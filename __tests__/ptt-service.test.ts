import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CHANNELS,
  canTransmitOnChannel,
  formatDuration,
  formatTimestamp,
  getRoleColor,
  getChannelColor,
} from '../services/ptt-service';

describe('PTT Service', () => {
  describe('DEFAULT_CHANNELS', () => {
    it('should have 4 default channels', () => {
      expect(DEFAULT_CHANNELS).toHaveLength(4);
    });

    it('should have emergency, dispatch, responders, and general channels', () => {
      const channelIds = DEFAULT_CHANNELS.map((c) => c.id);
      expect(channelIds).toContain('emergency');
      expect(channelIds).toContain('dispatch');
      expect(channelIds).toContain('responders');
      expect(channelIds).toContain('general');
    });

    it('emergency channel should allow all roles', () => {
      const emergency = DEFAULT_CHANNELS.find((c) => c.id === 'emergency')!;
      expect(emergency.allowedRoles).toContain('user');
      expect(emergency.allowedRoles).toContain('responder');
      expect(emergency.allowedRoles).toContain('dispatcher');
      expect(emergency.allowedRoles).toContain('admin');
    });

    it('dispatch channel should not allow users', () => {
      const dispatch = DEFAULT_CHANNELS.find((c) => c.id === 'dispatch')!;
      expect(dispatch.allowedRoles).not.toContain('user');
      expect(dispatch.allowedRoles).toContain('responder');
      expect(dispatch.allowedRoles).toContain('dispatcher');
    });

    it('responders channel should not allow users', () => {
      const responders = DEFAULT_CHANNELS.find((c) => c.id === 'responders')!;
      expect(responders.allowedRoles).not.toContain('user');
      expect(responders.allowedRoles).toContain('responder');
      expect(responders.allowedRoles).toContain('dispatcher');
    });
  });

  describe('canTransmitOnChannel', () => {
    it('should allow user on emergency channel', () => {
      const emergency = DEFAULT_CHANNELS.find((c) => c.id === 'emergency')!;
      expect(canTransmitOnChannel(emergency, 'user')).toBe(true);
    });

    it('should deny user on dispatch channel', () => {
      const dispatch = DEFAULT_CHANNELS.find((c) => c.id === 'dispatch')!;
      expect(canTransmitOnChannel(dispatch, 'user')).toBe(false);
    });

    it('should allow dispatcher on all channels', () => {
      DEFAULT_CHANNELS.forEach((channel) => {
        expect(canTransmitOnChannel(channel, 'dispatcher')).toBe(true);
      });
    });

    it('should allow responder on dispatch and responders channels', () => {
      const dispatch = DEFAULT_CHANNELS.find((c) => c.id === 'dispatch')!;
      const responders = DEFAULT_CHANNELS.find((c) => c.id === 'responders')!;
      expect(canTransmitOnChannel(dispatch, 'responder')).toBe(true);
      expect(canTransmitOnChannel(responders, 'responder')).toBe(true);
    });

    it('should allow admin on all channels', () => {
      DEFAULT_CHANNELS.forEach((channel) => {
        expect(canTransmitOnChannel(channel, 'admin')).toBe(true);
      });
    });
  });

  describe('formatDuration', () => {
    it('should format 0 seconds', () => {
      expect(formatDuration(0)).toBe('0:00');
    });

    it('should format seconds only', () => {
      expect(formatDuration(5)).toBe('0:05');
      expect(formatDuration(30)).toBe('0:30');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(65)).toBe('1:05');
      expect(formatDuration(125)).toBe('2:05');
    });

    it('should handle decimal seconds', () => {
      expect(formatDuration(5.7)).toBe('0:05');
    });
  });

  describe('formatTimestamp', () => {
    it('should return "Just now" for recent timestamps', () => {
      const now = new Date();
      expect(formatTimestamp(now)).toBe('Just now');
    });

    it('should return minutes ago for timestamps within an hour', () => {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
      expect(formatTimestamp(fiveMinAgo)).toBe('5m ago');
    });

    it('should return hours ago for timestamps within a day', () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      expect(formatTimestamp(twoHoursAgo)).toBe('2h ago');
    });
  });

  describe('getRoleColor', () => {
    it('should return correct colors for each role', () => {
      expect(getRoleColor('dispatcher')).toBe('#1e3a5f');
      expect(getRoleColor('responder')).toBe('#22c55e');
      expect(getRoleColor('user')).toBe('#8b5cf6');
      expect(getRoleColor('admin')).toBe('#ef4444');
    });

    it('should return default color for unknown role', () => {
      expect(getRoleColor('unknown')).toBe('#6b7280');
    });
  });

  describe('getChannelColor', () => {
    it('should return correct colors for each channel', () => {
      expect(getChannelColor('emergency')).toBe('#ef4444');
      expect(getChannelColor('dispatch')).toBe('#1e3a5f');
      expect(getChannelColor('responders')).toBe('#22c55e');
      expect(getChannelColor('general')).toBe('#3b82f6');
    });

    it('should return default color for unknown channel', () => {
      expect(getChannelColor('unknown')).toBe('#6b7280');
    });
  });
});
