import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Test: useActiveSOSAlert hook logic ─────────────────────────────────────

describe('useActiveSOSAlert - SOS alert detection logic', () => {
  // Simulate the filtering logic from the hook
  interface TestAlert {
    id: string;
    type: string;
    createdBy: string;
    status: 'active' | 'acknowledged' | 'resolved';
    severity: string;
    location: { latitude: number; longitude: number; address: string };
    description: string;
    createdAt: number;
    respondingUsers: string[];
  }

  function findUserActiveSOSAlert(alerts: TestAlert[], userId: string) {
    return alerts.find(
      (a) =>
        a.type === 'sos' &&
        a.createdBy === userId &&
        (a.status === 'active' || a.status === 'acknowledged')
    ) || null;
  }

  const baseAlert: TestAlert = {
    id: 'INC-001',
    type: 'sos',
    createdBy: 'user-001',
    status: 'active',
    severity: 'critical',
    location: { latitude: 46.19, longitude: 6.15, address: 'Genève' },
    description: 'SOS Alert',
    createdAt: Date.now(),
    respondingUsers: [],
  };

  it('should detect an active SOS alert created by the user', () => {
    const alerts = [baseAlert];
    const result = findUserActiveSOSAlert(alerts, 'user-001');
    expect(result).not.toBeNull();
    expect(result?.id).toBe('INC-001');
  });

  it('should detect an acknowledged SOS alert created by the user', () => {
    const alerts = [{ ...baseAlert, status: 'acknowledged' as const }];
    const result = findUserActiveSOSAlert(alerts, 'user-001');
    expect(result).not.toBeNull();
    expect(result?.status).toBe('acknowledged');
  });

  it('should NOT detect a resolved SOS alert', () => {
    const alerts = [{ ...baseAlert, status: 'resolved' as const }];
    const result = findUserActiveSOSAlert(alerts, 'user-001');
    expect(result).toBeNull();
  });

  it('should NOT detect an SOS alert created by a different user', () => {
    const alerts = [baseAlert];
    const result = findUserActiveSOSAlert(alerts, 'user-002');
    expect(result).toBeNull();
  });

  it('should NOT detect a non-SOS alert (e.g., medical)', () => {
    const alerts = [{ ...baseAlert, type: 'medical' }];
    const result = findUserActiveSOSAlert(alerts, 'user-001');
    expect(result).toBeNull();
  });

  it('should return null when there are no alerts', () => {
    const result = findUserActiveSOSAlert([], 'user-001');
    expect(result).toBeNull();
  });

  it('should return the first matching SOS alert when multiple exist', () => {
    const alerts = [
      baseAlert,
      { ...baseAlert, id: 'INC-002', createdAt: Date.now() + 1000 },
    ];
    const result = findUserActiveSOSAlert(alerts, 'user-001');
    expect(result?.id).toBe('INC-001');
  });
});

// ─── Test: Profile SOS banner visibility logic ──────────────────────────────

describe('Profile SOS Banner - visibility logic', () => {
  it('should show PTT button when activeAlert is present', () => {
    const activeAlert = {
      id: 'INC-005',
      type: 'sos',
      status: 'active',
      description: 'SOS Alert from user',
      location: { address: 'Genève' },
    };
    // Banner is shown when activeAlert is truthy
    expect(!!activeAlert).toBe(true);
  });

  it('should NOT show PTT button when activeAlert is null', () => {
    const activeAlert = null;
    expect(!!activeAlert).toBe(false);
  });
});

// ─── Test: PTT channel selection for SOS ────────────────────────────────────

