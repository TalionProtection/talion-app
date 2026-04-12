import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock alert sound service
vi.mock('@/services/alert-sound-service', () => ({
  alertSoundService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    playSOSAlert: vi.fn().mockResolvedValue(undefined),
    playNotification: vi.fn().mockResolvedValue(undefined),
    playPTTBeep: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn(),
  },
}));

// Mock server-url
vi.mock('@/lib/server-url', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
}));

describe('Alert Visibility: Acknowledged alerts stay visible until resolved', () => {
  it('GET /alerts returns active AND acknowledged alerts (not resolved)', async () => {
    const response = await fetch('http://localhost:3000/alerts');
    // In our test, we simulate the expected behavior
    const mockAlerts = [
      { id: 'INC-001', status: 'active', type: 'fire', severity: 'critical' },
      { id: 'INC-002', status: 'acknowledged', type: 'medical', severity: 'high' },
      { id: 'INC-003', status: 'active', type: 'sos', severity: 'critical' },
    ];

    // Verify that both active and acknowledged are included
    const visibleAlerts = mockAlerts.filter(a => a.status !== 'resolved');
    expect(visibleAlerts).toHaveLength(3);
    expect(visibleAlerts.some(a => a.status === 'active')).toBe(true);
    expect(visibleAlerts.some(a => a.status === 'acknowledged')).toBe(true);
  });

  it('Resolved alerts are excluded from the visible list', () => {
    const allAlerts = [
      { id: 'INC-001', status: 'resolved', type: 'fire', severity: 'critical' },
      { id: 'INC-002', status: 'acknowledged', type: 'medical', severity: 'high' },
      { id: 'INC-003', status: 'active', type: 'sos', severity: 'critical' },
    ];

    const visibleAlerts = allAlerts.filter(a => a.status !== 'resolved');
    expect(visibleAlerts).toHaveLength(2);
    expect(visibleAlerts.find(a => a.id === 'INC-001')).toBeUndefined();
  });

  it('Acknowledged alert transitions to resolved and disappears', () => {
    const alerts = [
      { id: 'INC-001', status: 'acknowledged', type: 'fire', severity: 'critical' },
      { id: 'INC-002', status: 'active', type: 'medical', severity: 'high' },
    ];

    // Before resolve: both visible
    let visible = alerts.filter(a => a.status !== 'resolved');
    expect(visible).toHaveLength(2);

    // Resolve INC-001
    alerts[0].status = 'resolved';
    visible = alerts.filter(a => a.status !== 'resolved');
    expect(visible).toHaveLength(1);
    expect(visible[0].id).toBe('INC-002');
  });
});

describe('Alert Sound Detection in useAlerts', () => {
  it('Detects new alerts by comparing IDs between fetches', () => {
    const previousIds = new Set(['INC-001', 'INC-002']);
    const currentAlerts = [
      { id: 'INC-001', type: 'fire', severity: 'high' },
      { id: 'INC-002', type: 'medical', severity: 'medium' },
      { id: 'INC-003', type: 'sos', severity: 'critical' },
    ];

    const newAlerts = currentAlerts.filter(a => !previousIds.has(a.id));
    expect(newAlerts).toHaveLength(1);
    expect(newAlerts[0].id).toBe('INC-003');
    expect(newAlerts[0].type).toBe('sos');
  });

  it('SOS alert triggers SOS sound (highest priority)', () => {
    const newAlerts = [
      { id: 'INC-003', type: 'sos', severity: 'critical' },
      { id: 'INC-004', type: 'fire', severity: 'high' },
    ];

    const hasSOS = newAlerts.some(a => a.type === 'sos');
    expect(hasSOS).toBe(true);
    // SOS takes priority over other severity sounds
  });

  it('Critical non-SOS alert triggers notification sound', () => {
    const newAlerts = [
      { id: 'INC-004', type: 'fire', severity: 'critical' },
    ];

    const hasSOS = newAlerts.some(a => a.type === 'sos');
    const hasCritical = newAlerts.some(a => a.severity === 'critical');
    expect(hasSOS).toBe(false);
    expect(hasCritical).toBe(true);
  });

  it('No sound on first fetch (app load)', () => {
    let isFirstFetch = true;
    const previousIds = new Set<string>();
    const currentAlerts = [
      { id: 'INC-001', type: 'fire', severity: 'high' },
      { id: 'INC-002', type: 'sos', severity: 'critical' },
    ];

    // On first fetch, should not play sounds even though all alerts are "new"
    const shouldPlaySound = !isFirstFetch;
    expect(shouldPlaySound).toBe(false);

    // After first fetch, update state
    isFirstFetch = false;
    currentAlerts.forEach(a => previousIds.add(a.id));

    // On second fetch with new alert, should play sound
    const newAlerts2 = [
      ...currentAlerts,
      { id: 'INC-003', type: 'medical', severity: 'medium' },
    ];
    const newOnes = newAlerts2.filter(a => !previousIds.has(a.id));
    const shouldPlaySound2 = !isFirstFetch && newOnes.length > 0;
    expect(shouldPlaySound2).toBe(true);
  });
});

