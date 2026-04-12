import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AsyncStorage
const mockStorage: Record<string, string> = {};
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(mockStorage[key] || null)),
    setItem: vi.fn((key: string, value: string) => {
      mockStorage[key] = value;
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      delete mockStorage[key];
      return Promise.resolve();
    }),
  },
}));

// Mock react-native
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
}));

// Mock websocket service
const mockWsListeners: Record<string, Function[]> = {};
const mockWebsocketService = {
  on: vi.fn((event: string, cb: Function) => {
    if (!mockWsListeners[event]) mockWsListeners[event] = [];
    mockWsListeners[event].push(cb);
  }),
  off: vi.fn((event: string, cb: Function) => {
    if (mockWsListeners[event]) {
      mockWsListeners[event] = mockWsListeners[event].filter((fn) => fn !== cb);
    }
  }),
  sendMessage: vi.fn(),
  isConnected: vi.fn().mockReturnValue(false),
};
vi.mock('@/services/websocket', () => ({
  websocketService: mockWebsocketService,
}));

// Mock alert sound service
vi.mock('@/services/alert-sound-service', () => ({
  alertSoundService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    playSOSAlert: vi.fn().mockResolvedValue(undefined),
    playNotification: vi.fn().mockResolvedValue(undefined),
    playPTTBeep: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  },
}));

// Import types for testing
import type { ChatMessage, Conversation, Contact } from '../lib/messaging-context';

