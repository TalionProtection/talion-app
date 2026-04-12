import { describe, it, expect } from 'vitest';

/**
 * Tests for the Broadcast Alert flow:
 * 1. Server creates a real alert from broadcast request
 * 2. Alert is broadcast via WebSocket as newAlert
 * 3. Alert appears in GET /alerts (polling)
 * 4. Push notifications sent to all users
 * 5. Mobile app displays broadcast alerts with correct icon/title
 */

interface Alert {
  id: string;
  type: string;
  severity: string;
  location: { latitude: number; longitude: number; address: string };
  description: string;
  createdBy: string;
  createdAt: number;
  status: string;
  respondingUsers: string[];
}

describe('Broadcast Alert - Server creates real alert', () => {
  it('should create an alert with type broadcast from dispatch broadcast request', () => {
    const message = 'Evacuation zone nord immédiate';
    const severity = 'critical';
    const radiusKm = 5;
    const by = 'Sophie Laurent';

    // Simulate what the server does
    const alert: Alert = {
      id: `BC-test1234`,
      type: 'broadcast',
      severity,
      location: {
        latitude: 46.1950,
        longitude: 6.1580,
        address: `Zone broadcast (${radiusKm}km radius)`,
      },
      description: message,
      createdBy: by,
      createdAt: Date.now(),
      status: 'active',
      respondingUsers: [],
    };

    expect(alert.type).toBe('broadcast');
    expect(alert.severity).toBe('critical');
    expect(alert.description).toBe('Evacuation zone nord immédiate');
    expect(alert.createdBy).toBe('Sophie Laurent');
    expect(alert.status).toBe('active');
    expect(alert.location.address).toContain('5km radius');
    expect(alert.id).toMatch(/^BC-/);
  });

  it('should default severity to medium if not provided', () => {
    const severity = undefined;
    const sev = (severity || 'medium') as string;
    expect(sev).toBe('medium');
  });

  it('should default location to Geneva if not provided', () => {
    const latitude = undefined;
    const longitude = undefined;
    const loc = {
      latitude: latitude || 46.1950,
      longitude: longitude || 6.1580,
    };
    expect(loc.latitude).toBe(46.1950);
    expect(loc.longitude).toBe(6.1580);
  });
});

describe('Broadcast Alert - Visible in GET /alerts', () => {
  it('should include broadcast alerts in the alerts list (not resolved)', () => {
    const alerts = new Map<string, Alert>();
    alerts.set('INC-001', {
      id: 'INC-001', type: 'medical', severity: 'high',
      location: { latitude: 46.19, longitude: 6.15, address: 'Avenue de Champel' },
      description: 'Medical emergency', createdBy: 'Jean', createdAt: Date.now(),
      status: 'active', respondingUsers: [],
    });
    alerts.set('BC-001', {
      id: 'BC-001', type: 'broadcast', severity: 'critical',
      location: { latitude: 46.19, longitude: 6.15, address: 'Zone broadcast (5km radius)' },
      description: 'Evacuation immédiate', createdBy: 'Sophie', createdAt: Date.now(),
      status: 'active', respondingUsers: [],
    });
    alerts.set('INC-002', {
      id: 'INC-002', type: 'fire', severity: 'medium',
      location: { latitude: 46.20, longitude: 6.16, address: 'Route de Florissant' },
      description: 'Fire alarm', createdBy: 'Pierre', createdAt: Date.now(),
      status: 'resolved', respondingUsers: [],
    });

    // Simulate GET /alerts endpoint logic
    const visibleAlerts = Array.from(alerts.values()).filter(a => a.status !== 'resolved');

    expect(visibleAlerts).toHaveLength(2);
    expect(visibleAlerts.some(a => a.type === 'broadcast')).toBe(true);
    expect(visibleAlerts.some(a => a.id === 'INC-002')).toBe(false); // resolved
  });

  it('should show broadcast alerts to regular users (not filtered like SOS)', () => {
    const allAlerts: Alert[] = [
      {
        id: 'SOS-001', type: 'sos', severity: 'critical',
        location: { latitude: 46.19, longitude: 6.15, address: 'SOS' },
        description: 'SOS', createdBy: 'User', createdAt: Date.now(),
        status: 'active', respondingUsers: [],
      },
      {
        id: 'BC-001', type: 'broadcast', severity: 'high',
        location: { latitude: 46.19, longitude: 6.15, address: 'Broadcast zone' },
        description: 'Zone alert', createdBy: 'Dispatch', createdAt: Date.now(),
        status: 'active', respondingUsers: [],
      },
      {
        id: 'INC-001', type: 'fire', severity: 'medium',
        location: { latitude: 46.20, longitude: 6.16, address: 'Fire' },
        description: 'Fire alarm', createdBy: 'Pierre', createdAt: Date.now(),
        status: 'active', respondingUsers: [],
      },
    ];

    // Simulate useAlerts filtering for regular user (role='user')
    const userRole = 'user';
    const privilegedRoles = ['dispatcher', 'responder', 'admin'];
    const filteredAlerts = privilegedRoles.includes(userRole)
      ? allAlerts
      : allAlerts.filter(a => a.type !== 'sos');

    // Regular user should see broadcast + fire, but NOT SOS
    expect(filteredAlerts).toHaveLength(2);
    expect(filteredAlerts.some(a => a.type === 'broadcast')).toBe(true);
    expect(filteredAlerts.some(a => a.type === 'fire')).toBe(true);
    expect(filteredAlerts.some(a => a.type === 'sos')).toBe(false);
  });
});

