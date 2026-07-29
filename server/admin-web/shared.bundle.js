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

  // shared/geo.ts
  function haversineDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  // shared/browser-entry.ts
  window.TalionShared = {
    sortByScheduledStartDesc,
    ENTITY_SEARCH_SOURCE_LABEL,
    ENTITY_SEARCH_SOURCE_BADGE,
    entitySearchSourceLabel,
    haversineDistanceMeters
  };
})();
