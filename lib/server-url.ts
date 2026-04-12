/**
 * Server URL Resolution
 *
 * Resolves the correct server URL based on the runtime environment:
 * - Web: uses window.location (same origin as the page)
 * - Native (Expo Go): uses the Metro bundler host from Constants
 * - Fallback: uses EXPO_PUBLIC_API_URL / EXPO_PUBLIC_WS_URL env vars
 *
 * The server runs on port 3000 alongside the Metro bundler (port 8081).
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';

const SERVER_PORT = 3000;

/**
 * Get the HTTP base URL for the API server.
 * e.g. "https://3000-xxxx.manus.computer" or "http://192.168.1.5:3000"
 */
export function getApiBaseUrl(): string {
  // 1. Check env var first
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL;
  }

  // 2. Web: derive from current page location
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    // In the manus.computer proxy environment, port is encoded in the subdomain
    // e.g. 8081-xxx.manus.computer → replace 8081 with 3000
    const host = window.location.host;
    const protocol = window.location.protocol;

    if (host.includes('manus.computer') || host.includes('manus.space')) {
      // Replace the port prefix in the subdomain: "8081-xxx" → "3000-xxx"
      const newHost = host.replace(/^\d+-/, `${SERVER_PORT}-`);
      return `${protocol}//${newHost}`;
    }

    // Standard same-origin: just change the port
    const hostname = window.location.hostname;
    return `${protocol}//${hostname}:${SERVER_PORT}`;
  }

  // 3. Native: use the Metro bundler host from Expo Constants
  const debuggerHost =
    Constants.expoConfig?.hostUri || // Expo SDK 54+
    (Constants as any).manifest?.debuggerHost || // Legacy
    (Constants as any).manifest2?.extra?.expoGo?.debuggerHost; // EAS Update

  if (debuggerHost) {
    // debuggerHost is like "192.168.1.5:8081" or "xxxx.manus.computer:8081"
    const hostname = debuggerHost.split(':')[0];

    // Check if it's a manus proxy domain
    if (hostname.includes('manus.computer') || hostname.includes('manus.space')) {
      // For proxy domains, the port is in the subdomain
      const newHostname = hostname.replace(/^\d+-/, `${SERVER_PORT}-`);
      return `https://${newHostname}`;
    }

    return `http://${hostname}:${SERVER_PORT}`;
  }

  // 4. Published APK: use the deployed manus.space domain
  //    In a published build, Constants.expoConfig?.extra?.deployedUrl may be set,
  //    or we fall back to the known published domain.
  const deployedUrl = Constants.expoConfig?.extra?.deployedUrl;
  if (deployedUrl) {
    return deployedUrl;
  }

  // 5. Fallback: try the published manus.space domain if available
  //    This handles the case where the APK is built and deployed but no env var is set
  if (Platform.OS !== 'web') {
    // In a standalone APK (not Expo Go), debuggerHost is typically undefined.
    // Use the production server URL.
    return 'https://safenetapp-plycttrb.manus.space';
  }

  // 6. Final fallback
  return `http://localhost:${SERVER_PORT}`;
}

/**
 * Get the WebSocket URL for the server.
 * e.g. "wss://3000-xxxx.manus.computer" or "ws://192.168.1.5:3000"
 */
export function getWsUrl(): string {
  // 1. Check env var first
  if (process.env.EXPO_PUBLIC_WS_URL) {
    return process.env.EXPO_PUBLIC_WS_URL;
  }

  // Derive from the API base URL
  const apiUrl = getApiBaseUrl();

  // Convert http(s) to ws(s)
  return apiUrl.replace(/^http/, 'ws');
}
