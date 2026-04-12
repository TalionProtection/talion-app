/**
 * Alert Sound Service
 * Manages audio playback for SOS alerts, siren notifications, and PTT beeps.
 * Uses expo-audio createAudioPlayer for native and Web Audio API for web.
 */

import { Platform } from 'react-native';

// Sound types supported by the service
export type SoundType = 'sos' | 'notification' | 'ptt_beep' | 'siren' | 'siren_short';

// Sound assets - require() at module level for bundling
const SOUND_ASSETS: Record<SoundType, any> = {
  sos: require('@/assets/sounds/sos-alert.mp3'),
  notification: require('@/assets/sounds/notification.mp3'),
  ptt_beep: require('@/assets/sounds/ptt-beep.mp3'),
  siren: require('@/assets/sounds/siren-alert.mp3'),
  siren_short: require('@/assets/sounds/siren-short.mp3'),
};

class AlertSoundService {
  private isInitialized = false;
  private isMuted = false;
  private createPlayerFn: ((source: any) => any) | null = null;
  private activePlayers: any[] = [];

  /**
   * Initialize the sound service.
   * On native: imports expo-audio and sets audio mode.
   * On web: marks as ready (uses Web Audio API fallback).
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      if (Platform.OS !== 'web') {
        const { createAudioPlayer, setAudioModeAsync } = await import('expo-audio');

        // Enable playback in iOS silent mode
        await setAudioModeAsync({
          playsInSilentMode: true,
        });

        this.createPlayerFn = createAudioPlayer;
      }

      this.isInitialized = true;
    } catch (error) {
      console.warn('AlertSoundService: Failed to initialize audio', error);
      this.isInitialized = true; // Mark as initialized to prevent repeated attempts
    }
  }

  /**
   * Play a specific sound type.
   * Creates a fresh player each time for reliability (avoids stale player issues).
   * @param type - The type of sound to play
   * @param volume - Volume level (0.0 to 1.0), defaults to 1.0
   */
  async play(type: SoundType, volume: number = 1.0): Promise<void> {
    if (this.isMuted) return;

    try {
      if (Platform.OS === 'web') {
        this.playWebAudio(type);
        return;
      }

      if (!this.createPlayerFn) {
        console.warn('AlertSoundService: Not initialized or createAudioPlayer not available');
        return;
      }

      const asset = SOUND_ASSETS[type];
      if (!asset) {
        console.warn(`AlertSoundService: No asset found for sound type: ${type}`);
        return;
      }

      // Create a fresh player for each play to avoid stale player issues
      const player = this.createPlayerFn(asset);
      this.activePlayers.push(player);
      player.volume = Math.max(0, Math.min(1, volume));
      player.play();

      // Clean up the player after it finishes (estimated max duration)
      const cleanupDelay = type === 'siren' ? 15000 : type === 'siren_short' ? 5000 : 3000;
      setTimeout(() => {
        try {
          player.remove();
          const idx = this.activePlayers.indexOf(player);
          if (idx !== -1) this.activePlayers.splice(idx, 1);
        } catch {
          // Ignore cleanup errors
        }
      }, cleanupDelay);
    } catch (error) {
      console.warn(`AlertSoundService: Failed to play sound: ${type}`, error);
    }
  }

  /**
   * Play the SOS alert sound (loud, attention-grabbing).
   */
  async playSOSAlert(): Promise<void> {
    await this.play('sos', 1.0);
  }

  /**
   * Play a notification sound (moderate volume).
   */
  async playNotification(): Promise<void> {
    await this.play('notification', 0.8);
  }

  /**
   * Play the PTT beep sound (short, quick).
   */
  async playPTTBeep(): Promise<void> {
    await this.play('ptt_beep', 0.7);
  }

  /**
   * Play the siren alert sound (loud, emergency siren for broadcasts/incidents).
   */
  async playSiren(): Promise<void> {
    await this.play('siren', 1.0);
  }

  /**
   * Play a short siren sound (for quick alert notifications).
   */
  async playSirenShort(): Promise<void> {
    await this.play('siren_short', 0.9);
  }

  /**
   * Stop all currently playing sounds.
   */
  stopAll(): void {
    for (const player of this.activePlayers) {
      try {
        player.pause();
        player.remove();
      } catch {
        // Ignore errors during stop
      }
    }
    this.activePlayers = [];
  }

  /**
   * Set mute state for all sounds.
   */
  setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted) {
      this.stopAll();
    }
  }

  /**
   * Get current mute state.
   */
  getMuted(): boolean {
    return this.isMuted;
  }

  /**
   * Clean up all audio players.
   * Should be called when the app is shutting down.
   */
  cleanup(): void {
    this.stopAll();
    this.createPlayerFn = null;
    this.isInitialized = false;
  }

  /**
   * Web fallback using Web Audio API for siren/alert sounds.
   */
  private playWebAudio(type: SoundType): void {
    try {
      if (typeof window === 'undefined') return;
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      switch (type) {
        case 'sos':
        case 'siren': {
          // Simulate a loud siren with oscillating frequency (wee-woo effect)
          const duration = type === 'siren' ? 3.0 : 1.5;
          oscillator.type = 'sawtooth';
          const cycles = type === 'siren' ? 6 : 3;
          for (let i = 0; i < cycles; i++) {
            const t = ctx.currentTime + (i * duration) / cycles;
            oscillator.frequency.setValueAtTime(600, t);
            oscillator.frequency.linearRampToValueAtTime(1200, t + duration / (cycles * 2));
            oscillator.frequency.linearRampToValueAtTime(600, t + duration / cycles);
          }
          gainNode.gain.value = 0.5;
          oscillator.start();
          oscillator.stop(ctx.currentTime + duration);
          break;
        }
        case 'siren_short': {
          // Short siren burst
          oscillator.type = 'sawtooth';
          oscillator.frequency.setValueAtTime(600, ctx.currentTime);
          oscillator.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.3);
          oscillator.frequency.linearRampToValueAtTime(600, ctx.currentTime + 0.6);
          oscillator.frequency.linearRampToValueAtTime(1200, ctx.currentTime + 0.9);
          gainNode.gain.value = 0.4;
          oscillator.start();
          oscillator.stop(ctx.currentTime + 1.0);
          break;
        }
        case 'notification': {
          oscillator.frequency.value = 523;
          gainNode.gain.value = 0.3;
          oscillator.start();
          oscillator.stop(ctx.currentTime + 0.3);
          break;
        }
        case 'ptt_beep': {
          oscillator.frequency.value = 1000;
          gainNode.gain.value = 0.2;
          oscillator.start();
          oscillator.stop(ctx.currentTime + 0.15);
          break;
        }
      }
    } catch {
      // Web audio not available
    }
  }
}

// Export singleton instance
export const alertSoundService = new AlertSoundService();
