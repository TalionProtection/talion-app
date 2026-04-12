import React, { createContext, useContext, useReducer, useCallback, useRef, useEffect } from 'react';
import { Platform } from 'react-native';
import {
  DEFAULT_CHANNELS,
  type PTTChannel,
  type PTTMessage,
  type PTTState,
  type TalkingUser,
  canTransmitOnChannel,
  fetchChannels,
  createChannel,
  deleteChannel,
  transmitAudioREST,
} from '@/services/ptt-service';
import { alertSoundService } from '@/services/alert-sound-service';
import { wsManager } from '@/services/websocket-manager';
import { useAuth } from '@/hooks/useAuth';

// ─── Native Audio Modules ────────────────────────────────────────────────────
// expo-audio is the correct module for Expo Go SDK 54.
// expo-av is NOT available in Expo Go (requires native rebuild).
// We use expo-audio for recording (useAudioRecorder) and playback (createAudioPlayer).
// We use expo-file-system for base64 conversion of recorded files.

let useAudioRecorderHook: any = null;
let RecordingPresetsModule: any = null;
let requestRecordingPermissionsFn: any = null;
let setAudioModeAsyncFn: any = null;
let createAudioPlayerFn: any = null;
let FileSystemModule: any = null;

if (Platform.OS !== 'web') {
  try {
    const ExpoAudio = require('expo-audio');
    useAudioRecorderHook = ExpoAudio.useAudioRecorder;
    RecordingPresetsModule = ExpoAudio.RecordingPresets;
    requestRecordingPermissionsFn = ExpoAudio.requestRecordingPermissionsAsync;
    setAudioModeAsyncFn = ExpoAudio.setAudioModeAsync;
    createAudioPlayerFn = ExpoAudio.createAudioPlayer;
    console.log('[PTT] expo-audio loaded successfully');
  } catch (e) {
    console.warn('[PTT] Failed to load expo-audio:', e);
  }
  try {
    FileSystemModule = require('expo-file-system/legacy');
    console.log('[PTT] expo-file-system loaded successfully');
  } catch (e) {
    console.warn('[PTT] Failed to load expo-file-system:', e);
  }
}

// ─── Actions ───────────────────────────────────────────────────────────────
type PTTAction =
  | { type: 'SET_CHANNELS'; channels: PTTChannel[] }
  | { type: 'ADD_CHANNEL'; channel: PTTChannel }
  | { type: 'REMOVE_CHANNEL'; channelId: string }
  | { type: 'SET_CHANNEL'; channel: PTTChannel }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'ADD_MESSAGE'; message: PTTMessage }
  | { type: 'SET_MESSAGES'; messages: PTTMessage[] }
  | { type: 'SET_PLAYING'; messageId: string | null }
  | { type: 'MARK_PLAYED'; messageId: string }
  | { type: 'CLEAR_CHANNEL_MESSAGES'; channelId: string }
  | { type: 'ADD_TALKING_USER'; user: TalkingUser }
  | { type: 'REMOVE_TALKING_USER'; userId: string; channelId: string }
  | { type: 'SET_EMERGENCY'; active: boolean; message?: PTTMessage | null };

// ─── Reducer ───────────────────────────────────────────────────────────────
function pttReducer(state: PTTState, action: PTTAction): PTTState {
  switch (action.type) {
    case 'SET_CHANNELS':
      return { ...state, channels: action.channels };
    case 'ADD_CHANNEL':
      return { ...state, channels: [...state.channels, action.channel] };
    case 'REMOVE_CHANNEL':
      return {
        ...state,
        channels: state.channels.filter(c => c.id !== action.channelId),
        currentChannel: state.currentChannel?.id === action.channelId ? state.channels[0] || null : state.currentChannel,
      };
    case 'SET_CHANNEL':
      return { ...state, currentChannel: action.channel };
    case 'START_RECORDING':
      return { ...state, isRecording: true };
    case 'STOP_RECORDING':
      return { ...state, isRecording: false };
    case 'ADD_MESSAGE':
      return { ...state, messages: [action.message, ...state.messages].slice(0, 200) };
    case 'SET_MESSAGES':
      return { ...state, messages: action.messages };
    case 'SET_PLAYING':
      return { ...state, isPlaying: action.messageId !== null, currentPlayingMessageId: action.messageId };
    case 'MARK_PLAYED':
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === action.messageId ? { ...m, played: true } : m
        ),
      };
    case 'CLEAR_CHANNEL_MESSAGES':
      return {
        ...state,
        messages: state.messages.filter((m) => m.channelId !== action.channelId),
      };
    case 'ADD_TALKING_USER':
      return {
        ...state,
        talkingUsers: [
          ...state.talkingUsers.filter(t => !(t.userId === action.user.userId && t.channelId === action.user.channelId)),
          action.user,
        ],
      };
    case 'REMOVE_TALKING_USER':
      return {
        ...state,
        talkingUsers: state.talkingUsers.filter(t => !(t.userId === action.userId && t.channelId === action.channelId)),
      };
    case 'SET_EMERGENCY':
      return {
        ...state,
        emergencyActive: action.active,
        lastEmergencyMessage: action.message ?? state.lastEmergencyMessage,
      };
    default:
      return state;
  }
}

