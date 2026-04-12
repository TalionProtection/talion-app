import { describe, it, expect } from 'vitest';

const BASE = 'http://127.0.0.1:3000';

describe('Admin Mobile CRUD - Server Endpoints', () => {
  it('GET /admin/users returns user list with all fields', async () => {
    const res = await fetch(`${BASE}/admin/users`);
    expect(res.status).toBe(200);
    const users = await res.json();
    expect(Array.isArray(users)).toBe(true);
    expect(users.length).toBeGreaterThan(0);

    const user = users[0];
    expect(user).toHaveProperty('id');
    expect(user).toHaveProperty('firstName');
    expect(user).toHaveProperty('lastName');
    expect(user).toHaveProperty('email');
    expect(user).toHaveProperty('role');
    expect(user).toHaveProperty('status');
    expect(user).toHaveProperty('hasPassword');
    // passwordHash should NOT be exposed
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('POST /admin/users creates a new user with all fields', async () => {
    const newUser = {
      firstName: 'Test',
      lastName: 'MobileAdmin',
      email: `test-mobile-${Date.now()}@example.com`,
      password: 'testpass123',
      role: 'user',
      phoneMobile: '+33 6 00 00 00 01',
      phoneLandline: '+33 1 00 00 00 01',
      address: '1 Rue de Test, Paris',
      tags: ['test-tag', 'mobile'],
      comments: 'Created from mobile admin test',
    };

    const res = await fetch(`${BASE}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.firstName).toBe('Test');
    expect(created.lastName).toBe('MobileAdmin');
    expect(created.email).toBe(newUser.email);
    expect(created.role).toBe('user');
    expect(created.phoneMobile).toBe(newUser.phoneMobile);
    expect(created.tags).toContain('test-tag');
    expect(created.hasPassword).toBe(true);
    expect(created).not.toHaveProperty('passwordHash');

    // Clean up
    await fetch(`${BASE}/admin/users/${created.id}`, { method: 'DELETE' });
  });

  it('PUT /admin/users/:id updates user fields', async () => {
    // Create a user first
    const res1 = await fetch(`${BASE}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Update',
        lastName: 'Test',
        email: `update-test-${Date.now()}@example.com`,
        password: 'pass123',
      }),
    });
    const created = await res1.json();

    // Update the user
    const res2 = await fetch(`${BASE}/admin/users/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Updated',
        lastName: 'Name',
        phoneMobile: '+33 6 99 99 99 99',
        tags: ['updated-tag'],
        comments: 'Updated via test',
      }),
    });
    expect(res2.status).toBe(200);
    const updated = await res2.json();
    expect(updated.firstName).toBe('Updated');
    expect(updated.lastName).toBe('Name');
    expect(updated.phoneMobile).toBe('+33 6 99 99 99 99');
    expect(updated.tags).toContain('updated-tag');

    // Clean up
    await fetch(`${BASE}/admin/users/${created.id}`, { method: 'DELETE' });
  });

  it('DELETE /admin/users/:id removes the user', async () => {
    // Create a user first
    const res1 = await fetch(`${BASE}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Delete',
        lastName: 'Me',
        email: `delete-me-${Date.now()}@example.com`,
        password: 'pass123',
      }),
    });
    const created = await res1.json();

    // Delete
    const res2 = await fetch(`${BASE}/admin/users/${created.id}`, { method: 'DELETE' });
    expect(res2.status).toBe(200);

    // Verify deleted
    const res3 = await fetch(`${BASE}/admin/users/${created.id}`);
    expect(res3.status).toBe(404);
  });

  it('PUT /admin/users/:id/role changes user role', async () => {
    const usersRes = await fetch(`${BASE}/admin/users`);
    const users = await usersRes.json();
    const testUser = users.find((u: any) => u.role === 'user');
    if (!testUser) return;

    const res = await fetch(`${BASE}/admin/users/${testUser.id}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'responder' }),
    });
    expect(res.status).toBe(200);

    // Restore original role
    await fetch(`${BASE}/admin/users/${testUser.id}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user' }),
    });
  });

  it('PUT /admin/users/:id/status changes user status', async () => {
    const usersRes = await fetch(`${BASE}/admin/users`);
    const users = await usersRes.json();
    const testUser = users.find((u: any) => u.status === 'active' && u.role === 'user');
    if (!testUser) return;

    const res = await fetch(`${BASE}/admin/users/${testUser.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'suspended' }),
    });
    expect(res.status).toBe(200);

    // Restore
    await fetch(`${BASE}/admin/users/${testUser.id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'active' }),
    });
  });

  it('GET /alerts returns incident data for admin view', async () => {
    const res = await fetch(`${BASE}/alerts`);
    expect(res.status).toBe(200);
    const alerts = await res.json();
    expect(Array.isArray(alerts)).toBe(true);
  });

  it('GET /admin/audit returns audit log entries', async () => {
    const res = await fetch(`${BASE}/admin/audit`);
    expect(res.status).toBe(200);
    const audit = await res.json();
    expect(Array.isArray(audit)).toBe(true);
    if (audit.length > 0) {
      expect(audit[0]).toHaveProperty('action');
      expect(audit[0]).toHaveProperty('category');
      expect(audit[0]).toHaveProperty('timestamp');
    }
  });
});
