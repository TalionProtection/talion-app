import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { wsManager, type WebSocketMessage } from '@/services/websocket-manager';
import { websocketService } from '@/services/websocket';
import { getWsUrl } from '@/lib/server-url';

/**
 * WebSocket Provider
 * 
 * Resolves the correct server URL dynamically (handles real devices, web, and dev),
 * then connects the protocol-correct wsManager at app startup when a user is authenticated.
 * Also bridges incoming events to the old websocketService so existing screens
 * (index, dispatcher, explore, messaging) continue to work.
 */

interface WebSocketContextType {
  isConnected: boolean;
  sendAlert: (alertData: {
    type: string;
    severity: string;
    location: { latitude: number; longitude: number; address: string };
    description: string;
  }) => void;
  sendLocation: (location: { latitude: number; longitude: number }) => void;
  sendStatus: (status: 'available' | 'on_duty' | 'off_duty' | 'responding') => void;
}

const WebSocketContext = createContext<WebSocketContextType>({
  isConnected: false,
  sendAlert: () => {},
  sendLocation: () => {},
  sendStatus: () => {},
});

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const connectedRef = useRef(false);
  const statusPollRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!user?.id || !user?.role) {
      return;
    }

    const userId = user.id;
    const userRole = user.role;

    // ─── Resolve the correct WebSocket URL dynamically ───
    const wsUrl = getWsUrl();
    console.log(`[WebSocketProvider] Resolved WebSocket URL: ${wsUrl}`);

    // Set the URL on both services before connecting
    wsManager.setUrl(wsUrl);
    websocketService.setUrl(wsUrl);

    // Connect the protocol-correct wsManager
    wsManager.connect(userId, userRole).then(() => {
      connectedRef.current = true;
      setIsConnected(true);
      console.log('[WebSocketProvider] Connected via wsManager');
    }).catch((error) => {
      console.error('[WebSocketProvider] Failed to connect wsManager:', error);
    });

    // Also connect the old websocketService for backward compatibility
    // (messaging context and other screens use it)
    websocketService.connect(userId, userRole).catch((error) => {
      console.warn('[WebSocketProvider] Old websocketService connect failed (expected):', error);
    });

    // Bridge wsManager events to old websocketService event system
    // so existing screens that listen on websocketService.on('newAlert', ...) still work
    const unsubNewAlert = wsManager.on('newAlert', (msg: WebSocketMessage) => {
      (websocketService as any).emit?.('newAlert', msg.data);
      (websocketService as any).emit?.('alert', msg.data);
    });

    const unsubAlertUpdate = wsManager.on('alertUpdate' as any, (msg: WebSocketMessage) => {
      (websocketService as any).emit?.('alertUpdate', msg.data);
    });

    // Listen for new alerts via WS and trigger siren + local notification immediately
    const unsubBroadcastNotif = wsManager.on('newAlert', (msg: WebSocketMessage) => {
      const alertType = msg.data?.type;
      // Play siren sound for all incoming alerts (ensure initialized first)
      import('@/services/alert-sound-service').then(async ({ alertSoundService }) => {
        await alertSoundService.initialize();
        if (alertType === 'sos') {
          alertSoundService.playSiren(); // Full siren for SOS
        } else {
          alertSoundService.playSirenShort(); // Short siren for broadcasts/incidents
        }
      });
      // Trigger local notification for broadcast alerts
      if (alertType === 'broadcast') {
        import('@/services/notification-service').then(({ notificationService }) => {
          notificationService.sendBroadcastAlert({
            alertId: msg.data.id || '',
            severity: msg.data.severity || 'medium',
            description: msg.data.description || '',
            senderName: msg.data.createdBy || 'Dispatch',
            address: msg.data.location?.address,
          });
        });
      }
    });

    const unsubAlertAck = wsManager.on('alertAcknowledged', (msg: WebSocketMessage) => {
      (websocketService as any).emit?.('alertAcknowledged', msg);
    });

    const unsubAlertResolved = wsManager.on('alertResolved' as any, (msg: WebSocketMessage) => {
      (websocketService as any).emit?.('alertResolved', msg);
    });

    const unsubLocationUpdate = wsManager.on('responderLocationUpdate', (msg: WebSocketMessage) => {
      (websocketService as any).emit?.('location', msg);
      (websocketService as any).emit?.('locationUpdate', msg);
    });

    const unsubStatusUpdate = wsManager.on('responderStatusUpdate', (msg: WebSocketMessage) => {
      (websocketService as any).emit?.('status', msg);
      (websocketService as any).emit?.('statusUpdate', msg);
    });

    // Bridge family location updates to legacy event system
    const unsubFamilyLocation = wsManager.on('familyLocationUpdate', (msg: WebSocketMessage) => {
      (websocketService as any).emit?.('familyLocation', msg);
    });

    // Bridge proximity alerts (family perimeter exit/entry)
    const unsubProximityAlert = wsManager.on('proximityAlert', (msg: WebSocketMessage) => {
      (websocketService as any).emit?.('proximityAlert', msg);
    });

    const unsubAlertsSnapshot = wsManager.on('alertsSnapshot', (msg: WebSocketMessage) => {
      if (Array.isArray(msg.data)) {
        msg.data.forEach((alert: any) => {
          (websocketService as any).emit?.('newAlert', alert);
          (websocketService as any).emit?.('alert', alert);
        });
      }
    });

    // Poll connection status
    statusPollRef.current = setInterval(() => {
      const connected = wsManager.isConnected();
      if (connected !== connectedRef.current) {
        connectedRef.current = connected;
        setIsConnected(connected);
      }
    }, 2000);

    return () => {
      unsubNewAlert();
      unsubAlertUpdate();
      unsubBroadcastNotif();
      unsubAlertAck();
      unsubAlertResolved();
      unsubLocationUpdate();
      unsubFamilyLocation();
      unsubProximityAlert();
      unsubStatusUpdate();
      unsubAlertsSnapshot();
      
      if (statusPollRef.current) {
        clearInterval(statusPollRef.current);
      }

      wsManager.disconnect();
      websocketService.disconnect();
      connectedRef.current = false;
      setIsConnected(false);
    };
  }, [user?.id, user?.role]);

  const sendAlert = useCallback((alertData: {
    type: string;
    severity: string;
    location: { latitude: number; longitude: number; address: string };
    description: string;
  }) => {
    if (wsManager.isConnected()) {
      wsManager.sendAlert(alertData);
      console.log('[WebSocketProvider] Alert sent via wsManager:', alertData.type);
    } else {
      console.warn('[WebSocketProvider] Cannot send alert - not connected');
    }
  }, []);

  const sendLocation = useCallback((location: { latitude: number; longitude: number }) => {
    const connected = wsManager.isConnected();
    console.log(`[WebSocketProvider] sendLocation called: connected=${connected}, lat=${location.latitude}, lng=${location.longitude}`);
    if (connected) {
      wsManager.updateLocation(location);
    } else {
      console.warn('[WebSocketProvider] Cannot send location - WebSocket not connected');
    }
  }, []);

  const sendStatus = useCallback((status: 'available' | 'on_duty' | 'off_duty' | 'responding') => {
    if (wsManager.isConnected()) {
      wsManager.updateStatus(status);
    }
  }, []);

  return (
    <WebSocketContext.Provider value={{ isConnected, sendAlert, sendLocation, sendStatus }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocketProvider() {
  return useContext(WebSocketContext);
}
