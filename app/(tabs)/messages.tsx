import { useState, useEffect, useCallback, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Modal,
  ActivityIndicator,
  ScrollView,
  Image,
  Alert,
} from 'react-native';
import { TalionScreen, TalionBanner } from '@/components/talion-banner';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/hooks/useAuth';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { offlineCache } from '@/services/offline-cache';
import { OfflineBanner } from '@/components/offline-banner';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { Audio } from 'expo-av';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ServerUser {
  id: string;
  name: string;
  email: string;
  role: string;
  tags: string[];
}

interface ServerConversation {
  id: string;
  type: 'direct' | 'group';
  name: string;
  displayName: string;
  participantIds: string[];
  participantCount: number;
  filterRole?: string;
  filterTags?: string[];
  createdBy: string;
  createdAt: number;
  lastMessage: string;
  lastMessageTime: number;
  lastSenderName: string;
  unreadCount?: number;
}

interface ServerMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  text: string;
  type: string;
  timestamp: number;
  mediaUrl?: string;
  mediaType?: 'image' | 'audio';
  location?: { latitude: number; longitude: number; address?: string };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  dispatcher: '#1e3a5f',
  admin: '#1e3a5f',
  responder: '#22c55e',
  user: '#8b5cf6',
  system: '#9ca3af',
};

