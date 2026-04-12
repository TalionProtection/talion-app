import { describe, it, expect } from 'vitest';

/**
 * Tests for AlertCreationModal migration from WebSocket to REST API.
 */

describe('AlertCreationModal uses REST API', () => {
  it('should import getApiBaseUrl instead of useWebSocket', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    expect(source).toContain("import { getApiBaseUrl } from '@/lib/server-url'");
    expect(source).not.toContain("import { useWebSocket }");
    expect(source).not.toContain("from '@/hooks/useWebSocket'");
  });

  it('should not import from websocket service', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    expect(source).not.toContain("from '@/services/websocket'");
    expect(source).not.toContain("from '@/services/websocket-manager'");
  });

  it('should define AlertType locally instead of importing from websocket', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    expect(source).toContain("type AlertType = 'sos' | 'medical' | 'fire' | 'accident' | 'other'");
  });

  it('should use fetch to POST to /api/sos endpoint', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    expect(source).toContain('const baseUrl = getApiBaseUrl()');
    expect(source).toContain('`${baseUrl}/api/sos`');
    expect(source).toContain("method: 'POST'");
    expect(source).toContain("'Content-Type': 'application/json'");
  });

  it('should send alertType, priority, location, description, userId, userName in body', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    expect(source).toContain('type: alertType');
    expect(source).toContain('severity: priority');
    expect(source).toContain('latitude: location.latitude');
    expect(source).toContain('longitude: location.longitude');
    expect(source).toContain('userId:');
    expect(source).toContain('userName:');
  });

  it('should accept userId and userName props', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    expect(source).toContain("userId?: string");
    expect(source).toContain("userName?: string");
  });

  it('should check server health on modal open', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    expect(source).toContain('checkServerHealth');
    expect(source).toContain('/health');
    expect(source).toContain('serverReachable');
  });

  it('should not block submit when server is unreachable (no isConnected gate)', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    // The old code had: disabled={isLoading || !isConnected}
    // The new code should only disable on isLoading
    expect(source).toContain('disabled={isLoading}');
    expect(source).not.toContain('disabled={isLoading || !isConnected}');
  });

  it('should handle server error gracefully', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/components/alert-creation-modal.tsx', 'utf-8')
    );

    expect(source).toContain('Server rejected the alert');
    expect(source).toContain('Failed to reach the server');
  });
});

describe('AlertCreationModal is passed userId/userName from home screen', () => {
  it('should pass userId and userName props to AlertCreationModal', async () => {
    const source = await import('fs').then(fs =>
      fs.readFileSync('/home/ubuntu/safenet-app/app/(tabs)/index.tsx', 'utf-8')
    );

    expect(source).toContain("userId={user?.id || ''}");
    expect(source).toContain("userName={user?.name || 'Unknown'}");
  });
});
