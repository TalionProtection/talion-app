import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { Platform } from 'react-native';
import { getApiBaseUrl } from '@/lib/server-url';
import { authHeader } from '@/lib/auth-fetch';

export const PRESENCE_GEOFENCE_TASK = 'talion-presence-geofence';

// Reports enter/exit for the caller's own registered addresses directly to
// the server from this headless task - not through the WebSocket/foreground
// location pipeline - so presence keeps updating even with the app fully
// closed (subject to iOS/Android's own limits on background execution after
// an explicit user force-quit; no app can override that).
if (Platform.OS !== 'web') {
  TaskManager.defineTask(PRESENCE_GEOFENCE_TASK, async ({ data, error }) => {
    if (error) {
      console.error('[PresenceGeofence] Task error:', error.message);
      return;
    }
    if (!data) return;
    const { eventType, region } = data as {
      eventType: Location.LocationGeofencingEventType;
      region: Location.LocationRegion;
    };
    if (!region?.identifier) return;

    const type = eventType === Location.LocationGeofencingEventType.Enter ? 'enter' : 'exit';
    console.log(`[PresenceGeofence] ${type} region ${region.identifier}`);

    try {
      const res = await fetch(`${getApiBaseUrl()}/api/presence/geofence-event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ addressId: region.identifier, eventType: type }),
      });
      if (!res.ok) {
        console.warn('[PresenceGeofence] Server rejected event:', res.status);
      }
    } catch (e) {
      console.warn('[PresenceGeofence] Failed to report event:', e);
    }
  });
}
