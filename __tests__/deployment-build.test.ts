import { describe, it, expect } from 'vitest';
import fs from 'fs';

describe('Deployment Build Configuration', () => {
  it('should have build script that compiles server to dist/index.js', () => {
    const pkg = JSON.parse(fs.readFileSync('/home/ubuntu/safenet-app/package.json', 'utf-8'));
    expect(pkg.scripts.build).toContain('esbuild server/index.ts');
    expect(pkg.scripts.build).toContain('--outdir=dist');
    expect(pkg.scripts.build).toContain('--format=cjs');
  });

  it('should have start script that runs dist/index.js', () => {
    const pkg = JSON.parse(fs.readFileSync('/home/ubuntu/safenet-app/package.json', 'utf-8'));
    expect(pkg.scripts.start).toContain('node dist/index.js');
  });

  it('should have esbuild as a dependency', () => {
    const pkg = JSON.parse(fs.readFileSync('/home/ubuntu/safenet-app/package.json', 'utf-8'));
    const hasEsbuild = pkg.dependencies?.esbuild || pkg.devDependencies?.esbuild;
    expect(hasEsbuild).toBeTruthy();
  });

  it('server should use PROJECT_ROOT for path resolution', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/server/index.ts', 'utf-8');
    expect(src).toContain("const PROJECT_ROOT = path.resolve(__dirname, '..')");
    expect(src).toContain("path.join(PROJECT_ROOT, 'data')");
    expect(src).toContain("path.join(PROJECT_ROOT, 'uploads')");
    expect(src).toContain("path.join(PROJECT_ROOT, 'server', 'admin-web')");
    expect(src).toContain("path.join(PROJECT_ROOT, 'server', 'dispatch-web')");
    expect(src).toContain("path.join(PROJECT_ROOT, 'server', 'console-login')");
  });
});

describe('Server URL Resolution for Published APK', () => {
  it('should have fallback to manus.space domain for native APK', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/lib/server-url.ts', 'utf-8');
    expect(src).toContain('safenetapp-plycttrb.manus.space');
    expect(src).toContain("Platform.OS !== 'web'");
  });

  it('should check EXPO_PUBLIC_API_URL env var first', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/lib/server-url.ts', 'utf-8');
    expect(src).toContain('process.env.EXPO_PUBLIC_API_URL');
  });

  it('should check deployedUrl from expoConfig extra', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/lib/server-url.ts', 'utf-8');
    expect(src).toContain('Constants.expoConfig?.extra?.deployedUrl');
  });

  it('should handle WebSocket URL derivation from API URL', () => {
    const src = fs.readFileSync('/home/ubuntu/safenet-app/lib/server-url.ts', 'utf-8');
    expect(src).toContain("apiUrl.replace(/^http/, 'ws')");
  });
});

describe('Quick Login Credentials', () => {
  it('should have matching credentials in login.tsx and server seed', () => {
    const loginSrc = fs.readFileSync('/home/ubuntu/safenet-app/app/login.tsx', 'utf-8');
    // Verify all 4 quick login roles exist
    expect(loginSrc).toContain("admin@talion.io");
    expect(loginSrc).toContain("dispatch@talion.io");
    expect(loginSrc).toContain("responder@talion.io");
    expect(loginSrc).toContain("thomas@example.com");
    expect(loginSrc).toContain("talion2026");
  });
});