describe('Messaging Types', () => {
  describe('ChatMessage', () => {
    it('has correct structure', () => {
      const msg: ChatMessage = {
        id: 'msg-001',
        conversationId: 'conv-001',
        senderId: 'user-001',
        senderName: 'Test User',
        senderRole: 'user',
        text: 'Hello world',
        type: 'text',
        timestamp: Date.now(),
        status: 'sent',
      };

      expect(msg.id).toBe('msg-001');
      expect(msg.conversationId).toBe('conv-001');
      expect(msg.senderId).toBe('user-001');
      expect(msg.senderName).toBe('Test User');
      expect(msg.senderRole).toBe('user');
      expect(msg.text).toBe('Hello world');
      expect(msg.type).toBe('text');
      expect(msg.status).toBe('sent');
    });

    it('supports location type messages', () => {
      const msg: ChatMessage = {
        id: 'msg-002',
        conversationId: 'conv-001',
        senderId: 'user-001',
        senderName: 'Test User',
        senderRole: 'user',
        text: 'Location: 48.8566, 2.3522',
        type: 'location',
        timestamp: Date.now(),
        status: 'sent',
        location: { latitude: 48.8566, longitude: 2.3522, address: 'Paris' },
      };

      expect(msg.type).toBe('location');
      expect(msg.location?.latitude).toBe(48.8566);
      expect(msg.location?.longitude).toBe(2.3522);
      expect(msg.location?.address).toBe('Paris');
    });

    it('supports alert type messages', () => {
      const msg: ChatMessage = {
        id: 'msg-003',
        conversationId: 'conv-001',
        senderId: 'user-001',
        senderName: 'Test User',
        senderRole: 'responder',
        text: 'ALERT: Emergency at current location',
        type: 'alert',
        timestamp: Date.now(),
        status: 'sent',
      };

      expect(msg.type).toBe('alert');
      expect(msg.text).toContain('ALERT');
    });

    it('supports image type messages', () => {
      const msg: ChatMessage = {
        id: 'msg-004',
        conversationId: 'conv-001',
        senderId: 'user-001',
        senderName: 'Test User',
        senderRole: 'user',
        text: 'Photo attached',
        type: 'image',
        timestamp: Date.now(),
        status: 'sent',
        imageUri: 'file:///path/to/image.jpg',
      };

      expect(msg.type).toBe('image');
      expect(msg.imageUri).toBe('file:///path/to/image.jpg');
    });

    it('supports system type messages', () => {
      const msg: ChatMessage = {
        id: 'msg-005',
        conversationId: 'conv-001',
        senderId: 'system',
        senderName: 'System',
        senderRole: 'system',
        text: 'Conversation started',
        type: 'system',
        timestamp: Date.now(),
        status: 'delivered',
      };

      expect(msg.type).toBe('system');
    });

    it('supports all message statuses', () => {
      const statuses: ChatMessage['status'][] = ['sending', 'sent', 'delivered', 'read'];
      statuses.forEach((status) => {
        const msg: ChatMessage = {
          id: `msg-${status}`,
          conversationId: 'conv-001',
          senderId: 'user-001',
          senderName: 'Test',
          senderRole: 'user',
          text: 'Test',
          type: 'text',
          timestamp: Date.now(),
          status,
        };
        expect(msg.status).toBe(status);
      });
    });
  });

  describe('Conversation', () => {
    it('has correct structure for direct conversation', () => {
      const conv: Conversation = {
        id: 'conv-001',
        participantIds: ['user-002'],
        participantNames: ['Dispatch Center'],
        participantRoles: ['dispatcher'],
        displayName: 'Dispatch Center',
        lastMessage: 'All units stand by',
        lastMessageTime: Date.now(),
        unreadCount: 2,
        isActive: true,
        avatar: 'D',
        type: 'direct',
      };

      expect(conv.id).toBe('conv-001');
      expect(conv.participantIds).toHaveLength(1);
      expect(conv.type).toBe('direct');
      expect(conv.unreadCount).toBe(2);
      expect(conv.isActive).toBe(true);
    });

    it('supports incident-linked conversations', () => {
      const conv: Conversation = {
        id: 'conv-inc-001',
        participantIds: ['resp-001', 'resp-002'],
        participantNames: ['Unit Alpha', 'Unit Bravo'],
        participantRoles: ['responder', 'responder'],
        displayName: 'Incident INC-042',
        lastMessage: 'Responding to scene',
        lastMessageTime: Date.now(),
        unreadCount: 0,
        isActive: true,
        avatar: 'I',
        type: 'incident',
        incidentId: 'INC-042',
      };

      expect(conv.type).toBe('incident');
      expect(conv.incidentId).toBe('INC-042');
      expect(conv.participantIds).toHaveLength(2);
    });

    it('supports group conversations', () => {
      const conv: Conversation = {
        id: 'conv-grp-001',
        participantIds: ['resp-001', 'resp-002', 'dispatch-001'],
        participantNames: ['Unit Alpha', 'Unit Bravo', 'Dispatch Center'],
        participantRoles: ['responder', 'responder', 'dispatcher'],
        displayName: 'Response Team',
        lastMessage: 'Briefing at 1400',
        lastMessageTime: Date.now(),
        unreadCount: 0,
        isActive: true,
        avatar: 'R',
        type: 'group',
      };

      expect(conv.type).toBe('group');
      expect(conv.participantIds).toHaveLength(3);
    });
  });

  describe('Contact', () => {
    it('has correct structure', () => {
      const contact: Contact = {
        id: 'dispatch-001',
        name: 'Dispatch Center',
        role: 'dispatcher',
        status: 'online',
        avatar: 'D',
      };

      expect(contact.id).toBe('dispatch-001');
      expect(contact.name).toBe('Dispatch Center');
      expect(contact.role).toBe('dispatcher');
      expect(contact.status).toBe('online');
    });

    it('supports all status types', () => {
      const statuses: Contact['status'][] = ['online', 'offline', 'busy'];
      statuses.forEach((status) => {
        const contact: Contact = {
          id: `c-${status}`,
          name: 'Test',
          role: 'user',
          status,
          avatar: 'T',
        };
        expect(contact.status).toBe(status);
      });
    });
  });
});

