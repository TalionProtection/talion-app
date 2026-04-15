import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { useAuth } from '@/hooks/useAuth';

/**
 * Hook that registers the device's Expo push token with the server.
 * Registers for ALL authenticated users so they can receive:
 * - Broadcast alerts (all roles)
 * - SOS push notifications (dispatchers, responders, admins)
 * Automatically registers on login and deregisters on logout.
 */
export function usePushNotifications() {
  const { user } = useAuth();
  const tokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!user) {
      // User logged out - deregister token
      if (tokenRef.current) {
        deregisterToken(tokenRef.current);
        tokenRef.current = null;
      }
      return;
    }

    // Register push tokens for ALL authenticated users
    // All users need broadcast notifications; dispatchers/responders also get SOS notifications
    registerPushToken(user.id, user.role);

    // Ne pas déregistrer à la navigation — seulement à la déconnexion explicite (user === null)
    return () => {};
  }, [user?.id, user?.role]);

  async function registerPushToken(userId: string, userRole: string) {
    try {
      // Skip on web - push tokens are native only
      if (Platform.OS === 'web') {
        console.log('[Push] Skipping push token registration on web');
        return;
      }

      // Check if running on a real device
      if (!Device.isDevice) {
        console.log('[Push] Push notifications require a physical device');
        return;
      }

      // Request permissions
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;
      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }
      if (finalStatus !== 'granted') {
        console.log('[Push] Permission not granted');
        return;
      }

      // Set up Android notification channels
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('sos-alerts', {
          name: 'SOS Alerts',
          importance: Notifications.AndroidImportance.MAX,
          vibrationPattern: [0, 500, 200, 500, 200, 500],
          lightColor: '#FF0000',
          sound: 'default',
          enableVibrate: true,
          enableLights: true,
          bypassDnd: true,
        });

        await Notifications.setNotificationChannelAsync('broadcast-alerts', {
          name: 'Broadcast Alerts',
          importance: Notifications.AndroidImportance.HIGH,
          vibrationPattern: [0, 250, 200, 250],
          lightColor: '#F59E0B',
          sound: 'default',
          enableVibrate: true,
          enableLights: true,
        });
      }

      // Get Expo push token
      const projectId = Constants.expoConfig?.extra?.eas?.projectId;
      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: projectId || undefined,
      });
      const token = tokenData.data;
      tokenRef.current = token;

      console.log(`[Push] Got Expo push token: ${token.substring(0, 20)}...`);

      // Register with server
      const baseUrl = getApiBaseUrl();
      const response = await fetchWithTimeout(`${baseUrl}/api/push-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, userId, userRole }),
        timeout: 10000,
      });

      if (response.ok) {
        console.log(`[Push] Token registered with server for ${userRole}`);
      } else {
        console.warn('[Push] Failed to register token with server:', response.status);
      }
    } catch (error) {
      console.warn('[Push] Error registering push token:', error);
    }
  }

  async function deregisterToken(token: string) {
    try {
      if (Platform.OS === 'web') return;

      const baseUrl = getApiBaseUrl();
      await fetchWithTimeout(`${baseUrl}/api/push-token`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        timeout: 10000,
      });
      console.log('[Push] Token deregistered from server');
    } catch (error) {
      console.warn('[Push] Error deregistering push token:', error);
    }
  }
}
