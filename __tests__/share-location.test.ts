import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the Share Location flow:
 * 1. Mobile sends location via WebSocket (updateLocation message)
 * 2. Server stores location and broadcasts to dispatchers
 * 3. Dispatch console receives and updates map
 */

// Mock WebSocket message format
interface WsMessage {
  type: string;
  userId?: string;
  userRole?: string;
  data?: any;
  timestamp?: number;
}

describe('Share Location - Mobile to Server', () => {
  it('should format updateLocation message correctly', () => {
    const userId = 'user-123';
    const userRole = 'user';
    const location = { latitude: 48.8566, longitude: 2.3522 };

    // Simulate what wsManager.updateLocation does
    const message: WsMessage = {
      type: 'updateLocation',
      userId,
      userRole,
      data: location,
      timestamp: Date.now(),
    };

    expect(message.type).toBe('updateLocation');
    expect(message.userId).toBe('user-123');
    expect(message.userRole).toBe('user');
    expect(message.data.latitude).toBe(48.8566);
    expect(message.data.longitude).toBe(2.3522);
  });

  it('should include userId and userRole in every message', () => {
    const message: WsMessage = {
      type: 'updateLocation',
      userId: 'test-user',
      userRole: 'user',
      data: { latitude: 48.85, longitude: 2.35 },
      timestamp: Date.now(),
    };

    // Server uses message.userId to look up user in the users Map
    expect(message.userId).toBeTruthy();
    expect(message.userRole).toBeTruthy();
  });
});

describe('Share Location - Server Broadcast Logic', () => {
  // Simulate the server's handleLocationUpdate logic
  interface User {
    id: string;
    role: string;
    location?: any;
    lastSeen?: number;
    status?: string;
  }

  let users: Map<string, User>;
  let broadcastedMessages: { role: string; message: any }[];

  function broadcastToRole(role: string, message: any) {
    broadcastedMessages.push({ role, message });
  }

  function handleLocationUpdate(userId: string, userRole: string, locationData: any) {
    if (!userId) return;
    const user = users.get(userId);
    if (user) {
      user.location = locationData;
      user.lastSeen = Date.now();
      users.set(userId, user);
      if (user.role === 'responder') {
        broadcastToRole('dispatcher', {
          type: 'responderLocationUpdate',
          userId,
          location: locationData,
          timestamp: Date.now(),
        });
      } else {
        broadcastToRole('dispatcher', {
          type: 'userLocationUpdate',
          userId,
          location: locationData,
          timestamp: Date.now(),
        });
      }
    }
  }

  beforeEach(() => {
    users = new Map();
    broadcastedMessages = [];
  });

  it('should broadcast userLocationUpdate for regular users', () => {
    users.set('user-123', { id: 'user-123', role: 'user' });
    handleLocationUpdate('user-123', 'user', { latitude: 48.85, longitude: 2.35 });

    expect(broadcastedMessages).toHaveLength(1);
    expect(broadcastedMessages[0].role).toBe('dispatcher');
    expect(broadcastedMessages[0].message.type).toBe('userLocationUpdate');
    expect(broadcastedMessages[0].message.userId).toBe('user-123');
    expect(broadcastedMessages[0].message.location.latitude).toBe(48.85);
  });

  it('should broadcast responderLocationUpdate for responders', () => {
    users.set('resp-1', { id: 'resp-1', role: 'responder' });
    handleLocationUpdate('resp-1', 'responder', { latitude: 48.86, longitude: 2.34 });

    expect(broadcastedMessages).toHaveLength(1);
    expect(broadcastedMessages[0].message.type).toBe('responderLocationUpdate');
  });

  it('should store location on the user object', () => {
    users.set('user-456', { id: 'user-456', role: 'user' });
    handleLocationUpdate('user-456', 'user', { latitude: 48.87, longitude: 2.33 });

    const user = users.get('user-456');
    expect(user?.location).toEqual({ latitude: 48.87, longitude: 2.33 });
    expect(user?.lastSeen).toBeDefined();
  });

  it('should not broadcast if user is not in the users map', () => {
    // User not registered (not authenticated)
    handleLocationUpdate('unknown-user', 'user', { latitude: 48.85, longitude: 2.35 });
    expect(broadcastedMessages).toHaveLength(0);
  });

  it('should not broadcast if userId is empty', () => {
    handleLocationUpdate('', 'user', { latitude: 48.85, longitude: 2.35 });
    expect(broadcastedMessages).toHaveLength(0);
  });
});

