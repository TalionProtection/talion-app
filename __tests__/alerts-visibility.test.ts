import { describe, it, expect } from 'vitest';
import * as fs from 'fs';

describe('useAlerts hook', () => {
  const source = fs.readFileSync('/home/ubuntu/safenet-app/hooks/useAlerts.ts', 'utf-8');

  it('should fetch alerts from server via getApiBaseUrl', () => {
    expect(source).toContain("import { getApiBaseUrl } from '@/lib/server-url'");
    expect(source).toContain('getApiBaseUrl()');
    expect(source).toContain('/alerts');
  });

  it('should implement polling with configurable interval', () => {
    expect(source).toContain('pollInterval');
    expect(source).toContain('setInterval');
    expect(source).toContain('clearInterval');
  });

  it('should export ServerAlert type', () => {
    expect(source).toContain('export interface ServerAlert');
    expect(source).toContain('id: string');
    expect(source).toContain('type: string');
    expect(source).toContain('severity: string');
    expect(source).toContain('location:');
    expect(source).toContain('createdAt: number');
    expect(source).toContain('status:');
  });

  it('should return alerts, isLoading, error, refresh', () => {
    expect(source).toContain('alerts,');
    expect(source).toContain('isLoading,');
    expect(source).toContain('error,');
    expect(source).toContain('refresh,');
  });

  it('should handle fetch errors gracefully', () => {
    expect(source).toContain('catch');
    expect(source).toContain('setError');
  });

  it('should clean up interval on unmount', () => {
    expect(source).toContain('isMountedRef.current = false');
    expect(source).toContain('clearInterval');
  });
});

describe('Home screen uses useAlerts instead of mock data', () => {
  const source = fs.readFileSync('/home/ubuntu/safenet-app/app/(tabs)/index.tsx', 'utf-8');

  it('should import useAlerts hook', () => {
    expect(source).toContain("import { useAlerts");
    expect(source).toContain("from '@/hooks/useAlerts'");
  });

  it('should NOT have hardcoded mock incidents', () => {
    // The old code had baseIncidents with hardcoded data like "inc-001"
    expect(source).not.toContain("id: 'inc-001'");
    expect(source).not.toContain("id: 'inc-002'");
    expect(source).not.toContain("id: 'inc-003'");
    expect(source).not.toContain("id: 'inc-004'");
    expect(source).not.toContain('baseIncidents');
  });

  it('should NOT import websocketService', () => {
    expect(source).not.toContain("from '@/services/websocket'");
    expect(source).not.toContain('websocketService.on');
    expect(source).not.toContain('websocketService.off');
  });

  it('should convert server alerts to incidents', () => {
    expect(source).toContain('serverAlertToIncident');
    expect(source).toContain('serverAlerts.map');
  });

  it('should show error banner when server is unreachable', () => {
    expect(source).toContain('alertsError');
    expect(source).toContain('errorBanner');
    expect(source).toContain('Unable to reach server');
  });

  it('should refresh alerts after SOS activation', () => {
    expect(source).toContain('refreshAlerts');
  });
});

describe('Dispatcher screen uses useAlerts instead of mock data', () => {
  const source = fs.readFileSync('/home/ubuntu/safenet-app/app/dispatcher.tsx', 'utf-8');

  it('should import useAlerts hook', () => {
    expect(source).toContain("import { useAlerts");
    expect(source).toContain("from '@/hooks/useAlerts'");
  });

  it('should NOT have hardcoded mock SOS alerts', () => {
    expect(source).not.toContain("responderName: 'Jean Martin'");
    expect(source).not.toContain("responderPhone: '+33 6 12 34 56 78'");
  });

  it('should convert server alerts to display format', () => {
    expect(source).toContain('serverAlertToDisplay');
  });

  it('should have a refresh button', () => {
    expect(source).toContain('refreshButton');
    expect(source).toContain('refresh');
  });

  it('should show error banner when server is unreachable', () => {
    expect(source).toContain('errorBanner');
    expect(source).toContain('Impossible de contacter le serveur');
  });

  it('should show loading state', () => {
    expect(source).toContain('isLoading');
    expect(source).toContain('ActivityIndicator');
    expect(source).toContain('Chargement des alertes');
  });

  it('should poll more frequently (5s) for dispatcher', () => {
    expect(source).toContain('pollInterval: 5000');
  });
});
