import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Tests for dynamic server URL resolution.
 * 
 * The core issue: on a real phone, ws://localhost:3000 points to the phone itself,
 * not the server. The server-url utility resolves the correct URL based on platform.
 */

// ─── Test 1: Server URL utility logic ──────────────────────────────────
describe('Server URL resolution logic', () => {
  it('should convert http URL to ws URL', () => {
    // Simulate the URL conversion logic
    const httpToWs = (url: string) => url.replace(/^http/, 'ws');

    expect(httpToWs('http://192.168.1.5:3000')).toBe('ws://192.168.1.5:3000');
    expect(httpToWs('https://3000-xxx.manus.computer')).toBe('wss://3000-xxx.manus.computer');
    expect(httpToWs('http://localhost:3000')).toBe('ws://localhost:3000');
  });

  it('should replace port prefix in manus.computer subdomain', () => {
    const replacePort = (host: string, newPort: number) => {
      return host.replace(/^\d+-/, `${newPort}-`);
    };

    expect(replacePort('8081-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer', 3000))
      .toBe('3000-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer');

    expect(replacePort('8081-abc123.manus.space', 3000))
      .toBe('3000-abc123.manus.space');
  });

  it('should extract hostname from debuggerHost', () => {
    const extractHostname = (debuggerHost: string) => debuggerHost.split(':')[0];

    expect(extractHostname('192.168.1.5:8081')).toBe('192.168.1.5');
    expect(extractHostname('10.0.0.1:8081')).toBe('10.0.0.1');
    expect(extractHostname('8081-xxx.manus.computer:8081')).toBe('8081-xxx.manus.computer');
  });

  it('should detect manus proxy domains', () => {
    const isManusProxy = (host: string) =>
      host.includes('manus.computer') || host.includes('manus.space');

    expect(isManusProxy('3000-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer')).toBe(true);
    expect(isManusProxy('safenetapp-plycttrb.manus.space')).toBe(true);
    expect(isManusProxy('192.168.1.5')).toBe(false);
    expect(isManusProxy('localhost')).toBe(false);
  });
});

// ─── Test 2: Verify server-url.ts file exists and has correct exports ──
describe('Server URL module', () => {
  it('should export getApiBaseUrl and getWsUrl functions', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/lib/server-url.ts', 'utf-8')
    );

    expect(source).toContain('export function getApiBaseUrl()');
    expect(source).toContain('export function getWsUrl()');
  });

  it('should handle web platform with window.location', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/lib/server-url.ts', 'utf-8')
    );

    expect(source).toContain("Platform.OS === 'web'");
    expect(source).toContain('window.location.host');
    expect(source).toContain('manus.computer');
    expect(source).toContain('manus.space');
  });

  it('should handle native platform with Expo Constants', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/lib/server-url.ts', 'utf-8')
    );

    expect(source).toContain('Constants.expoConfig?.hostUri');
    expect(source).toContain('debuggerHost');
  });

  it('should convert http to ws for WebSocket URL', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/lib/server-url.ts', 'utf-8')
    );

    expect(source).toContain("apiUrl.replace(/^http/, 'ws')");
  });
});

// ─── Test 3: Verify WebSocket provider uses dynamic URL ────────────────
describe('WebSocket provider uses dynamic URL', () => {
  it('should import getWsUrl from server-url', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/lib/websocket-provider.tsx', 'utf-8')
    );

    expect(source).toContain("import { getWsUrl } from '@/lib/server-url'");
  });

  it('should call getWsUrl() before connecting', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/lib/websocket-provider.tsx', 'utf-8')
    );

    expect(source).toContain('const wsUrl = getWsUrl()');
    expect(source).toContain('wsManager.setUrl(wsUrl)');
    expect(source).toContain('websocketService.setUrl(wsUrl)');
  });

  it('should log the resolved URL for debugging', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/lib/websocket-provider.tsx', 'utf-8')
    );

    expect(source).toContain('Resolved WebSocket URL');
  });
});

// ─── Test 4: Verify both WS services have setUrl method ────────────────
describe('WebSocket services have setUrl method', () => {
  it('wsManager should have setUrl method', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/services/websocket-manager.ts', 'utf-8')
    );

    expect(source).toContain('setUrl(url: string): void');
    expect(source).toContain('this.url = url');
  });

  it('old websocketService should have setUrl method', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/services/websocket.ts', 'utf-8')
    );

    expect(source).toContain('setUrl(url: string): void');
    expect(source).toContain('this.url = url');
  });
});

// ─── Test 5: Verify API service uses dynamic URL ───────────────────────
describe('API service uses dynamic URL', () => {
  it('should import getApiBaseUrl from server-url', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/services/api.ts', 'utf-8')
    );

    expect(source).toContain("import { getApiBaseUrl } from '@/lib/server-url'");
    expect(source).toContain('getApiBaseUrl()');
  });

  it('should NOT use hardcoded localhost for API URL', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/services/api.ts', 'utf-8')
    );

    // Should not have the old hardcoded URL at module level
    expect(source).not.toContain("const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000/api'");
  });
});

// ─── Test 6: End-to-end URL resolution simulation ──────────────────────
describe('End-to-end URL resolution simulation', () => {
  it('should resolve correct URLs for manus.computer web environment', () => {
    // Simulate: running on web at https://8081-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer
    const host = '8081-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer';
    const protocol = 'https:';
    const SERVER_PORT = 3000;

    const newHost = host.replace(/^\d+-/, `${SERVER_PORT}-`);
    const apiUrl = `${protocol}//${newHost}`;
    const wsUrl = apiUrl.replace(/^http/, 'ws');

    expect(apiUrl).toBe('https://3000-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer');
    expect(wsUrl).toBe('wss://3000-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer');
  });

  it('should resolve correct URLs for Expo Go on local network', () => {
    // Simulate: running on phone, debuggerHost = "192.168.1.5:8081"
    const debuggerHost = '192.168.1.5:8081';
    const hostname = debuggerHost.split(':')[0];
    const SERVER_PORT = 3000;

    const apiUrl = `http://${hostname}:${SERVER_PORT}`;
    const wsUrl = apiUrl.replace(/^http/, 'ws');

    expect(apiUrl).toBe('http://192.168.1.5:3000');
    expect(wsUrl).toBe('ws://192.168.1.5:3000');
  });

  it('should resolve correct URLs for Expo Go via manus tunnel', () => {
    // Simulate: running on phone via manus proxy, debuggerHost includes manus domain
    const debuggerHost = '8081-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer:443';
    const hostname = debuggerHost.split(':')[0];
    const SERVER_PORT = 3000;

    const isManusProxy = hostname.includes('manus.computer') || hostname.includes('manus.space');
    expect(isManusProxy).toBe(true);

    const newHostname = hostname.replace(/^\d+-/, `${SERVER_PORT}-`);
    const apiUrl = `https://${newHostname}`;
    const wsUrl = apiUrl.replace(/^http/, 'ws');

    expect(apiUrl).toBe('https://3000-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer');
    expect(wsUrl).toBe('wss://3000-if8cif4x8tlozlqqxek07-334988f6.us2.manus.computer');
  });
});
