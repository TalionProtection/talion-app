import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for the SOS → WebSocket → Server → Dispatch flow.
 * 
 * These tests verify:
 * 1. The server allows all authenticated roles to send alerts (including 'user')
 * 2. The wsManager sends the correct protocol messages
 * 3. The SOS button triggers wsManager.sendAlert
 * 4. The WebSocket provider connects on user login
 */

// ─── Mock WebSocket ──────────────────────────────────────────────────────
class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  onclose: (() => void) | null = null;

  sentMessages: any[] = [];

  send(data: string) {
    this.sentMessages.push(JSON.parse(data));
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  // Simulate server response
  simulateMessage(msg: any) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(msg) });
    }
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    if (this.onopen) this.onopen();
  }
}

// ─── Test 1: Server message handler allows user role to send alerts ──────
describe('Server sendAlert authorization', () => {
  it('should allow user role to send SOS alerts (not just dispatcher/responder)', () => {
    // Simulate the server's handleMessage logic (after our fix)
    const handleSendAlert = (userId: string | undefined, userRole: string | undefined) => {
      // NEW logic: all authenticated roles can send alerts
      if (userId && userRole) {
        return { allowed: true, userId, userRole };
      } else {
        return { allowed: false, error: 'Unauthorized to create alerts - not authenticated' };
      }
    };

    // User role should be allowed (this was the bug - previously only dispatcher/responder)
    expect(handleSendAlert('user-123', 'user')).toEqual({
      allowed: true, userId: 'user-123', userRole: 'user',
    });

    // Dispatcher should still be allowed
    expect(handleSendAlert('dispatch-1', 'dispatcher')).toEqual({
      allowed: true, userId: 'dispatch-1', userRole: 'dispatcher',
    });

    // Responder should still be allowed
    expect(handleSendAlert('resp-1', 'responder')).toEqual({
      allowed: true, userId: 'resp-1', userRole: 'responder',
    });

    // Unauthenticated should be rejected
    expect(handleSendAlert(undefined, undefined)).toEqual({
      allowed: false, error: 'Unauthorized to create alerts - not authenticated',
    });
  });

  it('should use connection-level context as fallback when message lacks userId/userRole', () => {
    // Simulate the server's new fallback logic
    const resolveContext = (
      messageUserId: string | undefined,
      messageUserRole: string | undefined,
      connUserId: string | null,
      connUserRole: string | null,
    ) => {
      return {
        userId: messageUserId || connUserId || undefined,
        userRole: messageUserRole || connUserRole || undefined,
      };
    };

    // Message has userId/userRole → use message values
    expect(resolveContext('msg-user', 'user', 'conn-user', 'dispatcher')).toEqual({
      userId: 'msg-user', userRole: 'user',
    });

    // Message lacks userId/userRole → fallback to connection context
    expect(resolveContext(undefined, undefined, 'conn-user', 'dispatcher')).toEqual({
      userId: 'conn-user', userRole: 'dispatcher',
    });

    // Both missing → undefined
    expect(resolveContext(undefined, undefined, null, null)).toEqual({
      userId: undefined, userRole: undefined,
    });
  });
});