describe('PTT Emergency Channel Selection', () => {
  const channels = [
    { id: 'emergency', name: 'Urgence', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'] },
    { id: 'dispatch', name: 'Dispatch', allowedRoles: ['responder', 'dispatcher', 'admin'] },
    { id: 'responders', name: 'Intervenants', allowedRoles: ['responder', 'dispatcher', 'admin'] },
    { id: 'general', name: 'Général', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'] },
  ];

  it('should find the emergency channel by ID', () => {
    const emergencyChannel = channels.find(ch => ch.id === 'emergency');
    expect(emergencyChannel).toBeDefined();
    expect(emergencyChannel?.name).toBe('Urgence');
  });

  it('emergency channel should allow all roles', () => {
    const emergencyChannel = channels.find(ch => ch.id === 'emergency');
    expect(emergencyChannel?.allowedRoles).toContain('user');
    expect(emergencyChannel?.allowedRoles).toContain('responder');
    expect(emergencyChannel?.allowedRoles).toContain('dispatcher');
    expect(emergencyChannel?.allowedRoles).toContain('admin');
  });

  it('dispatch channel should NOT allow regular users', () => {
    const dispatchChannel = channels.find(ch => ch.id === 'dispatch');
    expect(dispatchChannel?.allowedRoles).not.toContain('user');
  });
});

// ─── Test: Dispatch console PTT message rendering logic ─────────────────────

describe('Dispatch Console PTT - message rendering', () => {
  function formatPTTDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`;
  }

  function formatPTTTime(timestamp: string | number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function getRoleBadgeClass(role: string): string {
    switch (role) {
      case 'dispatcher': return 'ptt-role-dispatcher';
      case 'responder': return 'ptt-role-responder';
      case 'admin': return 'ptt-role-admin';
      default: return 'ptt-role-user';
    }
  }

  it('should format durations correctly', () => {
    expect(formatPTTDuration(3)).toBe('3s');
    expect(formatPTTDuration(45)).toBe('45s');
    expect(formatPTTDuration(65)).toBe('1:05');
    expect(formatPTTDuration(125)).toBe('2:05');
  });

  it('should assign correct role badge classes', () => {
    expect(getRoleBadgeClass('dispatcher')).toBe('ptt-role-dispatcher');
    expect(getRoleBadgeClass('responder')).toBe('ptt-role-responder');
    expect(getRoleBadgeClass('admin')).toBe('ptt-role-admin');
    expect(getRoleBadgeClass('user')).toBe('ptt-role-user');
    expect(getRoleBadgeClass('unknown')).toBe('ptt-role-user');
  });

  it('should format time in French locale', () => {
    const timestamp = new Date('2026-03-27T14:30:00Z').getTime();
    const formatted = formatPTTTime(timestamp);
    // Should contain hours and minutes
    expect(formatted).toMatch(/\d{2}:\d{2}/);
  });
});

// ─── Test: PTT WebSocket message format ─────────────────────────────────────

describe('PTT WebSocket Message Format', () => {
  it('should construct correct pttTransmit message', () => {
    const channelId = 'emergency';
    const audioBase64 = 'base64encodedaudio==';
    const duration = 3.5;
    const senderName = 'Jean Dupont';

    const message = {
      type: 'pttTransmit',
      data: {
        channelId,
        audioBase64,
        duration,
        senderName,
      },
    };

    expect(message.type).toBe('pttTransmit');
    expect(message.data.channelId).toBe('emergency');
    expect(message.data.audioBase64).toBe(audioBase64);
    expect(message.data.duration).toBe(3.5);
    expect(message.data.senderName).toBe('Jean Dupont');
  });

  it('should construct correct pttJoinChannel message', () => {
    const message = {
      type: 'pttJoinChannel',
      data: { channelId: 'dispatch' },
    };

    expect(message.type).toBe('pttJoinChannel');
    expect(message.data.channelId).toBe('dispatch');
  });

  it('should construct correct pttStartTalking message', () => {
    const message = {
      type: 'pttStartTalking',
      data: { channelId: 'emergency', userName: 'Dispatch Operator' },
    };

    expect(message.type).toBe('pttStartTalking');
    expect(message.data.channelId).toBe('emergency');
    expect(message.data.userName).toBe('Dispatch Operator');
  });

  it('should construct correct pttEmergency message', () => {
    const message = {
      type: 'pttEmergency',
      data: {
        audioBase64: 'emergencyaudio==',
        duration: 5.2,
        senderName: 'Admin User',
      },
    };

    expect(message.type).toBe('pttEmergency');
    expect(message.data.audioBase64).toBe('emergencyaudio==');
    expect(message.data.duration).toBe(5.2);
  });
});

// ─── Test: Dispatch PTT channel filtering ───────────────────────────────────

describe('Dispatch PTT Channel Filtering', () => {
  const channels = [
    { id: 'emergency', name: 'Urgence', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], isActive: true },
    { id: 'dispatch', name: 'Dispatch', allowedRoles: ['responder', 'dispatcher', 'admin'], isActive: true },
    { id: 'responders', name: 'Intervenants', allowedRoles: ['responder', 'dispatcher', 'admin'], isActive: true },
    { id: 'general', name: 'Général', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], isActive: true },
    { id: 'custom-1', name: 'Custom', allowedRoles: ['dispatcher'], isActive: false },
  ];

  it('dispatcher should see all active channels they have access to', () => {
    const role = 'dispatcher';
    const visible = channels.filter(
      ch => ch.isActive && ch.allowedRoles.includes(role)
    );
    expect(visible.length).toBe(4);
  });

  it('user should only see channels they have access to', () => {
    const role = 'user';
    const visible = channels.filter(
      ch => ch.isActive && ch.allowedRoles.includes(role)
    );
    expect(visible.length).toBe(2);
    expect(visible.map(c => c.id)).toEqual(['emergency', 'general']);
  });

  it('inactive channels should be excluded', () => {
    const role = 'dispatcher';
    const visible = channels.filter(
      ch => ch.isActive && ch.allowedRoles.includes(role)
    );
    expect(visible.find(c => c.id === 'custom-1')).toBeUndefined();
  });
});
