import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { BACKGROUND_LOCATION_TASK, onBackgroundLocationUpdate } from './background-location-task';

export interface UserLocation {
  latitude: number;
  longitude: number;
  altitude: number | null;
  accuracy: number | null;
  heading: number | null;
  speed: number | null;
  timestamp: number;
}

export interface LocationServiceState {
  hasPermission: boolean;
  hasBackgroundPermission: boolean;
  isTracking: boolean;
  isBackgroundTracking: boolean;
  currentLocation: UserLocation | null;
  errorMessage: string | null;
  isServicesEnabled: boolean;
}

type LocationUpdateCallback = (location: UserLocation) => void;

export class LocationService {
  private state: LocationServiceState = {
    hasPermission: false,
    hasBackgroundPermission: false,
    isTracking: false,
    isBackgroundTracking: false,
    currentLocation: null,
    errorMessage: null,
    isServicesEnabled: false,
  };

  private subscribers: Set<(state: LocationServiceState) => void> = new Set();
  private locationUpdateCallbacks: Set<LocationUpdateCallback> = new Set();
  private watchSubscription: Location.LocationSubscription | null = null;
  private backgroundUnsubscribe: (() => void) | null = null;

  // Default location (Geneva/Champel) used as fallback when GPS is unavailable
  private static readonly DEFAULT_LOCATION: UserLocation = {
    latitude: 46.1950,
    longitude: 6.1580,
    altitude: null,
    accuracy: null,
    heading: null,
    speed: null,
    timestamp: Date.now(),
  };

  getState(): LocationServiceState {
    return { ...this.state };
  }

  getCurrentLocation(): UserLocation {
    return this.state.currentLocation ?? LocationService.DEFAULT_LOCATION;
  }

