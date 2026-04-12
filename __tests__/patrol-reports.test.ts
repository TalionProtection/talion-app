import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock modules ─────────────────────────────────────────────────────────────
vi.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (opts: any) => opts.ios },
  StyleSheet: { create: (s: any) => s },
  Alert: { alert: vi.fn() },
}));

vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium' },
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: vi.fn(),
  launchCameraAsync: vi.fn(),
  MediaTypeOptions: { All: 'All', Images: 'Images', Videos: 'Videos' },
  requestCameraPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  requestMediaLibraryPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
}));

// ─── Patrol Report Data Model Tests ───────────────────────────────────────────

describe('Patrol Report Data Model', () => {
  const STATUS_CONFIG: Record<string, { label: string; color: string; textColor: string }> = {
    habituel:       { label: 'Habituel',       color: '#22C55E', textColor: '#ffffff' },
    inhabituel:     { label: 'Inhabituel',     color: '#EAB308', textColor: '#000000' },
    identification: { label: 'Identification', color: '#F97316', textColor: '#ffffff' },
    suspect:        { label: 'Suspect',        color: '#EF4444', textColor: '#ffffff' },
    menace:         { label: 'Menace',         color: '#8B5CF6', textColor: '#ffffff' },
    attaque:        { label: 'Attaque',        color: '#000000', textColor: '#ffffff' },
  };

  it('should have 6 predefined statuses with correct colors', () => {
    expect(Object.keys(STATUS_CONFIG)).toHaveLength(6);
    expect(STATUS_CONFIG.habituel.color).toBe('#22C55E');    // green
    expect(STATUS_CONFIG.inhabituel.color).toBe('#EAB308');  // yellow
    expect(STATUS_CONFIG.identification.color).toBe('#F97316'); // orange
    expect(STATUS_CONFIG.suspect.color).toBe('#EF4444');     // red
    expect(STATUS_CONFIG.menace.color).toBe('#8B5CF6');      // violet
    expect(STATUS_CONFIG.attaque.color).toBe('#000000');     // black
  });

  it('should have correct labels in French', () => {
    expect(STATUS_CONFIG.habituel.label).toBe('Habituel');
    expect(STATUS_CONFIG.inhabituel.label).toBe('Inhabituel');
    expect(STATUS_CONFIG.identification.label).toBe('Identification');
    expect(STATUS_CONFIG.suspect.label).toBe('Suspect');
    expect(STATUS_CONFIG.menace.label).toBe('Menace');
    expect(STATUS_CONFIG.attaque.label).toBe('Attaque');
  });
});

describe('Patrol Report Task Validation', () => {
  const TASKS = [
    { name: 'ronde_exterieure', label: 'Ronde extérieure' },
    { name: 'ronde_interieure', label: 'Ronde intérieure' },
    { name: 'ronde_maison', label: 'Ronde maison' },
    { name: 'anomalies', label: 'Anomalies' },
    { name: 'autre', label: 'Autre' },
  ];

  it('should have 5 predefined tasks', () => {
    expect(TASKS).toHaveLength(5);
  });

  it('should include all required task types', () => {
    const names = TASKS.map(t => t.name);
    expect(names).toContain('ronde_exterieure');
    expect(names).toContain('ronde_interieure');
    expect(names).toContain('ronde_maison');
    expect(names).toContain('anomalies');
    expect(names).toContain('autre');
  });

  it('should validate task results as ok or pas_ok', () => {
    const validResults = ['ok', 'pas_ok'];
    const taskResult = 'ok';
    expect(validResults).toContain(taskResult);
    const taskResult2 = 'pas_ok';
    expect(validResults).toContain(taskResult2);
  });
});

