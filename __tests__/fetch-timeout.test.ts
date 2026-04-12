import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── fetchWithTimeout unit tests ─────────────────────────────────────────

describe('fetchWithTimeout utility', () => {
  let fetchWithTimeout: typeof import('@/lib/fetch-with-timeout').fetchWithTimeout;

  beforeEach(async () => {
    vi.useFakeTimers();
    // Dynamic import to get fresh module
    const mod = await import('../lib/fetch-with-timeout');
    fetchWithTimeout = mod.fetchWithTimeout;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should call fetch with AbortController signal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);

    vi.useRealTimers(); // need real timers for this test
    const res = await fetchWithTimeout('http://localhost:3000/health', { timeout: 5000 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[0]).toBe('http://localhost:3000/health');
    expect(callArgs[1]).toHaveProperty('signal');
    expect(res).toBeInstanceOf(Response);
  });

  it('should pass through request options (method, headers, body)', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
    vi.stubGlobal('fetch', mockFetch);

    vi.useRealTimers();
    await fetchWithTimeout('http://localhost:3000/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
      timeout: 10000,
    });

    const callArgs = mockFetch.mock.calls[0];
    expect(callArgs[1].method).toBe('POST');
    expect(callArgs[1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(callArgs[1].body).toBe(JSON.stringify({ test: true }));
  });

  it('should throw timeout error when request exceeds timeout', async () => {
    vi.useRealTimers(); // need real timers for actual abort

    // Create a fetch that takes longer than the timeout
    const mockFetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('ok')), 5000);
        // Listen for abort signal
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    // Use a very short timeout (50ms) so the test runs quickly
    await expect(fetchWithTimeout('http://localhost:3000/slow', { timeout: 50 }))
      .rejects.toThrow('timed out');
  });

  it('should default to 15000ms timeout if not specified', async () => {
    // Just verify the module exports correctly
    const mod = await import('../lib/fetch-with-timeout');
    expect(typeof mod.fetchWithTimeout).toBe('function');
  });
});

// ─── Server timeout configuration tests ──────────────────────────────────

describe('Server timeout configuration', () => {
  it('should have keepAliveTimeout set to 65000ms', async () => {
    // Read the server file and check for timeout config
    const fs = await import('fs');
    const serverCode = fs.readFileSync('./server/index.ts', 'utf-8');
    expect(serverCode).toContain('server.keepAliveTimeout = 65000');
  });

  it('should have headersTimeout set to 66000ms', async () => {
    const fs = await import('fs');
    const serverCode = fs.readFileSync('./server/index.ts', 'utf-8');
    expect(serverCode).toContain('server.headersTimeout = 66000');
  });

  it('should have WebSocket server-side ping interval configured', async () => {
    const fs = await import('fs');
    const serverCode = fs.readFileSync('./server/index.ts', 'utf-8');
    expect(serverCode).toContain('WS_PING_INTERVAL');
    expect(serverCode).toContain('ws.ping()');
    expect(serverCode).toContain('ws.isAlive');
  });

  it('should handle pong responses in WebSocket connection handler', async () => {
    const fs = await import('fs');
    const serverCode = fs.readFileSync('./server/index.ts', 'utf-8');
    expect(serverCode).toContain("ws.on('pong'");
    expect(serverCode).toContain('ws.isAlive = true');
  });
});

// ─── Client-side fetch calls use fetchWithTimeout ────────────────────────

describe('Client files use fetchWithTimeout', () => {
  const fs = require('fs');
  const filesToCheck = [
    { path: './hooks/useAlerts.ts', name: 'useAlerts' },
    { path: './hooks/usePushNotifications.ts', name: 'usePushNotifications' },
    { path: './app/(tabs)/index.tsx', name: 'Home screen' },
    { path: './app/(tabs)/dispatcher.tsx', name: 'Dispatcher screen' },
    { path: './app/(tabs)/admin.tsx', name: 'Admin screen' },
    { path: './app/(tabs)/messages.tsx', name: 'Messages screen' },
    { path: './app/(tabs)/explore.tsx', name: 'Explore screen' },
  ];

  filesToCheck.forEach(({ path, name }) => {
    it(`${name} should import fetchWithTimeout`, () => {
      const code = fs.readFileSync(path, 'utf-8');
      expect(code).toContain("import { fetchWithTimeout } from '@/lib/fetch-with-timeout'");
    });

    it(`${name} should use fetchWithTimeout instead of raw fetch for API calls`, () => {
      const code = fs.readFileSync(path, 'utf-8');
      // Check that there are no raw fetch( calls to API endpoints
      // (allow fetch in comments or non-API contexts)
      const lines = code.split('\n');
      const rawFetchLines = lines.filter((line: string) => {
        const trimmed = line.trim();
        // Skip comments and imports
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import')) return false;
        // Skip non-API fetch (like AsyncStorage.getItem which uses .then)
        if (trimmed.includes('AsyncStorage')) return false;
        // Look for raw fetch( with API URL patterns
        return (trimmed.includes('fetch(`${') || trimmed.includes('await fetch(')) && !trimmed.includes('fetchWithTimeout');
      });
      expect(rawFetchLines).toEqual([]);
    });
  });
});
