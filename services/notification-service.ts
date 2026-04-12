import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ──────────────────────────────────────────────────────────────────
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface SOSNotificationPayload {
  alertId: string;
  senderName: string;
  senderRole: string;
  alertType: string;
  severity: AlertSeverity;
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
  };
  description?: string;
  timestamp: number;
}

export interface NotificationPreferences {
  sosAlerts: boolean;
  statusUpdates: boolean;
  messages: boolean;
  soundEnabled: boolean;
  vibrationEnabled: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferences = {
  sosAlerts: true,
  statusUpdates: true,
  messages: true,
  soundEnabled: true,
  vibrationEnabled: true,
};

const PREFS_KEY = '@talion_notification_prefs';

// ─── Notification Channels (Android) ────────────────────────────────────────
const CHANNELS = {
  SOS: 'sos-alerts',
  BROADCAST: 'broadcast-alerts',
  STATUS: 'status-updates',
  MESSAGES: 'messages',
  FAMILY: 'family-alerts',
} as const;

// ─── Notification Service ───────────────────────────────────────────────────
class NotificationService {
  private isInitialized = false;
  private preferences: NotificationPreferences = DEFAULT_PREFERENCES;
  private notificationListener: Notifications.EventSubscription | null = null;
  private responseListener: Notifications.EventSubscription | null = null;
  private onNotificationReceived: ((notification: Notifications.Notification) => void) | null = null;
  private onNotificationResponse: ((response: Notifications.NotificationResponse) => void) | null = null;

