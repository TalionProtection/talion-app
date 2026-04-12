import { useEffect, useState, useRef } from 'react';
import * as Location from 'expo-location';
import { apiService } from '@/services/api';

interface LocationData {
  latitude: number;
  longitude: number;
  accuracy: number;
  altitude: number;
  heading: number;
  speed: number;
}

interface UseLocationOptions {
  userId?: string;
  enabled?: boolean;
  updateInterval?: number; // milliseconds
  onLocationChange?: (location: LocationData) => void;
}

export function useLocation({
  userId,
  enabled = true,
  updateInterval = 5000,
  onLocationChange,
}: UseLocationOptions) {
  const [location, setLocation] = useState<LocationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const watchSubscriptionRef = useRef<Location.LocationSubscription | null>(null);

  useEffect(() => {
    if (!enabled) return;

    let isMounted = true;

    const startLocationTracking = async () => {
      try {
        // Request permissions
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          setError('Location permission denied');
          setIsLoading(false);
          return;
        }

        // Get initial location
        const initialLocation = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });

        if (isMounted) {
          const locationData: LocationData = {
            latitude: initialLocation.coords.latitude,
            longitude: initialLocation.coords.longitude,
            accuracy: initialLocation.coords.accuracy || 0,
            altitude: initialLocation.coords.altitude || 0,
            heading: initialLocation.coords.heading || 0,
            speed: initialLocation.coords.speed || 0,
          };

          setLocation(locationData);
          setError(null);
          setIsLoading(false);

          // Update API with initial location
          if (userId) {
            try {
              await apiService.updateUserLocation(userId, {
                latitude: locationData.latitude,
                longitude: locationData.longitude,
              });
            } catch (err) {
              console.error('Error updating location on server:', err);
            }
          }

          onLocationChange?.(locationData);
        }

        // Watch location changes
        watchSubscriptionRef.current = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: updateInterval,
            distanceInterval: 10, // Update if moved 10 meters
          },
          (newLocation) => {
            if (isMounted) {
              const locationData: LocationData = {
                latitude: newLocation.coords.latitude,
                longitude: newLocation.coords.longitude,
                accuracy: newLocation.coords.accuracy || 0,
                altitude: newLocation.coords.altitude || 0,
                heading: newLocation.coords.heading || 0,
                speed: newLocation.coords.speed || 0,
              };

              setLocation(locationData);
              onLocationChange?.(locationData);

              // Update API with new location
              if (userId) {
                apiService.updateUserLocation(userId, {
                  latitude: locationData.latitude,
                  longitude: locationData.longitude,
                }).catch((err) => {
                  console.error('Error updating location on server:', err);
                });
              }
            }
          }
        );
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Unknown error');
          setIsLoading(false);
        }
      }
    };

    startLocationTracking();

    return () => {
      isMounted = false;
      if (watchSubscriptionRef.current) {
        watchSubscriptionRef.current.remove();
      }
    };
  }, [enabled, userId, updateInterval, onLocationChange]);

  return {
    location,
    error,
    isLoading,
    hasPermission: error === null && location !== null,
  };
}
