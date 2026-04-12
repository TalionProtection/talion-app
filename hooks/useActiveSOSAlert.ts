import { useState, useEffect, useCallback, useRef } from 'react';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';

export interface ActiveSOSAlert {
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
}

/**
 * Hook to detect if the current user has an active SOS alert.
 * This bypasses the role-based filtering in useAlerts so that even
 * regular users can see their own SOS alert status.
 *
 * Returns the user's active SOS alert (if any) and a refresh function.
 */
export function useActiveSOSAlert(userId: string | undefined) {
  const [activeAlert, setActiveAlert] = useState<ActiveSOSAlert | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const isMountedRef = useRef(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMySOSAlert = useCallback(async () => {
    if (!userId) {
      setActiveAlert(null);
      return;
    }

    try {
      const baseUrl = getApiBaseUrl();
      const response = await fetchWithTimeout(`${baseUrl}/alerts`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 10000,
      });

      if (!response.ok) return;

      const allAlerts: ActiveSOSAlert[] = await response.json();

      if (isMountedRef.current) {
        // Find the user's own active or acknowledged SOS alert
        const mySOSAlert = allAlerts.find(
          (a) =>
            a.type === 'sos' &&
            a.createdBy === userId &&
            (a.status === 'active' || a.status === 'acknowledged')
        );
        setActiveAlert(mySOSAlert || null);
        setIsLoading(false);
      }
    } catch (err) {
      console.warn('[useActiveSOSAlert] Failed to fetch:', err);
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [userId]);

  const refresh = useCallback(() => {
    return fetchMySOSAlert();
  }, [fetchMySOSAlert]);

  useEffect(() => {
    isMountedRef.current = true;
    setIsLoading(true);
    fetchMySOSAlert();

    // Poll every 15 seconds
    intervalRef.current = setInterval(fetchMySOSAlert, 15000);

    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [fetchMySOSAlert]);

  return { activeAlert, isLoading, refresh };
}