// ─── Initial State ─────────────────────────────────────────────────────────
const initialState: PTTState = {
  currentChannel: DEFAULT_CHANNELS[0],
  isRecording: false,
  isPlaying: false,
  currentPlayingMessageId: null,
  messages: [],
  channels: DEFAULT_CHANNELS,
  talkingUsers: [],
  emergencyActive: false,
  lastEmergencyMessage: null,
};

// ─── Context ───────────────────────────────────────────────────────────────
interface PTTContextValue {
  state: PTTState;
  selectChannel: (channel: PTTChannel) => void;
  startRecording: (userId: string, userName: string, userRole: string) => Promise<void>;
  stopRecording: () => Promise<void>;
  playMessage: (message: PTTMessage) => Promise<void>;
  stopPlayback: () => void;
  getChannelMessages: (channelId: string) => PTTMessage[];
  canTransmit: (userRole: string) => boolean;
  createGroup: (name: string, description: string, allowedRoles: string[], members?: string[]) => Promise<PTTChannel | null>;
  deleteGroup: (channelId: string) => Promise<boolean>;
  refreshChannels: () => Promise<void>;
  triggerEmergency: (userId: string, userName: string, userRole: string) => Promise<void>;
  stopEmergency: () => Promise<void>;
  dismissEmergency: () => void;
}

const PTTContext = createContext<PTTContextValue | null>(null);

// ─── Helper: Read file as base64 ──────────────────────────────────────────
async function fileToBase64(uri: string): Promise<string> {
  try {
    if (Platform.OS === 'web') {
      const response = await fetch(uri);
      const blob = await response.blob();
      console.log(`[PTT] Web blob size: ${blob.size} bytes, type: ${blob.type}`);
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const base64 = result.split(',')[1] || result;
          resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } else {
      if (!FileSystemModule) {
        console.error('[PTT] FileSystem module not available');
        return '';
      }
      const fileInfo = await FileSystemModule.getInfoAsync(uri);
      console.log(`[PTT] File info: exists=${fileInfo.exists}, size=${fileInfo.size || 'unknown'}, uri=${uri.substring(0, 80)}`);
      if (!fileInfo.exists || (fileInfo.size !== undefined && fileInfo.size === 0)) {
        console.error('[PTT] Audio file does not exist or is empty');
        return '';
      }
      const result = await FileSystemModule.readAsStringAsync(uri, {
        encoding: FileSystemModule.EncodingType.Base64,
      });
      console.log(`[PTT] Base64 result: ${result ? result.length + ' chars (' + (result.length / 1024).toFixed(1) + ' KB)' : 'EMPTY'}`);
      return result;
    }
  } catch (error) {
    console.error('[PTT] Failed to convert file to base64:', error);
    return '';
  }
}