  subscribe(callback: (state: LocationServiceState) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  onLocationUpdate(callback: LocationUpdateCallback): () => void {
    this.locationUpdateCallbacks.add(callback);
    return () => {
      this.locationUpdateCallbacks.delete(callback);
    };
  }

  private notifySubscribers(): void {
    const stateCopy = { ...this.state };
    this.subscribers.forEach((cb) => {
      try {
        cb(stateCopy);
      } catch (e) {
        console.warn('[LocationService] Subscriber error:', e);
      }
    });
  }

  private notifyLocationUpdate(location: UserLocation): void {
    this.locationUpdateCallbacks.forEach((cb) => {
      try {
        cb(location);
      } catch (e) {
        console.warn('[LocationService] Location update callback error:', e);
      }
    });
  }

  /**
   * Check if location services are enabled on the device.
   */
  async checkServicesEnabled(): Promise<boolean> {
    try {
      const enabled = await Location.hasServicesEnabledAsync();
      this.state.isServicesEnabled = enabled;
      if (!enabled) {
        this.state.errorMessage = 'Location services are disabled. Please enable GPS.';
      }
      this.notifySubscribers();
      return enabled;
    } catch (e) {
      console.warn('[LocationService] Failed to check services:', e);
      return false;
    }
  }

  /**
   * Request foreground location permissions.
   */
  async requestPermissions(): Promise<boolean> {
    try {
      const servicesEnabled = await this.checkServicesEnabled();
      if (!servicesEnabled) {
        this.state.hasPermission = false;
        this.state.errorMessage = 'Location services are disabled. Please enable GPS in your device settings.';
        this.notifySubscribers();
        return false;
      }

      const { status } = await Location.requestForegroundPermissionsAsync();
      const granted = status === 'granted';

      this.state.hasPermission = granted;
      if (!granted) {
        this.state.errorMessage = 'Location permission denied. Please grant location access in settings.';
      } else {
        this.state.errorMessage = null;
      }

      this.notifySubscribers();
      return granted;
    } catch (e) {
      console.warn('[LocationService] Permission request failed:', e);
      this.state.hasPermission = false;
      this.state.errorMessage = 'Failed to request location permissions.';
      this.notifySubscribers();
      return false;
    }
  }

  /**
   * Request background location permissions.
   * Must be called after foreground permissions are granted.
   */
  async requestBackgroundPermissions(): Promise<boolean> {
    if (Platform.OS === 'web') {
      console.warn('[LocationService] Background location not available on web.');
      return false;
    }

    try {
      // Ensure foreground permissions first
      if (!this.state.hasPermission) {
        const fgGranted = await this.requestPermissions();
        if (!fgGranted) return false;
      }

      const { status } = await Location.requestBackgroundPermissionsAsync();
      const granted = status === 'granted';

      this.state.hasBackgroundPermission = granted;
      if (!granted) {
        this.state.errorMessage = 'Background location permission denied. Please grant "Always" location access in settings for emergency tracking.';
      } else {
        this.state.errorMessage = null;
      }

      this.notifySubscribers();
      return granted;
    } catch (e) {
      console.warn('[LocationService] Background permission request failed:', e);
      this.state.hasBackgroundPermission = false;
      this.state.errorMessage = 'Failed to request background location permissions.';
      this.notifySubscribers();
      return false;
    }
  }

  /**
   * Get the current position once (snapshot).
   */
  async getCurrentPosition(): Promise<UserLocation> {
    try {
      if (!this.state.hasPermission) {
        const granted = await this.requestPermissions();
        if (!granted) {
          return this.getCurrentLocation();
        }
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      const userLocation = this.mapLocationObject(location);
      this.state.currentLocation = userLocation;
      this.state.errorMessage = null;
      this.notifySubscribers();
      this.notifyLocationUpdate(userLocation);

      return userLocation;
    } catch (e) {
      console.warn('[LocationService] getCurrentPosition failed:', e);
      this.state.errorMessage = 'Failed to get current position.';
      this.notifySubscribers();
      return this.getCurrentLocation();
    }
  }

  /**
   * Start continuous location tracking (foreground only).
   */
  async startTracking(options?: {
    intervalMs?: number;
    distanceMeters?: number;
    accuracy?: Location.Accuracy;
  }): Promise<boolean> {
    if (this.state.isTracking) {
      return true;
    }

    try {
      if (!this.state.hasPermission) {
        const granted = await this.requestPermissions();
        if (!granted) return false;
      }

      const {
        intervalMs = 5000,
        distanceMeters = 5,
        accuracy = Location.Accuracy.High,
      } = options ?? {};

      this.watchSubscription = await Location.watchPositionAsync(
        {
          accuracy,
          timeInterval: intervalMs,
          distanceInterval: distanceMeters,
        },
        (location) => {
          const userLocation = this.mapLocationObject(location);
          this.state.currentLocation = userLocation;
          this.state.errorMessage = null;
          this.notifySubscribers();
          this.notifyLocationUpdate(userLocation);
        }
      );

      this.state.isTracking = true;
      this.state.errorMessage = null;
      this.notifySubscribers();
      return true;
    } catch (e) {
      console.warn('[LocationService] startTracking failed:', e);
      this.state.isTracking = false;
      this.state.errorMessage = 'Failed to start location tracking.';
      this.notifySubscribers();
      return false;
    }
  }

  /**
   * Stop continuous foreground location tracking.
   */
  stopTracking(): void {
    if (this.watchSubscription) {
      this.watchSubscription.remove();
      this.watchSubscription = null;
    }
    this.state.isTracking = false;
    this.notifySubscribers();
  }

  /**
   * Start background location tracking for responders.
   * This allows the app to receive location updates even when backgrounded.
   * Requires background location permissions.
   */
  async startBackgroundTracking(options?: {
    intervalMs?: number;
    distanceMeters?: number;
    accuracy?: Location.Accuracy;
  }): Promise<boolean> {
    if (Platform.OS === 'web') {
      console.warn('[LocationService] Background tracking not available on web.');
      return false;
    }

    if (this.state.isBackgroundTracking) {
      return true;
    }

    try {
      // Request background permissions if not granted
      if (!this.state.hasBackgroundPermission) {
        const granted = await this.requestBackgroundPermissions();
        if (!granted) return false;
      }

      // Check if the task is already registered
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRegistered) {
        // Already running, just update state
        this.state.isBackgroundTracking = true;
        this.notifySubscribers();
        return true;
      }

      const {
        intervalMs = 10000,
        distanceMeters = 10,
        accuracy = Location.Accuracy.Balanced,
      } = options ?? {};

      // Register callback to receive background location updates
      this.backgroundUnsubscribe = onBackgroundLocationUpdate((locations) => {
        if (locations.length > 0) {
          const latest = locations[locations.length - 1];
          const userLocation = this.mapLocationObject(latest);
          this.state.currentLocation = userLocation;
          this.state.errorMessage = null;
          this.notifySubscribers();
          this.notifyLocationUpdate(userLocation);
        }
      });

      // Start background location updates
      await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
        accuracy,
        timeInterval: intervalMs,
        distanceInterval: distanceMeters,
        deferredUpdatesInterval: intervalMs,
        deferredUpdatesDistance: distanceMeters,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: 'Talion Crisis Comm',
          notificationBody: 'Location tracking active for emergency response',
          notificationColor: '#1e3a5f',
          killServiceOnDestroy: false,
        },
      });

