import { describe, it, expect } from 'vitest';
import fs from 'fs';

const SERVER_URL = 'http://127.0.0.1:3000';

describe('Password Reset - Server Endpoints', () => {
  it('POST /auth/request-password-reset should accept valid email', async () => {
    const res = await fetch(`${SERVER_URL}/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@talion.io' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.message).toContain('code de réinitialisation');
  });

  it('POST /auth/request-password-reset should not reveal non-existent email', async () => {
    const res = await fetch(`${SERVER_URL}/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nonexistent@example.com' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // Same message as valid email - no information leakage
    expect(data.message).toContain('code de réinitialisation');
  });

  it('POST /auth/request-password-reset should require email', async () => {
    const res = await fetch(`${SERVER_URL}/auth/request-password-reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('POST /auth/reset-password should reject invalid code', async () => {
    const res = await fetch(`${SERVER_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '999999', newPassword: 'newpass123' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('invalide');
  });

  it('POST /auth/reset-password should require minimum password length', async () => {
    const res = await fetch(`${SERVER_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: '123456', newPassword: 'abc' }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('6 characters');
  });

  it('POST /auth/reset-password should require code and newPassword', async () => {
    const res = await fetch(`${SERVER_URL}/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe('Forgot Password Screen', () => {
  it('should exist at app/forgot-password.tsx', () => {
    expect(fs.existsSync('/home/ubuntu/safenet-app/app/forgot-password.tsx')).toBe(true);
  });

  it('should have two steps: email and code', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/app/forgot-password.tsx', 'utf-8');
    expect(src).toContain("type Step = 'email' | 'code'");
    expect(src).toContain('/auth/request-password-reset');
    expect(src).toContain('/auth/reset-password');
  });

  it('should have back to login link', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/app/forgot-password.tsx', 'utf-8');
    expect(src).toContain("router.replace('/login')");
    expect(src).toContain('Retour à la connexion');
  });
});

describe('Login Screen - Forgot Password Link', () => {
  it('should have forgot password link on login screen', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/app/login.tsx', 'utf-8');
    expect(src).toContain("router.push('/forgot-password')");
    expect(src).toContain('Mot de passe oublié');
  });
});

describe('Admin Tab - Unicode Characters', () => {
  it('should not contain broken Unicode surrogate pairs', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/app/(tabs)/admin.tsx', 'utf-8');
    // Should NOT contain escaped surrogate pairs like \uD83D\uDC65
    expect(src).not.toMatch(/\\uD[0-9A-F]{3}\\uD[0-9A-F]{3}/);
  });

  it('should contain actual emoji characters', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/app/(tabs)/admin.tsx', 'utf-8');
    expect(src).toContain('👥');
    expect(src).toContain('🚨');
    expect(src).toContain('📊');
    expect(src).toContain('📋');
    expect(src).toContain('🔐');
    expect(src).toContain('📍');
  });

  it('should contain proper French accented characters', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/app/(tabs)/admin.tsx', 'utf-8');
    expect(src).toContain('Prénom');
    expect(src).toContain('Rôle');
    expect(src).toContain('Résolus');
    expect(src).toContain('Désactivé');
    expect(src).toContain('Frère/Sœur');
  });
});