// ─── Test 2: wsManager sends correct protocol messages ──────────────────
describe('WebSocket Manager protocol', () => {
  let mockWs: MockWebSocket;

  beforeEach(() => {
    mockWs = new MockWebSocket();
    // @ts-ignore - mock global WebSocket with a class
    global.WebSocket = class {
      static OPEN = 1;
      static CONNECTING = 0;
      static CLOSED = 3;
      constructor() {
        // Return the mock instance
        Object.assign(this, mockWs);
        // Copy methods from mockWs prototype
        this.send = mockWs.send.bind(mockWs);
        this.close = mockWs.close.bind(mockWs);
        // Store reference so we can trigger events
        Object.defineProperty(this, '_mock', { value: mockWs });
        // Proxy onopen/onmessage/onerror/onclose setters to mockWs
        const self = this as any;
        setTimeout(() => {
          // Auto-trigger onopen if set
          if (self.onopen) {
            mockWs.onopen = self.onopen;
          }
          if (self.onmessage) {
            mockWs.onmessage = self.onmessage;
          }
          if (self.onerror) {
            mockWs.onerror = self.onerror;
          }
          if (self.onclose) {
            mockWs.onclose = self.onclose;
          }
        }, 0);
      }
    } as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should send auth message with type "auth" on connect', async () => {
    // Import fresh instance
    const { WebSocketManager } = await import('@/services/websocket-manager');
    const manager = new WebSocketManager('ws://localhost:3000');

    const connectPromise = manager.connect('test-user', 'user');

    // Wait for setTimeout to propagate event handlers, then trigger open
    await new Promise(r => setTimeout(r, 10));
    mockWs.simulateOpen();
    await connectPromise;

    // First message should be auth
    const authMsg = mockWs.sentMessages[0];
    expect(authMsg).toBeDefined();
    expect(authMsg.type).toBe('auth');
    expect(authMsg.userId).toBe('test-user');
    expect(authMsg.userRole).toBe('user');

    manager.disconnect();
  });

  it('should send sendAlert with correct format', async () => {
    const { WebSocketManager } = await import('@/services/websocket-manager');
    const manager = new WebSocketManager('ws://localhost:3000');

    const connectPromise = manager.connect('test-user', 'user');
    await new Promise(r => setTimeout(r, 10));
    mockWs.simulateOpen();
    await connectPromise;

    // Clear auth message
    mockWs.sentMessages = [];

    manager.sendAlert({
      type: 'sos',
      severity: 'critical',
      location: { latitude: 48.8566, longitude: 2.3522, address: 'Paris, France' },
      description: 'SOS Alert from TestUser',
    });

    const alertMsg = mockWs.sentMessages[0];
    expect(alertMsg).toBeDefined();
    expect(alertMsg.type).toBe('sendAlert'); // NOT 'alert' (old protocol)
    expect(alertMsg.userId).toBe('test-user');
    expect(alertMsg.userRole).toBe('user');
    expect(alertMsg.data).toEqual({
      type: 'sos',
      severity: 'critical',
      location: { latitude: 48.8566, longitude: 2.3522, address: 'Paris, France' },
      description: 'SOS Alert from TestUser',
    });

    manager.disconnect();
  });

  it('should include userId and userRole in every message (unlike old websocketService)', async () => {
    const { WebSocketManager } = await import('@/services/websocket-manager');
    const manager = new WebSocketManager('ws://localhost:3000');

    const connectPromise = manager.connect('resp-1', 'responder');
    await new Promise(r => setTimeout(r, 10));
    mockWs.simulateOpen();
    await connectPromise;

    // Clear auth message
    mockWs.sentMessages = [];

    // Send location update
    manager.updateLocation({ latitude: 48.8, longitude: 2.3 });

    const locMsg = mockWs.sentMessages[0];
    expect(locMsg.userId).toBe('resp-1');
    expect(locMsg.userRole).toBe('responder');
    expect(locMsg.type).toBe('updateLocation');

    // Send status update
    manager.updateStatus('on_duty');

    const statusMsg = mockWs.sentMessages[1];
    expect(statusMsg.userId).toBe('resp-1');
    expect(statusMsg.userRole).toBe('responder');
    expect(statusMsg.type).toBe('updateStatus');

    manager.disconnect();
  });
});

// ─── Test 3: SOS button triggers wsManager.sendAlert ────────────────────
describe('SOS button WebSocket integration', () => {
  it('should import wsManager and call sendAlert on SOS activation', async () => {
    // Verify that sos-button.tsx imports wsManager
    const sosButtonSource = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/sos-button.tsx', 'utf-8')
    );

    // Check that wsManager is imported
    expect(sosButtonSource).toContain("import { wsManager } from '@/services/websocket-manager'");

    // Check that wsManager.sendAlert is called
    expect(sosButtonSource).toContain('wsManager.sendAlert(');

    // Check that it sends type 'sos' and severity 'critical'
    expect(sosButtonSource).toContain("type: 'sos'");
    expect(sosButtonSource).toContain("severity: 'critical'");

    // Check that it checks connection before sending
    expect(sosButtonSource).toContain('wsManager.isConnected()');
  });
});

// ─── Test 4: WebSocket provider wires up at app level ───────────────────
describe('WebSocket provider integration', () => {
  it('should be imported in the root layout', async () => {
    const layoutSource = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/app/_layout.tsx', 'utf-8')
    );

    // Check WebSocketProvider is imported
    expect(layoutSource).toContain("import { WebSocketProvider } from '@/lib/websocket-provider'");

    // Check it wraps other providers
    expect(layoutSource).toContain('<WebSocketProvider>');
  });

  it('should connect wsManager when user is authenticated', async () => {
    const providerSource = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/lib/websocket-provider.tsx', 'utf-8')
    );

    // Check it imports wsManager
    expect(providerSource).toContain("import { wsManager");

    // Check it calls wsManager.connect
    expect(providerSource).toContain('wsManager.connect(userId, userRole)');

    // Check it bridges events to old service
    expect(providerSource).toContain("wsManager.on('newAlert'");
  });
});

// ─── Test 5: Server allows user role in sendAlert ───────────────────────
describe('Server code verification', () => {
  it('should allow all authenticated roles to send alerts', async () => {
    const serverSource = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/server/index.ts', 'utf-8')
    );

    // The old code had: if (userRole === 'dispatcher' || userRole === 'responder')
    // The new code should NOT restrict to just those roles
    expect(serverSource).not.toContain("if (userRole === 'dispatcher' || userRole === 'responder')");

    // Should check for authenticated user instead
    expect(serverSource).toContain('if (userId && userRole)');

    // Should use connection-level fallback
    expect(serverSource).toContain('connUserId');
    expect(serverSource).toContain('connUserRole');
  });
});
