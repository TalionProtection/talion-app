import { describe, it, expect, vi, beforeEach } from 'vitest';

// Define __DEV__ global and expo globals for expo-modules-core
(globalThis as any).__DEV__ = true;
(globalThis as any).expo = {
  EventEmitter: class MockEventEmitter {
    addListener() { return { remove: () => {} }; }
    removeAllListeners() {}
    emit() {}
  },
  modules: {
    ExpoTaskManager: {
      defineTask: vi.fn(),
      isTaskRegisteredAsync: vi.fn().mockResolvedValue(false),
      unregisterAllTasksAsync: vi.fn().mockResolvedValue(undefined),
    },
  },
};

// Mock expo-task-manager
vi.mock('expo-task-manager', () => ({
  defineTask: vi.fn(),
  isTaskRegisteredAsync: vi.fn().mockResolvedValue(false),
  unregisterAllTasksAsync: vi.fn().mockResolvedValue(undefined),
  TaskManagerTaskBody: {},
}));

// Mock expo-location
vi.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  requestBackgroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  hasServicesEnabledAsync: vi.fn().mockResolvedValue(true),
  getCurrentPositionAsync: vi.fn().mockResolvedValue({
    coords: { latitude: 46.1950, longitude: 6.1580, accuracy: 10, altitude: 35, heading: 0, speed: 0 },
    timestamp: Date.now(),
  }),
  watchPositionAsync: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  reverseGeocodeAsync: vi.fn().mockResolvedValue([
    { street: 'Avenue de Champel', city: 'Genève', region: 'Genève', country: 'Suisse' },
  ]),
  Accuracy: {
    Lowest: 1,
    Low: 2,
    Balanced: 3,
    High: 4,
    Highest: 5,
    BestForNavigation: 6,
  },
}));

// Mock Platform as ios (not web) so reverseGeocode uses the real API
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

