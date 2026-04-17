/**
 * LiveKit PTT Service
 * Gère la connexion PTT via LiveKit pour Talion Crisis Comm
 */

import { Room, RoomEvent, Track, LocalParticipant, ConnectionState } from '@livekit/react-native';
import { getApiBaseUrl } from './server-url';

class LiveKitPTTService {
  private room: Room | null = null;
  private isConnected = false;
  private isTransmitting = false;
  private currentRoom = '';

  // Callbacks
  onConnectionChange?: (connected: boolean) => void;
  onSpeakerChange?: (speakerId: string, speakerName: string, isSpeaking: boolean) => void;
  onError?: (error: string) => void;

  async getToken(userId: string, userName: string, roomName: string): Promise<{ token: string; url: string }> {
    const res = await fetch(`${getApiBaseUrl()}/api/livekit/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, userName, roomName }),
    });
    if (!res.ok) throw new Error('Failed to get LiveKit token');
    return res.json();
  }

  async connect(userId: string, userName: string, roomName: string): Promise<void> {
    try {
      if (this.room) await this.disconnect();

      const { token, url } = await this.getToken(userId, userName, roomName);
      
      this.room = new Room();
      this.currentRoom = roomName;

      this.room.on(RoomEvent.Connected, () => {
        this.isConnected = true;
        this.onConnectionChange?.(true);
        console.log('[LiveKit] Connected to room:', roomName);
      });

      this.room.on(RoomEvent.Disconnected, () => {
        this.isConnected = false;
        this.onConnectionChange?.(false);
        console.log('[LiveKit] Disconnected from room:', roomName);
      });

      this.room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        speakers.forEach(speaker => {
          this.onSpeakerChange?.(speaker.identity, speaker.name || speaker.identity, true);
        });
      });

      await this.room.connect(url, token, {
        autoSubscribe: true,
      });

      // Démarrer avec micro désactivé (PTT)
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
      await this.room.localParticipant.setMicrophoneEnabled(true);
      this.isTransmitting = true;
      console.log('[LiveKit] PTT: transmitting');
    } catch (e: any) {
      console.error('[LiveKit] Transmit error:', e);
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
    }
  }

  async disconnect(): Promise<void> {
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
      this.isConnected = false;
      this.isTransmitting = false;
    }
  }

  getIsConnected() { return this.isConnected; }
  getIsTransmitting() { return this.isTransmitting; }
  getCurrentRoom() { return this.currentRoom; }
}

export const livekitPTT = new LiveKitPTTService();
