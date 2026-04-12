import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { alertSoundService } from '@/services/alert-sound-service';
import { notificationService } from '@/services/notification-service';
import { offlineCache } from '@/services/offline-cache';

export interface RespondingDetail {
  id: string;
  name: string;
  phone?: string;
  tags?: string[];
  status: string;
  isConnected?: boolean;
}

export interface ServerAlert {
  id: string;
  type: string;
  severity: string;
  location: {
    latitude: number;
    longitude: number;
    address: string;
  };
  description: string;
  createdBy: string;
  createdAt: number;
  status: 'active' | 'acknowledged' | 'resolved';
  respondingUsers: string[];
  respondingNames?: string[];
  respondingDetails?: RespondingDetail[];
  responderStatuses?: Record<string, 'assigned' | 'accepted' | 'en_route' | 'on_scene'>;
}

interface UseAlertsOptions {
  /** Polling interval in ms (default: 10000 = 10s) */
  pollInterval?: number;
  /** Whether to start polling immediately (default: true) */
  autoStart?: boolean;
  /**
   * User role for filtering alerts.
   * - 'user': sees only non-SOS alerts (medical, fire, accident, etc.)
   * - 'dispatcher' | 'responder' | 'admin': sees ALL alerts including SOS
   * - undefined: treated as 'user' (no SOS)
   */
  userRole?: string;
  /** Whether to play sounds when new alerts arrive (default: false) */
  playSounds?: boolean;
}

/**
 * Hook to fetch alerts from the server via REST API with automatic polling.
 * Works reliably on all platforms (web, iOS, Android) without WebSocket.
 * Supports role-based filtering: regular users don't see SOS alerts.
 * Optionally plays sounds when new alerts are detected.
 */
export function useAlerts(options: UseAlertsOptions = {}) {
  const { pollInterval = 10000, autoStart = true, userRole, playSounds = false } = options;
  const [allAlerts, setAllAlerts] = useState<ServerAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);
  const previousAlertIdsRef = useRef<Set<string>>(new Set());
  const isFirstFetchRef = useRef(true);

  const fetchAlerts = useCallback(async () => {
    try {
      const baseUrl = getApiBaseUrl();
      const response = await fetchWithTimeout(`${baseUrl}/alerts`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 10000,
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      const data: ServerAlert[] = await response.json();
      
      if (isMountedRef.current) {
        // Detect new alerts (not on first fetch to avoid playing sounds on app load)
        if (playSounds && !isFirstFetchRef.current) {
          const currentIds = new Set(data.map(a => a.id));
          const newAlerts = data.filter(a => !previousAlertIdsRef.current.has(a.id));
          
          if (newAlerts.length > 0) {
            // Play siren sound for all new alerts (emergency siren)
            // Ensure service is initialized before playing
            await alertSoundService.initialize();
            const hasSOS = newAlerts.some(a => a.type === 'sos');
            
            if (hasSOS) {
              // Full siren for SOS
              alertSoundService.playSiren();
            } else {
              // Short siren for broadcasts and incidents
              alertSoundService.playSirenShort();
            }

            // Trigger local notifications for new broadcast alerts
            const broadcastAlerts = newAlerts.filter(a => a.type === 'broadcast');
            for (const ba of broadcastAlerts) {
              notificationService.sendBroadcastAlert({
                alertId: ba.id,
                severity: ba.severity,
                description: ba.description,
                senderName: ba.createdBy || 'Dispatch',
                address: ba.location?.address,
              });
            }
          }
        }
        
        // Update previous alert IDs for next comparison
        previousAlertIdsRef.current = new Set(data.map(a => a.id));
        isFirstFetchRef.current = false;
        
        setAllAlerts(data);
        setError(null);
        setLastFetched(Date.now());
        setIsLoading(false);
        // Cache alerts for offline use
        offlineCache.cacheAlerts(data);
      }
    } catch (err) {
      console.warn('[useAlerts] Failed to fetch alerts:', err);
      if (isMountedRef.current) {
        // Try to load from offline cache
        offlineCache.getCachedAlerts().then(cached => {
          if (cached && isMountedRef.current) {
            setAllAlerts(cached);
            setError('Offline mode - showing cached data');
            setIsLoading(false);
          } else if (isMountedRef.current) {
            setError(err instanceof Error ? err.message : 'Failed to fetch alerts');
            setIsLoading(false);
          }
        });
      }
    }
  }, [playSounds]);

  const refresh = useCallback(() => {
    return fetchAlerts();
  }, [fetchAlerts]);

  // Initial fetch + polling
  useEffect(() => {
    isMountedRef.current = true;

    if (autoStart) {
      fetchAlerts();
      intervalRef.current = setInterval(fetchAlerts, pollInterval);
    }

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchAlerts, pollInterval, autoStart]);

  // Filter alerts based on user role
  const alerts = useMemo(() => {
    // Only dispatchers, responders, and admins see SOS alerts
    const privilegedRoles = ['dispatcher', 'responder', 'admin'];
    if (userRole && privilegedRoles.includes(userRole)) {
      return allAlerts; // privileged roles see everything
    }
    // Regular users (role='user' or undefined) don't see SOS alerts
    return allAlerts.filter((a) => a.type !== 'sos');
  }, [allAlerts, userRole]);

  return {
    alerts,
    isLoading,
    error,
    lastFetched,
    refresh,
  };
}