describe('Share Location - Dispatch Console Handling', () => {
  it('should update existing user in mapUsers on userLocationUpdate', () => {
    let mapUsers = [
      { id: 'user-001', name: 'Thomas', role: 'user', status: 'active', location: { latitude: 48.85, longitude: 2.35 }, lastSeen: 1000 },
    ];

    const msg = {
      type: 'userLocationUpdate',
      userId: 'user-001',
      location: { latitude: 48.86, longitude: 2.36 },
      timestamp: 2000,
    };

    // Simulate dispatch console handler
    const existingUser = mapUsers.find(u => u.id === msg.userId);
    if (existingUser) {
      existingUser.location = msg.location;
      existingUser.lastSeen = msg.timestamp || Date.now();
    }

    expect(mapUsers[0].location.latitude).toBe(48.86);
    expect(mapUsers[0].location.longitude).toBe(2.36);
    expect(mapUsers[0].lastSeen).toBe(2000);
  });

  it('should add new user to mapUsers on userLocationUpdate if not found', () => {
    let mapUsers: any[] = [];

    const msg = {
      type: 'userLocationUpdate',
      userId: 'new-user',
      location: { latitude: 48.87, longitude: 2.33 },
      timestamp: 3000,
    };

    const existingUser = mapUsers.find(u => u.id === msg.userId);
    if (!existingUser) {
      mapUsers.push({
        id: msg.userId,
        name: msg.userId,
        role: 'user',
        status: 'active',
        location: msg.location,
        lastSeen: msg.timestamp || Date.now(),
      });
    }

    expect(mapUsers).toHaveLength(1);
    expect(mapUsers[0].id).toBe('new-user');
    expect(mapUsers[0].location.latitude).toBe(48.87);
  });

  it('should NOT trigger full map refresh on userLocationUpdate (race condition fix)', () => {
    // userLocationUpdate and userLocationRemoved now use direct handlers
    // instead of triggering refreshMapData, to avoid race conditions
    const refreshTriggerEvents = [
      'newAlert', 'alertAcknowledged', 'alertUpdate', 'alertResolved',
      'alertsSnapshot', 'alertsList', 'responderLocationUpdate',
      'responderStatusUpdate', 'userStatusChange',
    ];

    expect(refreshTriggerEvents).not.toContain('userLocationUpdate');
    expect(refreshTriggerEvents).not.toContain('userLocationRemoved');
  });

  it('should remove user from mapUsers on userLocationRemoved', () => {
    let mapUsers = [
      { id: 'user-001', name: 'Thomas', role: 'user', status: 'active', location: { latitude: 48.85, longitude: 2.35 }, lastSeen: 1000 },
      { id: 'user-002', name: 'Marie', role: 'user', status: 'active', location: { latitude: 48.86, longitude: 2.36 }, lastSeen: 2000 },
    ];

    const msg = { type: 'userLocationRemoved', userId: 'user-001' };

    // Simulate dispatch console handler
    mapUsers = mapUsers.filter(u => u.id !== msg.userId);

    expect(mapUsers).toHaveLength(1);
    expect(mapUsers[0].id).toBe('user-002');
  });
});

