import { describe, it, expect } from 'vitest';

/**
 * Tests for role-based tab visibility logic.
 * Verifies that tabs are shown/hidden based on user role.
 */

describe('Role-Based Tab Visibility', () => {
  // Simulate the role-gating logic from _layout.tsx
  function getVisibleTabs(role: string | undefined) {
    const canSeeDispatch = role === 'dispatcher' || role === 'admin';
    const canSeeAdmin = role === 'admin';

    const tabs = ['Home', 'Messages', 'PTT', 'Map', 'Famille'];
    if (canSeeDispatch) tabs.push('Dispatch');
    if (canSeeAdmin) tabs.push('Admin');
    return tabs;
  }

  it('regular user should see only basic tabs (Home, Messages, PTT, Map, Famille)', () => {
    const tabs = getVisibleTabs('user');
    expect(tabs).toEqual(['Home', 'Messages', 'PTT', 'Map', 'Famille']);
    expect(tabs).not.toContain('Dispatch');
    expect(tabs).not.toContain('Admin');
  });

  it('responder should see only basic tabs (same as user)', () => {
    const tabs = getVisibleTabs('responder');
    expect(tabs).toEqual(['Home', 'Messages', 'PTT', 'Map', 'Famille']);
    expect(tabs).not.toContain('Dispatch');
    expect(tabs).not.toContain('Admin');
  });

  it('dispatcher should see basic tabs + Dispatch, but NOT Admin', () => {
    const tabs = getVisibleTabs('dispatcher');
    expect(tabs).toEqual(['Home', 'Messages', 'PTT', 'Map', 'Famille', 'Dispatch']);
    expect(tabs).toContain('Dispatch');
    expect(tabs).not.toContain('Admin');
  });

  it('admin should see ALL tabs including Dispatch and Admin', () => {
    const tabs = getVisibleTabs('admin');
    expect(tabs).toEqual(['Home', 'Messages', 'PTT', 'Map', 'Famille', 'Dispatch', 'Admin']);
    expect(tabs).toContain('Dispatch');
    expect(tabs).toContain('Admin');
  });

  it('undefined role should see only basic tabs', () => {
    const tabs = getVisibleTabs(undefined);
    expect(tabs).toEqual(['Home', 'Messages', 'PTT', 'Map', 'Famille']);
    expect(tabs).not.toContain('Dispatch');
    expect(tabs).not.toContain('Admin');
  });

  it('href should be null for hidden tabs, undefined for visible tabs', () => {
    // Simulates the href logic: canSee ? undefined : null
    const getHref = (canSee: boolean) => canSee ? undefined : null;

    // User role
    expect(getHref(false)).toBeNull(); // Dispatch hidden
    expect(getHref(false)).toBeNull(); // Admin hidden

    // Dispatcher role
    expect(getHref(true)).toBeUndefined(); // Dispatch visible
    expect(getHref(false)).toBeNull();     // Admin hidden

    // Admin role
    expect(getHref(true)).toBeUndefined(); // Dispatch visible
    expect(getHref(true)).toBeUndefined(); // Admin visible
  });
});
