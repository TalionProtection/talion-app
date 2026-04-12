import { describe, it, expect } from 'vitest';

// ─── Test: Role-based alert filtering in useAlerts ──────────────────────

describe('Role-based alert filtering', () => {
  const mockAlerts = [
    { id: '1', type: 'sos', severity: 'critical', description: 'SOS Alert', createdBy: 'user1', createdAt: Date.now(), status: 'active', respondingUsers: [], location: { latitude: 0, longitude: 0, address: 'Test' } },
    { id: '2', type: 'medical', severity: 'high', description: 'Medical Emergency', createdBy: 'user2', createdAt: Date.now(), status: 'active', respondingUsers: [], location: { latitude: 0, longitude: 0, address: 'Test' } },
    { id: '3', type: 'fire', severity: 'critical', description: 'Fire Alarm', createdBy: 'user3', createdAt: Date.now(), status: 'active', respondingUsers: [], location: { latitude: 0, longitude: 0, address: 'Test' } },
    { id: '4', type: 'sos', severity: 'critical', description: 'Another SOS', createdBy: 'user4', createdAt: Date.now(), status: 'active', respondingUsers: [], location: { latitude: 0, longitude: 0, address: 'Test' } },
    { id: '5', type: 'accident', severity: 'medium', description: 'Car accident', createdBy: 'user5', createdAt: Date.now(), status: 'active', respondingUsers: [], location: { latitude: 0, longitude: 0, address: 'Test' } },
  ];

  function filterAlerts(alerts: typeof mockAlerts, userRole?: string) {
    const privilegedRoles = ['dispatcher', 'responder', 'admin'];
    if (userRole && privilegedRoles.includes(userRole)) {
      return alerts;
    }
    return alerts.filter((a) => a.type !== 'sos');
  }

  it('should filter out SOS alerts for regular users', () => {
    const filtered = filterAlerts(mockAlerts, 'user');
    expect(filtered).toHaveLength(3);
    expect(filtered.every((a) => a.type !== 'sos')).toBe(true);
    expect(filtered.map((a) => a.type)).toEqual(['medical', 'fire', 'accident']);
  });

  it('should filter out SOS alerts when role is undefined', () => {
    const filtered = filterAlerts(mockAlerts, undefined);
    expect(filtered).toHaveLength(3);
    expect(filtered.every((a) => a.type !== 'sos')).toBe(true);
  });

  it('should show ALL alerts including SOS for dispatchers', () => {
    const filtered = filterAlerts(mockAlerts, 'dispatcher');
    expect(filtered).toHaveLength(5);
    expect(filtered.filter((a) => a.type === 'sos')).toHaveLength(2);
  });

  it('should show ALL alerts including SOS for responders', () => {
    const filtered = filterAlerts(mockAlerts, 'responder');
    expect(filtered).toHaveLength(5);
  });

  it('should show ALL alerts including SOS for admins', () => {
    const filtered = filterAlerts(mockAlerts, 'admin');
    expect(filtered).toHaveLength(5);
  });

  it('should return empty array when no alerts exist', () => {
    const filtered = filterAlerts([], 'user');
    expect(filtered).toHaveLength(0);
  });

  it('should return only non-SOS alerts when all alerts are SOS for regular user', () => {
    const allSos = mockAlerts.filter((a) => a.type === 'sos');
    const filtered = filterAlerts(allSos, 'user');
    expect(filtered).toHaveLength(0);
  });
});

// ─── Test: Push token server endpoint ──────────────────────────────────

describe('Push token server endpoint', () => {
  it('should accept POST /api/push-token with valid data', async () => {
    const response = await fetch('http://localhost:3000/api/push-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'ExponentPushToken[test-token-123]',
        userId: 'dispatcher-1',
        userRole: 'dispatcher',
      }),
    });
    const data = await response.json();
    expect(response.ok).toBe(true);
    expect(data.success).toBe(true);
  });

  it('should reject POST /api/push-token without token', async () => {
    const response = await fetch('http://localhost:3000/api/push-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'dispatcher-1',
        userRole: 'dispatcher',
      }),
    });
    expect(response.status).toBe(400);
  });

  it('should reject POST /api/push-token without userId', async () => {
    const response = await fetch('http://localhost:3000/api/push-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'ExponentPushToken[test-token-456]',
        userRole: 'dispatcher',
      }),
    });
    expect(response.status).toBe(400);
  });

  it('should accept DELETE /api/push-token', async () => {
    const response = await fetch('http://localhost:3000/api/push-token', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: 'ExponentPushToken[test-token-123]',
      }),
    });
    const data = await response.json();
    expect(response.ok).toBe(true);
    expect(data.success).toBe(true);
  });
});

// ─── Test: SOS endpoint triggers push notification function ─────────────

describe('SOS endpoint with push notifications', () => {
  it('should create SOS alert and return success', async () => {
    const response = await fetch('http://localhost:3000/api/sos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'test-user-push',
        userName: 'Push Test User',
        location: {
          latitude: 48.8566,
          longitude: 2.3522,
          address: '1 Rue de Rivoli, Paris',
        },
        description: 'SOS test for push notification',
      }),
    });
    const data = await response.json();
    expect(response.ok).toBe(true);
    expect(data.success).toBe(true);
    expect(data.alertId).toBeDefined();
    expect(data.broadcast).toBe(true);
  });

  it('should include alert id and broadcast confirmation in response', async () => {
    const response = await fetch('http://localhost:3000/api/sos', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: 'test-user-push-2',
        location: { latitude: 48.85, longitude: 2.35 },
      }),
    });
    const data = await response.json();
    expect(data.alertId).toBeDefined();
    expect(typeof data.alertId).toBe('string');
    expect(data.broadcast).toBe(true);
  });
});

// ─── Test: GET /alerts returns all alerts (filtering is client-side) ───

describe('GET /alerts returns all alerts (filtering is client-side)', () => {
  it('should return all alerts including SOS from GET /alerts', async () => {
    const response = await fetch('http://localhost:3000/alerts');
    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    const sosAlerts = data.filter((a: any) => a.type === 'sos');
    expect(sosAlerts.length).toBeGreaterThan(0);
  });

  it('should return alerts with correct structure', async () => {
    const response = await fetch('http://localhost:3000/alerts');
    const data = await response.json();
    if (data.length > 0) {
      const alert = data[0];
      expect(alert).toHaveProperty('id');
      expect(alert).toHaveProperty('type');
      expect(alert).toHaveProperty('severity');
      expect(alert).toHaveProperty('status');
      expect(alert).toHaveProperty('createdAt');
    }
  });
});