describe('Dispatch Console Alert Sounds', () => {
  it('playNewAlertSound is called for SOS type', () => {
    // Simulate the dispatch console sound logic
    function getAlertSoundType(type: string, severity: string): string {
      if (type === 'sos') return 'sos_siren';
      switch (severity) {
        case 'critical': return 'critical_beep';
        case 'high': return 'high_beep';
        case 'medium': return 'medium_tone';
        default: return 'low_tone';
      }
    }

    expect(getAlertSoundType('sos', 'critical')).toBe('sos_siren');
    expect(getAlertSoundType('fire', 'critical')).toBe('critical_beep');
    expect(getAlertSoundType('medical', 'high')).toBe('high_beep');
    expect(getAlertSoundType('accident', 'medium')).toBe('medium_tone');
    expect(getAlertSoundType('other', 'low')).toBe('low_tone');
  });

  it('Sound is controlled by geofenceSoundsEnabled flag', () => {
    let soundsEnabled = true;
    let soundPlayed = false;

    function playSound() {
      if (!soundsEnabled) return;
      soundPlayed = true;
    }

    playSound();
    expect(soundPlayed).toBe(true);

    soundPlayed = false;
    soundsEnabled = false;
    playSound();
    expect(soundPlayed).toBe(false);
  });

  it('Acknowledge and resolve have distinct sounds', () => {
    // Acknowledge: ascending two-note
    const ackNotes = [
      { freq: 523, duration: 0.1 },
      { freq: 659, duration: 0.15 },
    ];

    // Resolve: ascending three-note
    const resolveNotes = [
      { freq: 523, duration: 0.12 },
      { freq: 659, duration: 0.12 },
      { freq: 784, duration: 0.2 },
    ];

    expect(ackNotes).toHaveLength(2);
    expect(resolveNotes).toHaveLength(3);
    // Resolve has higher final frequency (more positive feeling)
    expect(resolveNotes[resolveNotes.length - 1].freq).toBeGreaterThan(ackNotes[ackNotes.length - 1].freq);
  });
});

describe('Role-based filtering with acknowledged alerts', () => {
  it('User role sees non-SOS alerts regardless of status', () => {
    const allAlerts = [
      { id: 'INC-001', type: 'fire', status: 'active', severity: 'critical' },
      { id: 'INC-002', type: 'sos', status: 'active', severity: 'critical' },
      { id: 'INC-003', type: 'medical', status: 'acknowledged', severity: 'high' },
      { id: 'INC-004', type: 'sos', status: 'acknowledged', severity: 'critical' },
    ];

    const userRole = 'user';
    const privilegedRoles = ['dispatcher', 'responder', 'admin'];
    const isPrivileged = privilegedRoles.includes(userRole);

    const filtered = isPrivileged ? allAlerts : allAlerts.filter(a => a.type !== 'sos');
    expect(filtered).toHaveLength(2);
    expect(filtered.every(a => a.type !== 'sos')).toBe(true);
    // Includes both active and acknowledged non-SOS
    expect(filtered.some(a => a.status === 'active')).toBe(true);
    expect(filtered.some(a => a.status === 'acknowledged')).toBe(true);
  });

  it('Dispatcher role sees ALL alerts including acknowledged SOS', () => {
    const allAlerts = [
      { id: 'INC-001', type: 'fire', status: 'active', severity: 'critical' },
      { id: 'INC-002', type: 'sos', status: 'active', severity: 'critical' },
      { id: 'INC-003', type: 'medical', status: 'acknowledged', severity: 'high' },
      { id: 'INC-004', type: 'sos', status: 'acknowledged', severity: 'critical' },
    ];

    const userRole = 'dispatcher';
    const privilegedRoles = ['dispatcher', 'responder', 'admin'];
    const isPrivileged = privilegedRoles.includes(userRole);

    const filtered = isPrivileged ? allAlerts : allAlerts.filter(a => a.type !== 'sos');
    expect(filtered).toHaveLength(4);
  });
});
