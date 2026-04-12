import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  notificationService,
  type SOSNotificationPayload,
  type NotificationPreferences,
} from '@/services/notification-service';
import { alertSoundService } from '@/services/alert-sound-service';
import { useAuth } from '@/hooks/useAuth';

// ─── Types ──────────────────────────────────────────────────────────────────
interface NotificationContextType {
  isPermissionGranted: boolean;
  preferences: NotificationPreferences;
  unreadCount: number;
  requestPermissions: () => Promise<boolean>;
  sendSOSNotification: (payload: SOSNotificationPayload) => Promise<void>;
  sendStatusNotification: (title: string, body: string) => Promise<void>;
  sendMessageNotification: (senderName: string, message: string) => Promise<void>;
  updatePreferences: (updates: Partial<NotificationPreferences>) => Promise<void>;
  clearNotifications: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextType | null>(null);

// ─── Provider ───────────────────────────────────────────────────────────────
export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [isPermissionGranted, setIsPermissionGranted] = useState(false);
  const [preferences, setPreferences] = useState<NotificationPreferences>(
    notificationService.getPreferences()
  );
  const [unreadCount, setUnreadCount] = useState(0);
  const initialized = useRef(false);

  // Initialize notification service
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    const init = async () => {
      await notificationService.initialize();
      await alertSoundService.initialize();

      // Check permissions
      const hasPerms = await notificationService.hasPermissions();
      setIsPermissionGranted(hasPerms);

      // Set up notification received handler
      notificationService.setOnNotificationReceived((notification) => {
        setUnreadCount((prev) => prev + 1);
        console.log('Notification received:', notification.request.content.title);

        // Play appropriate sound based on notification type
        const data = notification.request.content.data;
        if (data?.type === 'sos') {
          alertSoundService.playSOSAlert();
        } else if (data?.type === 'broadcast') {
          alertSoundService.playNotification();
        } else if (data?.type === 'message') {
          alertSoundService.playNotification();
        }
      });

      // Set up notification response handler (when user taps notification)
      notificationService.setOnNotificationResponse((response) => {
        const data = response.notification.request.content.data;
        console.log('Notification tapped:', data);
        // Navigation based on notification type can be handled here
      });
    };

    init();

    return () => {
      notificationService.cleanup();
      alertSoundService.cleanup();
    };
  }, []);

  // Request permissions
  const requestPermissions = useCallback(async (): Promise<boolean> => {
    const granted = await notificationService.requestPermissions();
    setIsPermissionGranted(granted);
    return granted;
  }, []);

  // Send SOS notification (to self and via WebSocket to others)
  const sendSOSNotification = useCallback(
    async (payload: SOSNotificationPayload) => {
      // Only send local notification if user is a responder or dispatcher
      // (users trigger SOS, responders/dispatchers receive alerts)
      if (user?.role === 'responder' || user?.role === 'dispatcher' || user?.role === 'admin') {
        await notificationService.sendSOSAlert(payload);
      }
    },
    [user]
  );

  // Send status notification
  const sendStatusNotification = useCallback(
    async (title: string, body: string) => {
      await notificationService.sendStatusUpdate(title, body);
    },
    []
  );

  // Send message notification
  const sendMessageNotification = useCallback(
    async (senderName: string, message: string) => {
      await notificationService.sendMessageNotification(senderName, message);
    },
    []
  );

  // Update preferences
  const updatePreferences = useCallback(
    async (updates: Partial<NotificationPreferences>) => {
      await notificationService.updatePreferences(updates);
      setPreferences(notificationService.getPreferences());
    },
    []
  );

  // Clear all notifications
  const clearNotifications = useCallback(async () => {
    await notificationService.dismissAll();
    await notificationService.setBadgeCount(0);
    setUnreadCount(0);
  }, []);

  return (
    <NotificationContext.Provider
      value={{
        isPermissionGranted,
        preferences,
        unreadCount,
        requestPermissions,
        sendSOSNotification,
        sendStatusNotification,
        sendMessageNotification,
        updatePreferences,
        clearNotifications,
      }}
    >
      {children}
    </NotificationContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────────
export function useNotifications(): NotificationContextType {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
}
