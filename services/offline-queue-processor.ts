/**
 * Offline Queue Processor
 * 
 * Processes queued offline actions when connectivity is restored.
 * Integrates with the offline cache service to retry failed operations.
 */

import { offlineCache, type QueuedAction } from './offline-cache';
import { getApiBaseUrl } from '@/lib/server-url';

/**
 * Process a single queued action by sending it to the server.
 * Returns true if successful, false otherwise.
 */
async function executeAction(action: QueuedAction): Promise<boolean> {
  const baseUrl = getApiBaseUrl();

  switch (action.type) {
    case 'sos': {
      try {
        const res = await fetch(`${baseUrl}/api/sos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.payload),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    case 'message': {
      try {
        const { conversationId, ...messageData } = action.payload;
        const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(messageData),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    case 'status_update': {
      try {
        const res = await fetch(`${baseUrl}/api/status`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.payload),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    case 'location_update': {
      // Location updates are time-sensitive, skip old ones
      const age = Date.now() - action.createdAt;
      if (age > 5 * 60 * 1000) {
        // Older than 5 minutes, discard
        return true;
      }
      try {
        const res = await fetch(`${baseUrl}/api/location`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action.payload),
        });
        return res.ok;
      } catch {
        return false;
      }
    }

    default:
      console.warn(`[QueueProcessor] Unknown action type: ${action.type}`);
      return true; // Remove unknown actions
  }
}

/**
 * Process all queued actions.
 * Call this when the app comes back online.
 */
export async function processOfflineQueue(): Promise<{ processed: number; failed: number }> {
  const queue = await offlineCache.getQueue();
  if (queue.length === 0) return { processed: 0, failed: 0 };

  console.log(`[QueueProcessor] Processing ${queue.length} queued actions...`);
  const result = await offlineCache.processQueue(executeAction);
  console.log(`[QueueProcessor] Done: ${result.processed} processed, ${result.failed} failed`);
  return result;
}

export default processOfflineQueue;
