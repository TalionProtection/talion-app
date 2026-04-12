import { describe, it, expect } from 'vitest';

const API = 'http://127.0.0.1:3000';

describe('Authentication - POST /auth/login', () => {
  it('should login with valid credentials and return user + token', async () => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'thomas@example.com', password: 'talion2026' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.token).toBeDefined();
    expect(data.user).toBeDefined();
    expect(data.user.name).toBe('Thomas Leroy');
    expect(data.user.role).toBe('user');
    expect(data.user.id).toBe('user-001');
    // Must NOT expose passwordHash
    expect(data.user.passwordHash).toBeUndefined();
  });

  it('should reject wrong password', async () => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'thomas@example.com', password: 'wrongpassword' }),
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid email or password');
  });

  it('should reject non-existent email', async () => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@test.com', password: 'test' }),
    });
    expect(res.status).toBe(401);
    const data = await res.json();
    expect(data.error).toBe('Invalid email or password');
  });

  it('should reject missing fields', async () => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'thomas@example.com' }),
    });
    expect(res.status).toBe(400);
  });

  it('should login all demo roles successfully', async () => {
    const demoAccounts = [
      { email: 'admin@talion.io', expectedRole: 'admin', expectedName: 'Marie Dupont' },
      { email: 'dispatch@talion.io', expectedRole: 'dispatcher', expectedName: 'Jean Moreau' },
      { email: 'responder@talion.io', expectedRole: 'responder', expectedName: 'Pierre Martin' },
      { email: 'thomas@example.com', expectedRole: 'user', expectedName: 'Thomas Leroy' },
    ];

    for (const account of demoAccounts) {
      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: account.email, password: 'talion2026' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.user.role).toBe(account.expectedRole);
      expect(data.user.name).toBe(account.expectedName);
    }
  });

  it('should reject inactive user login', async () => {
    // First deactivate a user
    const usersRes = await fetch(`${API}/admin/users`);
    const users = await usersRes.json();
    const testUser = users.find((u: any) => u.email === 'thomas@example.com');
    
    if (testUser) {
      await fetch(`${API}/admin/users/${testUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'deactivated' }),
      });

      const res = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'thomas@example.com', password: 'talion2026' }),
      });
      expect(res.status).toBe(403);

      // Reactivate user
      await fetch(`${API}/admin/users/${testUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
      });
    }
  });
});

describe('Admin Console - Password in User Management', () => {
  it('should show hasPassword field in user list', async () => {
    const res = await fetch(`${API}/admin/users`);
    const users = await res.json();
    expect(users.length).toBeGreaterThan(0);
    // All demo users should have hasPassword: true
    const demoUser = users.find((u: any) => u.email === 'thomas@example.com');
    expect(demoUser).toBeDefined();
    expect(demoUser.hasPassword).toBe(true);
    // passwordHash must NOT be in response
    expect(demoUser.passwordHash).toBeUndefined();
  });

  it('should create user with password and allow login', async () => {
    const uniqueEmail = `authtest-${Date.now()}@test.com`;
    const createRes = await fetch(`${API}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Auth',
        lastName: 'TestUser',
        email: uniqueEmail,
        password: 'securepass123',
        role: 'user',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.hasPassword).toBe(true);
    expect(created.passwordHash).toBeUndefined();

    // Login with the new user
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail, password: 'securepass123' }),
    });
    expect(loginRes.status).toBe(200);
    const loginData = await loginRes.json();
    expect(loginData.user.name).toBe('Auth TestUser');

    // Cleanup
    await fetch(`${API}/admin/users/${created.id}`, { method: 'DELETE' });
  });

  it('should update user password via PUT', async () => {
    const uniqueEmail = `pwupdate-${Date.now()}@test.com`;
    // Create user
    const createRes = await fetch(`${API}/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'PW',
        lastName: 'Update',
        email: uniqueEmail,
        password: 'oldpass',
        role: 'user',
      }),
    });
    const created = await createRes.json();

    // Update password
    const updateRes = await fetch(`${API}/admin/users/${created.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'newpass456' }),
    });
    expect(updateRes.status).toBe(200);

    // Old password should fail
    const oldLoginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail, password: 'oldpass' }),
    });
    expect(oldLoginRes.status).toBe(401);

    // New password should work
    const newLoginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: uniqueEmail, password: 'newpass456' }),
    });
    expect(newLoginRes.status).toBe(200);

    // Cleanup
    await fetch(`${API}/admin/users/${created.id}`, { method: 'DELETE' });
  });
});