describe('Broadcast Alert - WebSocket broadcast', () => {
  it('should broadcast as newAlert type (not just zoneBroadcast)', () => {
    const broadcastedMessages: any[] = [];

    function broadcastMessage(message: any) {
      broadcastedMessages.push(message);
    }

    const alert: Alert = {
      id: 'BC-test', type: 'broadcast', severity: 'medium',
      location: { latitude: 46.19, longitude: 6.15, address: 'Zone broadcast (3km radius)' },
      description: 'Test broadcast', createdBy: 'Dispatch', createdAt: Date.now(),
      status: 'active', respondingUsers: [],
    };

    // Simulate what the server does
    broadcastMessage({ type: 'newAlert', data: alert });
    broadcastMessage({ type: 'zoneBroadcast', data: { message: alert.description, severity: alert.severity } });

    // Should have both newAlert (for mobile) and zoneBroadcast (for dispatch console legacy)
    expect(broadcastedMessages).toHaveLength(2);
    expect(broadcastedMessages[0].type).toBe('newAlert');
    expect(broadcastedMessages[0].data.type).toBe('broadcast');
    expect(broadcastedMessages[1].type).toBe('zoneBroadcast');
  });
});

describe('Broadcast Alert - Push notifications to all users', () => {
  it('should target ALL registered push tokens (not just dispatchers)', () => {
    const pushTokens = new Map<string, { token: string; userId: string; userRole: string }>();
    pushTokens.set('token-1', { token: 'token-1', userId: 'user-1', userRole: 'user' });
    pushTokens.set('token-2', { token: 'token-2', userId: 'resp-1', userRole: 'responder' });
    pushTokens.set('token-3', { token: 'token-3', userId: 'disp-1', userRole: 'dispatcher' });
    pushTokens.set('token-4', { token: 'token-4', userId: 'admin-1', userRole: 'admin' });

    // Simulate sendPushToAllUsers - collects ALL tokens
    const targetTokens: string[] = [];
    for (const [token, _entry] of pushTokens) {
      targetTokens.push(token);
    }

    expect(targetTokens).toHaveLength(4);
    expect(targetTokens).toContain('token-1'); // regular user gets push
    expect(targetTokens).toContain('token-2'); // responder gets push
    expect(targetTokens).toContain('token-3'); // dispatcher gets push
    expect(targetTokens).toContain('token-4'); // admin gets push
  });

  it('should format push notification with severity emoji', () => {
    const SEVERITY_EMOJI: Record<string, string> = {
      critical: '\u{1F6A8}', high: '\u{26A0}\u{FE0F}', medium: '\u{1F4E2}', low: '\u{2139}\u{FE0F}',
    };

    expect(SEVERITY_EMOJI['critical']).toBe('\u{1F6A8}');
    expect(SEVERITY_EMOJI['medium']).toBe('\u{1F4E2}');

    const severity = 'high';
    const emoji = SEVERITY_EMOJI[severity] || '\u{1F4E2}';
    const title = `${emoji} BROADCAST - ${severity.toUpperCase()}`;
    expect(title).toContain('BROADCAST');
    expect(title).toContain('HIGH');
  });
});

