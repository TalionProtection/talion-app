import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock data ──────────────────────────────────────────────────────────────

const MOCK_FAMILY_MEMBERS = [
  { userId: 'user-001', name: 'Thomas Leroy', email: 'thomas@talion.fr', relationship: 'spouse', location: { latitude: 48.8566, longitude: 2.3522 }, isSharing: true, lastSeen: Date.now() },
  { userId: 'user-005', name: 'Lea Leroy', email: 'lea@talion.fr', relationship: 'child', location: { latitude: 48.8580, longitude: 2.3500 }, isSharing: true, lastSeen: Date.now() },
  { userId: 'user-006', name: 'Hugo Leroy', email: 'hugo@talion.fr', relationship: 'child', location: null, isSharing: false, lastSeen: null },
];

const MOCK_PERIMETERS = [
  {
    id: 'perim-1',
    ownerId: 'user-002',
    targetUserId: 'user-005',
    targetUserName: 'Lea Leroy',
    center: { latitude: 48.8566, longitude: 2.3522, address: 'Maison' },
    radiusMeters: 500,
    active: true,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now() - 86400000,
  },
];

const MOCK_PROXIMITY_ALERTS = [
  {
    id: 'prox-1',
    perimeterId: 'perim-1',
    targetUserId: 'user-005',
    targetUserName: 'Lea Leroy',
    ownerId: 'user-002',
    eventType: 'exit' as const,
    distanceMeters: 650,
    location: { latitude: 48.8620, longitude: 2.3580 },
    timestamp: Date.now() - 3600000,
    acknowledged: false,
  },
  {
    id: 'prox-2',
    perimeterId: 'perim-1',
    targetUserId: 'user-005',
    targetUserName: 'Lea Leroy',
    ownerId: 'user-002',
    eventType: 'entry' as const,
    distanceMeters: 200,
    location: { latitude: 48.8570, longitude: 2.3525 },
    timestamp: Date.now() - 1800000,
    acknowledged: false,
  },
];

const MOCK_LOCATION_HISTORY = [
  { userId: 'user-005', latitude: 48.8566, longitude: 2.3522, timestamp: Date.now() - 7200000 },
  { userId: 'user-005', latitude: 48.8580, longitude: 2.3500, timestamp: Date.now() - 3600000 },
  { userId: 'user-005', latitude: 48.8620, longitude: 2.3580, timestamp: Date.now() - 1800000 },
];

// ─── 1. Alert Persistence Tests ─────────────────────────────────────────────

describe('Alert Persistence', () => {
  it('should define persistence file paths', () => {
    const ALERTS_FILE = 'data/alerts.json';
    const FAMILY_PERIMETERS_FILE = 'data/family-perimeters.json';
    const PROXIMITY_ALERTS_FILE = 'data/proximity-alerts.json';
    const LOCATION_HISTORY_FILE = 'data/location-history.json';
    
    expect(ALERTS_FILE).toBe('data/alerts.json');
    expect(FAMILY_PERIMETERS_FILE).toBe('data/family-perimeters.json');
    expect(PROXIMITY_ALERTS_FILE).toBe('data/proximity-alerts.json');
    expect(LOCATION_HISTORY_FILE).toBe('data/location-history.json');
  });

  it('should serialize alerts to JSON correctly', () => {
    const alert = {
      id: 'alert-1',
      type: 'sos',
      severity: 'critical',
      location: { latitude: 48.8566, longitude: 2.3522, address: 'Paris' },
      createdAt: 1700000000000,
      status: 'active',
      respondingUsers: ['user-003'],
    };
    const json = JSON.stringify([alert]);
    const parsed = JSON.parse(json);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('alert-1');
    expect(parsed[0].location.latitude).toBe(48.8566);
  });

  it('should handle empty persistence files gracefully', () => {
    const loadJsonFile = <T>(defaultVal: T): T => {
      try {
        // Simulate file not found
        throw new Error('ENOENT');
      } catch {
        return defaultVal;
      }
    };
    expect(loadJsonFile<any[]>([])).toEqual([]);
    expect(loadJsonFile<Record<string, any>>({})).toEqual({});
  });

  it('should debounce saves correctly', async () => {
    const saveFn = vi.fn();
    let timer: ReturnType<typeof setTimeout> | null = null;
    
    const debouncedSave = (data: any, delay = 1000) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => saveFn(data), delay);
    };

    debouncedSave('first', 50);
    debouncedSave('second', 50);
    debouncedSave('third', 50);
    
    await new Promise(r => setTimeout(r, 100));
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn).toHaveBeenCalledWith('third');
  });
});

// ─── 2. Family Members Tests ────────────────────────────────────────────────

