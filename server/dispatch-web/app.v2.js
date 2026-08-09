// ─── Talion Dispatch Console ─────────────────────────────────
// Derive API base: if accessed via a proxy with a different port prefix (e.g. 4000-xxx),
// replace with 3000 to reach the actual API server.
const API_BASE = (() => {
  const origin = window.location.origin;
  const host = window.location.hostname;
  // Manus proxy pattern: "PORT-sessionid.region.manus.computer"
  const proxyMatch = host.match(/^(\d+)-(.+)$/);
  if (proxyMatch && proxyMatch[1] !== '3000') {
    return origin.replace(/^(https?:\/\/)\d+-/, '$13000-');
  }
  return origin;
})();

// ─── Auth: refuse to render the console at all without a stored session token
// (guards direct navigation to this page, bypassing /console/). ────────────
if (!localStorage.getItem('talion_token')) {
  window.location.href = '/console/';
}

// ─── Auth: attach the console session token to every same-origin fetch, and
// bounce back to login on a 401 (token missing/expired/invalid). ───────────
(() => {
  const _rawFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const reqUrl = typeof input === 'string' ? input : (input && input.url) || String(input);
    const isSameOrigin = reqUrl.startsWith('/') || reqUrl.startsWith(window.location.origin) || reqUrl.startsWith(API_BASE);
    if (!isSameOrigin) {
      // Third-party requests (e.g. livekit-client's own calls to LiveKit Cloud's
      // regions endpoint) must not get our Supabase bearer token attached, and
      // their response codes have nothing to do with our own session.
      return _rawFetch(input, init);
    }
    const token = localStorage.getItem('talion_token');
    const headers = new Headers(init.headers || (typeof input === 'object' && input.headers) || {});
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return _rawFetch(input, { ...init, headers }).then(res => {
      if (res.status === 401) {
        console.error(`[Auth] 401 on ${reqUrl} — redirecting to login`);
        localStorage.setItem('talion_last_401', reqUrl);
        localStorage.removeItem('talion_token');
        localStorage.removeItem('talion_role');
        window.location.href = '/console/';
      }
      return res;
    });
  };
})();

let incidents = [];
let responders = [];
let broadcastHistory = [];
let currentFilter = 'all';
let currentResponderFilter = 'all';
let selectedBroadcastSeverity = 'medium';
let selectedBroadcastRadius = '5';
let resolveTargetId = null;

// ─── Sectors (admin-managed organizational zones) ───────────────────────
let sectorsList = [];
let sectorLayers = {}; // id -> { shape: L.Layer, label: L.Marker }
let sectorEditingId = null; // null while creating a new sector
let sectorFormShape = 'circle';
let sectorCircleCenter = null; // L.LatLng
let sectorCircleRadius = 500; // meters
let sectorCircleCenterMarker = null;
let sectorCircleLayer = null;
let sectorMapClickHandler = null;
let sectorPolygonLayer = null; // editable L.Polygon while drawing/editing
let sectorPolygonPoints = null; // [{latitude, longitude}, ...]
let sectorPolygonDrawer = null; // active L.Draw.Polygon handler

const TYPE_ICONS = { sos: '🆘', medical: '🏥', fire: '🔥', security: '🔒', hazard: '⚠️', accident: '💥', broadcast: '📢', home_jacking: '🏠', cambriolage: '🔓', animal_perdu: '🐾', evenement_climatique: '🌪️', rodage: '🏍️', vehicule_suspect: '🚙', fugue: '🏃', route_bloquee: '🚧', route_fermee: '⛔', other: '🚨' };
const TYPE_LABELS = { sos: 'SOS', medical: 'Médical', fire: 'Feu', security: 'Sécurité', hazard: 'Danger', accident: 'Accident', broadcast: 'Broadcast', home_jacking: 'Home-Jacking', cambriolage: 'Cambriolage', animal_perdu: 'Animal perdu', evenement_climatique: 'Événement climatique', rodage: 'Rodage', vehicule_suspect: 'Véhicule suspect', fugue: 'Fugue', route_bloquee: 'Route bloquée', route_fermee: 'Route fermée', other: 'Autre' };
const SEVERITY_ORDER= { critical: 0, high: 1, medium: 2, low: 3 };
const SEVERITY_LABELS = { critical: 'Critique', high: 'Élevé', medium: 'Moyen', low: 'Faible' };
const STATUS_LABELS = { active: 'Actif', acknowledged: 'Acquitté', dispatched: 'Dispatché', resolved: 'Résolu' };
function formatIncidentId(id) {
  if (!id) return "INC-?????";
  // New format: "SOS — Billy Spielmann — Marbella — #0001"
  if (id.includes(" — ")) return id;
  // Legacy format: truncate UUID
  let cleaned = id.replace(/^alert-/i, "").replace(/^incident-/i, "").replace(/^inc-/i, "");
  const alphanumeric = cleaned.replace(/[^a-zA-Z0-9]/g, "");
  const short = alphanumeric.substring(0, 4).toUpperCase();
  return "INC-" + (short || "????");
}
function sevLabel(s) { return SEVERITY_LABELS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : ''); }
function statusLabel(s) { return STATUS_LABELS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : ''); }
function typeLabel(t) { return TYPE_LABELS[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : ''); }

// ─── WebSocket Real-Time Client ─────────────────────────────
let ws = null;
let wsReconnectTimer = null;
let wsReconnectDelay = 2000;
const WS_MAX_DELAY = 30000;

function getWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let host = window.location.host;
  // Fix port for Manus proxy pattern: replace port prefix with 3000
  const proxyMatch = host.match(/^(\d+)-(.+)$/);
  if (proxyMatch && proxyMatch[1] !== '3000') {
    host = host.replace(/^\d+-/, '3000-');
  }
  return `${proto}//${host}`;
}

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  updateWsStatus('connecting');
  ws = new WebSocket(getWsUrl());

  ws.onopen = () => {
    console.log('[WS] Connected');
    wsReconnectDelay = 2000;
    updateWsStatus('online');
    // Server verifies this token against Supabase and derives the real
    // identity/role from it — it no longer trusts a client-asserted userId/
    // userRole (previously every dispatch console tab claimed the same
    // fake shared identity "dispatch-console", not the actual logged-in user).
    ws.send(JSON.stringify({ type: 'auth', token: localStorage.getItem('talion_token') }));
    // Request current data
    ws.send(JSON.stringify({ type: 'getAlerts' }));
    ws.send(JSON.stringify({ type: 'getResponders' }));
    // Also do a REST refresh for complete data
    refreshData();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {
      console.warn('[WS] Failed to parse:', e);
    }
  };

  ws.onclose = () => {
    console.log('[WS] Disconnected');
    updateWsStatus('offline');
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    console.error('[WS] Error:', err);
    updateWsStatus('offline');
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(() => {
    wsReconnectDelay = Math.min(wsReconnectDelay * 1.5, WS_MAX_DELAY);
    connectWebSocket();
  }, wsReconnectDelay);
}

function updateWsStatus(state) {
  const dot = document.getElementById('serverStatusDot');
  const text = document.getElementById('serverStatusText');
  const indicator = document.getElementById('wsIndicator');
  if (dot) dot.className = `status-dot ${state === 'online' ? 'online' : state === 'connecting' ? 'connecting' : 'offline'}`;
  if (text) text.textContent = state === 'online' ? 'Live' : state === 'connecting' ? 'Connecting...' : 'Offline';
  if (indicator) {
    indicator.textContent = state === 'online' ? '⚡ Real-time' : state === 'connecting' ? '⏳ Connecting' : '❌ Disconnected';
    indicator.className = `ws-indicator ws-${state}`;
  }
}

function handleWsMessage(msg) {
  const now = Date.now();
  switch (msg.type) {
    case 'authSuccess':
      console.log('[WS] Authenticated as dispatch-console');
      break;

    case 'newAlert': {
      // New incident created
      const alert = msg.data;
      const existing = incidents.findIndex(i => i.id === alert.id);
      const formatted = {
        id: alert.id, type: alert.type, severity: alert.severity, status: alert.status,
        reportedBy: alert.createdBy, address: alert.location?.address || 'Unknown',
        description: alert.description,
        timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0,
        respondingUsers: alert.respondingUsers || [], respondingNames: alert.respondingNames || [],
        respondingDetails: alert.respondingDetails || [],
        photos: alert.photos || [],
        responderStatuses: alert.responderStatuses || {},
        statusHistory: alert.statusHistory || [],
        responderEscalation: alert.responderEscalation || {},
        escalationLevel: alert.escalationLevel || 0,
        possibleDuplicates: alert.possibleDuplicates || [],
        linkedIncidentIds: alert.linkedIncidentIds || [],
        origin: alert.origin || 'dispatch',
        archived: alert.archived || false,
        archivedAt: alert.archivedAt,
        isDuress: alert.isDuress || false,
      };
      if (existing >= 0) { incidents[existing] = formatted; } else { incidents.unshift(formatted); }
      showToast(`🚨 New Incident: ${alert.type.toUpperCase()} - ${alert.location?.address || 'Unknown'}`, 'error');
      sendBrowserNotification(
        `New ${alert.severity?.toUpperCase()} Incident`,
        `${alert.type.toUpperCase()} - ${alert.location?.address || 'Unknown location'}\nReported by: ${alert.createdBy || 'Unknown'}`,
        alert.severity || 'high',
        `incident-${alert.id}`
      );
      // Play alert sound based on type and severity
      showCriticalAlertBanner({ ...formatted, createdBy: alert.createdBy });
      if (formatted.isDuress) {
        if (typeof getAudioContext === 'function') { const ctx = getAudioContext(); if (ctx && ctx.state === 'suspended') ctx.resume().then(playDuressAlertSound); else playDuressAlertSound(); } else { playDuressAlertSound(); }
      } else {
        if (typeof getAudioContext === 'function') { const ctx = getAudioContext(); if (ctx && ctx.state === 'suspended') ctx.resume().then(() => playNewAlertSound(alert.type, alert.severity)); else playNewAlertSound(alert.type, alert.severity); } else { playNewAlertSound(alert.type, alert.severity); }
      }
      updateAll();
      break;
    }

    case 'alertAcknowledged': {
      const inc = incidents.find(i => i.id === msg.alertId);
      if (inc) { inc.status = 'acknowledged'; }
      showToast(`\u2705 Incident ${formatIncidentId(msg.alertId)} acquitt\u00e9`, 'success');
      sendBrowserNotification('Incident acquitt\u00e9', `Incident ${formatIncidentId(msg.alertId)} a \u00e9t\u00e9 acquitt\u00e9`, 'info', `ack-${msg.alertId}`);
      playAcknowledgeSound();
      updateAll();
      break;
    }

    case 'alertUpdate': {
      const alert = msg.data;
      const idx = incidents.findIndex(i => i.id === alert.id);
      const wasDuress = idx >= 0 && incidents[idx].isDuress;
      const formatted = {
        id: alert.id, type: alert.type, severity: alert.severity, status: alert.status,
        reportedBy: alert.createdBy, address: alert.location?.address || 'Unknown',
        description: alert.description,
        timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0,
        respondingUsers: alert.respondingUsers || [], respondingNames: alert.respondingNames || [],
        respondingDetails: alert.respondingDetails || [],
        photos: alert.photos || [],
        responderStatuses: alert.responderStatuses || {},
        statusHistory: alert.statusHistory || [],
        responderEscalation: alert.responderEscalation || {},
        escalationLevel: alert.escalationLevel || 0,
        possibleDuplicates: alert.possibleDuplicates || [],
        linkedIncidentIds: alert.linkedIncidentIds || [],
        origin: alert.origin || 'dispatch',
        archived: alert.archived || false,
        archivedAt: alert.archivedAt,
        isDuress: alert.isDuress || false,
      };
      if (idx >= 0) { incidents[idx] = formatted; } else { incidents.unshift(formatted); }
      // Newly became a duress case (not just any update to an already-known one) —
      // this is the common real-world path: SOS was already active, then "cancelled"
      // under coercion, which arrives here as an update, not a newAlert.
      if (formatted.isDuress && !wasDuress) {
        showCriticalAlertBanner({ ...formatted, createdBy: alert.createdBy });
        if (typeof getAudioContext === 'function') { const ctx = getAudioContext(); if (ctx && ctx.state === 'suspended') ctx.resume().then(playDuressAlertSound); else playDuressAlertSound(); } else { playDuressAlertSound(); }
      }
      showToast(`\ud83d\udccb Incident ${formatIncidentId(alert.id)} mis \u00e0 jour`, 'info');
      updateAll();
      break;
    }

    case 'alertResolved': {
      const inc = incidents.find(i => i.id === msg.alertId);
      if (inc) { inc.status = 'resolved'; }
      showToast(`\ud83d\udfe2 Incident ${formatIncidentId(msg.alertId)} r\u00e9solu`, 'success');
      sendBrowserNotification('Incident r\u00e9solu', `Incident ${formatIncidentId(msg.alertId)} a \u00e9t\u00e9 r\u00e9solu`, 'success', `resolved-${msg.alertId}`);
      playResolveSound();
      updateAll();
      break;
    }

    case 'alertDeleted': {
      incidents = incidents.filter(i => i.id !== msg.alertId);
      if (document.getElementById('detailModal')?.classList.contains('active')) closeDetailModal();
      showToast(`🗑️ Incident ${formatIncidentId(msg.alertId)} supprimé`, 'info');
      updateAll();
      break;
    }

    case 'acceptanceTimeout': {
      const respName = msg.responderName || msg.responderId;
      showToast(`\u23F0 ${respName} n'a pas accept\u00e9 l'incident ${formatIncidentId(msg.alertId)} dans les 5 min`, 'warning');
      sendBrowserNotification(
        "D\u00e9lai d'acceptation d\u00e9pass\u00e9",
        `${respName} n'a pas accept\u00e9 l'incident ${formatIncidentId(msg.alertId)} dans les 5 minutes. Veuillez r\u00e9assigner.`,
        'warning',
        `timeout-${msg.alertId}-${msg.responderId}`
      );
      playAlertSound();
      updateAll();
      break;
    }

    case 'escalationSoft': {
      const respName = msg.responderName || msg.responderId;
      const backup = msg.suggestedBackup;
      const backupNote = backup ? ` — Suggestion: ${backup.name} (${backup.distanceLabel}${backup.etaLabel ? ', ETA ' + backup.etaLabel : ''})` : '';
      showToast(`⚠️ ${respName} n'a pas encore accepté ${formatIncidentId(msg.alertId)} (2 min)${backupNote}`, 'warning');
      sendBrowserNotification(
        "Pas encore accepté (2 min)",
        `${respName} — ${formatIncidentId(msg.alertId)}${backupNote}`,
        'warning',
        `esc-soft-${msg.alertId}-${msg.responderId}`
      );
      playAlertSound();
      updateAll();
      break;
    }

    case 'patrolAlert': {
      const pr = msg.data;
      const sc = PATROL_STATUS_CONFIG[pr.status] || { label: pr.status, color: '#ef4444' };
      showToast(`⚠️ Ronde ${sc.label}: ${pr.location} — ${pr.createdByName}`, 'warning');
      sendBrowserNotification(`Ronde ${sc.label}`, `${pr.createdByName} — ${pr.location}`, 'warning', `patrol-${pr.reportId}`);
      refreshPatrolReports();
      break;
    }

    // ─── GPS patrol rounds (live) ─────────────────────────────────────
    case 'activePatrolRoundsSnapshot': {
      if (Array.isArray(msg.data)) {
        activePatrolRounds = msg.data;
        renderActivePatrolRounds();
        refreshPatrolRoundMapLayers();
      }
      break;
    }

    case 'patrolRoundStarted': {
      const round = msg.data;
      const idx = activePatrolRounds.findIndex(r => r.id === round.id);
      if (idx >= 0) activePatrolRounds[idx] = round; else activePatrolRounds.push(round);
      showToast(`📍 Ronde démarrée : ${round.responderName} — ${round.siteName}`, 'info');
      renderActivePatrolRounds();
      refreshPatrolRoundMapLayers();
      break;
    }

    case 'patrolRoundLocationUpdate': {
      const { roundId, location, timestamp } = msg.data;
      const round = activePatrolRounds.find(r => r.id === roundId);
      if (round) {
        round.lastLocation = { ...location, timestamp };
        round.trail = round.trail || [];
        round.trail.push({ ...location, timestamp });
        updatePatrolRoundMapLayers(round);
      }
      break;
    }

    case 'patrolCheckpointVisited': {
      const { roundId, checkpointId, name } = msg.data;
      const round = activePatrolRounds.find(r => r.id === roundId);
      if (round) {
        const cp = (round.checkpoints || []).find(c => c.checkpointId === checkpointId);
        if (cp) { cp.visited = true; cp.dwellMet = true; }
        renderActivePatrolRounds();
        updatePatrolRoundMapLayers(round);
      }
      showToast(`✅ Checkpoint validé : ${name}`, 'success');
      break;
    }

    case 'patrolRoundFinished':
    case 'patrolRoundInterrupted': {
      const { roundId } = msg.data;
      activePatrolRounds = activePatrolRounds.filter(r => r.id !== roundId);
      removePatrolRoundMapLayers(roundId);
      renderActivePatrolRounds();
      showToast(
        msg.type === 'patrolRoundInterrupted' ? '🚨 Ronde interrompue' : '✅ Ronde terminée',
        msg.type === 'patrolRoundInterrupted' ? 'warning' : 'success'
      );
      refreshPatrolReports();
      break;
    }

    case 'patrolRoundAttention': {
      const d = msg.data;
      showToast(`⚠️ ${d.message}`, 'warning', 8000);
      sendBrowserNotification('Ronde — attention requise', d.message, 'warning', `patrol-round-${d.roundId}`);
      break;
    }

    // ─── Post-round "next location" navigation (live) ──────────────────
    case 'activeRoutesSnapshot': {
      if (Array.isArray(msg.data)) {
        activeResponderRoutes = msg.data;
        renderActiveResponderRoutes();
        refreshPatrolRouteMapLayers();
      }
      break;
    }

    case 'patrolRouteStarted': {
      const route = msg.data;
      const idx = activeResponderRoutes.findIndex(r => r.responderId === route.responderId);
      if (idx >= 0) activeResponderRoutes[idx] = route; else activeResponderRoutes.push(route);
      showToast(`🧭 Navigation démarrée : ${route.responderName} → ${route.toSiteName}`, 'info');
      sendBrowserNotification('Navigation démarrée', `${route.responderName} → ${route.toSiteName}`, 'info', `route-${route.responderId}`);
      renderActiveResponderRoutes();
      refreshPatrolRouteMapLayers();
      break;
    }

    case 'patrolRouteEnded': {
      const { responderId } = msg.data;
      activeResponderRoutes = activeResponderRoutes.filter(r => r.responderId !== responderId);
      removePatrolRouteMapLayers(responderId);
      renderActiveResponderRoutes();
      break;
    }

    case 'alertsSnapshot': {
      // Full list of active alerts from server
      if (Array.isArray(msg.data)) {
        msg.data.forEach(alert => {
          const idx = incidents.findIndex(i => i.id === alert.id);
          const formatted = {
            id: alert.id, type: alert.type, severity: alert.severity, status: alert.status,
            reportedBy: alert.createdBy, address: alert.location?.address || 'Unknown',
            timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0,
            respondingUsers: alert.respondingUsers || [], respondingNames: alert.respondingNames || [],
            respondingDetails: alert.respondingDetails || [],
            responderStatuses: alert.responderStatuses || {},
            statusHistory: alert.statusHistory || [],
            responderEscalation: alert.responderEscalation || {},
            escalationLevel: alert.escalationLevel || 0,
          };
          if (idx >= 0) { incidents[idx] = formatted; } else { incidents.push(formatted); }
        });
        updateAll();
      }
      break;
    }

    case 'alertPhotosUpdated': {
      const { alertId, photos } = msg.data || {};
      const incIdx = incidents.findIndex(i => i.id === alertId);
      if (incIdx >= 0) {
        incidents[incIdx].photos = photos || [];
        renderOverview();
        renderIncidents();
        showToast(`Photos ajout\u00e9es \u00e0 ${formatIncidentId(alertId)}`, 'info');
      }
      break;
    }
    case 'alertsList': {
      if (Array.isArray(msg.data)) {
        msg.data.forEach(alert => {
          const idx = incidents.findIndex(i => i.id === alert.id);
          const formatted = {
            id: alert.id, type: alert.type, severity: alert.severity, status: alert.status,
            reportedBy: alert.createdBy, address: alert.location?.address || 'Unknown',
            timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0,
            respondingUsers: alert.respondingUsers || [], respondingNames: alert.respondingNames || [],
            respondingDetails: alert.respondingDetails || [],
            photos: alert.photos || [],
            responderStatuses: alert.responderStatuses || {},
            statusHistory: alert.statusHistory || [],
          };
          if (idx >= 0) { incidents[idx] = formatted; } else { incidents.push(formatted); }
        });
        updateAll();
      }
      break;
    }

    case 'respondersList': {
      if (Array.isArray(msg.data)) {
        responders = msg.data.map(r => ({
          id: r.id, name: r.name || r.id, firstName: r.firstName || '', lastName: r.lastName || '',
          email: r.email || '', phone: r.phone || '', tags: r.tags || [],
          status: r.status || 'available', location: r.location || null,
          lastSeen: r.lastSeen || now, isConnected: r.isConnected || false,
        }));
        renderOverview();
        renderResponders();
      }
      break;
    }

    case 'responderLocationUpdate': {
      const resp = responders.find(r => r.id === msg.userId);
      if (resp) {
        resp.location = msg.location;
        resp.lastSeen = msg.timestamp || now;
        if (msg.name) resp.name = msg.name;
        renderOverview();
        renderResponders();
      }
      break;
    }

    case 'responderStatusUpdate': {
      const resp = responders.find(r => r.id === msg.userId);
      if (resp) {
        resp.status = msg.status;
        resp.lastSeen = msg.timestamp || now;
        updateStats();
        renderOverview();
        renderResponders();
      }
      break;
    }

    case 'userLocationUpdate': {
      // A regular user shared their location - update mapUsers and refresh map markers
      if (msg.userId && msg.location) {
        if (!mapUsers) mapUsers = [];
        const existingUser = mapUsers.find(u => u.id === msg.userId);
        if (existingUser) {
          existingUser.location = msg.location;
          existingUser.lastSeen = msg.timestamp || now;
          // Self-heal a stub entry (created before the server sent a name) once a real one arrives
          if (msg.name) existingUser.name = msg.name;
        } else {
          mapUsers.push({
            id: msg.userId,
            name: msg.name || msg.userId,
            role: 'user',
            status: 'active',
            location: msg.location,
            lastSeen: msg.timestamp || now,
          });
        }
        window._cachedMapUsers = mapUsers;
        // Directly update user markers on the map without full refresh
        if (typeof updateUserMarkers === 'function' && dispatchMap) {
          updateUserMarkers(mapUsers);
        }
        showToast(`\uD83D\uDCCD ${msg.name || msg.userId} shared their location`, 'info');
        updateLiveUsersCounter();
      }
      break;
    }

    case 'userLocationRemoved': {
      // User stopped sharing their location - remove from mapUsers and update map
      if (msg.userId) {
        if (mapUsers) {
          mapUsers = mapUsers.filter(u => u.id !== msg.userId);
          window._cachedMapUsers = mapUsers;
        }
        if (typeof updateUserMarkers === 'function' && dispatchMap) {
          updateUserMarkers(mapUsers || []);
        }
        showToast(`\uD83D\uDCCD ${msg.userId} stopped sharing location`, 'info');
        updateLiveUsersCounter();
      }
      break;
    }

    case 'sectorCreated':
    case 'sectorUpdated': {
      if (msg.sector) {
        const idx = sectorsList.findIndex(s => s.id === msg.sector.id);
        if (idx >= 0) sectorsList[idx] = msg.sector;
        else sectorsList.push(msg.sector);
        if (dispatchMap) { renderSectors(); renderSectorFilterButtons(); }
      }
      break;
    }

    case 'sectorDeleted': {
      if (msg.sectorId) {
        sectorsList = sectorsList.filter(s => s.id !== msg.sectorId);
        if (dispatchMap) { renderSectors(); renderSectorFilterButtons(); }
      }
      break;
    }

    case 'presenceUpdated': {
      if (document.getElementById('tab-families')?.classList.contains('active')) {
        loadFamilyGroups();
      }
      if (msg.status === 'inside' || msg.status === 'outside') {
        const name = msg.name || msg.targetUserId;
        const label = msg.matchedLabel ? ` — ${msg.matchedLabel}` : '';
        const text = msg.status === 'inside' ? `\u{1F3E0} ${name} est rentré(e)${label}` : `\u{1F6B6} ${name} est sorti(e)${label}`;
        showToast(text, 'info');
        sendBrowserNotification(msg.status === 'inside' ? 'Rentré(e)' : 'Sorti(e)', `${name}${label}`, 'info', `presence-${msg.targetUserId}`);
      }
      break;
    }

    case 'userStatusChange': {
      // A user came online/offline
      const suName = msg.name || msg.userId;
      showToast(`👤 ${suName} is now ${msg.status}`, 'info');
      if (msg.status === 'offline') {
        sendBrowserNotification('User Disconnected', `${suName} went offline`, 'warning', `user-${msg.userId}`);
      }
      break;
    }

    case 'zoneBroadcast': {
      const bc = msg.data;
      broadcastHistory.unshift({
        details: `[${(bc.severity || 'medium').toUpperCase()}] ${bc.message} (${bc.radiusKm || 5}km radius)`,
        performedBy: bc.by || 'Unknown',
        timestamp: bc.timestamp || now,
      });
      broadcastHistory = broadcastHistory.slice(0, 10);
      showToast(`📢 Broadcast: ${bc.message}`, 'warning');
      sendBrowserNotification(
        `Zone Broadcast (${(bc.severity || 'medium').toUpperCase()})`,
        `${bc.message}\nRadius: ${bc.radiusKm || 5}km`,
        bc.severity || 'medium',
        `broadcast-${Date.now()}`
      );
      renderBroadcastHistory();
      break;
    }

    case 'geofenceEntry': {
      const ev = msg.data;
      showToast(`🟢 ${ev.responderName} entered zone (${ev.zone.severity.toUpperCase()})`, 'success', 8000);
      addGeofenceEventToLog(ev);
      flashResponderMarker(ev.responderId, 'entry');
      playGeofenceAlertSound(ev.zone.severity, 'entry');
      sendBrowserNotification(
        `Geofence Entry (${ev.zone.severity.toUpperCase()})`,
        `${ev.responderName} entered zone\nRadius: ${ev.zone.radius}km`,
        ev.zone.severity,
        `geofence-entry-${ev.responderId}`
      );
      break;
    }

    case 'geofenceExit': {
      const ev = msg.data;
      showToast(`🔴 ${ev.responderName} exited zone (${ev.zone.severity.toUpperCase()})`, 'warning', 8000);
      addGeofenceEventToLog(ev);
      flashResponderMarker(ev.responderId, 'exit');
      playGeofenceAlertSound(ev.zone.severity, 'exit');
      sendBrowserNotification(
        `Geofence Exit (${ev.zone.severity.toUpperCase()})`,
        `${ev.responderName} left zone\nRadius: ${ev.zone.radius}km`,
        ev.zone.severity,
        `geofence-exit-${ev.responderId}`
      );
      break;
    }

    case 'geofenceZoneCreated': {
      showToast(`📍 New geofence zone created (${msg.data.severity})`, 'info');
      break;
    }

    case 'geofenceZoneDeleted': {
      showToast(`🗑 Geofence zone removed`, 'info');
      break;
    }

    case 'pong':
      break;

    case 'pttEmergencyTriggered': {
      // Server sends { type: 'pttEmergencyTriggered', data: { channelId, senderId, senderName, senderRole, timestamp } }
      // \u2014 a notification to go join the live emergency channel, not a recorded message.
      const eData = msg.data || msg;
      const banner = document.getElementById('pttEmergencyBanner');
      const sender = document.getElementById('pttEmergencySender');
      if (banner) banner.style.display = 'flex';
      if (sender) sender.textContent = `${eData.senderName} (${eData.senderRole})`;
      showToast(`\u26a0\ufe0f URGENCE d\u00e9clench\u00e9e par ${eData.senderName}`, 'warning');
      break;
    }

    case 'blackbookPatternDetected': {
      // Proactive correlation alert - this Blackbook entry has now been
      // sighted at 2+ distinct residences within 90 days.
      const bData = msg.data || msg;
      showToast(bData.title || 'Pattern Blackbook détecté', 'warning');
      break;
    }

    case 'blackbookTemporalPatternDetected': {
      // Same entity sighted repeatedly at a similar weekday/time — a
      // deterministic bucket-count check, not AI.
      const tData = msg.data || msg;
      showToast(tData.title || 'Pattern horaire Blackbook détecté', 'warning');
      break;
    }

    case 'responderBlackbookProximityAlert': {
      // IMPORTANT: this means one of OUR responders entered a zone with
      // PAST Blackbook activity — never treat/word this as live suspect
      // detection (the server-side message body already says so).
      const pData = msg.data || msg;
      showToast(`📍 ${pData.body || pData.title || 'Responder proche d’une zone à activité Blackbook'}`, 'warning', 8000);
      sendBrowserNotification(pData.title || 'Zone à activité Blackbook connue', pData.body || '', 'warning', `bb-proximity-${pData.responderId}-${pData.entryId}`);
      break;
    }

    case 'pttTransmitAck':
    case 'pttEmergencyAck':
      // Acknowledgements from server — no action needed
      break;

    case 'pttChannelCreated':
    case 'pttChannelDeleted':
      loadPTTChannels();
      break;

    default:
      console.log('[WS] Unhandled:', msg.type);
  }
}

function updateAll() {
  updateStats();
  renderOverview();
  renderIncidents();
  renderArchives();
  document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
}

// ─── Toast Notifications ────────────────────────────────────
function showToast(message, type = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.style.cssText = 'position:fixed;top:16px;right:16px;z-index:10000;display:flex;flex-direction:column;gap:8px;max-width:400px;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  const colors = { success: '#059669', error: '#dc2626', warning: '#d97706', info: '#2563eb' };
  toast.style.cssText = `padding:12px 16px;border-radius:8px;color:#fff;font-size:13px;font-weight:500;background:${colors[type] || colors.info};box-shadow:0 4px 12px rgba(0,0,0,0.3);opacity:0;transform:translateX(100%);transition:all 0.3s ease;cursor:pointer;`;
  toast.textContent = message;
  toast.onclick = () => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); };
  container.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; toast.style.transform = 'translateX(0)'; });
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(100%)'; setTimeout(() => toast.remove(), 300); }, 5000);
}

// ─── WS Keepalive ───────────────────────────────────────────
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'ping' }));
  }
}, 25000);

// ─── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupCheckpointAdminUI();
  checkEmergencyOverrideStatus();
  // Show audio unlock reminder
  setTimeout(() => {
    if (!browserNotificationsEnabled) {
      showToast("🔔 Cliquez sur Notifications ON pour activer les sons d'alerte", "warning");
    }
  }, 1000);
  // Pre-unlock AudioContext with silent sound on page load
  setTimeout(() => {
    try {
      const ctx = getAudioContext();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      console.log("[Audio] AudioContext pre-unlocked");
    } catch(e) {}
  }, 500);
  connectWebSocket();
  refreshData();
  // Fallback polling every 30s (reduced from 10s since WS handles real-time)
  setInterval(refreshData, 30000);
});

function logout() {
  localStorage.removeItem('talion_token');
  localStorage.removeItem('talion_role');
  localStorage.removeItem('talion_user');
  window.location.href = '/console/';
}

// ─── Navigation ──────────────────────────────────────────────
function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const tab = item.dataset.tab;
      switchTab(tab);
    });
  });
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-tab="${tab}"]`)?.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  const titles = { overview: "Vue d'ensemble", incidents: "Gestion des incidents", responders: "Unités d'intervention", broadcast: "Diffusion", map: "Carte en direct", messages: "Messages", patrol: "Rapports de Ronde", ptt: "Push-to-Talk", archives: "Archives", families: "Familles", visits: "Visites", blackbook: "Blackbook", 'main-courante': "Main Courante", 'threat-analysis': "Analyse IA", health: "Santé Système", kpis: "Statistiques" };
  document.getElementById('pageTitle').textContent = titles[tab] || tab;
  if (tab === 'map') {
    setTimeout(() => { if (dispatchMap) { dispatchMap.invalidateSize(); } else { initMap(); } }, 100);
  }
  if (tab === 'ptt') {
    loadPTTChannels();
  }
  if (tab === 'archives') {
    renderArchives();
  }
  if (tab === 'families') {
    loadFamilyGroups();
  }
  if (tab === 'visits') {
    refreshVisitsSubtab();
  }
  if (tab === 'blackbook') {
    loadBlackbook();
  }
  if (tab === 'main-courante') {
    ensureFamilyGroupsLoaded().then(() => { populateFamilySelect('mcFamilySelect'); loadMainCourante(); });
  }
  if (tab === 'threat-analysis') {
    ensureFamilyGroupsLoaded().then(() => { populateFamilySelect('taFamilySelect'); loadThreatAnalyses(); });
  }
  if (tab === 'health') {
    loadSystemHealth();
  }
  if (tab === 'kpis') {
    loadKPIs();
  }
}

// ─── Emergency access override (point 4, "think like Palantir") ────────
// Break-glass: temporarily bypasses the caller's own family-assignment
// restriction. Never affects incidents/alerts, which are unrestricted for
// everyone regardless. Every enable/disable is logged server-side.
let emergencyOverrideTimer = null;

async function checkEmergencyOverrideStatus() {
  try {
    const res = await fetch(`${API_BASE}/api/access/emergency-override`);
    const data = res.ok ? await res.json() : { active: false };
    updateEmergencyOverrideBanner(data.active, data.expiresAt);
  } catch (e) {
    console.error('[EmergencyOverride] Status check error:', e);
  }
}

function updateEmergencyOverrideBanner(active, expiresAt) {
  const banner = document.getElementById('emergencyOverrideBanner');
  const btn = document.getElementById('btnEmergencyOverride');
  if (emergencyOverrideTimer) { clearTimeout(emergencyOverrideTimer); emergencyOverrideTimer = null; }
  if (active) {
    banner.style.display = 'flex';
    document.getElementById('emergencyOverrideExpiry').textContent = new Date(expiresAt).toLocaleTimeString('fr-FR');
    btn.style.background = '#dc2626';
    btn.style.color = '#fff';
    const msUntilExpiry = expiresAt - Date.now();
    if (msUntilExpiry > 0) {
      emergencyOverrideTimer = setTimeout(() => checkEmergencyOverrideStatus(), msUntilExpiry + 1000);
    }
  } else {
    banner.style.display = 'none';
    btn.style.background = '';
    btn.style.color = '';
  }
}

async function toggleEmergencyOverride() {
  const banner = document.getElementById('emergencyOverrideBanner');
  const isActive = banner.style.display !== 'none';
  if (isActive) {
    if (!confirm('Désactiver l\'accès d\'urgence et revenir à la restriction normale ?')) return;
    try {
      await fetch(`${API_BASE}/api/access/emergency-override`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: false }),
      });
      updateEmergencyOverrideBanner(false);
      showToast('Accès d\'urgence désactivé', 'success');
    } catch (e) {
      showToast('Erreur réseau', 'error');
    }
  } else {
    const reason = prompt('Raison de l\'accès d\'urgence (visible dans le journal d\'audit) :');
    if (reason === null) return; // cancelled
    if (!confirm('Activer l\'accès d\'urgence ? Vous verrez toutes les familles pendant 2h, action tracée.')) return;
    try {
      const res = await fetch(`${API_BASE}/api/access/emergency-override`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable: true, reason }),
      });
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      updateEmergencyOverrideBanner(true, data.expiresAt);
      showToast('Accès d\'urgence activé', 'warning');
    } catch (e) {
      showToast('Erreur lors de l\'activation', 'error');
    }
  }
}

// ─── System Health Tab ───────────────────────────────────────────────
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}j ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  return `${m}min`;
}

async function loadSystemHealth() {
  try {
    const res = await fetch(`${API_BASE}/admin/health`);
    if (!res.ok) throw new Error('Failed to load health');
    const health = await res.json();

    const supaEl = document.getElementById('healthSupabaseStatus');
    const supaCard = document.getElementById('healthSupabaseCard');
    supaEl.textContent = health.supabase?.ok ? `✅ ${health.supabase.latencyMs}ms` : '❌ Erreur';
    supaCard.className = `stat-card ${health.supabase?.ok ? 'stat-green' : 'stat-red'}`;

    const lkEl = document.getElementById('healthLivekitStatus');
    const lkCard = document.getElementById('healthLivekitCard');
    lkEl.textContent = health.livekit?.ok ? `✅ ${health.livekit.latencyMs}ms` : '❌ Erreur';
    lkCard.className = `stat-card ${health.livekit?.ok ? 'stat-green' : 'stat-red'}`;

    document.getElementById('healthWsClients').textContent = health.wsClients ?? 0;
    document.getElementById('healthUptime').textContent = formatUptime(health.uptimeSeconds || 0);
    const rssMb = health.memory?.rss ? Math.round(health.memory.rss / 1024 / 1024) : 0;
    document.getElementById('healthMemory').textContent = `${rssMb} MB`;
    document.getElementById('healthMemoryCard').className = `stat-card ${rssMb > 1024 ? 'stat-yellow' : ''}`;

    const staleDevices = health.staleDevices || [];
    document.getElementById('healthStaleCount').textContent = staleDevices.length;
    const staleBody = document.getElementById('healthStaleTableBody');
    const staleEmpty = document.getElementById('healthStaleEmptyState');
    if (staleDevices.length === 0) {
      staleBody.innerHTML = '';
      staleEmpty.style.display = 'block';
    } else {
      staleEmpty.style.display = 'none';
      staleBody.innerHTML = staleDevices.map(d => `
        <tr>
          <td>${escapeHtml(d.name)}</td>
          <td>${escapeHtml(d.role)}</td>
          <td>${d.lastSeenMinutesAgo} min</td>
        </tr>`).join('');
    }

    const errors = health.recentErrors || [];
    document.getElementById('healthErrorCount').textContent = errors.length;
    const errorsList = document.getElementById('healthErrorsList');
    const errorsEmpty = document.getElementById('healthErrorsEmptyState');
    if (errors.length === 0) {
      errorsList.innerHTML = '';
      errorsEmpty.style.display = 'block';
    } else {
      errorsEmpty.style.display = 'none';
      errorsList.innerHTML = errors.map(e => `
        <div style="padding:10px;border-bottom:1px solid var(--border-color);">
          <div style="display:flex;justify-content:space-between;">
            <strong style="color:var(--danger-color, #dc2626);">${escapeHtml(e.context)}</strong>
            <span style="color:var(--text-muted);font-size:12px;">${new Date(e.timestamp).toLocaleString('fr-FR')}</span>
          </div>
          <div style="font-size:13px;margin-top:4px;">${escapeHtml(e.message)}</div>
        </div>`).join('');
    }

    document.getElementById('healthLastUpdated').textContent = `Mis à jour: ${new Date().toLocaleTimeString('fr-FR')}`;
  } catch (e) {
    console.error('[Health] Load error:', e);
  }
}

// ─── Operational KPIs Tab (point 6, "think like Palantir") ────────────
// Reuses the existing SEVERITY_LABELS constant (declared near the top of
// this file for incident cards).
function formatDurationMs(ms) {
  if (ms == null) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}min`;
}

async function loadKPIs() {
  try {
    const days = document.getElementById('kpisPeriod')?.value || '30';
    const res = await fetch(`${API_BASE}/admin/kpis?days=${days}`);
    if (!res.ok) throw new Error('Failed to load KPIs');
    const kpis = await res.json();

    document.getElementById('kpiTotalIncidents').textContent = kpis.totalIncidents;

    const falseAlarmPct = Math.round(kpis.falseAlarmRate * 100);
    document.getElementById('kpiFalseAlarmRate').textContent = `${falseAlarmPct}%`;
    document.getElementById('kpiFalseAlarmCard').className = `stat-card ${falseAlarmPct > 20 ? 'stat-yellow' : 'stat-green'}`;

    const tbody = document.getElementById('kpiSeverityTableBody');
    const emptyState = document.getElementById('kpiSeverityEmptyState');
    const severityEntries = Object.entries(kpis.incidentsBySeverity || {});
    if (severityEntries.length === 0) {
      tbody.innerHTML = '';
      emptyState.style.display = 'block';
    } else {
      emptyState.style.display = 'none';
      tbody.innerHTML = severityEntries.map(([severity, data]) => `
        <tr>
          <td>${SEVERITY_LABELS[severity] || severity}</td>
          <td>${data.count}</td>
          <td>${formatDurationMs(data.avgTimeToAcknowledgeMs)}</td>
          <td>${formatDurationMs(data.avgTimeToResolveMs)}</td>
        </tr>`).join('');
    }
  } catch (e) {
    console.error('[KPIs] Load error:', e);
  }
}

// ─── Data Fetching ───────────────────────────────────────────
async function refreshData() {
  try {
    const [healthRes, incRes, respRes, auditRes] = await Promise.all([
      fetch(`${API_BASE}/admin/health`),
      fetch(`${API_BASE}/admin/incidents`),
      fetch(`${API_BASE}/dispatch/responders`),
      fetch(`${API_BASE}/admin/audit`),
    ]);
    const health = await healthRes.json();
    incidents = await incRes.json();
    responders = await respRes.json();
    const audit = await auditRes.json();

    // Extract broadcast history from audit
    broadcastHistory = audit.filter(a => a.category === 'broadcast').slice(0, 10);

    updateServerStatus(true, health.wsClients || 0);
    updateStats();
    renderOverview();
    renderIncidents();
    renderArchives();
    renderResponders();
    renderBroadcastHistory();
    document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Failed to fetch data:', err);
    updateServerStatus(false, 0);
  }
}

function updateServerStatus(online, count) {
  const countEl = document.getElementById('connectedCount');
  if (countEl) countEl.textContent = count;
  // Don't override WS status if WS is connected
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const dot = document.getElementById('serverStatusDot');
    const text = document.getElementById('serverStatusText');
    if (dot) dot.className = `status-dot ${online ? 'online' : 'offline'}`;
    if (text) text.textContent = online ? 'Online' : 'Offline';
  }
}

// ─── Stats ───────────────────────────────────────────────────
function updateStats() {
  const active = incidents.filter(i => i.status === 'active').length;
  const ack = incidents.filter(i => i.status === 'acknowledged').length;
  const dispatched = incidents.filter(i => i.status === 'dispatched').length;
  const available = responders.filter(r => r.status === 'available').length;
  const onDuty = responders.filter(r => r.status === 'on_duty').length;

  document.getElementById('statActive').textContent = active;
  document.getElementById('statAcknowledged').textContent = ack;
  document.getElementById('statDispatched').textContent = dispatched;
  document.getElementById('statAvailable').textContent = available;
  document.getElementById('statOnDuty').textContent = onDuty;

  // Pulse indicator
  const pulse = document.getElementById('pulseActive');
  if (pulse) pulse.style.display = active > 0 ? 'block' : 'none';

  // Incidents tab stats
  const activeEl = document.getElementById('incActiveCount');
  const totalEl = document.getElementById('incTotalCount');
  if (activeEl) activeEl.textContent = `${active} Active`;
  if (totalEl) totalEl.textContent = `${incidents.length} Total`;
}

// ─── Time Formatting ─────────────────────────────────────────
function formatTimeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatDateTime(ts) {
  return new Date(ts).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ─── Overview Rendering ──────────────────────────────────────
function renderOverview() {
  // Active incidents
  const container = document.getElementById('overviewIncidents');
  const OV_AGING_RANK = { critical: 0, warning: 1 };
  const activeIncs = incidents
    .filter(i => i.status !== 'resolved' && !i.archived)
    .sort((a, b) => {
      const aRank = OV_AGING_RANK[incidentAgingTier(a)] ?? 2;
      const bRank = OV_AGING_RANK[incidentAgingTier(b)] ?? 2;
      return (aRank - bRank)
        || ((b.escalationLevel || 0) - (a.escalationLevel || 0))
        || ((SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
        || (b.timestamp - a.timestamp);
    });

  if (activeIncs.length === 0) {
    container.innerHTML = '<div class="ov-empty"><div class="ov-empty-icon">\u2705</div><div class="ov-empty-text">Aucun incident actif</div></div>';
  } else {
    container.innerHTML = activeIncs.map(inc => {
      const assignedCount = inc.assignedCount || (inc.respondingNames || []).length || 0;
      const assignedLabel = assignedCount > 0 ? `<span class="ov-inc-assigned">${assignedCount} unit\u00e9${assignedCount > 1 ? 's' : ''}</span>` : '<span class="ov-inc-unassigned">Non assign\u00e9</span>';
      const escClass = inc.escalationLevel === 2 ? ' escalated-hard' : inc.escalationLevel === 1 ? ' escalated-soft' : '';
      const escBadge = inc.escalationLevel === 2
        ? '<span class="badge badge-escalated-hard">\u23f0 Escalade N2</span>'
        : inc.escalationLevel === 1
          ? '<span class="badge badge-escalated">\u23f0 Escalade N1</span>'
          : '';
      const ovAgingTier = incidentAgingTier(inc);
      const ovAgingClass = ovAgingTier ? ` aging-${ovAgingTier}` : '';
      const ovAgingBadge = ovAgingTier ? `<span class="badge badge-aging-${ovAgingTier}">\u23f3 ${formatAgeMinutes(inc)}</span>` : '';
      return `
      <div class="ov-inc-card sev-${inc.severity}${escClass}${ovAgingClass}" onclick="openDetailModal('${inc.id}')">
        <div class="ov-inc-icon">${TYPE_ICONS[inc.type] || '\ud83d\udea8'}</div>
        <div class="ov-inc-body">
          <div class="ov-inc-top">
            <span class="ov-inc-ref">${formatIncidentId(inc.id)}</span>
            <span class="ov-inc-time">${formatTimeAgo(inc.timestamp)}</span>
          </div>
          <div class="ov-inc-type">${typeLabel(inc.type)}</div>
          <div class="ov-inc-addr">\ud83d\udccd ${inc.address || 'Adresse inconnue'}</div>
          <div class="ov-inc-bottom">
            <div class="ov-inc-badges">
              <span class="badge badge-${inc.severity}">${sevLabel(inc.severity)}</span>
              <span class="badge badge-${inc.status}">${statusLabel(inc.status)}</span>
              ${escBadge}
              ${ovAgingBadge}
              ${assignedLabel}
            </div>
            <div class="ov-inc-actions">
              ${inc.status === 'active' ? `<button class="ov-btn ov-btn-ack" onclick="event.stopPropagation(); acknowledgeIncident('${inc.id}')">\u2705 ACK</button>` : ''}
              <button class="ov-btn ov-btn-assign" onclick="event.stopPropagation(); openAssignModal('${inc.id}')">\ud83d\udc6e Assigner</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join('');
  }

  // Responders
  const respContainer = document.getElementById('overviewResponders');
  const ovStatusLabels = { available: 'Disponible', on_duty: 'En service', off_duty: 'Hors service', responding: 'En intervention' };
  const ovStatusColors = { available: '#22c55e', on_duty: '#3b82f6', off_duty: '#6b7280', responding: '#f59e0b' };
  if (responders.length === 0) {
    respContainer.innerHTML = '<div class="ov-empty"><div class="ov-empty-icon">\ud83d\udc6e</div><div class="ov-empty-text">Aucune unit\u00e9 enregistr\u00e9e</div></div>';
  } else {
    respContainer.innerHTML = responders.map(r => {
      const incCount = (r.assignedIncidents || []).length;
      const initials = (r.name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
      const statusColor = ovStatusColors[r.status] || '#6b7280';
      return `
      <div class="ov-resp-card">
        <div class="ov-resp-avatar" style="background:${statusColor}20;color:${statusColor};border:2px solid ${statusColor}">
          ${initials}
        </div>
        <div class="ov-resp-body">
          <div class="ov-resp-name">
            <span class="ov-resp-conn ${r.isConnected ? 'online' : 'offline'}"></span>
            ${r.name}
          </div>
          <div class="ov-resp-status" style="color:${statusColor}">${ovStatusLabels[r.status] || r.status}</div>
        </div>
        <div class="ov-resp-right">
          ${incCount > 0 ? `<span class="ov-resp-inc-count">${incCount}</span>` : ''}
          <span class="ov-resp-seen">Vu ${formatTimeAgo(r.lastSeen)}</span>
        </div>
      </div>`;
    }).join('');
  }
}

// ─── Incidents Rendering ─────────────────────────────────────
// ─── Unacknowledged-aging (triage SLA) ────────────────────────
const INCIDENT_ACK_WARNING_MINUTES = 5;
const INCIDENT_ACK_CRITICAL_MINUTES = 15;

function incidentAgeMinutes(inc) {
  return (Date.now() - inc.timestamp) / 60000;
}

function incidentAgingTier(inc) {
  if (inc.status !== 'active') return null;
  const mins = incidentAgeMinutes(inc);
  if (mins >= INCIDENT_ACK_CRITICAL_MINUTES) return 'critical';
  if (mins >= INCIDENT_ACK_WARNING_MINUTES) return 'warning';
  return null;
}

function formatAgeMinutes(inc) {
  const mins = Math.floor(incidentAgeMinutes(inc));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}`;
}

// ─── Duplicate-suggestion rendering + actions ─────────────────
const DUP_CONFIDENCE_LABELS = { 'same-reporter': 'Même rapporteur', family: 'Famille', proximity: 'À proximité' };

function renderDuplicateSuggestions(inc) {
  const dups = inc.possibleDuplicates || [];
  if (dups.length === 0) return '';
  return `<div class="inc-duplicates">${dups.map(d => {
    const other = incidents.find(i => i.id === d.id);
    const otherLabel = formatIncidentId(d.id);
    return `
      <div class="dup-suggestion">
        <span class="dup-badge ${d.confidence}">${DUP_CONFIDENCE_LABELS[d.confidence] || d.confidence}</span>
        <span class="dup-label">Possible doublon avec ${otherLabel}${other ? ' — ' + escapeHtml(other.address || '') : ''}</span>
        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); linkIncidents('${inc.id}','${d.id}')">Lier</button>
        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); dismissDuplicateSuggestion('${inc.id}','${d.id}')">Ignorer</button>
      </div>
    `;
  }).join('')}</div>`;
}

function renderLinkedIncidents(inc) {
  const linked = inc.linkedIncidentIds || [];
  if (linked.length === 0) return '';
  return `<div class="inc-linked">🔗 Lié à: ${linked.map(id => `<span class="linked-chip" onclick="event.stopPropagation(); openDetailModal('${id}')">${formatIncidentId(id)}</span>`).join('')}</div>`;
}

function refreshOpenDetailModal(id) {
  if (document.getElementById('detailModal')?.classList.contains('active')) {
    openDetailModal(id);
  }
}

async function linkIncidents(id, otherId) {
  try {
    const res = await fetch(`${API_BASE}/alerts/${encodeURIComponent(id)}/link/${encodeURIComponent(otherId)}`, { method: 'POST' });
    if (res.ok) { showToast('Incidents liés', 'success'); await refreshData(); refreshOpenDetailModal(id); }
    else { const err = await res.json().catch(() => ({})); showToast(err.error || 'Erreur lors de la liaison', 'error'); }
  } catch (e) {
    console.error('[Incidents] Link error:', e);
    showToast('Erreur réseau', 'error');
  }
}

async function dismissDuplicateSuggestion(id, otherId) {
  try {
    const res = await fetch(`${API_BASE}/alerts/${encodeURIComponent(id)}/duplicate-suggestion/${encodeURIComponent(otherId)}`, { method: 'DELETE' });
    if (res.ok) { showToast('Suggestion ignorée', 'info'); await refreshData(); refreshOpenDetailModal(id); }
    else { const err = await res.json().catch(() => ({})); showToast(err.error || 'Erreur', 'error'); }
  } catch (e) {
    console.error('[Incidents] Dismiss error:', e);
    showToast('Erreur réseau', 'error');
  }
}

// ─── Incidents list: filter, search, sort, cards/table ────────
let currentIncidentSearch = '';
let incidentViewMode = localStorage.getItem('talion_incident_view') || 'cards';

function onIncidentSearchInput(value) {
  currentIncidentSearch = (value || '').trim().toLowerCase();
  renderIncidents();
}

function setIncidentViewMode(mode) {
  incidentViewMode = mode;
  localStorage.setItem('talion_incident_view', mode);
  document.getElementById('btnViewCards')?.classList.toggle('active', mode === 'cards');
  document.getElementById('btnViewTable')?.classList.toggle('active', mode === 'table');
  renderIncidents();
}

function renderIncidents() {
  const container = document.getElementById('incidentsList');
  const nonArchived = incidents.filter(i => !i.archived);
  let filtered = nonArchived;
  if (currentFilter === 'all') {
    filtered = nonArchived.filter(i => i.status !== 'resolved');
  } else {
    filtered = nonArchived.filter(i => i.status === currentFilter);
  }
  if (currentIncidentSearch) {
    const q = currentIncidentSearch;
    filtered = filtered.filter(i =>
      (i.address || '').toLowerCase().includes(q) ||
      (i.description || '').toLowerCase().includes(q) ||
      (i.reportedBy || '').toLowerCase().includes(q) ||
      (i.id || '').toLowerCase().includes(q) ||
      typeLabel(i.type).toLowerCase().includes(q)
    );
  }

  const AGING_RANK = { critical: 0, warning: 1 };
  filtered.sort((a, b) => {
    const aRank = AGING_RANK[incidentAgingTier(a)] ?? 2;
    const bRank = AGING_RANK[incidentAgingTier(b)] ?? 2;
    return (aRank - bRank)
      || ((b.escalationLevel || 0) - (a.escalationLevel || 0))
      || ((SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3))
      || (b.timestamp - a.timestamp);
  });

  container.className = incidentViewMode === 'table' ? 'incident-table-wrapper' : 'incident-cards';

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><p>No incidents matching this filter</p></div>';
    return;
  }

  if (incidentViewMode === 'table') {
    renderIncidentsTable(container, filtered);
  } else {
    renderIncidentsCards(container, filtered);
  }
}

function renderIncidentsCards(container, filtered) {
  container.innerHTML = filtered.map(inc => {
    const names = inc.respondingNames || [];
    const assignedChips = names.length > 0
      ? `<div class="inc-assigned"><span class="inc-assigned-label">Assignés:</span>${names.map(n => `<span class="assigned-chip assigned-name-chip">${n}</span>`).join('')}</div>`
      : (inc.assignedCount > 0 ? `<div class="inc-assigned"><span class="inc-assigned-label">Assignés:</span><span class="assigned-chip">${inc.assignedCount} responder(s)</span></div>` : '');
    const escClass = inc.escalationLevel === 2 ? ' escalated-hard' : inc.escalationLevel === 1 ? ' escalated-soft' : '';
    const escBadge = inc.escalationLevel === 2
      ? '<span class="badge badge-escalated-hard">⏰ Escalade N2</span>'
      : inc.escalationLevel === 1
        ? '<span class="badge badge-escalated">⏰ Escalade N1</span>'
        : '';
    const agingTier = incidentAgingTier(inc);
    const agingClass = agingTier ? ` aging-${agingTier}` : '';
    const agingBadge = agingTier
      ? `<span class="badge badge-aging-${agingTier}">⏳ ${formatAgeMinutes(inc)} sans acquittement</span>`
      : '';

    return `
      <div class="incident-card sev-${inc.severity}${escClass}${agingClass}${inc.isDuress ? ' is-duress' : ''}" style="cursor:pointer;" onclick="openDetailModal('${inc.id}')">
        ${inc.isDuress ? '<div class="duress-banner">🔴 CODE DE CONTRAINTE — le SOS a été "annulé" sous la contrainte, menace réelle probable</div>' : ''}
        <div class="inc-header">
          <div class="inc-header-left">
            <span class="inc-type-icon">${TYPE_ICONS[inc.type] || '🚨'}</span>
            <div class="inc-info">
        <h4>${inc.id.includes(' — ') ? inc.id : formatIncidentId(inc.id) + ' — ' + typeLabel(inc.type)}</h4>
              <span class="inc-address">📍 ${inc.address}</span>         </div>
          </div>
          <div class="inc-badges">
            <span class="badge badge-${inc.severity}">${sevLabel(inc.severity)}</span>
            <span class="badge badge-${inc.status}">${statusLabel(inc.status)}</span>
            ${escBadge}
            ${agingBadge}
          </div>
        </div>
        <div class="inc-desc">Signalé par: ${inc.reportedBy}${(inc.photos && inc.photos.length > 0) ? ` · 📷 ${inc.photos.length} photo${inc.photos.length > 1 ? 's' : ''}` : ''}</div>
        <div class="inc-meta">⏱ ${formatTimeAgo(inc.timestamp)} · ${formatDateTime(inc.timestamp)}</div>
        ${assignedChips}
        ${renderLinkedIncidents(inc)}
        ${renderDuplicateSuggestions(inc)}
        <div class="inc-actions">
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openDetailModal('${inc.id}')">Détails</button>
          ${inc.status === 'active' ? `<button class="btn btn-warning btn-sm" onclick="event.stopPropagation(); acknowledgeIncident('${inc.id}')">Acquitter</button>` : ''}
          ${inc.status !== 'resolved' ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); openAssignModal('${inc.id}')">Assigner Unité</button>` : ''}
          ${inc.status !== 'resolved' ? `<button class="btn btn-success btn-sm" onclick="event.stopPropagation(); openResolveModal('${inc.id}')">Résoudre</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); archiveIncident('${inc.id}')">Archiver</button>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteIncident('${inc.id}')">Supprimer</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderIncidentsTable(container, filtered) {
  const rows = filtered.map(inc => {
    const agingTier = incidentAgingTier(inc);
    const rowClass = inc.isDuress ? ' class="is-duress"' : (agingTier ? ` class="aging-${agingTier}"` : '');
    const ageLabel = agingTier ? `⏳ ${formatAgeMinutes(inc)}` : formatTimeAgo(inc.timestamp);
    const dupCount = (inc.possibleDuplicates || []).length;
    const dupBadge = dupCount > 0 ? ` <span class="dup-badge proximity" title="Doublons possibles">${dupCount}×🔗</span>` : '';
    return `
      <tr${rowClass} onclick="openDetailModal('${inc.id}')">
        <td>${inc.isDuress ? '🔴 ' : ''}${formatIncidentId(inc.id)}${dupBadge}</td>
        <td>${TYPE_ICONS[inc.type] || '🚨'} ${typeLabel(inc.type)}</td>
        <td><span class="badge badge-${inc.severity}">${sevLabel(inc.severity)}</span></td>
        <td><span class="badge badge-${inc.status}">${statusLabel(inc.status)}</span></td>
        <td>${escapeHtml(inc.address || '')}</td>
        <td>${escapeHtml(inc.reportedBy || '')}</td>
        <td>${(inc.respondingNames || []).join(', ') || (inc.assignedCount ? `${inc.assignedCount} responder(s)` : '—')}</td>
        <td>${ageLabel}</td>
        <td class="it-actions">
          ${inc.status === 'active' ? `<button class="btn btn-warning btn-sm" onclick="event.stopPropagation(); acknowledgeIncident('${inc.id}')">Acquitter</button>` : ''}
          ${inc.status !== 'resolved' ? `<button class="btn btn-success btn-sm" onclick="event.stopPropagation(); openResolveModal('${inc.id}')">Résoudre</button>` : ''}
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); archiveIncident('${inc.id}')">Archiver</button>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteIncident('${inc.id}')">Supprimer</button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="incident-table">
      <thead><tr>
        <th>ID</th><th>Type</th><th>Sévérité</th><th>Statut</th><th>Adresse</th><th>Rapporté par</th><th>Assignés</th><th>Âge</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function filterIncidents(filter) {
  currentFilter = filter;
  document.querySelectorAll('#tab-incidents .chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`#tab-incidents .chip[data-filter="${filter}"]`)?.classList.add('active');
  renderIncidents();
}

// ─── Archive / Unarchive ──────────────────────────────────────
// Archiving hides an incident from the normal active views (cards, table,
// map, overview) without deleting it — it stays fully findable here.
let archiveViewMode = 'dispatch'; // 'dispatch' | 'mobile'

function setArchiveView(mode) {
  archiveViewMode = mode;
  document.querySelectorAll('#tab-archives .chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`#tab-archives .chip[data-archive-view="${mode}"]`)?.classList.add('active');
  renderArchives();
}

function renderArchives() {
  const container = document.getElementById('archivesList');
  if (!container) return;
  const archived = incidents
    .filter(i => i.archived && (i.origin || 'dispatch') === archiveViewMode)
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));

  document.getElementById('archiveCount').textContent = `${archived.length} archivée${archived.length !== 1 ? 's' : ''}`;

  if (archived.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🗄️</div><p>Aucune alerte archivée dans cette catégorie</p></div>';
    return;
  }

  container.innerHTML = archived.map(inc => `
    <div class="incident-card sev-${inc.severity}" style="cursor:pointer;" onclick="openDetailModal('${inc.id}')">
      <div class="inc-header">
        <div class="inc-header-left">
          <span class="inc-type-icon">${TYPE_ICONS[inc.type] || '🚨'}</span>
          <div class="inc-info">
            <h4>${inc.id.includes(' — ') ? inc.id : formatIncidentId(inc.id) + ' — ' + typeLabel(inc.type)}</h4>
            <span class="inc-address">📍 ${inc.address}</span>
          </div>
        </div>
        <div class="inc-badges">
          <span class="badge badge-${inc.severity}">${sevLabel(inc.severity)}</span>
          <span class="badge badge-${inc.status}">${statusLabel(inc.status)}</span>
        </div>
      </div>
      <div class="inc-desc">Signalé par: ${inc.reportedBy}</div>
      <div class="inc-meta">⏱ Créé ${formatTimeAgo(inc.timestamp)} · 🗄️ Archivé ${inc.archivedAt ? formatTimeAgo(inc.archivedAt) : ''}</div>
      <div class="inc-actions">
        <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openDetailModal('${inc.id}')">Détails</button>
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); unarchiveIncident('${inc.id}')">Désarchiver</button>
        <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteIncident('${inc.id}')">Supprimer</button>
      </div>
    </div>
  `).join('');
}

async function archiveIncident(id) {
  try {
    const res = await fetch(`${API_BASE}/alerts/${encodeURIComponent(id)}/archive`, { method: 'PUT' });
    if (res.ok) {
      showToast(`Incident ${formatIncidentId(id)} archivé`, 'success');
      if (document.getElementById('detailModal')?.classList.contains('active')) closeDetailModal();
      await refreshData();
      if (dispatchMap) refreshMapData();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erreur lors de l’archivage', 'error');
    }
  } catch (e) {
    console.error('[Incidents] Archive error:', e);
    showToast('Erreur réseau', 'error');
  }
}

async function unarchiveIncident(id) {
  try {
    const res = await fetch(`${API_BASE}/alerts/${encodeURIComponent(id)}/unarchive`, { method: 'PUT' });
    if (res.ok) {
      showToast(`Incident ${formatIncidentId(id)} désarchivé`, 'success');
      await refreshData();
      renderArchives();
      if (dispatchMap) refreshMapData();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erreur', 'error');
    }
  } catch (e) {
    console.error('[Incidents] Unarchive error:', e);
    showToast('Erreur réseau', 'error');
  }
}

// ─── Family Groups (presence: home/away per residence) ────────────────
let familyGroups = [];

async function loadFamilyGroups() {
  try {
    const res = await fetch(`${API_BASE}/dispatch/family-groups`);
    familyGroups = res.ok ? await res.json() : [];
  } catch (e) {
    console.error('[Families] Load error:', e);
    familyGroups = [];
  }
  renderFamilyGroups();
  loadUpcomingInterventions();
  loadUpcomingItineraries();
}

// ─── Main Courante + Analyse IA ─────────────────────────────────────────
async function ensureFamilyGroupsLoaded() {
  if (familyGroups.length > 0) return;
  try {
    const res = await fetch(`${API_BASE}/dispatch/family-groups`);
    familyGroups = res.ok ? await res.json() : [];
  } catch (e) {
    familyGroups = [];
  }
}

// Any member of the group works as the anchor userId — getFamilyMemberIds
// resolves the same family regardless of which member is picked.
function populateFamilySelect(selectId) {
  const select = document.getElementById(selectId);
  const current = select.value;
  select.innerHTML = '<option value="">— Choisir une famille —</option>' +
    familyGroups.map(g => `<option value="${g.members[0].id}">${escapeHtml(g.members.map(m => m.name).join(', '))}</option>`).join('');
  if (current) select.value = current;
}

async function loadMainCourante() {
  const userId = document.getElementById('mcFamilySelect').value;
  const container = document.getElementById('mainCouranteList');
  if (!userId) { container.innerHTML = '<div class="empty-state">Sélectionnez une famille</div>'; return; }
  const days = document.getElementById('mcDaysSelect').value;
  container.innerHTML = '<div class="empty-state">Chargement...</div>';
  try {
    const res = await fetch(`${API_BASE}/api/main-courante?userId=${userId}&days=${days}`);
    const entries = res.ok ? await res.json() : [];
    renderMainCourante(entries);
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Erreur de chargement</div>';
  }
}

const MC_SOURCE_ICON = { patrol: '🚶', blackbook: '👁️', manual: '📝' };

function renderMainCourante(entries) {
  const container = document.getElementById('mainCouranteList');
  if (!entries || entries.length === 0) {
    container.innerHTML = '<div class="empty-state">📖 Aucune entrée sur cette période</div>';
    return;
  }
  container.innerHTML = entries.map(e => `
    <div class="provider-row">
      <div>
        <div class="provider-row-name">${MC_SOURCE_ICON[e.source] || '•'} ${new Date(e.timestamp).toLocaleString('fr-FR')} — ${escapeHtml(e.summary)}</div>
        ${e.notes ? `<div class="provider-row-detail">${escapeHtml(e.notes)}</div>` : ''}
        <div class="provider-row-detail" style="font-style:italic;">${escapeHtml(e.createdByName || '')}</div>
      </div>
    </div>`).join('');
}

function openAddMainCouranteNote() {
  populateFamilySelect('mcNoteFamilySelect');
  const mcFamily = document.getElementById('mcFamilySelect').value;
  if (mcFamily) document.getElementById('mcNoteFamilySelect').value = mcFamily;
  document.getElementById('mcNoteText').value = '';
  document.getElementById('mcNoteModal').style.display = 'flex';
}

function closeAddMainCouranteNote() {
  document.getElementById('mcNoteModal').style.display = 'none';
}

async function submitMainCouranteNote() {
  const userId = document.getElementById('mcNoteFamilySelect').value;
  const text = document.getElementById('mcNoteText').value.trim();
  if (!userId) { alert('Sélectionnez une famille'); return; }
  if (!text) { alert('La note ne peut pas être vide'); return; }
  try {
    const res = await fetch(`${API_BASE}/api/main-courante`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, text }),
    });
    if (!res.ok) { alert('Impossible d\'ajouter la note'); return; }
    closeAddMainCouranteNote();
    if (document.getElementById('mcFamilySelect').value === userId) loadMainCourante();
  } catch (e) {
    alert('Erreur réseau');
  }
}

async function loadThreatAnalyses() {
  const userId = document.getElementById('taFamilySelect').value;
  const container = document.getElementById('threatAnalysisList');
  if (!userId) { container.innerHTML = '<div class="empty-state">Sélectionnez une famille</div>'; return; }
  container.innerHTML = '<div class="empty-state">Chargement...</div>';
  try {
    const res = await fetch(`${API_BASE}/admin/threat-analysis?userId=${userId}`);
    const analyses = res.ok ? await res.json() : [];
    renderThreatAnalyses(analyses);
  } catch (e) {
    container.innerHTML = '<div class="empty-state">Erreur de chargement</div>';
  }
}

const SEVERITY_LABELS_FR = { low: 'Faible', medium: 'Moyen', high: 'Élevé', critical: 'Critique' };

function renderThreatAnalyses(analyses) {
  const container = document.getElementById('threatAnalysisList');
  if (!analyses || analyses.length === 0) {
    container.innerHTML = '<div class="empty-state">🧠 Aucune analyse générée pour cette famille</div>';
    return;
  }
  container.innerHTML = analyses.map(a => `
    <div class="provider-row" style="flex-direction:column;align-items:stretch;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div class="provider-row-name">${new Date(a.generatedAt).toLocaleString('fr-FR')} — ${a.entryCount} entrée(s) sur ${a.periodDays}j</div>
        <span style="font-size:11px;color:var(--text-muted);">par ${escapeHtml(a.generatedByName)}</span>
      </div>
      <div class="provider-row-detail" style="margin:6px 0;">${escapeHtml(a.summary)}</div>
      ${(a.flaggedItems || []).map(item => `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;background:rgba(148,163,184,0.1);border-radius:6px;padding:8px;margin-top:6px;">
          <div style="flex:1;">
            <div style="font-size:12px;font-weight:700;color:${SEVERITY_COLORS[item.severity] || '#6b7280'};">${SEVERITY_LABELS_FR[item.severity] || item.severity} — ${escapeHtml(item.title)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${escapeHtml(item.rationale)}</div>
          </div>
          ${item.acknowledged
            ? `<span style="font-size:11px;color:#4ade80;white-space:nowrap;">✓ Acquitté</span>`
            : `<button class="btn btn-secondary btn-sm" onclick="acknowledgeThreatItem('${a.id}','${item.id}')">Acquitter</button>`}
        </div>`).join('')}
    </div>`).join('');
}

async function generateThreatAnalysis() {
  const userId = document.getElementById('taFamilySelect').value;
  if (!userId) { alert('Sélectionnez une famille'); return; }
  const btn = document.getElementById('taGenerateBtn');
  btn.disabled = true;
  btn.textContent = '⏳ Génération en cours...';
  try {
    const res = await fetch(`${API_BASE}/admin/threat-analysis/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Impossible de générer l\'analyse');
    } else {
      loadThreatAnalyses();
    }
  } catch (e) {
    alert('Erreur réseau');
  }
  btn.disabled = false;
  btn.textContent = '🧠 Générer une analyse (30 jours)';
}

async function acknowledgeThreatItem(analysisId, itemId) {
  try {
    const res = await fetch(`${API_BASE}/admin/threat-analysis/${analysisId}/items/${itemId}/acknowledge`, { method: 'PUT' });
    if (res.ok) loadThreatAnalyses();
  } catch (e) {
    alert('Erreur réseau');
  }
}

// ─── Cross-residence interventions calendar ────────────────────────────
function toggleInterventionsPanel() {
  const el = document.getElementById('interventionsUpcomingList');
  const caret = document.getElementById('interventionsCaret');
  if (!el) return;
  const isHidden = el.style.display === 'none';
  el.style.display = isHidden ? 'block' : 'none';
  if (caret) caret.textContent = isHidden ? '▴' : '▾';
}

async function loadUpcomingInterventions() {
  const container = document.getElementById('interventionsUpcomingList');
  if (!container) return;
  try {
    const res = await fetch(`${API_BASE}/api/interventions/upcoming`);
    const occurrences = res.ok ? await res.json() : [];
    if (occurrences.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:12px;"><p>Aucune intervention prévue cette semaine</p></div>';
      return;
    }
    container.innerHTML = occurrences.map(o => `
      <div class="intervention-row">
        <div class="intervention-row-main">
          <strong>${escapeHtml(o.personName)}</strong>${o.category ? ` <span class="intervention-category">${escapeHtml(o.category)}</span>` : ''}
          <div class="intervention-row-detail">${new Date(o.scheduledStart).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
          <div class="intervention-row-detail">📍 ${escapeHtml(o.ownerName || '')} — ${escapeHtml(o.addressLabel || '')}</div>
        </div>
      </div>`).join('');
  } catch (e) {
    console.error('[Interventions] Load error:', e);
    container.innerHTML = '<div class="empty-state" style="padding:12px;"><p>Erreur de chargement</p></div>';
  }
}

// ─── Cross-family travel itineraries — "who's away" for the dispatch week ──
function toggleItinerariesPanel() {
  const el = document.getElementById('itinerariesUpcomingList');
  const caret = document.getElementById('itinerariesCaret');
  if (!el) return;
  const isHidden = el.style.display === 'none';
  el.style.display = isHidden ? 'block' : 'none';
  if (caret) caret.textContent = isHidden ? '▴' : '▾';
}

async function loadUpcomingItineraries() {
  const container = document.getElementById('itinerariesUpcomingList');
  if (!container) return;
  try {
    const res = await fetch(`${API_BASE}/api/itineraries/upcoming`);
    const itineraries = res.ok ? await res.json() : [];
    if (itineraries.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding:12px;"><p>Aucun voyage annoncé cette semaine</p></div>';
      return;
    }
    container.innerHTML = itineraries.map(it => `
      <div class="intervention-row">
        <div class="intervention-row-main">
          <strong>${escapeHtml(it.userName)}</strong> → ${escapeHtml(it.destinationLabel)}
          <div class="intervention-row-detail">Départ: ${new Date(it.departureAt).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${it.returnAt ? ` · Retour: ${new Date(it.returnAt).toLocaleDateString('fr-FR')}` : ''}</div>
        </div>
      </div>`).join('');
  } catch (e) {
    console.error('[Itineraries] Load error:', e);
    container.innerHTML = '<div class="empty-state" style="padding:12px;"><p>Erreur de chargement</p></div>';
  }
}

// ─── Visits Tab: planned visits + a known-people directory (for doubt
// resolution — "is this person/plate/company known anywhere" independent
// of whether they have a visit scheduled right now) ─────────────────────
let visitsData = [];
let visitsSort = { key: 'scheduledStart', dir: -1 }; // most recent/soonest first by default
let peopleData = [];
let peopleSort = { key: 'name', dir: 1 };
let visitsActiveSubtab = 'visits';

function switchVisitsSubtab(subtab) {
  visitsActiveSubtab = subtab;
  document.getElementById('visitsSubtabBtn-visits').classList.toggle('active', subtab === 'visits');
  document.getElementById('visitsSubtabBtn-people').classList.toggle('active', subtab === 'people');
  document.getElementById('visitsSubtabBtn-global').classList.toggle('active', subtab === 'global');
  document.getElementById('visitsTableWrap').style.display = subtab === 'visits' ? 'block' : 'none';
  document.getElementById('peopleTableWrap').style.display = subtab === 'people' ? 'block' : 'none';
  document.getElementById('globalSearchWrap').style.display = subtab === 'global' ? 'block' : 'none';
  document.getElementById('visitsRangeFilter').style.display = subtab === 'visits' ? '' : 'none';
  document.getElementById('visitsCategoryFilter').style.display = subtab === 'global' ? 'none' : '';
  document.getElementById('visitsSearch').placeholder = subtab === 'visits'
    ? '🔍 Nom, société, plaque, résidence, famille...'
    : subtab === 'people'
      ? '🔍 Nom, société, plaque, résidence, famille (toutes personnes connues)...'
      : '🔍 Nom, téléphone, plaque — cherche dans Blackbook + Personnes connues + Comptes...';
  if (subtab === 'people' && peopleData.length === 0) loadKnownPeopleAll();
  else renderCurrentVisitsSubtab();
}

function refreshVisitsSubtab() {
  if (visitsActiveSubtab === 'visits') loadVisits();
  else if (visitsActiveSubtab === 'people') loadKnownPeopleAll();
  else renderGlobalSearch();
}

function renderCurrentVisitsSubtab() {
  if (visitsActiveSubtab === 'visits') renderVisitsTable();
  else if (visitsActiveSubtab === 'people') renderPeopleTable();
  else renderGlobalSearch();
}

// ─── Global entity search: Blackbook + Personnes connues + Comptes système ──
// Labels/badges shared with the mobile app via shared/entity-search.ts,
// bundled into shared.bundle.js (see index.html) - point 5 of the "think
// like Palantir" review (parity by construction, not by discipline).
const GLOBAL_SEARCH_SOURCE_LABEL = TalionShared.ENTITY_SEARCH_SOURCE_LABEL;
const GLOBAL_SEARCH_SOURCE_BADGE = TalionShared.ENTITY_SEARCH_SOURCE_BADGE;
let globalSearchTimer = null;

function renderGlobalSearch() {
  const query = (document.getElementById('visitsSearch')?.value || '').trim();
  clearTimeout(globalSearchTimer);
  if (query.length < 2) {
    document.getElementById('globalSearchTableBody').innerHTML = '';
    document.getElementById('globalSearchEmptyState').style.display = 'block';
    document.getElementById('globalSearchEmptyState').querySelector('p').textContent = 'Tapez au moins 2 caractères pour rechercher';
    document.getElementById('visitsCount').textContent = '';
    return;
  }
  globalSearchTimer = setTimeout(() => loadGlobalSearch(query), 300);
}

async function loadGlobalSearch(query) {
  try {
    const res = await fetch(`${API_BASE}/api/entity-search?q=${encodeURIComponent(query)}`);
    const results = res.ok ? await res.json() : [];
    const tbody = document.getElementById('globalSearchTableBody');
    const emptyState = document.getElementById('globalSearchEmptyState');
    document.getElementById('visitsCount').textContent = `${results.length} résultat${results.length !== 1 ? 's' : ''}`;
    if (results.length === 0) {
      tbody.innerHTML = '';
      emptyState.querySelector('p').textContent = 'Aucun résultat';
      emptyState.style.display = 'block';
      return;
    }
    emptyState.style.display = 'none';
    tbody.innerHTML = results.map(r => `
      <tr>
        <td><span class="stat-badge ${GLOBAL_SEARCH_SOURCE_BADGE[r.source] || ''}">${GLOBAL_SEARCH_SOURCE_LABEL[r.source] || r.source}</span></td>
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.detail)}</td>
      </tr>`).join('');
  } catch (e) {
    console.error('[GlobalSearch] Error:', e);
  }
}

async function loadKnownPeopleAll() {
  try {
    const res = await fetch(`${API_BASE}/api/known-people/all`);
    peopleData = res.ok ? await res.json() : [];
  } catch (e) {
    console.error('[Visits] Load known people error:', e);
    peopleData = [];
  }
  renderPeopleTable();
}

function sortPeopleBy(key) {
  if (peopleSort.key === key) peopleSort.dir *= -1;
  else peopleSort = { key, dir: 1 };
  renderPeopleTable();
}

function renderPeopleTable() {
  const tbody = document.getElementById('peopleTableBody');
  const emptyState = document.getElementById('peopleEmptyState');
  if (!tbody) return;

  const query = (document.getElementById('visitsSearch')?.value || '').trim().toLowerCase();
  const categoryFilter = document.getElementById('visitsCategoryFilter')?.value || '';

  let rows = peopleData.filter(p => {
    if (categoryFilter && p.category !== categoryFilter) return false;
    if (!query) return true;
    const haystack = [p.name, p.company, p.vehiclePlate, p.phone, p.addressLabel, p.address, p.ownerName]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });

  rows.sort((a, b) => {
    const av = a[peopleSort.key] ?? '';
    const bv = b[peopleSort.key] ?? '';
    if (av < bv) return -1 * peopleSort.dir;
    if (av > bv) return 1 * peopleSort.dir;
    return 0;
  });

  document.getElementById('visitsCount').textContent = `${rows.length} personne${rows.length !== 1 ? 's' : ''}`;

  if (rows.length === 0) {
    tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'block';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  tbody.innerHTML = rows.map(p => `
    <tr onclick="openProvidersModal('${p.addressId}', '${escapeHtml(p.addressLabel || '').replace(/'/g, "\\'")}')" title="Cliquer pour gérer cette résidence">
      <td><strong>${escapeHtml(p.name)}</strong></td>
      <td>${escapeHtml(p.company || '—')}</td>
      <td>${PROVIDER_CATEGORY_LABEL[p.category] || escapeHtml(p.category || '—')}</td>
      <td>${escapeHtml(p.phone || '—')}</td>
      <td>${escapeHtml(p.vehiclePlate || '—')}</td>
      <td>${escapeHtml(p.addressLabel || '—')}</td>
      <td>${escapeHtml(p.ownerName || '—')}</td>
    </tr>`).join('');
}

// ─── Residence Picker — entry point to add a person/visit "from scratch"
// (not already viewing a specific family member's chip) ────────────────
let allResidencesCache = null;

async function openResidencePicker() {
  document.getElementById('residencePickerSearch').value = '';
  document.getElementById('residencePickerModal').style.display = 'flex';
  if (!allResidencesCache) {
    try {
      const res = await fetch(`${API_BASE}/dispatch/all-residences`);
      allResidencesCache = res.ok ? await res.json() : [];
    } catch (e) {
      allResidencesCache = [];
    }
  }
  renderResidencePickerList();
}

function closeResidencePicker() {
  document.getElementById('residencePickerModal').style.display = 'none';
}

function renderResidencePickerList() {
  const container = document.getElementById('residencePickerList');
  const query = (document.getElementById('residencePickerSearch').value || '').trim().toLowerCase();
  const list = (allResidencesCache || []).filter(r => {
    if (!query) return true;
    return [r.label, r.address, r.userName].filter(Boolean).join(' ').toLowerCase().includes(query);
  });
  if (list.length === 0) {
    container.innerHTML = '<div class="presence-place-empty">Aucune résidence trouvée</div>';
    return;
  }
  container.innerHTML = list.map(r => `
    <div class="presence-place-item" onclick="closeResidencePicker(); openProvidersModal('${r.id}', '${escapeHtml(r.label).replace(/'/g, "\\'")}')">
      <div>
        <div style="font-weight:600;">${getPlaceIcon(r.label)} ${escapeHtml(r.label)}</div>
        <div style="font-size:12px;color:var(--text-muted);">${escapeHtml(r.userName)} — ${escapeHtml(r.address || '')}</div>
      </div>
    </div>`).join('');
}

async function loadVisits() {
  const rangeVal = parseInt(document.getElementById('visitsRangeFilter')?.value || '30', 10);
  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const from = rangeVal < 0 ? now + rangeVal * DAY_MS : now;
  const to = rangeVal < 0 ? now : now + rangeVal * DAY_MS;
  try {
    const res = await fetch(`${API_BASE}/api/interventions/upcoming?from=${from}&to=${to}`);
    visitsData = res.ok ? await res.json() : [];
  } catch (e) {
    console.error('[Visits] Load error:', e);
    visitsData = [];
  }
  renderVisitsTable();
}

function sortVisitsBy(key) {
  if (visitsSort.key === key) visitsSort.dir *= -1;
  else visitsSort = { key, dir: 1 };
  renderVisitsTable();
}

function renderVisitsTable() {
  const tbody = document.getElementById('visitsTableBody');
  const emptyState = document.getElementById('visitsEmptyState');
  if (!tbody) return;

  const query = (document.getElementById('visitsSearch')?.value || '').trim().toLowerCase();
  const categoryFilter = document.getElementById('visitsCategoryFilter')?.value || '';

  let rows = visitsData.filter(o => {
    if (categoryFilter && o.category !== categoryFilter) return false;
    if (!query) return true;
    const haystack = [o.personName, o.personCompany, o.personVehiclePlate, o.personPhone, o.addressLabel, o.address, o.ownerName]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });

  rows.sort((a, b) => {
    const av = a[visitsSort.key] ?? '';
    const bv = b[visitsSort.key] ?? '';
    if (av < bv) return -1 * visitsSort.dir;
    if (av > bv) return 1 * visitsSort.dir;
    return 0;
  });

  document.getElementById('visitsCount').textContent = `${rows.length} visite${rows.length !== 1 ? 's' : ''}`;

  if (rows.length === 0) {
    tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'block';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  const STATUS_LABEL = { scheduled: '🕓 Prévue', completed: '✅ Terminée', cancelled: '❌ Annulée' };
  tbody.innerHTML = rows.map(o => `
    <tr onclick="openProvidersModal('${o.addressId}', '${escapeHtml(o.addressLabel || '').replace(/'/g, "\\'")}')" title="Cliquer pour gérer cette résidence">
      <td>${new Date(o.scheduledStart).toLocaleString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${o.recurrence ? ' 🔁' : ''}</td>
      <td><strong>${escapeHtml(o.personName)}</strong></td>
      <td>${escapeHtml(o.personCompany || '—')}</td>
      <td>${PROVIDER_CATEGORY_LABEL[o.category] || escapeHtml(o.category || '—')}</td>
      <td>${escapeHtml(o.personPhone || '—')}</td>
      <td>${escapeHtml(o.personVehiclePlate || '—')}</td>
      <td>${escapeHtml(o.addressLabel || '—')}</td>
      <td>${escapeHtml(o.ownerName || '—')}</td>
      <td>${STATUS_LABEL[o.status] || o.status}</td>
    </tr>`).join('');
}

// ─── Known People & Planned Interventions (per residence) ─────────────
const PROVIDER_CATEGORY_LABEL = {
  jardinier: '🌳 Jardinier', piscine: '🏊 Piscine', plombier: '🔧 Plombier', electricien: '⚡ Électricien',
  menage: '🧹 Ménage', securite: '🔒 Sécurité', entrepreneur: '🏗️ Entrepreneur', livraison: '📦 Livraison',
  visiteur: '👤 Visiteur', autre: '❓ Autre',
};
let providersAddressId = null;
let providersKnownPeople = [];
let providersInterventions = [];
let providersGuests = [];

async function openProvidersModal(addressId, addressLabel) {
  providersAddressId = addressId;
  document.getElementById('providersModalTitle').textContent = `🔧 Prestataires — ${addressLabel}`;
  document.getElementById('addPersonForm').style.display = 'none';
  document.getElementById('addInterventionForm').style.display = 'none';
  document.getElementById('addGuestForm').style.display = 'none';
  document.getElementById('providersModal').style.display = 'flex';
  await loadProviders();
}

function closeProvidersModal() {
  document.getElementById('providersModal').style.display = 'none';
  providersAddressId = null;
}

async function loadProviders() {
  if (!providersAddressId) return;
  try {
    const [peopleRes, ivRes, guestsRes] = await Promise.all([
      fetch(`${API_BASE}/api/addresses/${providersAddressId}/people`),
      fetch(`${API_BASE}/api/addresses/${providersAddressId}/interventions`),
      fetch(`${API_BASE}/api/addresses/${providersAddressId}/guests`),
    ]);
    providersKnownPeople = peopleRes.ok ? await peopleRes.json() : [];
    providersInterventions = ivRes.ok ? await ivRes.json() : [];
    providersGuests = guestsRes.ok ? await guestsRes.json() : [];
  } catch (e) {
    providersKnownPeople = []; providersInterventions = []; providersGuests = [];
  }
  renderKnownPeople();
  renderInterventions();
  renderGuests();
}

function renderGuests() {
  const container = document.getElementById('guestsListContainer');
  if (providersGuests.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">Aucun invité pré-autorisé</p>';
    return;
  }
  container.innerHTML = providersGuests.map(g => `
    <div class="provider-row">
      <div>
        <div class="provider-row-name">${escapeHtml(g.guestName)}</div>
        ${g.eventLabel ? `<div class="provider-row-detail">${escapeHtml(g.eventLabel)}</div>` : ''}
        ${g.guestPhone ? `<div class="provider-row-detail">📞 ${escapeHtml(g.guestPhone)}</div>` : ''}
        <div class="provider-row-detail">Du ${new Date(g.validFrom).toLocaleDateString('fr-FR')} au ${new Date(g.validUntil).toLocaleDateString('fr-FR')}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteGuest('${g.id}')">🗑️</button>
    </div>`).join('');
}

function toggleAddGuestForm() {
  const form = document.getElementById('addGuestForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function saveGuest() {
  const guestName = document.getElementById('guestName').value.trim();
  const validFromVal = document.getElementById('guestValidFrom').value;
  const validUntilVal = document.getElementById('guestValidUntil').value;
  if (!guestName || !validFromVal || !validUntilVal) { showToast('Nom et dates requis', 'error'); return; }
  try {
    const res = await fetch(`${API_BASE}/api/addresses/${providersAddressId}/guests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        guestName,
        guestPhone: document.getElementById('guestPhone').value.trim() || undefined,
        eventLabel: document.getElementById('guestEventLabel').value.trim() || undefined,
        validFrom: new Date(validFromVal).getTime(),
        validUntil: new Date(validUntilVal).getTime(),
      }),
    });
    if (!res.ok) throw new Error('failed');
    document.getElementById('guestName').value = '';
    document.getElementById('guestPhone').value = '';
    document.getElementById('guestEventLabel').value = '';
    document.getElementById('guestValidFrom').value = '';
    document.getElementById('guestValidUntil').value = '';
    document.getElementById('addGuestForm').style.display = 'none';
    showToast('Invité ajouté', 'success');
    await loadProviders();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function deleteGuest(guestId) {
  if (!confirm('Retirer cet invité ?')) return;
  try {
    await fetch(`${API_BASE}/api/addresses/${providersAddressId}/guests/${guestId}`, { method: 'DELETE' });
    showToast('Invité retiré', 'success');
    await loadProviders();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

function renderKnownPeople() {
  const container = document.getElementById('knownPeopleList');
  if (providersKnownPeople.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">Aucune personne enregistrée</p>';
  } else {
    container.innerHTML = providersKnownPeople.map(p => `
      <div class="provider-row">
        <div>
          <div class="provider-row-name">${escapeHtml(p.name)} <span class="provider-row-category">${PROVIDER_CATEGORY_LABEL[p.category] || escapeHtml(p.category)}</span></div>
          ${p.company ? `<div class="provider-row-detail">${escapeHtml(p.company)}</div>` : ''}
          ${p.phone ? `<div class="provider-row-detail">📞 ${escapeHtml(p.phone)}</div>` : ''}
          ${p.vehiclePlate ? `<div class="provider-row-detail">🚗 ${escapeHtml(p.vehiclePlate)}</div>` : ''}
          ${p.notes ? `<div class="provider-row-detail">${escapeHtml(p.notes)}</div>` : ''}
          <span class="stat-badge ${TalionShared.VERIFICATION_STATUS_BADGE[p.verificationStatus || 'pending']}" style="cursor:pointer;margin-top:4px;display:inline-block;" onclick="cycleVerificationStatus('${p.id}', '${p.verificationStatus || 'pending'}')">${TalionShared.VERIFICATION_STATUS_LABEL[p.verificationStatus || 'pending']}</span>
        </div>
        <button class="btn btn-danger btn-sm" onclick="deleteKnownPerson('${p.id}')">🗑️</button>
      </div>`).join('');
  }
  const select = document.getElementById('interventionPersonId');
  select.innerHTML = providersKnownPeople.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('') || '<option value="">Aucun prestataire — ajoutez-en un d\'abord</option>';
}

function renderInterventions() {
  const container = document.getElementById('interventionsListContainer');
  if (providersInterventions.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">Aucune intervention prévue</p>';
    return;
  }
  container.innerHTML = providersInterventions.map(iv => `
    <div class="provider-row">
      <div>
        <div class="provider-row-name">${escapeHtml(iv.personName)}</div>
        <div class="provider-row-detail">${formatInterventionDate(iv.scheduledStart, iv.recurrence)}</div>
        ${iv.notes ? `<div class="provider-row-detail">${escapeHtml(iv.notes)}</div>` : ''}
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteIntervention('${iv.id}')">🗑️</button>
    </div>`).join('');
}

function formatInterventionDate(ts, recurrence) {
  const d = new Date(ts);
  const dateStr = d.toLocaleDateString('fr-FR');
  const timeStr = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (recurrence && recurrence.frequency === 'weekly') {
    const days = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
    return `Tous les ${recurrence.daysOfWeek.map(d2 => days[d2]).join(', ')} à ${timeStr}`;
  }
  return `${dateStr} à ${timeStr}`;
}

function toggleAddPersonForm() {
  const form = document.getElementById('addPersonForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

function toggleAddInterventionForm() {
  const form = document.getElementById('addInterventionForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
}

async function saveKnownPerson() {
  const name = document.getElementById('personName').value.trim();
  if (!name) { showToast('Nom requis', 'error'); return; }
  try {
    const res = await fetch(`${API_BASE}/api/addresses/${providersAddressId}/people`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, category: document.getElementById('personCategory').value,
        company: document.getElementById('personCompany').value.trim() || undefined,
        phone: document.getElementById('personPhone').value.trim() || undefined,
        vehiclePlate: document.getElementById('personPlate').value.trim() || undefined,
        notes: document.getElementById('personNotes').value.trim() || undefined,
      }),
    });
    if (!res.ok) throw new Error('failed');
    document.getElementById('personName').value = '';
    document.getElementById('personCompany').value = '';
    document.getElementById('personPhone').value = '';
    document.getElementById('personPlate').value = '';
    document.getElementById('personNotes').value = '';
    document.getElementById('addPersonForm').style.display = 'none';
    showToast('Personne ajoutée', 'success');
    await loadProviders();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function cycleVerificationStatus(personId, currentStatus) {
  const nextStatus = TalionShared.VERIFICATION_STATUS_NEXT[currentStatus] || 'verified';
  try {
    const res = await fetch(`${API_BASE}/api/addresses/${providersAddressId}/people/${personId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verificationStatus: nextStatus }),
    });
    if (!res.ok) throw new Error('failed');
    await loadProviders();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function deleteKnownPerson(personId) {
  if (!confirm('Retirer cette personne ?')) return;
  try {
    await fetch(`${API_BASE}/api/addresses/${providersAddressId}/people/${personId}`, { method: 'DELETE' });
    showToast('Personne retirée', 'success');
    await loadProviders();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function saveIntervention() {
  const personId = document.getElementById('interventionPersonId').value;
  const person = providersKnownPeople.find(p => p.id === personId);
  if (!person) { showToast('Choisissez un prestataire', 'error'); return; }
  const dateVal = document.getElementById('interventionDate').value;
  const timeVal = document.getElementById('interventionTime').value || '09:00';
  if (!dateVal) { showToast('Date requise', 'error'); return; }
  const scheduledStart = new Date(`${dateVal}T${timeVal}:00`).getTime();
  const recurring = document.getElementById('interventionRecurring').checked;
  try {
    const res = await fetch(`${API_BASE}/api/addresses/${providersAddressId}/interventions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personId: person.id, personName: person.name, category: person.category, scheduledStart,
        recurrence: recurring ? { frequency: 'weekly', daysOfWeek: [new Date(scheduledStart).getDay()] } : undefined,
        notes: document.getElementById('interventionNotes').value.trim() || undefined,
      }),
    });
    if (!res.ok) throw new Error('failed');
    document.getElementById('interventionDate').value = '';
    document.getElementById('interventionNotes').value = '';
    document.getElementById('interventionRecurring').checked = false;
    document.getElementById('addInterventionForm').style.display = 'none';
    showToast('Intervention planifiée', 'success');
    await loadProviders();
    loadUpcomingInterventions();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function deleteIntervention(interventionId) {
  if (!confirm('Annuler cette intervention ?')) return;
  try {
    await fetch(`${API_BASE}/api/addresses/${providersAddressId}/interventions/${interventionId}`, { method: 'DELETE' });
    showToast('Intervention annulée', 'success');
    await loadProviders();
    loadUpcomingInterventions();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

// ─── Blackbook: suspicious persons registry ────────────────────────────
const BLACKBOOK_CATEGORY_LABELS = {
  prise_info: "Prise d'info", intrusion: 'Intrusion', menaces: 'Menaces',
  envoi_courrier: 'Envoi de courrier', reperage: 'Repérage', autre: 'Autre',
};
const BLACKBOOK_RISK_LABELS = { low: '🟢 Faible', medium: '🟡 Moyen', high: '🟠 Élevé', critical: '🔴 Critique' };
const BLACKBOOK_STATUS_LABELS = { active: 'Surveillance active', resolved: 'Résolu', archived: 'Archivé' };

let blackbookData = [];
let blackbookSort = { key: 'lastSeenAt', dir: -1 };
let currentBlackbookEntry = null; // null while creating a new entry
let currentBlackbookVehicles = [];

function blackbookLastSighting(entry) {
  if (!entry.sightings || entry.sightings.length === 0) return null;
  return entry.sightings.reduce((latest, s) => (!latest || s.timestamp > latest.timestamp ? s : latest), null);
}

async function loadBlackbook() {
  try {
    const res = await fetch(`${API_BASE}/api/blackbook`);
    const data = res.ok ? await res.json() : [];
    blackbookData = data.map(e => {
      const last = blackbookLastSighting(e);
      return {
        ...e, lastSeenAt: last?.timestamp || 0, lastSeenLocation: last?.location?.address || '', lastSeenCategory: last?.category,
        lastSeenResidenceLabel: last?.residenceLabel, lastSeenOwnerName: last?.residenceOwnerName,
      };
    });
  } catch (e) {
    console.error('[Blackbook] Load error:', e);
    blackbookData = [];
  }
  renderBlackbookTable();
}

function sortBlackbookBy(key) {
  if (blackbookSort.key === key) blackbookSort.dir *= -1;
  else blackbookSort = { key, dir: 1 };
  renderBlackbookTable();
}

function renderBlackbookTable() {
  const tbody = document.getElementById('blackbookTableBody');
  const emptyState = document.getElementById('blackbookEmptyState');
  if (!tbody) return;

  const query = (document.getElementById('blackbookSearch')?.value || '').trim().toLowerCase();
  const riskFilter = document.getElementById('blackbookRiskFilter')?.value || '';
  const statusFilter = document.getElementById('blackbookStatusFilter')?.value || '';

  let rows = blackbookData.filter(e => {
    if (riskFilter && e.riskLevel !== riskFilter) return false;
    if (statusFilter && e.status !== statusFilter) return false;
    if (!query) return true;
    const haystack = [
      e.firstName, e.lastName, (e.aliases || []).join(' '), e.notes, e.lastSeenLocation,
      ...(e.vehicles || []).map(v => `${v.plate || ''} ${v.description || ''}`),
      ...(e.tags || []),
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query);
  });

  rows.sort((a, b) => {
    const av = a[blackbookSort.key] ?? '';
    const bv = b[blackbookSort.key] ?? '';
    if (av < bv) return -1 * blackbookSort.dir;
    if (av > bv) return 1 * blackbookSort.dir;
    return 0;
  });

  document.getElementById('blackbookCount').textContent = `${rows.length} fiche${rows.length !== 1 ? 's' : ''}`;

  if (rows.length === 0) {
    tbody.innerHTML = '';
    if (emptyState) emptyState.style.display = 'block';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  tbody.innerHTML = rows.map(e => `
    <tr onclick="openBlackbookDetail('${e.id}')" title="Cliquer pour ouvrir la fiche">
      <td><strong>${escapeHtml(e.firstName)} ${escapeHtml(e.lastName)}</strong></td>
      <td>${(e.aliases || []).map(escapeHtml).join(', ') || '—'}</td>
      <td>${e.linkedUserName ? `<span class="tag-chip" style="background:#fef3c7;color:#92400e;">🔗 ${escapeHtml(e.linkedUserName)}</span>` : '—'}</td>
      <td>${BLACKBOOK_RISK_LABELS[e.riskLevel] || e.riskLevel}</td>
      <td>${BLACKBOOK_STATUS_LABELS[e.status] || e.status}</td>
      <td>${e.lastSeenAt ? new Date(e.lastSeenAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + (e.lastSeenCategory ? ' — ' + (BLACKBOOK_CATEGORY_LABELS[e.lastSeenCategory] || e.lastSeenCategory) : '') : '—'}</td>
      <td>${e.lastSeenOwnerName ? `🏠 ${escapeHtml(e.lastSeenResidenceLabel || '')} — ${escapeHtml(e.lastSeenOwnerName)}` : escapeHtml(e.lastSeenLocation || '—')}</td>
      <td>${(e.tags || []).map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join(' ') || '—'}</td>
    </tr>`).join('');
}

function renderBlackbookVehicles() {
  const container = document.getElementById('bbVehiclesList');
  container.innerHTML = currentBlackbookVehicles.map((v, i) => `
    <div style="display:flex;gap:6px;">
      <input type="text" class="form-control" placeholder="Plaque" value="${escapeHtml(v.plate || '')}" style="flex:1;" oninput="currentBlackbookVehicles[${i}].plate = this.value">
      <input type="text" class="form-control" placeholder="Description (marque, modèle, couleur)" value="${escapeHtml(v.description || '')}" style="flex:2;" oninput="currentBlackbookVehicles[${i}].description = this.value">
      <button type="button" class="btn btn-danger btn-sm" onclick="removeBlackbookVehicleRow(${i})">✕</button>
    </div>`).join('');
}

function addBlackbookVehicleRow() {
  currentBlackbookVehicles.push({ plate: '', description: '' });
  renderBlackbookVehicles();
}

function removeBlackbookVehicleRow(i) {
  currentBlackbookVehicles.splice(i, 1);
  renderBlackbookVehicles();
}

function renderBlackbookPhotos() {
  const container = document.getElementById('bbPhotosGallery');
  const photos = currentBlackbookEntry?.photos || [];
  if (photos.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">Aucune photo</p>';
    return;
  }
  container.innerHTML = photos.map(url => {
    const fullUrl = url.startsWith('http') ? url : API_BASE + url;
    return `
    <div style="position:relative;">
      <a href="${fullUrl}" target="_blank" rel="noopener">
        <img src="${fullUrl}" style="width:90px;height:90px;object-fit:cover;border-radius:8px;border:1px solid var(--border-main);cursor:pointer;">
      </a>
      <button onclick="deleteBlackbookPhoto('${url}')" style="position:absolute;top:-6px;right:-6px;background:#ef4444;color:#fff;border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:11px;line-height:1;">✕</button>
    </div>`;
  }).join('');
}

function renderBlackbookSightings() {
  const container = document.getElementById('bbSightingsList');
  const sightings = (currentBlackbookEntry?.sightings || []).slice().sort((a, b) => b.timestamp - a.timestamp);
  if (sightings.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">Aucun signalement enregistré</p>';
    return;
  }
  container.innerHTML = sightings.map(s => `
    <div class="provider-row">
      <div>
        <div class="provider-row-name">${new Date(s.timestamp).toLocaleString('fr-FR')} — ${BLACKBOOK_CATEGORY_LABELS[s.category] || s.category}</div>
        ${s.residenceId
          ? `<div class="provider-row-detail" style="font-weight:700;color:#92400e;">🏠 ${escapeHtml(s.residenceLabel || '')} — Famille : ${escapeHtml(s.residenceOwnerName || '')}</div>`
          : (s.location?.address ? `<div class="provider-row-detail">📍 ${escapeHtml(s.location.address)}</div>` : '')}
        ${s.notes ? `<div class="provider-row-detail">${escapeHtml(s.notes)}</div>` : ''}
        <div class="provider-row-detail" style="font-style:italic;">Signalé par ${escapeHtml(s.reportedByName)}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="deleteSighting('${s.id}')">🗑️</button>
    </div>`).join('');
}

// Deterministic plate/name matching against other Blackbook entries (see
// findRelatedBlackbookEntries server-side) — not AI, just string matching.
async function renderBlackbookRelated(entryId) {
  const section = document.getElementById('bbRelatedSection');
  const list = document.getElementById('bbRelatedList');
  try {
    const res = await fetch(`${API_BASE}/api/blackbook/${entryId}/related`);
    const related = res.ok ? await res.json() : [];
    if (!related.length) { section.style.display = 'none'; return; }
    section.style.display = 'block';
    list.innerHTML = related.map(r => `
      <button class="btn btn-sm" style="cursor:pointer;" onclick="openBlackbookDetail('${r.entryId}')" title="Correspondance : ${escapeHtml(r.matchType)} — ${escapeHtml(r.matchValue)}">
        ${BLACKBOOK_RISK_LABELS[r.riskLevel] || r.riskLevel} ${escapeHtml(r.name)}
      </button>
    `).join('');
  } catch (e) {
    section.style.display = 'none';
  }
}

let allUsersCache = null;

async function ensureAllUsersLoaded() {
  if (allUsersCache) return;
  try {
    const res = await fetch(`${API_BASE}/api/users`);
    allUsersCache = res.ok ? await res.json() : [];
  } catch (e) {
    allUsersCache = [];
  }
}

function populateBlackbookLinkedUserSelect(selectedId) {
  const select = document.getElementById('bbLinkedUserId');
  select.innerHTML = '<option value="">— Aucun —</option>' +
    (allUsersCache || []).map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  select.value = selectedId || '';
}

// ─── Dispatch-initiated check-in request (any user, spontaneous or recurring) ──
async function openCheckInRequestModal() {
  await ensureAllUsersLoaded();
  const select = document.getElementById('checkinRequestUserId');
  select.innerHTML = (allUsersCache || [])
    .filter(u => u.role === 'user')
    .map(u => `<option value="${u.id}">${escapeHtml(u.name)}</option>`).join('');
  document.getElementById('checkinRequestType').value = 'spontaneous';
  document.getElementById('checkinRequestGrace').value = '30';
  onCheckInRequestTypeChange();
  document.getElementById('checkinRequestModal').style.display = 'flex';
}

function closeCheckInRequestModal() {
  document.getElementById('checkinRequestModal').style.display = 'none';
}

function onCheckInRequestTypeChange() {
  const isDaily = document.getElementById('checkinRequestType').value === 'daily';
  document.getElementById('checkinRequestDailyFields').style.display = isDaily ? 'block' : 'none';
}

async function submitCheckInRequest() {
  const targetUserId = document.getElementById('checkinRequestUserId').value;
  if (!targetUserId) { alert('Sélectionnez un utilisateur'); return; }
  const type = document.getElementById('checkinRequestType').value;
  const grace = parseInt(document.getElementById('checkinRequestGrace').value, 10) || 30;
  const body = { targetUserId, graceMinutes: grace };

  if (type === 'daily') {
    const hour = parseInt(document.getElementById('checkinRequestHour').value, 10);
    const minute = parseInt(document.getElementById('checkinRequestMinute').value, 10);
    if (isNaN(hour) || hour < 0 || hour > 23 || isNaN(minute) || minute < 0 || minute > 59) {
      alert('Heure invalide');
      return;
    }
    const due = new Date();
    due.setHours(hour, minute, 0, 0);
    if (due.getTime() <= Date.now()) due.setDate(due.getDate() + 1);
    body.dueAt = due.getTime();
    body.recurrence = 'daily';
    body.hour = hour;
    body.minute = minute;
  } else {
    body.dueAt = Date.now() + 30000;
  }

  try {
    const res = await fetch(`${API_BASE}/api/family/checkins`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error || 'Impossible de créer le check-in');
      return;
    }
    closeCheckInRequestModal();
  } catch (e) {
    alert('Erreur réseau');
  }
}

async function populateSightingResidenceSelect() {
  if (!allResidencesCache) {
    try {
      const res = await fetch(`${API_BASE}/dispatch/all-residences`);
      allResidencesCache = res.ok ? await res.json() : [];
    } catch (e) {
      allResidencesCache = [];
    }
  }
  const select = document.getElementById('sightingResidenceId');
  select.innerHTML = '<option value="">— Lieu libre (non enregistré) —</option>' +
    (allResidencesCache || []).map(r => `<option value="${r.id}">${escapeHtml(r.userName)} — ${escapeHtml(r.label)}</option>`).join('');
  select.value = '';
}

function onSightingResidenceChange() {
  const select = document.getElementById('sightingResidenceId');
  const residence = (allResidencesCache || []).find(r => r.id === select.value);
  document.getElementById('sightingLocation').value = residence ? residence.address : '';
}

async function openBlackbookDetail(entryId) {
  currentBlackbookVehicles = [];
  dismissPlateSuggestion();
  document.getElementById('bbNotesEntities').style.display = 'none';
  document.getElementById('sightingNotesEntities').style.display = 'none';
  document.getElementById('addSightingForm').style.display = 'none';
  await ensureAllUsersLoaded();
  await populateSightingResidenceSelect();
  if (!entryId) {
    currentBlackbookEntry = null;
    document.getElementById('blackbookModalTitle').textContent = 'Nouvelle fiche';
    document.getElementById('blackbookPdfBtn').style.display = 'none';
    document.getElementById('blackbookDeleteBtn').style.display = 'none';
    document.getElementById('bbStatusField').style.display = 'none';
    document.getElementById('blackbookExistingSections').style.display = 'none';
    document.getElementById('blackbookNewEntryHint').style.display = 'block';
    ['bbFirstName', 'bbLastName', 'bbAliases', 'bbDateOfBirth', 'bbPhysicalDescription', 'bbTags', 'bbNotes'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('bbRiskLevel').value = 'medium';
    populateBlackbookLinkedUserSelect(null);
    renderBlackbookVehicles();
    document.getElementById('bbRelatedSection').style.display = 'none';
  } else {
    const entry = blackbookData.find(e => e.id === entryId) || await (await fetch(`${API_BASE}/api/blackbook/${entryId}`)).json();
    currentBlackbookEntry = entry;
    currentBlackbookVehicles = (entry.vehicles || []).map(v => ({ ...v }));
    document.getElementById('blackbookModalTitle').textContent = `${entry.firstName} ${entry.lastName}`.trim() || 'Fiche';
    document.getElementById('blackbookPdfBtn').style.display = 'inline-flex';
    document.getElementById('blackbookDeleteBtn').style.display = 'inline-flex';
    document.getElementById('bbStatusField').style.display = 'block';
    document.getElementById('blackbookExistingSections').style.display = 'block';
    document.getElementById('blackbookNewEntryHint').style.display = 'none';
    document.getElementById('bbFirstName').value = entry.firstName || '';
    document.getElementById('bbLastName').value = entry.lastName || '';
    document.getElementById('bbAliases').value = (entry.aliases || []).join(', ');
    document.getElementById('bbDateOfBirth').value = entry.dateOfBirth || '';
    document.getElementById('bbRiskLevel').value = entry.riskLevel || 'medium';
    document.getElementById('bbStatus').value = entry.status || 'active';
    document.getElementById('bbPhysicalDescription').value = entry.physicalDescription || '';
    document.getElementById('bbTags').value = (entry.tags || []).join(', ');
    document.getElementById('bbNotes').value = entry.notes || '';
    populateBlackbookLinkedUserSelect(entry.linkedUserId);
    renderBlackbookVehicles();
    renderBlackbookPhotos();
    renderBlackbookSightings();
    renderBlackbookRelated(entry.id);
  }
  document.getElementById('blackbookModal').style.display = 'flex';
}

function closeBlackbookModal() {
  document.getElementById('blackbookModal').style.display = 'none';
  currentBlackbookEntry = null;
}

async function saveBlackbookEntry() {
  const body = {
    firstName: document.getElementById('bbFirstName').value.trim(),
    lastName: document.getElementById('bbLastName').value.trim(),
    aliases: document.getElementById('bbAliases').value.split(',').map(s => s.trim()).filter(Boolean),
    dateOfBirth: document.getElementById('bbDateOfBirth').value || undefined,
    riskLevel: document.getElementById('bbRiskLevel').value,
    physicalDescription: document.getElementById('bbPhysicalDescription').value.trim() || undefined,
    tags: document.getElementById('bbTags').value.split(',').map(s => s.trim()).filter(Boolean),
    vehicles: currentBlackbookVehicles.filter(v => v.plate || v.description),
    notes: document.getElementById('bbNotes').value.trim() || undefined,
    // Sent as-is (possibly '') rather than coerced to undefined, so clearing
    // the selection back to "Aucun" actually clears it server-side too — PUT
    // only updates fields it receives as not-undefined.
    linkedUserId: document.getElementById('bbLinkedUserId').value,
  };
  if (!body.firstName && !body.lastName) { showToast('Nom ou prénom requis', 'error'); return; }
  try {
    if (currentBlackbookEntry) {
      body.status = document.getElementById('bbStatus').value;
      const res = await fetch(`${API_BASE}/api/blackbook/${currentBlackbookEntry.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('failed');
      showToast('Fiche mise à jour', 'success');
      closeBlackbookModal();
      loadBlackbook();
    } else {
      const res = await fetch(`${API_BASE}/api/blackbook`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('failed');
      const created = await res.json();
      showToast('Fiche créée — vous pouvez maintenant ajouter photos et signalements', 'success');
      await loadBlackbook();
      openBlackbookDetail(created.id);
    }
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function deleteBlackbookEntry() {
  if (!currentBlackbookEntry) return;
  if (!confirm(`Supprimer définitivement la fiche de ${currentBlackbookEntry.firstName} ${currentBlackbookEntry.lastName} ?`)) return;
  try {
    const res = await fetch(`${API_BASE}/api/blackbook/${currentBlackbookEntry.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('failed');
    showToast('Fiche supprimée', 'success');
    closeBlackbookModal();
    loadBlackbook();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function uploadBlackbookPhotos() {
  if (!currentBlackbookEntry) return;
  const input = document.getElementById('bbPhotoInput');
  if (!input.files || input.files.length === 0) return;
  const formData = new FormData();
  for (const file of input.files) formData.append('photos', file);
  try {
    const res = await fetch(`${API_BASE}/api/blackbook/${currentBlackbookEntry.id}/photos`, { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    currentBlackbookEntry.photos = data.photos;
    renderBlackbookPhotos();
    showToast('Photo(s) ajoutée(s)', 'success');
    renderPlateSuggestion(data.plateSuggestion);
  } catch (e) {
    showToast('Erreur upload photo : ' + (e.message || 'inconnue'), 'error');
  }
  input.value = '';
}

// Vehicle/plate recognition (ANPR) suggestion — never auto-written, the
// operator must explicitly click "Ajouter" and then still save the fiche.
let pendingPlateSuggestion = null;
function renderPlateSuggestion(suggestion) {
  const box = document.getElementById('bbPlateSuggestion');
  if (!box) return;
  if (!suggestion) { box.style.display = 'none'; pendingPlateSuggestion = null; return; }
  if (!suggestion.ok) {
    pendingPlateSuggestion = null;
    // "No plate on this photo" is the normal/expected case for most
    // Blackbook photos (portraits) — don't alarm the user over it, just a
    // quiet confirmation that analysis did run. Anything else (missing
    // token, service/network error) is a real configuration problem worth
    // surfacing clearly so it gets noticed and fixed.
    const isNoPlateFound = suggestion.reason === 'Aucune plaque détectée sur la photo';
    box.innerHTML = `<span style="color:${isNoPlateFound ? 'var(--text-muted)' : '#dc2626'};">${isNoPlateFound ? '🔍' : '⚠️'} ${escapeHtml(suggestion.reason || 'Analyse de plaque indisponible')}</span>`;
    box.style.display = 'flex';
    return;
  }
  pendingPlateSuggestion = suggestion;
  const matchText = (suggestion.matchingEntries && suggestion.matchingEntries.length)
    ? ` — cette plaque apparaît aussi sur : ${suggestion.matchingEntries.map(m => escapeHtml(m.name)).join(', ')}`
    : '';
  box.innerHTML = `
    <span>🚗 Plaque détectée : <b>${escapeHtml(suggestion.plate)}</b> (${Math.round((suggestion.confidence || 0) * 100)}% confiance)${matchText}</span>
    <span style="display:flex;gap:6px;">
      <button class="btn btn-sm btn-primary" onclick="confirmPlateSuggestion()">Ajouter comme véhicule</button>
      <button class="btn btn-sm btn-secondary" onclick="dismissPlateSuggestion()">Ignorer</button>
    </span>
  `;
  box.style.display = 'flex';
}

function confirmPlateSuggestion() {
  if (!pendingPlateSuggestion) return;
  currentBlackbookVehicles.push({
    plate: pendingPlateSuggestion.plate,
    description: [pendingPlateSuggestion.vehicle?.make, pendingPlateSuggestion.vehicle?.color].filter(Boolean).join(' '),
  });
  renderBlackbookVehicles();
  dismissPlateSuggestion();
  showToast('Véhicule ajouté — pensez à enregistrer la fiche', 'success');
}

function dismissPlateSuggestion() {
  pendingPlateSuggestion = null;
  const box = document.getElementById('bbPlateSuggestion');
  if (box) box.style.display = 'none';
}

// Entity extraction from free-text notes — explicit "Analyser" trigger
// only, never automatic on keystroke/save (LLM cost + avoid surprising
// staff). Candidates are suggestions only; applying one still requires
// the existing save action to persist.
let lastEntityCandidates = [];
async function analyzeNotesField(textareaId, chipsId, scope) {
  const text = document.getElementById(textareaId).value;
  const chipsEl = document.getElementById(chipsId);
  if (!text.trim()) { chipsEl.style.display = 'none'; chipsEl.innerHTML = ''; return; }
  chipsEl.style.display = 'block';
  chipsEl.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Analyse en cours...</span>';
  try {
    const res = await fetch(`${API_BASE}/api/notes/extract-entities`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      chipsEl.innerHTML = `<span style="font-size:11px;color:#dc2626;">${escapeHtml(err.error || 'Erreur')}</span>`;
      return;
    }
    const data = await res.json();
    lastEntityCandidates = data.candidates || [];
    if (lastEntityCandidates.length === 0) {
      chipsEl.innerHTML = '<span style="font-size:11px;color:var(--text-muted);">Aucune entité détectée</span>';
      return;
    }
    const icon = { name: '🧑', plate: '🚗', location: '📍' };
    chipsEl.innerHTML = lastEntityCandidates.map((c, i) => `
      <button type="button" class="btn btn-sm" style="cursor:pointer;margin:2px;" onclick="applyEntityCandidate(${i}, '${scope}')" title="${escapeHtml(c.context || '')}">
        ${icon[c.type] || ''} ${escapeHtml(c.value)}
      </button>
    `).join('');
  } catch (e) {
    chipsEl.innerHTML = '<span style="font-size:11px;color:#dc2626;">Erreur réseau</span>';
  }
}

function applyEntityCandidate(idx, scope) {
  const c = lastEntityCandidates[idx];
  if (!c) return;
  if (c.type === 'plate') {
    currentBlackbookVehicles.push({ plate: c.value, description: '' });
    renderBlackbookVehicles();
    showToast('Plaque ajoutée à la liste des véhicules', 'success');
  } else if (c.type === 'name') {
    const aliasesEl = document.getElementById('bbAliases');
    const current = aliasesEl.value.split(',').map(s => s.trim()).filter(Boolean);
    if (!current.includes(c.value)) { current.push(c.value); aliasesEl.value = current.join(', '); }
    showToast('Nom ajouté aux alias', 'success');
  } else if (c.type === 'location' && scope === 'sighting') {
    document.getElementById('sightingLocation').value = c.value;
    showToast('Lieu ajouté au signalement', 'success');
  } else {
    showToast(`Détecté : ${c.value}`, 'info');
  }
}

async function deleteBlackbookPhoto(url) {
  if (!currentBlackbookEntry) return;
  if (!confirm('Supprimer cette photo ?')) return;
  try {
    const res = await fetch(`${API_BASE}/api/blackbook/${currentBlackbookEntry.id}/photos`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    if (!res.ok) throw new Error('failed');
    const data = await res.json();
    currentBlackbookEntry.photos = data.photos;
    renderBlackbookPhotos();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

function toggleAddSightingForm() {
  const form = document.getElementById('addSightingForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
  if (form.style.display === 'block' && !document.getElementById('sightingDate').value) {
    document.getElementById('sightingDate').value = new Date().toISOString().slice(0, 10);
  }
}

async function saveSighting() {
  if (!currentBlackbookEntry) return;
  const dateVal = document.getElementById('sightingDate').value;
  const timeVal = document.getElementById('sightingTime').value || '12:00';
  if (!dateVal) { showToast('Date requise', 'error'); return; }
  const timestamp = new Date(`${dateVal}T${timeVal}:00`).getTime();
  const locationText = document.getElementById('sightingLocation').value.trim();
  const residenceId = document.getElementById('sightingResidenceId').value || undefined;
  try {
    const res = await fetch(`${API_BASE}/api/blackbook/${currentBlackbookEntry.id}/sightings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp, category: document.getElementById('sightingCategory').value,
        location: locationText ? { address: locationText } : undefined,
        residenceId,
        notes: document.getElementById('sightingNotes').value.trim() || undefined,
      }),
    });
    if (!res.ok) throw new Error('failed');
    const sighting = await res.json();
    currentBlackbookEntry.sightings = [...(currentBlackbookEntry.sightings || []), sighting];
    document.getElementById('sightingLocation').value = '';
    document.getElementById('sightingResidenceId').value = '';
    document.getElementById('sightingNotes').value = '';
    document.getElementById('addSightingForm').style.display = 'none';
    renderBlackbookSightings();
    showToast('Signalement ajouté', 'success');
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function deleteSighting(sightingId) {
  if (!currentBlackbookEntry) return;
  if (!confirm('Supprimer ce signalement ?')) return;
  try {
    const res = await fetch(`${API_BASE}/api/blackbook/${currentBlackbookEntry.id}/sightings/${sightingId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('failed');
    currentBlackbookEntry.sightings = (currentBlackbookEntry.sightings || []).filter(s => s.id !== sightingId);
    renderBlackbookSightings();
  } catch (e) {
    showToast('Erreur', 'error');
  }
}

async function exportBlackbookPdf() {
  if (!currentBlackbookEntry) return;
  // window.open() wouldn't carry the Authorization header this (protected)
  // route needs — fetch it as a blob through the authenticated fetch instead
  // and trigger the download from there.
  try {
    const res = await fetch(`${API_BASE}/api/blackbook/${currentBlackbookEntry.id}/pdf`);
    if (!res.ok) throw new Error('failed');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `blackbook-${(currentBlackbookEntry.lastName || 'sans-nom').replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (e) {
    showToast('Erreur export PDF', 'error');
  }
}

function renderFamilyGroups() {
  const container = document.getElementById('familyGroupsList');
  if (!container) return;
  document.getElementById('familyGroupsCount').textContent = `${familyGroups.length} famille${familyGroups.length !== 1 ? 's' : ''}`;

  if (familyGroups.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">🏠</div><p>Aucune famille (relations parent/enfant/conjoint) enregistrée</p></div>';
    return;
  }

  const STATUS_LABELS = { inside: 'Présent', outside: 'Sorti', unknown: 'Statut inconnu' };
  const STATUS_ICONS = { inside: '🏠', outside: '🚶', unknown: '❓' };

  container.innerHTML = familyGroups.map(group => `
    <div class="family-card">
      <div class="family-card-members">
        ${group.members.map(m => {
          const statusLine = m.status === 'outside' && m.matchedLabel
            ? `Sorti de ${getPlaceIcon(m.matchedLabel)} ${escapeHtml(m.matchedLabel)}`
            : `${STATUS_ICONS[m.status] || '❓'} ${STATUS_LABELS[m.status] || m.status}${m.matchedLabel ? ` — ${getPlaceIcon(m.matchedLabel)} ${escapeHtml(m.matchedLabel)}` : ''}`;
          return `
          <div class="family-member-row">
            <div class="family-member-info">
              <div class="family-member-name">
                ${m.name}
                ${m.ghostMode ? '<span class="ghost-badge" title="Mode Ghost actif">👻 Ghost</span>' : ''}
              </div>
              <div class="family-member-status status-${m.status}">${statusLine}</div>
              <div class="family-member-meta">
                ${m.source === 'manual'
                  ? `Statut manuel${m.setBy ? ' par ' + escapeHtml(m.setBy) : ''}${m.setAt ? ' · depuis ' + formatTimeAgo(m.setAt) : ''}`
                  : `Statut automatique (position live)${m.setAt ? ' · depuis ' + formatTimeAgo(m.setAt) : ''}`}
              </div>
              <div class="family-member-places-toggle" onclick="togglePlacesFor('${m.id}')">
                🗂️ Gérer les lieux${m.addresses.length > 0 ? ` (${m.addresses.length})` : ''} <span id="places-caret-${m.id}">▾</span>
              </div>
              <div class="family-member-addresses" id="places-${m.id}" style="display:none;">
                ${m.addresses.map(a => `
                  <span class="addr-chip place-chip${a.temporary ? ' place-chip-temp' : ''}" title="Cliquer pour modifier" onclick="openEditPlaceModal('${m.id}','${a.id}')">
                    ${a.isPrimary ? '⭐ ' : ''}${getPlaceIcon(a.label)} ${escapeHtml(a.label)}${a.temporary && a.expiresAt ? ` (jusqu'au ${formatShortDate(a.expiresAt)})` : ''}${a.occupancyStatus === 'unoccupied' ? ' <span style="color:#b45309;font-weight:700;" title="Résidence inoccupée">🚪 Inoccupée</span>' : ''}
                    <span class="place-chip-delete" title="Prestataires" onclick="event.stopPropagation(); openProvidersModal('${a.id}', '${escapeHtml(a.label).replace(/'/g, "\\'")}')">🔧</span>
                    <span class="place-chip-delete" title="Supprimer ce lieu" onclick="event.stopPropagation(); deletePlace('${m.id}','${a.id}')">&times;</span>
                  </span>
                `).join('')}
                <button class="place-add-btn" onclick="openAddPlaceModal('${m.id}')">+ Ajouter un lieu</button>
              </div>
            </div>
            <div class="family-member-actions">
              <button class="btn btn-secondary btn-sm" onclick="openPresencePlacePicker('${m.id}')">Marquer présent</button>
              <button class="btn btn-secondary btn-sm" onclick="setPresence('${m.id}', 'outside')">Marquer sorti</button>
              ${m.source === 'manual' ? `<button class="btn btn-secondary btn-sm" onclick="setPresence('${m.id}', 'auto')">Revenir en auto</button>` : ''}
            </div>
          </div>
        `;
        }).join('')}
      </div>
    </div>
  `).join('');
}

const PLACE_TYPE_ICONS = {
  'Domicile principal': '🏠',
  'Résidence secondaire': '🏡',
  'Bureau': '🏢',
  'Vacances': '✈️',
  'Autre': '📍',
};
function getPlaceIcon(label) {
  for (const [key, icon] of Object.entries(PLACE_TYPE_ICONS)) {
    if (label && label.includes(key)) return icon;
  }
  return '📍';
}
function formatShortDate(ts) {
  return new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

// Registered addresses are reference data, not a live status — collapsed by
// default so the one precise status line above is never visually competing
// with a list that could otherwise read as "present in several places".
function togglePlacesFor(userId) {
  const el = document.getElementById(`places-${userId}`);
  const caret = document.getElementById(`places-caret-${userId}`);
  if (!el) return;
  const isHidden = el.style.display === 'none';
  el.style.display = isHidden ? 'flex' : 'none';
  if (caret) caret.textContent = isHidden ? '▴' : '▾';
}

// ─── Add/Edit Place Modal ────────────────────────────────────────
const PLACE_TYPES = Object.keys(PLACE_TYPE_ICONS);
// Labels are stored as "<type>" or "<type> — <name>" — split them back apart
// for editing (falls back to 'Autre' + the raw label for anything that
// predates this scheme or doesn't match a known type).
function parsePlaceLabel(label) {
  for (const t of PLACE_TYPES) {
    if (label === t) return { type: t, name: '' };
    if (label.startsWith(t + ' — ')) return { type: t, name: label.slice((t + ' — ').length) };
  }
  return { type: 'Autre', name: label };
}

let placeModalUserId = null;
let placeEditingId = null; // null while creating a new place
let placeSelectedType = 'Domicile principal';
let placeLat = null;
let placeLng = null;

function openAddPlaceModal(userId) {
  placeModalUserId = userId;
  placeEditingId = null;
  placeLat = null;
  placeLng = null;
  document.getElementById('placeModalTitle').textContent = 'Ajouter un lieu';
  document.getElementById('placeName').value = '';
  document.getElementById('placeAddress').value = '';
  document.getElementById('placeAddressSuggestions').style.display = 'none';
  document.getElementById('placeRadius').value = '150';
  document.getElementById('placeExpiry').value = '';
  document.getElementById('placeOccupancy').value = '';
  selectPlaceType('Domicile principal');
  document.getElementById('addPlaceModal').style.display = 'flex';
}

async function openEditPlaceModal(userId, addressId) {
  try {
    const res = await fetch(`${API_BASE}/api/users/${userId}/addresses`);
    const addresses = res.ok ? await res.json() : [];
    const addr = addresses.find(a => a.id === addressId);
    if (!addr) { showToast('Lieu introuvable', 'error'); return; }

    placeModalUserId = userId;
    placeEditingId = addressId;
    placeLat = addr.latitude ?? null;
    placeLng = addr.longitude ?? null;
    const { type, name } = parsePlaceLabel(addr.label);
    document.getElementById('placeModalTitle').textContent = 'Modifier ce lieu';
    document.getElementById('placeName').value = name;
    document.getElementById('placeAddress').value = addr.address || '';
    document.getElementById('placeAddressSuggestions').style.display = 'none';
    document.getElementById('placeRadius').value = addr.radiusMeters || 150;
    document.getElementById('placeExpiry').value = addr.expiresAt ? new Date(addr.expiresAt).toISOString().slice(0, 10) : '';
    document.getElementById('placeOccupancy').value = addr.occupancyStatus || '';
    selectPlaceType(type);
    document.getElementById('addPlaceModal').style.display = 'flex';
  } catch (e) {
    console.error('[Places] Load for edit failed:', e);
    showToast('Erreur réseau', 'error');
  }
}

function closeAddPlaceModal() {
  document.getElementById('addPlaceModal').style.display = 'none';
  placeModalUserId = null;
  placeEditingId = null;
}

function selectPlaceType(type) {
  placeSelectedType = type;
  document.querySelectorAll('.place-type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-type') === type);
  });
  document.getElementById('placeExpiryField').style.display = type === 'Vacances' ? 'block' : 'none';
}

let placeAddressDebounceTimer = null;
function onPlaceAddressInput(value) {
  clearTimeout(placeAddressDebounceTimer);
  const box = document.getElementById('placeAddressSuggestions');
  if (!value || value.length < 3) { box.style.display = 'none'; return; }
  placeAddressDebounceTimer = setTimeout(() => fetchPlaceAddressSuggestions(value), 350);
}

async function fetchPlaceAddressSuggestions(query) {
  const box = document.getElementById('placeAddressSuggestions');
  try {
    const res = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`);
    const results = await res.json();
    if (!results || results.length === 0) { box.style.display = 'none'; return; }
    box.innerHTML = results.map((r, i) => `
      <div class="address-suggestion-item" onclick="selectPlaceAddressSuggestion(${i})" data-lat="${r.lat}" data-lon="${r.lon}" data-name="${r.display_name.replace(/"/g, '&quot;')}">
        <span class="addr-icon">📍</span>
        <span class="addr-text">${r.display_name}</span>
      </div>
    `).join('');
    box.style.display = 'block';
  } catch (e) {
    console.error('[Places] Address autocomplete failed:', e);
    box.style.display = 'none';
  }
}

function selectPlaceAddressSuggestion(index) {
  const box = document.getElementById('placeAddressSuggestions');
  const items = box.querySelectorAll('.address-suggestion-item');
  if (!items[index]) return;
  const item = items[index];
  placeLat = parseFloat(item.getAttribute('data-lat'));
  placeLng = parseFloat(item.getAttribute('data-lon'));
  document.getElementById('placeAddress').value = item.getAttribute('data-name');
  box.style.display = 'none';
}

document.addEventListener('click', (e) => {
  const box = document.getElementById('placeAddressSuggestions');
  if (box && !e.target.closest('#placeAddress') && !e.target.closest('#placeAddressSuggestions')) {
    box.style.display = 'none';
  }
});

async function savePlace() {
  if (!placeModalUserId) return;
  const name = document.getElementById('placeName').value.trim();
  const address = document.getElementById('placeAddress').value.trim();
  const radiusMeters = parseInt(document.getElementById('placeRadius').value, 10) || 150;
  const expiryVal = document.getElementById('placeExpiry').value;
  const occupancyVal = document.getElementById('placeOccupancy').value;
  if (!address) { showToast('Adresse requise', 'error'); return; }

  const isTemp = placeSelectedType === 'Vacances';
  const label = name ? `${placeSelectedType} — ${name}` : placeSelectedType;
  const body = {
    label,
    address,
    latitude: placeLat,
    longitude: placeLng,
    radiusMeters,
    temporary: isTemp,
    expiresAt: isTemp && expiryVal ? new Date(expiryVal).getTime() : null,
    occupancyStatus: occupancyVal || null,
  };

  try {
    const url = placeEditingId
      ? `${API_BASE}/api/users/${placeModalUserId}/addresses/${placeEditingId}`
      : `${API_BASE}/api/users/${placeModalUserId}/addresses`;
    const res = await fetch(url, {
      method: placeEditingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      showToast(placeEditingId ? 'Lieu modifié' : 'Lieu ajouté', 'success');
      closeAddPlaceModal();
      loadFamilyGroups();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erreur lors de l\'ajout du lieu', 'error');
    }
  } catch (e) {
    console.error('[Places] Save error:', e);
    showToast('Erreur réseau', 'error');
  }
}

async function deletePlace(userId, addressId) {
  if (!confirm('Supprimer ce lieu ?')) return;
  try {
    await fetch(`${API_BASE}/api/users/${userId}/addresses/${addressId}`, { method: 'DELETE' });
    showToast('Lieu supprimé', 'success');
    loadFamilyGroups();
  } catch (e) {
    console.error('[Places] Delete error:', e);
    showToast('Erreur réseau', 'error');
  }
}

// Step 1 of marking someone present is choosing THIS action; step 2 is
// picking which of their registered places it refers to (openPresencePlacePicker).
// "Sorti" needs no picker — it always displays the last known place automatically.
function openPresencePlacePicker(userId) {
  const group = familyGroups.find(g => g.members.some(m => m.id === userId));
  const member = group?.members.find(m => m.id === userId);
  const addresses = member?.addresses || [];
  const list = document.getElementById('presencePlaceList');

  if (addresses.length === 0) {
    list.innerHTML = '<div class="presence-place-empty">Aucun lieu enregistré pour cette personne.<br>Ajoutez-en un via « Gérer les lieux » avant de marquer sa présence.</div>';
  } else {
    list.innerHTML = addresses.map(a => `
      <div class="presence-place-item" onclick="confirmPresencePlace('${userId}', '${a.label.replace(/'/g, "\\'")}')">
        ${a.isPrimary ? '⭐ ' : ''}${getPlaceIcon(a.label)} ${escapeHtml(a.label)}
      </div>
    `).join('');
  }
  document.getElementById('presencePlaceModal').style.display = 'flex';
}

function closePresencePlaceModal() {
  document.getElementById('presencePlaceModal').style.display = 'none';
}

function confirmPresencePlace(userId, placeLabel) {
  closePresencePlaceModal();
  setPresence(userId, 'inside', placeLabel);
}

async function setPresence(userId, status, placeLabel) {
  try {
    const res = await fetch(`${API_BASE}/api/family/presence/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(placeLabel ? { status, placeLabel } : { status }),
    });
    if (res.ok) {
      showToast('Statut mis à jour', 'success');
      loadFamilyGroups();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erreur lors de la mise à jour du statut', 'error');
    }
  } catch (e) {
    console.error('[Families] setPresence error:', e);
    showToast('Erreur réseau', 'error');
  }
}

// ─── Responders Rendering ────────────────────────────────────
function renderResponders() {
  const container = document.getElementById('respondersGrid');
  let filtered = responders;
  if (currentResponderFilter !== 'all') {
    filtered = responders.filter(r => r.status === currentResponderFilter);
  }
  if (filtered.length === 0) {
    container.innerHTML = '<div class="ov-empty"><div class="ov-empty-icon">\ud83d\udc64</div><div class="ov-empty-text">Aucune unit\u00e9 correspondante</div></div>';
    return;
  }

  const statusLabels = { available: 'Disponible', on_duty: 'En service', off_duty: 'Hors service', responding: 'En intervention' };
  const statusColors = { available: '#22c55e', on_duty: '#3b82f6', off_duty: '#6b7280', responding: '#f59e0b' };
  const TYPE_ICONS_MINI = { sos: '\ud83c\udd98', medical: '\ud83c\udfe5', fire: '\ud83d\udd25', security: '\ud83d\udee1\ufe0f', accident: '\ud83d\ude97', hazard: '\u26a0\ufe0f', broadcast: '\ud83d\udce2' };

  container.innerHTML = filtered.map(r => {
    const initials = (r.name || '?').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const statusColor = statusColors[r.status] || '#6b7280';
    const tagsHtml = (r.tags || []).slice(0, 4).map(t => `<span class="fr-tag">${t}</span>`).join('');
    const phoneHtml = r.phone ? `<div class="fr-detail-row">\ud83d\udcf1 ${r.phone}</div>` : '';
    const locationHtml = r.location
      ? `<div class="fr-detail-row">\ud83d\udccd ${r.location.latitude.toFixed(4)}, ${r.location.longitude.toFixed(4)}</div>`
      : `<div class="fr-detail-row">\ud83d\udccd Position inconnue</div>`;

    // Assigned incidents
    const assignedIncs = r.assignedIncidents || [];
    let assignedHtml = '';
    if (assignedIncs.length > 0) {
      assignedHtml = `<div class="fr-incidents">
        <div class="fr-incidents-title">Incidents assign\u00e9s</div>
        ${assignedIncs.map(inc => `<div class="fr-inc-chip sev-${inc.severity}" onclick="event.stopPropagation(); openDetailModal('${inc.id}')">
          <span>${TYPE_ICONS_MINI[inc.type] || '\ud83d\udea8'}</span>
          <span class="fr-inc-ref">${formatIncidentId(inc.id)}</span>
          <span class="fr-inc-type">${typeLabel(inc.type)}</span>
          <span class="badge badge-${inc.severity}" style="font-size:9px;padding:1px 5px;">${sevLabel(inc.severity)}</span>
        </div>`).join('')}
      </div>`;
    }

    return `
    <div class="fr-card">
      <div class="fr-header">
        <div class="fr-avatar" style="background:${statusColor}20;color:${statusColor};border:2px solid ${statusColor}">${initials}</div>
        <div class="fr-header-info">
          <div class="fr-name">
            <span class="ov-resp-conn ${r.isConnected ? 'online' : 'offline'}"></span>
            ${r.name}
          </div>
          <div class="fr-status" style="color:${statusColor}">${statusLabels[r.status] || r.status}</div>
        </div>
        <select class="fr-status-select ${r.status}" onchange="changeResponderStatus('${r.id}', this.value)">
          <option value="available" ${r.status === 'available' ? 'selected' : ''}>\u2713 Disponible</option>
          <option value="on_duty" ${r.status === 'on_duty' ? 'selected' : ''}>\u26a1 En service</option>
          <option value="responding" ${r.status === 'responding' ? 'selected' : ''}>\ud83d\udea8 En intervention</option>
          <option value="off_duty" ${r.status === 'off_duty' ? 'selected' : ''}>\u2717 Hors service</option>
        </select>
      </div>
      <div class="fr-details">
        ${phoneHtml}
        ${locationHtml}
        <div class="fr-detail-row">\ud83d\udd52 Vu ${formatTimeAgo(r.lastSeen)}</div>
      </div>
      ${tagsHtml ? `<div class="fr-tags">${tagsHtml}</div>` : ''}
      ${assignedHtml}
    </div>`;
  }).join('');
}

function filterResponders(filter) {
  currentResponderFilter = filter;
  document.querySelectorAll('#tab-responders .chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`#tab-responders .chip[data-filter="${filter}"]`)?.classList.add('active');
  renderResponders();
}

async function changeResponderStatus(responderId, newStatus) {
  try {
    const res = await fetch(`${API_BASE}/dispatch/responders/${responderId}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    const data = await res.json();
    if (data.success) {
      // Update local data immediately
      const r = responders.find(x => x.id === responderId);
      if (r) r.status = newStatus;
      renderResponders();
      renderOverview();
      showToast(`${data.name || responderId} → ${newStatus === 'available' ? 'Disponible' : newStatus === 'on_duty' ? 'En service' : newStatus === 'responding' ? 'En intervention' : 'Hors service'}`, 'success');
    } else {
      showToast('Erreur: ' + (data.error || 'Changement de statut échoué'), 'error');
    }
  } catch (err) {
    console.error('Failed to change responder status:', err);
    showToast('Erreur réseau lors du changement de statut', 'error');
  }
}

function showToast(message, type = 'info') {
  // Remove existing toast
  const existing = document.querySelector('.dispatch-toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = `dispatch-toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  // Animate in
  requestAnimationFrame(() => toast.classList.add('visible'));
  
  // Auto-remove after 3s
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── Broadcast ───────────────────────────────────────────────
function selectSeverity(sev) {
  selectedBroadcastSeverity = sev;
  document.querySelectorAll('.sev-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.sev-btn[data-sev="${sev}"]`)?.classList.add('active');
}

function selectRadius(r) {
  selectedBroadcastRadius = r;
  document.querySelectorAll('.radius-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.radius-btn[data-r="${r}"]`)?.classList.add('active');
}

async function sendBroadcast() {
  const message = document.getElementById('broadcastMessage').value.trim();
  if (!message) { alert('Please enter a broadcast message.'); return; }

  try {
    const res = await fetch(`${API_BASE}/dispatch/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        severity: selectedBroadcastSeverity,
        radiusKm: parseFloat(selectedBroadcastRadius),
        by: 'Dispatch Console',
      }),
    });
    const data = await res.json();
    if (data.success) {
      alert(`Broadcast sent to all units within ${selectedBroadcastRadius}km radius.`);
      document.getElementById('broadcastMessage').value = '';
      refreshData();
    }
  } catch (err) {
    console.error('Broadcast failed:', err);
    alert('Failed to send broadcast.');
  }
}

function renderBroadcastHistory() {
  const container = document.getElementById('broadcastHistory');
  if (broadcastHistory.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No recent broadcasts</p></div>';
    return;
  }
  container.innerHTML = broadcastHistory.map(b => `
    <div class="broadcast-entry">
      <div class="bc-msg">${b.details}</div>
      <div class="bc-meta">${b.performedBy} · ${formatTimeAgo(b.timestamp)}</div>
    </div>
  `).join('');
}

// ─── Address Autocomplete (Nominatim / OpenStreetMap) ────────────────────────────────────────
let addressDebounceTimer = null;

function onAddressInput(value) {
  clearTimeout(addressDebounceTimer);
  const sugBox = document.getElementById('addressSuggestions');
  if (!value || value.length < 3) {
    sugBox.style.display = 'none';
    return;
  }
  addressDebounceTimer = setTimeout(() => fetchAddressSuggestions(value), 350);
}

async function fetchAddressSuggestions(query) {
  const sugBox = document.getElementById('addressSuggestions');
  try {
    const url = `${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    const results = await res.json();
    if (!results || results.length === 0) {
      sugBox.style.display = 'none';
      return;
    }
    sugBox.innerHTML = results.map((r, i) => `
      <div class="address-suggestion-item" onclick="selectAddressSuggestion(${i})" data-lat="${r.lat}" data-lon="${r.lon}" data-name="${r.display_name.replace(/"/g, '&quot;')}">
        <span class="addr-icon">\uD83D\uDCCD</span>
        <span class="addr-text">${r.display_name}</span>
      </div>
    `).join('');
    sugBox.style.display = 'block';
  } catch (err) {
    console.error('Address autocomplete failed:', err);
    sugBox.style.display = 'none';
  }
}

function selectAddressSuggestion(index) {
  const sugBox = document.getElementById('addressSuggestions');
  const items = sugBox.querySelectorAll('.address-suggestion-item');
  if (!items[index]) return;
  const item = items[index];
  const name = item.getAttribute('data-name');
  const lat = item.getAttribute('data-lat');
  const lon = item.getAttribute('data-lon');
  document.getElementById('incidentAddress').value = name;
  document.getElementById('incidentLat').value = parseFloat(lat).toFixed(6);
  document.getElementById('incidentLng').value = parseFloat(lon).toFixed(6);
  sugBox.style.display = 'none';
}

// Close suggestions when clicking outside
document.addEventListener('click', (e) => {
  const sugBox = document.getElementById('addressSuggestions');
  if (sugBox && !e.target.closest('#incidentAddress') && !e.target.closest('#addressSuggestions')) {
    sugBox.style.display = 'none';
  }
});

// ─── Create Incident from Dispatch ──────────────────────────────────────────────────────
let selectedIncidentType = null;
let selectedIncidentSeverity = null;

function openCreateIncidentModal() {
  selectedIncidentType = null;
  selectedIncidentSeverity = null;
  document.getElementById('incidentDescription').value = '';
  document.getElementById('incidentAddress').value = '';
  document.getElementById('incidentLat').value = '';
  document.getElementById('incidentLng').value = '';
  document.getElementById('incidentVisibilityRadius').value = '';
  document.getElementById('addressSuggestions').style.display = 'none';
  // Reset active states
  document.querySelectorAll('#incidentTypeOptions .type-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#incidentSeverityOptions .sev-btn').forEach(b => b.classList.remove('active'));
  const modal = document.getElementById('createIncidentModal');
  modal.style.display = 'flex';
}

function closeCreateIncidentModal() {
  document.getElementById('createIncidentModal').style.display = 'none';
}

function selectIncidentType(type) {
  selectedIncidentType = type;
  document.querySelectorAll('#incidentTypeOptions .type-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-type') === type);
  });
}

function selectIncidentSeverity(sev) {
  selectedIncidentSeverity = sev;
  document.querySelectorAll('#incidentSeverityOptions .sev-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-sev') === sev);
  });
}

async function submitCreateIncident() {
  if (!selectedIncidentType) { alert('Please select an incident type.'); return; }
  if (!selectedIncidentSeverity) { alert('Please select a severity level.'); return; }
  const description = document.getElementById('incidentDescription').value.trim();
  if (!description) { alert('Please enter a description.'); return; }
  const address = document.getElementById('incidentAddress').value.trim() || 'Unknown location';
  const lat = parseFloat(document.getElementById('incidentLat').value) || 46.1950;
  const lng = parseFloat(document.getElementById('incidentLng').value) || 6.1580;
  const visibilityRadiusMeters = parseFloat(document.getElementById('incidentVisibilityRadius').value) || undefined;

  try {
    const res = await fetch(`${API_BASE}/dispatch/incidents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: selectedIncidentType,
        severity: selectedIncidentSeverity,
        description,
        location: { latitude: lat, longitude: lng, address },
        createdBy: 'Dispatch Console',
        visibilityRadiusMeters,
      }),
    });
    const data = await res.json();
    if (data.success) {
      closeCreateIncidentModal();
      refreshData();
      alert(`Incident created: ${selectedIncidentType.toUpperCase()} - ${selectedIncidentSeverity.toUpperCase()}`);
    } else {
      alert('Failed to create incident: ' + (data.error || 'Unknown error'));
    }
  } catch (err) {
    console.error('Create incident failed:', err);
    alert('Failed to create incident. Server error.');
  }
}

// ─── Incident Actions ────────────────────────────────────────────────────────
async function acknowledgeIncident(id) {
  try {
    const res = await fetch(`${API_BASE}/dispatch/incidents/${encodeURIComponent(id)}/acknowledge`, { method: 'PUT' });
    const data = await res.json();
    if (data.success) refreshData();
  } catch (err) {
    console.error('Acknowledge failed:', err);
    alert('Failed to acknowledge incident.');
  }
}

// Permanent, hard delete — for cleaning up test/junk incidents, not part of
// the normal resolve workflow. Admin-only server-side; confirm before firing.
async function deleteIncident(id) {
  if (!confirm(`Supprimer définitivement l'incident ${formatIncidentId(id)} ?\n\nCette action est irréversible.`)) return;
  try {
    const res = await fetch(`${API_BASE}/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (res.ok) {
      showToast(`Incident ${formatIncidentId(id)} supprimé`, 'success');
      incidents = incidents.filter(i => i.id !== id);
      if (document.getElementById('detailModal')?.classList.contains('active')) closeDetailModal();
      refreshData();
      if (dispatchMap) refreshMapData();
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erreur lors de la suppression', 'error');
    }
  } catch (e) {
    console.error('[Incidents] Delete error:', e);
    showToast('Erreur réseau', 'error');
  }
}

async function openAssignModal(incidentId) {
  const modal = document.getElementById('assignModal');
  const subtitle = document.getElementById('assignModalSubtitle');
  const list = document.getElementById('assignResponderList');
  const inc = incidents.find(i => i.id === incidentId);

  subtitle.textContent = inc ? `${TYPE_ICONS[inc.type] || '\uD83D\uDEA8'} ${formatIncidentId(inc.id)} \u2014 ${typeLabel(inc.type)} \u00e0 ${inc.address || 'Lieu inconnu'}` : formatIncidentId(incidentId);
  list.innerHTML = '<div class="empty-state"><p>Chargement...</p></div>';
  modal.classList.add('active');

  // Fetch responders with distance from the new endpoint
  let nearbyData = null;
  try {
    const res = await fetch(`${API_BASE}/dispatch/incidents/${encodeURIComponent(incidentId)}/responders-nearby`);
    if (res.ok) nearbyData = await res.json();
  } catch (e) {
    console.warn('[Assign] Failed to fetch responders-nearby:', e);
  }

  if (nearbyData && nearbyData.responders) {
    const rList = nearbyData.responders;
    if (rList.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>Aucun responder disponible</p></div>';
      return;
    }
    let html = '';
    const assigned = rList.filter(r => r.isAssigned);
    const notAssigned = rList.filter(r => !r.isAssigned);

    if (assigned.length > 0) {
      html += '<div class="assign-section-label">D\u00e9j\u00e0 assign\u00e9s</div>';
      html += assigned.map(r => {
        const connIcon = r.isConnected ? '\uD83D\uDFE2' : '\u26AA';
        const distHtml = r.distanceLabel ? `<span class="resp-distance">\uD83D\uDCCD ${r.distanceLabel}</span>` : '';
        return `<div class="resp-option assigned">
          <div class="resp-dot responding"></div>
          <div class="resp-opt-info">
            <div class="resp-opt-name">${connIcon} ${r.name}</div>
            <div class="resp-opt-detail">\u2705 Assign\u00e9 ${distHtml}</div>
          </div>
          <div class="resp-opt-action unassign" onclick="event.stopPropagation(); unassignResponder('${incidentId}', '${r.id}')" title="D\u00e9sassigner">\u274C D\u00e9sassigner</div>
        </div>`;
      }).join('');
    }

    if (notAssigned.length > 0) {
      html += '<div class="assign-section-label">Responders disponibles</div>';
      const suggested = notAssigned.find(r => r.suggested);
      if (suggested) {
        html += `<div class="assign-suggested-banner">
          <div class="assign-suggested-info">
            <span class="assign-suggested-star">\u2B50</span>
            <span class="assign-suggested-name">${suggested.name}</span>
            <span class="assign-suggested-meta">\uD83D\uDCCD ${suggested.distanceLabel}${suggested.etaLabel ? ' \u00B7 \u23F1 ' + suggested.etaLabel : ''}</span>
          </div>
          <button class="btn btn-success btn-sm" onclick="event.stopPropagation(); assignResponder('${incidentId}', '${suggested.id}')">Assigner le plus proche \u2192</button>
        </div>`;
      }
      html += notAssigned.map(r => {
        const statusLabels = { available: 'Disponible', on_duty: 'En service', responding: 'En intervention', off_duty: 'Hors service' };
        const statusLabel = statusLabels[r.status] || r.status;
        const statusClass = r.status === 'available' ? 'available' : r.status === 'on_duty' ? 'on_duty' : r.status === 'responding' ? 'responding' : 'off_duty';
        const connIcon = r.isConnected ? '\uD83D\uDFE2' : '\u26AA';
        const tagsHtml = (r.tags || []).slice(0, 3).map(t => `<span class="resp-tag">${t}</span>`).join('');
        const phoneHtml = r.phone ? `<span class="resp-phone">\uD83D\uDCF1 ${r.phone}</span>` : '';
        const distHtml = r.distanceLabel ? `<span class="resp-distance">\uD83D\uDCCD ${r.distanceLabel}</span>` : '';
        const etaHtml = r.etaLabel ? `<span class="resp-eta">\u23F1 ${r.etaLabel}</span>` : '';
        const suggestedBadge = r.suggested ? `<span class="resp-suggested-badge">\u2B50 Sugg\u00E9r\u00E9</span>` : '';
        const isAvailable = r.status === 'available' || r.status === 'on_duty' || r.status === 'responding';
        const clickAttr = isAvailable ? `onclick="assignResponder('${incidentId}', '${r.id}')"` : '';
        const disabledClass = isAvailable ? '' : ' disabled';
        const rowClass = `resp-option${disabledClass}${r.suggested ? ' suggested' : ''}`;
        return `<div class="${rowClass}" ${clickAttr}>
          <div class="resp-dot ${statusClass}"></div>
          <div class="resp-opt-info">
            <div class="resp-opt-name">${connIcon} ${r.name} ${distHtml} ${etaHtml} ${suggestedBadge}</div>
            <div class="resp-opt-detail">${statusLabel}${phoneHtml}</div>
            ${tagsHtml ? `<div class="resp-opt-tags">${tagsHtml}</div>` : ''}
          </div>
          ${isAvailable ? '<div class="resp-opt-action">Assigner \u2192</div>' : ''}
        </div>`;
      }).join('');
    } else if (assigned.length > 0) {
      html += '<div class="assign-section-label">Aucun autre responder disponible</div>';
    }
    list.innerHTML = html;
  } else {
    // Fallback to local data if API fails
    const alreadyAssigned = inc ? (inc.respondingUsers || []) : [];
    const assignable = responders.filter(r => r.status === 'available' || r.status === 'on_duty' || r.status === 'responding');
    if (assignable.length === 0 && alreadyAssigned.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>Aucun responder disponible</p></div>';
    } else {
      let html = '';
      if (alreadyAssigned.length > 0) {
        html += '<div class="assign-section-label">D\u00e9j\u00e0 assign\u00e9s</div>';
        html += alreadyAssigned.map(rid => {
          const r = responders.find(x => x.id === rid);
          const name = r ? r.name : rid;
          return `<div class="resp-option assigned">
            <div class="resp-dot responding"></div>
            <div class="resp-opt-info">
              <div class="resp-opt-name">${name}</div>
              <div class="resp-opt-detail">\u2705 Assign\u00e9</div>
            </div>
            <div class="resp-opt-action unassign" onclick="event.stopPropagation(); unassignResponder('${incidentId}', '${rid}')" title="D\u00e9sassigner">\u274C D\u00e9sassigner</div>
          </div>`;
        }).join('');
      }
      const notAssigned = assignable.filter(r => !alreadyAssigned.includes(r.id));
      if (notAssigned.length > 0) {
        html += '<div class="assign-section-label">Responders disponibles</div>';
        html += notAssigned.map(r => {
          const statusLabel = r.status === 'available' ? 'Disponible' : r.status === 'on_duty' ? 'En service' : 'En intervention';
          const statusClass = r.status === 'available' ? 'available' : r.status === 'on_duty' ? 'on_duty' : 'responding';
          const connIcon = r.isConnected ? '\uD83D\uDFE2' : '\u26AA';
          return `<div class="resp-option" onclick="assignResponder('${incidentId}', '${r.id}')">
            <div class="resp-dot ${statusClass}"></div>
            <div class="resp-opt-info">
              <div class="resp-opt-name">${connIcon} ${r.name}</div>
              <div class="resp-opt-detail">${statusLabel}</div>
            </div>
            <div class="resp-opt-action">Assigner \u2192</div>
          </div>`;
        }).join('');
      }
      list.innerHTML = html;
    }
  }
}

function closeAssignModal() {
  document.getElementById('assignModal').classList.remove('active');
}

async function assignResponder(incidentId, responderId) {
  try {
    const res = await fetch(`${API_BASE}/dispatch/incidents/${encodeURIComponent(incidentId)}/assign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responderId }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`\u2705 ${data.responderName || 'Responder'} assign\u00e9 \u00e0 ${incidentId}`, 'success');
      closeAssignModal();
      refreshData();
    }
  } catch (err) {
    console.error('Assign failed:', err);
    showToast('\u274C \u00c9chec de l\'assignation', 'error');
  }
}

async function unassignResponder(incidentId, responderId) {
  if (!confirm('D\u00e9sassigner ce responder de l\'incident ?')) return;
  try {
    const res = await fetch(`${API_BASE}/dispatch/incidents/${encodeURIComponent(incidentId)}/unassign`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responderId }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`\u274C ${data.responderName || 'Responder'} d\u00e9sassign\u00e9 de ${incidentId}`, 'info');
      closeAssignModal();
      refreshData();
    } else {
      showToast(data.error || '\u00c9chec de la d\u00e9sassignation', 'error');
    }
  } catch (err) {
    console.error('Unassign failed:', err);
    showToast('\u274C \u00c9chec de la d\u00e9sassignation', 'error');
  }
}

function openResolveModal(incidentId) {
  resolveTargetId = incidentId;
  const inc = incidents.find(i => i.id === incidentId);
  document.getElementById('resolveModalSubtitle').textContent =
    inc ? `\u00cates-vous s\u00fbr de vouloir r\u00e9soudre ${formatIncidentId(inc.id)} \u2014 ${typeLabel(inc.type)} \u00e0 ${inc.address}?` : `R\u00e9soudre ${formatIncidentId(incidentId)}?`;
  document.getElementById('resolveModal').classList.add('active');
}

function closeResolveModal() {
  resolveTargetId = null;
  document.getElementById('resolveModal').classList.remove('active');
}

async function confirmResolve() {
  if (!resolveTargetId) return;
  try {
    const res = await fetch(`${API_BASE}/dispatch/incidents/${encodeURIComponent(resolveTargetId)}/resolve`, { method: 'PUT' });
    const data = await res.json();
    if (data.success) {
      closeResolveModal();
      refreshData();
    }
  } catch (err) {
    console.error('Resolve failed:', err);
    alert('Failed to resolve incident.');
  }
}

// ─── Helpers ─────────────────────────────────────────────────
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

// ─── Interactive Map (Leaflet + OpenStreetMap) ──────────────
let dispatchMap = null;
let mapIncidentMarkers = [];
let mapResponderMarkers = [];
let mapUserMarkers = [];
let mapUsers = [];
let mapResidenceMarkers = [];
let mapFilters = { incidents: true, responders: true, users: true, residences: true };
let mapIncidentTypeFilter = 'all';

function filterMapByType(type) {
  mapIncidentTypeFilter = type;
  // Update active button state
  document.querySelectorAll('.btn-type-filter').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-type') === type);
  });
  // Refresh map markers
  if (dispatchMap) refreshMapData();
}

// Custom icon builders
function createCircleIcon(color, size, label, nameLabel) {
  const nameHtml = nameLabel ? `<div style="
    position:absolute;top:${size + 2}px;left:50%;transform:translateX(-50%);
    white-space:nowrap;font-size:10px;font-weight:600;
    color:#fff;background:rgba(0,0,0,0.7);padding:1px 5px;border-radius:3px;
    pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,0.8);
  ">${nameLabel}</div>` : '';
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;">
      <div style="
        width:${size}px;height:${size}px;border-radius:50%;
        background:${color};border:3px solid rgba(255,255,255,0.9);
        box-shadow:0 2px 8px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;
        font-size:${Math.floor(size*0.45)}px;color:#fff;font-weight:700;
      ">${label || ''}</div>${nameHtml}</div>`,
    iconSize: [size, size],
    iconAnchor: [size/2, size/2],
    popupAnchor: [0, -size/2 - 4],
  });
}

const SEVERITY_COLORS = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#6b7280' };
const TYPE_EMOJIS = { sos: '🆘', medical: '🏥', fire: '🔥', security: '🔒', hazard: '⚠️', accident: '💥', broadcast: '📢', other: '🚨' };
const STATUS_COLORS_RESP= { on_duty: '#0ea5e9', available: '#22c55e', off_duty: '#6b7280', responding: '#f59e0b' };

function initMap() {
  if (dispatchMap) return;
  const mapEl = document.getElementById('dispatchMap');
  if (!mapEl) return;

  // Geneva center (Champel / Florissant / Malagnou / Vésenaz)
  dispatchMap = L.map('dispatchMap', {
    center: [46.2125, 6.1795],
    zoom: 13,
    zoomControl: true,
  });

  // Theme-aware tile layer
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const darkTiles = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  const lightTiles = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
  window._mapTileLayer = L.tileLayer(isLight ? lightTiles : darkTiles, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(dispatchMap);

  // ── Sectors (admin-managed organizational zones) ──
  loadSectors();
  setupSectorAdminUI();

  // ── GPS patrol rounds already in progress (e.g. map tab opened after a
  // round's WS snapshot already arrived) ──
  refreshPatrolRoundMapLayers();
  refreshPatrolRouteMapLayers();

  // ── Geneva POIs (hospitals, fire stations, police) ──
  const GENEVA_POIS = [
    { name: 'H\u00f4pital de la Tour', type: 'hospital', lat: 46.1930, lng: 6.1490, icon: '\ud83c\udfe5' },
    { name: 'HUG - Cl. de Champel', type: 'hospital', lat: 46.1910, lng: 6.1500, icon: '\ud83c\udfe5' },
    { name: 'Clinique G\u00e9n\u00e9rale Beaulieu', type: 'hospital', lat: 46.2000, lng: 6.1550, icon: '\ud83c\udfe5' },
    { name: 'Caserne pompiers Frontenex', type: 'fire_station', lat: 46.2050, lng: 6.1650, icon: '\ud83d\ude92' },
    { name: 'SIS Gen\u00e8ve - Caserne V\u00e9senaz', type: 'fire_station', lat: 46.2280, lng: 6.2020, icon: '\ud83d\ude92' },
    { name: 'Police municipale Champel', type: 'police', lat: 46.1940, lng: 6.1560, icon: '\ud83d\udc6e' },
    { name: 'Gendarmerie V\u00e9senaz', type: 'police', lat: 46.2320, lng: 6.2070, icon: '\ud83d\udc6e' },
    { name: 'Poste de police Florissant', type: 'police', lat: 46.1960, lng: 6.1700, icon: '\ud83d\udc6e' },
  ];
  window._poiMarkers = [];
  GENEVA_POIS.forEach(poi => {
    const m = L.marker([poi.lat, poi.lng], {
      icon: L.divIcon({
        className: 'poi-marker',
        html: `<div style="display:flex;align-items:center;gap:3px;font-size:11px;color:#94a3b8;white-space:nowrap;text-shadow:0 1px 2px rgba(0,0,0,0.8);">
          <span style="font-size:14px;">${poi.icon}</span>
          <span>${poi.name}</span>
        </div>`,
        iconSize: [160, 20],
        iconAnchor: [14, 10],
      }),
    }).addTo(dispatchMap);
    window._poiMarkers.push(m);
  });

  // Populate map
  refreshMapData();
}

async function refreshMapData() {
  try {
    // Fetch incidents
    const incRes = await fetch(`${API_BASE}/admin/incidents`);
    const incData = await incRes.json();

    // Fetch responders
    const respRes = await fetch(`${API_BASE}/dispatch/responders`);
    const respData = await respRes.json();

    // Fetch users (map-specific endpoint)
    try {
      const usrRes = await fetch(`${API_BASE}/dispatch/map/users`);
      mapUsers = await usrRes.json();
    } catch (e) {
      mapUsers = [];
    }

    // Cache data for search
    window._cachedMapUsers = mapUsers;
    window._cachedMapResponders = respData;

    // Fetch residences (house pins + family composition/presence)
    let residenceData = [];
    try {
      const resRes = await fetch(`${API_BASE}/dispatch/residences-detailed`);
      residenceData = await resRes.json();
    } catch (e) {
      residenceData = [];
    }

    // Update markers
    updateIncidentMarkers(incData);
    updateResponderMarkers(respData);
    updateUserMarkers(mapUsers);
    updateResidenceMarkers(residenceData);
  } catch (err) {
    console.error('[Map] Failed to refresh data:', err);
  }
}

function updateIncidentMarkers(incidentData) {
  // Clear existing
  mapIncidentMarkers.forEach(m => dispatchMap.removeLayer(m));
  mapIncidentMarkers = [];

  if (!mapFilters.incidents) return;

  // Filter out resolved incidents — they should not appear on the map
  // Also apply incident type filter
  const visibleIncidents = incidentData.filter(inc => {
    if (inc.status === 'resolved') return false;
    if (inc.archived) return false;
    if (mapIncidentTypeFilter !== 'all' && inc.type !== mapIncidentTypeFilter) return false;
    return true;
  });

  const markerPosById = {};

  visibleIncidents.forEach(inc => {
    const lat = inc.location?.latitude;
    const lng = inc.location?.longitude;
    if (lat == null || lng == null || (lat === 0 && lng === 0)) return; // no usable coordinates

    const color = SEVERITY_COLORS[inc.severity] || '#6b7280';
    const emoji = TYPE_EMOJIS[inc.type] || '🚨';
    const size = inc.severity === 'critical' ? 36 : inc.severity === 'high' ? 32 : 28;
    const agingTier = incidentAgingTier(inc);

    const marker = L.marker([lat, lng], {
      icon: createCircleIcon(color, size, emoji),
      zIndexOffset: inc.severity === 'critical' ? 1000 : inc.severity === 'high' ? 500 : (agingTier ? 300 : 0),
    });

    // Pulse ring for active critical incidents AND for any unacknowledged
    // incident aging past the warning/critical threshold — a tactical cue
    // that something needs attention right now, not just severity at creation.
    if ((inc.status === 'active' && inc.severity === 'critical') || agingTier) {
      const ringColor = agingTier === 'critical' ? '#ef4444' : agingTier === 'warning' ? '#f59e0b' : '#dc2626';
      const pulseCircle = L.circleMarker([lat, lng], {
        radius: 25, color: ringColor, fillColor: ringColor, fillOpacity: 0.15, weight: 2, opacity: 0.4,
        className: 'pulse-marker',
      });
      pulseCircle.addTo(dispatchMap);
      mapIncidentMarkers.push(pulseCircle);
    }

    const statusBadge = `<span class="popup-badge ${inc.status}">${inc.status}</span>`;
    const sevBadge = `<span class="popup-badge ${inc.severity}">${inc.severity}</span>`;
    const agingBadge = agingTier
      ? `<span class="popup-badge ${inc.status}" style="background:${agingTier === 'critical' ? '#ef4444' : '#f59e0b'};">⏳ ${formatAgeMinutes(inc)}</span>`
      : '';
    const actions = inc.status === 'active'
      ? `<div class="popup-actions">
          <button class="popup-btn ack" onclick="acknowledgeIncident('${inc.id}')">ACK</button>
          <button class="popup-btn assign" onclick="openAssignModal('${inc.id}')">Assign</button>
        </div>`
      : inc.status === 'acknowledged'
      ? `<div class="popup-actions">
          <button class="popup-btn resolve" onclick="openResolveModal('${inc.id}')">Resolve</button>
          <button class="popup-btn assign" onclick="openAssignModal('${inc.id}')">Assign</button>
        </div>`
      : '';

    const dupCount = (inc.possibleDuplicates || []).length;
    const linkedCount = (inc.linkedIncidentIds || []).length;
    const correlationLine = (dupCount + linkedCount) > 0
      ? `<div class="popup-detail">🔗 ${linkedCount > 0 ? `Lié à ${linkedCount} incident(s)` : ''}${linkedCount > 0 && dupCount > 0 ? ' · ' : ''}${dupCount > 0 ? `${dupCount} doublon(s) possible(s)` : ''}</div>`
      : '';

    marker.bindPopup(`
      <div class="popup-title">${emoji} ${formatIncidentId(inc.id)} — ${typeLabel(inc.type)}</div>
      <div>${sevBadge} ${statusBadge} ${agingBadge}</div>
      <div class="popup-detail">📍 ${inc.address}</div>
      <div class="popup-detail">👤 Signalé par: ${inc.reportedBy}</div>
      <div class="popup-detail">⏱ ${formatTimeAgo(inc.timestamp)}</div>
      ${inc.assignedCount > 0 ? `<div class="popup-detail">👮 ${inc.assignedCount} intervenant(s) assigné(s)</div>` : ''}
      ${correlationLine}
      <div class="popup-actions">
        <button class="popup-btn assign" onclick="openDetailModal('${inc.id}')">Détails</button>
        <button class="popup-btn ack" onclick="archiveIncident('${inc.id}')">Archiver</button>
        <button class="popup-btn delete" onclick="deleteIncident('${inc.id}')">Supprimer</button>
      </div>
      ${actions}
    `, { maxWidth: 280 });

    marker.addTo(dispatchMap);
    mapIncidentMarkers.push(marker);
    markerPosById[inc.id] = [lat, lng];
  });

  // Tactical correlation lines: dashed connector between incidents that are
  // confirmed-linked or flagged as possible duplicates of each other, so a
  // dispatcher can see clustered/related reports (e.g. several family members
  // reporting the same event) at a glance rather than reading each popup.
  const drawnPairs = new Set();
  visibleIncidents.forEach(inc => {
    const from = markerPosById[inc.id];
    if (!from) return;
    const relatedIds = [...(inc.linkedIncidentIds || []), ...(inc.possibleDuplicates || []).map(d => d.id)];
    relatedIds.forEach(otherId => {
      const to = markerPosById[otherId];
      if (!to) return;
      const pairKey = [inc.id, otherId].sort().join('|');
      if (drawnPairs.has(pairKey)) return;
      drawnPairs.add(pairKey);
      const isConfirmed = (inc.linkedIncidentIds || []).includes(otherId);
      const line = L.polyline([from, to], {
        color: isConfirmed ? '#8b5cf6' : '#6b7280',
        weight: 2, opacity: 0.6, dashArray: isConfirmed ? '2 6' : '4 8',
      }).addTo(dispatchMap);
      mapIncidentMarkers.push(line);
    });
  });
}

// Haversine distance in meters
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDistance(m) {
  return m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`;
}

function estimateETA(distMeters) {
  // Assume average emergency response speed: 40 km/h in urban areas
  const speedMs = 40 * 1000 / 3600; // ~11.1 m/s
  const seconds = distMeters / speedMs;
  if (seconds < 60) return '< 1 min';
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} h`;
}

function getResponderInterventionIcon(resp) {
  // Check if responder has any active assigned incidents with a status
  const activeInc = (resp.assignedIncidents || []).find(i => i.responderStatus && i.responderStatus !== 'assigned');
  if (activeInc) {
    switch (activeInc.responderStatus) {
      case 'accepted': return { emoji: '✅', color: '#22c55e', label: 'Accepté' };
      case 'en_route': return { emoji: '🚗', color: '#3b82f6', label: 'En route' };
      case 'on_scene': return { emoji: '📍', color: '#ef4444', label: 'Sur place' };
    }
  }
  // Fallback to general status
  const color = STATUS_COLORS_RESP[resp.status] || '#6b7280';
  if (resp.assignedIncidents && resp.assignedIncidents.length > 0) {
    return { emoji: '🔔', color: '#f59e0b', label: 'Assigné' };
  }
  return { emoji: '👮', color, label: resp.status === 'available' ? 'Disponible' : resp.status === 'on_duty' ? 'En service' : 'Hors service' };
}

function updateResponderMarkers(responderData) {
  mapResponderMarkers.forEach(m => dispatchMap.removeLayer(m));
  mapResponderMarkers = [];

  if (!mapFilters.responders) return;

  responderData.forEach(resp => {
    if (!resp.location) return;
    const iconInfo = getResponderInterventionIcon(resp);
    const respName = resp.name || '';
    
    // Build a richer name label with status
    const statusColors = { 'Accepté': '#22c55e', 'En route': '#3b82f6', 'Sur place': '#ef4444', 'Assigné': '#f59e0b', 'Disponible': '#22c55e', 'En service': '#f59e0b', 'Hors service': '#6b7280' };
    const statusColor = statusColors[iconInfo.label] || '#6b7280';
    const nameHtml = `<div style="
      position:absolute;top:32px;left:50%;transform:translateX(-50%);
      white-space:nowrap;font-size:10px;font-weight:600;
      color:#fff;background:rgba(0,0,0,0.75);padding:2px 6px;border-radius:4px;
      pointer-events:none;text-shadow:0 1px 2px rgba(0,0,0,0.8);
      display:flex;align-items:center;gap:4px;
    "><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${statusColor};"></span>${respName}</div>`;
    
    const marker = L.marker([resp.location.latitude, resp.location.longitude], {
      icon: L.divIcon({
        className: 'custom-marker',
        html: `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;">
          <div style="
            width:30px;height:30px;border-radius:50%;
            background:${iconInfo.color};border:3px solid rgba(255,255,255,0.9);
            box-shadow:0 2px 8px rgba(0,0,0,0.4);
            display:flex;align-items:center;justify-content:center;
            font-size:14px;
          ">${iconInfo.emoji}</div>${nameHtml}</div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      zIndexOffset: 200,
      _responderId: resp.id,
    });

    // Build popup with ETA info
    let popupHtml = `<div style="font-weight:700;font-size:13px;margin-bottom:4px;">${iconInfo.emoji} ${respName}</div>`;
    popupHtml += `<div style="display:inline-block;background:${statusColor};color:#fff;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;margin-bottom:6px;">${iconInfo.label}</div>`;
    
    // Show assigned incidents with ETA
    if (resp.assignedIncidents && resp.assignedIncidents.length > 0) {
      popupHtml += `<div style="border-top:1px solid #334155;padding-top:6px;margin-top:4px;font-size:11px;color:#94a3b8;">Incidents assignés:</div>`;
      resp.assignedIncidents.forEach(inc => {
        const respStatus = inc.responderStatus || 'assigned';
        const statusLabels = { assigned: 'Assigné', accepted: 'Accepté', en_route: 'En route', on_scene: 'Sur place' };
        const statusEmojis = { assigned: '🔔', accepted: '✅', en_route: '🚗', on_scene: '📍' };
        let etaHtml = '';
        if (inc.latitude && inc.longitude && respStatus !== 'on_scene') {
          const dist = haversineDistance(resp.location.latitude, resp.location.longitude, inc.latitude, inc.longitude);
          const eta = estimateETA(dist);
          etaHtml = `<div style="font-size:10px;color:#60a5fa;">📏 ${formatDistance(dist)} — ⏱ ETA: ${eta}</div>`;
        } else if (respStatus === 'on_scene') {
          etaHtml = `<div style="font-size:10px;color:#22c55e;">✅ Sur place</div>`;
        }
        popupHtml += `<div style="background:#1e293b;padding:4px 6px;border-radius:4px;margin-top:4px;">
          <div style="font-size:11px;font-weight:600;color:#e2e8f0;">${formatIncidentId(inc.id)} — ${typeLabel(inc.type)}</div>
          <div style="font-size:10px;color:#94a3b8;">${statusEmojis[respStatus] || '⚪'} ${statusLabels[respStatus] || respStatus}</div>
          ${etaHtml}
        </div>`;
      });
    }
    
    if (resp.isConnected) {
      popupHtml += `<div style="margin-top:6px;font-size:10px;color:#4ade80;">🟢 Connecté</div>`;
    } else {
      popupHtml += `<div style="margin-top:6px;font-size:10px;color:#6b7280;">⚫ Hors ligne</div>`;
    }

    marker.bindPopup(popupHtml, { maxWidth: 260 });
    marker.on('click', () => openUserProfile(resp.id, resp.name));

    marker.addTo(dispatchMap);
    mapResponderMarkers.push(marker);
  });
}

function updateUserMarkers(userData) {
  mapUserMarkers.forEach(m => dispatchMap.removeLayer(m));
  mapUserMarkers = [];

  if (!mapFilters.users) return;

  userData.forEach(user => {
    if (!user.location) return;
    const userName = user.name || '';
    const marker = L.marker([user.location.latitude, user.location.longitude], {
      icon: createCircleIcon('#8b5cf6', 22, '\uD83D\uDC64', userName),
      zIndexOffset: 100,
    });

    marker.on('click', () => openUserProfile(user.id, user.name));

    marker.addTo(dispatchMap);
    mapUserMarkers.push(marker);
  });

  // Update live users counter
  updateLiveUsersCounter();
}

function updateResidenceMarkers(residenceData) {
  mapResidenceMarkers.forEach(m => dispatchMap.removeLayer(m));
  mapResidenceMarkers = [];

  if (!mapFilters.residences) return;

  residenceData.forEach(res => {
    const marker = L.marker([res.latitude, res.longitude], {
      icon: createCircleIcon('#92400e', 22, '🏠', res.label),
      zIndexOffset: 50,
    });

    const occupancyHtml = res.occupancyStatus
      ? `<div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">${res.occupancyStatus === 'occupied' ? '🏠 Occupée' : '🚪 Inoccupée'}</div>`
      : '';
    const membersHtml = (res.members || []).map(m => `
      <div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-top:1px solid rgba(148,163,184,0.2);cursor:pointer;"
           onclick="openUserProfile('${m.userId}', '${escapeHtml(m.name).replace(/'/g, "\\'")}')">
        ${m.photoUrl
          ? `<img src="${m.photoUrl.startsWith('/') ? API_BASE + m.photoUrl : m.photoUrl}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;">`
          : `<div style="width:28px;height:28px;border-radius:50%;background:#92400e;color:#fff;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;">${escapeHtml((m.name || '?').charAt(0).toUpperCase())}</div>`}
        <div style="flex:1;">
          <div style="font-size:12px;font-weight:600;color:#e2e8f0;">${escapeHtml(m.name)}</div>
          <div style="font-size:10px;color:#94a3b8;">${m.relationship === 'self' ? 'Titulaire' : escapeHtml(m.relationship)}</div>
        </div>
        <div style="font-size:10px;font-weight:700;color:${m.isPresent ? '#4ade80' : '#6b7280'};">${m.isPresent ? '● Présent' : '○ Sorti'}</div>
      </div>`).join('');

    const popupHtml = `
      <div style="min-width:220px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;">
          <div style="font-size:13px;font-weight:700;color:#f1f5f9;">🏠 ${escapeHtml(res.label)}</div>
          <span style="cursor:pointer;font-size:12px;" title="Renommer" onclick="renameResidence('${res.id}','${res.ownerId}')">✏️</span>
        </div>
        <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">${escapeHtml(res.address || '')}</div>
        ${occupancyHtml}
        ${membersHtml}
      </div>`;

    marker.bindPopup(popupHtml, { maxWidth: 280 });
    marker.addTo(dispatchMap);
    mapResidenceMarkers.push(marker);
  });
}

async function renameResidence(id, ownerId) {
  const newLabel = window.prompt('Nouveau nom de la résidence :');
  if (!newLabel || !newLabel.trim()) return;
  try {
    const res = await fetch(`${API_BASE}/api/family/residences/${id}/label`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: ownerId, label: newLabel.trim() }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Impossible de renommer cette résidence (HTTP ${res.status}: ${err.error || 'unknown'})`);
      return;
    }
    refreshMapData();
  } catch (e) {
    alert('Erreur réseau');
  }
}

function updateLiveUsersCounter() {
  const liveCount = (mapUsers || []).filter(u => u.location).length;
  const countEl = document.getElementById('liveUsersCount');
  const counterEl = document.getElementById('liveUsersCounter');
  if (countEl) countEl.textContent = liveCount;
  if (counterEl) {
    if (liveCount > 0) {
      counterEl.classList.add('has-live');
    } else {
      counterEl.classList.remove('has-live');
    }
  }
}

function updateMapFilters() {
  mapFilters.incidents = document.getElementById('filterIncidents')?.checked ?? true;
  mapFilters.responders = document.getElementById('filterResponders')?.checked ?? true;
  mapFilters.users = document.getElementById('filterUsers')?.checked ?? true;
  mapFilters.residences = document.getElementById('filterResidences')?.checked ?? true;
  if (dispatchMap) refreshMapData();
}

// Hook into WS messages to update map in real-time
const _origHandleWsMessage = handleWsMessage;
handleWsMessage = function(msg) {
  _origHandleWsMessage(msg);
  // Update map on relevant events
  // Note: userLocationUpdate and userLocationRemoved have their own direct handlers
  // that update mapUsers and call updateUserMarkers() without a full refresh.
  // Including them here would cause a race condition where refreshMapData re-fetches
  // stale data and re-adds markers that were just removed.
  if (dispatchMap && ['newAlert', 'alertAcknowledged', 'alertUpdate', 'alertResolved', 'alertDeleted', 'alertsSnapshot', 'alertsList', 'responderLocationUpdate', 'responderStatusUpdate', 'userStatusChange'].includes(msg.type)) {
    refreshMapData();
  }
};

// ─── Visual Geofencing ──────────────────────────────────────
let geofenceMode = false;
let geofenceCenter = null;
let geofenceRadius = 5; // km
let geofenceSeverity = 'medium';
let geofenceCircle = null;
let geofenceCenterMarker = null;
let geofenceMapClickHandler = null;
let activeZones = [];
let activeZoneLayers = [];

function toggleGeofenceMode() {
  if (geofenceMode) {
    cancelGeofence();
  } else {
    startGeofenceMode();
  }
}

function startGeofenceMode() {
  if (!dispatchMap) { initMap(); return; }
  geofenceMode = true;
  geofenceCenter = null;
  geofenceRadius = 5;
  geofenceSeverity = 'medium';

  // Update UI
  const btn = document.getElementById('btnDrawZone');
  btn.classList.add('active');
  btn.innerHTML = '&#x274C; Cancel Drawing';

  // Show panel
  const panel = document.getElementById('geofencePanel');
  panel.style.display = 'block';
  document.getElementById('gfInfo').textContent = 'Click on the map to place zone center';
  document.getElementById('gfInfo').classList.add('active-drawing');
  document.getElementById('gfRadiusField').style.display = 'none';
  document.getElementById('gfSeverityField').style.display = 'none';
  document.getElementById('gfMessageField').style.display = 'none';
  document.getElementById('gfStats').style.display = 'none';
  document.getElementById('gfActions').style.display = 'none';
  document.getElementById('gfRadiusSlider').value = 5;
  document.getElementById('gfRadiusValue').textContent = '5';
  document.getElementById('gfMessage').value = '';

  // Reset severity buttons
  document.querySelectorAll('.gf-sev-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.gf-sev-btn[data-sev="medium"]')?.classList.add('active');

  // Set crosshair cursor
  dispatchMap.getContainer().classList.add('geofence-drawing');

  // Add click handler
  geofenceMapClickHandler = function(e) {
    placeGeofenceCenter(e.latlng);
  };
  dispatchMap.on('click', geofenceMapClickHandler);
}

function placeGeofenceCenter(latlng) {
  geofenceCenter = latlng;

  // Remove previous center marker and circle
  if (geofenceCenterMarker) dispatchMap.removeLayer(geofenceCenterMarker);
  if (geofenceCircle) dispatchMap.removeLayer(geofenceCircle);

  // Create center marker
  geofenceCenterMarker = L.marker(latlng, {
    icon: L.divIcon({
      className: 'gf-center-icon',
      html: `<div style="
        width:20px;height:20px;border-radius:50%;
        background:#f59e0b;border:3px solid #fff;
        box-shadow:0 0 12px rgba(245,158,11,0.6);
        display:flex;align-items:center;justify-content:center;
        font-size:10px;
      ">&#x1F4CD;</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    }),
    draggable: true,
    zIndexOffset: 2000,
  }).addTo(dispatchMap);

  // Allow dragging to reposition
  geofenceCenterMarker.on('drag', function(e) {
    geofenceCenter = e.target.getLatLng();
    updateGeofenceCircle();
    updateGeofenceStats();
  });

  // Draw radius circle
  updateGeofenceCircle();

  // Show all form fields
  document.getElementById('gfInfo').textContent = `Zone center: ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  document.getElementById('gfInfo').classList.remove('active-drawing');
  document.getElementById('gfRadiusField').style.display = 'block';
  document.getElementById('gfSeverityField').style.display = 'block';
  document.getElementById('gfMessageField').style.display = 'block';
  document.getElementById('gfStats').style.display = 'flex';
  document.getElementById('gfActions').style.display = 'flex';

  // Remove crosshair
  dispatchMap.getContainer().classList.remove('geofence-drawing');

  // Remove click handler (center is placed)
  if (geofenceMapClickHandler) {
    dispatchMap.off('click', geofenceMapClickHandler);
    geofenceMapClickHandler = null;
  }

  // Count entities in zone
  updateGeofenceStats();
}

function updateGeofenceCircle() {
  if (!geofenceCenter) return;
  if (geofenceCircle) dispatchMap.removeLayer(geofenceCircle);

  const sevColor = SEVERITY_COLORS[geofenceSeverity] || '#f59e0b';
  geofenceCircle = L.circle(geofenceCenter, {
    radius: geofenceRadius * 1000, // km to meters
    color: sevColor,
    fillColor: sevColor,
    fillOpacity: 0.12,
    weight: 2.5,
    dashArray: '8, 6',
    opacity: 0.7,
  }).addTo(dispatchMap);

  // Fit map to show the zone
  dispatchMap.fitBounds(geofenceCircle.getBounds(), { padding: [40, 40], maxZoom: 15 });
}

function updateGeofenceRadius(value) {
  geofenceRadius = parseFloat(value);
  document.getElementById('gfRadiusValue').textContent = value;
  updateGeofenceCircle();
  updateGeofenceStats();
}

function selectGfSeverity(sev) {
  geofenceSeverity = sev;
  document.querySelectorAll('.gf-sev-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.gf-sev-btn[data-sev="${sev}"]`)?.classList.add('active');
  updateGeofenceCircle();
}

function updateGeofenceStats() {
  if (!geofenceCenter) return;
  const statsEl = document.getElementById('gfStats');
  const radiusM = geofenceRadius * 1000;

  // Count incidents in zone
  let incCount = 0;
  const KNOWN_COORDS = {
    'Avenue de Champel 24, 1206 Genève': [46.1925, 6.1535],
    'Route de Florissant 62, 1206 Genève': [46.1955, 6.1675],
    'Route de Malagnou 32, 1208 Genève': [46.2005, 6.1615],
    'Chemin des Crêts-de-Champel 2, 1206 Genève': [46.1970, 6.1690],
    'Route de Thonon 85, 1222 Vésenaz': [46.2315, 6.2055],
    'Chemin de la Capite 12, 1222 Vésenaz': [46.2300, 6.2040],
    'Avenue de Miremont 30, 1206 Genève': [46.1945, 6.1665],
    'Chemin du Velours 10, 1208 Genève': [46.2030, 6.1600],
  };
  incidents.filter(inc => inc.status !== 'resolved').forEach(inc => {
    const coords = KNOWN_COORDS[inc.address];
    if (coords) {
      const dist = geofenceCenter.distanceTo(L.latLng(coords[0], coords[1]));
      if (dist <= radiusM) incCount++;
    }
  });

  // Count responders in zone
  let respCount = 0;
  responders.forEach(r => {
    if (r.location) {
      const dist = geofenceCenter.distanceTo(L.latLng(r.location.latitude, r.location.longitude));
      if (dist <= radiusM) respCount++;
    }
  });

  // Count users in zone
  let userCount = 0;
  mapUsers.forEach(u => {
    if (u.location) {
      const dist = geofenceCenter.distanceTo(L.latLng(u.location.latitude, u.location.longitude));
      if (dist <= radiusM) userCount++;
    }
  });

  statsEl.innerHTML = `
    <span class="gf-stat-item">&#x1F6A8; <span class="gf-stat-num">${incCount}</span> incident${incCount !== 1 ? 's' : ''}</span>
    <span class="gf-stat-item">&#x1F46E; <span class="gf-stat-num">${respCount}</span> responder${respCount !== 1 ? 's' : ''}</span>
    <span class="gf-stat-item">&#x1F464; <span class="gf-stat-num">${userCount}</span> user${userCount !== 1 ? 's' : ''}</span>
    <span class="gf-stat-item">&#x1F4CF; <span class="gf-stat-num">${(Math.PI * geofenceRadius * geofenceRadius).toFixed(1)}</span> km&sup2;</span>
  `;
}

function cancelGeofence() {
  geofenceMode = false;
  geofenceCenter = null;

  // Clean up map layers
  if (geofenceCenterMarker) { dispatchMap.removeLayer(geofenceCenterMarker); geofenceCenterMarker = null; }
  if (geofenceCircle) { dispatchMap.removeLayer(geofenceCircle); geofenceCircle = null; }
  if (geofenceMapClickHandler) { dispatchMap.off('click', geofenceMapClickHandler); geofenceMapClickHandler = null; }

  // Reset UI
  const btn = document.getElementById('btnDrawZone');
  btn.classList.remove('active');
  btn.innerHTML = '&#x1F4CD; Draw Zone';
  document.getElementById('geofencePanel').style.display = 'none';
  dispatchMap?.getContainer().classList.remove('geofence-drawing');
}

async function sendGeofenceBroadcast() {
  if (!geofenceCenter) return;
  const message = document.getElementById('gfMessage').value.trim();
  if (!message) { alert('Please enter a broadcast message.'); return; }

  try {
    // 1) Send broadcast
    const res = await fetch(`${API_BASE}/dispatch/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        severity: geofenceSeverity,
        radiusKm: geofenceRadius,
        by: 'Dispatch Console (Map)',
        center: { latitude: geofenceCenter.lat, longitude: geofenceCenter.lng },
      }),
    });
    const data = await res.json();
    if (data.success) {
      // 2) Register geofence zone server-side for entry/exit tracking
      let serverZoneId = 'zone-' + Date.now();
      try {
        const gfRes = await fetch(`${API_BASE}/dispatch/geofence/zones`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            center: { latitude: geofenceCenter.lat, longitude: geofenceCenter.lng },
            radiusKm: geofenceRadius,
            severity: geofenceSeverity,
            message: message,
            createdBy: 'Dispatch Console (Map)',
          }),
        });
        const gfData = await gfRes.json();
        if (gfData.success && gfData.zone) serverZoneId = gfData.zone.id;
      } catch (e) { console.warn('Failed to register geofence zone server-side:', e); }

      // Add to active zones
      const zone = {
        id: serverZoneId,
        center: geofenceCenter,
        radius: geofenceRadius,
        severity: geofenceSeverity,
        message: message,
        timestamp: Date.now(),
      };
      addActiveZone(zone);

      // Show toast
      showToast(`Broadcast sent to zone (${geofenceRadius}km radius)`, 'success');

      // Reset geofence mode but keep the zone visible
      geofenceMode = false;
      geofenceCenterMarker = null;
      geofenceCircle = null;
      const btn = document.getElementById('btnDrawZone');
      btn.classList.remove('active');
      btn.innerHTML = '&#x1F4CD; Draw Zone';
      document.getElementById('geofencePanel').style.display = 'none';
      dispatchMap?.getContainer().classList.remove('geofence-drawing');

      // Refresh data
      refreshData();
    }
  } catch (err) {
    console.error('Geofence broadcast failed:', err);
    alert('Failed to send broadcast.');
  }
}

// ─── Active Zones Management ────────────────────────────────
function addActiveZone(zone) {
  activeZones.push(zone);

  // Draw persistent zone on map
  const sevColor = SEVERITY_COLORS[zone.severity] || '#f59e0b';
  const circle = L.circle(zone.center, {
    radius: zone.radius * 1000,
    color: sevColor,
    fillColor: sevColor,
    fillOpacity: 0.08,
    weight: 2,
    dashArray: '6, 4',
    opacity: 0.5,
  }).addTo(dispatchMap);

  // Add label at center
  const label = L.marker(zone.center, {
    icon: L.divIcon({
      className: 'zone-label',
      html: `<div style="
        background:${sevColor};color:#fff;padding:3px 8px;border-radius:6px;
        font-size:10px;font-weight:700;white-space:nowrap;
        box-shadow:0 2px 6px rgba(0,0,0,0.3);
      ">&#x1F4E1; ${zone.radius}km — ${zone.severity.toUpperCase()}</div>`,
      iconSize: [120, 24],
      iconAnchor: [60, 12],
    }),
    zIndexOffset: 1500,
  }).addTo(dispatchMap);

  circle.bindPopup(`
    <div class="popup-title">&#x1F4E1; Broadcast Zone</div>
    <div><span class="popup-badge ${zone.severity}">${zone.severity}</span></div>
    <div class="popup-detail">&#x1F4CF; Radius: ${zone.radius} km (${(Math.PI * zone.radius * zone.radius).toFixed(1)} km&sup2;)</div>
    <div class="popup-detail">&#x1F4AC; ${zone.message}</div>
    <div class="popup-detail">&#x23F1; ${formatTimeAgo(zone.timestamp)}</div>
    <div class="popup-actions">
      <button class="popup-btn" style="background:#ef4444;color:#fff;" onclick="removeActiveZone('${zone.id}')">Remove Zone</button>
    </div>
  `, { maxWidth: 280 });

  activeZoneLayers.push({ id: zone.id, circle, label });

  // Show active zones panel
  renderActiveZones();
}

function removeActiveZone(zoneId) {
  const idx = activeZoneLayers.findIndex(z => z.id === zoneId);
  if (idx !== -1) {
    dispatchMap.removeLayer(activeZoneLayers[idx].circle);
    dispatchMap.removeLayer(activeZoneLayers[idx].label);
    activeZoneLayers.splice(idx, 1);
  }
  activeZones = activeZones.filter(z => z.id !== zoneId);
  renderActiveZones();
  dispatchMap.closePopup();
  // Delete server-side geofence zone
  fetch(`${API_BASE}/dispatch/geofence/zones/${zoneId}`, { method: 'DELETE' }).catch(e => console.warn('Failed to delete server zone:', e));
}

function focusActiveZone(zoneId) {
  const layer = activeZoneLayers.find(z => z.id === zoneId);
  if (layer) {
    dispatchMap.fitBounds(layer.circle.getBounds(), { padding: [40, 40], maxZoom: 15 });
    layer.circle.openPopup();
  }
}

function renderActiveZones() {
  const panel = document.getElementById('activeZonesPanel');
  const list = document.getElementById('azList');
  const count = document.getElementById('azCount');

  count.textContent = activeZones.length;

  if (activeZones.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  list.innerHTML = activeZones.map(z => `
    <div class="az-item">
      <div class="az-item-info">
        <div class="az-item-title">&#x1F4E1; ${z.severity.toUpperCase()} — ${z.radius}km</div>
        <div class="az-item-meta">${z.message.substring(0, 40)}${z.message.length > 40 ? '...' : ''} · ${formatTimeAgo(z.timestamp)}</div>
      </div>
      <div class="az-item-actions">
        <button class="az-btn focus" onclick="focusActiveZone('${z.id}')">&#x1F50D;</button>
        <button class="az-btn delete" onclick="removeActiveZone('${z.id}')">&#x1F5D1;</button>
      </div>
    </div>
  `).join('');
}

function toggleActiveZones() {
  const panel = document.getElementById('activeZonesPanel');
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}


// ─── Geofence Event Log ──────────────────────────────────────
let geofenceEvents = [];

function addGeofenceEventToLog(ev) {
  geofenceEvents.unshift(ev);
  if (geofenceEvents.length > 50) geofenceEvents = geofenceEvents.slice(0, 50);
  renderGeofenceEvents();
  updateGfeBadge();
}

function renderGeofenceEvents() {
  const list = document.getElementById('gfeList');
  const count = document.getElementById('gfeCount');
  if (!list || !count) return;

  count.textContent = geofenceEvents.length;

  if (geofenceEvents.length === 0) {
    list.innerHTML = '<div class="gfe-empty">No geofence events yet. Create a zone and simulate responder movement to see events.</div>';
    return;
  }

  list.innerHTML = geofenceEvents.map((ev, i) => {
    const isEntry = ev.eventType === 'entry';
    const icon = isEntry ? '🟢' : '🔴';
    const action = isEntry ? 'entered' : 'exited';
    const time = ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : '--';
    const zoneSev = ev.zone?.severity?.toUpperCase() || 'UNKNOWN';
    const zoneRadius = ev.zone?.radiusKm || '?';
    return `
      <div class="gfe-item ${isEntry ? 'entry' : 'exit'} ${i === 0 ? 'gfe-item-new' : ''}">
        <div class="gfe-icon">${icon}</div>
        <div class="gfe-content">
          <div class="gfe-title">${ev.responderName || ev.responderId} ${action} zone</div>
          <div class="gfe-detail">${zoneSev} zone · ${zoneRadius}km radius · ${ev.zone?.message || ''}</div>
        </div>
        <div class="gfe-time">${time}</div>
      </div>
    `;
  }).join('');
}

function updateGfeBadge() {
  const badge = document.getElementById('gfeBadge');
  if (badge) badge.textContent = geofenceEvents.length;
}

function toggleGeofenceEvents() {
  const panel = document.getElementById('geofenceEventsPanel');
  if (!panel) return;
  panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

async function refreshGeofenceEvents() {
  try {
    const res = await fetch(`${API_BASE}/dispatch/geofence/events`);
    const data = await res.json();
    if (data.success && data.events) {
      geofenceEvents = data.events;
      renderGeofenceEvents();
      updateGfeBadge();
    }
  } catch (e) {
    console.warn('Failed to fetch geofence events:', e);
  }
}

// ─── Responder Marker Flashing ───────────────────────────────
function flashResponderMarker(responderId, type) {
  // Find the responder marker on the map
  if (!dispatchMap) return;
  dispatchMap.eachLayer(layer => {
    if (layer._icon && layer.options && layer.options._responderId === responderId) {
      const el = layer._icon;
      el.classList.remove('marker-flash-entry', 'marker-flash-exit');
      // Force reflow
      void el.offsetWidth;
      el.classList.add(type === 'entry' ? 'marker-flash-entry' : 'marker-flash-exit');
      setTimeout(() => {
        el.classList.remove('marker-flash-entry', 'marker-flash-exit');
      }, 5000);
    }
  });

  // Also try to find by iterating responderMarkers if stored
  if (typeof mapMarkers !== 'undefined' && mapMarkers.responders) {
    const marker = mapMarkers.responders.find(m => m.options?._responderId === responderId);
    if (marker && marker._icon) {
      const el = marker._icon;
      el.classList.remove('marker-flash-entry', 'marker-flash-exit');
      void el.offsetWidth;
      el.classList.add(type === 'entry' ? 'marker-flash-entry' : 'marker-flash-exit');
      setTimeout(() => {
        el.classList.remove('marker-flash-entry', 'marker-flash-exit');
      }, 5000);
    }
  }
}

// ─── Simulate Movement Panel ─────────────────────────────────
function toggleSimulatePanel() {
  const panel = document.getElementById('simulatePanel');
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (isHidden) populateSimResponders();
}

function populateSimResponders() {
  const select = document.getElementById('simResponder');
  if (!select) return;
  select.innerHTML = responders.map(r =>
    `<option value="${r.id}">${r.name} (${r.status})</option>`
  ).join('');
}

async function simulateMoveInto() {
  const responderId = document.getElementById('simResponder')?.value;
  if (!responderId) return;
  if (activeZones.length === 0) {
    setSimStatus('No active zones. Draw a zone first.', 'error');
    return;
  }

  // Pick the first active zone and move responder to its center
  const zone = activeZones[0];
  const lat = zone.center.lat + (Math.random() - 0.5) * 0.001; // slight offset
  const lng = zone.center.lng + (Math.random() - 0.5) * 0.001;

  try {
    const res = await fetch(`${API_BASE}/dispatch/geofence/simulate-move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        responderId,
        latitude: lat,
        longitude: lng,
      }),
    });
    const data = await res.json();
    if (data.success) {
      const resp = responders.find(r => r.id === responderId);
      setSimStatus(`Moved ${resp?.name || responderId} into zone center (${lat.toFixed(4)}, ${lng.toFixed(4)})`, 'success');
    } else {
      setSimStatus(data.error || 'Failed to simulate', 'error');
    }
  } catch (e) {
    setSimStatus('Network error: ' + e.message, 'error');
  }
}

async function simulateMoveOut() {
  const responderId = document.getElementById('simResponder')?.value;
  if (!responderId) return;
  if (activeZones.length === 0) {
    setSimStatus('No active zones. Draw a zone first.', 'error');
    return;
  }

  // Move responder far away from all zones
  const lat = 46.25 + Math.random() * 0.05; // North of Geneva (outside zones)
  const lng = 6.10 + Math.random() * 0.05;

  try {
    const res = await fetch(`${API_BASE}/dispatch/geofence/simulate-move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        responderId,
        latitude: lat,
        longitude: lng,
      }),
    });
    const data = await res.json();
    if (data.success) {
      const resp = responders.find(r => r.id === responderId);
      setSimStatus(`Moved ${resp?.name || responderId} out of all zones (${lat.toFixed(4)}, ${lng.toFixed(4)})`, 'success');
    } else {
      setSimStatus(data.error || 'Failed to simulate', 'error');
    }
  } catch (e) {
    setSimStatus('Network error: ' + e.message, 'error');
  }
}

function setSimStatus(text, type) {
  const el = document.getElementById('simStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'sim-status ' + (type || '');
  setTimeout(() => { el.textContent = ''; el.className = 'sim-status'; }, 5000);
}

// Load geofence events on map init
const origInitMap = initMap;
initMap = function() {
  origInitMap();
  // Load server-side geofence events after map init
  setTimeout(() => {
    refreshGeofenceEvents();
    loadServerGeofenceZones();
  }, 1000);
};

// Load server-side geofence zones on map init
async function loadServerGeofenceZones() {
  try {
    const res = await fetch(`${API_BASE}/dispatch/geofence/zones`);
    const data = await res.json();
    if (data.success && data.zones) {
      data.zones.forEach(z => {
        // Only add if not already in activeZones
        if (!activeZones.find(az => az.id === z.id)) {
          const zone = {
            id: z.id,
            center: L.latLng(z.center.latitude, z.center.longitude),
            radius: z.radiusKm,
            severity: z.severity,
            message: z.message,
            timestamp: new Date(z.createdAt).getTime(),
          };
          addActiveZone(zone);
        }
      });
    }
  } catch (e) {
    console.warn('Failed to load server geofence zones:', e);
  }
}


// ─── Geofence Alert Sounds (Web Audio API) ────────────────────
let geofenceSoundsEnabled = true;
let audioCtx = null;

function getAudioContext() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if suspended (browser autoplay policy)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

/**
 * Play a tone sequence using Web Audio API.
 * @param {Array} notes - Array of {freq, duration, type, gain} objects
 * @param {number} startDelay - Delay before first note in seconds
 */
function playToneSequence(notes, startDelay = 0) {
  const ctx = getAudioContext();
  let time = ctx.currentTime + startDelay;

  notes.forEach(note => {
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();
    osc.connect(gainNode);
    gainNode.connect(ctx.destination);

    osc.type = note.type || 'sine';
    osc.frequency.setValueAtTime(note.freq, time);

    // If freq changes (sweep), ramp to it
    if (note.freqEnd) {
      osc.frequency.linearRampToValueAtTime(note.freqEnd, time + note.duration);
    }

    const vol = note.gain || 0.3;
    gainNode.gain.setValueAtTime(0, time);
    gainNode.gain.linearRampToValueAtTime(vol, time + 0.01); // fast attack
    gainNode.gain.setValueAtTime(vol, time + note.duration - 0.05);
    gainNode.gain.linearRampToValueAtTime(0, time + note.duration); // fade out

    osc.start(time);
    osc.stop(time + note.duration);

    time += note.duration + (note.gap || 0);
  });
}

/**
 * Play geofence alert sound based on severity and event type.
 * Critical: urgent siren (alternating high tones, 3 cycles)
 * High: rapid alarm (fast beeps)
 * Medium: double beep
 * Low: single gentle beep
 * Entry: ascending pitch, Exit: descending pitch
 */
function playGeofenceAlertSound(severity, eventType) {
  if (!geofenceSoundsEnabled) return;

  const isEntry = eventType === 'entry';

  switch (severity) {
    case 'critical': {
      // Urgent siren: alternating high/low tones, 3 cycles
      const notes = [];
      for (let i = 0; i < 3; i++) {
        if (isEntry) {
          notes.push({ freq: 880, freqEnd: 1320, duration: 0.2, type: 'sawtooth', gain: 0.25 });
          notes.push({ freq: 1320, freqEnd: 880, duration: 0.2, type: 'sawtooth', gain: 0.25 });
        } else {
          notes.push({ freq: 1320, freqEnd: 660, duration: 0.2, type: 'sawtooth', gain: 0.25 });
          notes.push({ freq: 660, freqEnd: 440, duration: 0.2, type: 'sawtooth', gain: 0.25 });
        }
      }
      playToneSequence(notes);
      break;
    }

    case 'high': {
      // Rapid alarm: 4 fast beeps
      const baseFreq = isEntry ? 660 : 880;
      const step = isEntry ? 55 : -55;
      const notes = [];
      for (let i = 0; i < 4; i++) {
        notes.push({ freq: baseFreq + step * i, duration: 0.12, type: 'square', gain: 0.2, gap: 0.06 });
      }
      playToneSequence(notes);
      break;
    }

    case 'medium': {
      // Double beep
      const f1 = isEntry ? 523 : 659;
      const f2 = isEntry ? 659 : 523;
      playToneSequence([
        { freq: f1, duration: 0.15, type: 'sine', gain: 0.25, gap: 0.08 },
        { freq: f2, duration: 0.2, type: 'sine', gain: 0.25 },
      ]);
      break;
    }

    case 'low':
    default: {
      // Single gentle beep
      const freq = isEntry ? 440 : 330;
      playToneSequence([
        { freq, duration: 0.25, type: 'sine', gain: 0.15 },
      ]);
      break;
    }
  }
}

/**
 * Toggle geofence sounds on/off.
 */
function toggleGeofenceSounds() {
  geofenceSoundsEnabled = !geofenceSoundsEnabled;
  const btn = document.getElementById('btnSoundToggle');
  if (btn) {
    if (geofenceSoundsEnabled) {
      btn.innerHTML = '&#x1F50A; Sound ON';
      btn.classList.remove('muted');
      // Play a short confirmation beep
      playToneSequence([{ freq: 523, duration: 0.1, type: 'sine', gain: 0.15, gap: 0.05 }, { freq: 659, duration: 0.15, type: 'sine', gain: 0.15 }]);
    } else {
      btn.innerHTML = '&#x1F507; Sound OFF';
      btn.classList.add('muted');
    }
  }
}

// ─── Alert Sounds (Web Audio API) ───────────────────────────────────────
/**
 * Play alert sound when a new incident arrives.
 * SOS: urgent repeating siren (3 cycles of alternating high/low)
 * Critical: fast triple beep with rising pitch
 * High: double beep
 * Medium/Low: single notification tone
 */
// Duress: the single most critical signal this console can raise — someone
// "cancelled" their own SOS under coercion. Deliberately NOT the same sound
// as a normal SOS (square-wave siren, wider pitch swing, more repeats) so a
// dispatcher can tell it apart by ear alone. Repetition and dismissal reuse
// the existing critical-alert-banner machinery below (it already re-sounds
// every 10s until acknowledged) rather than a second, competing timer — it's
// just told which sound and styling to use for a duress incident.
function playDuressAlertSound() {
  try {
    const audioEl = document.getElementById("sosAlertAudio");
    if (audioEl) { audioEl.currentTime = 0; audioEl.play().catch(() => {}); }
  } catch (e) {}
  if (!geofenceSoundsEnabled) return;
  const notes = [];
  for (let i = 0; i < 6; i++) {
    notes.push({ freq: 660, freqEnd: 1760, duration: 0.15, type: 'square', gain: 0.4 });
    notes.push({ freq: 1760, freqEnd: 660, duration: 0.15, type: 'square', gain: 0.4 });
  }
  playToneSequence(notes);
}

function playNewAlertSound(type, severity) {
  // Try HTML Audio element first (fewer browser restrictions)
  try {
    const audioEl = document.getElementById("sosAlertAudio");
    if (audioEl && type === "sos") {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
    }
  } catch(e) {}
  if (!geofenceSoundsEnabled) return;

  if (type === 'sos') {
    // SOS: urgent siren — alternating high/low sawtooth, 4 cycles, louder
    const notes = [];
    for (let i = 0; i < 4; i++) {
      notes.push({ freq: 880, freqEnd: 1400, duration: 0.25, type: 'sawtooth', gain: 0.35 });
      notes.push({ freq: 1400, freqEnd: 880, duration: 0.25, type: 'sawtooth', gain: 0.35 });
    }
    playToneSequence(notes);
    // Play a second wave after a short pause for urgency
    setTimeout(() => {
      if (geofenceSoundsEnabled) playToneSequence(notes);
    }, 2200);
    return;
  }

  switch (severity) {
    case 'critical': {
      // Fast triple beep with rising pitch
      playToneSequence([
        { freq: 880, duration: 0.15, type: 'square', gain: 0.3, gap: 0.08 },
        { freq: 1047, duration: 0.15, type: 'square', gain: 0.3, gap: 0.08 },
        { freq: 1320, duration: 0.2, type: 'square', gain: 0.35 },
      ]);
      // Repeat after short pause
      setTimeout(() => {
        if (geofenceSoundsEnabled) {
          playToneSequence([
            { freq: 880, duration: 0.15, type: 'square', gain: 0.3, gap: 0.08 },
            { freq: 1047, duration: 0.15, type: 'square', gain: 0.3, gap: 0.08 },
            { freq: 1320, duration: 0.2, type: 'square', gain: 0.35 },
          ]);
        }
      }, 1000);
      break;
    }
    case 'high': {
      // Double beep, ascending
      playToneSequence([
        { freq: 660, duration: 0.18, type: 'sine', gain: 0.25, gap: 0.1 },
        { freq: 880, duration: 0.22, type: 'sine', gain: 0.3 },
      ]);
      break;
    }
    case 'medium': {
      // Single notification tone
      playToneSequence([
        { freq: 523, duration: 0.3, type: 'sine', gain: 0.2 },
      ]);
      break;
    }
    case 'low':
    default: {
      // Gentle single beep
      playToneSequence([
        { freq: 440, duration: 0.25, type: 'sine', gain: 0.15 },
      ]);
      break;
    }
  }
}

/**
 * Play a sound when an alert is acknowledged.
 */
function playAcknowledgeSound() {
  if (!geofenceSoundsEnabled) return;
  playToneSequence([
    { freq: 523, duration: 0.1, type: 'sine', gain: 0.15, gap: 0.05 },
    { freq: 659, duration: 0.15, type: 'sine', gain: 0.15 },
  ]);
}

/**
 * Play a sound when an alert is resolved.
 */
function playResolveSound() {
  if (!geofenceSoundsEnabled) return;
  playToneSequence([
    { freq: 523, duration: 0.12, type: 'sine', gain: 0.15, gap: 0.05 },
    { freq: 659, duration: 0.12, type: 'sine', gain: 0.15, gap: 0.05 },
    { freq: 784, duration: 0.2, type: 'sine', gain: 0.2 },
  ]);
}

// ─── Browser Web Notifications ─────────────────────────────────────────
let browserNotificationsEnabled = false;
let notifPermission = 'default'; // 'default', 'granted', 'denied'

function initBrowserNotifications() {
  if (!('Notification' in window)) {
    console.warn('[Notif] Browser does not support notifications');
    updateNotifButton('unsupported');
    return;
  }
  notifPermission = Notification.permission;
  if (notifPermission === 'granted') {
    browserNotificationsEnabled = true;
    updateNotifButton('enabled');
  } else if (notifPermission === 'denied') {
    updateNotifButton('denied');
  } else {
    updateNotifButton('disabled');
  }
}

function toggleBrowserNotifications() {
  // Unlock AudioContext on this user gesture
  try { const ctx = getAudioContext(); if (ctx.state === "suspended") ctx.resume(); } catch(e) {}
  // Also unlock HTML audio elements
  try { ["sosAlertAudio","sirenAlertAudio"].forEach(id => { const el = document.getElementById(id); if (el) { el.play().then(() => el.pause()).catch(() => {}); }}); } catch(e) {}
  if (!('Notification' in window)) {
    showToast('❌ Your browser does not support notifications', 'error');
    return;
  }

  if (browserNotificationsEnabled) {
    // Disable
    browserNotificationsEnabled = false;
    updateNotifButton('disabled');
    showToast('🔕 Browser notifications disabled', 'info');
    return;
  }

  // Request permission
  if (notifPermission === 'denied') {
    showToast('⚠️ Notifications blocked. Please enable them in your browser settings.', 'warning');
    return;
  }

  Notification.requestPermission().then(permission => {
    notifPermission = permission;
    if (permission === 'granted') {
      browserNotificationsEnabled = true;
      updateNotifButton('enabled');
      showToast('🔔 Browser notifications enabled', 'success');
      // Send a test notification
      sendBrowserNotification('Talion Dispatch', 'Notifications are now active. You will be alerted of critical events.', 'info');
    } else {
      updateNotifButton('denied');
      showToast('⚠️ Notification permission denied', 'warning');
    }
  });
}

function updateNotifButton(state) {
  const btn = document.getElementById('btnNotifToggle');
  if (!btn) return;
  switch (state) {
    case 'enabled':
      btn.textContent = '🔔 Notifications ON';
      btn.style.background = '#059669';
      btn.style.color = '#fff';
      btn.style.borderColor = '#059669';
      break;
    case 'disabled':
      btn.textContent = '🔕 Notifications OFF';
      btn.style.background = 'transparent';
      btn.style.color = '#94a3b8';
      btn.style.borderColor = '#334155';
      break;
    case 'denied':
      btn.textContent = '🚫 Notifications Blocked';
      btn.style.background = 'transparent';
      btn.style.color = '#f87171';
      btn.style.borderColor = '#7f1d1d';
      break;
    case 'unsupported':
      btn.textContent = '❌ Not Supported';
      btn.style.background = 'transparent';
      btn.style.color = '#6b7280';
      btn.style.borderColor = '#374151';
      btn.disabled = true;
      break;
  }
}

function sendBrowserNotification(title, body, severity, tag) {
  if (!browserNotificationsEnabled || notifPermission !== 'granted') return;
  
  // Don't send if tab is focused (user already sees the toast)
  if (document.hasFocus()) return;

  const iconMap = {
    critical: '🆘', high: '🔥', medium: '⚠️', low: 'ℹ️', 
    info: 'ℹ️', success: '✅', warning: '⚠️', error: '🚨'
  };
  const icon = iconMap[severity] || '📢';

  try {
    const notif = new Notification(`${icon} ${title}`, {
      body: body,
      tag: tag || `talion-dispatch-${Date.now()}`,
      icon: '/admin-console/favicon.ico',
      badge: '/admin-console/favicon.ico',
      requireInteraction: severity === 'critical' || severity === 'high',
      silent: false,
    });

    // Click on notification focuses the console tab
    notif.onclick = () => {
      window.focus();
      notif.close();
    };

    // Auto-close after 10s for non-critical
    if (severity !== 'critical' && severity !== 'high') {
      setTimeout(() => notif.close(), 10000);
    }
  } catch (e) {
    console.warn('[Notif] Failed to send:', e);
  }
}

// Initialize on load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBrowserNotifications);
} else {
  initBrowserNotifications();
}


// ═══════════════════════════════════════════════════════════
// THEME TOGGLE — Dark / Light mode
// ═══════════════════════════════════════════════════════════
(function initTheme() {
  const saved = localStorage.getItem('talion-dispatch-theme');
  if (saved === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else if (saved === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    // Auto-detect system preference; default is dark
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      document.documentElement.setAttribute('data-theme', 'light');
    }
  }
  updateThemeButton();

  // Listen for system theme changes when no manual preference set
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
      if (!localStorage.getItem('talion-dispatch-theme')) {
        if (e.matches) {
          document.documentElement.setAttribute('data-theme', 'light');
        } else {
          document.documentElement.removeAttribute('data-theme');
        }
        updateThemeButton();
      }
    });
  }
})();

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  if (isLight) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('talion-dispatch-theme', 'dark');
  } else {
    document.documentElement.setAttribute('data-theme', 'light');
    localStorage.setItem('talion-dispatch-theme', 'light');
  }
  updateThemeButton();

  // Re-invalidate map tiles if map exists
  if (typeof dispatchMap !== 'undefined' && dispatchMap) {
    // Switch map tile layer for better contrast
    setTimeout(() => {
      dispatchMap.invalidateSize();
      updateMapTileLayer();
    }, 100);
  }
}

function updateThemeButton() {
  const btn = document.getElementById('btnThemeToggle');
  if (!btn) return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  btn.textContent = isLight ? '🌙 Dark' : '☀️ Light';
  btn.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
}

// Swap map tile layer based on theme
function updateMapTileLayer() {
  if (typeof dispatchMap === 'undefined' || !dispatchMap) return;
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  // Remove existing tile layers
  dispatchMap.eachLayer((layer) => {
    if (layer._url && typeof layer._url === 'string' && layer._url.includes('tile')) {
      dispatchMap.removeLayer(layer);
    }
  });
  // Add appropriate tile layer
  const tileUrl = isLight
    ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  L.tileLayer(tileUrl, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  }).addTo(dispatchMap);
}

// ─── Incident Detail Modal ──────────────────────────────────
let detailMiniMap = null;
let detailMarker = null;
let detailCircle = null;
let detailNearbyMarkers = [];
let currentDetailIncidentId = null;
let nearbyRadiusDebounceTimer = null;

async function openDetailModal(incidentId) {
  const modal = document.getElementById('detailModal');
  
  // Try to get full details from server
  let inc = null;
  try {
    const res = await fetch(`${API_BASE}/alerts/${encodeURIComponent(incidentId)}`);
    if (res.ok) {
      inc = await res.json();
      // Cache for ETA calculation
      if (!window._cachedAlerts) window._cachedAlerts = [];
      const idx = window._cachedAlerts.findIndex(a => a.id === inc.id);
      if (idx >= 0) window._cachedAlerts[idx] = inc; else window._cachedAlerts.push(inc);
    }
  } catch (e) {
    console.warn('[Detail] Failed to fetch from /alerts/', e);
  }
  
  // Fallback: also try admin endpoint
  if (!inc) {
    try {
      const res = await fetch(`${API_BASE}/admin/incidents`);
      if (res.ok) {
        const all = await res.json();
        inc = all.find(i => i.id === incidentId);
      }
    } catch (e) {
      console.warn('[Detail] Failed to fetch from /admin/incidents', e);
    }
  }
  
  // Last fallback: use local data
  if (!inc) {
    inc = incidents.find(i => i.id === incidentId);
  }
  
  if (!inc) {
    showToast('Could not load incident details', 'error');
    return;
  }
  
  // Populate header
  document.getElementById('detailTypeIcon').textContent = TYPE_ICONS[inc.type] || '🚨';
  document.getElementById('detailTitle').textContent = `${typeLabel(inc.type)} — Incident`;
  document.getElementById('detailId').textContent = formatIncidentId(inc.id);
  
  // Badges
  const severity = inc.severity || 'medium';
  const status = inc.status || 'active';
  document.getElementById('detailBadges').innerHTML = `
    ${inc.isDuress ? '<div class="duress-banner">🔴 CODE DE CONTRAINTE — le SOS a été "annulé" sous la contrainte, menace réelle probable</div>' : ''}
    <span class="badge badge-${severity}">${sevLabel(severity)}</span>
    <span class="badge badge-${status}">${statusLabel(status)}</span>
    ${inc.type === 'sos' ? '<span class="badge badge-critical">SOS URGENCE</span>' : ''}
  `;

  // Duplicate suggestions / confirmed links
  const dupSection = document.getElementById('detailDuplicatesSection');
  const dupContent = document.getElementById('detailDuplicatesContent');
  const dups = inc.possibleDuplicates || [];
  const linked = inc.linkedIncidentIds || [];
  if (dups.length > 0 || linked.length > 0) {
    dupSection.style.display = 'block';
    dupContent.innerHTML = `
      ${linked.length > 0 ? `<div class="inc-linked">🔗 Lié à: ${linked.map(id => `<span class="linked-chip" onclick="openDetailModal('${id}')">${formatIncidentId(id)}</span>`).join('')}</div>` : ''}
      ${renderDuplicateSuggestions(inc)}
    `;
  } else {
    dupSection.style.display = 'none';
    dupContent.innerHTML = '';
  }

  // Location info
  const lat = inc.location?.latitude || inc.latitude || 0;
  const lng = inc.location?.longitude || inc.longitude || 0;
  const address = inc.location?.address || inc.address || 'Unknown location';
  const hasValidLocation = lat !== 0 || lng !== 0;
  
  document.getElementById('detailAddress').innerHTML = `📍 ${address}`;
  document.getElementById('detailCoords').textContent = hasValidLocation 
    ? `${lat.toFixed(6)}, ${lng.toFixed(6)}` 
    : 'No GPS coordinates available';
  
  // Info grid
  document.getElementById('detailReportedBy').textContent = inc.createdBy || inc.reportedBy || 'Unknown';

  // Load client context (profile, addresses, family, location detection)
  const clientSection = document.getElementById('detailClientSection');
  const clientProfile = document.getElementById('detailClientProfile');
  if (clientSection && clientProfile) {
    clientSection.style.display = 'none';
    clientProfile.innerHTML = '<div style="color:#6b7280;font-size:13px;">Chargement du profil...</div>';
    try {
      const ctxRes = await fetch(`${API_BASE}/api/alerts/${encodeURIComponent(incidentId)}/context`);
      if (ctxRes.ok) {
        const ctx = await ctxRes.json();
        if (ctx.user) {
          clientSection.style.display = 'block';
          const u = ctx.user;
          const loc = ctx.locationContext;
          
          // Location context badge
          let locBadge = '';
          if (loc) {
            if (loc.isHomeJacking) {
              locBadge = `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 12px;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">🏠</span>
                <div>
                  <div style="font-weight:700;color:#dc2626;font-size:13px;">⚠️ ALERTE POSSIBLE HOME-JACKING <span style="font-weight:500;font-size:9px;color:#b91c1c;text-transform:none;">(au moment du signalement)</span></div>
                  <div style="font-size:11px;color:#991b1b;">${loc.label} · ${loc.distanceMeters}m · Possible home-jacking</div>
                  ${loc.alarmCode ? `<div style="font-size:11px;color:#991b1b;margin-top:2px;">🔑 Code alarme: <strong>${loc.alarmCode}</strong></div>` : ''}
                </div>
              </div>`;
            } else {
              locBadge = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">📍</span>
                <div>
                  <div style="font-weight:700;color:#16a34a;font-size:13px;">HORS DOMICILE <span style="font-weight:500;font-size:9px;color:#15803d;">(au moment du signalement)</span></div>
                  <div style="font-size:11px;color:#15803d;">${loc.label} · ${loc.distanceMeters}m du domicile connu</div>
                </div>
              </div>`;
            }
          }

          // Occupancy banner — surfaces if the matched residence was marked
          // "inoccupée" (family away), a signal worth extra vigilance on scene.
          let occupancyBadge = '';
          if (ctx.residenceContext?.occupancyStatus === 'unoccupied') {
            occupancyBadge = `<div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:8px 12px;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
              <span style="font-size:18px;">🚪</span>
              <div style="font-weight:700;color:#b45309;font-size:13px;">⚠️ Résidence actuellement inoccupée</div>
            </div>`;
          }

          // Client info
          const phone = u.phoneMobile || u.phone || '';
          const photoHtml = u.photoUrl 
            ? `<img src="${u.photoUrl}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid #e5e7eb;">` 
            : `<div style="width:48px;height:48px;border-radius:50%;background:#1e3a5f;display:flex;align-items:center;justify-content:center;color:white;font-weight:700;font-size:18px;">${(u.firstName||u.name||'?')[0]}</div>`;

          // Addresses
          const addrsHtml = (ctx.addresses || []).map(a => `
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:#374151;margin-top:4px;">
              <span>${a.isPrimary ? '🏠' : '🏡'}</span>
              <span>${a.label}: ${a.address}</span>
              ${a.alarmCode ? `<span style="color:#6b7280;">· 🔑 ${a.alarmCode}</span>` : ''}
            </div>`).join('');

          // Family
          const presenceBadgeHtml = (p) => {
            if (!p || p.status === 'unknown') return `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:#f3f4f6;color:#6b7280;">❓ INCONNU</span>`;
            const color = p.status === 'inside' ? '#22c55e' : '#f59e0b';
            const label = p.status === 'inside'
              ? `PRÉSENT${p.matchedLabel ? ' — ' + escapeHtml(p.matchedLabel) : ''}`
              : `SORTI${p.matchedLabel ? ' DE ' + escapeHtml(p.matchedLabel).toUpperCase() : ''}`;
            const since = p.setAt ? ` · depuis ${formatTimeAgo(p.setAt)}` : '';
            return `<span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;background:${color}20;color:${color};">${p.status === 'inside' ? '🏠' : '🚶'} ${label}</span><span style="font-size:10px;color:#9ca3af;margin-left:4px;">${since}</span>`;
          };

          const familyHtml = (ctx.family || []).filter(Boolean).map(f => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6;">
              <div style="width:32px;height:32px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:14px;">
                ${f.photoUrl ? `<img src="${f.photoUrl}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">` : '👤'}
              </div>
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#1f2937;">${f.name}</div>
                <div style="font-size:11px;color:#6b7280;">${f.role}</div>
                <div style="margin-top:3px;">${presenceBadgeHtml(f.presence)}</div>
              </div>
              ${f.phone ? `<a href="tel:${f.phone}" style="font-size:12px;color:#1e3a5f;font-weight:600;text-decoration:none;">📞 ${f.phone}</a>` : ''}
            </div>`).join('');

          clientProfile.innerHTML = `
            ${locBadge}
            ${occupancyBadge}
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
              ${photoHtml}
              <div style="flex:1;">
                <div style="font-weight:700;font-size:15px;color:#1f2937;">${u.firstName || ''} ${u.lastName || u.name || ''}</div>
                ${phone ? `<a href="tel:${phone}" style="font-size:13px;color:#1e3a5f;font-weight:600;text-decoration:none;">📞 ${phone}</a>` : ''}
                <div style="margin-top:4px;">${presenceBadgeHtml(ctx.reporterPresence)} <span style="font-size:9px;color:#9ca3af;">(en direct maintenant)</span></div>
              </div>
            </div>
            ${addrsHtml ? `<div style="margin-bottom:10px;">${addrsHtml}</div>` : ''}
            ${familyHtml ? `<div><div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Famille <span style="text-transform:none;font-weight:500;">(statut en direct)</span></div>${familyHtml}</div>` : ''}
          `;
        }
      }
    } catch(e) { console.error('Failed to load client context:', e); }
  }
  document.getElementById('detailCreatedAt').textContent = formatDateTime(inc.createdAt || inc.timestamp || Date.now());
  document.getElementById('detailStatus').innerHTML = `<span class="badge badge-${status}">${status.toUpperCase()}</span>`;
  document.getElementById('detailSeverity').innerHTML = `<span class="badge badge-${severity}">${severity.toUpperCase()}</span>`;
  
  // Description
  const descSection = document.getElementById('detailDescSection');
  const desc = inc.description || '';
  if (desc) {
    descSection.style.display = 'block';
    document.getElementById('detailDescription').textContent = desc;
  } else {
    descSection.style.display = 'none';
  }
  
  // Responding units
  const respSection = document.getElementById('detailRespondersSection');
  const respondingDetails = inc.respondingDetails || [];
  const respondingUsers = inc.respondingUsers || [];
  
  const incIdForUnassign = inc.id;
  const incStatusForUnassign = status;
  // Get incident coordinates for ETA calculation — `inc` here is the full
  // alert fetched from /alerts/:id, so its own location is authoritative.
  let incLat = null, incLng = null;
  try {
    if (inc.location) {
      incLat = inc.location.latitude;
      incLng = inc.location.longitude;
    } else {
      const cachedAlerts = window._cachedAlerts || [];
      const alertData = cachedAlerts.find(a => a.id === inc.id);
      if (alertData && alertData.location) {
        incLat = alertData.location.latitude;
        incLng = alertData.location.longitude;
      }
    }
  } catch(e) {}

  const intStatusLabels = { assigned: 'Assign\u00e9', accepted: 'Accept\u00e9', en_route: 'En route', on_scene: 'Sur place' };
  const intStatusEmojis = { assigned: '\ud83d\udd14', accepted: '\u2705', en_route: '\ud83d\ude97', on_scene: '\ud83d\udccd' };
  const intStatusColors = { assigned: '#f59e0b', accepted: '#22c55e', en_route: '#3b82f6', on_scene: '#ef4444' };

  function buildResponderRow(rId, rName, rStatus, rIntStatus, rLocation) {
    const intSt = rIntStatus || 'assigned';
    const intColor = intStatusColors[intSt] || '#6b7280';
    const intEmoji = intStatusEmojis[intSt] || '\u26aa';
    const intLabel = intStatusLabels[intSt] || intSt;
    let etaHtml = '';
    if (rLocation && incLat && incLng && intSt !== 'on_scene') {
      const dist = haversineDistance(rLocation.latitude, rLocation.longitude, incLat, incLng);
      const eta = estimateETA(dist);
      etaHtml = `<div style="font-size:10px;color:#60a5fa;margin-top:2px;">\ud83d\udccf ${formatDistance(dist)} \u2014 \u23f1 ETA: ${eta}</div>`;
    } else if (intSt === 'on_scene') {
      etaHtml = `<div style="font-size:10px;color:#22c55e;margin-top:2px;">\u2705 Sur place</div>`;
    }
    return `
      <div class="detail-resp-item" style="flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;">
          <div style="width:8px;height:8px;border-radius:50%;background:${intColor};flex-shrink:0;"></div>
          <div style="min-width:0;">
            <div class="detail-resp-name">${rName}</div>
            <div style="display:flex;align-items:center;gap:4px;margin-top:2px;">
              <span style="font-size:10px;">${intEmoji}</span>
              <span style="font-size:10px;font-weight:600;color:${intColor};">${intLabel}</span>
            </div>
            ${etaHtml}
          </div>
        </div>
        ${incStatusForUnassign !== 'resolved' ? `<button class="btn btn-danger btn-sm" style="margin-left:auto;font-size:10px;padding:2px 8px;flex-shrink:0;" onclick="closeDetailModal(); unassignResponder('${incIdForUnassign}', '${rId}')">❌</button>` : ''}
      </div>`;
  }

  if (respondingDetails.length > 0) {
    respSection.style.display = 'block';
    document.getElementById('detailResponders').innerHTML = respondingDetails.map(r => {
      // Find responder location from cached data
      const respObj = responders.find(x => x.id === (r.userId || r.id));
      const rLocation = respObj?.location || null;
      const rIntStatus = r.interventionStatus || r.responderStatus || 'assigned';
      return buildResponderRow(r.userId || r.id, r.name || r.id, r.status, rIntStatus, rLocation);
    }).join('');
  } else if (respondingUsers.length > 0) {
    respSection.style.display = 'block';
    document.getElementById('detailResponders').innerHTML = respondingUsers.map(uid => {
      const respObj = responders.find(x => x.id === uid);
      const rName = respObj?.name || uid;
      const rLocation = respObj?.location || null;
      // Try to get intervention status from responder's assigned incidents
      const rIntStatus = respObj?.assignedIncidents?.find(ai => ai.id === inc.id)?.responderStatus || 'assigned';
      return buildResponderRow(uid, rName, 'unknown', rIntStatus, rLocation);
    }).join('');
  } else {
    respSection.style.display = 'block';
    document.getElementById('detailResponders').innerHTML = '<p class="detail-no-resp">Aucune unit\u00e9 assign\u00e9e</p>';
  }
  
  // Photos
  const photosSection = document.getElementById('detailPhotosSection');
  const photosContainer = document.getElementById('detailPhotos');
  const photos = inc.photos || [];
  if (photos.length > 0) {
    photosSection.style.display = 'block';
    photosContainer.innerHTML = photos.map(url => {
      const fullUrl = url.startsWith('http') ? url : `${API_BASE}${url}`;
      return `<a href="${fullUrl}" target="_blank" class="detail-photo-link"><img src="${fullUrl}" class="detail-photo-img" alt="Photo alerte" /></a>`;
    }).join('');
  } else {
    photosSection.style.display = 'none';
  }

  // Status History Timeline
  const historySection = document.getElementById('detailHistorySection');
  const historyContainer = document.getElementById('detailStatusHistory');
  const statusHistory = inc.statusHistory || [];
  if (statusHistory.length > 0) {
    historySection.style.display = 'block';
    const STATUS_ICONS = { assigned: '\u{1F4CB}', accepted: '\u2705', en_route: '\u{1F697}', on_scene: '\u{1F4CD}' };
    const STATUS_LABELS_FR = { assigned: 'Assign\u00e9', accepted: 'Accept\u00e9', en_route: 'En route', on_scene: 'Sur place' };
    const STATUS_COLORS = { assigned: '#6b7280', accepted: '#3b82f6', en_route: '#f59e0b', on_scene: '#22c55e' };
    historyContainer.innerHTML = statusHistory.map(entry => {
      const icon = STATUS_ICONS[entry.status] || '\u26A0';
      const label = STATUS_LABELS_FR[entry.status] || entry.status;
      const color = STATUS_COLORS[entry.status] || '#6b7280';
      const time = new Date(entry.timestamp);
      const timeStr = time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const dateStr = time.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      return `<div class="timeline-entry">
        <div class="timeline-dot" style="background:${color}"></div>
        <div class="timeline-content">
          <div class="timeline-header">
            <span class="timeline-icon">${icon}</span>
            <strong class="timeline-label" style="color:${color}">${label}</strong>
            <span class="timeline-time">${dateStr} ${timeStr}</span>
          </div>
          <div class="timeline-name">${entry.responderName || entry.responderId}</div>
        </div>
      </div>`;
    }).join('');
  } else {
    historySection.style.display = 'none';
  }

  // Actions
  const actionsHtml = [];
  if (status === 'active') {
    actionsHtml.push(`<button class="btn btn-warning" onclick="closeDetailModal(); acknowledgeIncident('${inc.id}')">\u2705 Acquitter</button>`);
  }
  if (status !== 'resolved') {
    actionsHtml.push(`<button class="btn btn-primary" onclick="closeDetailModal(); openAssignModal('${inc.id}')">\ud83d\udc6e Assigner Unit\u00e9</button>`);
    actionsHtml.push(`<button class="btn btn-success" onclick="closeDetailModal(); openResolveModal('${inc.id}')">\ud83c\udfc1 R\u00e9soudre</button>`);
  }
  // Navigate button (opens Google Maps directions)
  const navLat = inc.location?.latitude || inc.latitude || 0;
  const navLng = inc.location?.longitude || inc.longitude || 0;
  if (navLat !== 0 || navLng !== 0) {
    actionsHtml.push(`<button class="btn btn-info" onclick="window.open('https://www.google.com/maps/dir/?api=1&destination=${navLat},${navLng}', '_blank')">\ud83e\udded Navigate</button>`);
  }
  if (status === 'resolved') {
    actionsHtml.push(`<button class="btn btn-secondary" onclick="closeDetailModal()">Close</button>`);
  }
  actionsHtml.push(inc.archived
    ? `<button class="btn btn-primary" onclick="unarchiveIncident('${inc.id}')">Désarchiver</button>`
    : `<button class="btn btn-secondary" onclick="archiveIncident('${inc.id}')">🗄️ Archiver</button>`);
  actionsHtml.push(`<button class="btn btn-danger" onclick="deleteIncident('${inc.id}')">🗑️ Supprimer</button>`);
  document.getElementById('detailActions').innerHTML = actionsHtml.join('');
  
  // Show modal
  modal.classList.add('active');

  // Nearby users panel — resets to the 200m default each time a (possibly different)
  // incident is opened; the dispatcher can then widen/narrow it live.
  currentDetailIncidentId = inc.id;
  const nearbySection = document.getElementById('detailNearbySection');
  const nearbyRadiusInput = document.getElementById('detailNearbyRadius');
  if (nearbySection && nearbyRadiusInput) {
    nearbySection.style.display = hasValidLocation ? 'block' : 'none';
    nearbyRadiusInput.value = 200;
  }

  // Initialize or update mini map after modal is visible
  setTimeout(() => {
    initDetailMiniMap(lat, lng, hasValidLocation, severity, 200);
    if (hasValidLocation) loadNearbyUsers(inc.id, 200);
  }, 150);
}

// Fetch civilian users within `radius` meters of the open incident, render the list,
// and mirror the radius onto the mini-map's dashed circle + add a marker per user.
async function loadNearbyUsers(incidentId, radius) {
  const listEl = document.getElementById('detailNearbyUsersList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="nearby-users-empty">Recherche…</div>';
  try {
    const res = await fetch(`${API_BASE}/dispatch/incidents/${encodeURIComponent(incidentId)}/nearby-users?radius=${radius}`);
    if (!res.ok) throw new Error('request failed');
    const data = await res.json();
    // Stale response from a previous incident/radius that resolved late — ignore it.
    if (incidentId !== currentDetailIncidentId) return;
    renderNearbyUsers(data.users || []);
  } catch (e) {
    console.warn('[Nearby] Failed to load nearby users:', e);
    listEl.innerHTML = '<div class="nearby-users-empty">Erreur de chargement</div>';
  }
}

function renderNearbyUsers(usersList) {
  const listEl = document.getElementById('detailNearbyUsersList');
  if (!listEl) return;

  // Clear previous per-user markers from the mini map
  detailNearbyMarkers.forEach(m => { if (detailMiniMap) detailMiniMap.removeLayer(m); });
  detailNearbyMarkers = [];

  if (usersList.length === 0) {
    listEl.innerHTML = '<div class="nearby-users-empty">Aucun utilisateur dans ce rayon</div>';
    return;
  }

  listEl.innerHTML = usersList.map(u => {
    const distLabel = u.distanceMeters < 1000 ? `${u.distanceMeters} m` : `${(u.distanceMeters / 1000).toFixed(1)} km`;
    return `<div class="nearby-user-row" onclick="openUserProfile('${u.id}', '${escapeHtml(u.name).replace(/'/g, "\\'")}')">
      <span>${u.role === 'user' ? '\u{1F464}' : '\u{1F46E}'}</span>
      <span class="nearby-user-name">${escapeHtml(u.name)}</span>
      <span class="nearby-user-dist">${distLabel}</span>
    </div>`;
  }).join('');

  if (detailMiniMap) {
    usersList.forEach(u => {
      if (!u.location) return;
      const marker = L.circleMarker([u.location.latitude, u.location.longitude], {
        radius: 6, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 0.9,
      }).addTo(detailMiniMap).bindTooltip(u.name, { direction: 'top', offset: [0, -4] });
      detailNearbyMarkers.push(marker);
    });
  }
}

function adjustNearbyRadius(delta) {
  const input = document.getElementById('detailNearbyRadius');
  if (!input) return;
  const min = parseFloat(input.min) || 50;
  const max = parseFloat(input.max) || 5000;
  const next = Math.min(max, Math.max(min, (parseFloat(input.value) || 200) + delta));
  input.value = next;
  onNearbyRadiusChange();
}

function onNearbyRadiusChange() {
  const input = document.getElementById('detailNearbyRadius');
  if (!input || !currentDetailIncidentId) return;
  const min = parseFloat(input.min) || 50;
  const max = parseFloat(input.max) || 5000;
  let radius = parseFloat(input.value) || 200;
  radius = Math.min(max, Math.max(min, radius));
  if (detailCircle) detailCircle.setRadius(radius);

  clearTimeout(nearbyRadiusDebounceTimer);
  const incidentId = currentDetailIncidentId;
  nearbyRadiusDebounceTimer = setTimeout(() => {
    loadNearbyUsers(incidentId, radius);
  }, 350);
}

function initDetailMiniMap(lat, lng, hasValidLocation, severity, radius) {
  const mapEl = document.getElementById('detailMiniMap');
  if (!mapEl) return;
  
  // Destroy previous map instance
  if (detailMiniMap) {
    detailMiniMap.remove();
    detailMiniMap = null;
    detailMarker = null;
    detailCircle = null;
  }
  
  if (!hasValidLocation) {
    mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:13px;">No GPS coordinates available</div>';
    return;
  }
  
  // Create map
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  detailMiniMap = L.map(mapEl, {
    center: [lat, lng],
    zoom: 15,
    zoomControl: false,
    attributionControl: false,
    dragging: true,
    scrollWheelZoom: true,
  });
  
  const tileUrl = isLight
    ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
  L.tileLayer(tileUrl, { subdomains: 'abcd', maxZoom: 19 }).addTo(detailMiniMap);
  
  // Add marker
  const sevColors = { critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#6b7280' };
  const color = sevColors[severity] || '#3b82f6';
  
  detailMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        width:32px;height:32px;border-radius:50%;
        background:${color};border:3px solid rgba(255,255,255,0.9);
        box-shadow:0 2px 8px rgba(0,0,0,0.4);
        display:flex;align-items:center;justify-content:center;
        font-size:16px;color:#fff;font-weight:700;
        animation: pulse-marker 2s infinite;
      ">!</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    })
  }).addTo(detailMiniMap);
  
  // Add radius circle (kept in sync with the "Utilisateurs à proximité" radius control)
  detailCircle = L.circle([lat, lng], {
    radius: radius || 200,
    color: color,
    fillColor: color,
    fillOpacity: 0.12,
    weight: 2,
    dashArray: '6 4',
  }).addTo(detailMiniMap);
}

function closeDetailModal() {
  document.getElementById('detailModal').classList.remove('active');
  currentDetailIncidentId = null;
  clearTimeout(nearbyRadiusDebounceTimer);
  // Clean up map after animation
  setTimeout(() => {
    if (detailMiniMap) {
      detailMiniMap.remove();
      detailMiniMap = null;
      detailMarker = null;
      detailCircle = null;
      detailNearbyMarkers = [];
    }
  }, 300);
}


// ═══════════════════════════════════════════════════════════
// MESSAGING SYSTEM
// ═══════════════════════════════════════════════════════════

// Was a hardcoded shared identity ('Jean Moreau — dispatcher') used for
// every dispatcher regardless of who's actually logged in — the server now
// verifies and derives the real sender from the session token on every
// messaging route, so a stale/fake id here would silently mismatch and
// break "is this my message" bubble styling. Reads the real logged-in
// user set at login (server/console-login), same source admin-web uses.
function currentDispatchUser() {
  try { return JSON.parse(localStorage.getItem('talion_user') || '{}'); } catch (e) { return {}; }
}
let msgConversations = [];
let msgCurrentConvId = null;
let msgCurrentMessages = [];
let msgUsers = [];
let msgAvailableTags = [];
let msgPollTimer = null;
let msgConvPollTimer = null;
let newConvSelectedUsers = new Set();
let newConvSelectedRole = null;
let newConvSelectedTags = new Set();

// ─── Fetch Helpers ──────────────────────────────────────────

async function msgFetch(path, opts = {}) {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      ...opts,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error(`[MSG] fetch ${path} failed:`, e);
    return null;
  }
}

// ─── Load Data ──────────────────────────────────────────────

async function loadMsgUsers() {
  const data = await msgFetch('/api/messaging/users');
  if (data) {
    msgUsers = data.users || [];
    // Collect all tags
    const tagSet = new Set();
    msgUsers.forEach(u => (u.tags || []).forEach(t => tagSet.add(t)));
    msgAvailableTags = [...tagSet].sort();
  }
}

async function loadConversations() {
  // No userId -> every conversation in the caller's own organization,
  // matching what the shared fake identity used to achieve in practice
  // (it was a participant in every dispatch-initiated conversation).
  const data = await msgFetch('/api/messaging/conversations');
  if (data) {
    msgConversations = data.conversations || [];
    renderConversationList();
  }
}

let isAudioPlaying = false;
let isVideoPlaying = false;

async function loadMessages(convId) {
  if (isAudioPlaying || isVideoPlaying) return; // Ne pas recharger pendant la lecture audio
  const data = await msgFetch(`/api/messaging/conversations/${convId}/messages`);
  if (data) {
    msgCurrentMessages = data.messages || [];
    renderMessages();
  }
}

// ─── Render Conversation List ───────────────────────────────

function renderConversationList() {
  const list = document.getElementById('msgConvList');
  const search = (document.getElementById('msgSearchInput')?.value || '').toLowerCase();

  const filtered = msgConversations.filter(c => {
    const name = getConvDisplayName(c).toLowerCase();
    return name.includes(search);
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="msg-empty">No conversations yet. Click + New to start.</div>';
    return;
  }

  // Sort by last message time
  filtered.sort((a, b) => new Date(b.lastMessageAt || b.createdAt) - new Date(a.lastMessageAt || a.createdAt));

  list.innerHTML = filtered.map(c => {
    const name = getConvDisplayName(c);
    const isResidence = c.type === 'residence';
    const isGroup = c.type === 'group';
    const avatarColor = isResidence ? '#22c55e' : isGroup ? '#8b5cf6' : '#3b82f6';
    const avatarText = isResidence ? '\u{1F3E0}' : isGroup ? (name.charAt(0) || 'G') : (name.charAt(0) || '?');
    const time = c.lastMessageAt ? formatMsgTime(c.lastMessageAt) : '';
    const preview = c.lastMessage || (isGroup || isResidence ? `${c.participants?.length || 0} members` : 'No messages yet');
    const active = c.id === msgCurrentConvId ? 'active' : '';
    const typeBadge = isResidence
      ? `<span class="msg-conv-badge" style="background:rgba(34,197,94,0.15);color:#22c55e;">residence</span>`
      : isGroup
      ? `<span class="msg-conv-badge" style="background:rgba(139,92,246,0.15);color:#8b5cf6;">${c.groupType || 'group'}</span>`
      : `<span class="msg-conv-badge" style="background:rgba(59,130,246,0.15);color:#60a5fa;">direct</span>`;

    return `
      <div class="msg-conv-item ${active}" onclick="selectConversation('${c.id}')">
        <div class="msg-conv-avatar" style="background:${avatarColor}">${avatarText}</div>
        <div class="msg-conv-content">
          <div class="msg-conv-header">
            <div class="msg-conv-name">${escapeHtml(name)}</div>
            <div class="msg-conv-time">${time}</div>
          </div>
          <div class="msg-conv-preview">${escapeHtml(preview)}</div>
          <div class="msg-conv-badges">${typeBadge}</div>
        </div>
      </div>
    `;
  }).join('');
}

function getConvDisplayName(conv) {
  if (conv.type === 'group' || conv.type === 'residence') return conv.name || 'Group';
  // Direct: find the other participant
  const other = (conv.participants || []).find(p => p !== currentDispatchUser().id);
  if (other) {
    const user = msgUsers.find(u => u.id === other);
    return user ? user.name : other;
  }
  return conv.name || 'Unknown';
}

function formatMsgTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ─── Select Conversation ────────────────────────────────────

async function selectConversation(convId) {
  msgCurrentConvId = convId;
  renderConversationList(); // highlight active

  const conv = msgConversations.find(c => c.id === convId);
  if (!conv) return;

  // Show chat area
  document.getElementById('msgChatPlaceholder').style.display = 'none';
  document.getElementById('msgChatHeader').style.display = 'flex';
  document.getElementById('msgMessages').style.display = 'flex';
  document.getElementById('msgInputArea').style.display = 'flex';

  // Update header
  const name = getConvDisplayName(conv);
  const isResidence = conv.type === 'residence';
  const isGroup = conv.type === 'group';
  const avatarColor = isResidence ? '#22c55e' : isGroup ? '#8b5cf6' : '#3b82f6';
  document.getElementById('msgChatAvatar').style.background = avatarColor;
  document.getElementById('msgChatAvatar').textContent = isResidence ? '\u{1F3E0}' : (name.charAt(0) || '?');
  document.getElementById('msgChatName').textContent = name;
  document.getElementById('msgChatMeta').textContent = isResidence
    ? `${conv.participants?.length || 0} members | residence`
    : isGroup
    ? `${conv.participants?.length || 0} members | ${conv.groupType || 'group'}`
    : 'Direct message';

  // Load messages
  await loadMessages(convId);

  // Start message polling
  clearInterval(msgPollTimer);
  msgPollTimer = setInterval(() => loadMessages(convId), 3000);
}

// ─── Render Messages ────────────────────────────────────────

function renderMessages() {
  const container = document.getElementById('msgMessages');
  if (!msgCurrentMessages.length) {
    container.innerHTML = '<div class="msg-empty" style="padding:60px 20px;">No messages yet. Send the first message!</div>';
    return;
  }

  container.innerHTML = msgCurrentMessages.map(m => {
    const isMine = m.senderId === currentDispatchUser().id;
    const sender = msgUsers.find(u => u.id === m.senderId);
    const senderName = sender ? sender.name : (m.senderName || m.senderId);
    const senderInitial = senderName.charAt(0) || '?';
    const avatarColor = isMine ? '#1e3a5f' : getRoleColor(sender?.role);
    const time = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (m.type === 'system') {
      return `<div class="msg-bubble-row" style="justify-content:center;">
        <div class="msg-bubble" style="background:var(--bg-chip);color:var(--text-muted);font-size:12px;text-align:center;max-width:80%;border-radius:12px;">
          ${escapeHtml(m.content)} <span style="opacity:0.6;font-size:10px;">${time}</span>
        </div>
      </div>`;
    }

    // Contenu selon le type de message
    let msgContent = '';
    const apiBase = window.location.origin;
    if (m.type === 'image' && m.mediaUrl) {
      const imgUrl = m.mediaUrl.startsWith('http') ? m.mediaUrl : apiBase + m.mediaUrl;
      msgContent = `<a href="${imgUrl}" target="_blank"><img src="${imgUrl}" style="max-width:220px;max-height:180px;border-radius:8px;display:block;cursor:pointer;" /></a>`;
    } else if (m.type === 'document' && m.mediaUrl) {
      const docUrl = m.mediaUrl.startsWith('http') ? m.mediaUrl : apiBase + m.mediaUrl;
      const fileName = m.content || m.text || 'Document';
      msgContent = `<a href="${docUrl}" target="_blank" style="color:inherit;text-decoration:none;display:flex;align-items:center;gap:6px;"><span style="font-size:20px;">📎</span><span style="text-decoration:underline;">${escapeHtml(fileName.replace('📎 ',''))}</span></a>`;
    } else if (m.type === 'video' && m.mediaUrl) {
      const videoUrl = m.mediaUrl.startsWith('http') ? m.mediaUrl : apiBase + m.mediaUrl;
      msgContent = `<video controls style="max-width:280px;max-height:200px;border-radius:8px;display:block;" src="${videoUrl}" onplay="isVideoPlaying=true" onended="isVideoPlaying=false" onpause="isVideoPlaying=false"></video>`;
    } else if (m.type === 'audio' && m.mediaUrl) {
      const audioUrl = m.mediaUrl.startsWith('http') ? m.mediaUrl : apiBase + m.mediaUrl;
      msgContent = `<audio controls style="max-width:200px;" onplay="isAudioPlaying=true" onended="isAudioPlaying=false" onpause="isAudioPlaying=false"><source src="${audioUrl}" /></audio>`;
    } else if (m.type === 'location' && m.location) {
      const { latitude, longitude, address } = m.location;
      const mapsUrl = `https://maps.google.com/?q=${latitude},${longitude}`;
      msgContent = `<a href="${mapsUrl}" target="_blank" style="color:inherit;text-decoration:none;">📍 ${escapeHtml(address || m.content || '')}<br><span style="font-size:10px;opacity:0.7;">${latitude?.toFixed(5)}, ${longitude?.toFixed(5)}</span></a>`;
    } else {
      msgContent = escapeHtml(m.content || m.text || '');
    }

    return `
      <div class="msg-bubble-row ${isMine ? 'mine' : 'theirs'}">
        ${!isMine ? `<div class="msg-bubble-avatar" style="background:${avatarColor}">${senderInitial}</div>` : ''}
        <div class="msg-bubble ${isMine ? 'mine' : 'theirs'}">
          ${!isMine ? `<div class="msg-sender-name" style="color:${avatarColor}">${escapeHtml(senderName)}</div>` : ''}
          ${msgContent}
          <div class="msg-bubble-time">${time}</div>
        </div>
      </div>
    `;
  }).join('');

  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function getRoleColor(role) {
  switch (role) {
    case 'admin': return '#ef4444';
    case 'dispatcher': return '#f59e0b';
    case 'responder': return '#3b82f6';
    default: return '#8b5cf6';
  }
}

// ─── Send Media from Dispatch ───────────────────────────────
async function sendDispatchMedia(input, mediaType) {
  if (!msgCurrentConvId || !input.files?.[0]) return;
  const file = input.files[0];
  input.value = ''; // reset input
  
  const formData = new FormData();
  formData.append('file', file);
  formData.append('senderId', currentDispatchUser().id || '');
  formData.append('senderName', currentDispatchUser().name || 'Dispatch Console');
  formData.append('mediaType', mediaType);
  if (mediaType === 'document') formData.append('fileName', file.name);

  try {
    const res = await fetch(`${API_BASE}/api/conversations/${msgCurrentConvId}/media`, {
      method: 'POST',
      body: formData,
    });
    if (res.ok) {
      await loadMessages(msgCurrentConvId);
      await loadConversations();
    } else {
      alert('Erreur lors de l\'envoi du fichier');
    }
  } catch(e) {
    console.error('Media send error:', e);
    alert('Erreur lors de l\'envoi du fichier');
  }
}

// ─── Send Message ───────────────────────────────────────────

async function sendChatMessage() {
  const input = document.getElementById('msgInput');
  const content = input.value.trim();
  if (!content || !msgCurrentConvId) return;

  input.value = '';

  const data = await msgFetch(`/api/messaging/conversations/${msgCurrentConvId}/messages`, {
    method: 'POST',
    body: JSON.stringify({
      senderId: currentDispatchUser().id,
      senderName: currentDispatchUser().name || 'Dispatch Console',
      content,
    }),
  });

  if (data) {
    await loadMessages(msgCurrentConvId);
    await loadConversations();
  }
}

function handleMsgKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
}

async function refreshChatMessages() {
  if (msgCurrentConvId) {
    await loadMessages(msgCurrentConvId);
  }
}

// ─── Filter Conversations ───────────────────────────────────

function filterConversations() {
  renderConversationList();
}

// ─── New Conversation Modal ─────────────────────────────────

async function openNewConversationModal() {
  await loadMsgUsers();
  newConvSelectedUsers.clear();
  newConvSelectedRole = null;
  newConvSelectedTags.clear();

  renderNewConvDirectUsers();
  renderNewConvGroupUsers();
  renderNewConvTags();
  switchNewConvMode('direct');

  document.getElementById('newConvModal').classList.add('active');
}

function closeNewConvModal() {
  document.getElementById('newConvModal').classList.remove('active');
}

function switchNewConvMode(mode) {
  document.querySelectorAll('.newconv-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  document.querySelectorAll('.newconv-panel').forEach(p => p.classList.remove('active'));
  document.getElementById(`newconv-${mode}`).classList.add('active');
}

// Direct users list
function renderNewConvDirectUsers() {
  const list = document.getElementById('newconvDirectUsers');
  const users = msgUsers.filter(u => u.id !== currentDispatchUser().id);
  list.innerHTML = users.map(u => {
    const color = getRoleColor(u.role);
    const tags = (u.tags || []).map(t => `<span class="newconv-tag">${t}</span>`).join('');
    return `
      <div class="newconv-user-item" onclick="startDirectConversation('${u.id}')">
        <div class="newconv-user-avatar" style="background:${color}">${(u.name || '?').charAt(0)}</div>
        <div class="newconv-user-info">
          <div class="newconv-user-name">${escapeHtml(u.name)}</div>
          <div class="newconv-user-role">${u.role}</div>
          ${tags ? `<div class="newconv-user-tags">${tags}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// Group users list (with checkboxes)
function renderNewConvGroupUsers() {
  const list = document.getElementById('newconvGroupUsers');
  const users = msgUsers.filter(u => u.id !== currentDispatchUser().id);
  list.innerHTML = users.map(u => {
    const color = getRoleColor(u.role);
    const checked = newConvSelectedUsers.has(u.id);
    return `
      <div class="newconv-user-item ${checked ? 'selected' : ''}" onclick="toggleGroupUser('${u.id}')">
        <div class="newconv-checkbox ${checked ? 'checked' : ''}">${checked ? '✓' : ''}</div>
        <div class="newconv-user-avatar" style="background:${color}">${(u.name || '?').charAt(0)}</div>
        <div class="newconv-user-info">
          <div class="newconv-user-name">${escapeHtml(u.name)}</div>
          <div class="newconv-user-role">${u.role}</div>
        </div>
      </div>
    `;
  }).join('');
}

function toggleGroupUser(userId) {
  if (newConvSelectedUsers.has(userId)) {
    newConvSelectedUsers.delete(userId);
  } else {
    newConvSelectedUsers.add(userId);
  }
  renderNewConvGroupUsers();
}

// Tags list
function renderNewConvTags() {
  const list = document.getElementById('newconvTagsList');
  list.innerHTML = msgAvailableTags.map(tag => {
    const active = newConvSelectedTags.has(tag) ? 'active' : '';
    return `<button class="newconv-tag-btn ${active}" onclick="toggleConvTag('${tag}')">${tag}</button>`;
  }).join('');
}

function toggleConvTag(tag) {
  if (newConvSelectedTags.has(tag)) {
    newConvSelectedTags.delete(tag);
  } else {
    newConvSelectedTags.add(tag);
  }
  renderNewConvTags();
}

function selectConvRole(role) {
  newConvSelectedRole = (newConvSelectedRole === role) ? null : role;
  document.querySelectorAll('.role-select-btn').forEach(b => b.classList.toggle('active', b.dataset.role === newConvSelectedRole));
}

// ─── Create Conversations ───────────────────────────────────

async function startDirectConversation(userId) {
  // Check if conversation already exists
  const existing = msgConversations.find(c =>
    c.type === 'direct' && c.participants?.includes(userId) && c.participants?.includes(currentDispatchUser().id)
  );
  if (existing) {
    closeNewConvModal();
    selectConversation(existing.id);
    return;
  }

  const data = await msgFetch('/api/messaging/conversations', {
    method: 'POST',
    body: JSON.stringify({
      type: 'direct',
      createdBy: currentDispatchUser().id,
      participants: [currentDispatchUser().id, userId],
    }),
  });

  if (data?.conversation) {
    closeNewConvModal();
    await loadConversations();
    selectConversation(data.conversation.id);
  }
}

async function createGroupByUsers() {
  const name = document.getElementById('newconvGroupName')?.value?.trim();
  if (!name) return alert('Please enter a group name');
  if (newConvSelectedUsers.size === 0) return alert('Please select at least one user');

  const participants = [currentDispatchUser().id, ...newConvSelectedUsers];
  const data = await msgFetch('/api/messaging/conversations', {
    method: 'POST',
    body: JSON.stringify({
      type: 'group',
      name,
      groupType: 'custom',
      createdBy: currentDispatchUser().id,
      participants,
    }),
  });

  if (data?.conversation) {
    closeNewConvModal();
    await loadConversations();
    selectConversation(data.conversation.id);
  }
}

async function createGroupByRole() {
  const name = document.getElementById('newconvRoleGroupName')?.value?.trim();
  if (!name) return alert('Please enter a group name');
  if (!newConvSelectedRole) return alert('Please select a role');

  const roleUsers = msgUsers.filter(u => u.role === newConvSelectedRole).map(u => u.id);
  if (roleUsers.length === 0) return alert(`No users with role "${newConvSelectedRole}"`);

  const participants = [currentDispatchUser().id, ...roleUsers];
  const data = await msgFetch('/api/messaging/conversations', {
    method: 'POST',
    body: JSON.stringify({
      type: 'group',
      name,
      groupType: `role:${newConvSelectedRole}`,
      createdBy: currentDispatchUser().id,
      participants,
    }),
  });

  if (data?.conversation) {
    closeNewConvModal();
    await loadConversations();
    selectConversation(data.conversation.id);
  }
}

async function createGroupByTags() {
  const name = document.getElementById('newconvTagGroupName')?.value?.trim();
  if (!name) return alert('Please enter a group name');
  if (newConvSelectedTags.size === 0) return alert('Please select at least one tag');

  const data = await msgFetch('/api/messaging/conversations', {
    method: 'POST',
    body: JSON.stringify({
      type: 'group',
      name,
      groupType: `tags:${[...newConvSelectedTags].join(',')}`,
      createdBy: currentDispatchUser().id,
      tags: [...newConvSelectedTags],
    }),
  });

  if (data?.conversation) {
    closeNewConvModal();
    await loadConversations();
    selectConversation(data.conversation.id);
  }
}

// ─── WebSocket Message Handling ─────────────────────────────

function handleNewChatMessage(data) {
  // If we're viewing this conversation, refresh messages
  if (data.conversationId === msgCurrentConvId) {
    loadMessages(msgCurrentConvId);
  }
  // Always refresh conversation list for updated previews
  loadConversations();
  // Play notification sound
  playMessageSound();
}

function playMessageSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}

// ─── Init Messages Tab ──────────────────────────────────────

async function initMessagesTab() {
  await loadMsgUsers();
  await loadConversations();

  // Start conversation list polling
  clearInterval(msgConvPollTimer);
  msgConvPollTimer = setInterval(loadConversations, 5000);
}

// Hook into tab switching
const origSwitchTab = window.switchTab;
if (origSwitchTab) {
  window.switchTab = function(tab) {
    origSwitchTab(tab);
    if (tab === 'messages') {
      initMessagesTab();
    } else {
      // Clean up polling when leaving messages tab
      clearInterval(msgPollTimer);
      clearInterval(msgConvPollTimer);
    }
    if (tab === 'patrol') {
      refreshPatrolReports();
    }
  };
}

// Hook into WebSocket message handler to catch new messages
const origHandleWsMessage = window.handleWsMessage;
if (origHandleWsMessage) {
  window.handleWsMessage = function(data) {
    origHandleWsMessage(data);
    if (data.type === 'newMessage') {
      handleNewChatMessage(data);
    }
  };
}


// ─── User Profile Panel (Map) ─────────────────────────────────────
let currentProfileUserId = null;

async function openUserProfile(userId, userName) {
  const panel = document.getElementById('userProfilePanel');
  const body = document.getElementById('upBody');
  const title = document.getElementById('upTitle');

  title.textContent = userName || 'User Profile';
  body.innerHTML = '<div class="up-loading">⏳ Loading profile...</div>';
  panel.style.display = 'flex';
  currentProfileUserId = userId;

  try {
    const res = await fetch(`${API_BASE}/admin/users/${userId}`);
    if (!res.ok) throw new Error('User not found');
    const user = await res.json();
    renderUserProfile(user);
  } catch (err) {
    body.innerHTML = `<div class="up-loading" style="color:#ef4444;">❌ Failed to load profile: ${err.message}</div>`;
  }
}

function closeUserProfile() {
  document.getElementById('userProfilePanel').style.display = 'none';
  currentProfileUserId = null;
}

function renderUserProfile(user) {
  const body = document.getElementById('upBody');
  const title = document.getElementById('upTitle');

  const fullName = [user.firstName, user.lastName].filter(Boolean).join(' ') || user.name || 'Unknown';
  title.textContent = fullName;

  // Photo
  const photoHtml = user.photoUrl
    ? `<img src="${user.photoUrl}" class="up-photo" alt="${fullName}">`
    : `<div class="up-photo-placeholder">${(user.firstName || user.name || '?').charAt(0)}</div>`;

  // Role & Status badges
  const ROLE_COLORS = { admin: '#dc2626', dispatcher: '#f59e0b', responder: '#059669', user: '#8b5cf6' };
  const STATUS_COLORS = { active: '#22c55e', inactive: '#6b7280', suspended: '#ef4444' };
  const roleColor = ROLE_COLORS[user.role] || '#6b7280';
  const statusColor = STATUS_COLORS[user.status] || '#6b7280';
  const roleBadge = `<span class="up-badge" style="background:${roleColor}15;color:${roleColor};border:1px solid ${roleColor}40;">${user.role}</span>`;
  const statusBadge = `<span class="up-badge" style="background:${statusColor}15;color:${statusColor};border:1px solid ${statusColor}40;">${user.status}</span>`;

  // Tags
  const tagsHtml = (user.tags && user.tags.length > 0)
    ? `<div class="up-tags">${user.tags.map(t => `<span class="up-tag">${t}</span>`).join('')}</div>`
    : '';

  // Contact info
  const contactRows = [];
  if (user.email) contactRows.push(`<div class="up-info-row"><span class="up-info-icon">📧</span><span class="up-info-value">${user.email}</span></div>`);
  if (user.phoneMobile) contactRows.push(`<div class="up-info-row"><span class="up-info-icon">📱</span><span class="up-info-value"><a href="tel:${user.phoneMobile}" class="up-link">${user.phoneMobile}</a></span></div>`);
  if (user.phoneLandline) contactRows.push(`<div class="up-info-row"><span class="up-info-icon">☎️</span><span class="up-info-value"><a href="tel:${user.phoneLandline}" class="up-link">${user.phoneLandline}</a></span></div>`);
  if (user.address) contactRows.push(`<div class="up-info-row"><span class="up-info-icon">📍</span><span class="up-info-value">${user.address}</span></div>`);

  // Relationships
  let relHtml = '';
  if (user.relationships && user.relationships.length > 0) {
    const REL_LABELS = { spouse: 'Conjoint(e)', parent: 'Parent', child: 'Enfant', sibling: 'Frère/Sœur', cohabitant: 'Cohabitant(e)', other: 'Autre' };
    const REL_ICONS = { spouse: '💑', parent: '👨‍👩‍👧', child: '👶', sibling: '👫', cohabitant: '🏠', other: '🔗' };
    relHtml = `
      <div class="up-section">
        <div class="up-section-title">Relations</div>
        ${user.relationships.map(r => {
          const label = REL_LABELS[r.type] || r.type;
          const icon = REL_ICONS[r.type] || '🔗';
          const relName = r.relatedUser ? r.relatedUser.name : r.userId;
          return `<div class="up-rel-item" onclick="openUserProfile('${r.userId}', '${relName ? relName.replace(/'/g, "\\'") : ''}')">
            <span class="up-rel-icon">${icon}</span>
            <div class="up-rel-info">
              <div class="up-rel-name">${relName}</div>
              <div class="up-rel-type">${label}</div>
            </div>
            <span class="up-rel-arrow">›</span>
          </div>`;
        }).join('')}
      </div>`;
  }

  // Same address users
  let sameAddrHtml = '';
  if (user.sameAddress && user.sameAddress.length > 0) {
    sameAddrHtml = `
      <div class="up-section">
        <div class="up-section-title">🏠 Même adresse</div>
        ${user.sameAddress.map(u => `
          <div class="up-rel-item" onclick="openUserProfile('${u.id}', '${(u.name || '').replace(/'/g, "\\'")}')">
            <span class="up-rel-icon">👤</span>
            <div class="up-rel-info">
              <div class="up-rel-name">${u.name}</div>
              <div class="up-rel-type">${u.role}</div>
            </div>
            <span class="up-rel-arrow">›</span>
          </div>
        `).join('')}
      </div>`;
  }

  // Comments
  const commentsHtml = user.comments
    ? `<div class="up-section"><div class="up-section-title">Commentaires</div><div class="up-comments">${user.comments}</div></div>`
    : '';

  // Last login
  const lastLoginHtml = user.lastLogin
    ? `<div class="up-info-row"><span class="up-info-icon">🕐</span><span class="up-info-value">Dernière connexion: ${new Date(user.lastLogin).toLocaleString('fr-FR')}</span></div>`
    : '';

  // Action buttons - check if user has a live location on the map
  const mapUser = (mapUsers || []).find(u => u.id === user.id);
  const hasLocation = !!(mapUser && mapUser.location);
  const locateBtn = hasLocation
    ? `<button class="up-action-btn up-btn-locate" onclick="locateUserOnMap('${user.id}', '${fullName.replace(/'/g, "\\'")}')">📍 Localiser</button>`
    : `<button class="up-action-btn up-btn-locate up-btn-disabled" disabled title="Position non disponible">📍 Localiser</button>`;
  const actionsHtml = `
    <div class="up-actions">
      ${locateBtn}
      <button class="up-action-btn up-btn-message" onclick="startDirectFromProfile('${user.id}', '${fullName.replace(/'/g, "\\'")}')">💬 Message</button>
      ${user.phoneMobile ? `<a href="tel:${user.phoneMobile}" class="up-action-btn up-btn-call">📞 Appeler</a>` : ''}
    </div>`;

  body.innerHTML = `
    <div class="up-hero">
      ${photoHtml}
      <div class="up-hero-info">
        <div class="up-name">${fullName}</div>
        <div class="up-badges">${roleBadge} ${statusBadge}</div>
        ${tagsHtml}
      </div>
    </div>
    <div class="up-contact">
      ${contactRows.join('')}
      ${lastLoginHtml}
    </div>
    ${relHtml}
    ${sameAddrHtml}
    ${commentsHtml}
    ${actionsHtml}
  `;
}

function startDirectFromProfile(userId, userName) {
  closeUserProfile();
  switchTab('messages');
  // Check if a DM conversation already exists with this user
  const existing = allConversations.find(c => c.type === 'direct' && c.participants && c.participants.includes(userId));
  if (existing) {
    selectConversation(existing.id);
  } else {
    startDirectConversation(userId);
  }
}

function locateUserOnMap(userId, userName) {
  // Find user location from mapUsers or cached data
  const allUsers = mapUsers || window._cachedMapUsers || [];
  const user = allUsers.find(u => u.id === userId);
  
  if (!user || !user.location) {
    showToast(`Position de ${userName || userId} non disponible`, 'warning');
    return;
  }
  
  const { latitude, longitude } = user.location;
  
  // Close profile panel
  closeUserProfile();
  
  // Switch to map tab if not already there
  switchTab('map');
  
  // Wait for map to be visible, then center and zoom
  setTimeout(() => {
    if (dispatchMap) {
      dispatchMap.setView([latitude, longitude], 16, { animate: true });
      
      // Add a pulsing highlight marker
      if (window._locateHighlightMarker) {
        dispatchMap.removeLayer(window._locateHighlightMarker);
      }
      
      const pulseIcon = L.divIcon({
        className: 'locate-pulse-marker',
        html: `<div class="locate-pulse-ring"></div><div class="locate-pulse-dot"></div><div class="locate-pulse-label">${userName || userId}</div>`,
        iconSize: [80, 80],
        iconAnchor: [40, 40],
      });
      
      window._locateHighlightMarker = L.marker([latitude, longitude], { icon: pulseIcon, zIndexOffset: 1000 });
      window._locateHighlightMarker.addTo(dispatchMap);
      
      showToast(`📍 ${userName || userId} localisé(e)`, 'success');
      
      // Remove highlight after 8 seconds
      setTimeout(() => {
        if (window._locateHighlightMarker) {
          dispatchMap.removeLayer(window._locateHighlightMarker);
          window._locateHighlightMarker = null;
        }
      }, 8000);
    }
  }, 300);
}


// ═══════════════════════════════════════════════════════════
// MAP USER SEARCH
// ═══════════════════════════════════════════════════════════
let mapSearchHighlightMarker = null;

function onMapSearchInput(query) {
  const resultsDiv = document.getElementById('mapSearchResults');
  if (!query || query.trim().length < 2) {
    resultsDiv.style.display = 'none';
    return;
  }
  
  const q = query.toLowerCase().trim();
  
  // Search across all users (mapUsers + mapResponders from cached data)
  const allEntities = [];
  
  // Add users from cached map data
  if (window._cachedMapUsers) {
    window._cachedMapUsers.forEach(u => {
      allEntities.push({ ...u, _type: 'user' });
    });
  }
  
  // Add responders from cached map data
  if (window._cachedMapResponders) {
    window._cachedMapResponders.forEach(r => {
      allEntities.push({ ...r, _type: 'responder' });
    });
  }
  
  // Filter by name, email, role, or tags
  const matches = allEntities.filter(e => {
    const name = (e.name || '').toLowerCase();
    const email = (e.email || '').toLowerCase();
    const role = (e.role || '').toLowerCase();
    const tags = (e.tags || []).join(' ').toLowerCase();
    return name.includes(q) || email.includes(q) || role.includes(q) || tags.includes(q);
  });
  
  if (matches.length === 0) {
    resultsDiv.innerHTML = '<div class="map-search-no-result">Aucun résultat trouvé</div>';
    resultsDiv.style.display = 'block';
    return;
  }
  
  const ROLE_COLORS = { admin: '#dc2626', dispatcher: '#f59e0b', responder: '#059669', user: '#8b5cf6' };
  
  resultsDiv.innerHTML = matches.slice(0, 10).map(e => {
    const initial = (e.name || '?').charAt(0).toUpperCase();
    const color = ROLE_COLORS[e.role] || ROLE_COLORS[e._type] || '#6b7280';
    const hasLocation = e.location && e.location.latitude;
    const noLocHtml = !hasLocation ? '<span class="map-search-no-location">(pas de position)</span>' : '';
    return `<div class="map-search-item" onclick="focusMapOnUser('${e.id}', '${e.name ? e.name.replace(/'/g, "\\'") : ''}', ${hasLocation ? e.location.latitude : 0}, ${hasLocation ? e.location.longitude : 0}, ${hasLocation})">
      <div class="map-search-avatar" style="background:${color}">${initial}</div>
      <div class="map-search-info">
        <div class="map-search-name">${e.name || 'Unknown'}${noLocHtml}</div>
        <div class="map-search-detail">${e.role || e._type} ${e.email ? '· ' + e.email : ''}</div>
      </div>
    </div>`;
  }).join('');
  
  resultsDiv.style.display = 'block';
}

function focusMapOnUser(userId, userName, lat, lng, hasLocation) {
  const resultsDiv = document.getElementById('mapSearchResults');
  const searchInput = document.getElementById('mapUserSearch');
  resultsDiv.style.display = 'none';
  searchInput.value = userName;
  
  if (!hasLocation) {
    showToast(`${userName} n'a pas de position connue`, 'warning');
    return;
  }
  
  // Remove previous highlight
  if (mapSearchHighlightMarker) {
    dispatchMap.removeLayer(mapSearchHighlightMarker);
    mapSearchHighlightMarker = null;
  }
  
  // Fly to user location
  dispatchMap.flyTo([lat, lng], 16, { duration: 1.5 });
  
  // Add a pulsing highlight ring around the user
  mapSearchHighlightMarker = L.circleMarker([lat, lng], {
    radius: 30,
    color: '#3b82f6',
    fillColor: '#3b82f6',
    fillOpacity: 0.15,
    weight: 3,
    opacity: 0.8,
    className: 'search-highlight-pulse',
  }).addTo(dispatchMap);
  
  // Open the user profile
  setTimeout(() => {
    openUserProfile(userId, userName);
  }, 800);
  
  // Remove highlight after 8 seconds
  setTimeout(() => {
    if (mapSearchHighlightMarker) {
      dispatchMap.removeLayer(mapSearchHighlightMarker);
      mapSearchHighlightMarker = null;
    }
  }, 8000);
}

// Close search results when clicking outside
document.addEventListener('click', (e) => {
  const container = document.querySelector('.map-search-container');
  if (container && !container.contains(e.target)) {
    document.getElementById('mapSearchResults').style.display = 'none';
  }
});

// ── Zone Quick Filters ──
async function zoomToZone(zoneId) {
  if (!dispatchMap) return;
  if (zoneId === 'all') {
    await zoomToAllResidences();
  } else {
    const layer = sectorLayers[zoneId];
    if (!layer) return;
    dispatchMap.fitBounds(layer.shape.getBounds(), { padding: [40, 40], maxZoom: 16 });
  }

  // Highlight active button
  document.querySelectorAll('.btn-zone-filter').forEach(btn => {
    btn.classList.toggle('zone-active', btn.getAttribute('data-zone') === zoneId);
  });
}

// "Tout" zooms out to fit every registered residence/office/etc. across every
// user profile — not a fixed city — so it stays correct as families' places
// change (Geneva today, maybe elsewhere tomorrow).
async function zoomToAllResidences() {
  try {
    const res = await fetch(`${API_BASE}/dispatch/all-residences`);
    const residences = res.ok ? await res.json() : [];
    if (residences.length === 0) {
      dispatchMap.setView([46.2125, 6.1795], 13, { animate: true });
      return;
    }
    const bounds = L.latLngBounds(residences.map(r => [r.latitude, r.longitude]));
    dispatchMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 12 });
  } catch (e) {
    console.error('[Map] Failed to fetch all residences:', e);
    dispatchMap.setView([46.2125, 6.1795], 13, { animate: true });
  }
}

// ─── Sector CRUD (admin-managed organizational zones) ───────────────────

async function loadSectors() {
  try {
    const res = await fetch(`${API_BASE}/dispatch/sectors`);
    sectorsList = res.ok ? await res.json() : [];
  } catch (e) {
    console.error('[Sectors] Load error:', e);
    sectorsList = [];
  }
  renderSectors();
  renderSectorFilterButtons();
}

function renderSectors() {
  Object.values(sectorLayers).forEach(l => {
    if (dispatchMap.hasLayer(l.shape)) dispatchMap.removeLayer(l.shape);
    if (dispatchMap.hasLayer(l.label)) dispatchMap.removeLayer(l.label);
  });
  sectorLayers = {};
  sectorsList.forEach(sector => {
    let shapeLayer;
    let labelCenter;
    if (sector.shape === 'circle' && sector.center && sector.radiusMeters) {
      shapeLayer = L.circle([sector.center.latitude, sector.center.longitude], {
        radius: sector.radiusMeters,
        color: sector.color, weight: 2, opacity: 0.5, fillOpacity: 0.08, dashArray: '6 4',
      });
      labelCenter = [sector.center.latitude, sector.center.longitude];
    } else if (sector.shape === 'polygon' && sector.points && sector.points.length >= 3) {
      shapeLayer = L.polygon(sector.points.map(p => [p.latitude, p.longitude]), {
        color: sector.color, weight: 2, opacity: 0.5, fillOpacity: 0.08, dashArray: '6 4',
      });
      labelCenter = shapeLayer.getBounds().getCenter();
    } else {
      return;
    }
    shapeLayer.addTo(dispatchMap);
    const label = L.marker(labelCenter, {
      icon: L.divIcon({
        className: 'commune-label',
        html: `<div style="font-size:11px;font-weight:700;color:${sector.color};text-shadow:0 1px 3px rgba(0,0,0,0.7);white-space:nowrap;">${escapeHtml(sector.name)}</div>`,
        iconSize: [80, 20],
        iconAnchor: [40, 10],
      }),
    }).addTo(dispatchMap);
    sectorLayers[sector.id] = { shape: shapeLayer, label };
  });
}

function renderSectorFilterButtons() {
  const container = document.getElementById('sectorFilterButtons');
  if (!container) return;
  container.innerHTML = sectorsList.map(sector => `
    <button class="btn btn-zone-filter" data-zone="${sector.id}" onclick="zoomToZone('${sector.id}')" style="border-color:${sector.color};color:${sector.color};">${escapeHtml(sector.name)}</button>
  `).join('');
}

// ── Admin-only management UI ──

function setupSectorAdminUI() {
  const isAdmin = localStorage.getItem('talion_role') === 'admin';
  const btn = document.getElementById('btnManageSectors');
  if (btn) btn.style.display = isAdmin ? 'inline-flex' : 'none';
}

function setupCheckpointAdminUI() {
  const role = localStorage.getItem('talion_role');
  const isAdminOrAbove = role === 'admin' || role === 'superadmin';
  const btn = document.getElementById('btnConfigCheckpoints');
  if (btn) btn.style.display = isAdminOrAbove ? 'inline-flex' : 'none';
}

// ─── Patrol checkpoint configuration (admin only) ─────────────────────
let checkpointConfigMap = null;
let checkpointSites = [];
let checkpointsForSite = [];
let checkpointMarkers = {}; // id -> {marker, circle}
let editingCheckpointId = null; // null while creating a new checkpoint
let pendingCheckpointLatLng = null;
let pendingPreviewCircle = null;

async function openCheckpointConfigModal() {
  document.getElementById('checkpointConfigModal').style.display = 'flex';
  if (!checkpointSites.length) {
    try {
      const res = await fetch(`${API_BASE}/admin/patrol-sites`);
      checkpointSites = res.ok ? await res.json() : [];
    } catch (e) { checkpointSites = []; }
  }
  const select = document.getElementById('cpSiteSelect');
  select.innerHTML = '<option value="">Sélectionner un site...</option>' +
    checkpointSites.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  // Modal must be visible (display:flex) before Leaflet measures its container.
  setTimeout(initCheckpointConfigMap, 50);
}

function closeCheckpointConfigModal() {
  document.getElementById('checkpointConfigModal').style.display = 'none';
  cancelCheckpointForm();
}

let checkpointMapTileLayer = null;
let checkpointMapIsSatellite = false;

const CHECKPOINT_STREET_TILES_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const CHECKPOINT_STREET_TILES_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const CHECKPOINT_SATELLITE_TILES = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

function toggleCheckpointSatellite() {
  checkpointMapIsSatellite = !checkpointMapIsSatellite;
  if (checkpointMapTileLayer) checkpointConfigMap.removeLayer(checkpointMapTileLayer);
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  // Leaflet's TileLayer.getTileUrl() calls this.options.subdomains.length on
  // every tile regardless of whether the URL template even contains {s} — so
  // subdomains must never be set to undefined, only omitted (falls back to
  // Leaflet's harmless default 'abc') or given a real string/array.
  const tileOptions = checkpointMapIsSatellite
    ? { maxZoom: 20, attribution: 'Tiles &copy; Esri' }
    : { subdomains: 'abcd', maxZoom: 19 };
  const tiles = checkpointMapIsSatellite
    ? CHECKPOINT_SATELLITE_TILES
    : (isLight ? CHECKPOINT_STREET_TILES_LIGHT : CHECKPOINT_STREET_TILES_DARK);
  checkpointMapTileLayer = L.tileLayer(tiles, tileOptions).addTo(checkpointConfigMap);
  const btn = document.getElementById('cpSatelliteToggle');
  if (btn) btn.innerHTML = checkpointMapIsSatellite ? '&#x1F5FA;&#xFE0F; Plan' : '&#x1F6F0;&#xFE0F; Satellite';
}

function initCheckpointConfigMap() {
  if (checkpointConfigMap) { checkpointConfigMap.invalidateSize(); return; }
  checkpointConfigMap = L.map('checkpointConfigMap', { center: [46.2125, 6.1795], zoom: 15 });
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const tiles = isLight ? CHECKPOINT_STREET_TILES_LIGHT : CHECKPOINT_STREET_TILES_DARK;
  checkpointMapTileLayer = L.tileLayer(tiles, { subdomains: 'abcd', maxZoom: 19 }).addTo(checkpointConfigMap);
  checkpointConfigMap.on('click', (e) => {
    if (!document.getElementById('cpSiteSelect').value) {
      showToast("Sélectionnez un site d'abord", 'error');
      return;
    }
    startNewCheckpointAt(e.latlng);
  });
  const radiusInput = document.getElementById('cpRadius');
  radiusInput.addEventListener('input', () => {
    if (pendingCheckpointLatLng) showPendingPreview(pendingCheckpointLatLng, Number(radiusInput.value) || 15);
  });
}

async function onCheckpointSiteChange() {
  const siteId = document.getElementById('cpSiteSelect').value;
  cancelCheckpointForm();
  clearCheckpointMarkers();
  if (!siteId) { checkpointsForSite = []; renderCheckpointList(); return; }
  try {
    const res = await fetch(`${API_BASE}/admin/patrol-checkpoints?siteId=${siteId}`);
    checkpointsForSite = res.ok ? await res.json() : [];
  } catch (e) { checkpointsForSite = []; }
  renderCheckpointList();
  drawCheckpointMarkers();
  if (checkpointsForSite.length) {
    const group = L.featureGroup(Object.values(checkpointMarkers).map(m => m.circle));
    checkpointConfigMap.fitBounds(group.getBounds(), { padding: [40, 40], maxZoom: 17 });
  }
}

function clearCheckpointMarkers() {
  Object.values(checkpointMarkers).forEach(({ marker, circle }) => {
    checkpointConfigMap.removeLayer(marker);
    checkpointConfigMap.removeLayer(circle);
  });
  checkpointMarkers = {};
}

function drawCheckpointMarkers() {
  clearCheckpointMarkers();
  checkpointsForSite.forEach(cp => addCheckpointMarker(cp));
}

function addCheckpointMarker(cp) {
  const circle = L.circle([cp.latitude, cp.longitude], {
    radius: cp.radiusMeters, color: '#3b82f6', fillColor: '#3b82f6', fillOpacity: 0.15,
    weight: 2, dashArray: '6,4',
  }).addTo(checkpointConfigMap);
  const marker = L.marker([cp.latitude, cp.longitude], {
    icon: L.divIcon({
      className: 'checkpoint-marker',
      html: '<div style="background:#3b82f6;color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 1px 4px rgba(0,0,0,0.4);">&#x1F4CD;</div>',
      iconSize: [22, 22], iconAnchor: [11, 11],
    }),
  }).addTo(checkpointConfigMap);
  marker.bindPopup(
    `<b>${escapeHtml(cp.name)}</b><br>${cp.radiusMeters}m` +
    (cp.minDwellSeconds ? ` &middot; min ${cp.minDwellSeconds}s` : '') +
    `<br><button class="btn btn-sm btn-secondary" onclick="editCheckpoint('${cp.id}')">Modifier</button> ` +
    `<button class="btn btn-sm btn-danger" onclick="deleteCheckpoint('${cp.id}')">Supprimer</button>`
  );
  checkpointMarkers[cp.id] = { marker, circle };
}

function renderCheckpointList() {
  const container = document.getElementById('checkpointList');
  if (!checkpointsForSite.length) {
    container.innerHTML = '<div class="empty-state" style="padding:12px;font-size:13px;">Aucun checkpoint. Cliquez sur la carte pour en ajouter un.</div>';
    return;
  }
  container.innerHTML = checkpointsForSite.map(cp => `
    <div style="padding:8px;border-bottom:1px solid var(--border-color);cursor:pointer;" onclick="focusCheckpoint('${cp.id}')">
      <div style="font-weight:600;">${escapeHtml(cp.name)}</div>
      <div style="font-size:12px;color:var(--text-secondary);">${cp.radiusMeters}m${cp.minDwellSeconds ? ` &middot; min ${cp.minDwellSeconds}s` : ''}</div>
    </div>
  `).join('');
}

function focusCheckpoint(id) {
  const cp = checkpointsForSite.find(c => c.id === id);
  const m = checkpointMarkers[id];
  if (cp && m) { checkpointConfigMap.setView([cp.latitude, cp.longitude], 17); m.marker.openPopup(); }
}

function startNewCheckpointAt(latlng) {
  editingCheckpointId = null;
  pendingCheckpointLatLng = latlng;
  showCheckpointForm({ name: '', radiusMeters: 15, minDwellSeconds: '' });
  showPendingPreview(latlng, 15);
}

function editCheckpoint(id) {
  const cp = checkpointsForSite.find(c => c.id === id);
  if (!cp) return;
  editingCheckpointId = id;
  pendingCheckpointLatLng = L.latLng(cp.latitude, cp.longitude);
  showCheckpointForm(cp);
  showPendingPreview(pendingCheckpointLatLng, cp.radiusMeters);
}

function showPendingPreview(latlng, radius) {
  if (pendingPreviewCircle) checkpointConfigMap.removeLayer(pendingPreviewCircle);
  pendingPreviewCircle = L.circle(latlng, {
    radius, color: '#f59e0b', fillColor: '#f59e0b', fillOpacity: 0.15, weight: 2, dashArray: '4,4',
  }).addTo(checkpointConfigMap);
}

function showCheckpointForm(cp) {
  document.getElementById('checkpointForm').style.display = 'block';
  document.getElementById('cpName').value = cp.name || '';
  document.getElementById('cpRadius').value = cp.radiusMeters || 15;
  document.getElementById('cpMinDwell').value = cp.minDwellSeconds || '';
}

function cancelCheckpointForm() {
  document.getElementById('checkpointForm').style.display = 'none';
  if (pendingPreviewCircle) { checkpointConfigMap && checkpointConfigMap.removeLayer(pendingPreviewCircle); pendingPreviewCircle = null; }
  editingCheckpointId = null;
  pendingCheckpointLatLng = null;
}

async function saveCheckpointForm() {
  const siteId = document.getElementById('cpSiteSelect').value;
  const name = document.getElementById('cpName').value.trim();
  const radiusMeters = Number(document.getElementById('cpRadius').value);
  const minDwellRaw = document.getElementById('cpMinDwell').value;
  const minDwellSeconds = minDwellRaw ? Number(minDwellRaw) : undefined;
  if (!name || !radiusMeters) { showToast('Nom et rayon requis', 'error'); return; }
  try {
    let res;
    if (editingCheckpointId) {
      res = await fetch(`${API_BASE}/admin/patrol-checkpoints/${editingCheckpointId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, radiusMeters, minDwellSeconds: minDwellSeconds ?? null }),
      });
    } else {
      res = await fetch(`${API_BASE}/admin/patrol-checkpoints`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId, name, latitude: pendingCheckpointLatLng.lat, longitude: pendingCheckpointLatLng.lng, radiusMeters, minDwellSeconds }),
      });
    }
    if (!res.ok) { const err = await res.json().catch(() => ({})); showToast(err.error || 'Erreur', 'error'); return; }
    showToast(editingCheckpointId ? 'Checkpoint modifié' : 'Checkpoint créé', 'success');
    cancelCheckpointForm();
    await onCheckpointSiteChange();
  } catch (e) { showToast('Impossible de contacter le serveur', 'error'); }
}

async function deleteCheckpoint(id) {
  if (!confirm('Supprimer ce checkpoint ?')) return;
  try {
    const res = await fetch(`${API_BASE}/admin/patrol-checkpoints/${id}`, { method: 'DELETE' });
    if (res.ok) { showToast('Checkpoint supprimé', 'success'); await onCheckpointSiteChange(); }
    else showToast('Erreur lors de la suppression', 'error');
  } catch (e) { showToast('Impossible de contacter le serveur', 'error'); }
}

function openSectorModal() {
  const modal = document.getElementById('sectorModal');
  if (modal) modal.style.display = 'flex';
  renderSectorManageList();
  showSectorList();
}

function closeSectorModal() {
  cancelSectorForm();
  const modal = document.getElementById('sectorModal');
  if (modal) modal.style.display = 'none';
}

function showSectorList() {
  document.getElementById('sectorListView').style.display = 'block';
  document.getElementById('sectorFormView').style.display = 'none';
}

function renderSectorManageList() {
  const list = document.getElementById('sectorList');
  if (!list) return;
  if (sectorsList.length === 0) {
    list.innerHTML = '<div class="sector-empty">Aucun secteur défini pour le moment.</div>';
    return;
  }
  list.innerHTML = sectorsList.map(sector => `
    <div class="sector-list-item">
      <span class="sector-color-dot" style="background:${sector.color};"></span>
      <div class="sector-list-info">
        <div class="sector-list-name">${escapeHtml(sector.name)}</div>
        <div class="sector-list-meta">${sector.shape === 'circle' ? `Cercle · ${sector.radiusMeters}m de rayon` : `Tracé libre · ${sector.points?.length || 0} points`}</div>
      </div>
      <button class="btn btn-secondary sector-edit-btn" onclick="editSector('${sector.id}')">Modifier</button>
      <button class="btn btn-danger sector-delete-btn" onclick="deleteSectorConfirm('${sector.id}')">Supprimer</button>
    </div>
  `).join('');
}

function showSectorForm() {
  sectorEditingId = null;
  document.getElementById('sectorFormTitle').textContent = 'Nouveau secteur';
  document.getElementById('sectorName').value = '';
  document.getElementById('sectorColor').value = '#3b82f6';
  document.getElementById('sectorAddress').value = '';
  document.getElementById('sectorAddressSuggestions').style.display = 'none';
  document.getElementById('sectorShapeToggle').style.display = 'flex';
  selectSectorShape('circle');
  document.getElementById('sectorListView').style.display = 'none';
  document.getElementById('sectorFormView').style.display = 'block';
}

function editSector(sectorId) {
  const sector = sectorsList.find(s => s.id === sectorId);
  if (!sector) return;
  sectorEditingId = sectorId;
  document.getElementById('sectorFormTitle').textContent = `Modifier « ${sector.name} »`;
  document.getElementById('sectorName').value = sector.name;
  document.getElementById('sectorColor').value = sector.color;
  document.getElementById('sectorAddress').value = '';
  document.getElementById('sectorAddressSuggestions').style.display = 'none';
  // Shape is fixed once a sector is created — editing only adjusts geometry/name/color.
  document.getElementById('sectorShapeToggle').style.display = 'none';
  document.getElementById('sectorListView').style.display = 'none';
  document.getElementById('sectorFormView').style.display = 'block';

  cleanupSectorDrawingLayers();
  if (sector.shape === 'circle') {
    sectorFormShape = 'circle';
    document.getElementById('sectorCircleFields').style.display = 'block';
    document.getElementById('sectorPolygonFields').style.display = 'none';
    sectorCircleCenter = L.latLng(sector.center.latitude, sector.center.longitude);
    sectorCircleRadius = sector.radiusMeters;
    document.getElementById('sectorRadiusSlider').value = Math.min(Math.max(sectorCircleRadius, 50), 5000);
    document.getElementById('sectorRadiusInput').value = sectorCircleRadius;
    document.getElementById('sectorRadiusField').style.display = 'block';
    document.getElementById('sectorCircleHint').textContent = 'Glissez le repère pour déplacer le centre, ajustez le rayon ci-dessous.';
    placeSectorCircleCenter(sectorCircleCenter, true);
  } else {
    sectorFormShape = 'polygon';
    document.getElementById('sectorCircleFields').style.display = 'none';
    document.getElementById('sectorPolygonFields').style.display = 'block';
    sectorPolygonPoints = sector.points.slice();
    sectorPolygonLayer = L.polygon(sector.points.map(p => [p.latitude, p.longitude]), {
      color: sector.color, weight: 2, fillOpacity: 0.1,
    }).addTo(dispatchMap);
    sectorPolygonLayer.editing.enable();
    sectorPolygonLayer.on('edit', () => {
      sectorPolygonPoints = sectorPolygonLayer.getLatLngs()[0].map(ll => ({ latitude: ll.lat, longitude: ll.lng }));
    });
    dispatchMap.fitBounds(sectorPolygonLayer.getBounds(), { padding: [40, 40] });
    document.getElementById('sectorPolygonHint').textContent = 'Faites glisser les sommets pour ajuster le tracé.';
    document.getElementById('sectorDrawPolygonBtn').style.display = 'none';
  }
}

function selectSectorShape(shape) {
  sectorFormShape = shape;
  document.getElementById('sectorShapeCircleBtn').classList.toggle('active', shape === 'circle');
  document.getElementById('sectorShapePolygonBtn').classList.toggle('active', shape === 'polygon');
  document.getElementById('sectorCircleFields').style.display = shape === 'circle' ? 'block' : 'none';
  document.getElementById('sectorPolygonFields').style.display = shape === 'polygon' ? 'block' : 'none';
  cleanupSectorDrawingLayers();
  if (shape === 'circle') {
    document.getElementById('sectorCircleHint').textContent = 'Cliquez sur la carte pour placer le centre, puis ajustez le rayon.';
    document.getElementById('sectorRadiusField').style.display = 'none';
    startSectorCircleDraw();
  } else {
    document.getElementById('sectorPolygonHint').textContent = 'Cliquez « Dessiner » puis posez les points du contour sur la carte (double-clic pour terminer).';
    document.getElementById('sectorDrawPolygonBtn').style.display = 'inline-block';
    document.getElementById('sectorDrawPolygonBtn').textContent = '✏️ Dessiner sur la carte';
  }
}

function cleanupSectorDrawingLayers() {
  if (sectorCircleCenterMarker) { dispatchMap.removeLayer(sectorCircleCenterMarker); sectorCircleCenterMarker = null; }
  if (sectorCircleLayer) { dispatchMap.removeLayer(sectorCircleLayer); sectorCircleLayer = null; }
  if (sectorPolygonLayer) { dispatchMap.removeLayer(sectorPolygonLayer); sectorPolygonLayer = null; }
  if (sectorMapClickHandler) { dispatchMap.off('click', sectorMapClickHandler); sectorMapClickHandler = null; }
  if (sectorPolygonDrawer) { sectorPolygonDrawer.disable(); sectorPolygonDrawer = null; }
  sectorCircleCenter = null;
  sectorPolygonPoints = null;
  dispatchMap?.getContainer().classList.remove('geofence-drawing');
}

function startSectorCircleDraw() {
  if (!dispatchMap) return;
  switchTab('map');
  dispatchMap.getContainer().classList.add('geofence-drawing');
  sectorMapClickHandler = function(e) { placeSectorCircleCenter(e.latlng); };
  dispatchMap.on('click', sectorMapClickHandler);
}

function placeSectorCircleCenter(latlng, keepListening) {
  sectorCircleCenter = latlng;
  if (sectorCircleCenterMarker) dispatchMap.removeLayer(sectorCircleCenterMarker);
  if (sectorCircleLayer) dispatchMap.removeLayer(sectorCircleLayer);

  sectorCircleCenterMarker = L.marker(latlng, {
    icon: L.divIcon({
      className: 'gf-center-icon',
      html: `<div style="width:20px;height:20px;border-radius:50%;background:${document.getElementById('sectorColor').value};border:3px solid #fff;box-shadow:0 0 12px rgba(0,0,0,0.4);"></div>`,
      iconSize: [20, 20], iconAnchor: [10, 10],
    }),
    draggable: true,
    zIndexOffset: 2000,
  }).addTo(dispatchMap);
  sectorCircleCenterMarker.on('drag', e => { sectorCircleCenter = e.target.getLatLng(); updateSectorCircle(); });

  updateSectorCircle();
  document.getElementById('sectorRadiusField').style.display = 'block';
  document.getElementById('sectorCircleHint').textContent = `Centre : ${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}`;
  dispatchMap.getContainer().classList.remove('geofence-drawing');
  if (!keepListening && sectorMapClickHandler) { dispatchMap.off('click', sectorMapClickHandler); sectorMapClickHandler = null; }
}

function updateSectorCircle() {
  if (!sectorCircleCenter) return;
  if (sectorCircleLayer) dispatchMap.removeLayer(sectorCircleLayer);
  sectorCircleLayer = L.circle(sectorCircleCenter, {
    radius: sectorCircleRadius,
    color: document.getElementById('sectorColor').value,
    weight: 2, fillOpacity: 0.1, dashArray: '8 6',
  }).addTo(dispatchMap);
  dispatchMap.fitBounds(sectorCircleLayer.getBounds(), { padding: [40, 40], maxZoom: 16 });
}

function updateSectorRadius(value) {
  sectorCircleRadius = parseFloat(value);
  document.getElementById('sectorRadiusInput').value = sectorCircleRadius;
  updateSectorCircle();
}

function updateSectorRadiusFromInput(value) {
  const v = parseFloat(value);
  if (isNaN(v) || v <= 0) return;
  sectorCircleRadius = v;
  const slider = document.getElementById('sectorRadiusSlider');
  slider.value = Math.min(Math.max(v, Number(slider.min)), Number(slider.max));
  updateSectorCircle();
}

// ── Address Autocomplete for sector circle center ──
let sectorAddressDebounceTimer = null;

function onSectorAddressInput(value) {
  clearTimeout(sectorAddressDebounceTimer);
  const box = document.getElementById('sectorAddressSuggestions');
  if (!value || value.length < 3) { box.style.display = 'none'; return; }
  sectorAddressDebounceTimer = setTimeout(() => fetchSectorAddressSuggestions(value), 350);
}

async function fetchSectorAddressSuggestions(query) {
  const box = document.getElementById('sectorAddressSuggestions');
  try {
    const res = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`);
    const results = await res.json();
    if (!results || results.length === 0) { box.style.display = 'none'; return; }
    box.innerHTML = results.map((r, i) => `
      <div class="address-suggestion-item" onclick="selectSectorAddressSuggestion(${i})" data-lat="${r.lat}" data-lon="${r.lon}" data-name="${r.display_name.replace(/"/g, '&quot;')}">
        <span class="addr-icon">📍</span>
        <span class="addr-text">${r.display_name}</span>
      </div>
    `).join('');
    box.style.display = 'block';
  } catch (e) {
    console.error('[Sectors] Address autocomplete failed:', e);
    box.style.display = 'none';
  }
}

function selectSectorAddressSuggestion(index) {
  const box = document.getElementById('sectorAddressSuggestions');
  const items = box.querySelectorAll('.address-suggestion-item');
  if (!items[index]) return;
  const item = items[index];
  const lat = parseFloat(item.getAttribute('data-lat'));
  const lon = parseFloat(item.getAttribute('data-lon'));
  document.getElementById('sectorAddress').value = item.getAttribute('data-name');
  box.style.display = 'none';
  placeSectorCircleCenter(L.latLng(lat, lon));
}

document.addEventListener('click', (e) => {
  const box = document.getElementById('sectorAddressSuggestions');
  if (box && !e.target.closest('#sectorAddress') && !e.target.closest('#sectorAddressSuggestions')) {
    box.style.display = 'none';
  }
});

function startSectorPolygonDraw() {
  if (!dispatchMap || !window.L?.Draw) return;
  switchTab('map');
  if (sectorPolygonLayer) { dispatchMap.removeLayer(sectorPolygonLayer); sectorPolygonLayer = null; }
  if (sectorPolygonDrawer) sectorPolygonDrawer.disable();
  sectorPolygonDrawer = new L.Draw.Polygon(dispatchMap, {
    shapeOptions: { color: document.getElementById('sectorColor').value, weight: 2 },
  });
  sectorPolygonDrawer.enable();
  document.getElementById('sectorPolygonHint').textContent = 'Cliquez pour poser chaque point, double-cliquez pour terminer le tracé.';

  const onCreated = (e) => {
    sectorPolygonLayer = e.layer;
    sectorPolygonLayer.addTo(dispatchMap);
    sectorPolygonLayer.editing.enable();
    sectorPolygonPoints = sectorPolygonLayer.getLatLngs()[0].map(ll => ({ latitude: ll.lat, longitude: ll.lng }));
    sectorPolygonLayer.on('edit', () => {
      sectorPolygonPoints = sectorPolygonLayer.getLatLngs()[0].map(ll => ({ latitude: ll.lat, longitude: ll.lng }));
    });
    document.getElementById('sectorPolygonHint').textContent = 'Faites glisser les sommets pour ajuster le tracé.';
    document.getElementById('sectorDrawPolygonBtn').textContent = '✏️ Recommencer le tracé';
    dispatchMap.off(L.Draw.Event.CREATED, onCreated);
  };
  dispatchMap.on(L.Draw.Event.CREATED, onCreated);
}

function cancelSectorForm() {
  cleanupSectorDrawingLayers();
  sectorEditingId = null;
  showSectorList();
}

async function saveSector() {
  const name = document.getElementById('sectorName').value.trim();
  const color = document.getElementById('sectorColor').value;
  if (!name) { showToast('Le nom du secteur est requis', 'error'); return; }

  let body;
  if (sectorFormShape === 'circle') {
    if (!sectorCircleCenter) { showToast('Placez le centre du secteur sur la carte', 'error'); return; }
    body = { name, color, shape: 'circle', center: { latitude: sectorCircleCenter.lat, longitude: sectorCircleCenter.lng }, radiusMeters: sectorCircleRadius };
  } else {
    if (!sectorPolygonPoints || sectorPolygonPoints.length < 3) { showToast('Dessinez un tracé avec au moins 3 points', 'error'); return; }
    body = { name, color, shape: 'polygon', points: sectorPolygonPoints };
  }

  try {
    const res = await fetch(`${API_BASE}/dispatch/sectors${sectorEditingId ? '/' + sectorEditingId : ''}`, {
      method: sectorEditingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Erreur lors de l'enregistrement du secteur", 'error');
      return;
    }
    showToast(`Secteur "${name}" enregistré`, 'success');
    cleanupSectorDrawingLayers();
    sectorEditingId = null;
    await loadSectors();
    renderSectorManageList();
    showSectorList();
  } catch (e) {
    console.error('[Sectors] Save error:', e);
    showToast('Erreur réseau', 'error');
  }
}

async function deleteSectorConfirm(sectorId) {
  const sector = sectorsList.find(s => s.id === sectorId);
  if (!sector) return;
  if (!confirm(`Supprimer le secteur "${sector.name}" ?`)) return;
  try {
    const res = await fetch(`${API_BASE}/dispatch/sectors/${sectorId}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Erreur lors de la suppression', 'error');
      return;
    }
    showToast(`Secteur "${sector.name}" supprimé`, 'success');
    await loadSectors();
    renderSectorManageList();
  } catch (e) {
    console.error('[Sectors] Delete error:', e);
    showToast('Erreur réseau', 'error');
  }
}

// ── POI Toggle ──
let poisVisible = true;
function togglePOIs() {
  poisVisible = !poisVisible;
  const btn = document.getElementById('btnTogglePoi');
  if (window._poiMarkers) {
    window._poiMarkers.forEach(m => {
      if (poisVisible) m.addTo(dispatchMap);
      else dispatchMap.removeLayer(m);
    });
  }
  if (btn) {
    btn.style.opacity = poisVisible ? '1' : '0.5';
    btn.title = poisVisible ? 'Masquer les points d\'intérêt' : 'Afficher les points d\'intérêt';
  }
}

// ── POI Quick Select for Incident Creation ──
function selectPOI(name, lat, lng) {
  document.getElementById('incidentAddress').value = name;
  document.getElementById('incidentLat').value = lat;
  document.getElementById('incidentLng').value = lng;
}


// ═══════════════════════════════════════════════════════════════════════════
// ── Patrol Reports ──────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

let activePatrolRounds = [];
let patrolDetailMap = null; // Leaflet instance for the round map inside showPatrolDetail's modal
const patrolRoundLayers = {}; // roundId -> { marker, trailPolyline, checkpointCircles: [], checkpointMarkers: [] }

function checkpointDivIcon(dwellMet) {
  const color = dwellMet ? '#22c55e' : '#3b82f6';
  return L.divIcon({
    className: 'patrol-checkpoint-marker',
    html: `<div style="background:#fff;border:2px solid ${color};border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:10px;">${dwellMet ? '✓' : '📍'}</div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  });
}

// Adds (once) or updates the Leaflet layers for one active round on the main
// dispatch map: checkpoint circles+markers (positions are fixed for the
// round's lifetime, only their color/icon changes), a growing trail
// polyline, and the responder's own marker — moved via setLatLng
// (incremental), not a remove-and-redraw, so it stays smooth as pings
// arrive. Mirrors the live-move pattern already used for updateUserMarkers.
function updatePatrolRoundMapLayers(round) {
  if (!dispatchMap) return;
  let layers = patrolRoundLayers[round.id];
  if (!layers) {
    layers = { marker: null, trailPolyline: null, checkpointCircles: [], checkpointMarkers: [] };
    patrolRoundLayers[round.id] = layers;
    (round.checkpoints || []).forEach(cp => {
      const circle = L.circle([cp.latitude, cp.longitude], {
        radius: cp.radiusMeters,
        color: cp.dwellMet ? '#22c55e' : '#3b82f6',
        fillColor: cp.dwellMet ? '#22c55e' : '#3b82f6',
        fillOpacity: 0.15,
        weight: 2,
      }).addTo(dispatchMap);
      circle._checkpointId = cp.checkpointId;
      const marker = L.marker([cp.latitude, cp.longitude], { icon: checkpointDivIcon(cp.dwellMet) }).addTo(dispatchMap);
      marker._checkpointId = cp.checkpointId;
      layers.checkpointCircles.push(circle);
      layers.checkpointMarkers.push(marker);
    });
    layers.trailPolyline = L.polyline([], { color: '#1e3a5f', weight: 3 }).addTo(dispatchMap);
  }

  if (round.trail && round.trail.length) {
    layers.trailPolyline.setLatLngs(round.trail.map(p => [p.latitude, p.longitude]));
  }

  const loc = round.lastLocation;
  if (loc) {
    if (!layers.marker) {
      layers.marker = L.marker([loc.latitude, loc.longitude], {
        icon: L.divIcon({
          className: 'patrol-responder-marker',
          html: '<div style="background:#059669;color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 1px 4px rgba(0,0,0,0.4);">🚶</div>',
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
      }).addTo(dispatchMap);
      layers.marker.bindPopup(`<b>${escapeHtml(round.responderName)}</b><br>${escapeHtml(round.siteName)}`);
    } else {
      layers.marker.setLatLng([loc.latitude, loc.longitude]);
    }
  }

  (round.checkpoints || []).forEach(cp => {
    const circle = layers.checkpointCircles.find(c => c._checkpointId === cp.checkpointId);
    const marker = layers.checkpointMarkers.find(m => m._checkpointId === cp.checkpointId);
    const color = cp.dwellMet ? '#22c55e' : '#3b82f6';
    if (circle) circle.setStyle({ color, fillColor: color });
    if (marker) marker.setIcon(checkpointDivIcon(cp.dwellMet));
  });
}

function refreshPatrolRoundMapLayers() {
  if (!dispatchMap) return;
  Object.keys(patrolRoundLayers).forEach(id => {
    if (!activePatrolRounds.find(r => r.id === id)) removePatrolRoundMapLayers(id);
  });
  activePatrolRounds.forEach(round => updatePatrolRoundMapLayers(round));
}

function removePatrolRoundMapLayers(roundId) {
  const layers = patrolRoundLayers[roundId];
  if (!layers) return;
  if (dispatchMap) {
    if (layers.marker) dispatchMap.removeLayer(layers.marker);
    if (layers.trailPolyline) dispatchMap.removeLayer(layers.trailPolyline);
    layers.checkpointCircles.forEach(c => dispatchMap.removeLayer(c));
    layers.checkpointMarkers.forEach(m => dispatchMap.removeLayer(m));
  }
  delete patrolRoundLayers[roundId];
}

// "Rondes en cours" status list on the Rondes tab (the live map itself lives
// on the Map tab, where dispatchMap already renders every other live layer).
function renderActivePatrolRounds() {
  const panel = document.getElementById('activePatrolRoundsPanel');
  const list = document.getElementById('activePatrolRoundsList');
  if (!panel || !list) return;
  if (activePatrolRounds.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  list.innerHTML = activePatrolRounds.map(round => {
    const total = (round.checkpoints || []).length;
    const done = (round.checkpoints || []).filter(c => c.dwellMet).length;
    return `
      <div class="patrol-round-item">
        <div>
          <b>${escapeHtml(round.responderName)}</b> — ${escapeHtml(round.siteName)}
          <div style="font-size:12px;color:var(--text-secondary);">
            ${total > 0 ? `${done} / ${total} checkpoints validés` : 'Aucun checkpoint configuré'} · depuis ${new Date(round.startedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ─── Post-round "next location" navigation (live) ──────────────────────────
// A responder can only navigate to one place at a time, so this is keyed by
// responderId (unlike activePatrolRounds' roundId) — same live/reconnect-
// snapshot model, though, and the map layers follow the exact incremental
// add/update/remove pattern used above for round layers.
let activeResponderRoutes = [];
const patrolRouteLayers = {}; // responderId -> { polyline, originMarker, destMarker }

function updatePatrolRouteMapLayers(route) {
  if (!dispatchMap || !Array.isArray(route.geometry) || route.geometry.length === 0) return;
  let layers = patrolRouteLayers[route.responderId];
  const origin = route.geometry[0];
  const dest = route.geometry[route.geometry.length - 1];
  if (!layers) {
    layers = {
      // Dashed + a distinct blue so a live route reads differently from a
      // round's solid trail on the same map.
      polyline: L.polyline(route.geometry.map(p => [p.latitude, p.longitude]), {
        color: '#2563eb', weight: 4, dashArray: '8,6',
      }).addTo(dispatchMap),
      originMarker: L.circleMarker([origin.latitude, origin.longitude], {
        radius: 6, color: '#2563eb', fillColor: '#2563eb', fillOpacity: 1,
      }).addTo(dispatchMap),
      destMarker: L.marker([dest.latitude, dest.longitude], {
        icon: L.divIcon({
          className: 'patrol-route-dest-marker',
          html: '<div style="background:#2563eb;color:#fff;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;">🏁</div>',
          iconSize: [22, 22],
          iconAnchor: [11, 11],
        }),
      }).addTo(dispatchMap),
    };
    layers.destMarker.bindPopup(
      `<b>${escapeHtml(route.responderName)}</b><br>→ ${escapeHtml(route.toSiteName)}<br><span style="font-size:11px;color:#6b7280;">${escapeHtml(route.rationale || '')}</span>`
    );
    patrolRouteLayers[route.responderId] = layers;
  } else {
    layers.polyline.setLatLngs(route.geometry.map(p => [p.latitude, p.longitude]));
  }
}

function refreshPatrolRouteMapLayers() {
  if (!dispatchMap) return;
  Object.keys(patrolRouteLayers).forEach(id => {
    if (!activeResponderRoutes.find(r => r.responderId === id)) removePatrolRouteMapLayers(id);
  });
  activeResponderRoutes.forEach(route => updatePatrolRouteMapLayers(route));
}

function removePatrolRouteMapLayers(responderId) {
  const layers = patrolRouteLayers[responderId];
  if (!layers) return;
  if (dispatchMap) {
    dispatchMap.removeLayer(layers.polyline);
    dispatchMap.removeLayer(layers.originMarker);
    dispatchMap.removeLayer(layers.destMarker);
  }
  delete patrolRouteLayers[responderId];
}

// "Trajets en cours" status list on the Rondes tab, same visual language as
// "Rondes en cours" above — the live map layers themselves render on the Map
// tab where dispatchMap lives, matching every other live layer in this app.
function renderActiveResponderRoutes() {
  const panel = document.getElementById('activeRoutesPanel');
  const list = document.getElementById('activeRoutesList');
  if (!panel || !list) return;
  if (activeResponderRoutes.length === 0) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  list.innerHTML = activeResponderRoutes.map(route => {
    const km = ((route.distanceMeters || 0) / 1000).toFixed(1);
    const mins = Math.round((route.durationSeconds || 0) / 60);
    return `
      <div class="patrol-round-item">
        <div>
          <b>${escapeHtml(route.responderName)}</b> → ${escapeHtml(route.toSiteName)}
          <div style="font-size:12px;color:var(--text-secondary);">
            ${km} km · ~${mins} min · ${route.mode === 'walking' ? 'à pied' : 'en véhicule'}
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${escapeHtml(route.rationale || '')}</div>
        </div>
      </div>
    `;
  }).join('');
}

let patrolReports = [];
let patrolFilter = 'all';
let patrolAgentFilter = '';
let patrolDateFrom = '';
let patrolDateTo = '';

const PATROL_STATUS_CONFIG = {
  habituel:       { label: 'Habituel',       color: '#22C55E', textColor: '#fff' },
  inhabituel:     { label: 'Inhabituel',     color: '#EAB308', textColor: '#000' },
  identification: { label: 'Identification', color: '#F97316', textColor: '#fff' },
  suspect:        { label: 'Suspect',        color: '#EF4444', textColor: '#fff' },
  menace:         { label: 'Menace',         color: '#8B5CF6', textColor: '#fff' },
  attaque:        { label: 'Attaque',        color: '#000000', textColor: '#fff' },
};

async function refreshPatrolReports() {
  try {
    const res = await fetch(`${API_BASE}/api/patrol/reports?role=admin`);
    if (!res.ok) throw new Error('Failed to fetch patrol reports');
    const data = await res.json();
    patrolReports = data.reports || [];
    populatePatrolAgentFilter();
    renderPatrolReports();
    updatePatrolStats();
  } catch (err) {
    console.error('[Patrol] Refresh error:', err);
  }
  try {
    const covRes = await fetch(`${API_BASE}/api/patrol/coverage`);
    if (covRes.ok) {
      const covData = await covRes.json();
      renderPatrolCoverage(covData.sites || []);
    }
  } catch (err) {
    console.error('[Patrol] Coverage refresh error:', err);
  }
}

function populatePatrolAgentFilter() {
  const select = document.getElementById('patrolAgentFilter');
  if (!select) return;
  const current = select.value;
  const agents = [...new Set(patrolReports.map(r => r.createdByName || r.createdBy).filter(Boolean))].sort();
  select.innerHTML = '<option value="">Tous les agents</option>' +
    agents.map(a => `<option value="${a}">${a}</option>`).join('');
  if (agents.includes(current)) select.value = current;
}

function applyPatrolFilters() {
  patrolAgentFilter = document.getElementById('patrolAgentFilter')?.value || '';
  patrolDateFrom = document.getElementById('patrolDateFrom')?.value || '';
  patrolDateTo = document.getElementById('patrolDateTo')?.value || '';
  renderPatrolReports();
}

function filterPatrolReports(status) {
  patrolFilter = status;
  // Update chip active state
  document.querySelectorAll('#tab-patrol .chip').forEach(chip => {
    const chipStatus = chip.getAttribute('onclick')?.match(/'(\w+)'/)?.[1] || 'all';
    chip.classList.toggle('active', chipStatus === status);
  });
  renderPatrolReports();
}

function getFilteredPatrolReports() {
  let filtered = patrolFilter === 'all'
    ? patrolReports
    : patrolReports.filter(r => r.status === patrolFilter);
  if (patrolAgentFilter) {
    filtered = filtered.filter(r => (r.createdByName || r.createdBy) === patrolAgentFilter);
  }
  if (patrolDateFrom) {
    const fromTs = new Date(patrolDateFrom + 'T00:00:00').getTime();
    filtered = filtered.filter(r => r.createdAt >= fromTs);
  }
  if (patrolDateTo) {
    const toTs = new Date(patrolDateTo + 'T23:59:59').getTime();
    filtered = filtered.filter(r => r.createdAt <= toTs);
  }
  return filtered;
}

function renderPatrolReports() {
  const grid = document.getElementById('patrolReportsGrid');
  if (!grid) return;

  const filtered = getFilteredPatrolReports();

  if (filtered.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>Aucun rapport de ronde</p></div>';
    return;
  }

  grid.innerHTML = filtered.map(report => {
    const sc = PATROL_STATUS_CONFIG[report.status] || PATROL_STATUS_CONFIG.habituel;
    const hasPasOk = (report.tasks || []).some(t => t.result === 'pas_ok');
    const mediaCount = (report.media || []).length;
    const date = new Date(report.createdAt);
    const dateStr = date.toLocaleDateString('fr-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' });

    return `
      <div class="patrol-card" onclick="showPatrolDetail('${report.id}')" style="cursor:pointer;">
        <div class="patrol-card-header">
          <span class="patrol-status-badge" style="background:${sc.color};color:${sc.textColor}">${sc.label}</span>
          <span class="patrol-time">${dateStr} ${timeStr}</span>
        </div>
        <div class="patrol-location">${report.location}</div>
        <div class="patrol-card-footer">
          <span class="patrol-author">${report.createdByName || report.createdBy}</span>
          <div class="patrol-badges">
            ${mediaCount > 0 ? `<span class="patrol-media-badge">${mediaCount} &#x1F4CE;</span>` : ''}
            ${hasPasOk ? '<span class="patrol-pasok-badge">PAS OK</span>' : ''}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderPatrolCoverage(sites) {
  const panel = document.getElementById('patrolCoveragePanel');
  if (!panel) return;
  if (!sites.length) { panel.innerHTML = ''; return; }

  const levelColor = { ok: '#22C55E', warning: '#EAB308', critical: '#EF4444' };
  const levelLabel = { ok: 'OK', warning: 'Attention', critical: 'Critique' };

  panel.innerHTML = `
    <div class="patrol-coverage-title">Couverture par site</div>
    <div class="patrol-coverage-grid">
      ${sites.map(s => {
        const hoursLabel = s.hoursSince === null ? 'Jamais' : `il y a ${s.hoursSince < 1 ? '<1h' : Math.round(s.hoursSince) + 'h'}`;
        return `
        <div class="patrol-coverage-card" style="border-left:4px solid ${levelColor[s.level]}">
          <div class="patrol-coverage-site">${s.location}</div>
          <div class="patrol-coverage-status" style="color:${levelColor[s.level]}">${levelLabel[s.level]} — ${hoursLabel}</div>
        </div>`;
      }).join('')}
    </div>
  `;
}

function exportPatrolReportsCSV() {
  const filtered = getFilteredPatrolReports();
  const header = ['ID', 'Date', 'Site', 'Agent', 'Statut', 'Tâches PAS OK', 'Médias', 'Notes'];
  const rows = filtered.map(r => {
    const pasOkTasks = (r.tasks || []).filter(t => t.result === 'pas_ok').map(t => t.label).join('; ');
    const date = new Date(r.createdAt).toLocaleString('fr-CH');
    const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    return [r.id, date, r.location, r.createdByName || r.createdBy, r.status, pasOkTasks, (r.media || []).length, r.notes || '']
      .map(csvEscape).join(',');
  });
  const csv = [header.map(h => `"${h}"`).join(','), ...rows].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `rondes_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function updatePatrolStats() {
  const total = patrolReports.length;
  const green = patrolReports.filter(r => r.status === 'habituel').length;
  const alerts = patrolReports.filter(r => r.status !== 'habituel').length;
  const pasOk = patrolReports.filter(r => (r.tasks || []).some(t => t.result === 'pas_ok')).length;

  const el = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };
  el('patrolTotalCount', total);
  el('patrolGreenCount', green);
  el('patrolAlertCount', alerts);
  el('patrolPasOkCount', pasOk);
}

function showPatrolDetail(reportId) {
  const report = patrolReports.find(r => r.id === reportId);
  if (!report) return;

  const sc = PATROL_STATUS_CONFIG[report.status] || PATROL_STATUS_CONFIG.habituel;
  const date = new Date(report.createdAt);
  const dateStr = date.toLocaleDateString('fr-CH', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' });

  let html = `
    <div class="patrol-detail-status" style="background:${sc.color};color:${sc.textColor};padding:8px 16px;border-radius:8px;display:inline-block;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:12px;">${sc.label}</div>
    <div class="patrol-detail-id" style="color:#9ca3af;font-size:12px;margin-bottom:16px;">R\u00e9f: ${formatIncidentId(report.id)}</div>

    <div class="patrol-detail-info" style="background:#f9fafb;border-radius:10px;padding:14px;margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#6b7280;">Date et heure</span>
        <span style="font-weight:600;">${dateStr} à ${timeStr}</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="color:#6b7280;">Lieu</span>
        <span style="font-weight:600;">${report.location}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span style="color:#6b7280;">Créé par</span>
        <span style="font-weight:600;">${report.createdByName || report.createdBy}</span>
      </div>
    </div>

  `;

  // GPS round: map (trail + checkpoints) + per-checkpoint outcome
  if (report.checkpoints && report.checkpoints.length > 0) {
    html += `<h4 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#374151;margin-bottom:8px;">Ronde GPS${report.roundStatus === 'interrupted' ? ' (interrompue)' : ''}</h4>`;
    if (report.interruptReason) {
      html += `<div style="background:#fef2f2;border-radius:10px;padding:12px;margin-bottom:12px;color:#991b1b;"><b>Motif de l'interruption :</b> ${escapeHtml(report.interruptReason)}</div>`;
    }
    if (report.trail && report.trail.length > 0) {
      html += `<div id="patrolDetailMap" style="height:280px;border-radius:10px;margin-bottom:12px;"></div>`;
    }
    html += '<div style="background:#f9fafb;border-radius:10px;padding:14px;margin-bottom:16px;">';
    report.checkpoints.forEach((cp, idx) => {
      const badgeColor = cp.dwellMet ? '#22c55e' : '#ef4444';
      const badgeBg = cp.dwellMet ? '#f0fdf4' : '#fef2f2';
      const badgeText = cp.dwellMet ? '✓ Validé' : cp.visited ? 'Temps insuffisant' : 'Manqué';
      html += `
        ${idx > 0 ? '<hr style="border:none;border-top:1px solid #e5e7eb;margin:8px 0;">' : ''}
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#374151;">${escapeHtml(cp.name)}</span>
          <span style="background:${badgeBg};color:${badgeColor};padding:2px 10px;border-radius:6px;font-size:12px;font-weight:700;">${badgeText}</span>
        </div>
      `;
    });
    html += '</div>';
  }

  if (report.tasks && report.tasks.length > 0) {
  html += `
    <h4 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#374151;margin-bottom:8px;">Tâches</h4>
    <div style="background:#f9fafb;border-radius:10px;padding:14px;margin-bottom:16px;">
  `;

  report.tasks.forEach((task, idx) => {
    const isOk = task.result === 'ok';
    const badgeColor = isOk ? '#22c55e' : '#ef4444';
    const badgeBg = isOk ? '#f0fdf4' : '#fef2f2';
    const badgeText = isOk ? 'OK' : 'PAS OK';
    html += `
      ${idx > 0 ? '<hr style="border:none;border-top:1px solid #e5e7eb;margin:8px 0;">' : ''}
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#374151;">${task.label}</span>
        <span style="background:${badgeBg};color:${badgeColor};padding:2px 10px;border-radius:6px;font-size:12px;font-weight:700;">${badgeText}</span>
      </div>
      ${task.comment ? `<div style="color:#6b7280;font-style:italic;font-size:13px;margin-top:4px;">${task.comment}</div>` : ''}
    `;
  });

  html += '</div>';
  }

  // Media attachments
  if (report.media && report.media.length > 0) {
    html += `<h4 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#374151;margin-bottom:8px;">Pièces jointes (${report.media.length})</h4>`;
    html += '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">';
    report.media.forEach(media => {
      const mediaUrl = media.url.startsWith('http') ? media.url : API_BASE + media.url;
      if (media.type === 'photo') {
        html += `<a href="${mediaUrl}" target="_blank" style="display:block;width:120px;height:120px;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
          <img src="${mediaUrl}" style="width:100%;height:100%;object-fit:cover;" />
        </a>`;
      } else {
        html += `<a href="${mediaUrl}" target="_blank" style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:120px;height:120px;border-radius:8px;background:#1e293b;color:#94a3b8;text-decoration:none;border:1px solid #334155;">
          <span style="font-size:28px;">&#x1F3AC;</span>
          <span style="font-size:10px;margin-top:4px;text-align:center;padding:0 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;">${media.filename}</span>
        </a>`;
      }
    });
    html += '</div>';
  }

  // Notes
  if (report.notes) {
    html += `
      <h4 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#374151;margin-bottom:8px;">Notes</h4>
      <div style="background:#f9fafb;border-radius:10px;padding:14px;color:#374151;line-height:1.5;">${report.notes}</div>
    `;
  }

  // Escalation to a real incident, for non-routine reports only
  if (report.status !== 'habituel') {
    html += report.escalatedIncidentId
      ? `<div style="margin-top:16px;padding:12px;background:#eff6ff;border-radius:10px;color:#1e3a8a;font-weight:600;">→ Incident ${formatIncidentId(report.escalatedIncidentId)}</div>`
      : `<button class="btn btn-danger" style="width:100%;margin-top:16px;" onclick="escalatePatrolReport('${report.id}')">&#x1F6A8; Créer un incident</button>`;
  }

  const content = document.getElementById('patrolDetailContent');
  if (content) content.innerHTML = html;

  const modal = document.getElementById('patrolDetailModal');
  if (modal) modal.style.display = 'flex';

  // The map container div only exists once innerHTML above has run, so this
  // has to happen after — and any previous report's map instance (tied to
  // now-replaced DOM nodes) needs tearing down first.
  if (patrolDetailMap) { patrolDetailMap.remove(); patrolDetailMap = null; }
  if (report.trail && report.trail.length > 0) {
    setTimeout(() => {
      const mapEl = document.getElementById('patrolDetailMap');
      if (!mapEl) return;
      patrolDetailMap = L.map('patrolDetailMap', {
        center: [report.trail[0].latitude, report.trail[0].longitude],
        zoom: 16,
      });
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      const tiles = isLight
        ? 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png'
        : 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
      L.tileLayer(tiles, { subdomains: 'abcd', maxZoom: 19 }).addTo(patrolDetailMap);

      const trailLatLngs = report.trail.map(p => [p.latitude, p.longitude]);
      const trailLine = L.polyline(trailLatLngs, { color: '#1e3a5f', weight: 3 }).addTo(patrolDetailMap);
      const bounds = trailLine.getBounds();

      (report.checkpoints || []).forEach(cp => {
        const color = cp.dwellMet ? '#22c55e' : '#ef4444';
        L.circle([cp.latitude, cp.longitude], {
          radius: cp.radiusMeters, color, fillColor: color, fillOpacity: 0.15, weight: 2,
        }).addTo(patrolDetailMap);
        L.marker([cp.latitude, cp.longitude], {
          icon: L.divIcon({
            className: 'patrol-checkpoint-marker',
            html: `<div style="background:#fff;border:2px solid ${color};border-radius:50%;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:11px;">${cp.dwellMet ? '✓' : '✕'}</div>`,
            iconSize: [20, 20], iconAnchor: [10, 10],
          }),
        }).addTo(patrolDetailMap).bindPopup(`<b>${escapeHtml(cp.name)}</b><br>${cp.dwellMet ? 'Validé' : cp.visited ? 'Temps insuffisant' : 'Manqué'}`);
        bounds.extend([cp.latitude, cp.longitude]);
      });

      patrolDetailMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 18 });
      setTimeout(() => patrolDetailMap && patrolDetailMap.invalidateSize(), 100);
    }, 50);
  }
}

async function escalatePatrolReport(reportId) {
  try {
    const res = await fetch(`${API_BASE}/api/patrol/reports/${reportId}/escalate-to-incident`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || 'Échec de l\'escalade', 'error');
      return;
    }
    showToast(`🚨 Incident ${formatIncidentId(data.incidentId)} créé`, 'success');
    await refreshPatrolReports();
    showPatrolDetail(reportId);
  } catch (err) {
    console.error('[Patrol] Escalation failed:', err);
    showToast('Échec de l\'escalade', 'error');
  }
}

function closePatrolDetailModal() {
  const modal = document.getElementById('patrolDetailModal');
  if (modal) modal.style.display = 'none';
  if (patrolDetailMap) { patrolDetailMap.remove(); patrolDetailMap = null; }
}

// Initial load of patrol reports
setTimeout(refreshPatrolReports, 2000);
// Auto-refresh every 30s
setInterval(refreshPatrolReports, 30000);


// ═══════════════════════════════════════════════════════════════════════════
// PTT — Dispatch Console Logic
// ═══════════════════════════════════════════════════════════════════════════

let pttChannels = [];
let pttCurrentChannel = null;
let pttRoom = null; // LiveKit Room instance
let pttConnected = false;
let pttTransmitting = false;
let pttAllUsersCache = null; // for group-creation member picker

const PTT_CHANNEL_ICONS = { emergency: '🚨', dispatch: '📡', responders: '👮', general: '📻' };
function pttChannelIcon(ch) {
  if (PTT_CHANNEL_ICONS[ch.id]) return PTT_CHANNEL_ICONS[ch.id];
  if (ch.id.startsWith('family-')) return '🏠';
  if (ch.id.startsWith('direct-')) return '📞';
  if (ch.id.startsWith('custom-')) return '👥';
  return '📻';
}

async function loadPTTChannels() {
  try {
    const res = await fetch(`${API_BASE}/api/ptt/channels`);
    if (!res.ok) throw new Error('Failed to load channels');
    pttChannels = await res.json();
    renderPTTChannels();
  } catch (e) {
    console.error('[PTT] Error loading channels:', e);
  }
}

function renderPTTChannels() {
  const container = document.getElementById('pttChannelList');
  if (!container) return;
  if (pttChannels.length === 0) {
    container.innerHTML = '<div class="empty-state">Aucun canal disponible</div>';
    return;
  }
  container.innerHTML = pttChannels.map(ch => {
    const isSelected = pttCurrentChannel && pttCurrentChannel.id === ch.id;
    return `<div class="ptt-channel-item ${isSelected ? 'active' : ''}" onclick='selectPTTChannel(${JSON.stringify(ch)})'>
      <span class="ptt-channel-icon">${pttChannelIcon(ch)}</span>
      <div class="ptt-channel-info">
        <div class="ptt-channel-name">${escapeHtml(ch.name)}</div>
        <div class="ptt-channel-desc">${escapeHtml(ch.description || '')}</div>
      </div>
    </div>`;
  }).join('');
}

async function selectPTTChannel(channel) {
  if (pttRoom) await disconnectPTTRoom();

  pttCurrentChannel = channel;
  renderPTTChannels();

  const el = document.getElementById('pttCurrentChannel');
  if (el) el.textContent = channel.name;

  const btn = document.getElementById('pttRecordBtn');
  if (btn) { btn.disabled = true; btn.innerHTML = '⏳ Connexion...'; }

  const messagesEl = document.getElementById('pttMessages');
  if (messagesEl) messagesEl.innerHTML = '<div class="empty-state">⏳ Connexion au canal...</div>';

  try {
    const tokenRes = await fetch(`${API_BASE}/api/livekit/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName: channel.id }),
    });
    if (!tokenRes.ok) throw new Error((await tokenRes.json()).error || 'Token error');
    const { token, url } = await tokenRes.json();

    if (typeof LivekitClient === 'undefined') {
      throw new Error('LiveKit non chargé (script CDN bloqué ou hors ligne)');
    }

    pttRoom = new LivekitClient.Room();

    pttRoom.on(LivekitClient.RoomEvent.Connected, () => {
      pttConnected = true;
      if (btn) { btn.disabled = false; btn.innerHTML = '🎙 MAINTENIR POUR PARLER'; }
      if (messagesEl) messagesEl.innerHTML = `<div class="empty-state">✅ Connecté à ${escapeHtml(channel.name)}</div>`;
      updatePTTAudioBlockedBanner();
    });
    pttRoom.on(LivekitClient.RoomEvent.AudioPlaybackStatusChanged, () => {
      updatePTTAudioBlockedBanner();
    });
    pttRoom.on(LivekitClient.RoomEvent.Disconnected, () => {
      pttConnected = false;
      if (messagesEl) messagesEl.innerHTML = '<div class="empty-state">Déconnecté</div>';
    });
    pttRoom.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const indicator = document.getElementById('pttTalkingIndicator');
      const nameEl = document.getElementById('pttTalkingName');
      if (!indicator || !nameEl) return;
      if (speakers.length === 0) {
        indicator.style.display = 'none';
      } else {
        indicator.style.display = 'flex';
        nameEl.textContent = speakers.map(s => s.name || s.identity).join(', ');
      }
    });
    // autoSubscribe just delivers the remote track to the browser - nothing
    // plays it until it's attached to a media element. Without this, PTT
    // audio from other participants (mobile app, other dispatchers) never
    // makes it out of the speakers even though the connection is otherwise
    // fully working.
    pttRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      console.log(`[PTT] TrackSubscribed: kind=${track.kind} from ${participant?.identity}`);
      if (track.kind !== 'audio') return;
      try {
        const audioEl = track.attach();
        audioEl.id = `ptt-audio-${track.sid}`;
        audioEl.style.display = 'none';
        document.body.appendChild(audioEl);
        console.log(`[PTT] Audio element attached for track ${track.sid}`);
      } catch (e) {
        console.error('[PTT] Failed to attach audio track:', e);
        showToast(`Erreur lecture audio PTT: ${e.message || e}`, 'error');
      }
    });
    pttRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach(el => el.remove());
    });

    await pttRoom.connect(url, token, { autoSubscribe: true });
    await pttRoom.localParticipant.setMicrophoneEnabled(false);
  } catch (e) {
    console.error('[PTT] Connect error:', e);
    showToast(`Erreur de connexion au canal PTT: ${e.message || e}`, 'error');
    if (messagesEl) messagesEl.innerHTML = `<div class="empty-state">Erreur de connexion${e.message ? ': ' + escapeHtml(e.message) : ''}</div>`;
    if (btn) { btn.disabled = true; btn.innerHTML = '🎙 MAINTENIR POUR PARLER'; }
  }
}

async function disconnectPTTRoom() {
  if (pttRoom) {
    await pttRoom.disconnect();
    pttRoom = null;
  }
  pttConnected = false;
  pttTransmitting = false;
  const banner = document.getElementById('pttAudioBlockedBanner');
  if (banner) banner.style.display = 'none';
}

// Browsers block audio autoplay until the page has had a user gesture. LiveKit
// detects this per-track (canPlaybackAudio) and only resumes it via startAudio(),
// which must be called from inside a real click handler. Without this, incoming
// PTT audio can be silently blocked with no visible error at all.
function updatePTTAudioBlockedBanner() {
  const banner = document.getElementById('pttAudioBlockedBanner');
  if (!banner) return;
  banner.style.display = (pttRoom && !pttRoom.canPlaybackAudio) ? 'flex' : 'none';
}

async function enablePTTAudio() {
  if (!pttRoom) return;
  try {
    await pttRoom.startAudio();
  } catch (e) {
    console.error('[PTT] startAudio error:', e);
  }
  updatePTTAudioBlockedBanner();
}

async function startDispatchPTT() {
  if (!pttRoom || !pttConnected || pttTransmitting) return;
  try {
    await pttRoom.localParticipant.setMicrophoneEnabled(true);
    pttTransmitting = true;
    const btn = document.getElementById('pttRecordBtn');
    if (btn) { btn.classList.add('recording'); btn.innerHTML = '🔴 EN COURS...'; }
  } catch (e) {
    console.error('[PTT] Microphone error:', e);
    showToast('Erreur: accès au microphone refusé', 'error');
  }
}

async function stopDispatchPTT() {
  if (!pttRoom || !pttTransmitting) return;
  try {
    await pttRoom.localParticipant.setMicrophoneEnabled(false);
  } catch (e) {
    console.error('[PTT] Stop transmit error:', e);
  }
  pttTransmitting = false;
  const btn = document.getElementById('pttRecordBtn');
  if (btn) { btn.classList.remove('recording'); btn.innerHTML = '🎙 MAINTENIR POUR PARLER'; }
}

async function toggleDispatchEmergency() {
  if (!confirm('Déclencher l\'alerte d\'urgence PTT pour tout le monde ?')) return;
  try {
    const res = await fetch(`${API_BASE}/api/ptt/emergency`, { method: 'POST' });
    if (!res.ok) throw new Error('failed');
    showToast('Alerte urgence déclenchée', 'success');
  } catch (e) {
    showToast('Erreur lors du déclenchement de l\'urgence', 'error');
  }
}

function joinEmergencyChannel() {
  dismissDispatchEmergency();
  const emergencyChannel = pttChannels.find(c => c.id === 'emergency');
  if (emergencyChannel) selectPTTChannel(emergencyChannel);
}

function dismissDispatchEmergency() {
  const banner = document.getElementById('pttEmergencyBanner');
  if (banner) banner.style.display = 'none';
}

// ─── Direct PTT Call ──────────────────────────────────────────────────────
async function showDirectPTTCall() {
  const modal = document.getElementById('pttDirectModal');
  if (!modal) return;
  modal.style.display = 'flex';
  const listEl = document.getElementById('pttDirectUserList');
  if (!listEl) return;
  listEl.innerHTML = '<div class="empty-state">Chargement...</div>';
  try {
    const res = await fetch(`${API_BASE}/admin/users`);
    if (!res.ok) throw new Error('Failed');
    const allUsers = await res.json();
    const available = allUsers.filter(u => u.status !== 'deactivated');
    if (available.length === 0) {
      listEl.innerHTML = '<div class="empty-state">Aucun utilisateur disponible</div>';
      return;
    }
    const roleIcons = { admin: '👑', dispatcher: '📡', responder: '🛡️', user: '👤' };
    listEl.innerHTML = available.map(u => {
      const icon = roleIcons[u.role] || '👤';
      const name = u.name || u.id;
      return `<div class="ptt-direct-user-item" onclick="initiateDirectPTTCall('${u.id}', '${name.replace(/'/g, "\\'")}')">
        <span class="ptt-direct-user-icon">${icon}</span>
        <div class="ptt-direct-user-info">
          <div class="ptt-direct-user-name">${escapeHtml(name)}</div>
          <div class="ptt-direct-user-role">${u.role}</div>
        </div>
        <span class="ptt-direct-call-icon">📞</span>
      </div>`;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<div class="empty-state">Erreur de chargement</div>';
  }
}

function closePTTDirectModal() {
  const modal = document.getElementById('pttDirectModal');
  if (modal) modal.style.display = 'none';
}

async function initiateDirectPTTCall(targetUserId, targetUserName) {
  closePTTDirectModal();
  showToast(`Création du canal direct avec ${targetUserName}...`, 'info');
  try {
    const res = await fetch(`${API_BASE}/api/ptt/channels/direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId2: targetUserId }),
    });
    if (!res.ok) throw new Error('Failed to create direct channel');
    const channel = await res.json();
    if (!pttChannels.find(c => c.id === channel.id)) pttChannels.push(channel);
    renderPTTChannels();
    selectPTTChannel(channel);
    showToast(`Canal direct avec ${targetUserName} prêt`, 'success');
  } catch (e) {
    console.error('[PTT] Direct call error:', e);
    showToast('Erreur lors de la création du canal direct', 'error');
  }
}

// ─── Group PTT Channel (dispatch decides the members) ──────────────────────
async function showCreatePTTGroup() {
  const modal = document.getElementById('pttGroupModal');
  if (modal) modal.style.display = 'flex';
  if (!pttAllUsersCache) {
    try {
      const res = await fetch(`${API_BASE}/api/users`);
      pttAllUsersCache = res.ok ? await res.json() : [];
    } catch (e) {
      pttAllUsersCache = [];
    }
  }
  document.getElementById('pttGroupMemberSearch').value = '';
  renderPTTGroupMemberList();
}

function closePTTGroupModal() {
  const modal = document.getElementById('pttGroupModal');
  if (modal) modal.style.display = 'none';
}

function renderPTTGroupMemberList() {
  const container = document.getElementById('pttGroupMemberList');
  if (!container) return;
  const query = (document.getElementById('pttGroupMemberSearch')?.value || '').trim().toLowerCase();
  const list = (pttAllUsersCache || []).filter(u => !query || u.name.toLowerCase().includes(query));
  container.innerHTML = list.map(u => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;">
      <input type="checkbox" value="${u.id}" class="ptt-group-member-check">
      <span>${escapeHtml(u.name)} <span style="color:var(--text-muted);font-size:12px;">(${u.role})</span></span>
    </label>`).join('');
}

async function createDispatchPTTGroup() {
  const name = document.getElementById('pttGroupName')?.value?.trim();
  const desc = document.getElementById('pttGroupDesc')?.value?.trim();
  if (!name) { showToast('Veuillez saisir un nom de groupe', 'error'); return; }

  const members = [];
  document.querySelectorAll('#pttGroupMemberList .ptt-group-member-check:checked').forEach(cb => members.push(cb.value));

  try {
    const res = await fetch(`${API_BASE}/api/ptt/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: desc || '', members }),
    });
    if (res.ok) {
      showToast(`Groupe "${name}" créé`, 'success');
      closePTTGroupModal();
      document.getElementById('pttGroupName').value = '';
      document.getElementById('pttGroupDesc').value = '';
      loadPTTChannels();
    } else {
      const err = await res.json();
      showToast(err.error || 'Erreur de création', 'error');
    }
  } catch (e) {
    showToast('Erreur réseau', 'error');
  }
}

/// Initial load of PTT channels after a delay
setTimeout(() => { loadPTTChannels(); }, 3000);

// ─── Initialize AudioContext on first user gesture ────────────────────────
document.addEventListener('click', function initAudioOnClick() {
  if (typeof getAudioContext === 'function') {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(() => {
        console.log('[Audio] AudioContext resumed on user gesture');
      });
    }
  }
}, { once: false });

// ─── Critical Alert Banner ────────────────────────────────────────────────
let alertBannerInterval = null;
let alertBannerQueue = [];
let titleBlinkInterval = null;
let originalTitle = document.title;

function showCriticalAlertBanner(alert) {
  // Add to queue
  alertBannerQueue.push(alert);

  // Create or update banner
  let banner = document.getElementById('criticalAlertBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'criticalAlertBanner';
    banner.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 99999;
      background: linear-gradient(135deg, #dc2626, #991b1b);
      color: white; padding: 12px 20px;
      display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 4px 20px rgba(220,38,38,0.6);
      animation: bannerPulse 1s ease-in-out infinite;
      font-family: system-ui, sans-serif;
    `;
    document.body.appendChild(banner);

    // Add CSS animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes bannerPulse {
        0%, 100% { background: linear-gradient(135deg, #dc2626, #991b1b); }
        50% { background: linear-gradient(135deg, #ef4444, #b91c1c); }
      }
      @keyframes duressBannerPulse {
        0%, 100% { background: repeating-linear-gradient(135deg, #000 0px, #000 20px, #b91c1c 20px, #b91c1c 40px); }
        50% { background: repeating-linear-gradient(135deg, #1a0000 0px, #1a0000 20px, #ef4444 20px, #ef4444 40px); }
      }
    `;
    document.head.appendChild(style);
  }

  const latestAlert = alertBannerQueue[alertBannerQueue.length - 1];
  const count = alertBannerQueue.length;
  const isDuress = !!latestAlert.isDuress;
  banner.style.animation = isDuress ? 'duressBannerPulse 0.6s ease-in-out infinite' : 'bannerPulse 1s ease-in-out infinite';
  banner.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; flex:1;">
      <span style="font-size:24px;">${isDuress ? '🔴' : '🚨'}</span>
      <div>
        <div style="font-size:16px; font-weight:800; letter-spacing:0.5px;">
          ${isDuress ? 'CODE DE CONTRAINTE — SOS "ANNULÉ" SOUS LA CONTRAINTE' : (count > 1 ? count + ' ALERTES ACTIVES' : latestAlert.id || 'NOUVELLE ALERTE')}
        </div>
        <div style="font-size:13px; opacity:0.9;">
          ${latestAlert.location?.address || latestAlert.address || 'Position en cours...'}
          · Signalé par: ${latestAlert.createdBy || latestAlert.reportedBy || 'Inconnu'}
        </div>
      </div>
    </div>
    <div style="display:flex; gap:8px; align-items:center;">
      <button onclick="acknowledgeBannerAlert()" style="
        background:white; color:#dc2626; border:none; border-radius:6px;
        padding:8px 16px; font-weight:700; cursor:pointer; font-size:13px;
      ">✓ ACQUITTER</button>
      ${isDuress ? '' : `
      <button onclick="dismissAlertBanner()" style="
        background:rgba(255,255,255,0.2); color:white; border:none; border-radius:6px;
        padding:8px 12px; font-weight:700; cursor:pointer; font-size:13px;
      ">✕</button>`}
    </div>
  `;

  // Blink page title
  startTitleBlink(latestAlert);

  // Repeat siren every 10s until dismissed — the "✕" silence-only option is
  // hidden above for duress, so only a real acknowledgement (which calls the
  // server) can stop this, not a casual click to make the noise go away.
  if (alertBannerInterval) clearInterval(alertBannerInterval);
  alertBannerInterval = setInterval(() => {
    if (document.getElementById('criticalAlertBanner')) {
      if (latestAlert.isDuress) playDuressAlertSound();
      else playNewAlertSound(latestAlert.type, latestAlert.severity);
    } else {
      clearInterval(alertBannerInterval);
    }
  }, 10000);
}

function startTitleBlink(alert) {
  if (titleBlinkInterval) clearInterval(titleBlinkInterval);
  originalTitle = 'TALION Dispatch';
  let blink = true;
  titleBlinkInterval = setInterval(() => {
    document.title = blink ? `🚨 ${alert.createdBy || 'SOS'} — ALERTE` : originalTitle;
    blink = !blink;
  }, 800);
}

function stopTitleBlink() {
  if (titleBlinkInterval) clearInterval(titleBlinkInterval);
  document.title = originalTitle;
}

function dismissAlertBanner() {
  try { const el = document.getElementById("sosAlertAudio"); if (el) { el.pause(); el.currentTime = 0; } } catch(e) {}
  try { const el = document.getElementById("sirenAlertAudio"); if (el) { el.pause(); el.currentTime = 0; } } catch(e) {}
  const banner = document.getElementById('criticalAlertBanner');
  if (banner) banner.remove();
  if (alertBannerInterval) clearInterval(alertBannerInterval);
  alertBannerQueue = [];
  stopTitleBlink();
}

function acknowledgeBannerAlert() {
  // Acknowledge the latest alert
  if (alertBannerQueue.length > 0) {
    const latest = alertBannerQueue[alertBannerQueue.length - 1];
    if (latest.id) {
      fetch(`${API_BASE}/dispatch/incidents/${encodeURIComponent(latest.id)}/acknowledge`, { method: 'PUT' })
        .catch(() => {});
    }
  }
  dismissAlertBanner();
}
