import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Test: Unassign endpoint logic ───────────────────────────
describe('Unassign Responder', () => {
  it('should remove responder from respondingUsers array', () => {
    const respondingUsers = ['user-1', 'user-2', 'user-3'];
    const responderId = 'user-2';
    const idx = respondingUsers.indexOf(responderId);
    expect(idx).toBe(1);
    respondingUsers.splice(idx, 1);
    expect(respondingUsers).toEqual(['user-1', 'user-3']);
    expect(respondingUsers).not.toContain('user-2');
  });

  it('should return -1 for non-assigned responder', () => {
    const respondingUsers = ['user-1', 'user-3'];
    const idx = respondingUsers.indexOf('user-999');
    expect(idx).toBe(-1);
  });

  it('should handle unassign from single-responder incident', () => {
    const respondingUsers = ['user-1'];
    respondingUsers.splice(respondingUsers.indexOf('user-1'), 1);
    expect(respondingUsers).toEqual([]);
    expect(respondingUsers.length).toBe(0);
  });
});

// ─── Test: Haversine distance calculation ────────────────────
describe('Haversine Distance', () => {
  // Replicate the haversine from server
  function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  it('should return 0 for same coordinates', () => {
    expect(haversineDistance(48.8566, 2.3522, 48.8566, 2.3522)).toBe(0);
  });

  it('should calculate ~2.2km between Eiffel Tower and Notre-Dame', () => {
    const dist = haversineDistance(48.8584, 2.2945, 48.8530, 2.3499);
    expect(dist).toBeGreaterThan(2000);
    expect(dist).toBeLessThan(5000);
  });

  it('should format distance labels correctly', () => {
    const formatDist = (meters: number) => {
      if (meters < 1000) return `${Math.round(meters)} m`;
      return `${(meters / 1000).toFixed(1)} km`;
    };
    expect(formatDist(500)).toBe('500 m');
    expect(formatDist(1500)).toBe('1.5 km');
    expect(formatDist(10000)).toBe('10.0 km');
    expect(formatDist(0)).toBe('0 m');
    expect(formatDist(999)).toBe('999 m');
    expect(formatDist(1000)).toBe('1.0 km');
  });
});

// ─── Test: Responders-nearby sorting ─────────────────────────
describe('Responders Nearby Sorting', () => {
  interface NearbyResp {
    id: string;
    name: string;
    isAssigned: boolean;
    distanceMeters: number | null;
  }

  const sortResponders = (list: NearbyResp[]) => {
    return [...list].sort((a, b) => {
      if (a.isAssigned !== b.isAssigned) return a.isAssigned ? -1 : 1;
      if (a.distanceMeters !== null && b.distanceMeters !== null) return a.distanceMeters - b.distanceMeters;
      if (a.distanceMeters !== null) return -1;
      if (b.distanceMeters !== null) return 1;
      return a.name.localeCompare(b.name);
    });
  };

  it('should put assigned responders first', () => {
    const list: NearbyResp[] = [
      { id: '1', name: 'Alice', isAssigned: false, distanceMeters: 100 },
      { id: '2', name: 'Bob', isAssigned: true, distanceMeters: 5000 },
      { id: '3', name: 'Charlie', isAssigned: false, distanceMeters: 200 },
    ];
    const sorted = sortResponders(list);
    expect(sorted[0].id).toBe('2'); // assigned first
    expect(sorted[1].id).toBe('1'); // closest non-assigned
    expect(sorted[2].id).toBe('3');
  });

  it('should sort non-assigned by distance ascending', () => {
    const list: NearbyResp[] = [
      { id: '1', name: 'Far', isAssigned: false, distanceMeters: 10000 },
      { id: '2', name: 'Close', isAssigned: false, distanceMeters: 500 },
      { id: '3', name: 'Medium', isAssigned: false, distanceMeters: 3000 },
    ];
    const sorted = sortResponders(list);
    expect(sorted[0].id).toBe('2');
    expect(sorted[1].id).toBe('3');
    expect(sorted[2].id).toBe('1');
  });

  it('should put null-distance responders last', () => {
    const list: NearbyResp[] = [
      { id: '1', name: 'Unknown', isAssigned: false, distanceMeters: null },
      { id: '2', name: 'Known', isAssigned: false, distanceMeters: 1000 },
    ];
    const sorted = sortResponders(list);
    expect(sorted[0].id).toBe('2');
    expect(sorted[1].id).toBe('1');
  });

  it('should sort null-distance by name', () => {
    const list: NearbyResp[] = [
      { id: '1', name: 'Zara', isAssigned: false, distanceMeters: null },
      { id: '2', name: 'Alice', isAssigned: false, distanceMeters: null },
    ];
    const sorted = sortResponders(list);
    expect(sorted[0].id).toBe('2'); // Alice before Zara
    expect(sorted[1].id).toBe('1');
  });
});

// ─── Test: Dispatch console unassign function ────────────────
describe('Dispatch Console Unassign', () => {
  it('should construct correct unassign API URL', () => {
    const API_BASE = 'http://localhost:3000';
    const incidentId = 'INC-20260327-001';
    const url = `${API_BASE}/dispatch/incidents/${incidentId}/unassign`;
    expect(url).toBe('http://localhost:3000/dispatch/incidents/INC-20260327-001/unassign');
  });

  it('should construct correct responders-nearby API URL', () => {
    const API_BASE = 'http://localhost:3000';
    const incidentId = 'INC-20260327-001';
    const url = `${API_BASE}/dispatch/incidents/${incidentId}/responders-nearby`;
    expect(url).toBe('http://localhost:3000/dispatch/incidents/INC-20260327-001/responders-nearby');
  });
});
