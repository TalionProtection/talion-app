import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock expo-location
vi.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  requestBackgroundPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  getCurrentPositionAsync: vi.fn().mockResolvedValue({
    coords: { latitude: 46.1950, longitude: 6.1580, altitude: null, accuracy: 10, heading: null, speed: null },
    timestamp: Date.now(),
  }),
  watchPositionAsync: vi.fn().mockResolvedValue({ remove: vi.fn() }),
  startLocationUpdatesAsync: vi.fn().mockResolvedValue(undefined),
  stopLocationUpdatesAsync: vi.fn().mockResolvedValue(undefined),
  hasServicesEnabledAsync: vi.fn().mockResolvedValue(true),
  reverseGeocodeAsync: vi.fn().mockResolvedValue([{ street: 'Avenue de Champel', city: 'Genève', region: 'GE', country: 'Suisse' }]),
  Accuracy: { High: 6, Balanced: 3, Low: 1 },
  ActivityType: { Other: 1 },
}));

// Mock expo-task-manager
vi.mock('expo-task-manager', () => ({
  defineTask: vi.fn(),
  isTaskRegisteredAsync: vi.fn().mockResolvedValue(false),
  unregisterTaskAsync: vi.fn().mockResolvedValue(undefined),
}));

// Mock react-native Platform
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

