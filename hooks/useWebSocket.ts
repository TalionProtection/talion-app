import { useEffect, useCallback, useRef, useState } from 'react';
import { websocketService, Alert, LocationUpdate, ResponderStatusUpdate } from '@/services/websocket';
import { useAuth } from './useAuth';

export function useWebSocket() {
  const { user } = useAuth();
  const [isConnected, setIsConnected] = useState(false);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [locations, setLocations] = useState<Map<string, LocationUpdate>>(new Map());
  const [responderStatuses, setResponderStatuses] = useState<Map<string, ResponderStatusUpdate>>(new Map());
  const [error, setError] = useState<Error | null>(null);
  const alertsRef = useRef<Map<string, Alert>>(new Map());
  const locationsRef = useRef<Map<string, LocationUpdate>>(new Map());
  const statusesRef = useRef<Map<string, ResponderStatusUpdate>>(new Map());

  // Connect to WebSocket on mount
  useEffect(() => {
    if (!user) return;

    const connect = async () => {
      try {
        await websocketService.connect(user.id, user.role);
        setIsConnected(true);
        setError(null);
      } catch (err) {
        const error = err instanceof Error ? err : new Error('Failed to connect');
        setError(error);
        console.error('WebSocket connection error:', error);
      }
    };

    // Set up event listeners
    const handleConnected = () => setIsConnected(true);
    const handleDisconnected = () => setIsConnected(false);
    const handleError = (err: Error) => setError(err);

    const handleAlert = (alert: Alert) => {
      alertsRef.current.set(alert.id, alert);
      setAlerts(Array.from(alertsRef.current.values()));
    };

    const handleLocation = (location: LocationUpdate) => {
      locationsRef.current.set(location.userId, location);
      setLocations(new Map(locationsRef.current));
    };

    const handleStatus = (status: ResponderStatusUpdate) => {
      statusesRef.current.set(status.userId, status);
      setResponderStatuses(new Map(statusesRef.current));
    };

    websocketService.on('connected', handleConnected);
    websocketService.on('disconnected', handleDisconnected);
    websocketService.on('error', handleError);
    websocketService.on('alert', handleAlert);
    websocketService.on('location', handleLocation);
    websocketService.on('status', handleStatus);

    connect();

    return () => {
      websocketService.off('connected', handleConnected);
      websocketService.off('disconnected', handleDisconnected);
      websocketService.off('error', handleError);
      websocketService.off('alert', handleAlert);
      websocketService.off('location', handleLocation);
      websocketService.off('status', handleStatus);
    };
  }, [user]);

  // Disconnect on unmount
  useEffect(() => {
    return () => {
      websocketService.disconnect();
    };
  }, []);

  const sendAlert = useCallback(
    (alert: Omit<Alert, 'id' | 'createdAt' | 'updatedAt'>) => {
      if (isConnected) {
        websocketService.sendAlert(alert);
      } else {
        throw new Error('WebSocket not connected');
      }
    },
    [isConnected]
  );

  const sendLocation = useCallback(
    (latitude: number, longitude: number, accuracy?: number) => {
      if (isConnected) {
        websocketService.sendLocation(latitude, longitude, accuracy);
      } else {
        throw new Error('WebSocket not connected');
      }
    },
    [isConnected]
  );

  const sendStatusUpdate = useCallback(
    (status: 'available' | 'on_duty' | 'off_duty' | 'responding') => {
      if (isConnected) {
        websocketService.sendStatusUpdate(status);
      } else {
        throw new Error('WebSocket not connected');
      }
    },
    [isConnected]
  );

  const sendMessage = useCallback(
    (recipientId: string, content: string) => {
      if (isConnected) {
        websocketService.sendMessage(recipientId, content);
      } else {
        throw new Error('WebSocket not connected');
      }
    },
    [isConnected]
  );

  const getAlert = useCallback((alertId: string) => {
    return alertsRef.current.get(alertId);
  }, []);

  const getLocation = useCallback((userId: string) => {
    return locationsRef.current.get(userId);
  }, []);

  const getResponderStatus = useCallback((userId: string) => {
    return statusesRef.current.get(userId);
  }, []);

  return {
    isConnected,
    alerts,
    locations,
    responderStatuses,
    error,
    sendAlert,
    sendLocation,
    sendStatusUpdate,
    sendMessage,
    getAlert,
    getLocation,
    getResponderStatus,
  };
}
