/**
 * Push-to-Talk Service
 * Manages audio recording, playback, channels, and message history.
 * Connected to server via WebSocket and REST API.
 */

import { getApiBaseUrl } from '@/lib/server-url';

export interface PTTChannel {
  id: string;
  name: string;
  description: string;
  /** Roles allowed to transmit on this channel */
  allowedRoles: ('user' | 'responder' | 'dispatcher' | 'admin')[];
  /** Whether the channel is currently active */
  isActive: boolean;
  /** Whether this is a default (non-deletable) channel */
  isDefault?: boolean;
  /** Who created the channel */
  createdBy?: string;
  /** Specific member user IDs (for custom groups) */
  members?: string[];
  /** Number of users currently listening (local UI only) */
  listenerCount: number;
}

export interface PTTMessage {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  senderRole: 'user' | 'responder' | 'dispatcher' | 'admin';
  /** URI of the recorded audio file (local) or base64 audio data (from server) */
  audioUri: string;
  /** Base64-encoded audio data for server transmission */
  audioBase64?: string;
  /** MIME type of the audio (e.g., 'audio/m4a', 'audio/webm') */
  mimeType?: string;
  /** Duration in seconds */
  duration: number;
  timestamp: Date;
  /** Whether this message has been played */
  played: boolean;
}

export interface TalkingUser {
  userId: string;
  userName: string;
  userRole: string;
  channelId: string;
}

export interface PTTState {
  currentChannel: PTTChannel | null;
  isRecording: boolean;
  isPlaying: boolean;
  currentPlayingMessageId: string | null;
  messages: PTTMessage[];
  channels: PTTChannel[];
  /** Users currently talking on any channel */
  talkingUsers: TalkingUser[];
  /** Whether an emergency broadcast is active */
  emergencyActive: boolean;
  /** The last emergency message received */
  lastEmergencyMessage: PTTMessage | null;
}

/**
 * Fetch channels from server
 */
export async function fetchChannels(userRole: string, userId: string): Promise<PTTChannel[]> {
  try {
    const base = getApiBaseUrl();
    const res = await fetch(`${base}/api/ptt/channels?role=${userRole}&userId=${userId}`);
    if (!res.ok) throw new Error('Failed to fetch channels');
    const data = await res.json();
    return data.map((ch: any) => ({
      ...ch,
      listenerCount: 0,
    }));
  } catch (error) {
    console.error('[PTT] Failed to fetch channels:', error);
    return DEFAULT_CHANNELS;
  }
}

/**
 * Create a custom channel (dispatcher/admin only)
 */
export async function createChannel(params: {
  name: string;
  description: string;
  allowedRoles: string[];
  members?: string[];
  createdBy: string;
  createdByRole: string;
}): Promise<PTTChannel | null> {
  try {
    const base = getApiBaseUrl();
    const res = await fetch(`${base}/api/ptt/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error('Failed to create channel');
    const data = await res.json();
    return { ...data, listenerCount: 0 };
  } catch (error) {
    console.error('[PTT] Failed to create channel:', error);
    return null;
  }
}

/**
 * Delete a custom channel (dispatcher/admin only)
 */
export async function deleteChannel(channelId: string, userRole: string): Promise<boolean> {
  try {
    const base = getApiBaseUrl();
    const res = await fetch(`${base}/api/ptt/channels/${channelId}?userRole=${userRole}`, {
      method: 'DELETE',
    });
    return res.ok;
  } catch (error) {
    console.error('[PTT] Failed to delete channel:', error);
    return false;
  }
}

/**
 * Transmit audio via REST fallback
 */
export async function transmitAudioREST(params: {
  channelId: string;
  audioBase64: string;
  mimeType?: string;
  duration: number;
  senderId: string;
  senderName: string;
  senderRole: string;
}): Promise<boolean> {
  try {
    const base = getApiBaseUrl();
    const res = await fetch(`${base}/api/ptt/transmit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return res.ok;
  } catch (error) {
    console.error('[PTT] REST transmit failed:', error);
    return false;
  }
}

/**
 * Create or find a direct 1-on-1 PTT channel between two users
 */
export async function createDirectChannel(params: {
  userId1: string;
  userId2: string;
  userName1: string;
  userName2: string;
}): Promise<PTTChannel | null> {
  try {
    const base = getApiBaseUrl();
    const res = await fetch(`${base}/api/ptt/channels/direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    if (!res.ok) throw new Error('Failed to create direct channel');
    const data = await res.json();
    return { ...data, listenerCount: 0 };
  } catch (error) {
    console.error('[PTT] Failed to create direct channel:', error);
    return null;
  }
}

/** Default channels available in the app */
export const DEFAULT_CHANNELS: PTTChannel[] = [
  {
    id: 'emergency',
    name: 'Urgence',
    description: 'Canal d\'urgence - tous les rôles',
    allowedRoles: ['user', 'responder', 'dispatcher', 'admin'],
    isActive: true,
    isDefault: true,
    listenerCount: 0,
  },
  {
    id: 'dispatch',
    name: 'Dispatch',
    description: 'Canal de coordination dispatch',
    allowedRoles: ['responder', 'dispatcher', 'admin'],
    isActive: true,
    isDefault: true,
    listenerCount: 0,
  },
  {
    id: 'responders',
    name: 'Intervenants',
    description: 'Canal équipe intervenants',
    allowedRoles: ['responder', 'dispatcher', 'admin'],
    isActive: true,
    isDefault: true,
    listenerCount: 0,
  },
  {
    id: 'general',
    name: 'Général',
    description: 'Canal de communication général',
    allowedRoles: ['user', 'responder', 'dispatcher', 'admin'],
    isActive: true,
    isDefault: true,
    listenerCount: 0,
  },
];

/**
 * Check if a user role can transmit on a given channel
 */
export function canTransmitOnChannel(
  channel: PTTChannel,
  userRole: string
): boolean {
  if (userRole === 'admin') return true;
  return channel.allowedRoles.includes(userRole as any);
}

/**
 * Format duration in seconds to MM:SS string
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Format timestamp to relative time string
 */
export function formatTimestamp(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);

  if (diffSecs < 60) return 'À l\'instant';
  if (diffMins < 60) return `Il y a ${diffMins}m`;
  if (diffHours < 24) return `Il y a ${diffHours}h`;
  return new Date(date).toLocaleDateString('fr-CH');
}

/**
 * Get role color for UI display
 */
export function getRoleColor(role: string): string {
  switch (role) {
    case 'dispatcher': return '#1e3a5f';
    case 'responder': return '#22c55e';
    case 'user': return '#8b5cf6';
    case 'admin': return '#ef4444';
    default: return '#6b7280';
  }
}

/**
 * Get channel color for UI display
 */
export function getChannelColor(channelId: string): string {
  switch (channelId) {
    case 'emergency': return '#ef4444';
    case 'dispatch': return '#1e3a5f';
    case 'responders': return '#22c55e';
    case 'general': return '#3b82f6';
    default:
      if (channelId.startsWith('direct-')) return '#8b5cf6'; // direct channels in purple
      return '#f59e0b'; // custom channels in amber
  }
}
