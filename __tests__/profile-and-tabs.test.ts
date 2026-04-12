import { describe, it, expect } from 'vitest';

describe('Updated Role-Based Tab Visibility', () => {
  function getVisibleTabs(role: string | undefined) {
    // Messages and PTT are visible to ALL users
    const canSeeDispatch = role === 'dispatcher' || role === 'admin';
    const canSeeAdmin = role === 'admin';

    const tabs = ['Home', 'Messages', 'PTT', 'Map', 'Famille', 'Profil'];
    if (canSeeDispatch) tabs.push('Dispatch');
    if (canSeeAdmin) tabs.push('Admin');
    return tabs;
  }

  it('regular user sees Home, Messages, PTT, Map, Famille, Profil (NO Dispatch, Admin)', () => {
    const tabs = getVisibleTabs('user');
    expect(tabs).toEqual(['Home', 'Messages', 'PTT', 'Map', 'Famille', 'Profil']);
    expect(tabs).toContain('Messages');
    expect(tabs).toContain('PTT');
    expect(tabs).not.toContain('Dispatch');
    expect(tabs).not.toContain('Admin');
  });

  it('responder sees Home, Messages, PTT, Map, Famille, Profil (NO Dispatch, Admin)', () => {
    const tabs = getVisibleTabs('responder');
    expect(tabs).toContain('Messages');
    expect(tabs).toContain('PTT');
    expect(tabs).not.toContain('Dispatch');
    expect(tabs).not.toContain('Admin');
  });

  it('dispatcher sees Home, Messages, PTT, Map, Famille, Dispatch, Profil (NO Admin)', () => {
    const tabs = getVisibleTabs('dispatcher');
    expect(tabs).toContain('Messages');
    expect(tabs).toContain('PTT');
    expect(tabs).toContain('Dispatch');
    expect(tabs).not.toContain('Admin');
  });

  it('admin sees ALL tabs', () => {
    const tabs = getVisibleTabs('admin');
    expect(tabs).toContain('Messages');
    expect(tabs).toContain('PTT');
    expect(tabs).toContain('Dispatch');
    expect(tabs).toContain('Admin');
    expect(tabs).toContain('Profil');
  });

  it('undefined role still sees Messages and PTT', () => {
    const tabs = getVisibleTabs(undefined);
    expect(tabs).toEqual(['Home', 'Messages', 'PTT', 'Map', 'Famille', 'Profil']);
    expect(tabs).toContain('Messages');
    expect(tabs).toContain('PTT');
  });
});

describe('Profile Update API', () => {
  const BASE = 'http://127.0.0.1:3000';

  it('should update user firstName and lastName via PUT /admin/users/:id', async () => {
    const res = await fetch(`${BASE}/admin/users/user-001`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Thomas-Updated', lastName: 'Leroy-Updated' }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.firstName).toBe('Thomas-Updated');
    expect(data.lastName).toBe('Leroy-Updated');
    expect(data.name).toBe('Thomas-Updated Leroy-Updated');

    // Restore original
    await fetch(`${BASE}/admin/users/user-001`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Thomas', lastName: 'Leroy' }),
    });
  });

  it('should update phoneMobile via PUT /admin/users/:id', async () => {
    const res = await fetch(`${BASE}/admin/users/user-001`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneMobile: '+33 6 99 88 77 66' }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.phoneMobile).toBe('+33 6 99 88 77 66');

    // Restore
    await fetch(`${BASE}/admin/users/user-001`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneMobile: '+33 6 12 34 56 78' }),
    });
  });

  it('should update photoUrl via PUT /admin/users/:id', async () => {
    const res = await fetch(`${BASE}/admin/users/user-001`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoUrl: 'https://example.com/photo.jpg' }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.photoUrl).toBe('https://example.com/photo.jpg');

    // Restore
    await fetch(`${BASE}/admin/users/user-001`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ photoUrl: '' }),
    });
  });

  it('should return 404 for non-existent user', async () => {
    const res = await fetch(`${BASE}/admin/users/nonexistent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Test' }),
    });
    expect(res.status).toBe(404);
  });
});
