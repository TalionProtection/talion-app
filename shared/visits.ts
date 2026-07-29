/**
 * Pure logic shared between the dispatch console (bundled via esbuild into
 * server/dispatch-web/shared.bundle.js, see shared-entry.ts) and the mobile
 * app (imported directly via the @/ alias). No React/RN/DOM dependencies —
 * must run identically in both a browser IIFE bundle and the Metro bundle.
 */

export interface ScheduledItem {
  scheduledStart?: number;
}

/**
 * Most recent/soonest first — the default sort for the Visites view on both
 * surfaces, so a past visit that already took place is right at the top
 * instead of buried under older ones.
 */
export function sortByScheduledStartDesc<T extends ScheduledItem>(items: T[]): T[] {
  return [...items].sort((a, b) => (b.scheduledStart ?? 0) - (a.scheduledStart ?? 0));
}
