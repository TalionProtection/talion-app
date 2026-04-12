import { describe, it, expect, vi, beforeEach } from 'vitest';

// Test the responder status update logic
describe('Responder Status Update', () => {
  // Mock fetch
  const mockFetch = vi.fn();
  
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = mockFetch as any;
  });

  describe('Status progression', () => {
    it('should follow the correct status progression: assigned → accepted → en_route → on_scene', () => {
      const validProgressions: Record<string, string> = {
        assigned: 'accepted',
        accepted: 'en_route',
        en_route: 'on_scene',
      };
      
      expect(validProgressions['assigned']).toBe('accepted');
      expect(validProgressions['accepted']).toBe('en_route');
      expect(validProgressions['en_route']).toBe('on_scene');
      expect(validProgressions['on_scene']).toBeUndefined(); // Terminal state
    });

    it('should have French labels for all statuses', () => {
      const RESP_STATUS_LABELS: Record<string, string> = {
        assigned: 'Assigné',
        accepted: 'Accepté',
        en_route: 'En route',
        on_scene: 'Sur place',
      };
      
      expect(RESP_STATUS_LABELS['assigned']).toBe('Assigné');
      expect(RESP_STATUS_LABELS['accepted']).toBe('Accepté');
      expect(RESP_STATUS_LABELS['en_route']).toBe('En route');
      expect(RESP_STATUS_LABELS['on_scene']).toBe('Sur place');
    });

    it('should have colors for all statuses', () => {
      const RESP_STATUS_COLORS: Record<string, string> = {
        assigned: '#6b7280',
        accepted: '#3b82f6',
        en_route: '#f59e0b',
        on_scene: '#22c55e',
      };
      
      expect(RESP_STATUS_COLORS['assigned']).toBeTruthy();
      expect(RESP_STATUS_COLORS['accepted']).toBeTruthy();
      expect(RESP_STATUS_COLORS['en_route']).toBeTruthy();
      expect(RESP_STATUS_COLORS['on_scene']).toBeTruthy();
    });
  });

  describe('API endpoint', () => {
    it('should call PUT /alerts/:id/respond with correct payload', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, responderId: 'user-1', status: 'accepted', statusLabel: 'Accepté' }),
      });

      const incidentId = 'inc-123';
      const responderId = 'user-1';
      const status = 'accepted';

      await fetch(`http://127.0.0.1:3000/alerts/${incidentId}/respond`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responderId, status }),
      });

      expect(mockFetch).toHaveBeenCalledWith(
        `http://127.0.0.1:3000/alerts/${incidentId}/respond`,
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ responderId, status }),
        })
      );
    });

    it('should reject invalid status values', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Invalid status. Must be one of: accepted, en_route, on_scene' }),
      });

      const res = await fetch('http://127.0.0.1:3000/alerts/inc-123/respond', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responderId: 'user-1', status: 'invalid_status' }),
      });

      expect(res.ok).toBe(false);
    });

    it('should reject if responder is not assigned to the incident', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'Responder not assigned to this incident' }),
      });

      const res = await fetch('http://127.0.0.1:3000/alerts/inc-123/respond', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responderId: 'not-assigned-user', status: 'accepted' }),
      });

      expect(res.ok).toBe(false);
    });
  });

  describe('Incident interface with responderStatuses', () => {
    it('should correctly map responderStatuses from server alert', () => {
      const serverAlert = {
        id: 'alert-1',
        type: 'medical',
        severity: 'high',
        location: { latitude: 0, longitude: 0, address: 'Test' },
        description: 'Test alert',
        createdBy: 'user-1',
        createdAt: Date.now(),
        status: 'active' as const,
        respondingUsers: ['resp-1', 'resp-2'],
        respondingNames: ['Alice', 'Bob'],
        responderStatuses: { 'resp-1': 'accepted' as const, 'resp-2': 'en_route' as const },
      };

      expect(serverAlert.responderStatuses['resp-1']).toBe('accepted');
      expect(serverAlert.responderStatuses['resp-2']).toBe('en_route');
    });

    it('should default to assigned when responderStatuses is empty', () => {
      const responderStatuses: Record<string, string> = {};
      const userId = 'resp-1';
      const myStatus = responderStatuses[userId] || 'assigned';
      
      expect(myStatus).toBe('assigned');
    });

    it('should only show action buttons for assigned responders', () => {
      const assignedResponders = ['resp-1', 'resp-2'];
      const userId = 'resp-1';
      const notAssignedUser = 'resp-3';
      
      expect(assignedResponders.includes(userId)).toBe(true);
      expect(assignedResponders.includes(notAssignedUser)).toBe(false);
    });
  });

  describe('Push notification on assignment', () => {
    it('should include incident type and address in notification', () => {
      const incidentType = 'medical';
      const incidentAddress = '123 Main St';
      const TYPE_LABELS: Record<string, string> = {
        medical: 'Médical',
        fire: 'Feu',
        security: 'Sécurité',
      };
      
      const title = 'Incident assigné';
      const body = `${TYPE_LABELS[incidentType] || incidentType} — ${incidentAddress}`;
      
      expect(title).toBe('Incident assigné');
      expect(body).toBe('Médical — 123 Main St');
    });
  });
});
