import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock types matching the map screen
interface ResponderLocation {
  id: string;
  name: string;
  role: 'responder' | 'dispatcher';
  status: 'available' | 'on_duty' | 'off_duty';
  latitude: number;
  longitude: number;
  lastUpdated: number;
}

interface IncidentZone {
  id: string;
  title: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  latitude: number;
  longitude: number;
  radius: number;
  description: string;
  timestamp: number;
  respondersAssigned: number;
}

// Helper functions from map screen
function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'critical': return '#ef4444';
    case 'high': return '#f97316';
    case 'medium': return '#eab308';
    case 'low': return '#3b82f6';
    default: return '#6b7280';
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'available': return '#22c55e';
    case 'on_duty': return '#f59e0b';
    case 'off_duty': return '#9ca3af';
    default: return '#6b7280';
  }
}

function getIncidentEmoji(type: string): string {
  switch (type) {
    case 'medical': return '🏥';
    case 'fire': return '🔥';
    case 'security': return '🔒';
    case 'accident': return '🚗';
    case 'sos': return '🆘';
    default: return '⚠️';
  }
}

function timeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// Filter logic from map screen
type MapFilter = 'all' | 'alerts' | 'responders';

function filterResponders(responders: ResponderLocation[], filter: MapFilter): ResponderLocation[] {
  return filter === 'alerts' ? [] : responders;
}

function filterIncidents(incidents: IncidentZone[], filter: MapFilter): IncidentZone[] {
  return filter === 'responders' ? [] : incidents;
}

// Location update handler
function handleLocationUpdate(
  responders: ResponderLocation[],
  data: { userId: string; latitude: number; longitude: number; timestamp: number }
): ResponderLocation[] {
  const existing = responders.find((r) => r.id === data.userId);
  if (existing) {
    return responders.map((r) =>
      r.id === data.userId
        ? { ...r, latitude: data.latitude, longitude: data.longitude, lastUpdated: data.timestamp }
        : r
    );
  }
  return responders;
}

// Alert to incident converter
function alertToIncident(alert: {
  id: string;
  type: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  description: string;
  location: { latitude: number; longitude: number };
  createdAt: number;
  respondersAssigned?: string[];
}): IncidentZone {
  return {
    id: alert.id,
    title: `${alert.type.charAt(0).toUpperCase() + alert.type.slice(1)} Alert`,
    type: alert.type,
    severity: alert.priority,
    latitude: alert.location.latitude,
    longitude: alert.location.longitude,
    radius: alert.priority === 'critical' ? 200 : alert.priority === 'high' ? 150 : 100,
    description: alert.description,
    timestamp: alert.createdAt,
    respondersAssigned: alert.respondersAssigned?.length ?? 0,
  };
}

describe('Map Helper Functions', () => {
  describe('getSeverityColor', () => {
    it('returns red for critical severity', () => {
      expect(getSeverityColor('critical')).toBe('#ef4444');
    });

    it('returns orange for high severity', () => {
      expect(getSeverityColor('high')).toBe('#f97316');
    });

    it('returns yellow for medium severity', () => {
      expect(getSeverityColor('medium')).toBe('#eab308');
    });

    it('returns blue for low severity', () => {
      expect(getSeverityColor('low')).toBe('#3b82f6');
    });

    it('returns gray for unknown severity', () => {
      expect(getSeverityColor('unknown')).toBe('#6b7280');
    });
  });

  describe('getStatusColor', () => {
    it('returns green for available', () => {
      expect(getStatusColor('available')).toBe('#22c55e');
    });

    it('returns amber for on_duty', () => {
      expect(getStatusColor('on_duty')).toBe('#f59e0b');
    });

    it('returns gray for off_duty', () => {
      expect(getStatusColor('off_duty')).toBe('#9ca3af');
    });
  });

  describe('getIncidentEmoji', () => {
    it('returns hospital emoji for medical', () => {
      expect(getIncidentEmoji('medical')).toBe('🏥');
    });

    it('returns fire emoji for fire', () => {
      expect(getIncidentEmoji('fire')).toBe('🔥');
    });

    it('returns lock emoji for security', () => {
      expect(getIncidentEmoji('security')).toBe('🔒');
    });

    it('returns car emoji for accident', () => {
      expect(getIncidentEmoji('accident')).toBe('🚗');
    });

    it('returns SOS emoji for sos', () => {
      expect(getIncidentEmoji('sos')).toBe('🆘');
    });

    it('returns warning emoji for unknown type', () => {
      expect(getIncidentEmoji('other')).toBe('⚠️');
    });
  });

  describe('timeAgo', () => {
    it('returns seconds for recent timestamps', () => {
      const result = timeAgo(Date.now() - 30000);
      expect(result).toMatch(/^\d+s ago$/);
    });

    it('returns minutes for timestamps within an hour', () => {
      const result = timeAgo(Date.now() - 300000); // 5 minutes
      expect(result).toMatch(/^\d+m ago$/);
    });

    it('returns hours for older timestamps', () => {
      const result = timeAgo(Date.now() - 7200000); // 2 hours
      expect(result).toMatch(/^\d+h ago$/);
    });
  });
});

