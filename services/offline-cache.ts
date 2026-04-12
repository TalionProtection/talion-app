/**
 * Offline Cache Service
 * 
 * Provides transparent caching of critical data via AsyncStorage with:
 * - TTL-based expiration per cache key
 * - Automatic fallback to cached data when network is unavailable
 * - Offline action queue (SOS, messages) for retry on reconnect
 * - Sync status tracking (last sync timestamp per resource)
 * - Event emitter for UI updates
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CacheEntry<T = any> {
  data: T;
  timestamp: number;
  ttl: number; // milliseconds
}

export interface QueuedAction {
  id: string;
  type: 'sos' | 'message' | 'status_update' | 'location_update';
  payload: any;
  createdAt: number;
  retryCount: number;
}

export interface SyncStatus {
  alerts: number;
  users: number;
  geofences: number;
  messages: number;
  isOnline: boolean;
  lastOnline: number;
}

type SyncListener = (status: SyncStatus) => void;

// ─── Constants ──────────────────────────────────────────────────────────────

const CACHE_PREFIX = '@offline_cache:';
const QUEUE_KEY = '@offline_queue';
const SYNC_STATUS_KEY = '@sync_status';

// Default TTLs (in milliseconds)
const DEFAULT_TTL = {
  alerts: 5 * 60 * 1000,       // 5 minutes
  users: 15 * 60 * 1000,       // 15 minutes
  geofences: 10 * 60 * 1000,   // 10 minutes
  messages: 5 * 60 * 1000,     // 5 minutes
  conversations: 10 * 60 * 1000, // 10 minutes
};

// ─── Service ────────────────────────────────────────────────────────────────

class OfflineCacheService {
  private listeners: Set<SyncListener> = new Set();
  private syncStatus: SyncStatus = {
    alerts: 0,
    users: 0,
    geofences: 0,
    messages: 0,
    isOnline: true, // Default to online; connectivity check will update
    lastOnline: Date.now(),
  };

  constructor() {
    this.loadSyncStatus();
  }

  // ─── Cache Operations ───────────────────────────────────────────────

  /**
   * Store data in cache with TTL
   */
  async set<T>(key: string, data: T, ttlMs?: number): Promise<void> {
    try {
      const entry: CacheEntry<T> = {
        data,
        timestamp: Date.now(),
        ttl: ttlMs || 10 * 60 * 1000, // default 10 min
      };
      await AsyncStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
    } catch (e) {
      console.warn('[OfflineCache] Failed to set:', key, e);
    }
  }

  /**
   * Get data from cache. Returns null if expired or not found.
   */
  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entry: CacheEntry<T> = JSON.parse(raw);
      const age = Date.now() - entry.timestamp;
      if (age > entry.ttl) {
        // Expired but still return stale data for offline use
        // Caller should check isFresh() separately
        return entry.data;
      }
      return entry.data;
    } catch (e) {
      console.warn('[OfflineCache] Failed to get:', key, e);
      return null;
    }
  }

  /**
   * Check if cached data is still fresh (within TTL)
   */
  async isFresh(key: string): Promise<boolean> {
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return false;
      const entry: CacheEntry = JSON.parse(raw);
      return (Date.now() - entry.timestamp) < entry.ttl;
    } catch {
      return false;
    }
  }

  /**
   * Get cache age in milliseconds
   */
  async getCacheAge(key: string): Promise<number | null> {
    try {
      const raw = await AsyncStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entry: CacheEntry = JSON.parse(raw);
      return Date.now() - entry.timestamp;
    } catch {
      return null;
    }
  }

  /**
   * Remove a specific cache entry
   */
  async remove(key: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(CACHE_PREFIX + key);
    } catch (e) {
      console.warn('[OfflineCache] Failed to remove:', key, e);
    }
  }

  /**
   * Clear all cached data
   */
  async clearAll(): Promise<void> {
    try {
      const keys = await AsyncStorage.getAllKeys();
      const cacheKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
      if (cacheKeys.length > 0) {
        await AsyncStorage.multiRemove(cacheKeys);
      }
    } catch (e) {
      console.warn('[OfflineCache] Failed to clear all:', e);
    }
  }

  // ─── Typed Cache Helpers ────────────────────────────────────────────

  async cacheAlerts(alerts: any[]): Promise<void> {
    await this.set('alerts', alerts, DEFAULT_TTL.alerts);
    this.updateSyncTimestamp('alerts');
  }

  async getCachedAlerts(): Promise<any[] | null> {
    return this.get<any[]>('alerts');
  }

  async cacheUsers(users: any[]): Promise<void> {
    await this.set('users', users, DEFAULT_TTL.users);
    this.updateSyncTimestamp('users');
  }

  async getCachedUsers(): Promise<any[] | null> {
    return this.get<any[]>('users');
  }

  async cacheGeofences(geofences: any[]): Promise<void> {
    await this.set('geofences', geofences, DEFAULT_TTL.geofences);
    this.updateSyncTimestamp('geofences');
  }

  async getCachedGeofences(): Promise<any[] | null> {
    return this.get<any[]>('geofences');
  }

  async cacheMessages(conversationId: string, messages: any[]): Promise<void> {
    await this.set(`messages:${conversationId}`, messages, DEFAULT_TTL.messages);
    this.updateSyncTimestamp('messages');
  }

  async getCachedMessages(conversationId: string): Promise<any[] | null> {
    return this.get<any[]>(`messages:${conversationId}`);
  }

  async cacheConversations(conversations: any[]): Promise<void> {
    await this.set('conversations', conversations, DEFAULT_TTL.conversations);
  }

  async getCachedConversations(): Promise<any[] | null> {
    return this.get<any[]>('conversations');
  }

  // ─── Offline Action Queue ───────────────────────────────────────────

  /**
   * Add an action to the offline queue for later execution
   */
  async enqueueAction(type: QueuedAction['type'], payload: any): Promise<void> {
    try {
      const queue = await this.getQueue();
      const action: QueuedAction = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type,
        payload,
        createdAt: Date.now(),
        retryCount: 0,
      };
      queue.push(action);
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch (e) {
      console.warn('[OfflineCache] Failed to enqueue action:', e);
    }
  }

  /**
   * Get all queued actions
   */
  async getQueue(): Promise<QueuedAction[]> {
    try {
      const raw = await AsyncStorage.getItem(QUEUE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  /**
   * Remove a specific action from the queue (after successful execution)
   */
  async dequeueAction(actionId: string): Promise<void> {
    try {
      const queue = await this.getQueue();
      const filtered = queue.filter(a => a.id !== actionId);
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(filtered));
    } catch (e) {
      console.warn('[OfflineCache] Failed to dequeue action:', e);
    }
  }

  /**
   * Increment retry count for a failed action
   */
  async markRetry(actionId: string): Promise<void> {
    try {
      const queue = await this.getQueue();
      const updated = queue.map(a =>
        a.id === actionId ? { ...a, retryCount: a.retryCount + 1 } : a
      );
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.warn('[OfflineCache] Failed to mark retry:', e);
    }
  }

  /**
   * Clear the entire queue
   */
  async clearQueue(): Promise<void> {
    try {
      await AsyncStorage.removeItem(QUEUE_KEY);
    } catch (e) {
      console.warn('[OfflineCache] Failed to clear queue:', e);
    }
  }

  /**
   * Process queued actions (call this when connectivity is restored)
   */
  async processQueue(executor: (action: QueuedAction) => Promise<boolean>): Promise<{ processed: number; failed: number }> {
    const queue = await this.getQueue();
    let processed = 0;
    let failed = 0;

    for (const action of queue) {
      if (action.retryCount >= 5) {
        // Too many retries, remove from queue
        await this.dequeueAction(action.id);
        failed++;
        continue;
      }
      try {
        const success = await executor(action);
        if (success) {
          await this.dequeueAction(action.id);
          processed++;
        } else {
          await this.markRetry(action.id);
          failed++;
        }
      } catch {
        await this.markRetry(action.id);
        failed++;
      }
    }

    return { processed, failed };
  }

  // ─── Sync Status ────────────────────────────────────────────────────

  private async loadSyncStatus(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(SYNC_STATUS_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        // Restore sync timestamps but always start as online
        // (actual connectivity will be checked by useOffline hook)
        this.syncStatus = {
          ...this.syncStatus,
          ...saved,
          isOnline: true, // Never persist offline state across sessions
        };
      }
    } catch {
      // ignore
    }
  }

  private async saveSyncStatus(): Promise<void> {
    try {
      await AsyncStorage.setItem(SYNC_STATUS_KEY, JSON.stringify(this.syncStatus));
    } catch {
      // ignore
    }
  }

  private updateSyncTimestamp(resource: 'alerts' | 'users' | 'geofences' | 'messages'): void {
    this.syncStatus[resource] = Date.now();
    this.saveSyncStatus();
    this.notifyListeners();
  }

  setOnlineStatus(isOnline: boolean): void {
    const wasOffline = !this.syncStatus.isOnline;
    this.syncStatus.isOnline = isOnline;
    if (isOnline) {
      this.syncStatus.lastOnline = Date.now();
    }
    this.saveSyncStatus();
    this.notifyListeners();

    // If coming back online, log it
    if (isOnline && wasOffline) {
      console.log('[OfflineCache] Back online, queued actions can be processed');
    }
  }

  getSyncStatus(): SyncStatus {
    return { ...this.syncStatus };
  }

  getLastSyncTime(resource: 'alerts' | 'users' | 'geofences' | 'messages'): number {
    return this.syncStatus[resource];
  }

  formatLastSync(resource: 'alerts' | 'users' | 'geofences' | 'messages'): string {
    const ts = this.syncStatus[resource];
    if (!ts) return 'Never';
    const diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  // ─── Event Listeners ────────────────────────────────────────────────

  subscribe(listener: SyncListener): () => void {
    this.listeners.add(listener);
    // Immediately notify with current status
    listener(this.getSyncStatus());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(): void {
    const status = this.getSyncStatus();
    this.listeners.forEach(l => l(status));
  }
}

// Singleton
export const offlineCache = new OfflineCacheService();
export default offlineCache;
