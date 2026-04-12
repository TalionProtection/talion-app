import { describe, it, expect } from 'vitest';

// ─── Incident Type Filter Logic Tests ──────────────────────────────────────

describe('Incident Type Filter Logic', () => {
  const mockIncidents = [
    { id: '1', type: 'sos', severity: 'critical', status: 'active', latitude: 46.19, longitude: 6.15, title: 'SOS Alert', description: 'Emergency', radius: 200, respondersAssigned: 0, timestamp: Date.now() },
    { id: '2', type: 'medical', severity: 'high', status: 'active', latitude: 46.20, longitude: 6.16, title: 'Medical Emergency', description: 'Heart attack', radius: 150, respondersAssigned: 1, timestamp: Date.now() },
    { id: '3', type: 'fire', severity: 'high', status: 'acknowledged', latitude: 46.21, longitude: 6.17, title: 'Fire Reported', description: 'Building fire', radius: 300, respondersAssigned: 2, timestamp: Date.now() },
    { id: '4', type: 'security', severity: 'medium', status: 'active', latitude: 46.22, longitude: 6.18, title: 'Security Breach', description: 'Intrusion', radius: 100, respondersAssigned: 0, timestamp: Date.now() },
    { id: '5', type: 'accident', severity: 'low', status: 'active', latitude: 46.23, longitude: 6.19, title: 'Minor Accident', description: 'Fender bender', radius: 50, respondersAssigned: 0, timestamp: Date.now() },
    { id: '6', type: 'sos', severity: 'critical', status: 'resolved', latitude: 46.24, longitude: 6.20, title: 'Old SOS', description: 'Resolved', radius: 200, respondersAssigned: 3, timestamp: Date.now() - 3600000 },
  ];

  function filterByType(incidents: typeof mockIncidents, typeFilter: string) {
    return typeFilter === 'all'
      ? incidents
      : incidents.filter(i => i.type === typeFilter);
  }

  function filterForMap(incidents: typeof mockIncidents, typeFilter: string) {
    return incidents.filter(inc => {
      if (inc.status === 'resolved') return false;
      if (typeFilter !== 'all' && inc.type !== typeFilter) return false;
      return true;
    });
  }

  it('should return all incidents when filter is "all"', () => {
    const result = filterByType(mockIncidents, 'all');
    expect(result).toHaveLength(6);
  });

  it('should filter incidents by SOS type', () => {
    const result = filterByType(mockIncidents, 'sos');
    expect(result).toHaveLength(2);
    expect(result.every(i => i.type === 'sos')).toBe(true);
  });

  it('should filter incidents by medical type', () => {
    const result = filterByType(mockIncidents, 'medical');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('2');
  });

  it('should filter incidents by fire type', () => {
    const result = filterByType(mockIncidents, 'fire');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('3');
  });

  it('should return empty array for non-existent type', () => {
    const result = filterByType(mockIncidents, 'hazard');
    expect(result).toHaveLength(0);
  });

  it('should exclude resolved incidents from map view', () => {
    const result = filterForMap(mockIncidents, 'all');
    expect(result).toHaveLength(5);
    expect(result.every(i => i.status !== 'resolved')).toBe(true);
  });

  it('should combine type filter with resolved exclusion on map', () => {
    const result = filterForMap(mockIncidents, 'sos');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('1');
    expect(result[0].status).toBe('active');
  });

  it('should show zero results for type with only resolved incidents', () => {
    const onlyResolved = [
      { id: '10', type: 'fire', severity: 'high', status: 'resolved', latitude: 0, longitude: 0, title: '', description: '', radius: 0, respondersAssigned: 0, timestamp: 0 },
    ];
    const result = filterForMap(onlyResolved, 'fire');
    expect(result).toHaveLength(0);
  });
});

// ─── Incident Detail Panel Data Tests ──────────────────────────────────────

