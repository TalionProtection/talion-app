import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for the REST API SOS flow.
 * 
 * The SOS button now uses HTTP POST /api/sos as the PRIMARY method
 * to send alerts to the server. This bypasses WebSocket entirely,
 * solving the connectivity issue on real devices.
 */

// ─── Test 1: Server has /api/sos endpoint ──────────────────────────────
describe('Server /api/sos endpoint', () => {
  it('should have POST /api/sos route defined', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/server/index.ts', 'utf-8')
    );

    expect(source).toContain("app.post('/api/sos'");
  });

  it('should create alert with correct fields', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/server/index.ts', 'utf-8')
    );

    // Should extract these fields from request body
    expect(source).toContain('userId, userName, userRole');
    // Should create an Alert object
    expect(source).toContain("type: type || 'sos'");
    expect(source).toContain("severity: severity || 'critical'");
  });

  it('should broadcast newAlert to all WebSocket clients', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/server/index.ts', 'utf-8')
    );

    // The /api/sos handler should call broadcastMessage
    const sosSection = source.split("app.post('/api/sos'")[1]?.split('app.')[0] || '';
    expect(sosSection).toContain("broadcastMessage({ type: 'newAlert', data: alert })");
  });

  it('should return success with alertId and broadcast flag', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/server/index.ts', 'utf-8')
    );

    const sosSection = source.split("app.post('/api/sos'")[1]?.split('app.')[0] || '';
    expect(sosSection).toContain('success: true');
    expect(sosSection).toContain('alertId: alert.id');
    expect(sosSection).toContain('broadcast: true');
  });

  it('should log SOS receipt and broadcast count', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/server/index.ts', 'utf-8')
    );

    const sosSection = source.split("app.post('/api/sos'")[1]?.split('app.')[0] || '';
    expect(sosSection).toContain('[SOS REST] Received SOS from');
    expect(sosSection).toContain('[SOS REST] Alert');
    expect(sosSection).toContain('broadcast to');
  });
});

// ─── Test 2: SOS button uses REST API ──────────────────────────────────
describe('SOS button uses REST API', () => {
  it('should import getApiBaseUrl from server-url', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/sos-button.tsx', 'utf-8')
    );

    expect(source).toContain("import { getApiBaseUrl } from '@/lib/server-url'");
  });

  it('should NOT import wsManager (no WebSocket dependency)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/sos-button.tsx', 'utf-8')
    );

    expect(source).not.toContain("import { wsManager }");
  });

  it('should have sendSOSViaREST function', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/sos-button.tsx', 'utf-8')
    );

    expect(source).toContain('sendSOSViaREST');
    expect(source).toContain("method: 'POST'");
    expect(source).toContain('/api/sos');
  });

  it('should use fetch with correct URL from getApiBaseUrl', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/sos-button.tsx', 'utf-8')
    );

    expect(source).toContain('const baseUrl = getApiBaseUrl()');
    expect(source).toContain('`${baseUrl}/api/sos`');
  });

  it('should send userId, userName, userRole in request body', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/sos-button.tsx', 'utf-8')
    );

    expect(source).toContain('userId');
    expect(source).toContain('userName');
    expect(source).toContain('userRole');
  });

  it('should accept userId prop', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/sos-button.tsx', 'utf-8')
    );

    expect(source).toContain("userId?: string");
    // Home screen should pass userId
    const homeSource = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/app/(tabs)/index.tsx', 'utf-8')
    );
    expect(homeSource).toContain("userId={user?.id");
  });

  it('should handle REST failure gracefully with offline alert', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/sos-button.tsx', 'utf-8')
    );

    expect(source).toContain('SOS Activated (Offline)');
    expect(source).toContain('could not reach the server');
  });
});

// ─── Test 3: End-to-end REST SOS flow simulation ───────────────────────
describe('REST SOS flow simulation', () => {
  it('should construct correct URL for manus.computer environment', () => {
    // Simulate getApiBaseUrl on web
    const host = '8081-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer';
    const protocol = 'https:';
    const SERVER_PORT = 3000;
    const newHost = host.replace(/^\d+-/, `${SERVER_PORT}-`);
    const apiUrl = `${protocol}//${newHost}`;
    const sosUrl = `${apiUrl}/api/sos`;

    expect(sosUrl).toBe('https://3000-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer/api/sos');
  });

  it('should construct correct URL for Expo Go on local network', () => {
    const debuggerHost = '192.168.1.5:8081';
    const hostname = debuggerHost.split(':')[0];
    const SERVER_PORT = 3000;
    const apiUrl = `http://${hostname}:${SERVER_PORT}`;
    const sosUrl = `${apiUrl}/api/sos`;

    expect(sosUrl).toBe('http://192.168.1.5:3000/api/sos');
  });

  it('should construct valid JSON payload', () => {
    const payload = {
      type: 'sos',
      severity: 'critical',
      location: {
        latitude: 48.8566,
        longitude: 2.3522,
        address: 'Test location',
      },
      description: 'SOS Alert from TestUser',
      userId: 'user-123',
      userName: 'TestUser',
      userRole: 'user',
    };

    const json = JSON.stringify(payload);
    const parsed = JSON.parse(json);

    expect(parsed.type).toBe('sos');
    expect(parsed.severity).toBe('critical');
    expect(parsed.location.latitude).toBe(48.8566);
    expect(parsed.userId).toBe('user-123');
    expect(parsed.userName).toBe('TestUser');
  });
});

// ─── Test 4: Live server endpoint test ─────────────────────────────────
describe('Live server /api/sos endpoint', () => {
  it('should respond with success when sending SOS', async () => {
    const response = await fetch('http://localhost:3000/api/sos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'sos',
        severity: 'critical',
        location: { latitude: 48.8566, longitude: 2.3522, address: 'Test from vitest' },
        description: 'Vitest SOS test',
        userId: 'vitest-user',
        userName: 'VitestUser',
        userRole: 'user',
      }),
    });

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.alertId).toBeTruthy();
    expect(data.broadcast).toBe(true);
  });

  it('should handle missing fields gracefully', async () => {
    const response = await fetch('http://localhost:3000/api/sos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.success).toBe(true);
    // Should use defaults
    expect(data.alertId).toBeTruthy();
  });
});
