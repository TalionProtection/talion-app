/**
 * LiveKit PTT Service
 * Gère la connexion PTT via LiveKit pour Talion's Eye.
 */

import { Platform } from 'react-native';
import { getApiBaseUrl } from './server-url';
import { authHeader } from './auth-fetch';

// Loaded defensively (require + try/catch, not a static import): this is a
// heavy native module (WebRTC) that can crash the whole screen at import
// time if it isn't available in a given build — same lesson as
// lib/ptt-context.tsx for expo-audio/expo-file-system.
//
// Room/RoomEvent come from livekit-client (the core cross-platform SDK),
// NOT from @livekit/react-native — that package only exports RN-specific
// helpers (registerGlobals, AudioSession, etc.) and re-exports nothing else;
// Room/RoomEvent aren't in it under any name. registerGlobals() itself,
// though, is required — it polyfills the WebRTC globals (RTCPeerConnection,
// MediaStream, etc.) that livekit-client expects to find, backed by
// @livekit/react-native-webrtc's native bindings. It must run exactly once,
// before any Room is constructed.
let RoomCtor: any = null;
let RoomEventEnum: any = null;
let AudioSessionCtor: any = null;
let getAppleAudioConfig: any = null;
let loadError: string | null = null;
if (Platform.OS !== 'web') {
  // Hermes doesn't provide the browser global DOMException, and neither
  // registerGlobals() nor react-native-webrtc polyfill it - but merely
  // requiring '@livekit/react-native' transitively loads livekit-client
  // (via its ./hooks and ./components/LiveKitRoom submodules), whose
  // bundled WebRTC adapter references DOMException at module scope. This
  // must be set up before that very first require, not after.
  if (typeof (global as any).DOMException === 'undefined') {
    (global as any).DOMException = class DOMException extends Error {
      constructor(message?: string, name?: string) {
        super(message);
        this.name = name || 'Error';
      }
    };
  }
  try {
    const { registerGlobals, AudioSession, getDefaultAppleAudioConfigurationForMode } = require('@livekit/react-native');
    registerGlobals();
    AudioSessionCtor = AudioSession;
    getAppleAudioConfig = getDefaultAppleAudioConfigurationForMode;
    const { Room, RoomEvent } = require('livekit-client');
    RoomCtor = Room;
    RoomEventEnum = RoomEvent;
    console.log('[LiveKit] livekit-client loaded and globals registered');
  } catch (e: any) {
    loadError = e?.message || String(e);
    console.warn('[LiveKit] Failed to load livekit-client:', e);
  }
}

export function isLiveKitAvailable(): boolean {
  return !!RoomCtor;
}

export function getLiveKitLoadError(): string | null {
  return loadError;
}

class LiveKitPTTService {
  private room: any = null;
  private isConnected = false;
  private isTransmitting = false;
  private currentRoom = '';

  // Callbacks
  onConnectionChange?: (connected: boolean) => void;
  // Full current set of active speakers (not a per-speaker on/off event) —
  // LiveKit's ActiveSpeakersChanged only lists who IS currently speaking, so
  // the consumer diffs this list itself rather than us guessing who stopped.
  onActiveSpeakersChanged?: (speakers: { identity: string; name: string }[]) => void;
  onError?: (error: string) => void;

