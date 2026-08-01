import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import locationService, { UserLocation, LocationServiceState } from '@/services/location-service';

// Import background task definitions (must be in global scope for TaskManager)
let setBackgroundLocationUser: (userId: string | null, role: string | null) => void = () => {};
if (Platform.OS !== 'web') {
  setBackgroundLocationUser = require('@/services/background-location-task').setBackgroundLocationUser;
  require('@/services/presence-geofence-task');
}

interface LocationContextValue {
  /** Current location state (permissions, tracking, error) */
  state: LocationServiceState;
  /** Current user location (real GPS or fallback) */
  location: UserLocation;
  /** Request location permissions */
  requestPermissions: () => Promise<boolean>;
  /** Request background location permissions */
  requestBackgroundPermissions: () => Promise<boolean>;
  /** Get current position once */
  getCurrentPosition: () => Promise<UserLocation>;
  /** Start continuous foreground tracking */
  startTracking: () => Promise<boolean>;
  /** Stop continuous foreground tracking */
  stopTracking: () => void;
  /** Start background tracking (for responders) */
  startBackgroundTracking: () => Promise<boolean>;
  /** Stop background tracking */
  stopBackgroundTracking: () => Promise<void>;
  /** Reverse geocode coordinates to address */
  reverseGeocode: (lat: number, lng: number) => Promise<string | null>;
  /** Whether location is being loaded */
  isLoading: boolean;
}

const LocationContext = createContext<LocationContextValue | null>(null);

interface LocationProviderProps {
  children: React.ReactNode;
  /** Current user id — passed straight through to the background location
   * task (see setBackgroundLocationUser) so it can POST location updates to
   * the server directly, without depending on any React component being
   * mounted/foregrounded to do it. */
  userId?: string;
  /** User role - if 'responder' or 'dispatcher', background tracking is available */
  userRole?: string;
  /** Whether the user is on duty (responders only) */
  isOnDuty?: boolean;
  /** Family users ('user' role): whether they've opted in to sharing their
   * location with family (Profile toggle) — gates background tracking the
   * same way isOnDuty gates it for responders. undefined/true = shared
   * (matches the toggle's own non-regressive default). */
  shareLocationWithFamily?: boolean;
}

export function LocationProvider({ children, userId, userRole, isOnDuty, shareLocationWithFamily }: LocationProviderProps) {
  const [state, setState] = useState<LocationServiceState>(locationService.getState());
  const [location, setLocation] = useState<UserLocation>(locationService.getCurrentLocation());
  const [isLoading, setIsLoading] = useState(true);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);

  // Subscribe to location service state changes
  useEffect(() => {
    const unsubState = locationService.subscribe((newState) => {
      setState(newState);
    });

    const unsubLocation = locationService.onLocationUpdate((newLocation) => {
      setLocation(newLocation);
    });

    return () => {
      unsubState();
      unsubLocation();
    };
  }, []);

  // Initialize location on mount
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        const granted = await locationService.requestPermissions();
        if (granted && mounted) {
          await locationService.getCurrentPosition();
          await locationService.startTracking({
            intervalMs: 10000,
            distanceMeters: 10,
          });
        }
      } catch (e) {
        console.warn('[LocationProvider] Init failed:', e);
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    init();

    return () => {
      mounted = false;
    };
  }, []);

  // Keep the background task's notion of "who this is" current, so it can
  // POST directly to the server when it wakes (see background-location-task.ts).
  useEffect(() => {
    setBackgroundLocationUser(userId || null, userRole || null);
  }, [userId, userRole]);

  // Auto-start background tracking for responders on duty, AND for family
  // users who've opted in to location sharing — without this, the family
  // presence/residence features only ever reflect a live position while the
  // app is open in the foreground, since iOS suspends plain foreground
  // location watching within moments of backgrounding.
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const isResponderOrDispatcher = userRole === 'responder' || userRole === 'dispatcher';
    const isFamilyUser = userRole === 'user';
    const shouldTrackInBackground =
      (isResponderOrDispatcher && isOnDuty) ||
      (isFamilyUser && shareLocationWithFamily !== false);

    if (shouldTrackInBackground) {
      locationService.startBackgroundTracking(
        isResponderOrDispatcher
          ? { intervalMs: 15000, distanceMeters: 10 } // responders: tight tracking while on duty
          : { intervalMs: 30000, distanceMeters: 20 } // family: enough to reflect presence, lighter on battery
      ).then((started) => {
        if (started) {
          console.log('[LocationProvider] Background tracking auto-started for', userRole);
        }
      });
    } else if (state.isBackgroundTracking) {
      locationService.stopBackgroundTracking().then(() => {
        console.log('[LocationProvider] Background tracking stopped');
      });
    }
  }, [userRole, isOnDuty, shareLocationWithFamily]);

  // Handle app state changes - manage foreground/background transitions
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState: AppStateStatus) => {
      if (
        appStateRef.current.match(/inactive|background/) &&
        nextAppState === 'active'
      ) {
        // App came to foreground - resume foreground tracking
        if (state.hasPermission && !state.isTracking) {
          locationService.startTracking();
        }
      }
      appStateRef.current = nextAppState;
    });

    return () => {
      subscription.remove();
    };
  }, [state.hasPermission, state.isTracking]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      locationService.stopTracking();
      // Note: Don't stop background tracking on unmount - it should persist
    };
  }, []);

  const requestPermissions = useCallback(async () => {
    return locationService.requestPermissions();
  }, []);

  const requestBackgroundPermissions = useCallback(async () => {
    return locationService.requestBackgroundPermissions();
  }, []);

  const getCurrentPosition = useCallback(async () => {
    return locationService.getCurrentPosition();
  }, []);

  const startTracking = useCallback(async () => {
    return locationService.startTracking();
  }, []);

  const stopTracking = useCallback(() => {
    locationService.stopTracking();
  }, []);

  const startBackgroundTracking = useCallback(async () => {
    return locationService.startBackgroundTracking();
  }, []);

  const stopBackgroundTracking = useCallback(async () => {
    return locationService.stopBackgroundTracking();
  }, []);

  const reverseGeocode = useCallback(async (lat: number, lng: number) => {
    return locationService.reverseGeocode(lat, lng);
  }, []);

  return (
    <LocationContext.Provider
      value={{
        state,
        location,
        requestPermissions,
        requestBackgroundPermissions,
        getCurrentPosition,
        startTracking,
        stopTracking,
        startBackgroundTracking,
        stopBackgroundTracking,
        reverseGeocode,
        isLoading,
      }}
    >
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation(): LocationContextValue {
  const context = useContext(LocationContext);
  if (!context) {
    throw new Error('useLocation must be used within a LocationProvider');
  }
  return context;
}

export default LocationProvider;
