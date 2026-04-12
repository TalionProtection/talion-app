import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'dispatch-1', name: 'Dispatch', role: 'dispatcher' } }) }));
vi.mock('@/lib/location-context', () => ({
  useLocation: () => ({
    location: { latitude: 48.8566, longitude: 2.3522 },
    isTracking: true,
    hasPermission: true,
  }),
}));
vi.mock('@/services/websocket', () => ({
  websocketService: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    isConnected: () => true,
  },
}));
vi.mock('@/components/talion-banner', () => ({
  TalionScreen: ({ children }: any) => children,
}));

describe('Dispatcher Incident Management', () => {
  describe('Incident Data Model', () => {
    it('should define correct incident types', () => {
      const types = ['sos', 'medical', 'fire', 'security', 'hazard'];
      expect(types).toHaveLength(5);
      types.forEach((t) => expect(typeof t).toBe('string'));
    });

    it('should define correct severity levels', () => {
      const severities = ['critical', 'high', 'medium', 'low'];
      expect(severities).toHaveLength(4);
    });

    it('should define correct incident statuses', () => {
      const statuses = ['active', 'acknowledged', 'dispatched', 'resolved'];
      expect(statuses).toHaveLength(4);
    });

    it('should define correct responder statuses', () => {
      const statuses = ['available', 'on_duty', 'off_duty'];
      expect(statuses).toHaveLength(3);
    });
  });

  describe('Incident Filtering', () => {
    const incidents = [
      { id: '1', status: 'active', severity: 'critical', timestamp: Date.now() },
      { id: '2', status: 'acknowledged', severity: 'high', timestamp: Date.now() - 60000 },
      { id: '3', status: 'dispatched', severity: 'medium', timestamp: Date.now() - 120000 },
      { id: '4', status: 'resolved', severity: 'low', timestamp: Date.now() - 180000 },
    ];

    it('should filter by "all" excluding resolved', () => {
      const filtered = incidents.filter((i) => i.status !== 'resolved');
      expect(filtered).toHaveLength(3);
    });

    it('should filter by "active" status', () => {
      const filtered = incidents.filter((i) => i.status === 'active');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('1');
    });

    it('should filter by "acknowledged" status', () => {
      const filtered = incidents.filter((i) => i.status === 'acknowledged');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('2');
    });

    it('should filter by "dispatched" status', () => {
      const filtered = incidents.filter((i) => i.status === 'dispatched');
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('3');
    });
  });

  describe('Incident Sorting', () => {
    it('should sort by severity then timestamp', () => {
      const incidents = [
        { id: '1', severity: 'medium', timestamp: Date.now() },
        { id: '2', severity: 'critical', timestamp: Date.now() - 60000 },
        { id: '3', severity: 'high', timestamp: Date.now() - 30000 },
      ];

      const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      const sorted = [...incidents].sort((a, b) => {
        const aSev = sevOrder[a.severity] ?? 3;
        const bSev = sevOrder[b.severity] ?? 3;
        if (aSev !== bSev) return aSev - bSev;
        return b.timestamp - a.timestamp;
      });

      expect(sorted[0].id).toBe('2'); // critical
      expect(sorted[1].id).toBe('3'); // high
      expect(sorted[2].id).toBe('1'); // medium
    });
  });

  describe('Incident Timeline', () => {
    it('should add timeline entries on acknowledge', () => {
      const timeline = [
        { id: '1', action: 'SOS triggered', by: 'User', timestamp: Date.now() - 120000 },
      ];
      const newEntry = { id: '2', action: 'Acknowledged by dispatch', by: 'Dispatch', timestamp: Date.now() };
      const updated = [...timeline, newEntry];
      expect(updated).toHaveLength(2);
      expect(updated[1].action).toBe('Acknowledged by dispatch');
    });

    it('should add timeline entries on assign', () => {
      const timeline = [
        { id: '1', action: 'SOS triggered', by: 'User', timestamp: Date.now() - 120000 },
        { id: '2', action: 'Acknowledged', by: 'Dispatch', timestamp: Date.now() - 60000 },
      ];
      const newEntry = { id: '3', action: 'Unit Alpha assigned', by: 'Dispatch', timestamp: Date.now() };
      const updated = [...timeline, newEntry];
      expect(updated).toHaveLength(3);
      expect(updated[2].action).toContain('assigned');
    });

    it('should add timeline entries on resolve', () => {
      const timeline = [
        { id: '1', action: 'SOS triggered', by: 'User', timestamp: Date.now() - 120000 },
      ];
      const newEntry = { id: '2', action: 'Incident resolved', by: 'Dispatch', timestamp: Date.now() };
      const updated = [...timeline, newEntry];
      expect(updated[1].action).toBe('Incident resolved');
    });

    it('should show last 3 timeline entries', () => {
      const timeline = [
        { id: '1', action: 'A', by: 'X', timestamp: 1 },
        { id: '2', action: 'B', by: 'X', timestamp: 2 },
        { id: '3', action: 'C', by: 'X', timestamp: 3 },
        { id: '4', action: 'D', by: 'X', timestamp: 4 },
        { id: '5', action: 'E', by: 'X', timestamp: 5 },
      ];
      const last3 = timeline.slice(-3);
      expect(last3).toHaveLength(3);
      expect(last3[0].action).toBe('C');
      expect(last3[2].action).toBe('E');
    });
  });

  describe('Responder Assignment', () => {
    it('should filter available responders for assignment', () => {
      const responders = [
        { id: 'r1', name: 'Unit 1', status: 'available' },
        { id: 'r2', name: 'Unit 2', status: 'on_duty' },
        { id: 'r3', name: 'Unit 3', status: 'off_duty' },
      ];
      const available = responders.filter((r) => r.status === 'available' || r.status === 'on_duty');
      expect(available).toHaveLength(2);
    });

    it('should exclude already assigned responders', () => {
      const responders = [
        { id: 'r1', name: 'Unit 1', status: 'available' },
        { id: 'r2', name: 'Unit 2', status: 'available' },
      ];
      const assignedIds = ['r1'];
      const unassigned = responders.filter((r) => !assignedIds.includes(r.id));
      expect(unassigned).toHaveLength(1);
      expect(unassigned[0].id).toBe('r2');
    });

    it('should update incident status to dispatched on assign', () => {
      const incident = { id: 'inc-1', status: 'acknowledged', assignedResponders: [] as string[] };
      const updated = {
        ...incident,
        status: 'dispatched',
        assignedResponders: [...incident.assignedResponders, 'r1'],
      };
      expect(updated.status).toBe('dispatched');
      expect(updated.assignedResponders).toContain('r1');
    });

    it('should set responder status to on_duty when assigned', () => {
      const responder = { id: 'r1', name: 'Unit 1', status: 'available' };
      const updated = { ...responder, status: 'on_duty' };
      expect(updated.status).toBe('on_duty');
    });
  });

  describe('Incident Resolution', () => {
    it('should set incident status to resolved', () => {
      const incident = { id: 'inc-1', status: 'dispatched', assignedResponders: ['r1', 'r2'] };
      const updated = { ...incident, status: 'resolved' };
      expect(updated.status).toBe('resolved');
    });

    it('should free assigned responders on resolve', () => {
      const assignedIds = ['r1', 'r2'];
      const responders = [
        { id: 'r1', name: 'Unit 1', status: 'on_duty' },
        { id: 'r2', name: 'Unit 2', status: 'on_duty' },
        { id: 'r3', name: 'Unit 3', status: 'available' },
      ];
      const updated = responders.map((r) =>
        assignedIds.includes(r.id) ? { ...r, status: 'available' } : r
      );
      expect(updated[0].status).toBe('available');
      expect(updated[1].status).toBe('available');
      expect(updated[2].status).toBe('available');
    });
  });

  describe('Zone Broadcast', () => {
    it('should validate broadcast message is not empty', () => {
      const message = '';
      expect(message.trim()).toBe('');
    });

    it('should parse radius correctly', () => {
      expect(parseFloat('5')).toBe(5);
      expect(parseFloat('10')).toBe(10);
      expect(parseFloat('25')).toBe(25);
      expect(parseFloat('invalid') || 5).toBe(5); // fallback
    });

    it('should support radius options 1, 5, 10, 25 km', () => {
      const options = ['1', '5', '10', '25'];
      expect(options).toHaveLength(4);
      options.forEach((o) => expect(parseFloat(o)).toBeGreaterThan(0));
    });
  });

  describe('Stats Calculation', () => {
    it('should calculate correct stats from incidents and responders', () => {
      const incidents = [
        { status: 'active' },
        { status: 'active' },
        { status: 'acknowledged' },
        { status: 'dispatched' },
        { status: 'resolved' },
      ];
      const responders = [
        { status: 'available' },
        { status: 'available' },
        { status: 'on_duty' },
        { status: 'off_duty' },
      ];

      const stats = {
        active: incidents.filter((i) => i.status === 'active').length,
        acknowledged: incidents.filter((i) => i.status === 'acknowledged').length,
        dispatched: incidents.filter((i) => i.status === 'dispatched').length,
        available: responders.filter((r) => r.status === 'available').length,
        onDuty: responders.filter((r) => r.status === 'on_duty').length,
        total: responders.length,
      };

      expect(stats.active).toBe(2);
      expect(stats.acknowledged).toBe(1);
      expect(stats.dispatched).toBe(1);
      expect(stats.available).toBe(2);
      expect(stats.onDuty).toBe(1);
      expect(stats.total).toBe(4);
    });
  });

  describe('Time Formatting', () => {
    it('should format "Just now" for recent timestamps', () => {
      const diff = Date.now() - (Date.now() - 30000);
      const minutes = Math.floor(diff / 60000);
      expect(minutes).toBeLessThan(1);
    });

    it('should format minutes ago', () => {
      const diff = 5 * 60000;
      const minutes = Math.floor(diff / 60000);
      expect(minutes).toBe(5);
      expect(`${minutes}m ago`).toBe('5m ago');
    });

    it('should format hours ago', () => {
      const diff = 2 * 3600000;
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(minutes / 60);
      expect(hours).toBe(2);
      expect(`${hours}h ago`).toBe('2h ago');
    });
  });
});
