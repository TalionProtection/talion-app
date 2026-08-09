import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Local-only medication reminders — deliberately no backend route, no server
// storage, no family/dispatch visibility. A missed pill must never trigger a
// security escalation, so this stays entirely on-device: expo-notifications
// daily-repeating local notifications, AsyncStorage-persisted schedule.

export interface MedicationReminder {
  id: string;
  name: string;
  dosage?: string;
  hour: number;
  minute: number;
  active: boolean;
  notificationId?: string;
  createdAt: number;
}

const STORAGE_KEY = '@talion_medication_reminders';
const CHANNEL_ID = 'medication-reminders';

function genId(): string {
  return `med-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class MedicationReminderService {
  private channelReady = false;

  private async setupChannel(): Promise<void> {
    if (this.channelReady || Platform.OS !== 'android') { this.channelReady = true; return; }
    // Deliberately gentle: default importance, no bypassDnd, no urgent
    // vibration pattern — distinct from every other channel in this app,
    // none of which should ever be mistaken for a security alert.
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Rappels médicaments',
      description: 'Rappels de prise de médicaments',
      importance: Notifications.AndroidImportance.DEFAULT,
      sound: 'default',
    });
    this.channelReady = true;
  }

  async getReminders(): Promise<MedicationReminder[]> {
    try {
      const stored = await AsyncStorage.getItem(STORAGE_KEY);
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  }

  private async saveReminders(reminders: MedicationReminder[]): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(reminders));
  }

  async requestPermission(): Promise<boolean> {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === 'granted') return true;
    const req = await Notifications.requestPermissionsAsync();
    return req.status === 'granted';
  }

  async addReminder(input: { name: string; dosage?: string; hour: number; minute: number }): Promise<MedicationReminder> {
    await this.setupChannel();
    const reminder: MedicationReminder = {
      id: genId(), name: input.name, dosage: input.dosage,
      hour: input.hour, minute: input.minute, active: true, createdAt: Date.now(),
    };
    reminder.notificationId = await this.scheduleNotification(reminder).catch(() => undefined);
    const all = await this.getReminders();
    all.push(reminder);
    await this.saveReminders(all);
    return reminder;
  }

  async deleteReminder(id: string): Promise<void> {
    const all = await this.getReminders();
    const reminder = all.find(r => r.id === id);
    if (reminder?.notificationId) {
      await Notifications.cancelScheduledNotificationAsync(reminder.notificationId).catch(() => {});
    }
    await this.saveReminders(all.filter(r => r.id !== id));
  }

  async setActive(id: string, active: boolean): Promise<void> {
    const all = await this.getReminders();
    const reminder = all.find(r => r.id === id);
    if (!reminder) return;
    if (reminder.notificationId) {
      await Notifications.cancelScheduledNotificationAsync(reminder.notificationId).catch(() => {});
      reminder.notificationId = undefined;
    }
    reminder.active = active;
    if (active) {
      reminder.notificationId = await this.scheduleNotification(reminder).catch(() => undefined);
    }
    await this.saveReminders(all);
  }

  private async scheduleNotification(reminder: MedicationReminder): Promise<string> {
    return Notifications.scheduleNotificationAsync({
      content: {
        title: '💊 Rappel médicament',
        body: `${reminder.name}${reminder.dosage ? ` — ${reminder.dosage}` : ''}`,
        data: { type: 'medication_reminder', reminderId: reminder.id },
        sound: true,
        ...(Platform.OS === 'android' && { channelId: CHANNEL_ID }),
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: reminder.hour,
        minute: reminder.minute,
      },
    });
  }

  // Re-schedules any active reminder whose OS-level notification is missing
  // (e.g. after an app reinstall/update cleared expo-notifications' own
  // schedule without touching AsyncStorage). Call once on app start.
  async rehydrate(): Promise<void> {
    if (Platform.OS === 'web') return;
    await this.setupChannel();
    const all = await this.getReminders();
    if (all.length === 0) return;
    const scheduledIds = new Set((await Notifications.getAllScheduledNotificationsAsync()).map(n => n.identifier));
    let changed = false;
    for (const reminder of all) {
      if (!reminder.active) continue;
      if (reminder.notificationId && scheduledIds.has(reminder.notificationId)) continue;
      reminder.notificationId = await this.scheduleNotification(reminder).catch(() => undefined);
      changed = true;
    }
    if (changed) await this.saveReminders(all);
  }
}

export const medicationReminderService = new MedicationReminderService();