const ROLE_LABELS: Record<string, string> = {
  dispatcher: 'Dispatcher',
  admin: 'Admin',
  responder: 'Responder',
  user: 'User',
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ─── API Helpers ────────────────────────────────────────────────────────────

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${getApiBaseUrl()}${path}`, { timeout: 10000 });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function apiPost<T>(path: string, body: any): Promise<T> {
  const res = await fetchWithTimeout(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

// Upload media file (image or audio) via multipart
async function uploadMedia(uri: string, convId: string, senderId: string, senderName: string, mediaType: 'image' | 'audio'): Promise<void> {
  const ext = mediaType === 'audio' ? 'm4a' : 'jpg';
  const mimeType = mediaType === 'audio' ? 'audio/m4a' : 'image/jpeg';
  const formData = new FormData();
  formData.append('file', { uri, name: `media.${ext}`, type: mimeType } as any);
  formData.append('senderId', senderId);
  formData.append('senderName', senderName);
  formData.append('mediaType', mediaType);
  const baseUrl = getApiBaseUrl();
  const url = `${baseUrl}/api/conversations/${encodeURIComponent(convId)}/media`;
  console.log('[Upload] Sending to:', url);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Accept': 'application/json' },
    body: formData,
  });
  const responseText = await res.text();
  console.log('[Upload] Response:', res.status, responseText);
  if (!res.ok) throw new Error(`Upload failed: ${res.status} ${responseText}`);
}

// ─── Audio Recording Hook ────────────────────────────────────────────────────

function useAudioRecorder() {
  const recordingRef = useRef<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startRecording = async (): Promise<boolean> => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Accès au microphone nécessaire pour enregistrer un message vocal.');
        return false;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      setIsRecording(true);
      setRecordingDuration(0);
      timerRef.current = setInterval(() => setRecordingDuration(d => d + 1000), 1000);
      return true;
    } catch (e) {
      console.warn('[Audio] Start recording error:', e);
      return false;
    }
  };

  const stopRecording = async (): Promise<string | null> => {
    try {
      if (timerRef.current) clearInterval(timerRef.current);
      setIsRecording(false);
      setRecordingDuration(0);
      if (!recordingRef.current) return null;
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      return uri || null;
    } catch (e) {
      console.warn('[Audio] Stop recording error:', e);
      return null;
    }
  };

  const cancelRecording = async () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setIsRecording(false);
    setRecordingDuration(0);
    if (recordingRef.current) {
      try { await recordingRef.current.stopAndUnloadAsync(); } catch {}
      recordingRef.current = null;
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
  };

  return { isRecording, recordingDuration, startRecording, stopRecording, cancelRecording };
}

// ─── Audio Player Component ──────────────────────────────────────────────────

function AudioPlayer({ uri, isMe }: { uri: string; isMe: boolean }) {
  const soundRef = useRef<Audio.Sound | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);

  useEffect(() => {
    return () => { soundRef.current?.unloadAsync(); };
  }, []);

  const toggle = async () => {
    try {
      if (!soundRef.current) {
        await Audio.setAudioModeAsync({ playsInSilentModeIOS: true, allowsRecordingIOS: false });
        const { sound, status } = await Audio.Sound.createAsync(
          { uri },
          { shouldPlay: true },
          (s) => {
            if (s.isLoaded) {
              setPosition(s.positionMillis);
              setDuration(s.durationMillis || 0);
              if (s.didJustFinish) { setPlaying(false); setPosition(0); soundRef.current = null; }
            }
          }
        );
        soundRef.current = sound;
        setPlaying(true);
      } else if (playing) {
        await soundRef.current.pauseAsync();
        setPlaying(false);
      } else {
        await soundRef.current.playAsync();
        setPlaying(true);
      }
    } catch (e) { console.warn('[Audio] Player error:', e); }
  };

  const progress = duration > 0 ? position / duration : 0;

  return (
    <View style={[audioStyles.container, isMe ? audioStyles.containerMe : audioStyles.containerThem]}>
      <TouchableOpacity onPress={toggle} style={audioStyles.playBtn}>
        <Text style={audioStyles.playIcon}>{playing ? '⏸' : '▶'}</Text>
      </TouchableOpacity>
      <View style={audioStyles.waveContainer}>
        <View style={[audioStyles.waveBar, { width: `${progress * 100}%` as any }]} />
        <View style={audioStyles.waveTrack} />
      </View>
      <Text style={[audioStyles.duration, isMe && audioStyles.durationMe]}>
        {formatDuration(duration > 0 ? (playing ? position : duration) : 0)}
      </Text>
    </View>
  );
}

const audioStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 160 },
  containerMe: {},
  containerThem: {},
  playBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center' },
  playIcon: { fontSize: 14, color: '#ffffff' },
  waveContainer: { flex: 1, height: 24, justifyContent: 'center', position: 'relative' },
  waveTrack: { position: 'absolute', left: 0, right: 0, height: 3, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 2 },
  waveBar: { position: 'absolute', left: 0, height: 3, backgroundColor: '#ffffff', borderRadius: 2, zIndex: 1 },
  duration: { fontSize: 11, color: 'rgba(255,255,255,0.8)', minWidth: 32, textAlign: 'right' },
  durationMe: { color: 'rgba(255,255,255,0.8)' },
});

// ─── Main Component ─────────────────────────────────────────────────────────

type ViewState = 'list' | 'chat' | 'new-direct' | 'new-group';

export default function MessagesScreen() {
  const { user } = useAuth();

  // Navigation state
  const [view, setView] = useState<ViewState>('list');
  const [selectedConversation, setSelectedConversation] = useState<ServerConversation | null>(null);

  // Data state
  const [conversations, setConversations] = useState<ServerConversation[]>([]);
  const [chatMessages, setChatMessages] = useState<ServerMessage[]>([]);
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingMedia, setSendingMedia] = useState(false);

  // Chat input
  const [messageText, setMessageText] = useState('');
  const flatListRef = useRef<FlatList>(null);

  // Media menu
  const [showMediaMenu, setShowMediaMenu] = useState(false);

  // Audio recording
  const { isRecording, recordingDuration, startRecording, stopRecording, cancelRecording } = useAudioRecorder();

  // Group creation state
  const [groupName, setGroupName] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedRole, setSelectedRole] = useState<string>('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [groupMode, setGroupMode] = useState<'users' | 'role' | 'tags'>('users');

  // ─── Data Fetching ──────────────────────────────────────────────────────

  const fetchConversations = useCallback(async () => {
    if (!user?.id) return;
    try {
      const data = await apiGet<ServerConversation[]>(`/api/conversations?userId=${user.id}`);
      setConversations(data);
      offlineCache.cacheConversations(data);
    } catch (e) {
      console.warn('[Messages] Failed to fetch conversations, trying cache:', e);
      const cached = await offlineCache.getCachedConversations();
      if (cached) setConversations(cached as any);
    }
  }, [user?.id]);

  const fetchUsers = useCallback(async () => {
    try {
      const data = await apiGet<ServerUser[]>('/api/users');
      setUsers(data.filter(u => u.id !== user?.id));
    } catch (e) {
      console.warn('[Messages] Failed to fetch users:', e);
    }
  }, [user?.id]);

  const fetchTags = useCallback(async () => {
    try {
      const data = await apiGet<string[]>('/api/tags');
      setAllTags(data);
    } catch (e) {
      console.warn('[Messages] Failed to fetch tags:', e);
    }
  }, []);

  const fetchMessages = useCallback(async (convId: string) => {
    try {
      const data = await apiGet<ServerMessage[]>(`/api/conversations/${encodeURIComponent(convId)}/messages`);
      setChatMessages(data);
      offlineCache.cacheMessages(convId, data);
    } catch (e) {
      console.warn('[Messages] Failed to fetch messages, trying cache:', e);
      const cached = await offlineCache.getCachedMessages(convId);
      if (cached) setChatMessages(cached as any);
    }
  }, []);

  // Initial load + polling for conversations
  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 5000);
    return () => clearInterval(interval);
  }, [fetchConversations]);

  // Poll messages when in chat view
  useEffect(() => {
    if (view === 'chat' && selectedConversation) {
      fetchMessages(selectedConversation.id);
      const interval = setInterval(() => fetchMessages(selectedConversation.id), 3000);
      return () => clearInterval(interval);
    }
  }, [view, selectedConversation, fetchMessages]);

  // Load users and tags when opening new conversation views
  useEffect(() => {
    if (view === 'new-direct' || view === 'new-group') {
      fetchUsers();
      fetchTags();
    }
  }, [view, fetchUsers, fetchTags]);

  // ─── Actions ────────────────────────────────────────────────────────────

  const openConversation = useCallback(async (conv: ServerConversation) => {
    setSelectedConversation(conv);
    setChatMessages([]);
    setView('chat');
    // Marquer comme lu
    if (user?.id && (conv.unreadCount || 0) > 0) {
      try {
        await apiPost(`/api/conversations/${encodeURIComponent(conv.id)}/read`, { userId: user.id });
        setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, unreadCount: 0 } : c));
      } catch {}
    }
  }, [user?.id]);

  const handleSendMessage = useCallback(async () => {
    if (!messageText.trim() || !selectedConversation || !user?.id) return;
    const text = messageText.trim();
    setMessageText('');
    try {
      await apiPost(`/api/conversations/${encodeURIComponent(selectedConversation.id)}/messages`, {
        senderId: user.id,
        text,
        type: 'text',
      });
      await fetchMessages(selectedConversation.id);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e) {
      console.warn('[Messages] Failed to send message:', e);
    }
  }, [messageText, selectedConversation, user?.id, fetchMessages]);

  // ─── Media Handlers ──────────────────────────────────────────────────────

  const handleSendPhoto = useCallback(async (fromCamera: boolean) => {
    if (!selectedConversation || !user?.id) return;
    setShowMediaMenu(false);
    try {
      let result;
      if (fromCamera) {
        const { status } = await ImagePicker.requestCameraPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission requise', 'Accès à la caméra nécessaire.');
          return;
        }
        result = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
      } else {
        const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (status !== 'granted') {
          Alert.alert('Permission requise', 'Accès à la galerie nécessaire.');
          return;
        }
        result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
      }
      if (result.canceled || !result.assets?.[0]?.uri) return;
      setSendingMedia(true);
      await uploadMedia(result.assets[0].uri, selectedConversation.id, user.id, user.name || '', 'image');
      await fetchMessages(selectedConversation.id);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e) {
      Alert.alert('Erreur', "Impossible d'envoyer la photo.");
      console.warn('[Media] Photo error:', e);
    } finally {
      setSendingMedia(false);
    }
  }, [selectedConversation, user, fetchMessages]);

  const handleSendLocation = useCallback(async () => {
    if (!selectedConversation || !user?.id) return;
    setShowMediaMenu(false);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Accès à la localisation nécessaire.');
        return;
      }
      setSendingMedia(true);
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const [geo] = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
      const address = geo ? `${geo.street || ''} ${geo.city || ''}`.trim() : `${loc.coords.latitude.toFixed(5)}, ${loc.coords.longitude.toFixed(5)}`;
      await apiPost(`/api/conversations/${encodeURIComponent(selectedConversation.id)}/messages`, {
        senderId: user.id,
        text: address,
        type: 'location',
        location: { latitude: loc.coords.latitude, longitude: loc.coords.longitude, address },
      });
      await fetchMessages(selectedConversation.id);
      setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
    } catch (e) {
      Alert.alert('Erreur', 'Impossible de partager la localisation.');
      console.warn('[Media] Location error:', e);
    } finally {
      setSendingMedia(false);
    }
  }, [selectedConversation, user, fetchMessages]);

  const handleToggleRecording = useCallback(async () => {
    if (!selectedConversation || !user?.id) return;
    if (isRecording) {
      // Stop and send
      const uri = await stopRecording();
      if (!uri) return;
      setSendingMedia(true);
      try {
        await uploadMedia(uri, selectedConversation.id, user.id, user.name || '', 'audio');
        await fetchMessages(selectedConversation.id);
        setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 100);
      } catch (e) {
        Alert.alert('Erreur', "Impossible d'envoyer le message vocal.");
      } finally {
        setSendingMedia(false);
      }
    } else {
      await startRecording();
    }
  }, [isRecording, selectedConversation, user, startRecording, stopRecording, fetchMessages]);

  const handleStartDirect = useCallback(async (targetUser: ServerUser) => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const conv = await apiPost<ServerConversation>('/api/conversations', {
        type: 'direct',
        participantIds: [user.id, targetUser.id],
        createdBy: user.id,
      });
      setSelectedConversation({ ...conv, displayName: targetUser.name, participantCount: 2 });
      setChatMessages([]);
      setView('chat');
      fetchConversations();
    } catch (e) {
      console.warn('[Messages] Failed to create DM:', e);
    } finally {
      setLoading(false);
    }
  }, [user?.id, fetchConversations]);

  const handleCreateGroup = useCallback(async () => {
    if (!user?.id || !groupName.trim()) return;
    setLoading(true);
    try {
      const body: any = { type: 'group', name: groupName.trim(), createdBy: user.id, participantIds: [user.id] };
      if (groupMode === 'users') body.participantIds = [user.id, ...selectedUserIds];
      else if (groupMode === 'role') body.filterRole = selectedRole;
      else if (groupMode === 'tags') body.filterTags = selectedTags;
      const conv = await apiPost<ServerConversation>('/api/conversations', body);
      setSelectedConversation({ ...conv, displayName: conv.name, participantCount: conv.participantIds?.length || 0 });
      setChatMessages([]);
      setView('chat');
      fetchConversations();
      setGroupName(''); setSelectedUserIds([]); setSelectedRole(''); setSelectedTags([]);
    } catch (e) {
      console.warn('[Messages] Failed to create group:', e);
    } finally {
      setLoading(false);
    }
  }, [user?.id, groupName, groupMode, selectedUserIds, selectedRole, selectedTags, fetchConversations]);

  const toggleUserId = (id: string) => setSelectedUserIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleTag = (tag: string) => setSelectedTags(prev => prev.includes(tag) ? prev.filter(x => x !== tag) : [...prev, tag]);

  // ─── New Message Menu ───────────────────────────────────────────────────
  const [showNewMenu, setShowNewMenu] = useState(false);

  // ─── Chat View ──────────────────────────────────────────────────────────

  if (view === 'chat' && selectedConversation) {
    const baseUrl = getApiBaseUrl();
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#1e3a5f' }} edges={['top', 'left', 'right']}>
        <TalionBanner showStatus={false} />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.chatContainer}
          keyboardVerticalOffset={0}
        >
          {/* Chat Header */}
          <View style={styles.chatHeader}>
            <TouchableOpacity onPress={() => { setView('list'); setSelectedConversation(null); }} style={styles.backButton}>
              <Text style={styles.backIcon}>←</Text>
            </TouchableOpacity>
            <View style={[styles.chatAvatar, { backgroundColor: selectedConversation.type === 'group' ? '#f59e0b' : '#1e3a5f' }]}>
              <Text style={styles.chatAvatarText}>
                {selectedConversation.type === 'group' ? '👥' : selectedConversation.displayName?.charAt(0) || '?'}
              </Text>
            </View>
            <View style={styles.chatHeaderInfo}>
              <Text style={styles.chatHeaderName} numberOfLines={1}>{selectedConversation.displayName || selectedConversation.name}</Text>
              <Text style={styles.chatStatusText}>
                {selectedConversation.type === 'group'
                  ? `${selectedConversation.participantCount || selectedConversation.participantIds?.length || 0} membres`
                  : 'Message direct'}
              </Text>
            </View>
          </View>

          {/* Messages */}
          <FlatList
            ref={flatListRef}
            data={chatMessages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.messagesContainer}
            onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: false })}
            ListEmptyComponent={
              <View style={styles.emptyChatState}>
                <Text style={styles.emptyChatIcon}>💬</Text>
                <Text style={styles.emptyChatText}>Aucun message</Text>
                <Text style={styles.emptyChatSubtext}>Envoyez un message pour commencer</Text>
              </View>
            }
            renderItem={({ item }) => {
              const isMe = item.senderId === user?.id;
              const isSystem = item.type === 'system';
              const isAlert = item.type === 'alert';
              const isLocation = item.type === 'location';
              const isImage = item.type === 'image';
              const isAudio = item.type === 'audio';

              if (isSystem) {
                return (
                  <View style={styles.systemMessageContainer}>
                    <Text style={styles.systemMessageText}>{item.text}</Text>
                  </View>
                );
              }

              return (
                <View style={[styles.messageBubbleContainer, isMe ? styles.myBubbleContainer : styles.theirBubbleContainer]}>
                  {!isMe && (
                    <View style={[styles.bubbleAvatar, { backgroundColor: ROLE_COLORS[item.senderRole] || '#6b7280' }]}>
                      <Text style={styles.bubbleAvatarText}>{item.senderName.charAt(0)}</Text>
                    </View>
                  )}
                  <View style={[
                    styles.messageBubble,
                    isMe ? styles.myBubble : styles.theirBubble,
                    isAlert && styles.alertBubble,
                    isLocation && styles.locationBubble,
                    isImage && styles.imageBubble,
                    isAudio && styles.audioBubble,
                  ]}>
                    {!isMe && selectedConversation.type === 'group' && (
                      <Text style={[styles.senderLabel, { color: isMe ? 'rgba(255,255,255,0.7)' : ROLE_COLORS[item.senderRole] || '#6b7280' }]}>
                        {item.senderName}
                      </Text>
                    )}

                    {/* Image message */}
                    {isImage && item.mediaUrl && (
                      <Image
                        source={{ uri: item.mediaUrl.startsWith('http') ? item.mediaUrl : `${baseUrl}${item.mediaUrl}` }}
                        style={styles.messageImage}
                        resizeMode="cover"
                      />
                    )}

                    {/* Audio message */}
                    {isAudio && item.mediaUrl && (
                      <AudioPlayer
                        uri={item.mediaUrl.startsWith('http') ? item.mediaUrl : `${baseUrl}${item.mediaUrl}`}
                        isMe={isMe}
                      />
                    )}

                    {/* Location message */}
                    {isLocation && item.location && (
                      <View>
                        <View style={styles.locationPreview}>
                          <Text style={styles.locationPin}>📍</Text>
                          <View>
                            <Text style={[styles.locationText, isMe && { color: '#ffffff' }]} numberOfLines={2}>
                              {item.location.address || item.text}
                            </Text>
                            <Text style={[styles.locationCoords, isMe && { color: 'rgba(255,255,255,0.6)' }]}>
                              {item.location.latitude.toFixed(5)}, {item.location.longitude.toFixed(5)}
                            </Text>
                          </View>
                        </View>
                      </View>
                    )}

                    {/* Text message */}
                    {!isImage && !isAudio && !isLocation && (
                      <Text style={[styles.messageText, isMe && styles.myMessageText, isAlert && styles.alertMessageText]}>
                        {isAlert && '🚨 '}{item.text}
                      </Text>
                    )}

                    <Text style={[styles.timestamp, isMe && styles.myTimestamp]}>{formatTime(item.timestamp)}</Text>
                  </View>
                </View>
              );
            }}
          />

          {/* Recording indicator */}
          {isRecording && (
            <View style={styles.recordingBar}>
              <View style={styles.recordingDot} />
              <Text style={styles.recordingText}>Enregistrement... {formatDuration(recordingDuration)}</Text>
              <TouchableOpacity onPress={cancelRecording} style={styles.cancelRecordBtn}>
                <Text style={styles.cancelRecordText}>✕ Annuler</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Sending indicator */}
          {sendingMedia && (
            <View style={styles.sendingBar}>
              <ActivityIndicator size="small" color="#1e3a5f" />
              <Text style={styles.sendingText}>Envoi en cours...</Text>
            </View>
          )}

          {/* Input Area */}
          <View style={styles.inputContainer}>
            <View style={styles.inputRow}>
              {/* Media button */}
              <TouchableOpacity
                style={styles.mediaButton}
                onPress={() => setShowMediaMenu(true)}
              >
                <Text style={styles.mediaIcon}>+</Text>
              </TouchableOpacity>

              <TextInput
                style={styles.input}
                placeholder="Message..."
                placeholderTextColor="#9ca3af"
                value={messageText}
                onChangeText={setMessageText}
                multiline
                returnKeyType="send"
                onSubmitEditing={handleSendMessage}
              />

              {/* Send or Record button */}
              {messageText.trim() ? (
                <TouchableOpacity style={styles.sendButton} onPress={handleSendMessage}>
                  <Text style={styles.sendIcon}>➤</Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.sendButton, isRecording && styles.recordingActive]}
                  onPress={handleToggleRecording}
                >
                  <Text style={styles.sendIcon}>{isRecording ? '⏹' : '🎤'}</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </KeyboardAvoidingView>

        {/* Media Menu */}
        <Modal visible={showMediaMenu} transparent animationType="slide" onRequestClose={() => setShowMediaMenu(false)}>
          <TouchableOpacity style={styles.mediaMenuOverlay} activeOpacity={1} onPress={() => setShowMediaMenu(false)}>
            <View style={styles.mediaMenuCard}>
              <Text style={styles.mediaMenuTitle}>Envoyer</Text>
              <View style={styles.mediaMenuGrid}>
                <TouchableOpacity style={styles.mediaMenuItem} onPress={() => handleSendPhoto(true)}>
                  <Text style={styles.mediaMenuItemIcon}>📷</Text>
                  <Text style={styles.mediaMenuItemText}>Caméra</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.mediaMenuItem} onPress={() => handleSendPhoto(false)}>
                  <Text style={styles.mediaMenuItemIcon}>🖼️</Text>
                  <Text style={styles.mediaMenuItemText}>Galerie</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.mediaMenuItem} onPress={handleSendLocation}>
                  <Text style={styles.mediaMenuItemIcon}>📍</Text>
                  <Text style={styles.mediaMenuItemText}>Position</Text>
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </Modal>
      </SafeAreaView>
    );
  }

  // ─── New Direct Message View ────────────────────────────────────────────

  if (view === 'new-direct') {
    return (
      <TalionScreen showStatus={false}>
        <View style={styles.screenHeader}>
          <TouchableOpacity onPress={() => setView('list')} style={styles.headerBackBtn}>
            <Text style={styles.headerBackText}>←</Text>
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Nouveau Message Direct</Text>
        </View>
        {loading ? (
          <View style={styles.loadingContainer}><ActivityIndicator size="large" color="#1e3a5f" /></View>
        ) : (
          <FlatList
            data={users}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.contactList}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.contactItem} onPress={() => handleStartDirect(item)}>
                <View style={[styles.contactAvatar, { backgroundColor: ROLE_COLORS[item.role] || '#6b7280' }]}>
                  <Text style={styles.contactAvatarText}>{item.name.charAt(0)}</Text>
                </View>
                <View style={styles.contactInfo}>
                  <Text style={styles.contactName}>{item.name}</Text>
                  <Text style={styles.contactRole}>{ROLE_LABELS[item.role] || item.role}</Text>
                  {item.tags.length > 0 && (
                    <View style={styles.tagRow}>
                      {item.tags.map(t => (
                        <View key={t} style={styles.tagChip}>
                          <Text style={styles.tagChipText}>{t}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              </TouchableOpacity>
            )}
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyStateText}>Aucun utilisateur disponible</Text>
              </View>
            }
          />
        )}
      </TalionScreen>
    );
  }

  // ─── New Group View ─────────────────────────────────────────────────────

  if (view === 'new-group') {
    return (
      <TalionScreen showStatus={false}>
        <View style={styles.screenHeader}>
          <TouchableOpacity onPress={() => setView('list')} style={styles.headerBackBtn}>
            <Text style={styles.headerBackText}>←</Text>
          </TouchableOpacity>
          <Text style={styles.screenTitle}>Nouveau Groupe</Text>
        </View>
        <ScrollView style={styles.groupForm} contentContainerStyle={{ paddingBottom: 40 }}>
          <Text style={styles.formLabel}>Nom du groupe</Text>
          <TextInput
            style={styles.formInput}
            placeholder="Entrez un nom..."
            placeholderTextColor="#9ca3af"
            value={groupName}
            onChangeText={setGroupName}
          />
          <Text style={styles.formLabel}>Créer par</Text>
          <View style={styles.modeSelector}>
            {(['users', 'role', 'tags'] as const).map(mode => (
              <TouchableOpacity
                key={mode}
                style={[styles.modeButton, groupMode === mode && styles.modeButtonActive]}
                onPress={() => setGroupMode(mode)}
              >
                <Text style={[styles.modeButtonText, groupMode === mode && styles.modeButtonTextActive]}>
                  {mode === 'users' ? 'Utilisateurs' : mode === 'role' ? 'Par rôle' : 'Par tags'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          {groupMode === 'users' && (
            <View>
              <Text style={styles.formLabel}>Participants ({selectedUserIds.length} sélectionnés)</Text>
              {users.map(u => (
                <TouchableOpacity
                  key={u.id}
                  style={[styles.selectableItem, selectedUserIds.includes(u.id) && styles.selectableItemActive]}
                  onPress={() => toggleUserId(u.id)}
                >
                  <View style={[styles.contactAvatar, { backgroundColor: ROLE_COLORS[u.role] || '#6b7280', width: 36, height: 36, borderRadius: 18 }]}>
                    <Text style={[styles.contactAvatarText, { fontSize: 14 }]}>{u.name.charAt(0)}</Text>
                  </View>
                  <View style={styles.contactInfo}>
                    <Text style={styles.contactName}>{u.name}</Text>
                    <Text style={styles.contactRole}>{ROLE_LABELS[u.role] || u.role}</Text>
                  </View>
                  <View style={[styles.checkbox, selectedUserIds.includes(u.id) && styles.checkboxActive]}>
                    {selectedUserIds.includes(u.id) && <Text style={styles.checkmark}>✓</Text>}
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {groupMode === 'role' && (
            <View>
              <Text style={styles.formLabel}>Sélectionner un rôle</Text>
              {['user', 'responder', 'dispatcher', 'admin'].map(role => (
                <TouchableOpacity
                  key={role}
                  style={[styles.selectableItem, selectedRole === role && styles.selectableItemActive]}
                  onPress={() => setSelectedRole(role)}
                >
                  <View style={[styles.roleDot, { backgroundColor: ROLE_COLORS[role] || '#6b7280' }]} />
                  <Text style={styles.selectableItemText}>{ROLE_LABELS[role] || role}</Text>
                  {selectedRole === role && <Text style={styles.selectedMark}>✓</Text>}
                </TouchableOpacity>
              ))}
            </View>
          )}

          {groupMode === 'tags' && (
            <View>
              <Text style={styles.formLabel}>Tags ({selectedTags.length} sélectionnés)</Text>
              {allTags.length > 0 ? (
                <View style={styles.tagsGrid}>
                  {allTags.map(tag => (
                    <TouchableOpacity
                      key={tag}
                      style={[styles.tagButton, selectedTags.includes(tag) && styles.tagButtonActive]}
                      onPress={() => toggleTag(tag)}
                    >
                      <Text style={[styles.tagButtonText, selectedTags.includes(tag) && styles.tagButtonTextActive]}>{tag}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ) : (
                <Text style={styles.helperText}>Aucun tag disponible.</Text>
              )}
            </View>
          )}

          <TouchableOpacity
            style={[styles.createGroupButton, (!groupName.trim() || loading) && styles.createGroupButtonDisabled]}
            onPress={handleCreateGroup}
            disabled={!groupName.trim() || loading}
          >
            {loading ? <ActivityIndicator color="#ffffff" /> : <Text style={styles.createGroupButtonText}>Créer le groupe</Text>}
          </TouchableOpacity>
        </ScrollView>
      </TalionScreen>
    );
  }

  // ─── Conversation List View ─────────────────────────────────────────────

  return (
    <TalionScreen
      showStatus={false}
      rightContent={
        <TouchableOpacity style={styles.newMessageButton} onPress={() => setShowNewMenu(true)}>
          <Text style={styles.newMessageIcon}>+</Text>
        </TouchableOpacity>
      }
    >
      <OfflineBanner />
      <View style={styles.screenHeader}>
        <Text style={styles.screenTitle}>Messages</Text>
      </View>

      {conversations.length > 0 ? (
        <FlatList
          data={conversations}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.conversationItem} onPress={() => openConversation(item)}>
              <View style={[styles.conversationAvatar, { backgroundColor: item.type === 'group' ? '#f59e0b' : '#1e3a5f' }]}>
                <Text style={styles.avatarText}>
                  {item.type === 'group' ? '👥' : (item.displayName?.charAt(0) || '?')}
                </Text>
              </View>
              <View style={styles.conversationContent}>
                <View style={styles.conversationHeaderRow}>
                  <Text style={styles.conversationName} numberOfLines={1}>{item.displayName || item.name}</Text>
                  <Text style={styles.conversationTime}>{item.lastMessageTime ? formatRelativeTime(item.lastMessageTime) : ''}</Text>
                  {(item.unreadCount || 0) > 0 && (
                    <View style={styles.unreadBadge}>
                      <Text style={styles.unreadBadgeText}>{item.unreadCount! > 99 ? '99+' : item.unreadCount}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.conversationPreview} numberOfLines={1}>
                  {item.lastSenderName ? `${item.lastSenderName}: ${item.lastMessage}` : item.lastMessage || 'Aucun message'}
                </Text>
                <View style={styles.conversationMeta}>
                  <View style={[styles.typeBadge, { backgroundColor: item.type === 'group' ? '#fef3c7' : '#eff6ff' }]}>
                    <Text style={[styles.typeBadgeText, { color: item.type === 'group' ? '#92400e' : '#1e40af' }]}>
                      {item.type === 'group' ? `Groupe · ${item.participantCount}` : 'Direct'}
                    </Text>
                  </View>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      ) : (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateIcon}>💬</Text>
          <Text style={styles.emptyStateText}>Aucune conversation</Text>
          <TouchableOpacity style={styles.startConvoButton} onPress={() => setShowNewMenu(true)}>
            <Text style={styles.startConvoText}>Démarrer une conversation</Text>
          </TouchableOpacity>
        </View>
      )}

      <Modal visible={showNewMenu} transparent animationType="fade" onRequestClose={() => setShowNewMenu(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setShowNewMenu(false)}>
          <View style={styles.menuCard}>
            <Text style={styles.menuTitle}>Nouvelle conversation</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setShowNewMenu(false); setView('new-direct'); }}>
              <Text style={styles.menuItemIcon}>👤</Text>
              <View>
                <Text style={styles.menuItemTitle}>Message direct</Text>
                <Text style={styles.menuItemDesc}>Chat 1-to-1</Text>
              </View>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => { setShowNewMenu(false); setView('new-group'); }}>
              <Text style={styles.menuItemIcon}>👥</Text>
              <View>
                <Text style={styles.menuItemTitle}>Groupe</Text>
                <Text style={styles.menuItemDesc}>Par utilisateurs, rôle ou tags</Text>
              </View>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </TalionScreen>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  screenHeader: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  screenTitle: { fontSize: 20, fontWeight: '700', color: '#1e3a5f', flex: 1 },
  headerBackBtn: { marginRight: 12, padding: 4 },
  headerBackText: { fontSize: 22, color: '#1e3a5f', fontWeight: '600' },
  newMessageButton: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.2)', justifyContent: 'center', alignItems: 'center',
  },
  newMessageIcon: { color: '#ffffff', fontSize: 20, fontWeight: 'bold' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  conversationItem: {
    flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6', backgroundColor: '#ffffff',
  },
  conversationAvatar: { width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  avatarText: { color: '#ffffff', fontSize: 18, fontWeight: 'bold' },
  conversationContent: { flex: 1 },
  conversationHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  conversationName: { fontSize: 15, fontWeight: '600', color: '#1f2937', flex: 1, marginRight: 8 },
  conversationTime: { fontSize: 12, color: '#9ca3af' },
  conversationPreview: { fontSize: 13, color: '#6b7280', marginBottom: 4 },
  conversationMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  typeBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 },
  typeBadgeText: { fontSize: 10, fontWeight: '600' },

  emptyState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 32 },
  emptyStateIcon: { fontSize: 48, marginBottom: 12 },
  emptyStateText: { color: '#9ca3af', fontSize: 16, marginBottom: 16 },
  startConvoButton: { backgroundColor: '#1e3a5f', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
  startConvoText: { color: '#ffffff', fontWeight: '600', fontSize: 14 },

  contactList: { paddingBottom: 20 },
  contactItem: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#f3f4f6', backgroundColor: '#ffffff',
  },
  contactAvatar: { width: 44, height: 44, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginRight: 12 },
  contactAvatarText: { color: '#ffffff', fontSize: 16, fontWeight: 'bold' },
  contactInfo: { flex: 1 },
  contactName: { fontSize: 15, fontWeight: '600', color: '#1f2937', marginBottom: 2 },
  contactRole: { fontSize: 12, color: '#6b7280' },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  tagChip: { backgroundColor: '#f0fdf4', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 },
  tagChipText: { fontSize: 10, color: '#166534', fontWeight: '500' },

  chatContainer: { flex: 1, backgroundColor: '#f0f2f5' },
  chatHeader: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  backButton: { marginRight: 8, padding: 6 },
  backIcon: { fontSize: 20, color: '#1e3a5f', fontWeight: '600' },
  chatAvatar: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  chatAvatarText: { color: '#ffffff', fontSize: 14, fontWeight: 'bold' },
  chatHeaderInfo: { flex: 1 },
  chatHeaderName: { fontSize: 15, fontWeight: '600', color: '#1f2937' },
  chatStatusText: { fontSize: 11, color: '#6b7280' },

  messagesContainer: { paddingHorizontal: 12, paddingVertical: 12, flexGrow: 1 },
  messageBubbleContainer: { marginVertical: 3, flexDirection: 'row', alignItems: 'flex-end' },
  myBubbleContainer: { justifyContent: 'flex-end' },
  theirBubbleContainer: { justifyContent: 'flex-start' },
  bubbleAvatar: { width: 28, height: 28, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginRight: 6, marginBottom: 2 },
  bubbleAvatarText: { color: '#ffffff', fontSize: 11, fontWeight: 'bold' },
  messageBubble: { maxWidth: '75%', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16 },
  myBubble: { backgroundColor: '#1e3a5f', borderBottomRightRadius: 4 },
  theirBubble: { backgroundColor: '#ffffff', borderBottomLeftRadius: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 2, elevation: 1 },
  alertBubble: { backgroundColor: '#fef2f2', borderLeftWidth: 3, borderLeftColor: '#ef4444' },
  locationBubble: { backgroundColor: '#eff6ff', borderLeftWidth: 3, borderLeftColor: '#1e3a5f' },
  imageBubble: { padding: 4, backgroundColor: 'transparent' },
  audioBubble: { backgroundColor: '#1e3a5f', minWidth: 180 },
  senderLabel: { fontSize: 11, fontWeight: '600', marginBottom: 2 },
  messageText: { fontSize: 14, color: '#1f2937', lineHeight: 20 },
  myMessageText: { color: '#ffffff' },
  alertMessageText: { color: '#991b1b', fontWeight: '600' },
  timestamp: { fontSize: 10, color: '#9ca3af', marginTop: 3, textAlign: 'right' },
  myTimestamp: { color: 'rgba(255,255,255,0.6)' },
  systemMessageContainer: { alignItems: 'center', marginVertical: 8 },
  systemMessageText: { fontSize: 12, color: '#9ca3af', backgroundColor: '#f3f4f6', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 },
  emptyChatState: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 60 },
  emptyChatIcon: { fontSize: 40, marginBottom: 8 },
  emptyChatText: { fontSize: 16, color: '#6b7280', fontWeight: '500' },
  emptyChatSubtext: { fontSize: 13, color: '#9ca3af', marginTop: 4 },

  messageImage: { width: 220, height: 160, borderRadius: 12 },
  locationPreview: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  locationPin: { fontSize: 20, marginTop: 2 },
  locationText: { fontSize: 13, color: '#1e3a5f', fontWeight: '500', maxWidth: 180 },
  locationCoords: { fontSize: 10, color: '#6b7280', marginTop: 2 },

  recordingBar: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#fef2f2',
    paddingHorizontal: 16, paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#fecaca', gap: 8,
  },
  recordingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#ef4444' },
  recordingText: { flex: 1, fontSize: 13, color: '#dc2626', fontWeight: '500' },
  cancelRecordBtn: { paddingHorizontal: 10, paddingVertical: 4, backgroundColor: '#fecaca', borderRadius: 6 },
  cancelRecordText: { fontSize: 12, color: '#dc2626', fontWeight: '600' },

  sendingBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 16, paddingVertical: 8, backgroundColor: '#f9fafb',
  },
  sendingText: { fontSize: 13, color: '#6b7280' },

  inputContainer: { backgroundColor: '#ffffff', borderTopWidth: 1, borderTopColor: '#e5e7eb', paddingHorizontal: 12, paddingVertical: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  mediaButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#f3f4f6', justifyContent: 'center', alignItems: 'center' },
  mediaIcon: { fontSize: 20, color: '#6b7280', fontWeight: 'bold' },
  input: { flex: 1, backgroundColor: '#f3f4f6', borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, maxHeight: 100, color: '#1f2937' },
  sendButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1e3a5f', justifyContent: 'center', alignItems: 'center' },
  recordingActive: { backgroundColor: '#ef4444' },
  sendButtonDisabled: { backgroundColor: '#d1d5db' },
  sendIcon: { fontSize: 16, color: '#ffffff' },

  mediaMenuOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  mediaMenuCard: { backgroundColor: '#ffffff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 },
  mediaMenuTitle: { fontSize: 16, fontWeight: '700', color: '#1f2937', marginBottom: 16, textAlign: 'center' },
  mediaMenuGrid: { flexDirection: 'row', justifyContent: 'space-around' },
  mediaMenuItem: { alignItems: 'center', gap: 8, padding: 16 },
  mediaMenuItemIcon: { fontSize: 36 },
  mediaMenuItemText: { fontSize: 13, fontWeight: '600', color: '#374151' },

  groupForm: { flex: 1, backgroundColor: '#ffffff', paddingHorizontal: 16, paddingTop: 16 },
  formLabel: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 8, marginTop: 16 },
  formInput: { backgroundColor: '#f3f4f6', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: '#1f2937' },
  modeSelector: { flexDirection: 'row', gap: 8 },
  modeButton: { flex: 1, paddingVertical: 10, borderRadius: 8, backgroundColor: '#f3f4f6', alignItems: 'center' },
  modeButtonActive: { backgroundColor: '#1e3a5f' },
  modeButtonText: { fontSize: 13, fontWeight: '600', color: '#6b7280' },
  modeButtonTextActive: { color: '#ffffff' },
  selectableItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 12, borderRadius: 8, marginBottom: 4, backgroundColor: '#f9fafb' },
  selectableItemActive: { backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#1e3a5f' },
  selectableItemText: { flex: 1, fontSize: 15, fontWeight: '500', color: '#1f2937', marginLeft: 10 },
  selectedMark: { fontSize: 18, color: '#1e3a5f', fontWeight: 'bold' },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: '#d1d5db', justifyContent: 'center', alignItems: 'center' },
  checkboxActive: { backgroundColor: '#1e3a5f', borderColor: '#1e3a5f' },
  checkmark: { color: '#ffffff', fontSize: 14, fontWeight: 'bold' },
  roleDot: { width: 12, height: 12, borderRadius: 6 },
  helperText: { fontSize: 12, color: '#6b7280', marginTop: 8, fontStyle: 'italic' },
  tagsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tagButton: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb' },
  tagButtonActive: { backgroundColor: '#1e3a5f', borderColor: '#1e3a5f' },
  tagButtonText: { fontSize: 13, fontWeight: '500', color: '#6b7280' },
  tagButtonTextActive: { color: '#ffffff' },
  createGroupButton: { backgroundColor: '#1e3a5f', paddingVertical: 14, borderRadius: 10, alignItems: 'center', marginTop: 24 },
  createGroupButtonDisabled: { backgroundColor: '#9ca3af' },
  createGroupButtonText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },

  unreadBadge: {
    backgroundColor: '#ef4444',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  unreadBadgeText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '700',
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center' },
  menuCard: { backgroundColor: '#ffffff', borderRadius: 16, padding: 20, width: '80%', maxWidth: 320 },
  menuTitle: { fontSize: 18, fontWeight: '700', color: '#1f2937', marginBottom: 16 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 12 },
  menuItemIcon: { fontSize: 28 },
  menuItemTitle: { fontSize: 15, fontWeight: '600', color: '#1f2937' },
  menuItemDesc: { fontSize: 12, color: '#6b7280', marginTop: 1 },
});