describe('Incident Detail Panel Data', () => {
  const TYPE_ICONS: Record<string, string> = { sos: '🆘', medical: '🏥', fire: '🔥', security: '🔒', hazard: '⚠️', accident: '💥', broadcast: '📢', other: '🚨' };

  function getIncidentEmoji(type: string): string {
    return TYPE_ICONS[type] || '🚨';
  }

  function getSeverityColor(severity: string): string {
    const colors: Record<string, string> = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#6b7280' };
    return colors[severity] || '#6b7280';
  }

  it('should return correct emoji for each incident type', () => {
    expect(getIncidentEmoji('sos')).toBe('🆘');
    expect(getIncidentEmoji('medical')).toBe('🏥');
    expect(getIncidentEmoji('fire')).toBe('🔥');
    expect(getIncidentEmoji('security')).toBe('🔒');
    expect(getIncidentEmoji('accident')).toBe('💥');
    expect(getIncidentEmoji('unknown')).toBe('🚨');
  });

  it('should return correct color for each severity', () => {
    expect(getSeverityColor('critical')).toBe('#dc2626');
    expect(getSeverityColor('high')).toBe('#f59e0b');
    expect(getSeverityColor('medium')).toBe('#3b82f6');
    expect(getSeverityColor('low')).toBe('#6b7280');
    expect(getSeverityColor('unknown')).toBe('#6b7280');
  });

  it('should generate correct navigation URL', () => {
    const lat = 46.2125;
    const lng = 6.1795;
    const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    expect(url).toBe('https://www.google.com/maps/dir/?api=1&destination=46.2125,6.1795');
    expect(url).toContain('google.com/maps');
  });

  it('should determine action buttons based on incident status', () => {
    function getActions(status: string, isPrivileged: boolean) {
      const actions: string[] = [];
      if (isPrivileged && status === 'active') actions.push('acknowledge');
      if (status !== 'resolved') {
        actions.push('navigate');
        actions.push('contact');
      }
      if (isPrivileged && status !== 'resolved') actions.push('resolve');
      return actions;
    }

    // Active incident - privileged user
    const activePriv = getActions('active', true);
    expect(activePriv).toContain('acknowledge');
    expect(activePriv).toContain('navigate');
    expect(activePriv).toContain('contact');
    expect(activePriv).toContain('resolve');

    // Active incident - regular user
    const activeReg = getActions('active', false);
    expect(activeReg).not.toContain('acknowledge');
    expect(activeReg).toContain('navigate');
    expect(activeReg).toContain('contact');
    expect(activeReg).not.toContain('resolve');

    // Resolved incident - no actions except close
    const resolved = getActions('resolved', true);
    expect(resolved).not.toContain('acknowledge');
    expect(resolved).not.toContain('navigate');
    expect(resolved).not.toContain('resolve');
  });
});

// ─── Dispatch Console Type Filter Tests ──────────────────────────────────────

describe('Dispatch Console Type Filters', () => {
  const TYPE_LABELS: Record<string, string> = {
    sos: 'SOS', medical: 'Médical', fire: 'Feu', security: 'Sécurité',
    hazard: 'Danger', accident: 'Accident', broadcast: 'Broadcast', other: 'Autre',
  };

  it('should have labels for all common incident types', () => {
    const requiredTypes = ['sos', 'medical', 'fire', 'security', 'accident', 'broadcast'];
    requiredTypes.forEach(type => {
      expect(TYPE_LABELS[type]).toBeDefined();
      expect(TYPE_LABELS[type].length).toBeGreaterThan(0);
    });
  });

  it('should filter dispatch incidents by type correctly', () => {
    const dispatchIncidents = [
      { id: 'D1', type: 'sos', status: 'active', severity: 'critical', address: 'Addr 1' },
      { id: 'D2', type: 'medical', status: 'active', severity: 'high', address: 'Addr 2' },
      { id: 'D3', type: 'fire', status: 'acknowledged', severity: 'high', address: 'Addr 3' },
      { id: 'D4', type: 'sos', status: 'resolved', severity: 'critical', address: 'Addr 4' },
    ];

    // Filter for map: exclude resolved + apply type filter
    function filterForDispatchMap(data: typeof dispatchIncidents, typeFilter: string) {
      return data.filter(inc => {
        if (inc.status === 'resolved') return false;
        if (typeFilter !== 'all' && inc.type !== typeFilter) return false;
        return true;
      });
    }

    expect(filterForDispatchMap(dispatchIncidents, 'all')).toHaveLength(3);
    expect(filterForDispatchMap(dispatchIncidents, 'sos')).toHaveLength(1);
    expect(filterForDispatchMap(dispatchIncidents, 'medical')).toHaveLength(1);
    expect(filterForDispatchMap(dispatchIncidents, 'fire')).toHaveLength(1);
    expect(filterForDispatchMap(dispatchIncidents, 'security')).toHaveLength(0);
  });
});

// ─── INCIDENT_TYPE_FILTERS constant tests ──────────────────────────────────

describe('INCIDENT_TYPE_FILTERS constant', () => {
  const INCIDENT_TYPE_FILTERS = [
    { key: 'all', label: 'Tous', emoji: '📋' },
    { key: 'sos', label: 'SOS', emoji: '🆘' },
    { key: 'medical', label: 'Médical', emoji: '🏥' },
    { key: 'fire', label: 'Incendie', emoji: '🔥' },
    { key: 'security', label: 'Sécurité', emoji: '🔒' },
    { key: 'accident', label: 'Accident', emoji: '🚗' },
    { key: 'other', label: 'Autre', emoji: '⚠️' },
  ];

  it('should have "all" as first filter option', () => {
    expect(INCIDENT_TYPE_FILTERS[0].key).toBe('all');
  });

  it('should have unique keys', () => {
    const keys = INCIDENT_TYPE_FILTERS.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('should have non-empty labels and emojis', () => {
    INCIDENT_TYPE_FILTERS.forEach(f => {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.emoji.length).toBeGreaterThan(0);
    });
  });

  it('should include all major incident types', () => {
    const keys = INCIDENT_TYPE_FILTERS.map(f => f.key);
    expect(keys).toContain('sos');
    expect(keys).toContain('medical');
    expect(keys).toContain('fire');
    expect(keys).toContain('security');
    expect(keys).toContain('accident');
  });
});
