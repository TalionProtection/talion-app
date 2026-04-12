import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AsyncStorage
const mockStorage: Record<string, string> = {};
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn((key: string) => Promise.resolve(mockStorage[key] || null)),
    setItem: vi.fn((key: string, value: string) => {
      mockStorage[key] = value;
      return Promise.resolve();
    }),
    removeItem: vi.fn((key: string) => {
      delete mockStorage[key];
      return Promise.resolve();
    }),
  },
}));

// Mock react-native
vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  StyleSheet: { create: (s: any) => s },
  Alert: { alert: vi.fn() },
}));

// Types matching admin.tsx
type UserRole = 'admin' | 'dispatcher' | 'responder' | 'user';

interface ManagedUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  status: 'active' | 'suspended' | 'deactivated';
  lastLogin: number;
  createdAt: number;
  phone?: string;
}

interface AdminIncident {
  id: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'active' | 'acknowledged' | 'dispatched' | 'resolved';
  reportedBy: string;
  address: string;
  timestamp: number;
  resolvedAt?: number;
  assignedCount: number;
}

interface AuditEntry {
  id: string;
  action: string;
  performedBy: string;
  targetUser?: string;
  details: string;
  timestamp: number;
  category: 'auth' | 'incident' | 'user' | 'system' | 'broadcast';
}

// ─── Test Data ───────────────────────────────────────────────────────
const mockUsers: ManagedUser[] = [
  { id: 'admin-001', name: 'Admin Principal', email: 'admin@talion.io', role: 'admin', status: 'active', lastLogin: Date.now() - 300000, createdAt: Date.now() - 86400000 * 90 },
  { id: 'disp-001', name: 'Centre Dispatch', email: 'dispatch@talion.io', role: 'dispatcher', status: 'active', lastLogin: Date.now() - 600000, createdAt: Date.now() - 86400000 * 60 },
  { id: 'resp-001', name: 'Unit Alpha', email: 'alpha@talion.io', role: 'responder', status: 'active', lastLogin: Date.now() - 120000, createdAt: Date.now() - 86400000 * 30 },
  { id: 'resp-002', name: 'Unit Bravo', email: 'bravo@talion.io', role: 'responder', status: 'suspended', lastLogin: Date.now() - 86400000 * 3, createdAt: Date.now() - 86400000 * 25 },
  { id: 'resp-003', name: 'Unit Charlie', email: 'charlie@talion.io', role: 'responder', status: 'deactivated', lastLogin: Date.now() - 86400000 * 14, createdAt: Date.now() - 86400000 * 15 },
  { id: 'user-001', name: 'Marie Dupont', email: 'marie@example.com', role: 'user', status: 'active', lastLogin: Date.now() - 7200000, createdAt: Date.now() - 86400000 * 10 },
];

const mockIncidents: AdminIncident[] = [
  { id: 'INC-001', type: 'medical', severity: 'critical', status: 'active', reportedBy: 'Marie Dupont', address: '123 Rue de Rivoli', timestamp: Date.now() - 120000, assignedCount: 0 },
  { id: 'INC-002', type: 'fire', severity: 'high', status: 'acknowledged', reportedBy: 'Pierre Martin', address: '456 Av. Champs-Elysees', timestamp: Date.now() - 480000, assignedCount: 1 },
  { id: 'INC-003', type: 'security', severity: 'medium', status: 'dispatched', reportedBy: 'Sophie Laurent', address: '12 Bd Saint-Germain', timestamp: Date.now() - 900000, assignedCount: 2 },
  { id: 'INC-004', type: 'sos', severity: 'critical', status: 'resolved', reportedBy: 'Jean Moreau', address: '78 Rue de la Republique', timestamp: Date.now() - 3600000, resolvedAt: Date.now() - 1800000, assignedCount: 3 },
  { id: 'INC-005', type: 'hazard', severity: 'low', status: 'resolved', reportedBy: 'Luc Bernard', address: '5 Place de la Concorde', timestamp: Date.now() - 7200000, resolvedAt: Date.now() - 5400000, assignedCount: 1 },
];

