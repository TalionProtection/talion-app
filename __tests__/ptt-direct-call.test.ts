/**
 * Tests for PTT broadcast fix (wsClientMap) and direct 1-on-1 call feature
 */
import { describe, it, expect } from 'vitest';

describe('PTT Broadcast Fix - wsClientMap', () => {
  it('should map ws clients to userId for O(1) lookup', () => {
    // Simulate wsClientMap behavior
    const wsClientMap = new Map<string, string>();
    const ws1 = 'ws-client-1';
    const ws2 = 'ws-client-2';
    const ws3 = 'ws-client-3';

    wsClientMap.set(ws1, 'user-alice');
    wsClientMap.set(ws2, 'dispatch-console');
    wsClientMap.set(ws3, 'user-bob');

    expect(wsClientMap.get(ws1)).toBe('user-alice');
    expect(wsClientMap.get(ws2)).toBe('dispatch-console');
    expect(wsClientMap.get(ws3)).toBe('user-bob');
    expect(wsClientMap.get('unknown')).toBeUndefined();
  });

  it('should clean up wsClientMap on disconnect', () => {
    const wsClientMap = new Map<string, string>();
    const userConnections = new Map<string, Set<string>>();

    const ws1 = 'ws-client-1';
    wsClientMap.set(ws1, 'user-alice');
    userConnections.set('user-alice', new Set([ws1]));

    // Simulate disconnect
    wsClientMap.delete(ws1);
    const conns = userConnections.get('user-alice');
    if (conns) {
      conns.delete(ws1);
      if (conns.size === 0) userConnections.delete('user-alice');
    }

    expect(wsClientMap.has(ws1)).toBe(false);
    expect(userConnections.has('user-alice')).toBe(false);
  });

  it('should always deliver PTT messages to dispatchers and admins', () => {
    // Simulate the broadcast logic
    const users = new Map<string, { role: string }>();
    users.set('user-alice', { role: 'user' });
    users.set('dispatch-console', { role: 'dispatcher' });
    users.set('admin-1', { role: 'admin' });
    users.set('responder-1', { role: 'responder' });

    const channel = {
      id: 'general',
      allowedRoles: ['user', 'responder', 'dispatcher', 'admin'],
      members: [] as string[],
    };

    const recipients: string[] = [];
    const senderId = 'user-alice';

    for (const [userId, userData] of users.entries()) {
      if (userId === senderId) continue;
      const role = userData.role;
      // Admin and dispatcher always receive
      if (role === 'admin' || role === 'dispatcher') {
        recipients.push(userId);
        continue;
      }
      if (channel.allowedRoles.includes(role)) {
        if (channel.members.length > 0 && !channel.members.includes(userId)) continue;
        recipients.push(userId);
      }
    }

    expect(recipients).toContain('dispatch-console');
    expect(recipients).toContain('admin-1');
    expect(recipients).toContain('responder-1');
    expect(recipients).not.toContain('user-alice'); // sender excluded
  });

  it('should deliver direct channel messages only to members + dispatchers/admins', () => {
    const users = new Map<string, { role: string }>();
    users.set('user-alice', { role: 'user' });
    users.set('dispatch-console', { role: 'dispatcher' });
    users.set('admin-1', { role: 'admin' });
    users.set('user-bob', { role: 'user' });

    const channel = {
      id: 'direct-123',
      allowedRoles: ['user', 'responder', 'dispatcher', 'admin'],
      members: ['user-alice', 'dispatch-console'],
    };

    const recipients: string[] = [];
    const senderId = 'user-alice';

    for (const [userId, userData] of users.entries()) {
      if (userId === senderId) continue;
      const role = userData.role;
      if (role === 'admin' || role === 'dispatcher') {
        recipients.push(userId);
        continue;
      }
      if (channel.allowedRoles.includes(role)) {
        if (channel.members.length > 0 && !channel.members.includes(userId)) continue;
        recipients.push(userId);
      }
    }

    expect(recipients).toContain('dispatch-console');
    expect(recipients).toContain('admin-1'); // admins always receive
    expect(recipients).not.toContain('user-bob'); // not a member
  });
});

