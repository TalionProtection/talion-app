import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import locationService, { UserLocation, LocationServiceState } from '@/services/location-service';

// Import background task definition (must be in global scope for TaskManager)
if (Platform.OS !== 'web') {
  require('@/services/background-location-task');
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
  /** User role - if 'responder' or 'dispatcher', background tracking is available */
  userRole?: string;
  /** Whether the user is on duty (responders only) */
  isOnDuty?: boolean;
}

export function LocationProvider({ children, userRole, isOnDuty }: LocationProviderProps) {
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

  // Auto-start background tracking for responders who are on duty
  useEffect(() => {
    if (Platform.OS === 'web') return;

    const isResponderOrDispatcher = userRole === 'responder' || userRole === 'dispatcher';

    if (isResponderOrDispatcher && isOnDuty) {
      // Start background tracking when responder goes on duty
      locationService.startBackgroundTracking({
        intervalMs: 15000,  // every 15 seconds
        distanceMeters: 10, // minimum 10 meters movement
      }).then((started) => {
        if (started) {
          console.log('[LocationProvider] Background tracking auto-started for', userRole);
        }
      });
    } else if (!isOnDuty && state.isBackgroundTracking) {
      // Stop background tracking when going off duty
      locationService.stopBackgroundTracking().then(() => {
        console.log('[LocationProvider] Background tracking stopped (off duty)');
      });
    }
  }, [userRole, isOnDuty]);

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
