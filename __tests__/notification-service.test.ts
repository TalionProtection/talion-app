import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock expo-notifications
vi.mock('expo-notifications', () => ({
  setNotificationHandler: vi.fn(),
  setNotificationChannelAsync: vi.fn().mockResolvedValue(undefined),
  getPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  requestPermissionsAsync: vi.fn().mockResolvedValue({ status: 'granted' }),
  scheduleNotificationAsync: vi.fn().mockResolvedValue('notif-123'),
  dismissAllNotificationsAsync: vi.fn().mockResolvedValue(undefined),
  getBadgeCountAsync: vi.fn().mockResolvedValue(0),
  setBadgeCountAsync: vi.fn().mockResolvedValue(undefined),
  addNotificationReceivedListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
  addNotificationResponseReceivedListener: vi.fn().mockReturnValue({ remove: vi.fn() }),
  AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3 },
  AndroidNotificationPriority: { MAX: 'max' },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));

// Mock AsyncStorage
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock Platform
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import {
  getSeverityEmoji,
  getAlertTypeLabel,
  getSeverityColor,
  type SOSNotificationPayload,
} from '../services/notification-service';

describe('Notification Service Helpers', () => {
  describe('getSeverityEmoji', () => {
    it('returns correct emoji for critical severity', () => {
      expect(getSeverityEmoji('critical')).toBe('🚨');
    });

    it('returns correct emoji for high severity', () => {
      expect(getSeverityEmoji('high')).toBe('⚠️');
    });

    it('returns correct emoji for medium severity', () => {
      expect(getSeverityEmoji('medium')).toBe('🔔');
    });

    it('returns correct emoji for low severity', () => {
      expect(getSeverityEmoji('low')).toBe('ℹ️');
    });
  });

  describe('getAlertTypeLabel', () => {
    it('returns correct label for SOS', () => {
      expect(getAlertTypeLabel('sos')).toBe('SOS Emergency');
    });

    it('returns correct label for medical', () => {
      expect(getAlertTypeLabel('medical')).toBe('Medical Emergency');
    });

    it('returns correct label for fire', () => {
      expect(getAlertTypeLabel('fire')).toBe('Fire Alert');
    });

    it('returns correct label for accident', () => {
      expect(getAlertTypeLabel('accident')).toBe('Accident Report');
    });

    it('returns correct label for security', () => {
      expect(getAlertTypeLabel('security')).toBe('Security Threat');
    });

    it('returns default label for unknown type', () => {
      expect(getAlertTypeLabel('unknown')).toBe('Alert');
    });
  });

  describe('getSeverityColor', () => {
    it('returns red for critical', () => {
      expect(getSeverityColor('critical')).toBe('#ef4444');
    });

    it('returns orange for high', () => {
      expect(getSeverityColor('high')).toBe('#f97316');
    });

    it('returns yellow for medium', () => {
      expect(getSeverityColor('medium')).toBe('#eab308');
    });

    it('returns blue for low', () => {
      expect(getSeverityColor('low')).toBe('#3b82f6');
    });
  });

  describe('SOSNotificationPayload type', () => {
    it('accepts valid payload', () => {
      const payload: SOSNotificationPayload = {
        alertId: 'sos-123',
        senderName: 'John Doe',
        senderRole: 'user',
        alertType: 'sos',
        severity: 'critical',
        location: {
          latitude: 40.7128,
          longitude: -74.006,
          address: '123 Main St',
        },
        description: 'Emergency at location',
        timestamp: Date.now(),
      };

      expect(payload.alertId).toBe('sos-123');
      expect(payload.senderName).toBe('John Doe');
      expect(payload.severity).toBe('critical');
      expect(payload.location?.latitude).toBe(40.7128);
      expect(payload.location?.longitude).toBe(-74.006);
    });

    it('accepts payload without optional fields', () => {
      const payload: SOSNotificationPayload = {
        alertId: 'sos-456',
        senderName: 'Jane Doe',
        senderRole: 'responder',
        alertType: 'medical',
        severity: 'high',
        timestamp: Date.now(),
      };

      expect(payload.alertId).toBe('sos-456');
      expect(payload.location).toBeUndefined();
      expect(payload.description).toBeUndefined();
    });
  });
});