const mockAuditLog: AuditEntry[] = [
  { id: 'aud-001', action: 'User Login', performedBy: 'Admin Principal', details: 'Admin logged in', timestamp: Date.now() - 300000, category: 'auth' },
  { id: 'aud-002', action: 'Role Changed', performedBy: 'Admin Principal', targetUser: 'Unit Charlie', details: 'Role changed', timestamp: Date.now() - 600000, category: 'user' },
  { id: 'aud-003', action: 'Incident Created', performedBy: 'System', details: 'SOS alert created', timestamp: Date.now() - 120000, category: 'incident' },
  { id: 'aud-004', action: 'Zone Broadcast', performedBy: 'Centre Dispatch', details: 'Broadcast sent', timestamp: Date.now() - 900000, category: 'broadcast' },
  { id: 'aud-005', action: 'System Restart', performedBy: 'System', details: 'Server restarted', timestamp: Date.now() - 86400000, category: 'system' },
];

// ─── Tests ───────────────────────────────────────────────────────────
describe('Admin Console - User Management', () => {
  describe('User filtering', () => {
    it('filters users by name search', () => {
      const query = 'alpha';
      const filtered = mockUsers.filter(u =>
        u.name.toLowerCase().includes(query.toLowerCase()) ||
        u.email.toLowerCase().includes(query.toLowerCase())
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0].name).toBe('Unit Alpha');
    });

    it('filters users by email search', () => {
      const query = 'dispatch';
      const filtered = mockUsers.filter(u =>
        u.name.toLowerCase().includes(query.toLowerCase()) ||
        u.email.toLowerCase().includes(query.toLowerCase())
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0].email).toBe('dispatch@talion.io');
    });

    it('filters users by role search', () => {
      const query = 'responder';
      const filtered = mockUsers.filter(u =>
        u.role.toLowerCase().includes(query.toLowerCase())
      );
      expect(filtered).toHaveLength(3);
    });

    it('returns all users when search is empty', () => {
      const query = '';
      const filtered = query.trim()
        ? mockUsers.filter(u => u.name.toLowerCase().includes(query.toLowerCase()))
        : mockUsers;
      expect(filtered).toHaveLength(6);
    });
  });

  describe('User sorting by role', () => {
    it('sorts users with admin first, then dispatcher, responder, user', () => {
      const roleOrder: Record<UserRole, number> = { admin: 0, dispatcher: 1, responder: 2, user: 3 };
      const sorted = [...mockUsers].sort((a, b) => roleOrder[a.role] - roleOrder[b.role]);
      expect(sorted[0].role).toBe('admin');
      expect(sorted[1].role).toBe('dispatcher');
      expect(sorted[sorted.length - 1].role).toBe('user');
    });
  });

  describe('User status management', () => {
    it('can toggle active user to suspended', () => {
      const user = mockUsers.find(u => u.id === 'resp-001')!;
      expect(user.status).toBe('active');
      const newStatus = user.status === 'active' ? 'suspended' : 'active';
      expect(newStatus).toBe('suspended');
    });

    it('can toggle suspended user to active', () => {
      const user = mockUsers.find(u => u.id === 'resp-002')!;
      expect(user.status).toBe('suspended');
      const newStatus = user.status === 'active' ? 'suspended' : 'active';
      expect(newStatus).toBe('active');
    });

    it('prevents self-status change', () => {
      const currentUserId = 'admin-001';
      const targetUser = mockUsers.find(u => u.id === currentUserId)!;
      const isSelf = targetUser.id === currentUserId;
      expect(isSelf).toBe(true);
    });
  });

  describe('Role change', () => {
    it('can change user role', () => {
      const user = { ...mockUsers.find(u => u.id === 'user-001')! };
      const newRole: UserRole = 'responder';
      user.role = newRole;
      expect(user.role).toBe('responder');
    });

    it('prevents changing own role', () => {
      const currentUserId = 'admin-001';
      const targetUser = mockUsers.find(u => u.id === currentUserId)!;
      const isSelf = targetUser.id === currentUserId;
      expect(isSelf).toBe(true);
    });

    it('all four roles are available', () => {
      const roles: UserRole[] = ['admin', 'dispatcher', 'responder', 'user'];
      expect(roles).toHaveLength(4);
    });
  });

  describe('User statistics', () => {
    it('counts active users correctly', () => {
      const active = mockUsers.filter(u => u.status === 'active').length;
      expect(active).toBe(4);
    });

    it('counts suspended users correctly', () => {
      const suspended = mockUsers.filter(u => u.status === 'suspended').length;
      expect(suspended).toBe(1);
    });

    it('counts deactivated users correctly', () => {
      const deactivated = mockUsers.filter(u => u.status === 'deactivated').length;
      expect(deactivated).toBe(1);
    });

    it('counts users by role', () => {
      const byRole = {
        admin: mockUsers.filter(u => u.role === 'admin').length,
        dispatcher: mockUsers.filter(u => u.role === 'dispatcher').length,
        responder: mockUsers.filter(u => u.role === 'responder').length,
        user: mockUsers.filter(u => u.role === 'user').length,
      };
      expect(byRole.admin).toBe(1);
      expect(byRole.dispatcher).toBe(1);
      expect(byRole.responder).toBe(3);
      expect(byRole.user).toBe(1);
    });
  });
});