  async getToken(roomName: string): Promise<{ token: string; url: string }> {
    const res = await fetch(`${getApiBaseUrl()}/api/livekit/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ roomName }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to get LiveKit token');
    }
    return res.json();
  }

  async connect(roomName: string): Promise<void> {
    if (!RoomCtor) throw new Error('LiveKit is not available on this build');
    try {
      if (this.room) await this.disconnect();

      const { token, url } = await this.getToken(roomName);

      // Must configure + start the native AudioSession *before* connecting.
      // registerGlobals()'s own category enforcement only kicks in once the
      // mic is actually engaged (setMicrophoneEnabled(true)), which is why
      // playback only worked after the app itself had transmitted at least
      // once - if the other side spoke first, the session was still in
      // whatever default/inactive state iOS left it in. Configuring
      // playAndRecord upfront makes receive-only work from the first packet.
      if (AudioSessionCtor && getAppleAudioConfig) {
        try {
          const audioConfig = getAppleAudioConfig('localAndRemote', true);
          console.log('[LiveKit] Configuring AudioSession:', JSON.stringify(audioConfig));
          await AudioSessionCtor.configureAudio(audioConfig);
          await AudioSessionCtor.startAudioSession();
          console.log('[LiveKit] AudioSession started successfully');
        } catch (e: any) {
          console.error('[LiveKit] AudioSession setup failed:', e);
          this.onError?.(`AudioSession non configurée: ${e?.message || e}`);
        }
      } else {
        console.warn('[LiveKit] AudioSession or getAppleAudioConfig not available - AudioSessionCtor:', !!AudioSessionCtor, 'getAppleAudioConfig:', !!getAppleAudioConfig);
      }

      this.room = new RoomCtor();
      this.currentRoom = roomName;

      this.room.on(RoomEventEnum.Connected, () => {
        this.isConnected = true;
        this.onConnectionChange?.(true);
        console.log('[LiveKit] Connected to room:', roomName);
      });

      this.room.on(RoomEventEnum.Disconnected, () => {
        this.isConnected = false;
        this.onConnectionChange?.(false);
        console.log('[LiveKit] Disconnected from room:', roomName);
      });

      this.room.on(RoomEventEnum.ActiveSpeakersChanged, (speakers: any[]) => {
        this.onActiveSpeakersChanged?.(speakers.map(s => ({ identity: s.identity, name: s.name || s.identity })));
      });

      this.room.on(RoomEventEnum.TrackSubscribed, (track: any, _pub: any, participant: any) => {
        console.log(`[LiveKit] TrackSubscribed: kind=${track.kind} from ${participant?.identity} isMuted=${track.isMuted}`);
      });

      await this.room.connect(url, token, { autoSubscribe: true });

      // Start muted — this is push-to-talk, not an open mic.
      await this.room.localParticipant.setMicrophoneEnabled(false);
    } catch (e: any) {
      console.error('[LiveKit] Connect error:', e);
      this.onError?.(e.message);
      throw e;
    }
  }

  async startTransmit(): Promise<void> {
    if (!this.room || !this.isConnected) return;
    try {
      // react-native-webrtc's getUserMedia doesn't check/request mic permission
      // itself - it just silently captures a dead/empty track if permission was
      // never granted. Request explicitly first so a denial surfaces clearly.
      if (Platform.OS !== 'web') {
        const { requestRecordingPermissionsAsync } = require('expo-audio');
        const { granted } = await requestRecordingPermissionsAsync();
        if (!granted) {
          this.onError?.('Accès au microphone refusé. Activez-le dans Réglages > Talion\'s Eye > Microphone.');
          return;
        }
      }
      await this.room.localParticipant.setMicrophoneEnabled(true);
      this.isTransmitting = true;
      console.log('[LiveKit] PTT: transmitting');
    } catch (e: any) {
      console.error('[LiveKit] Transmit error:', e);
      this.onError?.(e?.message || 'Erreur lors de l\'activation du microphone');
    }
  }

  async stopTransmit(): Promise<void> {
    if (!this.room) return;
    try {
      await this.room.localParticipant.setMicrophoneEnabled(false);
      this.isTransmitting = false;
      console.log('[LiveKit] PTT: stopped');
    } catch (e: any) {
      console.error('[LiveKit] Stop transmit error:', e);
      this.onError?.(e?.message || 'Erreur lors de la désactivation du microphone');
    }
  }

  async disconnect(): Promise<void> {
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
      this.isConnected = false;
      this.isTransmitting = false;
    }
    if (AudioSessionCtor) {
      try {
        await AudioSessionCtor.stopAudioSession();
      } catch (e) {
        console.warn('[LiveKit] AudioSession stop failed:', e);
      }
    }
  }

  getIsConnected() { return this.isConnected; }
  getIsTransmitting() { return this.isTransmitting; }
  getCurrentRoom() { return this.currentRoom; }
}

export const livekitPTT = new LiveKitPTTService();