describe('Notification Service Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('notification service module exports correctly', async () => {
    const mod = await import('../services/notification-service');
    expect(mod.notificationService).toBeDefined();
    expect(typeof mod.notificationService.initialize).toBe('function');
    expect(typeof mod.notificationService.requestPermissions).toBe('function');
    expect(typeof mod.notificationService.sendSOSAlert).toBe('function');
    expect(typeof mod.notificationService.sendStatusUpdate).toBe('function');
    expect(typeof mod.notificationService.sendMessageNotification).toBe('function');
    expect(typeof mod.notificationService.dismissAll).toBe('function');
    expect(typeof mod.notificationService.cleanup).toBe('function');
  });

  it('initializes notification service', async () => {
    const mod = await import('../services/notification-service');
    const result = await mod.notificationService.initialize();
    expect(result).toBe(true);
  });

  it('requests permissions successfully', async () => {
    const mod = await import('../services/notification-service');
    const result = await mod.notificationService.requestPermissions();
    expect(result).toBe(true);
  });

  it('checks permissions', async () => {
    const mod = await import('../services/notification-service');
    const result = await mod.notificationService.hasPermissions();
    expect(result).toBe(true);
  });

  it('sends SOS alert notification', async () => {
    const Notifications = await import('expo-notifications');
    const mod = await import('../services/notification-service');

    const payload: SOSNotificationPayload = {
      alertId: 'sos-test',
      senderName: 'Test User',
      senderRole: 'user',
      alertType: 'sos',
      severity: 'critical',
      location: { latitude: 40.7128, longitude: -74.006, address: 'Test Location' },
      description: 'Test SOS alert',
      timestamp: Date.now(),
    };

    const notifId = await mod.notificationService.sendSOSAlert(payload);
    expect(notifId).toBe('notif-123');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
  });

  it('sends status update notification', async () => {
    const Notifications = await import('expo-notifications');
    const mod = await import('../services/notification-service');

    const notifId = await mod.notificationService.sendStatusUpdate('Test Title', 'Test Body');
    expect(notifId).toBe('notif-123');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
  });

  it('sends message notification', async () => {
    const Notifications = await import('expo-notifications');
    const mod = await import('../services/notification-service');

    const notifId = await mod.notificationService.sendMessageNotification('Sender', 'Hello!');
    expect(notifId).toBe('notif-123');
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalled();
  });

  it('dismisses all notifications', async () => {
    const Notifications = await import('expo-notifications');
    const mod = await import('../services/notification-service');

    await mod.notificationService.dismissAll();
    expect(Notifications.dismissAllNotificationsAsync).toHaveBeenCalled();
  });

  it('gets and sets badge count', async () => {
    const Notifications = await import('expo-notifications');
    const mod = await import('../services/notification-service');

    const count = await mod.notificationService.getBadgeCount();
    expect(count).toBe(0);

    await mod.notificationService.setBadgeCount(5);
    expect(Notifications.setBadgeCountAsync).toHaveBeenCalledWith(5);
  });

  it('gets default preferences', async () => {
    const mod = await import('../services/notification-service');
    const prefs = mod.notificationService.getPreferences();
    expect(prefs.sosAlerts).toBe(true);
    expect(prefs.statusUpdates).toBe(true);
    expect(prefs.messages).toBe(true);
    expect(prefs.soundEnabled).toBe(true);
    expect(prefs.vibrationEnabled).toBe(true);
  });

  it('cleans up listeners', async () => {
    const mod = await import('../services/notification-service');
    mod.notificationService.cleanup();
    // Should not throw
    expect(true).toBe(true);
  });
});