  /**
   * Initialize the notification service.
   * Sets up handlers, channels, and loads preferences.
   */
  async initialize(): Promise<boolean> {
    if (this.isInitialized) return true;

    try {
      // Set foreground notification handler
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: true,
          shouldShowBanner: true,
          shouldShowList: true,
        }),
      });

      // Set up Android notification channels
      if (Platform.OS === 'android') {
        await this.setupAndroidChannels();
      }

      // Load saved preferences
      await this.loadPreferences();

      // Set up listeners
      this.notificationListener = Notifications.addNotificationReceivedListener(
        (notification) => {
          this.onNotificationReceived?.(notification);
        }
      );

      this.responseListener = Notifications.addNotificationResponseReceivedListener(
        (response) => {
          this.onNotificationResponse?.(response);
        }
      );

      this.isInitialized = true;
      return true;
    } catch (error) {
      console.error('Failed to initialize notification service:', error);
      return false;
    }
  }

  /**
   * Request notification permissions from the user.
   */
  async requestPermissions(): Promise<boolean> {
    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      return finalStatus === 'granted';
    } catch (error) {
      console.error('Failed to request notification permissions:', error);
      return false;
    }
  }

  /**
   * Check if notification permissions are granted.
   */
  async hasPermissions(): Promise<boolean> {
    try {
      const { status } = await Notifications.getPermissionsAsync();
      return status === 'granted';
    } catch {
      return false;
    }
  }

  /**
   * Send an SOS alert notification to the device.
   * In a real app, this would be triggered by the server via push.
   * For now, we use local notifications.
   */
  async sendSOSAlert(payload: SOSNotificationPayload): Promise<string | null> {
    if (!this.preferences.sosAlerts) return null;

    try {
      const severityEmoji = getSeverityEmoji(payload.severity);
      const alertTypeLabel = getAlertTypeLabel(payload.alertType);
      const locationText = payload.location?.address || 'Location shared';

      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: `${severityEmoji} ${payload.severity.toUpperCase()} SOS - ${alertTypeLabel}`,
          body: `${payload.senderName} triggered an alert.\n${locationText}${payload.description ? `\n${payload.description}` : ''}`,
          data: {
            type: 'sos',
            alertId: payload.alertId,
            severity: payload.severity,
            alertType: payload.alertType,
            senderId: payload.senderName,
            location: payload.location,
          },
          sound: true,
          priority: Notifications.AndroidNotificationPriority.MAX,
          ...(Platform.OS === 'android' && { channelId: CHANNELS.SOS }),
        },
        trigger: null, // Immediate
      });

      return notificationId;
    } catch (error) {
      console.error('Failed to send SOS notification:', error);
      return null;
    }
  }

  /**
   * Send a status update notification.
   */
  async sendStatusUpdate(title: string, body: string, data?: Record<string, any>): Promise<string | null> {
    if (!this.preferences.statusUpdates) return null;

    try {
      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          data: { type: 'status', ...data },
          sound: false,
          ...(Platform.OS === 'android' && { channelId: CHANNELS.STATUS }),
        },
        trigger: null,
      });

      return notificationId;
    } catch (error) {
      console.error('Failed to send status notification:', error);
      return null;
    }
  }

  /**
   * Send a broadcast alert notification.
   */
  async sendBroadcastAlert(params: {
    alertId: string;
    severity: string;
    description: string;
    senderName: string;
    address?: string;
  }): Promise<string | null> {
    try {
      const severityEmoji = getSeverityEmoji(params.severity as AlertSeverity);

      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: `${severityEmoji} BROADCAST - ${params.severity.toUpperCase()}`,
          body: `${params.senderName}: ${params.description}${params.address ? `\n\u{1F4CD} ${params.address}` : ''}`,
          data: {
            type: 'broadcast',
            alertId: params.alertId,
            severity: params.severity,
          },
          sound: true,
          priority: Notifications.AndroidNotificationPriority.HIGH,
          ...(Platform.OS === 'android' && { channelId: CHANNELS.BROADCAST }),
        },
        trigger: null, // Immediate
      });

      return notificationId;
    } catch (error) {
      console.error('Failed to send broadcast notification:', error);
      return null;
    }
  }

  /**
   * Send a message notification.
   */
  async sendMessageNotification(
    senderName: string,
    message: string,
    data?: Record<string, any>
  ): Promise<string | null> {
    if (!this.preferences.messages) return null;

    try {
      const notificationId = await Notifications.scheduleNotificationAsync({
        content: {
          title: `Message from ${senderName}`,
          body: message.length > 100 ? message.substring(0, 100) + '...' : message,
          data: { type: 'message', senderName, ...data },
          sound: true,
          ...(Platform.OS === 'android' && { channelId: CHANNELS.MESSAGES }),
        },
        trigger: null,
      });

      return notificationId;
    } catch (error) {
      console.error('Failed to send message notification:', error);
      return null;
    }
  }

  /**
   * Dismiss all notifications.
   */
  async dismissAll(): Promise<void> {
    await Notifications.dismissAllNotificationsAsync();
  }

  /**
   * Get the current badge count.
   */
  async getBadgeCount(): Promise<number> {
    return await Notifications.getBadgeCountAsync();
  }

  /**
   * Set the badge count.
   */
  async setBadgeCount(count: number): Promise<void> {
    await Notifications.setBadgeCountAsync(count);
  }

  /**
   * Set callback for when a notification is received.
   */
  setOnNotificationReceived(callback: (notification: Notifications.Notification) => void): void {
    this.onNotificationReceived = callback;
  }

  /**
   * Set callback for when a notification is tapped.
   */
  setOnNotificationResponse(callback: (response: Notifications.NotificationResponse) => void): void {
    this.onNotificationResponse = callback;
  }

  /**
   * Get notification preferences.
   */
  getPreferences(): NotificationPreferences {
    return { ...this.preferences };
  }

  /**
   * Update notification preferences.
   */
  async updatePreferences(updates: Partial<NotificationPreferences>): Promise<void> {
    this.preferences = { ...this.preferences, ...updates };
    await this.savePreferences();
  }

  /**
   * Clean up listeners.
   */
  cleanup(): void {
    this.notificationListener?.remove();
    this.responseListener?.remove();
    this.notificationListener = null;
    this.responseListener = null;
    this.isInitialized = false;
  }

  // ─── Private Methods ──────────────────────────────────────────────────────

  private async setupAndroidChannels(): Promise<void> {
    await Notifications.setNotificationChannelAsync(CHANNELS.SOS, {
      name: 'SOS Alerts',
      description: 'Critical emergency SOS alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 200, 500, 200, 500],
      lightColor: '#FF0000',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
      bypassDnd: true,
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.BROADCAST, {
      name: 'Broadcast Alerts',
      description: 'Zone broadcast alerts from dispatchers',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 200, 250],
      lightColor: '#F59E0B',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.STATUS, {
      name: 'Status Updates',
      description: 'Responder and incident status changes',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#1E3A5F',
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.MESSAGES, {
      name: 'Messages',
      description: 'New messages from team members',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#3B82F6',
      sound: 'default',
    });

    await Notifications.setNotificationChannelAsync(CHANNELS.FAMILY, {
      name: 'Alertes Famille',
      description: 'Alertes de proximit\u00e9 pour les membres de la famille',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 500, 200, 500],
      lightColor: '#EF4444',
      sound: 'default',
      enableVibrate: true,
      enableLights: true,
    });
  }

  private async loadPreferences(): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem(PREFS_KEY);
      if (stored) {
        this.preferences = { ...DEFAULT_PREFERENCES, ...JSON.parse(stored) };
      }
    } catch {
      this.preferences = DEFAULT_PREFERENCES;
    }
  }

  private async savePreferences(): Promise<void> {
    try {
      await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(this.preferences));
    } catch (error) {
      console.error('Failed to save notification preferences:', error);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function getSeverityEmoji(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical': return '🚨';
    case 'high': return '⚠️';
    case 'medium': return '🔔';
    case 'low': return 'ℹ️';
    default: return '🔔';
  }
}

export function getAlertTypeLabel(type: string): string {
  switch (type) {
    case 'sos': return 'SOS Emergency';
    case 'medical': return 'Medical Emergency';
    case 'fire': return 'Fire Alert';
    case 'accident': return 'Accident Report';
    case 'security': return 'Security Threat';
    case 'broadcast': return 'Broadcast Alert';
    default: return 'Alert';
  }
}

export function getSeverityColor(severity: AlertSeverity): string {
  switch (severity) {
    case 'critical': return '#ef4444';
    case 'high': return '#f97316';
    case 'medium': return '#eab308';
    case 'low': return '#3b82f6';
    default: return '#6b7280';
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