      this.state.isBackgroundTracking = true;
      this.state.errorMessage = null;
      this.notifySubscribers();

      console.log('[LocationService] Background tracking started');
      return true;
    } catch (e) {
      console.warn('[LocationService] startBackgroundTracking failed:', e);
      this.state.isBackgroundTracking = false;
      this.state.errorMessage = 'Failed to start background location tracking.';
      this.notifySubscribers();
      return false;
    }
  }

  /**
   * Stop background location tracking.
   */
  async stopBackgroundTracking(): Promise<void> {
    if (Platform.OS === 'web') return;

    try {
      const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
      if (isRegistered) {
        await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
        console.log('[LocationService] Background tracking stopped');
      }
    } catch (e) {
      console.warn('[LocationService] stopBackgroundTracking failed:', e);
    }

    if (this.backgroundUnsubscribe) {
      this.backgroundUnsubscribe();
      this.backgroundUnsubscribe = null;
    }

    this.state.isBackgroundTracking = false;
    this.notifySubscribers();
  }

  /**
   * Check if background tracking is currently active.
   */
  async isBackgroundTrackingActive(): Promise<boolean> {
    if (Platform.OS === 'web') return false;
    try {
      return await TaskManager.isTaskRegisteredAsync(BACKGROUND_LOCATION_TASK);
    } catch {
      return false;
    }
  }

  /**
   * Reverse geocode coordinates to a human-readable address.
   */
  async reverseGeocode(latitude: number, longitude: number): Promise<string | null> {
    try {
      if (Platform.OS === 'web') {
        return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      }

      const results = await Location.reverseGeocodeAsync({ latitude, longitude });
      if (results.length > 0) {
        const addr = results[0];
        const parts = [addr.street, addr.city, addr.region, addr.country].filter(Boolean);
        return parts.join(', ') || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
      }
      return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
    } catch (e) {
      console.warn('[LocationService] reverseGeocode failed:', e);
      return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
    }
  }

  /**
   * Calculate distance between two points in meters (Haversine formula).
   */
  static distanceBetween(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
  ): number {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * Format distance for display.
   */
  static formatDistance(meters: number): string {
    if (meters < 1000) {
      return `${Math.round(meters)}m`;
    }
    return `${(meters / 1000).toFixed(1)}km`;
  }

  /**
   * Map expo-location LocationObject to our UserLocation type.
   */
  private mapLocationObject(location: Location.LocationObject): UserLocation {
    return {
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      altitude: location.coords.altitude,
      accuracy: location.coords.accuracy,
      heading: location.coords.heading,
      speed: location.coords.speed,
      timestamp: location.timestamp,
    };
  }

  /**
   * Cleanup all resources.
   */
  destroy(): void {
    this.stopTracking();
    // Don't await stopBackgroundTracking in destroy, just clean up callbacks
    if (this.backgroundUnsubscribe) {
      this.backgroundUnsubscribe();
      this.backgroundUnsubscribe = null;
    }
    this.state.isBackgroundTracking = false;
    this.subscribers.clear();
    this.locationUpdateCallbacks.clear();
  }
}

// Singleton instance
export const locationService = new LocationService();
export default locationService;
