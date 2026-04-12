import { describe, it, expect, beforeAll } from 'vitest';

const BASE = 'http://127.0.0.1:3000';

// Helper to create a user
async function createUser(data: Record<string, any>) {
  const res = await fetch(`${BASE}/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res;
}

// Helper to delete a user
async function deleteUser(id: string) {
  return fetch(`${BASE}/admin/users/${id}`, { method: 'DELETE' });
}

describe('Admin Photo Upload', () => {
  let userId: string;

  beforeAll(async () => {
    const res = await createUser({
      firstName: 'Photo',
      lastName: 'TestUser',
      email: `photo-test-${Date.now()}@test.com`,
      password: 'test123',
      role: 'user',
    });
    const data = await res.json();
    userId = data.id;
  });

  it('should have photo upload endpoint', async () => {
    // Test without file - should return 400
    const res = await fetch(`${BASE}/admin/users/${userId}/photo`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(res.status).toBe(400);
  });

  it('should return 404 for non-existent user photo upload', async () => {
    const res = await fetch(`${BASE}/admin/users/non-existent-id/photo`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(res.status).toBe(404);
  });

  it('should include photoUrl in user data', async () => {
    const res = await fetch(`${BASE}/admin/users/${userId}`);
    const data = await res.json();
    expect(data).toHaveProperty('photoUrl');
  });
});

describe('Admin User Relationships', () => {
  let user1Id: string;
  let user2Id: string;

  beforeAll(async () => {
    const res1 = await createUser({
      firstName: 'Parent',
      lastName: 'User',
      email: `parent-${Date.now()}@test.com`,
      password: 'test123',
      role: 'user',
    });
    const data1 = await res1.json();
    user1Id = data1.id;

    const res2 = await createUser({
      firstName: 'Child',
      lastName: 'User',
      email: `child-${Date.now()}@test.com`,
      password: 'test123',
      role: 'user',
    });
    const data2 = await res2.json();
    user2Id = data2.id;
  });

  it('should create user with relationships', async () => {
    const res = await createUser({
      firstName: 'Spouse',
      lastName: 'User',
      email: `spouse-${Date.now()}@test.com`,
      password: 'test123',
      role: 'user',
      relationships: [{ userId: user1Id, type: 'spouse' }],
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.relationships).toBeDefined();
    expect(data.relationships.length).toBeGreaterThanOrEqual(1);
    expect(data.relationships[0].userId).toBe(user1Id);
    expect(data.relationships[0].type).toBe('spouse');
  });

  it('should create reciprocal relationship', async () => {
    const res = await createUser({
      firstName: 'ChildOf',
      lastName: 'User',
      email: `childof-${Date.now()}@test.com`,
      password: 'test123',
      role: 'user',
      relationships: [{ userId: user2Id, type: 'parent' }],
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.relationships[0].type).toBe('parent');

    // Check reciprocal: user2 should now have a 'child' relationship
    const res2 = await fetch(`${BASE}/admin/users/${user2Id}`);
    const user2Data = await res2.json();
    const reciprocal = user2Data.relationships?.find((r: any) => r.type === 'child');
    expect(reciprocal).toBeDefined();
  });

  it('should update user with new relationships', async () => {
    const res = await fetch(`${BASE}/admin/users/${user1Id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        relationships: [{ userId: user2Id, type: 'parent' }],
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.relationships).toBeDefined();
  });

  it('should list users with relationship data', async () => {
    const res = await fetch(`${BASE}/admin/users`);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    const userWithRels = data.find((u: any) => u.id === user1Id);
    expect(userWithRels).toBeDefined();
    expect(userWithRels.relationships).toBeDefined();
  });
});

describe('Geofence CRUD', () => {
  let zoneId: string;

  it('should create a geofence zone', async () => {
    const res = await fetch(`${BASE}/dispatch/geofence/zones`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        center: { latitude: 48.8566, longitude: 2.3522 },
        radiusKm: 1.5,
        severity: 'high',
        message: 'Test geofence zone from mobile',
        createdBy: 'Test User',
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.zone).toBeDefined();
    expect(data.zone.id).toBeDefined();
    expect(data.zone.radiusKm).toBe(1.5);
    expect(data.zone.severity).toBe('high');
    zoneId = data.zone.id;
  });

  it('should list geofence zones', async () => {
    const res = await fetch(`${BASE}/dispatch/geofence/zones`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    // API may return { success, zones } or a plain array
    const zones = Array.isArray(data) ? data : data.zones;
    expect(Array.isArray(zones)).toBe(true);
    const zone = zones.find((z: any) => z.id === zoneId);
    expect(zone).toBeDefined();
    expect(zone.message).toBe('Test geofence zone from mobile');
  });

  it('should delete a geofence zone', async () => {
    const res = await fetch(`${BASE}/dispatch/geofence/zones/${zoneId}`, {
      method: 'DELETE',
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify it's gone
    const listRes = await fetch(`${BASE}/dispatch/geofence/zones`);
    const listData = await listRes.json();
    const zones = Array.isArray(listData) ? listData : listData.zones;
    const deleted = zones.find((z: any) => z.id === zoneId);
    expect(deleted).toBeUndefined();
  });

  it('should handle geofence events endpoint', async () => {
    const res = await fetch(`${BASE}/dispatch/geofence/events`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    // API may return { success, events } or a plain array
    const events = Array.isArray(data) ? data : data.events;
    expect(Array.isArray(events)).toBe(true);
  });
});

describe('Admin User CRUD with all fields', () => {
  it('should create user with full profile (tags, comments, phones, address)', async () => {
    const res = await createUser({
      firstName: 'Full',
      lastName: 'Profile',
      email: `full-${Date.now()}@test.com`,
      password: 'test123',
      role: 'responder',
      tags: ['zone-nord', 'equipe-alpha'],
      phoneMobile: '+33 6 12 34 56 78',
      phoneLandline: '+33 1 23 45 67 89',
      address: '123 Rue de Paris, 75001 Paris',
      comments: 'Test user with full profile',
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.firstName).toBe('Full');
    expect(data.lastName).toBe('Profile');
    expect(data.tags).toEqual(['zone-nord', 'equipe-alpha']);
    expect(data.phoneMobile).toBe('+33 6 12 34 56 78');
    expect(data.phoneLandline).toBe('+33 1 23 45 67 89');
    expect(data.address).toBe('123 Rue de Paris, 75001 Paris');
    expect(data.comments).toBe('Test user with full profile');
  });

  it('should reject duplicate email', async () => {
    const email = `dup-${Date.now()}@test.com`;
    await createUser({ firstName: 'A', lastName: 'B', email, password: 'test', role: 'user' });
    const res = await createUser({ firstName: 'C', lastName: 'D', email, password: 'test', role: 'user' });
    expect(res.status).toBe(409);
  });
});