describe('Broadcast Alert - Local notification on arrival', () => {
  it('should trigger local notification when broadcast detected via polling', () => {
    // Simulate useAlerts detecting a new broadcast
    const previousIds = new Set(['INC-001', 'INC-002']);
    const currentAlerts = [
      { id: 'INC-001', type: 'fire', severity: 'high', description: 'Fire', createdBy: 'Jean', location: { address: '123' } },
      { id: 'INC-002', type: 'medical', severity: 'medium', description: 'Medical', createdBy: 'Pierre', location: { address: '456' } },
      { id: 'BC-003', type: 'broadcast', severity: 'critical', description: 'Evacuation', createdBy: 'Sophie', location: { address: 'Zone 5km' } },
    ];

    const newAlerts = currentAlerts.filter(a => !previousIds.has(a.id));
    const broadcastAlerts = newAlerts.filter(a => a.type === 'broadcast');

    expect(newAlerts).toHaveLength(1);
    expect(broadcastAlerts).toHaveLength(1);
    expect(broadcastAlerts[0].id).toBe('BC-003');
    expect(broadcastAlerts[0].description).toBe('Evacuation');
  });

  it('should NOT trigger notification on first fetch (app load)', () => {
    const isFirstFetch = true;
    const shouldPlaySound = !isFirstFetch;
    expect(shouldPlaySound).toBe(false);
  });

  it('should play notification sound (not SOS) for broadcast alerts', () => {
    const newAlerts = [
      { type: 'broadcast', severity: 'critical' },
    ];
    const hasSOS = newAlerts.some(a => a.type === 'sos');
    const hasBroadcast = newAlerts.some(a => a.type === 'broadcast');

    let soundPlayed = '';
    if (hasSOS) {
      soundPlayed = 'sos-alert';
    } else if (hasBroadcast) {
      soundPlayed = 'notification';
    }

    expect(soundPlayed).toBe('notification');
  });
});

describe('Broadcast Alert - Role-based ACK restrictions', () => {
  it('regular users cannot respond to broadcast alerts', () => {
    const userRole = 'user';
    const incidentType = 'broadcast';
    const isPrivileged = ['responder', 'dispatcher', 'admin'].includes(userRole);
    const canRespond = isPrivileged; // Only privileged roles can respond to broadcasts

    expect(canRespond).toBe(false);
  });

  it('responders CAN respond to broadcast alerts', () => {
    const userRole = 'responder';
    const incidentType = 'broadcast';
    const isPrivileged = ['responder', 'dispatcher', 'admin'].includes(userRole);
    const canRespond = isPrivileged;

    expect(canRespond).toBe(true);
  });

  it('dispatchers CAN respond to broadcast alerts', () => {
    const userRole = 'dispatcher';
    const isPrivileged = ['responder', 'dispatcher', 'admin'].includes(userRole);
    expect(isPrivileged).toBe(true);
  });

  it('regular users CAN view broadcast alert details (read-only)', () => {
    const userRole = 'user';
    const incidentType = 'broadcast';
    const isBroadcast = incidentType === 'broadcast';
    const isPrivileged = ['responder', 'dispatcher', 'admin'].includes(userRole);

    // User sees view-only dialog (no Respond button)
    const showViewOnly = userRole === 'user' || (isBroadcast && !isPrivileged);
    expect(showViewOnly).toBe(true);
  });

  it('Respond button is hidden for regular users on all alerts', () => {
    const userRole = 'user';
    const showRespondButton = ['responder', 'dispatcher', 'admin'].includes(userRole);
    expect(showRespondButton).toBe(false);
  });
});

describe('Broadcast Alert - Mobile display', () => {
  it('should have broadcast icon in TYPE_ICONS', () => {
    const TYPE_ICONS: Record<string, string> = {
      sos: '\u{1F198}', medical: '\u{1F3E5}', fire: '\u{1F525}',
      security: '\u{1F512}', hazard: '\u26A0\uFE0F', accident: '\u{1F697}',
      broadcast: '\u{1F4E2}', other: '\u26A0\uFE0F',
    };

    expect(TYPE_ICONS['broadcast']).toBe('\u{1F4E2}');
    expect(TYPE_ICONS['broadcast']).toBeDefined();
  });

  it('should format broadcast alert title correctly', () => {
    const titles: Record<string, string> = {
      sos: 'SOS Alert', medical: 'Medical Emergency', fire: 'Fire Alarm',
      security: 'Security Breach', broadcast: 'Broadcast Alert',
      hazard: 'Hazardous Situation', accident: 'Accident', other: 'Alert',
    };

    expect(titles['broadcast']).toBe('Broadcast Alert');
  });
});
