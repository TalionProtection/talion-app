/**
 * Entry point bundled by esbuild (see package.json's "build" script) into
 * shared.bundle.js for BOTH server/dispatch-web/ and server/admin-web/,
 * exposing the shared/ modules as a single browser global for the consoles'
 * plain-script app.v2.js files to consume (no module system/bundler
 * otherwise exists for them - see shared/visits.ts for the full rationale).
 */
import { sortByScheduledStartDesc } from './visits';
import { ENTITY_SEARCH_SOURCE_LABEL, ENTITY_SEARCH_SOURCE_BADGE, entitySearchSourceLabel } from './entity-search';
import { haversineDistanceMeters } from './geo';

(window as any).TalionShared = {
  sortByScheduledStartDesc,
  ENTITY_SEARCH_SOURCE_LABEL,
  ENTITY_SEARCH_SOURCE_BADGE,
  entitySearchSourceLabel,
  haversineDistanceMeters,
};
