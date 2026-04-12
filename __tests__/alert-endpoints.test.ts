import { describe, it, expect, beforeAll } from 'vitest';

const API_BASE = 'http://localhost:3000';

describe('Alert Detail & Action Endpoints', () => {
  let alertIds: string[] = [];

  beforeAll(async () => {
    // Get existing alerts
    const res = await fetch(`${API_BASE}/alerts`);
    const alerts = await res.json();
    alertIds = alerts.map((a: any) => a.id);
  });

  describe('GET /alerts/:id', () => {
    it('should return full alert details with location', async () => {
      if (alertIds.length === 0) return;
      const res = await fetch(`${API_BASE}/alerts/${alertIds[0]}`);
      expect(res.ok).toBe(true);
      const data = await res.json();
      expect(data.id).toBe(alertIds[0]);
      expect(data).toHaveProperty('type');
      expect(data).toHaveProperty('severity');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('location');
      expect(data).toHaveProperty('respondingDetails');
      expect(data.location).toHaveProperty('latitude');
      expect(data.location).toHaveProperty('longitude');
    });

    it('should return 404 for non-existent alert', async () => {
      const res = await fetch(`${API_BASE}/alerts/NON-EXISTENT-ID`);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Alert not found');
    });

    it('should include respondingDetails array', async () => {
      if (alertIds.length === 0) return;
      const res = await fetch(`${API_BASE}/alerts/${alertIds[0]}`);
      const data = await res.json();
      expect(Array.isArray(data.respondingDetails)).toBe(true);
    });
  });

  describe('PUT /alerts/:id/acknowledge', () => {
    it('should acknowledge an active alert', async () => {
      // Create a fresh alert to acknowledge
      const createRes = await fetch(`${API_BASE}/api/sos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'test-ack-user',
          userName: 'Test ACK',
          type: 'sos',
          severity: 'critical',
          location: { latitude: 48.85, longitude: 2.35, address: 'Test ACK Location' },
        }),
      });
      const created = await createRes.json();
      const alertId = created.alertId;

      const ackRes = await fetch(`${API_BASE}/alerts/${alertId}/acknowledge`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'dispatcher-1' }),
      });
      expect(ackRes.ok).toBe(true);
      const ackData = await ackRes.json();
      expect(ackData.success).toBe(true);

      // Verify status changed
      const detailRes = await fetch(`${API_BASE}/alerts/${alertId}`);
      const detail = await detailRes.json();
      expect(detail.status).toBe('acknowledged');
    });

    it('should return 404 for non-existent alert', async () => {
      const res = await fetch(`${API_BASE}/alerts/FAKE-ID/acknowledge`, { method: 'PUT' });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /alerts/:id/resolve', () => {
    it('should resolve an alert', async () => {
      // Create a fresh alert to resolve
      const createRes = await fetch(`${API_BASE}/api/sos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'test-resolve-user',
          userName: 'Test Resolve',
          type: 'sos',
          severity: 'high',
          location: { latitude: 48.86, longitude: 2.36, address: 'Test Resolve Location' },
        }),
      });
      const created = await createRes.json();
      const alertId = created.alertId;

      const resolveRes = await fetch(`${API_BASE}/alerts/${alertId}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'dispatcher-1' }),
      });
      expect(resolveRes.ok).toBe(true);
      const resolveData = await resolveRes.json();
      expect(resolveData.success).toBe(true);

      // Verify status changed
      const detailRes = await fetch(`${API_BASE}/alerts/${alertId}`);
      const detail = await detailRes.json();
      expect(detail.status).toBe('resolved');
    });

    it('should return 404 for non-existent alert', async () => {
      const res = await fetch(`${API_BASE}/alerts/FAKE-ID/resolve`, { method: 'PUT' });
      expect(res.status).toBe(404);
    });
  });
});
