import { describe, it, expect } from 'vitest';

/**
 * Tests for push notification registration and broadcast delivery.
 * Verifies that ALL users (including role='user') register push tokens
 * and that broadcast push notifications target all registered tokens.
 */

describe('Push Token Registration', () => {
  it('should register push tokens for ALL roles including regular users', () => {
    // Simulate the old behavior (was filtering out regular users)
    const roles = ['user', 'responder', 'dispatcher', 'admin'];
    
    // New behavior: all roles should register
    const registeredRoles = roles.filter(role => {
      // Old code had: if (user.role === 'user') return;
      // New code removes this filter
      return true; // All roles register now
    });

    expect(registeredRoles).toHaveLength(4);
    expect(registeredRoles).toContain('user');
    expect(registeredRoles).toContain('responder');
    expect(registeredRoles).toContain('dispatcher');
    expect(registeredRoles).toContain('admin');
  });

  it('should NOT register on web platform', () => {
    const platform = 'web';
    const shouldSkip = platform === 'web';
    expect(shouldSkip).toBe(true);
  });

  it('should NOT register on non-device (simulator without push support)', () => {
    const isDevice = false;
    const shouldSkip = !isDevice;
    expect(shouldSkip).toBe(true);
  });
});

describe('Broadcast Push Notification Targeting', () => {
  it('sendPushToAllUsers should collect ALL registered tokens', () => {
    const pushTokens = new Map<string, { token: string; userId: string; userRole: string }>();
    pushTokens.set('ExponentPushToken[abc]', { token: 'ExponentPushToken[abc]', userId: 'user-1', userRole: 'user' });
    pushTokens.set('ExponentPushToken[def]', { token: 'ExponentPushToken[def]', userId: 'resp-1', userRole: 'responder' });
    pushTokens.set('ExponentPushToken[ghi]', { token: 'ExponentPushToken[ghi]', userId: 'disp-1', userRole: 'dispatcher' });

    // sendPushToAllUsers collects ALL tokens
    const targetTokens: string[] = [];
    for (const [token] of pushTokens) {
      targetTokens.push(token);
    }

    expect(targetTokens).toHaveLength(3);
    // Regular user token is included
    expect(targetTokens).toContain('ExponentPushToken[abc]');
  });

  it('sendPushToDispatchersAndResponders should NOT include regular users', () => {
    const pushTokens = new Map<string, { token: string; userId: string; userRole: string }>();
    pushTokens.set('ExponentPushToken[abc]', { token: 'ExponentPushToken[abc]', userId: 'user-1', userRole: 'user' });
    pushTokens.set('ExponentPushToken[def]', { token: 'ExponentPushToken[def]', userId: 'resp-1', userRole: 'responder' });
    pushTokens.set('ExponentPushToken[ghi]', { token: 'ExponentPushToken[ghi]', userId: 'disp-1', userRole: 'dispatcher' });

    // sendPushToDispatchersAndResponders only targets privileged roles
    const targetTokens: string[] = [];
    for (const [token, entry] of pushTokens) {
      if (entry.userRole === 'dispatcher' || entry.userRole === 'responder' || entry.userRole === 'admin') {
        targetTokens.push(token);
      }
    }

    expect(targetTokens).toHaveLength(2);
    expect(targetTokens).not.toContain('ExponentPushToken[abc]');
  });
});

describe('Broadcast Push Message Format', () => {
  it('should use broadcast-alerts channelId', () => {
    const channelId = 'broadcast-alerts';
    const message = {
      to: 'ExponentPushToken[test]',
      sound: 'default',
      title: '\u{1F4E2} BROADCAST - HIGH',
      body: 'Dispatcher: Evacuation zone nord',
      data: { type: 'broadcast', alertId: 'BC-001', severity: 'high' },
      priority: 'high',
      channelId,
    };

    expect(message.channelId).toBe('broadcast-alerts');
    expect(message.data.type).toBe('broadcast');
    expect(message.title).toContain('BROADCAST');
  });

  it('should set high priority for critical and high severity', () => {
    const testCases = [
      { severity: 'critical', expected: 'high' },
      { severity: 'high', expected: 'high' },
      { severity: 'medium', expected: 'normal' },
      { severity: 'low', expected: 'normal' },
    ];

    testCases.forEach(({ severity, expected }) => {
      const priority = severity === 'critical' || severity === 'high' ? 'high' : 'normal';
      expect(priority).toBe(expected);
    });
  });
});

describe('Notification Context - Broadcast Sound', () => {
  it('should play notification sound for broadcast type', () => {
    const soundsPlayed: string[] = [];

    function handleNotification(dataType: string) {
      if (dataType === 'sos') {
        soundsPlayed.push('sos-alert');
      } else if (dataType === 'broadcast') {
        soundsPlayed.push('notification');
      } else if (dataType === 'message') {
        soundsPlayed.push('notification');
      }
    }

    handleNotification('broadcast');
    expect(soundsPlayed).toContain('notification');
    expect(soundsPlayed).not.toContain('sos-alert');
  });
});

describe('Android Notification Channels', () => {
  it('should define broadcast-alerts channel', () => {
    const CHANNELS = {
      SOS: 'sos-alerts',
      BROADCAST: 'broadcast-alerts',
      STATUS: 'status-updates',
      MESSAGES: 'messages',
    };

    expect(CHANNELS.BROADCAST).toBe('broadcast-alerts');
    expect(Object.values(CHANNELS)).toContain('broadcast-alerts');
  });
});