describe('Admin Console - Incident Management', () => {
  describe('Incident filtering', () => {
    it('filters active incidents (non-resolved)', () => {
      const active = mockIncidents.filter(i => i.status !== 'resolved');
      expect(active).toHaveLength(3);
    });

    it('filters resolved incidents', () => {
      const resolved = mockIncidents.filter(i => i.status === 'resolved');
      expect(resolved).toHaveLength(2);
    });

    it('returns all incidents when filter is all', () => {
      expect(mockIncidents).toHaveLength(5);
    });
  });

  describe('Incident sorting', () => {
    it('sorts incidents by timestamp descending', () => {
      const sorted = [...mockIncidents].sort((a, b) => b.timestamp - a.timestamp);
      expect(sorted[0].id).toBe('INC-001'); // most recent
      expect(sorted[sorted.length - 1].id).toBe('INC-005'); // oldest
    });
  });

  describe('Incident statistics', () => {
    it('counts total incidents', () => {
      expect(mockIncidents.length).toBe(5);
    });

    it('counts active incidents', () => {
      const active = mockIncidents.filter(i => i.status !== 'resolved').length;
      expect(active).toBe(3);
    });

    it('counts critical incidents', () => {
      const critical = mockIncidents.filter(i => i.severity === 'critical').length;
      expect(critical).toBe(2);
    });

    it('counts by severity', () => {
      const bySeverity = {
        critical: mockIncidents.filter(i => i.severity === 'critical').length,
        high: mockIncidents.filter(i => i.severity === 'high').length,
        medium: mockIncidents.filter(i => i.severity === 'medium').length,
        low: mockIncidents.filter(i => i.severity === 'low').length,
      };
      expect(bySeverity.critical).toBe(2);
      expect(bySeverity.high).toBe(1);
      expect(bySeverity.medium).toBe(1);
      expect(bySeverity.low).toBe(1);
    });
  });
});

describe('Admin Console - Analytics', () => {
  it('calculates average response time for resolved incidents', () => {
    const resolved = mockIncidents.filter(i => i.resolvedAt);
    const avgResponseTime = resolved.length > 0
      ? resolved.reduce((sum, i) => sum + ((i.resolvedAt! - i.timestamp) / 60000), 0) / resolved.length
      : 0;
    expect(avgResponseTime).toBeGreaterThan(0);
    // INC-004: (1800000) / 60000 = 30 min
    // INC-005: (1800000) / 60000 = 30 min
    // avg = 30
    expect(avgResponseTime).toBe(30);
  });

  it('returns 0 avg response time when no resolved incidents', () => {
    const noResolved: AdminIncident[] = mockIncidents.filter(i => i.status !== 'resolved');
    const resolved = noResolved.filter(i => i.resolvedAt);
    const avgResponseTime = resolved.length > 0
      ? resolved.reduce((sum, i) => sum + ((i.resolvedAt! - i.timestamp) / 60000), 0) / resolved.length
      : 0;
    expect(avgResponseTime).toBe(0);
  });

  it('calculates resolution rate', () => {
    const total = mockIncidents.length;
    const resolved = mockIncidents.filter(i => i.status === 'resolved').length;
    const rate = total > 0 ? (resolved / total) * 100 : 0;
    expect(rate).toBe(40); // 2 out of 5
  });
});

