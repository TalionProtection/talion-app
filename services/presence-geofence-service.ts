import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { getApiBaseUrl } from '@/lib/server-url';
import { authHeader } from '@/lib/auth-fetch';
import { PRESENCE_GEOFENCE_TASK } from './presence-geofence-task';

interface UserAddressForGeofence {
  id: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  temporary?: boolean;
  expiresAt?: number;
}

/**
 * (Re)registers native geofence regions around every one of the given user's
 * registered addresses, so entering/leaving any of them is detected by the OS
 * even when the app isn't running - not just backgrounded. Call this once
 * after opting in (background permission granted) and again whenever the
 * user's addresses change (add/edit/remove/set primary).
 */
export async function syncPresenceGeofences(userId: string): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const res = await fetch(`${getApiBaseUrl()}/api/users/${userId}/addresses`, {
      headers: await authHeader(),
    });
    if (!res.ok) return;
    const addresses: UserAddressForGeofence[] = await res.json();
    const now = Date.now();
    const regions = addresses
      .filter(a => a.latitude != null && a.longitude != null && (!a.temporary || !a.expiresAt || a.expiresAt > now))
      .map(a => ({
        identifier: a.id,
        latitude: a.latitude!,
        longitude: a.longitude!,
        radius: a.radiusMeters || 150,
      }));

    if (regions.length === 0) {
      await stopPresenceGeofences();
      return;
    }
    await Location.startGeofencingAsync(PRESENCE_GEOFENCE_TASK, regions);
    console.log(`[PresenceGeofence] Registered ${regions.length} region(s)`);
  } catch (e) {
    console.warn('[PresenceGeofence] Sync failed:', e);
  }
}

export async function stopPresenceGeofences(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const started = await Location.hasStartedGeofencingAsync(PRESENCE_GEOFENCE_TASK);
    if (started) {
      await Location.stopGeofencingAsync(PRESENCE_GEOFENCE_TASK);
    }
  } catch (e) {
    console.warn('[PresenceGeofence] Stop failed:', e);
  }
}

export async function isPresenceGeofencingActive(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return await Location.hasStartedGeofencingAsync(PRESENCE_GEOFENCE_TASK);
  } catch {
    return false;
  }
}
