/**
 * useOffline Hook
 * 
 * Provides offline status, sync timestamps, and queue info to components.
 * Monitors network connectivity and updates the offline cache service.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { Platform, AppState } from 'react-native';
import { offlineCache, type SyncStatus, type QueuedAction } from '@/services/offline-cache';
import { processOfflineQueue } from '@/services/offline-queue-processor';
import { getApiBaseUrl } from '@/lib/server-url';

export interface OfflineState {
  isOnline: boolean;
  syncStatus: SyncStatus;
  queuedActions: number;
  lastSync: {
    alerts: string;
    users: string;
    geofences: string;
    messages: string;
  };
}

/**
 * Hook that tracks online/offline status and sync state.
 * Automatically polls network availability and updates the cache service.
 */
export function useOffline(): OfflineState {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>(offlineCache.getSyncStatus());
  const [queuedActions, setQueuedActions] = useState(0);
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Subscribe to sync status changes
  useEffect(() => {
    const unsubscribe = offlineCache.subscribe((status) => {
      setSyncStatus(status);
    });
    return unsubscribe;
  }, []);

  // Load queued actions count
  const refreshQueueCount = useCallback(async () => {
    const queue = await offlineCache.getQueue();
    setQueuedActions(queue.length);
  }, []);

  // Check network connectivity
  const wasOnlineRef = useRef(syncStatus.isOnline);

  const checkConnectivity = useCallback(async () => {
    try {
      // Simple connectivity check - try to reach the API
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      // Use the same URL resolution as the rest of the app
      const baseUrl = getApiBaseUrl();
      
      const res = await fetch(`${baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const isNowOnline = res.ok;
      offlineCache.setOnlineStatus(isNowOnline);

      // Process offline queue when coming back online
      if (isNowOnline && !wasOnlineRef.current) {
        processOfflineQueue().then(() => refreshQueueCount());
      }
      wasOnlineRef.current = isNowOnline;
    } catch {
      wasOnlineRef.current = false;
      offlineCache.setOnlineStatus(false);
    }
    refreshQueueCount();
  }, [refreshQueueCount]);

  // Periodic connectivity check
  useEffect(() => {
    checkConnectivity();
    checkIntervalRef.current = setInterval(checkConnectivity, 15000);
    return () => {
      if (checkIntervalRef.current) clearInterval(checkIntervalRef.current);
    };
  }, [checkConnectivity]);

  // Check on app state change (foreground/background)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        checkConnectivity();
      }
    });
    return () => subscription.remove();
  }, [checkConnectivity]);

  return {
    isOnline: syncStatus.isOnline,
    syncStatus,
    queuedActions,
    lastSync: {
      alerts: offlineCache.formatLastSync('alerts'),
      users: offlineCache.formatLastSync('users'),
      geofences: offlineCache.formatLastSync('geofences'),
      messages: offlineCache.formatLastSync('messages'),
    },
  };
}

/**
 * Helper hook to fetch data with offline fallback.
 * Tries network first, falls back to cache, and caches successful responses.
 */
export function useOfflineFetch<T>(
  cacheKey: string,
  fetcher: () => Promise<T>,
  options?: {
    ttlMs?: number;
    enabled?: boolean;
    refreshInterval?: number;
  }
): {
  data: T | null;
  isLoading: boolean;
  isStale: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isStale, setIsStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { isOnline } = useOffline();

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Try network first
      const result = await fetcher();
      setData(result);
      setIsStale(false);
      // Cache the result
      await offlineCache.set(cacheKey, result, options?.ttlMs);
    } catch (e) {
      // Network failed, try cache
      const cached = await offlineCache.get<T>(cacheKey);
      if (cached !== null) {
        setData(cached);
        setIsStale(true);
        setError('Using cached data (offline)');
      } else {
        setError('No data available offline');
      }
    } finally {
      setIsLoading(false);
    }
  }, [cacheKey, fetcher, options?.ttlMs]);

  // Initial fetch
  useEffect(() => {
    if (options?.enabled === false) return;
    fetchData();
  }, [fetchData, options?.enabled]);

  // Refresh interval
  useEffect(() => {
    if (!options?.refreshInterval || options?.enabled === false) return;
    const interval = setInterval(fetchData, options.refreshInterval);
    return () => clearInterval(interval);
  }, [fetchData, options?.refreshInterval, options?.enabled]);

  // Re-fetch when coming back online
  useEffect(() => {
    if (isOnline && isStale) {
      fetchData();
    }
  }, [isOnline, isStale, fetchData]);

  return { data, isLoading, isStale, error, refresh: fetchData };
}
