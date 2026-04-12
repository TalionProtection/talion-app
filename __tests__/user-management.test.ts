import { describe, it, expect } from 'vitest';

const API = 'http://127.0.0.1:3000';

describe('User Management CRUD', () => {
  let createdUserId: string;

  it('GET /admin/users returns all users', async () => {
    const res = await fetch(`${API}/admin/users`);
    expect(res.status).toBe(200);
    const users = await res.json();
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThanOrEqual(12);
    // Check user has required fields
    const user = users[0];
    expect(user).toHaveProperty('id');
    expect(user).toHaveProperty('name');
    expect(user).toHaveProperty('email');
    expect(user).toHaveProperty('role');
    expect(user).toHaveProperty('status');
    expect(user).toHaveProperty('firstName');
    expect(user).toHaveProperty('lastName');
    expect(user).toHaveProperty('tags');
    // relationships may not be present for users without any
  });

  it('POST /admin/users creates a new user with all fields', async () => {
    const newUser = {
      firstName: 'TestPrenom',
      lastName: 'TestNom',
      email: 'test-crud@example.com',
      role: 'responder',
      status: 'active',
      phoneMobile: '+33 6 11 22 33 44',
      phoneLandline: '+33 1 99 88 77 66',
      address: '1 Place de la Concorde, 75008 Paris',
      tags: ['test-tag', 'zone-test'],
      comments: 'Test user for CRUD validation',
      relationships: [{ userId: 'user-001', type: 'cohabitant' }],
    };
    const res = await fetch(`${API}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('TestPrenom TestNom');
    expect(created.firstName).toBe('TestPrenom');
    expect(created.lastName).toBe('TestNom');
    expect(created.email).toBe('test-crud@example.com');
    expect(created.role).toBe('responder');
    expect(created.phoneMobile).toBe('+33 6 11 22 33 44');
    expect(created.phoneLandline).toBe('+33 1 99 88 77 66');
    expect(created.address).toBe('1 Place de la Concorde, 75008 Paris');
    expect(created.tags).toEqual(['test-tag', 'zone-test']);
    expect(created.comments).toBe('Test user for CRUD validation');
    expect(created.relationships).toHaveLength(1);
    expect(created.relationships[0].userId).toBe('user-001');
    expect(created.relationships[0].type).toBe('cohabitant');
    createdUserId = created.id;
  });

  it('POST /admin/users requires firstName, lastName, email', async () => {
    const res = await fetch(`${API}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'OnlyFirst' }),
    });
    expect(res.status).toBe(400);
    const err = await res.json();
    expect(err.error).toBeTruthy();
  });

  it('PUT /admin/users/:id updates user fields', async () => {
    expect(createdUserId).toBeTruthy();
    const res = await fetch(`${API}/admin/users/${createdUserId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'UpdatedPrenom',
        comments: 'Updated comment',
        tags: ['updated-tag'],
      }),
    });
    expect(res.status).toBe(200);
    const updated = await res.json();
    expect(updated.firstName).toBe('UpdatedPrenom');
    expect(updated.name).toBe('UpdatedPrenom TestNom');
    expect(updated.comments).toBe('Updated comment');
    expect(updated.tags).toEqual(['updated-tag']);
  });

  it('PUT /admin/users/:id returns 404 for unknown user', async () => {
    const res = await fetch(`${API}/admin/users/nonexistent-id`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Ghost' }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /admin/users/:id deletes the user', async () => {
    expect(createdUserId).toBeTruthy();
    const res = await fetch(`${API}/admin/users/${createdUserId}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result.success).toBe(true);
    expect(result.deletedUser).toBe('UpdatedPrenom TestNom');
  });

  it('DELETE /admin/users/:id returns 404 for unknown user', async () => {
    const res = await fetch(`${API}/admin/users/nonexistent-id`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('GET /admin/users reflects deletion', async () => {
    const res = await fetch(`${API}/admin/users`);
    const users = await res.json();
    const found = users.find((u: any) => u.id === createdUserId);
    expect(found).toBeUndefined();
  });

  it('Users have firstName and lastName fields', async () => {
    const res = await fetch(`${API}/admin/users`);
    const users = await res.json();
    const admin = users.find((u: any) => u.role === 'admin');
    expect(admin).toBeTruthy();
    expect(admin.firstName).toBeTruthy();
    expect(admin.lastName).toBeTruthy();
    expect(admin.name).toBe(`${admin.firstName} ${admin.lastName}`);
  });

  it('Relationships are bidirectional after creation', async () => {
    // Create a user with a relationship to user-002
    const res = await fetch(`${API}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'BiDir',
        lastName: 'Test',
        email: `bidir-${Date.now()}@test.com`,
        role: 'user',
        relationships: [{ userId: 'user-002', type: 'parent' }],
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    
    // Check the other user has the reciprocal relationship
    const usersRes = await fetch(`${API}/admin/users`);
    const users = await usersRes.json();
    const user002 = users.find((u: any) => u.id === 'user-002');
    const reciprocal = user002?.relationships?.find((r: any) => r.userId === created.id);
    expect(reciprocal).toBeTruthy();
    expect(reciprocal.type).toBe('child'); // parent -> child reciprocal

    // Cleanup
    await fetch(`${API}/admin/users/${created.id}`, { method: 'DELETE' });
  });
});