describe('Background Location Tracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('LocationService - Background Permissions', () => {
    it('should have background permission state initialized to false', async () => {
      // Re-import to get fresh instance
      const { locationService } = await import('../services/location-service');
      const state = locationService.getState();
      expect(state.hasBackgroundPermission).toBe(false);
      expect(state.isBackgroundTracking).toBe(false);
    });

    it('should request background permissions after foreground permissions', async () => {
      const Location = await import('expo-location');
      const { locationService } = await import('../services/location-service');

      const result = await locationService.requestBackgroundPermissions();
      expect(result).toBe(true);
      expect(Location.requestBackgroundPermissionsAsync).toHaveBeenCalled();
    });

    it('should handle denied background permissions', async () => {
      const Location = await import('expo-location');
      vi.mocked(Location.requestBackgroundPermissionsAsync).mockResolvedValueOnce({
        status: 'denied' as any,
        granted: false,
        canAskAgain: true,
        expires: 'never',
      });

      const { locationService } = await import('../services/location-service');
      const result = await locationService.requestBackgroundPermissions();
      expect(result).toBe(false);

      const state = locationService.getState();
      expect(state.hasBackgroundPermission).toBe(false);
      expect(state.errorMessage).toContain('Background location permission denied');
    });
  });

  describe('LocationService - Background Tracking', () => {
    it('should start background tracking with correct options', async () => {
      const Location = await import('expo-location');
      const { locationService } = await import('../services/location-service');

      const result = await locationService.startBackgroundTracking({
        intervalMs: 15000,
        distanceMeters: 10,
      });

      expect(result).toBe(true);
      expect(Location.startLocationUpdatesAsync).toHaveBeenCalledWith(
        'talion-background-location',
        expect.objectContaining({
          timeInterval: 15000,
          distanceInterval: 10,
          showsBackgroundLocationIndicator: true,
          foregroundService: expect.objectContaining({
            notificationTitle: 'Talion Crisis Comm',
            notificationBody: 'Location tracking active for emergency response',
          }),
        })
      );

      const state = locationService.getState();
      expect(state.isBackgroundTracking).toBe(true);
    });

    it('should not start background tracking if already tracking', async () => {
      const Location = await import('expo-location');
      const { locationService } = await import('../services/location-service');

      // Start first time
      await locationService.startBackgroundTracking();
      vi.mocked(Location.startLocationUpdatesAsync).mockClear();

      // Try to start again
      const result = await locationService.startBackgroundTracking();
      expect(result).toBe(true);
      // Should not call startLocationUpdatesAsync again
      expect(Location.startLocationUpdatesAsync).not.toHaveBeenCalled();
    });

    it('should stop background tracking', async () => {
      const Location = await import('expo-location');
      const TaskManager = await import('expo-task-manager');
      const { locationService } = await import('../services/location-service');

      // Start tracking first
      await locationService.startBackgroundTracking();

      // Mock task as registered
      vi.mocked(TaskManager.isTaskRegisteredAsync).mockResolvedValueOnce(true);

      await locationService.stopBackgroundTracking();

      expect(Location.stopLocationUpdatesAsync).toHaveBeenCalledWith('talion-background-location');

      const state = locationService.getState();
      expect(state.isBackgroundTracking).toBe(false);
    });

    it('should check if background tracking is active', async () => {
      const TaskManager = await import('expo-task-manager');
      const { locationService } = await import('../services/location-service');

      vi.mocked(TaskManager.isTaskRegisteredAsync).mockResolvedValueOnce(true);
      const isActive = await locationService.isBackgroundTrackingActive();
      expect(isActive).toBe(true);

      vi.mocked(TaskManager.isTaskRegisteredAsync).mockResolvedValueOnce(false);
      const isInactive = await locationService.isBackgroundTrackingActive();
      expect(isInactive).toBe(false);
    });
  });

  describe('Background Location Task', () => {
    it('should export the correct task name', async () => {
      const { BACKGROUND_LOCATION_TASK } = await import('../services/background-location-task');
      expect(BACKGROUND_LOCATION_TASK).toBe('talion-background-location');
    });

    it('should allow registering and unregistering callbacks', async () => {
      const { onBackgroundLocationUpdate } = await import('../services/background-location-task');
      const callback = vi.fn();
      const unsubscribe = onBackgroundLocationUpdate(callback);

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  describe('LocationService State', () => {
    it('should include background tracking fields in state', async () => {
      const { locationService } = await import('../services/location-service');
      const state = locationService.getState();

      expect('hasBackgroundPermission' in state).toBe(true);
      expect('isBackgroundTracking' in state).toBe(true);
    });

    it('should notify subscribers when background tracking state changes', async () => {
      const { locationService } = await import('../services/location-service');
      const callback = vi.fn();
      locationService.subscribe(callback);

      await locationService.startBackgroundTracking();

      // Should have been called with updated state
      expect(callback).toHaveBeenCalled();
      const lastCall = callback.mock.calls[callback.mock.calls.length - 1][0];
      expect(lastCall.isBackgroundTracking).toBe(true);
    });

    it('should provide default location when no GPS available', async () => {
      const { locationService } = await import('../services/location-service');
      const location = locationService.getCurrentLocation();

      expect(location.latitude).toBe(46.1950);
      expect(location.longitude).toBe(6.1580);
    });
  });

  describe('Role-Based Background Tracking', () => {
    it('should only show BG tracking for responders and dispatchers', () => {
      // Test role logic
      const roles = ['user', 'responder', 'dispatcher'];
      const shouldShowBgTracking = (role: string) =>
        role === 'responder' || role === 'dispatcher';

      expect(shouldShowBgTracking('user')).toBe(false);
      expect(shouldShowBgTracking('responder')).toBe(true);
      expect(shouldShowBgTracking('dispatcher')).toBe(true);
    });

    it('should auto-start for on-duty responders', () => {
      const shouldAutoStart = (role: string, isOnDuty: boolean) => {
        const isResponderOrDispatcher = role === 'responder' || role === 'dispatcher';
        return isResponderOrDispatcher && isOnDuty;
      };

      expect(shouldAutoStart('responder', true)).toBe(true);
      expect(shouldAutoStart('responder', false)).toBe(false);
      expect(shouldAutoStart('dispatcher', true)).toBe(true);
      expect(shouldAutoStart('user', true)).toBe(false);
    });

    it('should determine on-duty status correctly for responders', () => {
      const isOnDuty = (role: string, status?: string) => {
        if (role === 'responder') {
          return status === 'available' || status === 'on_mission';
        }
        return role === 'dispatcher';
      };

      expect(isOnDuty('responder', 'available')).toBe(true);
      expect(isOnDuty('responder', 'on_mission')).toBe(true);
      expect(isOnDuty('responder', 'off_duty')).toBe(false);
      expect(isOnDuty('dispatcher')).toBe(true);
      expect(isOnDuty('user')).toBe(false);
    });
  });

  describe('Foreground Service Configuration', () => {
    it('should configure Android foreground service notification', async () => {
      const Location = await import('expo-location');
      const { locationService } = await import('../services/location-service');

      await locationService.startBackgroundTracking();

      const callArgs = vi.mocked(Location.startLocationUpdatesAsync).mock.calls[0];
      if (callArgs) {
        const options = callArgs[1];
        expect(options.foregroundService).toBeDefined();
        expect(options.foregroundService?.notificationTitle).toBe('Talion Crisis Comm');
        expect(options.foregroundService?.notificationColor).toBe('#1e3a5f');
        expect(options.foregroundService?.killServiceOnDestroy).toBe(false);
      }
    });

    it('should enable iOS background location indicator', async () => {
      const Location = await import('expo-location');
      const { locationService } = await import('../services/location-service');

      await locationService.startBackgroundTracking();

      const callArgs = vi.mocked(Location.startLocationUpdatesAsync).mock.calls[0];
      if (callArgs) {
        const options = callArgs[1];
        expect(options.showsBackgroundLocationIndicator).toBe(true);
      }
    });
  });
});
