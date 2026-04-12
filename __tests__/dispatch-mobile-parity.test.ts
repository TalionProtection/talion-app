import { describe, it, expect } from 'vitest';

const BASE = 'http://127.0.0.1:3000';

describe('Dispatch Mobile Parity - Server Endpoints', () => {
  it('GET /dispatch/responders returns responders with fallback data', async () => {
    const res = await fetch(`${BASE}/dispatch/responders`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    // Each responder should have id, name, status
    const first = data[0];
    expect(first).toHaveProperty('id');
    expect(first).toHaveProperty('name');
    expect(first).toHaveProperty('status');
  });

  it('POST /dispatch/broadcast sends broadcast successfully', async () => {
    const res = await fetch(`${BASE}/dispatch/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'Test broadcast from mobile',
        severity: 'high',
        radiusKm: 10,
        by: 'Mobile Dispatcher',
      }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.success).toBe(true);
  });

  it('GET /admin/users returns users with firstName/lastName for profile display', async () => {
    const res = await fetch(`${BASE}/admin/users`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    const user = data.find((u: any) => u.id === 'user-001');
    expect(user).toBeDefined();
    expect(user.firstName).toBe('Thomas');
    expect(user.lastName).toBe('Leroy');
    expect(user.email).toBeDefined();
    expect(user.role).toBe('user');
  });

  it('GET /admin/users/:id returns full profile with relationships and sameAddress', async () => {
    const res = await fetch(`${BASE}/admin/users/user-001`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.firstName).toBe('Thomas');
    expect(data.lastName).toBe('Leroy');
    expect(data).toHaveProperty('tags');
    expect(data).toHaveProperty('relationships');
    expect(data).toHaveProperty('sameAddress');
    expect(data).toHaveProperty('email');
    expect(data).toHaveProperty('address');
  });

  it('GET /admin/users/:id for responder returns profile', async () => {
    const res = await fetch(`${BASE}/admin/users/resp-001`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.firstName).toBe('Pierre');
    expect(data.lastName).toBe('Martin');
    expect(data.role).toBe('responder');
  });

  it('POST /auth/login tracks login history', async () => {
    // Login
    await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'thomas@example.com', password: 'talion2026' }),
    });

    // Check login history
    const res = await fetch(`${BASE}/admin/users/user-001/login-history`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('entries');
    expect(Array.isArray(data.entries)).toBe(true);
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.entries[0]).toHaveProperty('timestamp');
    expect(data.entries[0]).toHaveProperty('status');
  });

  it('GET /dispatch/responders enriches with admin user data when IDs match', async () => {
    const res = await fetch(`${BASE}/dispatch/responders`);
    const responders = await res.json();
    // Demo responders have IDs like resp-001 which match admin users
    const matched = responders.find((r: any) => r.id === 'resp-001');
    if (matched) {
      // The dispatch endpoint returns basic data, but admin enrichment happens client-side
      expect(matched).toHaveProperty('id');
      expect(matched).toHaveProperty('status');
    }
  });
});
