import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { getApiBaseUrl } from '@/lib/server-url';
import { authHeader } from '@/lib/auth-fetch';

export const BACKGROUND_LOCATION_TASK = 'talion-background-location';

/**
 * Background location update callback registry.
 * Components can register callbacks to receive background location updates.
 */
type BackgroundLocationCallback = (locations: Location.LocationObject[]) => void;
const backgroundCallbacks: Set<BackgroundLocationCallback> = new Set();

export function onBackgroundLocationUpdate(callback: BackgroundLocationCallback): () => void {
  backgroundCallbacks.add(callback);
  return () => {
    backgroundCallbacks.delete(callback);
  };
}

// The task callback below runs outside any mounted React component — it's
// invoked directly by the native side during the OS-granted background
// execution window, so it can't reach anything living in a component or
// hook (e.g. the app's periodic "send location" setInterval in the Home
// screen, which is what actually pushes updates to the server for a
// foregrounded app — that interval is simply frozen while backgrounded).
// Without a direct network call right here, a background GPS fix is
// captured but never leaves the device until the app is foregrounded again.
let currentUserId: string | null = null;
let currentUserRole: string | null = null;

export function setBackgroundLocationUser(userId: string | null, role: string | null) {
  currentUserId = userId;
  currentUserRole = role;
}

async function sendBackgroundLocationToServer(latitude: number, longitude: number) {
  if (!currentUserId) return;
  try {
    const apiBase = getApiBaseUrl();
    await fetch(`${apiBase}/api/location`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ userId: currentUserId, userRole: currentUserRole || 'user', latitude, longitude }),
    });
    console.log('[BackgroundLocation] Sent to server:', latitude.toFixed(6), longitude.toFixed(6));
  } catch (e) {
    console.warn('[BackgroundLocation] Failed to send to server:', e);
  }
}

/**
 * Define the background location task in global scope.
 * This MUST be called at the top level, not inside a component.
 */
if (Platform.OS !== 'web') {
  TaskManager.defineTask(BACKGROUND_LOCATION_TASK, ({ data, error }) => {
    if (error) {
      console.error('[BackgroundLocation] Task error:', error.message);
      return;
    }
    if (data) {
      const { locations } = data as { locations: Location.LocationObject[] };
      if (locations && locations.length > 0) {
        console.log('[BackgroundLocation] Received', locations.length, 'locations');
        const latest = locations[locations.length - 1];
        sendBackgroundLocationToServer(latest.coords.latitude, latest.coords.longitude).catch(() => {});
        // Notify all registered callbacks (foreground UI state, when mounted)
        backgroundCallbacks.forEach((cb) => {
          try {
            cb(locations);
          } catch (e) {
            console.warn('[BackgroundLocation] Callback error:', e);
          }
        });
      }
    }
  });
}
