import { describe, it, expect } from 'vitest';

/**
 * Test the responder incident filter logic that is used in the Home screen.
 * This tests the pure filtering function extracted from the useMemo in index.tsx.
 */

interface Incident {
  id: string;
  title: string;
  type: string;
  severity: string;
  latitude: number;
  longitude: number;
  address: string;
  description: string;
  timestamp: number;
  reportedBy: string;
  status: 'active' | 'acknowledged' | 'resolved';
  assignedResponders: string[];
  respondingNames?: string[];
}

function filterIncidents(
  incidents: Incident[],
  filter: 'all' | 'assigned',
  userId?: string,
  userName?: string
): Incident[] {
  let filtered = incidents.filter((inc) => inc.status !== 'resolved');

  if (filter === 'assigned' && userId) {
    filtered = filtered.filter((inc) =>
      inc.assignedResponders.includes(userId) ||
      (inc.respondingNames && inc.respondingNames.includes(userName || ''))
    );
  }

  return filtered;
}

const mockIncidents: Incident[] = [
  {
    id: 'inc-1',
    title: 'Fire',
    type: 'fire',
    severity: 'high',
    latitude: 48.85,
    longitude: 2.35,
    address: '123 Rue de Paris',
    description: 'Fire in building',
    timestamp: Date.now() - 60000,
    reportedBy: 'user-1',
    status: 'active',
    assignedResponders: ['responder-1', 'responder-2'],
    respondingNames: ['Jean Dupont', 'Marie Martin'],
  },
  {
    id: 'inc-2',
    title: 'Medical',
    type: 'medical',
    severity: 'medium',
    latitude: 48.86,
    longitude: 2.36,
    address: '456 Avenue de Lyon',
    description: 'Medical emergency',
    timestamp: Date.now() - 120000,
    reportedBy: 'user-2',
    status: 'active',
    assignedResponders: ['responder-3'],
    respondingNames: ['Pierre Durand'],
  },
  {
    id: 'inc-3',
    title: 'Security',
    type: 'security',
    severity: 'low',
    latitude: 48.87,
    longitude: 2.37,
    address: '789 Boulevard de Nice',
    description: 'Security alert',
    timestamp: Date.now() - 180000,
    reportedBy: 'user-3',
    status: 'active',
    assignedResponders: ['responder-1'],
    respondingNames: ['Jean Dupont'],
  },
  {
    id: 'inc-4',
    title: 'Resolved',
    type: 'other',
    severity: 'low',
    latitude: 48.88,
    longitude: 2.38,
    address: '101 Rue Resolved',
    description: 'Already resolved',
    timestamp: Date.now() - 300000,
    reportedBy: 'user-4',
    status: 'resolved',
    assignedResponders: ['responder-1'],
    respondingNames: ['Jean Dupont'],
  },
  {
    id: 'inc-5',
    title: 'Unassigned',
    type: 'hazard',
    severity: 'critical',
    latitude: 48.89,
    longitude: 2.39,
    address: '202 Rue Unassigned',
    description: 'No one assigned',
    timestamp: Date.now() - 30000,
    reportedBy: 'user-5',
    status: 'active',
    assignedResponders: [],
    respondingNames: [],
  },
];

describe('Responder Incident Filter', () => {
  it('filter "all" shows all non-resolved incidents', () => {
    const result = filterIncidents(mockIncidents, 'all', 'responder-1', 'Jean Dupont');
    expect(result.length).toBe(4); // inc-1, inc-2, inc-3, inc-5 (not inc-4 which is resolved)
    expect(result.find(i => i.id === 'inc-4')).toBeUndefined();
  });

  it('filter "assigned" shows only incidents assigned to the responder by ID', () => {
    const result = filterIncidents(mockIncidents, 'assigned', 'responder-1', 'Jean Dupont');
    expect(result.length).toBe(2); // inc-1 and inc-3
    expect(result.map(i => i.id)).toContain('inc-1');
    expect(result.map(i => i.id)).toContain('inc-3');
    expect(result.map(i => i.id)).not.toContain('inc-2');
    expect(result.map(i => i.id)).not.toContain('inc-5');
  });

  it('filter "assigned" excludes resolved incidents even if assigned', () => {
    const result = filterIncidents(mockIncidents, 'assigned', 'responder-1', 'Jean Dupont');
    expect(result.find(i => i.id === 'inc-4')).toBeUndefined();
  });

  it('filter "assigned" for a responder with no assignments returns empty', () => {
    const result = filterIncidents(mockIncidents, 'assigned', 'responder-99', 'Nobody');
    expect(result.length).toBe(0);
  });

  it('filter "assigned" matches by respondingNames as fallback', () => {
    // Simulate a case where userId doesn't match but name does
    const result = filterIncidents(mockIncidents, 'assigned', 'unknown-id', 'Pierre Durand');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('inc-2');
  });

  it('filter "assigned" with no userId returns all non-resolved (no filter applied)', () => {
    const result = filterIncidents(mockIncidents, 'assigned', undefined, undefined);
    // When userId is undefined, the filter condition is skipped
    expect(result.length).toBe(4);
  });

  it('filter "all" does not filter by assignment', () => {
    const result = filterIncidents(mockIncidents, 'all', 'responder-3', 'Pierre Durand');
    expect(result.length).toBe(4); // All non-resolved
    expect(result.map(i => i.id)).toContain('inc-5'); // Unassigned incident is included
  });

  it('filter "assigned" for responder-2 shows only inc-1', () => {
    const result = filterIncidents(mockIncidents, 'assigned', 'responder-2', 'Marie Martin');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('inc-1');
  });

  it('filter "assigned" for responder-3 shows only inc-2', () => {
    const result = filterIncidents(mockIncidents, 'assigned', 'responder-3', 'Pierre Durand');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe('inc-2');
  });
});