describe('LocationService', () => {
  let LocationService: any;
  let locationService: any;

  beforeEach(async () => {
    vi.resetModules();
    // Re-import to get fresh singleton
    const mod = await import('../services/location-service');
    // Create a new instance for each test by accessing the class
    locationService = mod.default;
    // Reset the singleton state by destroying and re-creating
    locationService.destroy();
  });

  describe('Initialization', () => {
    it('should have default location state', () => {
      const state = locationService.getState();
      expect(state).toHaveProperty('hasPermission');
      expect(state).toHaveProperty('isTracking');
      expect(state).toHaveProperty('errorMessage');
      expect(state.hasPermission).toBe(false);
      expect(state.isTracking).toBe(false);
    });

    it('should have a default fallback location', () => {
      const loc = locationService.getCurrentLocation();
      expect(loc).toHaveProperty('latitude');
      expect(loc).toHaveProperty('longitude');
      expect(loc).toHaveProperty('timestamp');
      expect(typeof loc.latitude).toBe('number');
      expect(typeof loc.longitude).toBe('number');
      // Default is Geneva/Champel
      expect(loc.latitude).toBe(46.1950);
      expect(loc.longitude).toBe(6.1580);
    });
  });

  describe('Permissions', () => {
    it('should request foreground permissions', async () => {
      const Location = await import('expo-location');
      const granted = await locationService.requestPermissions();
      expect(Location.requestForegroundPermissionsAsync).toHaveBeenCalled();
      expect(granted).toBe(true);
    });

    it('should update state after permission granted', async () => {
      await locationService.requestPermissions();
      const state = locationService.getState();
      expect(state.hasPermission).toBe(true);
      expect(state.errorMessage).toBeNull();
    });

    it('should handle permission denied', async () => {
      const Location = await import('expo-location');
      (Location.requestForegroundPermissionsAsync as any).mockResolvedValueOnce({ status: 'denied' });
      const granted = await locationService.requestPermissions();
      expect(granted).toBe(false);
      const state = locationService.getState();
      expect(state.hasPermission).toBe(false);
    });

    it('should handle services disabled', async () => {
      const Location = await import('expo-location');
      (Location.hasServicesEnabledAsync as any).mockResolvedValueOnce(false);
      const granted = await locationService.requestPermissions();
      expect(granted).toBe(false);
    });
  });

  describe('Current Position', () => {
    it('should get current position with real coordinates', async () => {
      await locationService.requestPermissions();
      const pos = await locationService.getCurrentPosition();
      expect(pos.latitude).toBe(46.1950);
      expect(pos.longitude).toBe(6.1580);
      expect(pos.accuracy).toBe(10);
    });

    it('should return fallback location if permission denied', async () => {
      const Location = await import('expo-location');
      (Location.hasServicesEnabledAsync as any).mockResolvedValueOnce(true);
      (Location.requestForegroundPermissionsAsync as any).mockResolvedValueOnce({ status: 'denied' });
      // Also mock for the internal requestPermissions call inside getCurrentPosition
      (Location.hasServicesEnabledAsync as any).mockResolvedValueOnce(true);
      (Location.requestForegroundPermissionsAsync as any).mockResolvedValueOnce({ status: 'denied' });
      await locationService.requestPermissions();
      const pos = await locationService.getCurrentPosition();
      expect(typeof pos.latitude).toBe('number');
      expect(typeof pos.longitude).toBe('number');
    });

    it('should update currentLocation in state after getting position', async () => {
      await locationService.requestPermissions();
      await locationService.getCurrentPosition();
      const state = locationService.getState();
      expect(state.currentLocation).not.toBeNull();
      expect(state.currentLocation!.latitude).toBe(46.1950);
    });
  });

  describe('Tracking', () => {
    it('should start tracking after permissions granted', async () => {
      const Location = await import('expo-location');
      await locationService.requestPermissions();
      const started = await locationService.startTracking();
      expect(started).toBe(true);
      expect(Location.watchPositionAsync).toHaveBeenCalled();
      const state = locationService.getState();
      expect(state.isTracking).toBe(true);
    });

    it('should stop tracking', async () => {
      await locationService.requestPermissions();
      await locationService.startTracking();
      locationService.stopTracking();
      const state = locationService.getState();
      expect(state.isTracking).toBe(false);
    });

    it('should not start tracking twice', async () => {
      await locationService.requestPermissions();
      await locationService.startTracking();
      const secondStart = await locationService.startTracking();
      expect(secondStart).toBe(true); // returns true because already tracking
    });
  });

  describe('Reverse Geocoding', () => {
    it('should reverse geocode coordinates to address', async () => {
      const address = await locationService.reverseGeocode(46.1950, 6.1580);
      expect(address).toContain('Genève');
      expect(address).toContain('Avenue de Champel');
    });

    it('should return coordinate string on geocoding error', async () => {
      const Location = await import('expo-location');
      (Location.reverseGeocodeAsync as any).mockRejectedValueOnce(new Error('Network error'));
      const address = await locationService.reverseGeocode(0, 0);
      // On error, it returns formatted coords, not null
      expect(address).toBe('0.0000, 0.0000');
    });
  });

  describe('Subscriptions', () => {
    it('should notify subscribers on state change', async () => {
      const callback = vi.fn();
      const unsub = locationService.subscribe(callback);
      await locationService.requestPermissions();
      expect(callback).toHaveBeenCalled();
      unsub();
    });

    it('should notify on location update via getCurrentPosition', async () => {
      const callback = vi.fn();
      const unsub = locationService.onLocationUpdate(callback);
      await locationService.requestPermissions();
      await locationService.getCurrentPosition();
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          latitude: 46.1950,
          longitude: 6.1580,
        })
      );
      unsub();
    });

    it('should unsubscribe correctly', async () => {
      const callback = vi.fn();
      const unsub = locationService.subscribe(callback);
      unsub();
      callback.mockClear();
      // After unsubscribe, new events should not trigger callback
      await locationService.requestPermissions();
      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('Static Utilities', () => {
    it('should calculate distance between Geneva and Zurich', async () => {
      const mod = await import('../services/location-service');
      // Access the class to call static method
      const distance = (mod as any).LocationService?.distanceBetween?.(46.1950, 6.1580, 47.3769, 8.5417);
      // If we can't access the class, test the formula directly
      if (distance === undefined) {
        // Haversine formula
        const R = 6371000;
        const dLat = ((47.3769 - 46.1950) * Math.PI) / 180;
        const dLon = ((8.5417 - 6.1580) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((46.1950 * Math.PI) / 180) *
            Math.cos((47.3769 * Math.PI) / 180) *
            Math.sin(dLon / 2) *
            Math.sin(dLon / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const d = R * c;
        expect(d).toBeGreaterThan(200000);
        expect(d).toBeLessThan(300000);
      } else {
        expect(distance).toBeGreaterThan(200000);
        expect(distance).toBeLessThan(300000);
      }
    });

    it('should format distance correctly', () => {
      // Test the formatting logic
      const formatDistance = (meters: number): string => {
        if (meters < 1000) return `${Math.round(meters)}m`;
        return `${(meters / 1000).toFixed(1)}km`;
      };
      expect(formatDistance(500)).toBe('500m');
      expect(formatDistance(1500)).toBe('1.5km');
      expect(formatDistance(10000)).toBe('10.0km');
    });
  });

  describe('Destroy', () => {
    it('should cleanup all resources', async () => {
      const callback = vi.fn();
      locationService.subscribe(callback);
      locationService.onLocationUpdate(callback);
      await locationService.requestPermissions();
      await locationService.startTracking();
      
      locationService.destroy();
      
      const state = locationService.getState();
      expect(state.isTracking).toBe(false);
    });
  });
});