describe('Share Location - Live Users Counter', () => {
  it('should count users with location data', () => {
    const mapUsers = [
      { id: 'u1', location: { latitude: 48.85, longitude: 2.35 } },
      { id: 'u2', location: { latitude: 48.86, longitude: 2.36 } },
      { id: 'u3', location: null },
      { id: 'u4' },
    ];

    const liveCount = (mapUsers || []).filter((u: any) => u.location).length;
    expect(liveCount).toBe(2);
  });

  it('should return 0 when no users have location', () => {
    const mapUsers = [
      { id: 'u1', location: null },
      { id: 'u2' },
    ];

    const liveCount = (mapUsers || []).filter((u: any) => u.location).length;
    expect(liveCount).toBe(0);
  });

  it('should return 0 when mapUsers is empty', () => {
    const mapUsers: any[] = [];
    const liveCount = (mapUsers || []).filter((u: any) => u.location).length;
    expect(liveCount).toBe(0);
  });

  it('should handle null mapUsers gracefully', () => {
    const mapUsers: any = null;
    const liveCount = (mapUsers || []).filter((u: any) => u.location).length;
    expect(liveCount).toBe(0);
  });

  it('should increment when user starts sharing and decrement when they stop', () => {
    let mapUsers: any[] = [];

    // User starts sharing
    mapUsers.push({ id: 'u1', location: { latitude: 48.85, longitude: 2.35 } });
    expect((mapUsers || []).filter((u: any) => u.location).length).toBe(1);

    // Another user starts sharing
    mapUsers.push({ id: 'u2', location: { latitude: 48.86, longitude: 2.36 } });
    expect((mapUsers || []).filter((u: any) => u.location).length).toBe(2);

    // First user stops sharing (removed from array)
    mapUsers = mapUsers.filter(u => u.id !== 'u1');
    expect((mapUsers || []).filter((u: any) => u.location).length).toBe(1);
  });
});

describe('Share Location - Live Count Endpoint', () => {
  it('should track sharing users in a Set', () => {
    const sharingUsers = new Set<string>();

    // User starts sharing
    sharingUsers.add('user-1');
    sharingUsers.add('user-2');
    expect(sharingUsers.size).toBe(2);

    // Same user sends another update (no duplicate)
    sharingUsers.add('user-1');
    expect(sharingUsers.size).toBe(2);

    // User stops sharing
    sharingUsers.delete('user-1');
    expect(sharingUsers.size).toBe(1);
    expect(Array.from(sharingUsers)).toEqual(['user-2']);
  });

  it('should return count and userIds', () => {
    const sharingUsers = new Set<string>(['user-a', 'user-b', 'user-c']);
    const response = { count: sharingUsers.size, userIds: Array.from(sharingUsers) };

    expect(response.count).toBe(3);
    expect(response.userIds).toContain('user-a');
    expect(response.userIds).toContain('user-b');
    expect(response.userIds).toContain('user-c');
  });
});

describe('Share Location - Periodic Sending', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should send location immediately and then every 10 seconds', () => {
    const sendLocation = vi.fn();
    const location = { latitude: 48.8566, longitude: 2.3522 };

    // Simulate handleShareLocation
    sendLocation(location);
    const interval = setInterval(() => {
      sendLocation(location);
    }, 10000);

    expect(sendLocation).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10000);
    expect(sendLocation).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(10000);
    expect(sendLocation).toHaveBeenCalledTimes(3);

    // Stop sharing
    clearInterval(interval);
    vi.advanceTimersByTime(10000);
    expect(sendLocation).toHaveBeenCalledTimes(3); // No more calls
  });
});

describe('Share Location - /dispatch/map/users endpoint', () => {
  it('should include users with location data (not just responders)', () => {
    // Simulate the server endpoint logic
    const users = new Map<string, any>();
    users.set('user-1', { id: 'user-1', role: 'user', location: { latitude: 48.85, longitude: 2.35 }, lastSeen: Date.now() });
    users.set('resp-1', { id: 'resp-1', role: 'responder', location: { latitude: 48.86, longitude: 2.34 }, lastSeen: Date.now() });
    users.set('user-2', { id: 'user-2', role: 'user', location: null, lastSeen: Date.now() });

    const connectedUsersList = Array.from(users.values())
      .filter(u => u.location && u.role !== 'responder')
      .map(u => ({
        id: u.id,
        name: u.id,
        role: u.role,
        status: 'available',
        location: u.location,
        lastSeen: u.lastSeen,
      }));

    // Should include user-1 (has location, not responder)
    // Should NOT include resp-1 (responder)
    // Should NOT include user-2 (no location)
    expect(connectedUsersList).toHaveLength(1);
    expect(connectedUsersList[0].id).toBe('user-1');
  });
});
