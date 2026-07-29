/**
 * Entry point bundled by esbuild (see package.json's "build" script) into
 * server/dispatch-web/shared.bundle.js, exposing the shared/ modules as a
 * single browser global for the console's plain-script app.v2.js to consume
 * (no module system/bundler otherwise exists for the console - see
 * shared/visits.ts for the full rationale).
 */
import { sortByScheduledStartDesc } from '../../shared/visits';
import { ENTITY_SEARCH_SOURCE_LABEL, ENTITY_SEARCH_SOURCE_BADGE, entitySearchSourceLabel } from '../../shared/entity-search';

(window as any).TalionShared = {
  sortByScheduledStartDesc,
  ENTITY_SEARCH_SOURCE_LABEL,
  ENTITY_SEARCH_SOURCE_BADGE,
  entitySearchSourceLabel,
};