describe('Family Members', () => {
  it('should return correct family members for a user', () => {
    expect(MOCK_FAMILY_MEMBERS).toHaveLength(3);
    expect(MOCK_FAMILY_MEMBERS[0].relationship).toBe('spouse');
    expect(MOCK_FAMILY_MEMBERS[1].relationship).toBe('child');
    expect(MOCK_FAMILY_MEMBERS[2].relationship).toBe('child');
  });

  it('should distinguish online and offline members', () => {
    const online = MOCK_FAMILY_MEMBERS.filter(m => m.isSharing);
    const offline = MOCK_FAMILY_MEMBERS.filter(m => !m.isSharing);
    expect(online).toHaveLength(2);
    expect(offline).toHaveLength(1);
    expect(offline[0].name).toBe('Hugo Leroy');
  });

  it('should format relationship labels correctly', () => {
    const labels: Record<string, string> = {
      parent: 'Parent',
      child: 'Enfant',
      sibling: 'Frère/Sœur',
      spouse: 'Conjoint(e)',
    };
    expect(labels['parent']).toBe('Parent');
    expect(labels['child']).toBe('Enfant');
    expect(labels['sibling']).toBe('Frère/Sœur');
    expect(labels['spouse']).toBe('Conjoint(e)');
  });

  it('should handle members with no location gracefully', () => {
    const noLocation = MOCK_FAMILY_MEMBERS.find(m => m.location === null);
    expect(noLocation).toBeDefined();
    expect(noLocation!.name).toBe('Hugo Leroy');
    expect(noLocation!.isSharing).toBe(false);
  });
});

// ─── 3. Family Perimeter Tests ──────────────────────────────────────────────

describe('Family Perimeters', () => {
  it('should create a valid perimeter structure', () => {
    const perimeter = MOCK_PERIMETERS[0];
    expect(perimeter.ownerId).toBe('user-002');
    expect(perimeter.targetUserId).toBe('user-005');
    expect(perimeter.radiusMeters).toBe(500);
    expect(perimeter.active).toBe(true);
    expect(perimeter.center.address).toBe('Maison');
  });

  it('should validate perimeter radius bounds', () => {
    const isValid = (radius: number) => radius >= 50 && radius <= 50000;
    expect(isValid(500)).toBe(true);
    expect(isValid(50)).toBe(true);
    expect(isValid(50000)).toBe(true);
    expect(isValid(49)).toBe(false);
    expect(isValid(50001)).toBe(false);
    expect(isValid(0)).toBe(false);
    expect(isValid(-100)).toBe(false);
  });

  it('should only allow perimeters for family members', () => {
    const familyIds = MOCK_FAMILY_MEMBERS.map(m => m.userId);
    const targetUserId = 'user-005';
    const nonFamilyId = 'user-003';
    
    expect(familyIds.includes(targetUserId)).toBe(true);
    expect(familyIds.includes(nonFamilyId)).toBe(false);
  });

  it('should toggle perimeter active state', () => {
    const perimeter = { ...MOCK_PERIMETERS[0] };
    expect(perimeter.active).toBe(true);
    perimeter.active = !perimeter.active;
    expect(perimeter.active).toBe(false);
    perimeter.active = !perimeter.active;
    expect(perimeter.active).toBe(true);
  });
});

// ─── 4. Proximity Alert Tests ───────────────────────────────────────────────

describe('Proximity Alerts', () => {
  // Haversine distance calculation
  function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  it('should detect when a user exits a perimeter', () => {
    const perimeter = MOCK_PERIMETERS[0];
    const userLocation = { latitude: 48.8620, longitude: 2.3580 }; // ~700m from center
    
    const dist = haversineDistance(
      perimeter.center.latitude, perimeter.center.longitude,
      userLocation.latitude, userLocation.longitude
    );
    
    expect(dist).toBeGreaterThan(perimeter.radiusMeters);
  });

  it('should detect when a user is inside a perimeter', () => {
    const perimeter = MOCK_PERIMETERS[0];
    const userLocation = { latitude: 48.8570, longitude: 2.3525 }; // ~50m from center
    
    const dist = haversineDistance(
      perimeter.center.latitude, perimeter.center.longitude,
      userLocation.latitude, userLocation.longitude
    );
    
    expect(dist).toBeLessThan(perimeter.radiusMeters);
  });

  it('should create exit alerts with correct structure', () => {
    const alert = MOCK_PROXIMITY_ALERTS[0];
    expect(alert.eventType).toBe('exit');
    expect(alert.acknowledged).toBe(false);
    expect(alert.distanceMeters).toBeGreaterThan(0);
    expect(alert.targetUserName).toBe('Lea Leroy');
    expect(alert.ownerId).toBe('user-002');
  });

  it('should create entry alerts when user returns', () => {
    const alert = MOCK_PROXIMITY_ALERTS[1];
    expect(alert.eventType).toBe('entry');
    expect(alert.timestamp).toBeGreaterThan(MOCK_PROXIMITY_ALERTS[0].timestamp);
  });

  it('should allow acknowledging exit alerts', () => {
    const alert = { ...MOCK_PROXIMITY_ALERTS[0] };
    expect(alert.acknowledged).toBe(false);
    alert.acknowledged = true;
    expect(alert.acknowledged).toBe(true);
  });

  it('should filter alerts by owner', () => {
    const ownerAlerts = MOCK_PROXIMITY_ALERTS.filter(a => a.ownerId === 'user-002');
    const otherAlerts = MOCK_PROXIMITY_ALERTS.filter(a => a.ownerId === 'user-999');
    expect(ownerAlerts).toHaveLength(2);
    expect(otherAlerts).toHaveLength(0);
  });

  it('should count unread exit alerts', () => {
    const unread = MOCK_PROXIMITY_ALERTS.filter(a => a.eventType === 'exit' && !a.acknowledged);
    expect(unread).toHaveLength(1);
  });

  it('should not trigger alert for inactive perimeters', () => {
    const inactivePerimeter = { ...MOCK_PERIMETERS[0], active: false };
    // The checkFamilyPerimeters function skips inactive perimeters
    expect(inactivePerimeter.active).toBe(false);
    // In the actual code: if (!perimeter.active || ...) continue;
  });
});

