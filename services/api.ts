/**
 * API Service — attache automatiquement le JWT Supabase sur chaque requête.
 * Importe `supabase` depuis auth-context pour récupérer la session active.
 */
import axios, { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { getApiBaseUrl } from '@/lib/server-url';
import { supabase } from '@/lib/auth-context';

class APIService {
  private client: AxiosInstance;

  constructor() {
    const baseUrl = getApiBaseUrl();
    console.log(`[APIService] Using base URL: ${baseUrl}/api`);

    this.client = axios.create({
      baseURL: `${baseUrl}/api`,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // ─── Auth interceptor ───────────────────────────────────────────────────
    // Attache le Bearer token Supabase sur chaque requête sortante
    this.client.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        config.headers.set('Authorization', `Bearer ${session.access_token}`);
      }
      return config;
    });

    // ─── Response interceptor ───────────────────────────────────────────────
    // Gère les 401 globalement (token expiré, non authentifié)
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401) {
          console.warn('[APIService] 401 — session expirée, déconnexion');
          await supabase.auth.signOut();
        }
        return Promise.reject(error);
      }
    );
  }

  // ─── Alerts ──────────────────────────────────────────────────────────────
  async getAlerts(userId?: string) {
    const response = await this.client.get('/alerts', {
      params: userId ? { userId } : {},
    });
    return response.data;
  }

  async createAlert(data: {
    title: string;
    description: string;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
    location: { latitude: number; longitude: number };
    responderIds?: string[];
  }) {
    const response = await this.client.post('/alerts', data);
    return response.data;
  }

  async updateAlert(alertId: string, data: Partial<any>) {
    const response = await this.client.put(`/alerts/${alertId}`, data);
    return response.data;
  }

  async respondToAlert(alertId: string, userId: string) {
    const response = await this.client.post(`/alerts/${alertId}/respond`, { userId });
    return response.data;
  }

  // ─── Users ───────────────────────────────────────────────────────────────
  async getUser(userId: string) {
    const response = await this.client.get(`/users/${userId}`);
    return response.data;
  }

  async updateUserStatus(userId: string, status: 'available' | 'on_duty' | 'off_duty') {
    const response = await this.client.put(`/users/${userId}/status`, { status });
    return response.data;
  }

  async updateUserLocation(userId: string, location: { latitude: number; longitude: number }) {
    const response = await this.client.put(`/users/${userId}/location`, { location });
    return response.data;
  }

  // ─── SOS ─────────────────────────────────────────────────────────────────
  async triggerSOS(userId: string, location: { latitude: number; longitude: number }) {
    const response = await this.client.post('/sos', {
      userId,
      location,
      timestamp: new Date().toISOString(),
    });
    return response.data;
  }

  async acknowledgeSOS(sosId: string, dispatcherId: string) {
    const response = await this.client.post(`/sos/${sosId}/acknowledge`, {
      dispatcherId,
      timestamp: new Date().toISOString(),
    });
    return response.data;
  }

  // ─── Messages ────────────────────────────────────────────────────────────
  async getMessages(userId: string, conversationId?: string) {
    const response = await this.client.get('/messages', {
      params: { userId, conversationId },
    });
    return response.data;
  }

  async sendMessage(data: {
    senderId: string;
    recipientId: string;
    content: string;
    type: 'text' | 'location' | 'alert';
  }) {
    const response = await this.client.post('/messages', {
      ...data,
      timestamp: new Date().toISOString(),
    });
    return response.data;
  }

  async markMessageAsRead(messageId: string) {
    const response = await this.client.put(`/messages/${messageId}/read`);
    return response.data;
  }

  // ─── Auth (conservé pour compatibilité avec le serveur Express) ──────────
  async logout(userId: string) {
    const response = await this.client.post('/auth/logout', { userId });
    return response.data;
  }

  // ─── Health ──────────────────────────────────────────────────────────────
  async healthCheck() {
    const response = await this.client.get('/health');
    return response.data;
  }
}

export const apiService = new APIService();