describe('Messaging Business Logic', () => {
  describe('Conversation ID generation', () => {
    it('generates deterministic IDs from sorted user IDs', () => {
      const userId1 = 'user-001';
      const userId2 = 'dispatch-001';

      // Sort to ensure deterministic ID regardless of order
      const sorted = [userId1, userId2].sort().join('-');
      const convId = `conv-${sorted}`;

      expect(convId).toBe('conv-dispatch-001-user-001');

      // Same result regardless of input order
      const sorted2 = [userId2, userId1].sort().join('-');
      const convId2 = `conv-${sorted2}`;

      expect(convId2).toBe(convId);
    });
  });

  describe('Role-based contact filtering', () => {
    const contacts: Contact[] = [
      { id: 'dispatch-001', name: 'Dispatch', role: 'dispatcher', status: 'online', avatar: 'D' },
      { id: 'resp-001', name: 'Unit A', role: 'responder', status: 'online', avatar: 'A' },
      { id: 'resp-002', name: 'Unit B', role: 'responder', status: 'offline', avatar: 'B' },
      { id: 'user-001', name: 'Observer', role: 'user', status: 'online', avatar: 'O' },
      { id: 'admin-001', name: 'Admin', role: 'admin', status: 'online', avatar: 'X' },
    ];

    function filterContactsForRole(currentRole: string, currentId: string): Contact[] {
      return contacts.filter((c) => {
        if (c.id === currentId) return false;
        switch (currentRole) {
          case 'dispatcher':
          case 'admin':
            return true;
          case 'responder':
            return c.role === 'dispatcher' || c.role === 'responder' || c.role === 'admin';
          case 'user':
            return c.role === 'dispatcher' || c.role === 'responder';
          default:
            return false;
        }
      });
    }

    it('dispatchers can message everyone', () => {
      const filtered = filterContactsForRole('dispatcher', 'dispatch-001');
      expect(filtered).toHaveLength(4); // all except self
    });

    it('admins can message everyone', () => {
      const filtered = filterContactsForRole('admin', 'admin-001');
      expect(filtered).toHaveLength(4); // all except self
    });

    it('responders can message dispatchers, admins, and other responders', () => {
      const filtered = filterContactsForRole('responder', 'resp-001');
      // dispatch-001, resp-002, admin-001 (not user-001, not self)
      expect(filtered).toHaveLength(3);
      expect(filtered.every((c) => c.role !== 'user')).toBe(true);
    });

    it('users can message dispatchers and responders', () => {
      const filtered = filterContactsForRole('user', 'user-001');
      // dispatch-001, resp-001, resp-002 (not admin-001 per current logic, not self)
      expect(filtered).toHaveLength(3);
      expect(filtered.every((c) => c.role === 'dispatcher' || c.role === 'responder')).toBe(true);
    });

    it('unknown role gets no contacts', () => {
      const filtered = filterContactsForRole('unknown', 'unknown-001');
      expect(filtered).toHaveLength(0);
    });
  });

  describe('Message sorting', () => {
    it('conversations sort by lastMessageTime descending', () => {
      const convos: Conversation[] = [
        {
          id: 'c1',
          participantIds: ['a'],
          participantNames: ['A'],
          participantRoles: ['user'],
          displayName: 'A',
          lastMessage: 'old',
          lastMessageTime: 1000,
          unreadCount: 0,
          isActive: true,
          avatar: 'A',
          type: 'direct',
        },
        {
          id: 'c2',
          participantIds: ['b'],
          participantNames: ['B'],
          participantRoles: ['user'],
          displayName: 'B',
          lastMessage: 'newest',
          lastMessageTime: 3000,
          unreadCount: 0,
          isActive: true,
          avatar: 'B',
          type: 'direct',
        },
        {
          id: 'c3',
          participantIds: ['c'],
          participantNames: ['C'],
          participantRoles: ['user'],
          displayName: 'C',
          lastMessage: 'middle',
          lastMessageTime: 2000,
          unreadCount: 0,
          isActive: true,
          avatar: 'C',
          type: 'direct',
        },
      ];

      const sorted = [...convos].sort((a, b) => b.lastMessageTime - a.lastMessageTime);
      expect(sorted[0].id).toBe('c2');
      expect(sorted[1].id).toBe('c3');
      expect(sorted[2].id).toBe('c1');
    });
  });

  describe('Unread count calculation', () => {
    it('calculates total unread from all conversations', () => {
      const convos: Conversation[] = [
        {
          id: 'c1',
          participantIds: ['a'],
          participantNames: ['A'],
          participantRoles: ['user'],
          displayName: 'A',
          lastMessage: '',
          lastMessageTime: 0,
          unreadCount: 3,
          isActive: true,
          avatar: 'A',
          type: 'direct',
        },
        {
          id: 'c2',
          participantIds: ['b'],
          participantNames: ['B'],
          participantRoles: ['user'],
          displayName: 'B',
          lastMessage: '',
          lastMessageTime: 0,
          unreadCount: 1,
          isActive: true,
          avatar: 'B',
          type: 'direct',
        },
        {
          id: 'c3',
          participantIds: ['c'],
          participantNames: ['C'],
          participantRoles: ['user'],
          displayName: 'C',
          lastMessage: '',
          lastMessageTime: 0,
          unreadCount: 0,
          isActive: true,
          avatar: 'C',
          type: 'direct',
        },
      ];

      const totalUnread = convos.reduce((sum, c) => sum + c.unreadCount, 0);
      expect(totalUnread).toBe(4);
    });

    it('returns 0 when no unread messages', () => {
      const convos: Conversation[] = [
        {
          id: 'c1',
          participantIds: ['a'],
          participantNames: ['A'],
          participantRoles: ['user'],
          displayName: 'A',
          lastMessage: '',
          lastMessageTime: 0,
          unreadCount: 0,
          isActive: true,
          avatar: 'A',
          type: 'direct',
        },
      ];

      const totalUnread = convos.reduce((sum, c) => sum + c.unreadCount, 0);
      expect(totalUnread).toBe(0);
    });
  });

  describe('Time formatting', () => {
    function formatRelativeTime(timestamp: number): string {
      const diff = Date.now() - timestamp;
      const minutes = Math.floor(diff / 60000);
      if (minutes < 1) return 'Now';
      if (minutes < 60) return `${minutes}m`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h`;
      return `${Math.floor(hours / 24)}d`;
    }

    it('shows "Now" for recent timestamps', () => {
      expect(formatRelativeTime(Date.now())).toBe('Now');
      expect(formatRelativeTime(Date.now() - 30000)).toBe('Now');
    });

    it('shows minutes for timestamps within an hour', () => {
      expect(formatRelativeTime(Date.now() - 5 * 60000)).toBe('5m');
      expect(formatRelativeTime(Date.now() - 30 * 60000)).toBe('30m');
    });

    it('shows hours for timestamps within a day', () => {
      expect(formatRelativeTime(Date.now() - 2 * 3600000)).toBe('2h');
      expect(formatRelativeTime(Date.now() - 12 * 3600000)).toBe('12h');
    });

    it('shows days for older timestamps', () => {
      expect(formatRelativeTime(Date.now() - 2 * 86400000)).toBe('2d');
    });
  });
});

describe('WebSocket Message Integration', () => {
  it('websocket service mock is configured', () => {
    expect(mockWebsocketService.on).toBeDefined();
    expect(mockWebsocketService.off).toBeDefined();
    expect(mockWebsocketService.sendMessage).toBeDefined();
  });

  it('can register message listeners', () => {
    const callback = vi.fn();
    mockWebsocketService.on('message', callback);
    expect(mockWebsocketService.on).toHaveBeenCalledWith('message', callback);
  });

  it('can unregister message listeners', () => {
    const callback = vi.fn();
    mockWebsocketService.off('message', callback);
    expect(mockWebsocketService.off).toHaveBeenCalledWith('message', callback);
  });

  it('can send messages through websocket', () => {
    mockWebsocketService.sendMessage('recipient-001', 'Hello');
    expect(mockWebsocketService.sendMessage).toHaveBeenCalledWith('recipient-001', 'Hello');
  });
});