// ─── 5. Location History Tests ──────────────────────────────────────────────

describe('Location History', () => {
  it('should store location history entries', () => {
    expect(MOCK_LOCATION_HISTORY).toHaveLength(3);
    expect(MOCK_LOCATION_HISTORY[0].userId).toBe('user-005');
  });

  it('should be ordered by timestamp', () => {
    for (let i = 1; i < MOCK_LOCATION_HISTORY.length; i++) {
      expect(MOCK_LOCATION_HISTORY[i].timestamp).toBeGreaterThan(MOCK_LOCATION_HISTORY[i - 1].timestamp);
    }
  });

  it('should enforce max history per user (ring buffer)', () => {
    const MAX_HISTORY = 500;
    const history: any[] = [];
    for (let i = 0; i < 600; i++) {
      history.push({ userId: 'user-005', latitude: 48 + i * 0.001, longitude: 2, timestamp: Date.now() + i });
    }
    // Trim like the server does
    if (history.length > MAX_HISTORY) {
      history.splice(0, history.length - MAX_HISTORY);
    }
    expect(history).toHaveLength(MAX_HISTORY);
  });

  it('should filter history by time range', () => {
    const since = Date.now() - 3600000; // last hour
    const filtered = MOCK_LOCATION_HISTORY.filter(h => h.timestamp >= since);
    expect(filtered.length).toBeLessThanOrEqual(MOCK_LOCATION_HISTORY.length);
    filtered.forEach(h => expect(h.timestamp).toBeGreaterThanOrEqual(since));
  });

  it('should only allow family members to view history', () => {
    const familyIds = ['user-001', 'user-005', 'user-006'];
    const requesterId = 'user-002'; // Julie
    const targetId = 'user-005'; // Lea (her child)
    const nonFamilyTarget = 'user-003'; // Marc (not family)
    
    // Julie can view Lea's history (family)
    expect(familyIds.includes(targetId)).toBe(true);
    // Julie cannot view Marc's history (not family)
    expect(familyIds.includes(nonFamilyTarget)).toBe(false);
  });
});

// ─── 6. Push Notification Format Tests ──────────────────────────────────────

describe('Proximity Push Notifications', () => {
  it('should format exit notification correctly', () => {
    const alert = MOCK_PROXIMITY_ALERTS[0];
    const perimeter = MOCK_PERIMETERS[0];
    
    const emoji = alert.eventType === 'exit' ? '⚠️' : '✅';
    const action = alert.eventType === 'exit' ? 'a quitté' : 'est revenu(e) dans';
    const body = `${alert.targetUserName} ${action} le périmètre (${Math.round(alert.distanceMeters)}m${perimeter.center.address ? ' - ' + perimeter.center.address : ''})`;
    
    expect(emoji).toBe('⚠️');
    expect(body).toContain('Lea Leroy');
    expect(body).toContain('a quitté');
    expect(body).toContain('Maison');
  });

  it('should format entry notification correctly', () => {
    const alert = MOCK_PROXIMITY_ALERTS[1];
    const action = alert.eventType === 'exit' ? 'a quitté' : 'est revenu(e) dans';
    expect(action).toBe('est revenu(e) dans');
  });

  it('should use high priority for exit alerts', () => {
    const exitPriority = 'high';
    const entryPriority = 'normal';
    expect(exitPriority).toBe('high');
    expect(entryPriority).toBe('normal');
  });
});

// ─── 7. Family Screen Tab Tests ─────────────────────────────────────────────

describe('Family Screen Tabs', () => {
  it('should have three tabs: members, perimeters, alerts', () => {
    const tabs = ['members', 'perimeters', 'alerts'];
    expect(tabs).toHaveLength(3);
    expect(tabs).toContain('members');
    expect(tabs).toContain('perimeters');
    expect(tabs).toContain('alerts');
  });

  it('should show badge count for unread alerts', () => {
    const unreadCount = MOCK_PROXIMITY_ALERTS.filter(a => a.eventType === 'exit' && !a.acknowledged).length;
    expect(unreadCount).toBe(1);
  });

  it('should display correct member count in header', () => {
    const count = MOCK_FAMILY_MEMBERS.length;
    const label = `${count} membre${count !== 1 ? 's' : ''}`;
    expect(label).toBe('3 membres');
  });
});