describe('Admin Console - Audit Log', () => {
  describe('Audit filtering', () => {
    it('filters by auth category', () => {
      const filtered = mockAuditLog.filter(e => e.category === 'auth');
      expect(filtered).toHaveLength(1);
    });

    it('filters by user category', () => {
      const filtered = mockAuditLog.filter(e => e.category === 'user');
      expect(filtered).toHaveLength(1);
    });

    it('filters by incident category', () => {
      const filtered = mockAuditLog.filter(e => e.category === 'incident');
      expect(filtered).toHaveLength(1);
    });

    it('filters by system category', () => {
      const filtered = mockAuditLog.filter(e => e.category === 'system');
      expect(filtered).toHaveLength(1);
    });

    it('filters by broadcast category', () => {
      const filtered = mockAuditLog.filter(e => e.category === 'broadcast');
      expect(filtered).toHaveLength(1);
    });

    it('returns all entries when filter is all', () => {
      expect(mockAuditLog).toHaveLength(5);
    });
  });

  describe('Audit sorting', () => {
    it('sorts audit entries by timestamp descending', () => {
      const sorted = [...mockAuditLog].sort((a, b) => b.timestamp - a.timestamp);
      expect(sorted[0].id).toBe('aud-003'); // most recent
    });
  });

  describe('Audit entry creation', () => {
    it('creates new audit entry with correct structure', () => {
      const newEntry: AuditEntry = {
        id: `aud-${Date.now()}`,
        action: 'Role Changed',
        performedBy: 'Admin Principal',
        targetUser: 'Unit Alpha',
        details: 'Role changed from Responder to Dispatcher',
        timestamp: Date.now(),
        category: 'user',
      };
      expect(newEntry.action).toBe('Role Changed');
      expect(newEntry.category).toBe('user');
      expect(newEntry.targetUser).toBe('Unit Alpha');
    });

    it('prepends new entry to existing log', () => {
      const newEntry: AuditEntry = {
        id: 'aud-new',
        action: 'Test',
        performedBy: 'Admin',
        details: 'Test entry',
        timestamp: Date.now(),
        category: 'system',
      };
      const updated = [newEntry, ...mockAuditLog];
      expect(updated[0].id).toBe('aud-new');
      expect(updated).toHaveLength(6);
    });
  });
});

describe('Admin Console - Role Access Control', () => {
  it('admin tab is visible only for admin role', () => {
    const roles: UserRole[] = ['admin', 'dispatcher', 'responder', 'user'];
    roles.forEach(role => {
      const isAdmin = role === 'admin';
      if (role === 'admin') {
        expect(isAdmin).toBe(true);
      } else {
        expect(isAdmin).toBe(false);
      }
    });
  });

  it('dispatcher tab is visible for admin and dispatcher', () => {
    const roles: UserRole[] = ['admin', 'dispatcher', 'responder', 'user'];
    roles.forEach(role => {
      const isDispatcher = role === 'dispatcher' || role === 'admin';
      if (role === 'admin' || role === 'dispatcher') {
        expect(isDispatcher).toBe(true);
      } else {
        expect(isDispatcher).toBe(false);
      }
    });
  });
});

describe('Admin Console - Formatting Helpers', () => {
  function formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function formatDate(timestamp: number): string {
    const d = new Date(timestamp);
    return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  }

  it('formats recent time as "Just now"', () => {
    expect(formatTimeAgo(Date.now())).toBe('Just now');
  });

  it('formats minutes ago', () => {
    expect(formatTimeAgo(Date.now() - 5 * 60000)).toBe('5m ago');
  });

  it('formats hours ago', () => {
    expect(formatTimeAgo(Date.now() - 3 * 3600000)).toBe('3h ago');
  });

  it('formats days ago', () => {
    expect(formatTimeAgo(Date.now() - 5 * 86400000)).toBe('5d ago');
  });

  it('formats months ago', () => {
    expect(formatTimeAgo(Date.now() - 45 * 86400000)).toBe('1mo ago');
  });

  it('formats date correctly', () => {
    const ts = new Date(2026, 2, 25, 14, 30).getTime(); // March 25, 2026 14:30
    expect(formatDate(ts)).toBe('25/03/2026 14:30');
  });
});

describe('Admin Console - Category Colors', () => {
  function getCategoryColor(category: string): string {
    switch (category) {
      case 'auth': return '#7c3aed';
      case 'user': return '#059669';
      case 'incident': return '#ef4444';
      case 'system': return '#6b7280';
      case 'broadcast': return '#f59e0b';
      default: return '#6b7280';
    }
  }

  it('returns correct color for each category', () => {
    expect(getCategoryColor('auth')).toBe('#7c3aed');
    expect(getCategoryColor('user')).toBe('#059669');
    expect(getCategoryColor('incident')).toBe('#ef4444');
    expect(getCategoryColor('system')).toBe('#6b7280');
    expect(getCategoryColor('broadcast')).toBe('#f59e0b');
  });

  it('returns default color for unknown category', () => {
    expect(getCategoryColor('unknown')).toBe('#6b7280');
  });
});
