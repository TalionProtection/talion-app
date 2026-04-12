import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { Platform } from 'react-native';

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
        // Notify all registered callbacks
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
