export type AlertType = 'sos' | 'medical' | 'fire' | 'accident' | 'other';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved' | 'cancelled';
export type ResponderStatus = 'available' | 'on_duty' | 'off_duty' | 'responding';

export interface Alert {
  id: string;
  userId: string;
  userName: string;
  type: AlertType;
  status: AlertStatus;
  location: {
    latitude: number;
    longitude: number;
    address?: string;
  };
  description: string;
  createdAt: number;
  updatedAt: number;
  respondersAssigned?: string[];
  respondingUsers?: string[];
  respondingNames?: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface LocationUpdate {
  userId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  timestamp: number;
}

export interface ResponderStatusUpdate {
  userId: string;
  status: ResponderStatus;
  timestamp: number;
}

export interface PTTTransmission {
  senderId: string;
  senderName: string;
  senderRole: string;
  channelId: string;
  audioData: string; // base64 encoded audio
  duration: number;
  timestamp: number;
}

export interface WebSocketMessage {
  type: 'alert' | 'location' | 'status' | 'message' | 'ptt' | 'ping' | 'pong';
  data: any;
  timestamp: number;
}

class WebSocketService {
  private listeners: Map<string, Function[]> = new Map();
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 3000;
  private isConnecting = false;
  private messageQueue: WebSocketMessage[] = [];
  private userId: string | null = null;
  private userRole: string | null = null;
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(url: string = 'ws://localhost:3000') {
    this.url = url;
  }

  /**
   * Update the server URL (call before connect)
   */
  setUrl(url: string): void {
    this.url = url;
  }

  on(event: string, callback: Function) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(callback);
  }

  off(event: string, callback: Function) {
    if (!this.listeners.has(event)) return;
    const callbacks = this.listeners.get(event)!;
    const index = callbacks.indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
    }
  }

  private emit(event: string, data?: any) {
    if (!this.listeners.has(event)) return;
    this.listeners.get(event)!.forEach((callback) => callback(data));
  }

  /**
   * Connect to WebSocket server
   */
  connect(userId: string, userRole: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isConnecting) {
        reject(new Error('Connection already in progress'));
        return;
      }

      this.isConnecting = true;
      this.userId = userId;
      this.userRole = userRole;

      try {
        this.ws = new WebSocket(`${this.url}?userId=${userId}&role=${userRole}`);

        this.ws.onopen = () => {
          console.log('WebSocket connected');
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.emit('connected', undefined);
          this.flushMessageQueue();
          this.startPingInterval();
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
          const err = error instanceof Error ? error : new Error(String(error));
          this.emit('error', err);
          this.isConnecting = false;
          reject(err);
        };

        this.ws.onclose = () => {
          console.log('WebSocket disconnected');
          this.isConnecting = false;
          this.stopPingInterval();
          this.emit('disconnected', undefined);
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
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.messageQueue = [];
  }

  /**
   * Send alert to server
   */
  sendAlert(alert: Omit<Alert, 'id' | 'createdAt' | 'updatedAt'>): void {
    const message: WebSocketMessage = {
      type: 'alert',
      data: {
        ...alert,
        userId: this.userId,
      },
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * Send location update
   */
  sendLocation(latitude: number, longitude: number, accuracy?: number): void {
    const message: WebSocketMessage = {
      type: 'location',
      data: {
        userId: this.userId,
        latitude,
        longitude,
        accuracy,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * Send status update (for responders)
   */
  sendStatusUpdate(status: ResponderStatus): void {
    const message: WebSocketMessage = {
      type: 'status',
      data: {
        userId: this.userId,
        status,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * Send PTT voice transmission
   */
  sendPTT(transmission: PTTTransmission): void {
    const message: WebSocketMessage = {
      type: 'ptt',
      data: transmission,
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * Send chat message
   */
  sendMessage(recipientId: string, content: string): void {
    const message: WebSocketMessage = {
      type: 'message',
      data: {
        senderId: this.userId,
        recipientId,
        content,
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };
    this.send(message);
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Private methods
   */

  private send(message: WebSocketMessage): void {
    if (this.isConnected()) {
      try {
        this.ws!.send(JSON.stringify(message));
      } catch (error) {
        console.error('Failed to send WebSocket message:', error);
        this.messageQueue.push(message);
      }
    } else {
      this.messageQueue.push(message);
    }
  }

  private handleMessage(message: WebSocketMessage): void {
    switch (message.type) {
      case 'alert':
        this.emit('alert', message.data);
        break;
      case 'location':
        this.emit('location', message.data);
        break;
      case 'status':
        this.emit('status', message.data);
        break;
      case 'message':
        this.emit('message', message.data);
        break;
      case 'ptt':
        this.emit('ptt', message.data);
        break;
      case 'pong':
        // Handle pong response
        break;
      default:
        console.warn('Unknown message type:', message.type);
    }
  }

  private flushMessageQueue(): void {
    while (this.messageQueue.length > 0 && this.isConnected()) {
      const message = this.messageQueue.shift();
      if (message) {
        this.send(message);
      }
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
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
    } else {
      console.error('Max reconnection attempts reached');
      this.emit('reconnect_failed');
    }
  }

  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      if (this.isConnected()) {
        const message: WebSocketMessage = {
          type: 'ping',
          data: {},
          timestamp: Date.now(),
        };
        this.send(message);
      }
    }, 30000); // Ping every 30 seconds
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

// Export singleton instance
export const websocketService = new WebSocketService(
  process.env.EXPO_PUBLIC_WS_URL || 'ws://localhost:3000'
);
