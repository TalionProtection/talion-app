/**
 * Pure logic shared between the dispatch console and the mobile app for the
 * unified entity search (point 2 of the "think like Palantir" review) - see
 * shared/visits.ts for why this must stay dependency-free.
 */

export type EntitySearchSource = 'blackbook' | 'known_person' | 'system_account';

export const ENTITY_SEARCH_SOURCE_LABEL: Record<EntitySearchSource, string> = {
  blackbook: '🕵️ Blackbook',
  known_person: '👥 Personne connue',
  system_account: '🏠 Compte système',
};

// Console-specific badge color class names (stat-red/stat-blue/stat-green) —
// harmless on mobile, which looks these up itself for its own styling and
// simply won't reference this map.
export const ENTITY_SEARCH_SOURCE_BADGE: Record<EntitySearchSource, string> = {
  blackbook: 'stat-red',
  known_person: 'stat-blue',
  system_account: 'stat-green',
};

export function entitySearchSourceLabel(source: string): string {
  return ENTITY_SEARCH_SOURCE_LABEL[source as EntitySearchSource] || source;
}
