import React, { useEffect, useRef } from 'react';
import { wsManager } from '@/services/websocket-manager';
import type { WebSocketMessage } from '@/services/websocket-manager';

/**
 * Hook to manage WebSocket connection lifecycle
 * Automatically connects on mount and disconnects on unmount
 */
export function useWebSocketConnection(userId: string | null, userRole: string | null) {
  const isConnectedRef = useRef(false);

  useEffect(() => {
    if (!userId || !userRole) {
      return;
    }

    // Connect to WebSocket
    wsManager.connect(userId, userRole).catch((error) => {
      console.error('Failed to connect to WebSocket:', error);
    });

    isConnectedRef.current = true;

    // Cleanup on unmount
    return () => {
      if (isConnectedRef.current) {
        wsManager.disconnect();
        isConnectedRef.current = false;
      }
    };
  }, [userId, userRole]);

  return wsManager;
}

/**
 * Hook to listen for specific WebSocket message types
 */
export function useWebSocketMessage(
  messageType: string,
  handler: (message: WebSocketMessage) => void
) {
  useEffect(() => {
    const unsubscribe = wsManager.on(messageType as any, handler);
    return unsubscribe;
  }, [messageType, handler]);
}

/**
 * Hook to get WebSocket connection status
 */
export function useWebSocketStatus() {
  const [isConnected, setIsConnected] = React.useState(wsManager.isConnected());

  useEffect(() => {
    // Check connection status periodically
    const interval = setInterval(() => {
      setIsConnected(wsManager.isConnected());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  return isConnected;
}
