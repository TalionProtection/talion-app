import { describe, it, expect } from 'vitest';

const API = 'http://127.0.0.1:3000';

describe('Login History - Tracking', () => {
  it('should record successful login in history', async () => {
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TestAgent/1.0 (iPhone)' },
      body: JSON.stringify({ email: 'thomas@example.com', password: 'talion2026' }),
    });
    expect(loginRes.status).toBe(200);

    const historyRes = await fetch(`${API}/admin/login-history`);
    const data = await historyRes.json();
    expect(data.entries.length).toBeGreaterThan(0);
    const latest = data.entries[0];
    expect(latest.userName).toBe('Thomas Leroy');
    expect(latest.status).toBe('success');
    expect(latest.device).toBe('iPhone');
    expect(latest.ip).toBeDefined();
    expect(latest.userAgent).toContain('TestAgent');
  });

  it('should record failed password attempt in history', async () => {
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TestAgent/1.0 (Windows NT 10.0)' },
      body: JSON.stringify({ email: 'thomas@example.com', password: 'wrongpass' }),
    });

    const historyRes = await fetch(`${API}/admin/login-history?status=failed_password`);
    const data = await historyRes.json();
    expect(data.entries.length).toBeGreaterThan(0);
    const latest = data.entries[0];
    expect(latest.status).toBe('failed_password');
    expect(latest.device).toBe('Windows PC');
  });

  it('should record unknown email attempt in history', async () => {
    await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TestAgent/1.0 (Linux)' },
      body: JSON.stringify({ email: 'nobody@nowhere.com', password: 'test' }),
    });

    const historyRes = await fetch(`${API}/admin/login-history?status=failed_email`);
    const data = await historyRes.json();
    expect(data.entries.length).toBeGreaterThan(0);
    const latest = data.entries[0];
    expect(latest.status).toBe('failed_email');
    expect(latest.userName).toBe('Unknown');
  });
});

describe('Login History - API Endpoints', () => {
  it('should return paginated global history', async () => {
    const res = await fetch(`${API}/admin/login-history?page=1&limit=2`);
    const data = await res.json();
    expect(data.entries.length).toBeLessThanOrEqual(2);
    expect(data.page).toBe(1);
    expect(data.total).toBeGreaterThan(0);
    expect(data.totalPages).toBeGreaterThanOrEqual(1);
  });

  it('should filter by status', async () => {
    const res = await fetch(`${API}/admin/login-history?status=success`);
    const data = await res.json();
    data.entries.forEach((e: any) => {
      expect(e.status).toBe('success');
    });
  });

  it('should filter by userId', async () => {
    const res = await fetch(`${API}/admin/login-history?userId=user-001`);
    const data = await res.json();
    data.entries.forEach((e: any) => {
      expect(e.userId).toBe('user-001');
    });
  });

  it('should search by text', async () => {
    const res = await fetch(`${API}/admin/login-history?search=thomas`);
    const data = await res.json();
    data.entries.forEach((e: any) => {
      const match = e.userName.toLowerCase().includes('thomas') ||
                    e.email.toLowerCase().includes('thomas');
      expect(match).toBe(true);
    });
  });

  it('should return user-specific history', async () => {
    const res = await fetch(`${API}/admin/users/user-001/login-history`);
    const data = await res.json();
    expect(data.user.name).toBe('Thomas Leroy');
    expect(data.total).toBeGreaterThan(0);
    data.entries.forEach((e: any) => {
      expect(e.userId).toBe('user-001');
    });
  });

  it('should return 404 for non-existent user history', async () => {
    const res = await fetch(`${API}/admin/users/nonexistent/login-history`);
    expect(res.status).toBe(404);
  });

  it('should return login stats', async () => {
    const res = await fetch(`${API}/admin/login-stats`);
    const data = await res.json();
    expect(data.last24h).toBeDefined();
    expect(data.last24h.success).toBeGreaterThanOrEqual(0);
    expect(data.last24h.failed).toBeGreaterThanOrEqual(0);
    expect(data.last24h.uniqueUsers).toBeGreaterThanOrEqual(0);
    expect(data.last7d).toBeDefined();
    expect(data.totalEntries).toBeGreaterThan(0);
  });
});
