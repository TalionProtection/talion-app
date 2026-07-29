"use strict";
(() => {
  // shared/visits.ts
  function sortByScheduledStartDesc(items) {
    return [...items].sort((a, b) => (b.scheduledStart ?? 0) - (a.scheduledStart ?? 0));
  }

  // shared/entity-search.ts
  var ENTITY_SEARCH_SOURCE_LABEL = {
    blackbook: "\u{1F575}\uFE0F Blackbook",
    known_person: "\u{1F465} Personne connue",
    system_account: "\u{1F3E0} Compte syst\xE8me"
  };
  var ENTITY_SEARCH_SOURCE_BADGE = {
    blackbook: "stat-red",
    known_person: "stat-blue",
    system_account: "stat-green"
  };
  function entitySearchSourceLabel(source) {
    return ENTITY_SEARCH_SOURCE_LABEL[source] || source;
  }

  // server/dispatch-web/shared-entry.ts
  window.TalionShared = {
    sortByScheduledStartDesc,
    ENTITY_SEARCH_SOURCE_LABEL,
    ENTITY_SEARCH_SOURCE_BADGE,
    entitySearchSourceLabel
  };
})();