describe('Map Filter Logic', () => {
  const mockResponders: ResponderLocation[] = [
    { id: 'r1', name: 'Unit Alpha', role: 'responder', status: 'available', latitude: 48.8566, longitude: 2.3522, lastUpdated: Date.now() },
    { id: 'r2', name: 'Unit Bravo', role: 'responder', status: 'on_duty', latitude: 48.8606, longitude: 2.3376, lastUpdated: Date.now() },
  ];

  const mockIncidents: IncidentZone[] = [
    { id: 'i1', title: 'Medical Emergency', type: 'medical', severity: 'critical', latitude: 48.8588, longitude: 2.3470, radius: 150, description: 'Test', timestamp: Date.now(), respondersAssigned: 2 },
    { id: 'i2', title: 'Fire Alert', type: 'fire', severity: 'high', latitude: 48.8530, longitude: 2.3200, radius: 200, description: 'Test', timestamp: Date.now(), respondersAssigned: 1 },
  ];

  it('shows all items when filter is "all"', () => {
    expect(filterResponders(mockResponders, 'all')).toHaveLength(2);
    expect(filterIncidents(mockIncidents, 'all')).toHaveLength(2);
  });

  it('shows only incidents when filter is "alerts"', () => {
    expect(filterResponders(mockResponders, 'alerts')).toHaveLength(0);
    expect(filterIncidents(mockIncidents, 'alerts')).toHaveLength(2);
  });

  it('shows only responders when filter is "responders"', () => {
    expect(filterResponders(mockResponders, 'responders')).toHaveLength(2);
    expect(filterIncidents(mockIncidents, 'responders')).toHaveLength(0);
  });
});

describe('Location Update Handler', () => {
  const mockResponders: ResponderLocation[] = [
    { id: 'r1', name: 'Unit Alpha', role: 'responder', status: 'available', latitude: 48.8566, longitude: 2.3522, lastUpdated: Date.now() },
    { id: 'r2', name: 'Unit Bravo', role: 'responder', status: 'on_duty', latitude: 48.8606, longitude: 2.3376, lastUpdated: Date.now() },
  ];

  it('updates existing responder location', () => {
    const update = { userId: 'r1', latitude: 48.8600, longitude: 2.3500, timestamp: Date.now() };
    const result = handleLocationUpdate(mockResponders, update);
    expect(result[0].latitude).toBe(48.8600);
    expect(result[0].longitude).toBe(2.3500);
    expect(result[1].latitude).toBe(48.8606); // unchanged
  });

  it('does not add unknown responder', () => {
    const update = { userId: 'unknown', latitude: 48.8600, longitude: 2.3500, timestamp: Date.now() };
    const result = handleLocationUpdate(mockResponders, update);
    expect(result).toHaveLength(2);
    expect(result).toEqual(mockResponders);
  });

  it('preserves other responder properties on update', () => {
    const update = { userId: 'r1', latitude: 48.8600, longitude: 2.3500, timestamp: Date.now() };
    const result = handleLocationUpdate(mockResponders, update);
    expect(result[0].name).toBe('Unit Alpha');
    expect(result[0].role).toBe('responder');
    expect(result[0].status).toBe('available');
  });
});

describe('Alert to Incident Converter', () => {
  it('converts critical alert to incident with 200m radius', () => {
    const alert = {
      id: 'a1',
      type: 'sos',
      priority: 'critical' as const,
      description: 'Emergency SOS',
      location: { latitude: 48.8566, longitude: 2.3522 },
      createdAt: Date.now(),
      respondersAssigned: ['r1', 'r2'],
    };
    const incident = alertToIncident(alert);
    expect(incident.radius).toBe(200);
    expect(incident.severity).toBe('critical');
    expect(incident.title).toBe('Sos Alert');
    expect(incident.respondersAssigned).toBe(2);
  });

  it('converts high alert to incident with 150m radius', () => {
    const alert = {
      id: 'a2',
      type: 'fire',
      priority: 'high' as const,
      description: 'Fire detected',
      location: { latitude: 48.8530, longitude: 2.3200 },
      createdAt: Date.now(),
    };
    const incident = alertToIncident(alert);
    expect(incident.radius).toBe(150);
    expect(incident.severity).toBe('high');
    expect(incident.respondersAssigned).toBe(0);
  });

  it('converts medium alert to incident with 100m radius', () => {
    const alert = {
      id: 'a3',
      type: 'security',
      priority: 'medium' as const,
      description: 'Suspicious activity',
      location: { latitude: 48.8650, longitude: 2.3550 },
      createdAt: Date.now(),
    };
    const incident = alertToIncident(alert);
    expect(incident.radius).toBe(100);
  });

  it('converts low alert to incident with 100m radius', () => {
    const alert = {
      id: 'a4',
      type: 'other',
      priority: 'low' as const,
      description: 'Minor issue',
      location: { latitude: 48.8500, longitude: 2.3400 },
      createdAt: Date.now(),
    };
    const incident = alertToIncident(alert);
    expect(incident.radius).toBe(100);
  });

  it('capitalizes alert type in title', () => {
    const alert = {
      id: 'a5',
      type: 'medical',
      priority: 'critical' as const,
      description: 'Medical emergency',
      location: { latitude: 48.8566, longitude: 2.3522 },
      createdAt: Date.now(),
    };
    const incident = alertToIncident(alert);
    expect(incident.title).toBe('Medical Alert');
  });
});
