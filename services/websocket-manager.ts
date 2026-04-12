/**
 * WebSocket Manager - Handles connection to backend WebSocket server
 * Manages authentication, message routing, and reconnection logic
 */

export type WebSocketMessageType =
  | 'auth'
  | 'authSuccess'
  | 'newAlert'
  | 'alertsSnapshot'
  | 'sendAlert'
  | 'alertCreated'
  | 'updateLocation'
  | 'responderLocationUpdate'
  | 'updateStatus'
  | 'responderStatusUpdate'
  | 'acknowledgeAlert'
  | 'alertAcknowledged'
  | 'getAlerts'
  | 'alertsList'
  | 'getResponders'
  | 'respondersList'
  | 'userStatusChange'
  | 'familyLocationUpdate'
  | 'userLocationUpdate'
  | 'proximityAlert'
  | 'alertUpdate'
  | 'alertResolved'
  | 'broadcastNotification'
  | 'pttTransmit'
  | 'pttTransmitAck'
  | 'pttMessage'
  | 'pttJoinChannel'
  | 'pttChannelHistory'
  | 'pttChannelCreated'
  | 'pttChannelDeleted'
  | 'pttStartTalking'
  | 'pttStopTalking'
  | 'pttTalkingStart'
  | 'pttTalkingStop'
  | 'pttEmergency'
  | 'pttEmergencyMessage'
  | 'pttEmergencyAck'
  | 'ping'
  | 'pong'
  | 'error';

export interface WebSocketMessage {
  type: WebSocketMessageType;
  userId?: string;
  userRole?: string;
  data?: any;
  message?: string;
  timestamp?: number;
}

type MessageHandler = (message: WebSocketMessage) => void;

export class WebSocketManager {
  private ws: WebSocket | null = null;
  private url: string;
  private userId: string | null = null;
  private userRole: string | null = null;
  private messageHandlers: Map<WebSocketMessageType, Set<MessageHandler>> = new Map();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // ms
  private isConnecting = false;
  private messageQueue: WebSocketMessage[] = [];
  private pingInterval: ReturnType<typeof setInterval> | null = null;

  constructor(url: string = 'ws://localhost:3000') {
    this.url = url;
  }

  /**
   * Update the server URL (call before connect)
   */
  setUrl(url: string): void {
    this.url = url;
  }

  /**
   * Connect to WebSocket server
   */
  async connect(userId: string, userRole: string): Promise<void> {
    if (this.isConnecting || this.ws?.readyState === WebSocket.OPEN) {
      console.warn('Already connected or connecting');
      return;
    }

    this.isConnecting = true;
    this.userId = userId;
    this.userRole = userRole;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.url);

        this.ws.onopen = () => {
          console.log('WebSocket connected');
          this.isConnecting = false;
          this.reconnectAttempts = 0;

          // Send authentication
          this.send({
            type: 'auth',
            userId,
            userRole,
          });

          this.startPing();
          this.flushMessageQueue();
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const message: WebSocketMessage = JSON.parse(event.data);
            this.handleMessage(message);
          } catch (error) {
            console.error('Failed to parse WebSocket message:', error);
          }
        };

        this.ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          this.isConnecting = false;
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('WebSocket disconnected');
          this.isConnecting = false;
          this.stopPing();
          this.attemptReconnect();
        };
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from WebSocket server
   */
  disconnect(): void {
    this.stopPing();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Send a message to the server
   */
  send(message: WebSocketMessage): void {
    if (!this.userId || !this.userRole) {
      console.warn('Not authenticated');
      return;
    }

    const fullMessage: WebSocketMessage = {
      ...message,
      userId: this.userId,
      userRole: this.userRole,
      timestamp: Date.now(),
    };

    if (this.ws?.readyState === WebSocket.OPEN) {
      const payload = JSON.stringify(fullMessage);
      // Log PTT message sizes for debugging
      if (message.type === 'pttTransmit' || message.type === 'pttEmergency') {
        console.log(`[WS] Sending ${message.type}: payload size = ${(payload.length / 1024).toFixed(1)} KB`);
      }
      try {
        this.ws.send(payload);
      } catch (sendErr) {
        console.error(`[WS] Failed to send ${message.type}:`, sendErr);
        // Queue for retry
        this.messageQueue.push(fullMessage);
      }
    } else {
      // Queue message for later
      console.warn(`[WS] Not connected (state=${this.ws?.readyState}), queuing ${message.type}`);
      this.messageQueue.push(fullMessage);
    }
  }

  /**
   * Subscribe to message type
   */
  on(type: WebSocketMessageType, handler: MessageHandler): () => void {
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set());
    }
    this.messageHandlers.get(type)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.messageHandlers.get(type);
      if (handlers) {
        handlers.delete(handler);
      }
    };
  }

  /**
   * Send alert
   */
  sendAlert(alertData: {
    type: string;
    severity: string;
    location: { latitude: number; longitude: number; address: string };
    description: string;
  }): void {
    this.send({
      type: 'sendAlert',
      data: alertData,
    });
  }

  /**
   * Update location
   */
  updateLocation(location: { latitude: number; longitude: number }): void {
    console.log(`[wsManager] updateLocation: lat=${location.latitude}, lng=${location.longitude}, userId=${this.userId}, connected=${this.ws?.readyState === WebSocket.OPEN}`);
    this.send({
      type: 'updateLocation',
      data: location,
    });
  }

  /**
   * Update responder status
   */
  updateStatus(status: 'available' | 'on_duty' | 'off_duty' | 'responding'): void {
    this.send({
      type: 'updateStatus',
      data: { status },
    });
  }

  /**
   * Acknowledge alert
   */
  acknowledgeAlert(alertId: string): void {
    this.send({
      type: 'acknowledgeAlert',
      data: { alertId },
    });
  }

  /**
   * Get active alerts
   */
  getAlerts(): void {
    this.send({
      type: 'getAlerts',
    });
  }

  /**
   * Get responders (dispatcher only)
   */
  getResponders(): void {
    this.send({
      type: 'getResponders',
    });
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Private methods

  private handleMessage(message: WebSocketMessage): void {
    const handlers = this.messageHandlers.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => handler(message));
    }

    // Log important messages
    if (message.type === 'error') {
      console.error('WebSocket error:', message.message);
    }
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const message = this.messageQueue.shift();
      if (message) {
        this.ws.send(JSON.stringify(message));
      }
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Attempting to reconnect in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      if (this.userId && this.userRole) {
        this.connect(this.userId, this.userRole).catch((error) => {
          console.error('Reconnection failed:', error);
        });
      }
    }, delay);
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.send({ type: 'ping' });
      }
    }, 30000); // Ping every 30 seconds
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

// Export singleton instance - URL will be set dynamically before connect
export const wsManager = new WebSocketManager(
  'ws://localhost:3000' // placeholder, overridden by setUrl() before connect
);