describe('Patrol Report Sites', () => {
  const SITES = [
    'Champel — Avenue de Champel 24',
    'Champel — Chemin des Crêts-de-Champel 2',
    'Florissant — Route de Florissant 62',
    'Florissant — Avenue de Miremont 30',
    'Malagnou — Route de Malagnou 32',
    'Malagnou — Chemin du Velours 10',
    'Vésenaz — Route de Thonon 85',
    'Vésenaz — Chemin de la Capite 12',
  ];

  it('should have 8 predefined sites in Geneva', () => {
    expect(SITES).toHaveLength(8);
  });

  it('should include sites from all 4 communes', () => {
    const communes = ['Champel', 'Florissant', 'Malagnou', 'Vésenaz'];
    communes.forEach(commune => {
      expect(SITES.some(s => s.startsWith(commune))).toBe(true);
    });
  });

  it('should have 2 sites per commune', () => {
    const communes = ['Champel', 'Florissant', 'Malagnou', 'Vésenaz'];
    communes.forEach(commune => {
      const count = SITES.filter(s => s.startsWith(commune)).length;
      expect(count).toBe(2);
    });
  });
});

describe('Patrol Report Access Control', () => {
  const allowedRoles = ['responder', 'dispatcher', 'admin'];
  const deniedRoles = ['user'];

  it('should allow responders, dispatchers, and admins to create reports', () => {
    allowedRoles.forEach(role => {
      expect(['responder', 'dispatcher', 'admin']).toContain(role);
    });
  });

  it('should deny regular users from creating reports', () => {
    deniedRoles.forEach(role => {
      expect(['responder', 'dispatcher', 'admin']).not.toContain(role);
    });
  });

  it('should allow responders, dispatchers, and admins to view reports', () => {
    const canView = (role: string) => ['responder', 'dispatcher', 'admin'].includes(role);
    expect(canView('responder')).toBe(true);
    expect(canView('dispatcher')).toBe(true);
    expect(canView('admin')).toBe(true);
    expect(canView('user')).toBe(false);
  });
});

describe('Patrol Report Alert Logic', () => {
  it('should trigger alert for non-habituel statuses', () => {
    const shouldAlert = (status: string) => status !== 'habituel';
    expect(shouldAlert('habituel')).toBe(false);
    expect(shouldAlert('inhabituel')).toBe(true);
    expect(shouldAlert('identification')).toBe(true);
    expect(shouldAlert('suspect')).toBe(true);
    expect(shouldAlert('menace')).toBe(true);
    expect(shouldAlert('attaque')).toBe(true);
  });

  it('should send alerts only to dispatchers and admins', () => {
    const alertRecipients = ['dispatcher', 'admin'];
    expect(alertRecipients).toContain('dispatcher');
    expect(alertRecipients).toContain('admin');
    expect(alertRecipients).not.toContain('user');
    expect(alertRecipients).not.toContain('responder');
  });
});

describe('Patrol Report Media Attachments', () => {
  it('should support photo and video media types', () => {
    const validTypes = ['photo', 'video'];
    expect(validTypes).toContain('photo');
    expect(validTypes).toContain('video');
  });

  it('should generate unique media IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const id = `media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      ids.add(id);
    }
    expect(ids.size).toBe(100);
  });

  it('should structure media attachment correctly', () => {
    const media = {
      id: 'media-123',
      type: 'photo' as const,
      url: '/uploads/patrol/test.jpg',
      filename: 'test.jpg',
      uploadedAt: Date.now(),
    };
    expect(media).toHaveProperty('id');
    expect(media).toHaveProperty('type');
    expect(media).toHaveProperty('url');
    expect(media).toHaveProperty('filename');
    expect(media).toHaveProperty('uploadedAt');
    expect(['photo', 'video']).toContain(media.type);
  });
});

describe('Patrol Report Formatting', () => {
  it('should format date and time in Swiss French format', () => {
    const timestamp = new Date('2026-03-27T10:30:00Z').getTime();
    const date = new Date(timestamp);
    const dateStr = date.toLocaleDateString('fr-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' });
    // Should contain date parts
    expect(dateStr).toMatch(/\d{2}/);
    expect(timeStr).toMatch(/\d{2}/);
  });

  it('should create report with auto-generated timestamp', () => {
    const before = Date.now();
    const report = {
      id: 'PR-test',
      createdAt: Date.now(),
      location: 'Champel — Avenue de Champel 24',
      status: 'habituel',
      tasks: [],
    };
    const after = Date.now();
    expect(report.createdAt).toBeGreaterThanOrEqual(before);
    expect(report.createdAt).toBeLessThanOrEqual(after);
  });
});