// ─── Provider ──────────────────────────────────────────────────────────────
export function PTTProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(pttReducer, initialState);
  const { user } = useAuth();
  const playerRef = useRef<any>(null);
  const recordingStartTime = useRef<number>(0);
  const pendingUserInfo = useRef<{ userId: string; userName: string; userRole: string } | null>(null);
  const webRecorderRef = useRef<MediaRecorder | null>(null);
  const webChunksRef = useRef<Blob[]>([]);
  // Synchronous recording flag to prevent race conditions
  const isRecordingRef = useRef(false);
  // Track if audio mode has been initialized
  const audioModeInitialized = useRef(false);

  // ─── expo-audio useAudioRecorder hook ─────────────────────────────────
  // MUST be called unconditionally at the top level of the component (React rules of hooks).
  // On web, useAudioRecorderHook is null, so we use a dummy preset.
  const recordingPreset = RecordingPresetsModule?.HIGH_QUALITY ?? {};
  const nativeRecorder = useAudioRecorderHook ? useAudioRecorderHook(recordingPreset) : null;

  // ─── Initialize audio mode on mount ──────────────────────────────────
  useEffect(() => {
    if (Platform.OS === 'web' || audioModeInitialized.current) return;
    
    const initAudio = async () => {
      try {
        // Request recording permissions early
        if (requestRecordingPermissionsFn) {
          const permResult = await requestRecordingPermissionsFn();
          console.log(`[PTT] Recording permission: ${permResult.granted ? 'GRANTED' : 'DENIED'}`);
          if (!permResult.granted) {
            console.warn('[PTT] Microphone permission denied — recording will not work');
          }
        }
        audioModeInitialized.current = true;
      } catch (error) {
        console.error('[PTT] Failed to initialize audio:', error);
      }
    };
    
    initAudio();
  }, []);

  // ─── Fetch channels from server on mount ─────────────────────────────
  const refreshChannels = useCallback(async () => {
    if (!user) return;
    const channels = await fetchChannels(user.role);
    if (channels.length > 0) {
      dispatch({ type: 'SET_CHANNELS', channels });
      if (!state.currentChannel || !channels.find(c => c.id === state.currentChannel?.id)) {
        dispatch({ type: 'SET_CHANNEL', channel: channels[0] });
      }
    }
  }, [user, state.currentChannel]);

  useEffect(() => {
    refreshChannels();
  }, [user?.id]);

  // ─── WebSocket listeners for incoming PTT messages ────────────────────
  useEffect(() => {
    if (!user) return;

    const unsubMessage = wsManager.on('pttMessage', (msg: any) => {
      const data = msg.data;
      if (!data) return;
      let rawAudio = data.audioBase64 || '';
      if (rawAudio.includes(',')) rawAudio = rawAudio.split(',')[1] || rawAudio;
      const pttMsg: PTTMessage = {
        id: data.id,
        channelId: data.channelId,
        senderId: data.senderId,
        senderName: data.senderName,
        senderRole: data.senderRole,
        audioUri: '',
        audioBase64: rawAudio,
        mimeType: data.mimeType || 'audio/webm',
        duration: data.duration,
        timestamp: new Date(data.timestamp),
        played: false,
      };
      dispatch({ type: 'ADD_MESSAGE', message: pttMsg });
      if (data.senderId !== user?.id) {
        alertSoundService.playPTTBeep();
      }
    });

    const unsubChannelCreated = wsManager.on('pttChannelCreated', (msg: any) => {
      const ch = msg.data;
      if (ch) dispatch({ type: 'ADD_CHANNEL', channel: { ...ch, listenerCount: 0 } });
    });

    const unsubChannelDeleted = wsManager.on('pttChannelDeleted', (msg: any) => {
      const channelId = msg.channelId;
      if (channelId) dispatch({ type: 'REMOVE_CHANNEL', channelId });
    });

    const unsubHistory = wsManager.on('pttChannelHistory', (msg: any) => {
      const messages: PTTMessage[] = (msg.data || []).map((m: any) => {
        let histAudio = m.audioBase64 || '';
        if (histAudio.includes(',')) histAudio = histAudio.split(',')[1] || histAudio;
        return {
          id: m.id,
          channelId: m.channelId,
          senderId: m.senderId,
          senderName: m.senderName,
          senderRole: m.senderRole,
          audioUri: '',
          audioBase64: histAudio,
          mimeType: m.mimeType || 'audio/webm',
          duration: m.duration,
          timestamp: new Date(m.timestamp),
          played: true,
        };
      });
      dispatch({ type: 'SET_MESSAGES', messages });
    });

    const unsubTalkingStart = wsManager.on('pttTalkingStart', (msg: any) => {
      const data = msg.data;
      if (data) {
        dispatch({ type: 'ADD_TALKING_USER', user: {
          userId: data.userId,
          userName: data.userName,
          userRole: data.userRole,
          channelId: data.channelId,
        }});
      }
    });

    const unsubTalkingStop = wsManager.on('pttTalkingStop', (msg: any) => {
      const data = msg.data;
      if (data) {
        dispatch({ type: 'REMOVE_TALKING_USER', userId: data.userId, channelId: data.channelId });
      }
    });

    const unsubEmergency = wsManager.on('pttEmergencyMessage', (msg: any) => {
      const data = msg.data;
      if (!data) return;
      let emergAudio = data.audioBase64 || '';
      if (emergAudio.includes(',')) emergAudio = emergAudio.split(',')[1] || emergAudio;
      const emergencyMsg: PTTMessage = {
        id: data.id,
        channelId: 'emergency',
        senderId: data.senderId,
        senderName: data.senderName,
        senderRole: data.senderRole,
        audioUri: '',
        audioBase64: emergAudio,
        mimeType: data.mimeType || 'audio/webm',
        duration: data.duration,
        timestamp: new Date(data.timestamp),
        played: false,
      };
      dispatch({ type: 'SET_EMERGENCY', active: true, message: emergencyMsg });
      dispatch({ type: 'ADD_MESSAGE', message: emergencyMsg });
      alertSoundService.playSiren();
    });

    return () => {
      unsubMessage();
      unsubChannelCreated();
      unsubChannelDeleted();
      unsubHistory();
      unsubTalkingStart();
      unsubTalkingStop();
      unsubEmergency();
    };
  }, [user?.id]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (playerRef.current) {
        try { playerRef.current.remove?.(); } catch {}
        playerRef.current = null;
      }
    };
  }, []);

  const selectChannel = useCallback((channel: PTTChannel) => {
    dispatch({ type: 'SET_CHANNEL', channel });
    wsManager.send({ type: 'pttJoinChannel', data: { channelId: channel.id } });
  }, []);

  // ─── Start Recording ──────────────────────────────────────────────────
  const startRecording = useCallback(async (userId: string, userName: string, userRole: string) => {
    if (isRecordingRef.current) return;
    if (!state.currentChannel) return;
    if (!canTransmitOnChannel(state.currentChannel, userRole)) return;

    isRecordingRef.current = true;

    try {
      if (Platform.OS === 'web') {
        // Web: use MediaRecorder API
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
          webChunksRef.current = [];
          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) webChunksRef.current.push(e.data);
          };
          mediaRecorder.start();
          webRecorderRef.current = mediaRecorder;
        } catch (err) {
          console.warn('[PTT] Web microphone access denied:', err);
          isRecordingRef.current = false;
          return;
        }
      } else if (nativeRecorder) {
        // ─── Native: use expo-audio useAudioRecorder ───────────────
        // Following the EXACT pattern from expo-audio SDK 54 docs:
        // 1. Set audio mode to allow recording
        // 2. prepareToRecordAsync()
        // 3. record()
        try {
          // CRITICAL: Set audio mode to allow recording BEFORE preparing
          if (setAudioModeAsyncFn) {
            await setAudioModeAsyncFn({
              playsInSilentMode: true,
              allowsRecording: true,
            });
            console.log('[PTT] Audio mode set: allowsRecording=true');
          }

          await nativeRecorder.prepareToRecordAsync();
          console.log('[PTT] Recorder prepared');
          
          nativeRecorder.record();
          console.log('[PTT] Recording started');
        } catch (recErr) {
          console.error('[PTT] Failed to start native recording:', recErr);
          // Try to reset audio mode
          try {
            if (setAudioModeAsyncFn) {
              await setAudioModeAsyncFn({ playsInSilentMode: true, allowsRecording: false });
            }
          } catch {}
          isRecordingRef.current = false;
          return;
        }
      } else {
        console.error('[PTT] No native recorder available');
        isRecordingRef.current = false;
        return;
      }

      pendingUserInfo.current = { userId, userName, userRole };
      recordingStartTime.current = Date.now();
      dispatch({ type: 'START_RECORDING' });

      // Play PTT beep on start
      if (Platform.OS !== 'web') {
        alertSoundService.playPTTBeep();
      }

      // Broadcast talking state
      if (state.currentChannel) {
        wsManager.send({
          type: 'pttStartTalking',
          data: { channelId: state.currentChannel.id, userName },
        });
      }
    } catch (error) {
      console.error('[PTT] Failed to start recording:', error);
      isRecordingRef.current = false;
    }
  }, [state.isRecording, state.currentChannel, nativeRecorder]);

  // ─── Stop Recording ───────────────────────────────────────────────────
  const stopRecording = useCallback(async () => {
    if (!isRecordingRef.current) return;

    const duration = (Date.now() - recordingStartTime.current) / 1000;
    console.log(`[PTT] stopRecording: duration=${duration.toFixed(1)}s`);
    const userInfo = pendingUserInfo.current;

    try {
      let audioUri = '';
      let audioBase64 = '';

      if (Platform.OS === 'web') {
        // Web: stop MediaRecorder and get base64
        if (webRecorderRef.current && webRecorderRef.current.state !== 'inactive') {
          await new Promise<void>((resolve) => {
            webRecorderRef.current!.onstop = () => resolve();
            webRecorderRef.current!.stop();
          });
          webRecorderRef.current.stream.getTracks().forEach(t => t.stop());

          if (webChunksRef.current.length > 0) {
            const blob = new Blob(webChunksRef.current, { type: 'audio/webm' });
            audioUri = URL.createObjectURL(blob);
            audioBase64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                const result = reader.result as string;
                resolve(result.split(',')[1] || result);
              };
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }
          webRecorderRef.current = null;
          webChunksRef.current = [];
        }
      } else if (nativeRecorder) {
        // ─── Native: stop expo-audio recorder and get base64 ───────
        try {
          await nativeRecorder.stop();
          console.log(`[PTT] Recorder stopped. URI: ${nativeRecorder.uri || 'null'}`);

          // Switch audio mode back to playback (important for iOS speaker routing)
          if (setAudioModeAsyncFn) {
            await setAudioModeAsyncFn({
              playsInSilentMode: true,
              allowsRecording: false,
            });
            console.log('[PTT] Audio mode set: allowsRecording=false');
          }

          // Get the URI and convert to base64
          const uri = nativeRecorder.uri;
          if (uri) {
            audioUri = uri;
            
            // Wait a tiny bit for file to be fully flushed on disk
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Verify file exists and read as base64
            if (FileSystemModule) {
              const fileInfo = await FileSystemModule.getInfoAsync(uri);
              console.log(`[PTT] Recorded file: exists=${fileInfo.exists}, size=${fileInfo.size || 'unknown'} bytes`);
              
              if (fileInfo.exists && (fileInfo.size === undefined || fileInfo.size > 0)) {
                audioBase64 = await FileSystemModule.readAsStringAsync(uri, {
                  encoding: FileSystemModule.EncodingType.Base64,
                });
                console.log(`[PTT] Base64: ${audioBase64 ? (audioBase64.length / 1024).toFixed(1) + ' KB' : 'EMPTY'}`);
              } else {
                console.error('[PTT] Recorded file is empty or missing');
              }
            } else {
              console.error('[PTT] FileSystem not available for base64 conversion');
            }
          } else {
            console.error('[PTT] No URI from recorder after stop');
          }
        } catch (stopErr) {
          console.error('[PTT] Failed to stop native recorder:', stopErr);
          // Try to reset audio mode even on error
          try {
            if (setAudioModeAsyncFn) {
              await setAudioModeAsyncFn({ playsInSilentMode: true, allowsRecording: false });
            }
          } catch {}
        }
      }

      dispatch({ type: 'STOP_RECORDING' });

      // Only save messages longer than 0.3 seconds with actual audio data
      if (duration > 0.3 && userInfo && state.currentChannel) {
        const recordingMimeType = Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';
        const message: PTTMessage = {
          id: `ptt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          channelId: state.currentChannel.id,
          senderId: userInfo.userId,
          senderName: userInfo.userName,
          senderRole: userInfo.userRole as any,
          audioUri,
          audioBase64,
          mimeType: recordingMimeType,
          duration,
          timestamp: new Date(),
          played: true,
        };
        dispatch({ type: 'ADD_MESSAGE', message });

        console.log(`[PTT] Message ready: base64=${audioBase64 ? (audioBase64.length / 1024).toFixed(1) + ' KB' : 'EMPTY'}, duration=${duration.toFixed(1)}s, mimeType=${recordingMimeType}`);

        // Send via WebSocket (preferred) with REST fallback
        if (audioBase64 && audioBase64.length > 100) {
          console.log(`[PTT] Transmitting: ${(audioBase64.length / 1024).toFixed(1)} KB, channel=${state.currentChannel.id}`);
          let wsSent = false;
          if (wsManager.isConnected()) {
            try {
              wsManager.send({
                type: 'pttTransmit',
                data: {
                  channelId: state.currentChannel.id,
                  audioBase64,
                  mimeType: recordingMimeType,
                  duration,
                  senderName: userInfo.userName,
                },
              });
              wsSent = true;
              console.log('[PTT] Sent via WebSocket');
            } catch (wsErr) {
              console.error('[PTT] WebSocket send failed:', wsErr);
            }
          }
          if (!wsSent) {
            console.log('[PTT] Using REST fallback...');
            try {
              await transmitAudioREST({
                channelId: state.currentChannel.id,
                audioBase64,
                mimeType: recordingMimeType,
                duration,
                senderId: userInfo.userId,
                senderName: userInfo.userName,
                senderRole: userInfo.userRole,
              });
              console.log('[PTT] Sent via REST fallback');
            } catch (restErr) {
              console.error('[PTT] REST fallback also failed:', restErr);
            }
          }
        } else {
          console.warn(`[PTT] Audio too small to transmit: ${audioBase64 ? audioBase64.length : 0} chars`);
        }
      }
    } catch (error) {
      console.error('[PTT] Failed to stop recording:', error);
      dispatch({ type: 'STOP_RECORDING' });
    }

    pendingUserInfo.current = null;
    isRecordingRef.current = false;

    // Broadcast stop talking state
    if (state.currentChannel) {
      wsManager.send({
        type: 'pttStopTalking',
        data: { channelId: state.currentChannel.id },
      });
    }
  }, [state.isRecording, state.currentChannel, nativeRecorder]);

  // ─── Play Message ─────────────────────────────────────────────────────
  const playMessage = useCallback(async (message: PTTMessage) => {
    if (state.isPlaying) {
      if (playerRef.current) {
        try { playerRef.current.remove?.(); } catch {}
        playerRef.current = null;
      }
      dispatch({ type: 'SET_PLAYING', messageId: null });
    }

    try {
      dispatch({ type: 'SET_PLAYING', messageId: message.id });

      const hasLocalUri = message.audioUri && !message.audioUri.startsWith('ptt-recording') && message.audioUri.length > 10;
      const hasBase64 = message.audioBase64 && message.audioBase64.length > 100;

      if (Platform.OS === 'web') {
        // Web playback
        if (hasLocalUri || hasBase64) {
          let audioSrc = message.audioUri;
          if (!hasLocalUri && hasBase64) {
            const byteChars = atob(message.audioBase64!);
            const byteArray = new Uint8Array(byteChars.length);
            for (let i = 0; i < byteChars.length; i++) byteArray[i] = byteChars.charCodeAt(i);
            const blobType = message.mimeType || 'audio/webm';
            const blob = new Blob([byteArray], { type: blobType });
            audioSrc = URL.createObjectURL(blob);
          }
          const audio = new globalThis.Audio(audioSrc);
          audio.play().catch(console.error);
          audio.onended = () => {
            dispatch({ type: 'SET_PLAYING', messageId: null });
            dispatch({ type: 'MARK_PLAYED', messageId: message.id });
          };
          setTimeout(() => {
            dispatch({ type: 'SET_PLAYING', messageId: null });
            dispatch({ type: 'MARK_PLAYED', messageId: message.id });
          }, message.duration * 1000 + 2000);
        } else {
          setTimeout(() => {
            dispatch({ type: 'SET_PLAYING', messageId: null });
            dispatch({ type: 'MARK_PLAYED', messageId: message.id });
          }, message.duration * 1000);
        }
      } else if (hasLocalUri || hasBase64) {
        // Native playback using expo-audio createAudioPlayer
        if (setAudioModeAsyncFn) {
          await setAudioModeAsyncFn({
            playsInSilentMode: true,
            allowsRecording: false,
          });
        }

        let playUri = message.audioUri;
        if (!hasLocalUri && hasBase64) {
          if (!FileSystemModule) {
            console.error('[PTT] FileSystem not available for playback');
            dispatch({ type: 'SET_PLAYING', messageId: null });
            return;
          }
          const ext = (message.mimeType === 'audio/webm') ? 'webm' : 'm4a';
          const tempPath = `${FileSystemModule.cacheDirectory}ptt-${message.id}.${ext}`;
          console.log(`[PTT] Writing audio to temp file: ${tempPath}, mimeType: ${message.mimeType}, base64: ${message.audioBase64!.length} chars`);
          await FileSystemModule.writeAsStringAsync(tempPath, message.audioBase64!, {
            encoding: FileSystemModule.EncodingType.Base64,
          });
          playUri = tempPath;
        }

        if (createAudioPlayerFn) {
          console.log(`[PTT] Creating native player for: ${playUri}`);
          const player = createAudioPlayerFn({ uri: playUri });
          playerRef.current = player;
          try {
            player.play();
            console.log('[PTT] Native player.play() called');
          } catch (playErr) {
            console.error('[PTT] Native player.play() error:', playErr);
          }

          const timeout = Math.max(3000, message.duration * 1000 + 2000);
          setTimeout(() => {
            try { player.remove(); } catch {}
            playerRef.current = null;
            dispatch({ type: 'SET_PLAYING', messageId: null });
            dispatch({ type: 'MARK_PLAYED', messageId: message.id });
          }, timeout);
        }
      } else {
        setTimeout(() => {
          dispatch({ type: 'SET_PLAYING', messageId: null });
          dispatch({ type: 'MARK_PLAYED', messageId: message.id });
        }, message.duration * 1000);
      }
    } catch (error) {
      console.error('[PTT] Failed to play message:', error);
      dispatch({ type: 'SET_PLAYING', messageId: null });
    }
  }, [state.isPlaying]);

  const stopPlayback = useCallback(() => {
    if (playerRef.current) {
      try { playerRef.current.remove?.(); } catch {}
      playerRef.current = null;
    }
    dispatch({ type: 'SET_PLAYING', messageId: null });
  }, []);

  const getChannelMessages = useCallback((channelId: string) => {
    return state.messages.filter((m) => m.channelId === channelId);
  }, [state.messages]);

  const canTransmit = useCallback((userRole: string) => {
    if (!state.currentChannel) return false;
    return canTransmitOnChannel(state.currentChannel, userRole);
  }, [state.currentChannel]);

  const createGroup = useCallback(async (name: string, description: string, allowedRoles: string[], members?: string[]) => {
    if (!user) return null;
    const channel = await createChannel({
      name,
      description,
      allowedRoles,
      members,
      createdBy: user.id,
      createdByRole: user.role,
    });
    return channel;
  }, [user]);

  const deleteGroupFn = useCallback(async (channelId: string) => {
    if (!user) return false;
    const success = await deleteChannel(channelId, user.role);
    return success;
  }, [user]);

  // ─── Emergency Functions ─────────────────────────────────────────────
  const emergencyWebRecorderRef = useRef<MediaRecorder | null>(null);
  const emergencyWebChunksRef = useRef<Blob[]>([]);
  const emergencyStartTime = useRef<number>(0);
  const emergencyUserInfo = useRef<{ userId: string; userName: string; userRole: string } | null>(null);
  // For emergency, we reuse the same nativeRecorder (useAudioRecorder hook)
  // since only one recording can happen at a time

  const triggerEmergency = useCallback(async (userId: string, userName: string, userRole: string) => {
    if (userRole !== 'dispatcher' && userRole !== 'admin') return;
    if (isRecordingRef.current) return;

    isRecordingRef.current = true;

    try {
      if (Platform.OS === 'web') {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        emergencyWebChunksRef.current = [];
        mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) emergencyWebChunksRef.current.push(e.data);
        };
        mediaRecorder.start();
        emergencyWebRecorderRef.current = mediaRecorder;
      } else if (nativeRecorder) {
        try {
          if (setAudioModeAsyncFn) {
            await setAudioModeAsyncFn({
              playsInSilentMode: true,
              allowsRecording: true,
            });
          }
          await nativeRecorder.prepareToRecordAsync();
          nativeRecorder.record();
          console.log('[PTT] Emergency recording started');
        } catch (recErr) {
          console.error('[PTT] Emergency native recording failed:', recErr);
          try {
            if (setAudioModeAsyncFn) {
              await setAudioModeAsyncFn({ playsInSilentMode: true, allowsRecording: false });
            }
          } catch {}
          isRecordingRef.current = false;
          return;
        }
      } else {
        console.warn('[PTT] No native recorder for emergency');
        isRecordingRef.current = false;
        return;
      }

      emergencyUserInfo.current = { userId, userName, userRole };
      emergencyStartTime.current = Date.now();
      dispatch({ type: 'START_RECORDING' });
      dispatch({ type: 'SET_EMERGENCY', active: true });

      wsManager.send({
        type: 'pttStartTalking',
        data: { channelId: 'emergency', userName: `⚠️ ${userName}` },
      });

      alertSoundService.playPTTBeep();
    } catch (error) {
      console.error('[PTT] Failed to start emergency recording:', error);
      isRecordingRef.current = false;
    }
  }, [state.isRecording, nativeRecorder]);

  const stopEmergency = useCallback(async () => {
    const duration = (Date.now() - emergencyStartTime.current) / 1000;
    const userInfo = emergencyUserInfo.current;
    let audioBase64 = '';

    try {
      if (Platform.OS === 'web') {
        if (emergencyWebRecorderRef.current && emergencyWebRecorderRef.current.state !== 'inactive') {
          await new Promise<void>((resolve) => {
            emergencyWebRecorderRef.current!.onstop = () => resolve();
            emergencyWebRecorderRef.current!.stop();
          });
          emergencyWebRecorderRef.current.stream.getTracks().forEach(t => t.stop());
          if (emergencyWebChunksRef.current.length > 0) {
            const blob = new Blob(emergencyWebChunksRef.current, { type: 'audio/webm' });
            audioBase64 = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onloadend = () => {
                const result = reader.result as string;
                resolve(result.split(',')[1] || result);
              };
              reader.onerror = reject;
              reader.readAsDataURL(blob);
            });
          }
          emergencyWebRecorderRef.current = null;
          emergencyWebChunksRef.current = [];
        }
      } else if (nativeRecorder) {
        try {
          await nativeRecorder.stop();
          console.log(`[PTT] Emergency recorder stopped. URI: ${nativeRecorder.uri || 'null'}`);

          if (setAudioModeAsyncFn) {
            await setAudioModeAsyncFn({ playsInSilentMode: true, allowsRecording: false });
          }

          const uri = nativeRecorder.uri;
          if (uri && FileSystemModule) {
            await new Promise(resolve => setTimeout(resolve, 100));
            audioBase64 = await FileSystemModule.readAsStringAsync(uri, {
              encoding: FileSystemModule.EncodingType.Base64,
            });
            console.log(`[PTT] Emergency base64: ${audioBase64 ? (audioBase64.length / 1024).toFixed(1) + ' KB' : 'EMPTY'}`);
          }
        } catch (stopErr) {
          console.error('[PTT] Failed to stop emergency recorder:', stopErr);
          try {
            if (setAudioModeAsyncFn) {
              await setAudioModeAsyncFn({ playsInSilentMode: true, allowsRecording: false });
            }
          } catch {}
        }
      }

      dispatch({ type: 'STOP_RECORDING' });

      const emergencyMimeType = Platform.OS === 'web' ? 'audio/webm' : 'audio/mp4';
      if (duration > 0.3 && userInfo && audioBase64 && audioBase64.length > 100) {
        wsManager.send({
          type: 'pttEmergency',
          data: {
            audioBase64,
            mimeType: emergencyMimeType,
            duration,
            senderName: userInfo.userName,
          },
        });
      }

      wsManager.send({
        type: 'pttStopTalking',
        data: { channelId: 'emergency' },
      });
    } catch (error) {
      console.error('[PTT] Failed to stop emergency recording:', error);
      dispatch({ type: 'STOP_RECORDING' });
    }

    emergencyUserInfo.current = null;
    isRecordingRef.current = false;
  }, [nativeRecorder]);

  const dismissEmergency = useCallback(() => {
    dispatch({ type: 'SET_EMERGENCY', active: false });
  }, []);

  return (
    <PTTContext.Provider
      value={{
        state,
        selectChannel,
        startRecording,
        stopRecording,
        playMessage,
        stopPlayback,
        getChannelMessages,
        canTransmit,
        createGroup,
        deleteGroup: deleteGroupFn,
        refreshChannels,
        triggerEmergency,
        stopEmergency,
        dismissEmergency,
      }}
    >
      {children}
    </PTTContext.Provider>
  );
}

// ─── Hook ──────────────────────────────────────────────────────────────────
export function usePTT() {
  const ctx = useContext(PTTContext);
  if (!ctx) {
    throw new Error('usePTT must be used within a PTTProvider');
  }
  return ctx;
}