describe('Direct PTT Channel', () => {
  it('should create a direct channel with correct structure', () => {
    const channel = {
      id: `direct-${Date.now()}-abc123`,
      name: 'Alice ↔ Dispatch',
      description: 'Appel direct entre Alice et Dispatch',
      allowedRoles: ['user', 'responder', 'dispatcher', 'admin'],
      isActive: true,
      isDefault: false,
      createdBy: 'user-alice',
      createdAt: Date.now(),
      members: ['user-alice', 'dispatch-console'],
    };

    expect(channel.id).toMatch(/^direct-/);
    expect(channel.members).toHaveLength(2);
    expect(channel.members).toContain('user-alice');
    expect(channel.members).toContain('dispatch-console');
    expect(channel.isDefault).toBe(false);
    expect(channel.name).toContain('↔');
  });

  it('should find existing direct channel between same two users', () => {
    const channels = [
      { id: 'direct-1', members: ['user-alice', 'dispatch-console'] },
      { id: 'direct-2', members: ['user-bob', 'dispatch-console'] },
      { id: 'general', members: [] },
    ];

    const userId1 = 'user-alice';
    const userId2 = 'dispatch-console';

    const existing = channels.find(ch =>
      ch.members && ch.members.length === 2 &&
      ch.members.includes(userId1) && ch.members.includes(userId2) &&
      ch.id.startsWith('direct-')
    );

    expect(existing).toBeDefined();
    expect(existing!.id).toBe('direct-1');
  });

  it('should not find direct channel for different user pair', () => {
    const channels = [
      { id: 'direct-1', members: ['user-alice', 'dispatch-console'] },
    ];

    const existing = channels.find(ch =>
      ch.members && ch.members.length === 2 &&
      ch.members.includes('user-bob') && ch.members.includes('dispatch-console') &&
      ch.id.startsWith('direct-')
    );

    expect(existing).toBeUndefined();
  });

  it('should show direct channels with purple color', () => {
    function getChannelColor(channelId: string): string {
      switch (channelId) {
        case 'emergency': return '#ef4444';
        case 'dispatch': return '#1e3a5f';
        case 'responders': return '#22c55e';
        case 'general': return '#3b82f6';
        default:
          if (channelId.startsWith('direct-')) return '#8b5cf6';
          return '#f59e0b';
      }
    }

    expect(getChannelColor('direct-123')).toBe('#8b5cf6');
    expect(getChannelColor('direct-456-abc')).toBe('#8b5cf6');
    expect(getChannelColor('general')).toBe('#3b82f6');
    expect(getChannelColor('custom-group')).toBe('#f59e0b');
  });

  it('dispatchers should see all direct channels', () => {
    const channels = [
      { id: 'general', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], members: [] },
      { id: 'direct-1', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], members: ['user-alice', 'dispatch-console'] },
      { id: 'direct-2', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], members: ['user-bob', 'dispatch-console'] },
    ];

    const userRole = 'dispatcher';
    const userId = 'dispatch-console';

    const accessible = channels.filter(ch => {
      if (userRole === 'admin') return true;
      if (userRole === 'dispatcher') {
        if (!ch.allowedRoles.includes('dispatcher')) return false;
        return true;
      }
      if (!ch.allowedRoles.includes(userRole)) return false;
      if (ch.members && ch.members.length > 0 && !ch.members.includes(userId)) return false;
      return true;
    });

    expect(accessible).toHaveLength(3);
  });

  it('regular users should only see their own direct channels', () => {
    const channels = [
      { id: 'general', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], members: [] },
      { id: 'direct-1', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], members: ['user-alice', 'dispatch-console'] },
      { id: 'direct-2', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], members: ['user-bob', 'dispatch-console'] },
    ];

    const userRole = 'user';
    const userId = 'user-alice';

    const accessible = channels.filter(ch => {
      if (userRole === 'admin') return true;
      if (userRole === 'dispatcher') return true;
      if (!ch.allowedRoles.includes(userRole)) return false;
      if (ch.members && ch.members.length > 0 && !ch.members.includes(userId)) return false;
      return true;
    });

    expect(accessible).toHaveLength(2); // general + direct-1
    expect(accessible.map(c => c.id)).toContain('general');
    expect(accessible.map(c => c.id)).toContain('direct-1');
    expect(accessible.map(c => c.id)).not.toContain('direct-2');
  });
});
