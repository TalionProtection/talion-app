/**
 * Utility functions for formatting data in a human-readable way.
 */

/**
 * Convert a long UUID/ID string into a short, readable incident reference.
 * 
 * Examples:
 *   "a3f8b2c1-1234-5678-9abc-def012345678" → "INC-A3F8"
 *   "alert-1711234567890-abc123" → "INC-1711"
 *   "short" → "INC-SHOR"
 * 
 * The function extracts the first 4 meaningful alphanumeric characters
 * from the ID and uppercases them for a clean reference code.
 */
export function formatIncidentId(id: string): string {
  if (!id) return 'INC-????';
  
  // Strip common prefixes
  let cleaned = id
    .replace(/^alert-/i, '')
    .replace(/^incident-/i, '')
    .replace(/^inc-/i, '');
  
  // Extract only alphanumeric characters
  const alphanumeric = cleaned.replace(/[^a-zA-Z0-9]/g, '');
  
  // Take first 4 characters and uppercase
  const short = alphanumeric.substring(0, 4).toUpperCase();
  
  return `INC-${short || '????'}`;
}

/**
 * Format a timestamp into a human-readable relative time string (French).
 * 
 * Examples:
 *   now - 30s → "Il y a 30s"
 *   now - 5m → "Il y a 5min"
 *   now - 2h → "Il y a 2h"
 *   now - 1d → "Il y a 1j"
 */
export function formatTimeAgoFr(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);
  
  if (seconds < 60) return `Il y a ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Il y a ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  return `Il y a ${days}j`;
}

/**
 * Format an incident type string into a readable French label.
 */
export function formatIncidentType(type: string): string {
  const typeLabels: Record<string, string> = {
    sos: 'SOS',
    medical: 'Médical',
    fire: 'Incendie',
    security: 'Sécurité',
    accident: 'Accident',
    broadcast: 'Diffusion',
    other: 'Autre',
  };
  return typeLabels[type] || type.charAt(0).toUpperCase() + type.slice(1);
}

/**
 * Format a status string into a readable French label.
 */
export function formatStatusFr(status: string): string {
  const statusLabels: Record<string, string> = {
    active: 'Actif',
    acknowledged: 'Acquitté',
    dispatched: 'Dispatché',
    resolved: 'Résolu',
  };
  return statusLabels[status] || status.charAt(0).toUpperCase() + status.slice(1);
}

/**
 * Format a severity string into a readable French label.
 */
export function formatSeverityFr(severity: string): string {
  const severityLabels: Record<string, string> = {
    critical: 'Critique',
    high: 'Élevé',
    medium: 'Moyen',
    low: 'Faible',
  };
  return severityLabels[severity] || severity.charAt(0).toUpperCase() + severity.slice(1);
}
