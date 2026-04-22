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
let incidents = [];
let responders = [];
let broadcastHistory = [];
let currentFilter = 'all';
let currentResponderFilter = 'all';
let selectedBroadcastSeverity = 'medium';
let selectedBroadcastRadius = '5';
let resolveTargetId = null;

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
    // Auth as dispatch-console
    ws.send(JSON.stringify({ type: 'auth', userId: 'dispatch-console', userRole: 'dispatcher' }));
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
        timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0,
        respondingUsers: alert.respondingUsers || [], respondingNames: alert.respondingNames || [],
        respondingDetails: alert.respondingDetails || [],
        photos: alert.photos || [],
        responderStatuses: alert.responderStatuses || {},
        statusHistory: alert.statusHistory || [],
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
        if (typeof getAudioContext === 'function') { const ctx = getAudioContext(); if (ctx && ctx.state === 'suspended') ctx.resume().then(() => playNewAlertSound(alert.type, alert.severity)); else playNewAlertSound(alert.type, alert.severity); } else { playNewAlertSound(alert.type, alert.severity); }
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
      const formatted = {
        id: alert.id, type: alert.type, severity: alert.severity, status: alert.status,
        reportedBy: alert.createdBy, address: alert.location?.address || 'Unknown',
        timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0,
        respondingUsers: alert.respondingUsers || [], respondingNames: alert.respondingNames || [],
        respondingDetails: alert.respondingDetails || [],
        responderStatuses: alert.responderStatuses || {},
        statusHistory: alert.statusHistory || [],
      };
      if (idx >= 0) { incidents[idx] = formatted; } else { incidents.unshift(formatted); }
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

    case 'patrolAlert': {
      const pr = msg.data;
      const sc = PATROL_STATUS_CONFIG[pr.status] || { label: pr.status, color: '#ef4444' };
      showToast(`⚠️ Ronde ${sc.label}: ${pr.location} — ${pr.createdByName}`, 'warning');
      sendBrowserNotification(`Ronde ${sc.label}`, `${pr.createdByName} — ${pr.location}`, 'warning', `patrol-${pr.reportId}`);
      refreshPatrolReports();
      updatePatrolNavBadge();
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
        } else {
          mapUsers.push({
            id: msg.userId,
            name: msg.userId,
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
        showToast(`\uD83D\uDCCD ${msg.userId} shared their location`, 'info');
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

    case 'userStatusChange': {
      // A user came online/offline
      showToast(`👤 User ${msg.userId} is now ${msg.status}`, 'info');
      if (msg.status === 'offline') {
        sendBrowserNotification('User Disconnected', `${msg.userId} went offline`, 'warning', `user-${msg.userId}`);
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

    case 'pttMessage': {
      // Server sends { type: 'pttMessage', data: { id, channelId, senderId, senderName, senderRole, audioBase64, duration, timestamp } }
      const pttData = msg.data || msg;
      const chId = pttData.channelId;
      if (!pttMessages[chId]) pttMessages[chId] = [];
      // Normalize: strip data URL prefix from audioBase64 if present
      let rawAudioIn = pttData.audioBase64 || pttData.audioData || '';
      if (typeof rawAudioIn === 'string' && rawAudioIn.includes(',')) rawAudioIn = rawAudioIn.split(',')[1] || rawAudioIn;
      pttMessages[chId].push({
        id: pttData.id,
        channelId: chId,
        senderId: pttData.senderId,
        senderName: pttData.senderName,
        senderRole: pttData.senderRole,
        audioData: rawAudioIn,
        mimeType: pttData.mimeType || 'audio/webm',
        duration: pttData.duration,
        timestamp: pttData.timestamp ? new Date(pttData.timestamp).toISOString() : new Date().toISOString(),
      });
      if (pttCurrentChannel && pttCurrentChannel.id === chId) renderPTTMessages();
      renderPTTChannels();
      break;
    }

    case 'pttChannelHistory': {
      // Server sends { type: 'pttChannelHistory', channelId, data: [...messages] }
      const histChannelId = msg.channelId;
      const histMsgs = (msg.data || []).map(m => {
        // Normalize: strip data URL prefix if present
        let histRawAudio = m.audioBase64 || m.audioData || '';
        if (typeof histRawAudio === 'string' && histRawAudio.includes(',')) histRawAudio = histRawAudio.split(',')[1] || histRawAudio;
        return {
        id: m.id,
        channelId: m.channelId,
        senderId: m.senderId,
        senderName: m.senderName,
        senderRole: m.senderRole,
        audioData: histRawAudio,
        mimeType: m.mimeType || 'audio/webm',
        duration: m.duration,
        timestamp: m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString(),
      };
      });
      pttMessages[histChannelId] = histMsgs;
      if (pttCurrentChannel && pttCurrentChannel.id === histChannelId) renderPTTMessages();
      break;
    }

    case 'pttTalkingStart': {
      // Server sends { type: 'pttTalkingStart', data: { channelId, userId, userName, userRole } }
      const tData = msg.data || msg;
      const ind = document.getElementById('pttTalkingIndicator');
      const nm = document.getElementById('pttTalkingName');
      const rl = document.getElementById('pttTalkingRole');
      if (pttCurrentChannel && tData.channelId === pttCurrentChannel.id) {
        const roleLabels = { admin: 'ADMIN', dispatcher: 'DISPATCH', responder: 'INTERVENANT', user: 'UTILISATEUR' };
        if (ind) ind.style.display = 'flex';
        if (nm) nm.textContent = `${tData.userName} parle...`;
        if (rl) rl.textContent = roleLabels[tData.userRole] || tData.userRole;
      }
      break;
    }

    case 'pttTalkingStop': {
      const ind2 = document.getElementById('pttTalkingIndicator');
      if (ind2) ind2.style.display = 'none';
      break;
    }

    case 'pttEmergencyMessage': {
      // Server sends { type: 'pttEmergencyMessage', data: { id, senderName, senderRole, audioBase64, ... } }
      const eData = msg.data || msg;
      let emergRawAudio = eData.audioBase64 || eData.audioData || '';
      if (typeof emergRawAudio === 'string' && emergRawAudio.includes(',')) emergRawAudio = emergRawAudio.split(',')[1] || emergRawAudio;
      pttLastEmergencyMsg = { audioData: emergRawAudio, mimeType: eData.mimeType || 'audio/webm', senderName: eData.senderName, senderRole: eData.senderRole };
      const banner = document.getElementById('pttEmergencyBanner');
      const sender = document.getElementById('pttEmergencySender');
      if (banner) banner.style.display = 'flex';
      if (sender) sender.textContent = `${eData.senderName} (${eData.senderRole})`;
      showToast(`\u26a0\ufe0f MESSAGE D'URGENCE de ${eData.senderName}`, 'warning');
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
  const titles = { overview: "Vue d'ensemble", incidents: "Gestion des incidents", responders: "Unités d'intervention", broadcast: "Diffusion", map: "Carte en direct", messages: "Messages", patrol: "Rapports de Ronde", ptt: "Push-to-Talk" };
  document.getElementById('pageTitle').textContent = titles[tab] || tab;
  if (tab === 'map') {
    setTimeout(() => { if (dispatchMap) { dispatchMap.invalidateSize(); } else { initMap(); } }, 100);
  }
  if (tab === 'ptt') {
    loadPTTChannels();
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
  const activeIncs = incidents
    .filter(i => i.status !== 'resolved')
    .sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || b.timestamp - a.timestamp);

  if (activeIncs.length === 0) {
    container.innerHTML = '<div class="ov-empty"><div class="ov-empty-icon">\u2705</div><div class="ov-empty-text">Aucun incident actif</div></div>';
  } else {
    container.innerHTML = activeIncs.map(inc => {
      const assignedCount = inc.assignedCount || (inc.respondingNames || []).length || 0;
      const assignedLabel = assignedCount > 0 ? `<span class="ov-inc-assigned">${assignedCount} unit\u00e9${assignedCount > 1 ? 's' : ''}</span>` : '<span class="ov-inc-unassigned">Non assign\u00e9</span>';
      return `
      <div class="ov-inc-card sev-${inc.severity}" onclick="openDetailModal('${inc.id}')">
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
function renderIncidents() {
  const container = document.getElementById('incidentsList');
  let filtered = incidents;
  if (currentFilter === 'all') {
    filtered = incidents.filter(i => i.status !== 'resolved');
  } else {
    filtered = incidents.filter(i => i.status === currentFilter);
  }
  filtered.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3) || b.timestamp - a.timestamp);

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">✅</div><p>No incidents matching this filter</p></div>';
    return;
  }

  container.innerHTML = filtered.map(inc => {
    const names = inc.respondingNames || [];
    const assignedChips = names.length > 0
      ? `<div class="inc-assigned"><span class="inc-assigned-label">Assign\u00e9s:</span>${names.map(n => `<span class="assigned-chip assigned-name-chip">${n}</span>`).join('')}</div>`
      : (inc.assignedCount > 0 ? `<div class="inc-assigned"><span class="inc-assigned-label">Assign\u00e9s:</span><span class="assigned-chip">${inc.assignedCount} responder(s)</span></div>` : '');

    return `
      <div class="incident-card sev-${inc.severity}" style="cursor:pointer;" onclick="openDetailModal('${inc.id}')">
        <div class="inc-header">
          <div class="inc-header-left">
            <span class="inc-type-icon">${TYPE_ICONS[inc.type] || '🚨'}</span>
            <div class="inc-info">
        <h4>${inc.id.includes(' \u2014 ') ? inc.id : formatIncidentId(inc.id) + ' \u2014 ' + typeLabel(inc.type)}</h4>
              <span class="inc-address">\ud83d\udccd ${inc.address}</span>         </div>
          </div>
          <div class="inc-badges">
            <span class="badge badge-${inc.severity}">${sevLabel(inc.severity)}</span>
            <span class="badge badge-${inc.status}">${statusLabel(inc.status)}</span>
          </div>
        </div>
        <div class="inc-desc">Signal\u00e9 par: ${inc.reportedBy}${(inc.photos && inc.photos.length > 0) ? ` \u00b7 \ud83d\udcf7 ${inc.photos.length} photo${inc.photos.length > 1 ? 's' : ''}` : ''}</div>
        <div class="inc-meta">\u23f1 ${formatTimeAgo(inc.timestamp)} \u00b7 ${formatDateTime(inc.timestamp)}</div>
        ${assignedChips}
        <div class="inc-actions">
          <button class="btn btn-secondary btn-sm" onclick="event.stopPropagation(); openDetailModal('${inc.id}')">D\u00e9tails</button>
          ${inc.status === 'active' ? `<button class="btn btn-warning btn-sm" onclick="event.stopPropagation(); acknowledgeIncident('${inc.id}')">Acquitter</button>` : ''}
          ${inc.status !== 'resolved' ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); openAssignModal('${inc.id}')">Assigner Unit\u00e9</button>` : ''}
          ${inc.status !== 'resolved' ? `<button class="btn btn-success btn-sm" onclick="event.stopPropagation(); openResolveModal('${inc.id}')">R\u00e9soudre</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function filterIncidents(filter) {
  currentFilter = filter;
  document.querySelectorAll('#tab-incidents .chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`#tab-incidents .chip[data-filter="${filter}"]`)?.classList.add('active');
  renderIncidents();
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
      html += notAssigned.map(r => {
        const statusLabels = { available: 'Disponible', on_duty: 'En service', responding: 'En intervention', off_duty: 'Hors service' };
        const statusLabel = statusLabels[r.status] || r.status;
        const statusClass = r.status === 'available' ? 'available' : r.status === 'on_duty' ? 'on_duty' : r.status === 'responding' ? 'responding' : 'off_duty';
        const connIcon = r.isConnected ? '\uD83D\uDFE2' : '\u26AA';
        const tagsHtml = (r.tags || []).slice(0, 3).map(t => `<span class="resp-tag">${t}</span>`).join('');
        const phoneHtml = r.phone ? `<span class="resp-phone">\uD83D\uDCF1 ${r.phone}</span>` : '';
        const distHtml = r.distanceLabel ? `<span class="resp-distance">\uD83D\uDCCD ${r.distanceLabel}</span>` : '';
        const isAvailable = r.status === 'available' || r.status === 'on_duty' || r.status === 'responding';
        const clickAttr = isAvailable ? `onclick="assignResponder('${incidentId}', '${r.id}')"` : '';
        const disabledClass = isAvailable ? '' : ' disabled';
        return `<div class="resp-option${disabledClass}" ${clickAttr}>
          <div class="resp-dot ${statusClass}"></div>
          <div class="resp-opt-info">
            <div class="resp-opt-name">${connIcon} ${r.name} ${distHtml}</div>
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
let mapFilters = { incidents: true, responders: true, users: true };
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

  // ── Geneva Commune Boundaries (approximate polygons) ──
  const COMMUNE_ZONES = {
    'Champel': {
      center: [46.1925, 6.1535],
      color: '#8b5cf6',
      bounds: [[46.1880, 6.1440], [46.1880, 6.1620], [46.1970, 6.1620], [46.1970, 6.1440]],
    },
    'Florissant': {
      center: [46.1955, 6.1675],
      color: '#06b6d4',
      bounds: [[46.1910, 6.1620], [46.1910, 6.1780], [46.2000, 6.1780], [46.2000, 6.1620]],
    },
    'Malagnou': {
      center: [46.2005, 6.1615],
      color: '#f59e0b',
      bounds: [[46.1970, 6.1540], [46.1970, 6.1700], [46.2050, 6.1700], [46.2050, 6.1540]],
    },
    'V\u00e9senaz': {
      center: [46.2310, 6.2050],
      color: '#22c55e',
      bounds: [[46.2250, 6.1950], [46.2250, 6.2150], [46.2370, 6.2150], [46.2370, 6.1950]],
    },
  };
  window._communeZoneLayers = {};
  Object.entries(COMMUNE_ZONES).forEach(([name, zone]) => {
    const poly = L.polygon(zone.bounds, {
      color: zone.color,
      weight: 2,
      opacity: 0.5,
      fillOpacity: 0.08,
      dashArray: '6 4',
    }).addTo(dispatchMap);
    const label = L.marker(zone.center, {
      icon: L.divIcon({
        className: 'commune-label',
        html: `<div style="font-size:11px;font-weight:700;color:${zone.color};text-shadow:0 1px 3px rgba(0,0,0,0.7);white-space:nowrap;">${name}</div>`,
        iconSize: [80, 20],
        iconAnchor: [40, 10],
      }),
    }).addTo(dispatchMap);
    window._communeZoneLayers[name] = { poly, label };
  });

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

    // Update markers
    updateIncidentMarkers(incData);
    updateResponderMarkers(respData);
    updateUserMarkers(mapUsers);
  } catch (err) {
    console.error('[Map] Failed to refresh data:', err);
  }
}

function updateIncidentMarkers(incidentData) {
  // Clear existing
  mapIncidentMarkers.forEach(m => dispatchMap.removeLayer(m));
  mapIncidentMarkers = [];

  if (!mapFilters.incidents) return;

  // We need full alert data with coordinates
  // incidentData from /admin/incidents has address but not lat/lng
  // Fetch from /alerts for coordinate data
  fetch(`${API_BASE}/alerts`).then(r => r.json()).then(alerts => {
    // Cache alerts for ETA calculation in detail modal
    window._cachedAlerts = alerts;
    // Also get all alerts (including resolved) from admin/incidents for status
    const allAlerts = new Map();
    incidentData.forEach(i => allAlerts.set(i.id, i));

    // Use /alerts for active ones with coords, plus seed data coords
    const alertsWithCoords = Array.from(alerts);

    // Also add incidents from admin that have known addresses (Geneva seed coords)
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

    // Filter out resolved incidents — they should not appear on the map
    // Also apply incident type filter
    const visibleIncidents = incidentData.filter(inc => {
      if (inc.status === 'resolved') return false;
      if (mapIncidentTypeFilter !== 'all' && inc.type !== mapIncidentTypeFilter) return false;
      return true;
    });

    visibleIncidents.forEach(inc => {
      const alertData = alertsWithCoords.find(a => a.id === inc.id);
      let lat, lng;
      if (alertData && alertData.location) {
        lat = alertData.location.latitude;
        lng = alertData.location.longitude;
      } else if (KNOWN_COORDS[inc.address]) {
        [lat, lng] = KNOWN_COORDS[inc.address];
      } else {
        return; // skip if no coords
      }

      const color = SEVERITY_COLORS[inc.severity] || '#6b7280';
      const emoji = TYPE_EMOJIS[inc.type] || '🚨';
      const size = inc.severity === 'critical' ? 36 : inc.severity === 'high' ? 32 : 28;

      const marker = L.marker([lat, lng], {
        icon: createCircleIcon(color, size, emoji),
        zIndexOffset: inc.severity === 'critical' ? 1000 : inc.severity === 'high' ? 500 : 0,
      });

      // Pulse animation for active critical
      if (inc.status === 'active' && inc.severity === 'critical') {
        const pulseCircle = L.circleMarker([lat, lng], {
          radius: 25, color: '#dc2626', fillColor: '#dc2626', fillOpacity: 0.15, weight: 2, opacity: 0.4,
          className: 'pulse-marker',
        });
        pulseCircle.addTo(dispatchMap);
        mapIncidentMarkers.push(pulseCircle);
      }

      const statusBadge = `<span class="popup-badge ${inc.status}">${inc.status}</span>`;
      const sevBadge = `<span class="popup-badge ${inc.severity}">${inc.severity}</span>`;
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

      marker.bindPopup(`
        <div class="popup-title">${emoji} ${formatIncidentId(inc.id)} \u2014 ${typeLabel(inc.type)}</div>
        <div>${sevBadge} ${statusBadge}</div>
        <div class="popup-detail">\ud83d\udccd ${inc.address}</div>
        <div class="popup-detail">\ud83d\udc64 Signal\u00e9 par: ${inc.reportedBy}</div>
        <div class="popup-detail">\u23f1 ${formatTimeAgo(inc.timestamp)}</div>
        ${inc.assignedCount > 0 ? `<div class="popup-detail">\ud83d\udc6e ${inc.assignedCount} intervenant(s) assign\u00e9(s)</div>` : ''}
        ${actions}
      `, { maxWidth: 280 });

      marker.addTo(dispatchMap);
      mapIncidentMarkers.push(marker);
    });
  }).catch(err => {
    console.error('[Map] Failed to load alert coords:', err);
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
  if (dispatchMap && ['newAlert', 'alertAcknowledged', 'alertUpdate', 'alertResolved', 'alertsSnapshot', 'alertsList', 'responderLocationUpdate', 'responderStatusUpdate', 'userStatusChange'].includes(msg.type)) {
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
    <span class="badge badge-${severity}">${sevLabel(severity)}</span>
    <span class="badge badge-${status}">${statusLabel(status)}</span>
    ${inc.type === 'sos' ? '<span class="badge badge-critical">SOS URGENCE</span>' : ''}
  `;
  
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
                  <div style="font-weight:700;color:#dc2626;font-size:13px;">⚠️ ALERTE POSSIBLE HOME-JACKING</div>
                  <div style="font-size:11px;color:#991b1b;">${loc.label} · ${loc.distanceMeters}m · Possible home-jacking</div>
                  ${loc.alarmCode ? `<div style="font-size:11px;color:#991b1b;margin-top:2px;">🔑 Code alarme: <strong>${loc.alarmCode}</strong></div>` : ''}
                </div>
              </div>`;
            } else {
              locBadge = `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:8px 12px;margin-bottom:12px;display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">📍</span>
                <div>
                  <div style="font-weight:700;color:#16a34a;font-size:13px;">HORS DOMICILE</div>
                  <div style="font-size:11px;color:#15803d;">${loc.label} · ${loc.distanceMeters}m du domicile connu</div>
                </div>
              </div>`;
            }
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
          const familyHtml = (ctx.family || []).filter(Boolean).map(f => `
            <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f3f4f6;">
              <div style="width:32px;height:32px;border-radius:50%;background:#f3f4f6;display:flex;align-items:center;justify-content:center;font-size:14px;">
                ${f.photoUrl ? `<img src="${f.photoUrl}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">` : '👤'}
              </div>
              <div style="flex:1;">
                <div style="font-size:13px;font-weight:600;color:#1f2937;">${f.name}</div>
                <div style="font-size:11px;color:#6b7280;">${f.role}</div>
              </div>
              ${f.phone ? `<a href="tel:${f.phone}" style="font-size:12px;color:#1e3a5f;font-weight:600;text-decoration:none;">📞 ${f.phone}</a>` : ''}
            </div>`).join('');

          clientProfile.innerHTML = `
            ${locBadge}
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;">
              ${photoHtml}
              <div style="flex:1;">
                <div style="font-weight:700;font-size:15px;color:#1f2937;">${u.firstName || ''} ${u.lastName || u.name || ''}</div>
                ${phone ? `<a href="tel:${phone}" style="font-size:13px;color:#1e3a5f;font-weight:600;text-decoration:none;">📞 ${phone}</a>` : ''}
              </div>
            </div>
            ${addrsHtml ? `<div style="margin-bottom:10px;">${addrsHtml}</div>` : ''}
            ${familyHtml ? `<div><div style="font-size:12px;font-weight:600;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Famille</div>${familyHtml}</div>` : ''}
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
  // Get incident coordinates for ETA calculation
  let incLat = null, incLng = null;
  try {
    // Try to get from cached alert data
    const cachedAlerts = window._cachedAlerts || [];
    const alertData = cachedAlerts.find(a => a.id === inc.id);
    if (alertData && alertData.location) {
      incLat = alertData.location.latitude;
      incLng = alertData.location.longitude;
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
  document.getElementById('detailActions').innerHTML = actionsHtml.join('');
  
  // Show modal
  modal.classList.add('active');
  
  // Initialize or update mini map after modal is visible
  setTimeout(() => {
    initDetailMiniMap(lat, lng, hasValidLocation, severity);
  }, 150);
}

function initDetailMiniMap(lat, lng, hasValidLocation, severity) {
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
  
  // Add radius circle
  detailCircle = L.circle([lat, lng], {
    radius: 200,
    color: color,
    fillColor: color,
    fillOpacity: 0.12,
    weight: 2,
    dashArray: '6 4',
  }).addTo(detailMiniMap);
}

function closeDetailModal() {
  document.getElementById('detailModal').classList.remove('active');
  // Clean up map after animation
  setTimeout(() => {
    if (detailMiniMap) {
      detailMiniMap.remove();
      detailMiniMap = null;
      detailMarker = null;
      detailCircle = null;
    }
  }, 300);
}


// ═══════════════════════════════════════════════════════════
// MESSAGING SYSTEM
// ═══════════════════════════════════════════════════════════

const DISPATCH_USER_ID = 'b8044334-a903-4661-9f77-59fe469d67b3'; // Talion HQ // Jean Moreau — dispatcher
const DISPATCH_USER_NAME = 'Dispatch Console';
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
  const data = await msgFetch(`/api/messaging/conversations?userId=${DISPATCH_USER_ID}`);
  if (data) {
    msgConversations = data.conversations || [];
    renderConversationList();
  }
}

let isAudioPlaying = false;

async function loadMessages(convId) {
  if (isAudioPlaying) return; // Ne pas recharger pendant la lecture audio
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
    const isGroup = c.type === 'group';
    const avatarColor = isGroup ? '#8b5cf6' : '#3b82f6';
    const avatarText = isGroup ? (name.charAt(0) || 'G') : (name.charAt(0) || '?');
    const time = c.lastMessageAt ? formatMsgTime(c.lastMessageAt) : '';
    const preview = c.lastMessage || (isGroup ? `${c.participants?.length || 0} members` : 'No messages yet');
    const active = c.id === msgCurrentConvId ? 'active' : '';
    const typeBadge = isGroup
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
  if (conv.type === 'group') return conv.name || 'Group';
  // Direct: find the other participant
  const other = (conv.participants || []).find(p => p !== DISPATCH_USER_ID);
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
  const isGroup = conv.type === 'group';
  const avatarColor = isGroup ? '#8b5cf6' : '#3b82f6';
  document.getElementById('msgChatAvatar').style.background = avatarColor;
  document.getElementById('msgChatAvatar').textContent = name.charAt(0) || '?';
  document.getElementById('msgChatName').textContent = name;
  document.getElementById('msgChatMeta').textContent = isGroup
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
    const isMine = m.senderId === DISPATCH_USER_ID;
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
      msgContent = `<video controls style="max-width:280px;max-height:200px;border-radius:8px;display:block;" src="${videoUrl}"></video>`;
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
  formData.append('senderId', DISPATCH_USER_ID);
  formData.append('senderName', DISPATCH_USER_NAME);
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
      senderId: DISPATCH_USER_ID,
      senderName: DISPATCH_USER_NAME,
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
  const users = msgUsers.filter(u => u.id !== DISPATCH_USER_ID);
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
  const users = msgUsers.filter(u => u.id !== DISPATCH_USER_ID);
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
    c.type === 'direct' && c.participants?.includes(userId) && c.participants?.includes(DISPATCH_USER_ID)
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
      createdBy: DISPATCH_USER_ID,
      participants: [DISPATCH_USER_ID, userId],
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

  const participants = [DISPATCH_USER_ID, ...newConvSelectedUsers];
  const data = await msgFetch('/api/messaging/conversations', {
    method: 'POST',
    body: JSON.stringify({
      type: 'group',
      name,
      groupType: 'custom',
      createdBy: DISPATCH_USER_ID,
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

  const participants = [DISPATCH_USER_ID, ...roleUsers];
  const data = await msgFetch('/api/messaging/conversations', {
    method: 'POST',
    body: JSON.stringify({
      type: 'group',
      name,
      groupType: `role:${newConvSelectedRole}`,
      createdBy: DISPATCH_USER_ID,
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
      createdBy: DISPATCH_USER_ID,
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
const ZONE_CENTERS = {
  'Champel': { center: [46.1925, 6.1535], zoom: 16 },
  'Florissant': { center: [46.1955, 6.1675], zoom: 16 },
  'Malagnou': { center: [46.2005, 6.1615], zoom: 16 },
  'Vésenaz': { center: [46.2310, 6.2050], zoom: 15 },
  'all': { center: [46.2125, 6.1795], zoom: 13 },
};

function zoomToZone(zoneName) {
  if (!dispatchMap) return;
  const zone = ZONE_CENTERS[zoneName];
  if (!zone) return;
  dispatchMap.setView(zone.center, zone.zoom, { animate: true });

  // Highlight active button
  document.querySelectorAll('.btn-zone-filter').forEach(btn => {
    btn.classList.toggle('zone-active', btn.getAttribute('data-zone') === zoneName);
  });
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

let patrolReports = [];
let patrolFilter = 'all';

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
    renderPatrolReports();
    updatePatrolStats();
    updatePatrolNavBadge();
  } catch (err) {
    console.error('[Patrol] Refresh error:', err);
  }
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

function renderPatrolReports() {
  const grid = document.getElementById('patrolReportsGrid');
  if (!grid) return;

  const filtered = patrolFilter === 'all'
    ? patrolReports
    : patrolReports.filter(r => r.status === patrolFilter);

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

function updatePatrolNavBadge() {
  const badge = document.getElementById('patrolNavBadge');
  if (!badge) return;
  const alertCount = patrolReports.filter(r => r.status !== 'habituel').length;
  if (alertCount > 0) {
    badge.textContent = alertCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
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

    <h4 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#374151;margin-bottom:8px;">Tâches</h4>
    <div style="background:#f9fafb;border-radius:10px;padding:14px;margin-bottom:16px;">
  `;

  (report.tasks || []).forEach((task, idx) => {
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

  // Media attachments
  if (report.media && report.media.length > 0) {
    html += `<h4 style="font-size:13px;text-transform:uppercase;letter-spacing:0.5px;color:#374151;margin-bottom:8px;">Pièces jointes (${report.media.length})</h4>`;
    html += '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">';
    report.media.forEach(media => {
      if (media.type === 'photo') {
        html += `<a href="${API_BASE}${media.url}" target="_blank" style="display:block;width:120px;height:120px;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb;">
          <img src="${API_BASE}${media.url}" style="width:100%;height:100%;object-fit:cover;" />
        </a>`;
      } else {
        html += `<a href="${API_BASE}${media.url}" target="_blank" style="display:flex;flex-direction:column;align-items:center;justify-content:center;width:120px;height:120px;border-radius:8px;background:#1e293b;color:#94a3b8;text-decoration:none;border:1px solid #334155;">
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

  const content = document.getElementById('patrolDetailContent');
  if (content) content.innerHTML = html;

  const modal = document.getElementById('patrolDetailModal');
  if (modal) modal.style.display = 'flex';
}

function closePatrolDetailModal() {
  const modal = document.getElementById('patrolDetailModal');
  if (modal) modal.style.display = 'none';
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
let pttMessages = {};
let pttIsRecording = false;
let pttMediaRecorder = null;
let pttSelectedTargetUser = null; // ID du user cible pour PTT 1-1
let pttRecordedChunks = [];
let pttLastEmergencyMsg = null;
let pttEmergencyMode = false;

async function loadPTTChannels() {
  try {
    const res = await fetch(`${API_BASE}/api/ptt/channels?role=dispatcher&userId=dispatch-console`);
    if (!res.ok) throw new Error('Failed to load channels');
    pttChannels = await res.json();
    renderPTTChannels();
    if (!pttCurrentChannel && pttChannels.length > 0) {
      selectPTTChannel(pttChannels[0]);
    }
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
    const msgCount = (pttMessages[ch.id] || []).length;
    const icons = { urgence: '🚨', dispatch: '📡', intervenants: '👮', general: '📻' };
    const isDirect = ch.id.startsWith('direct-');
    const icon = isDirect ? '📞' : (icons[ch.id] || '📻');
    return `<div class="ptt-channel-item ${isSelected ? 'active' : ''}" onclick="selectPTTChannel(${JSON.stringify(ch).replace(/"/g, '&quot;')})">
      <span class="ptt-channel-icon">${icon}</span>
      <div class="ptt-channel-info">
        <div class="ptt-channel-name">${ch.name}</div>
        <div class="ptt-channel-desc">${ch.description || ''}</div>
      </div>
      ${msgCount > 0 ? `<span class="ptt-channel-badge">${msgCount}</span>` : ''}
    </div>`;
  }).join('');
}

function selectPTTChannel(channel) {
  pttCurrentChannel = channel;
  // Extraire targetUserId si canal direct
  if (channel.id && channel.id.startsWith('direct-')) {
    const parts = channel.id.replace('direct-', '').split('-');
    // Trouver l'ID qui n'est pas dispatch-console
    const members = channel.members || [];
    pttSelectedTargetUser = members.find(m => m !== 'dispatch-console') || null;
    console.log('[PTT] Direct channel target:', pttSelectedTargetUser);
  } else {
    pttSelectedTargetUser = null;
  }
  renderPTTChannels();

  const el = document.getElementById('pttCurrentChannel');
  if (el) el.textContent = channel.name;

  const btn = document.getElementById('pttRecordBtn');
  if (btn) btn.disabled = false;

  // Join channel via WS
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'pttJoinChannel', userId: 'dispatch-console', userRole: 'dispatcher', data: { channelId: channel.id } }));
  }

  // Load history
  loadPTTHistory(channel.id);
  renderPTTMessages();
}

async function loadPTTHistory(channelId) {
  try {
    const res = await fetch(`${API_BASE}/api/ptt/channels/${channelId}/messages`);
    if (res.ok) {
      const msgs = await res.json();
      pttMessages[channelId] = msgs;
      if (pttCurrentChannel && pttCurrentChannel.id === channelId) renderPTTMessages();
    }
  } catch (e) {
    console.error('[PTT] Error loading history:', e);
  }
}

function renderPTTMessages() {
  const container = document.getElementById('pttMessages');
  if (!container || !pttCurrentChannel) return;
  const msgs = pttMessages[pttCurrentChannel.id] || [];
  if (msgs.length === 0) {
    container.innerHTML = '<div class="empty-state">🎙 Aucun message sur ce canal</div>';
    return;
  }
  container.innerHTML = msgs.map(m => {
    const initials = (m.senderName || 'U').split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
    const time = m.timestamp ? new Date(m.timestamp).toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' }) : '';
    const roleLabels = { admin: 'Admin', dispatcher: 'Dispatch', responder: 'Intervenant', user: 'Utilisateur' };
    const roleLabel = roleLabels[m.senderRole] || m.senderRole || '';
    const audioId = `ptt-audio-${m.id || Math.random().toString(36).substr(2, 9)}`;
    return `<div class="ptt-msg">
      <div class="ptt-msg-avatar">${initials}</div>
      <div class="ptt-msg-content">
        <div class="ptt-msg-header">
          <span class="ptt-msg-sender">${m.senderName || 'Inconnu'} <span class="ptt-msg-role">${roleLabel}</span></span>
          <span class="ptt-msg-time">${time}</span>
        </div>
        <div class="ptt-msg-audio">
          <button class="ptt-msg-play-btn" onclick="playPTTAudio('${audioId}', this)" data-playing="false">▶ Écouter</button>
          ${m.duration ? `<span class="ptt-msg-duration">${Math.round(m.duration)}s</span>` : ''}
          <audio id="${audioId}" src="${m.audioData ? (m.audioData.startsWith('data:') ? m.audioData : 'data:' + (m.mimeType || 'audio/webm') + ';base64,' + m.audioData) : (m.audioUrl || '')}" preload="none"></audio>
        </div>
      </div>
    </div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
}

function playPTTAudio(audioId, btn) {
  const audio = document.getElementById(audioId);
  if (!audio) return;
  const isPlaying = btn.getAttribute('data-playing') === 'true';
  if (isPlaying) {
    audio.pause();
    audio.currentTime = 0;
    btn.textContent = '▶ Écouter';
    btn.setAttribute('data-playing', 'false');
  } else {
    // Stop any other playing audio
    document.querySelectorAll('.ptt-msg-play-btn[data-playing="true"]').forEach(b => {
      const otherId = b.closest('.ptt-msg-audio').querySelector('audio').id;
      const otherAudio = document.getElementById(otherId);
      if (otherAudio) { otherAudio.pause(); otherAudio.currentTime = 0; }
      b.textContent = '▶ Écouter';
      b.setAttribute('data-playing', 'false');
    });
    audio.play().catch(e => console.error('[PTT] Playback error:', e));
    btn.textContent = '⏹ Arrêter';
    btn.setAttribute('data-playing', 'true');
    audio.onended = () => {
      btn.textContent = '▶ Écouter';
      btn.setAttribute('data-playing', 'false');
    };
  }
}

async function startDispatchPTT() {
  if (pttIsRecording || !pttCurrentChannel) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Enregistrement WAV PCM via WebAudio pour compatibilité iOS
    const audioCtxRec = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = audioCtxRec.createMediaStreamSource(stream);
    const processor = audioCtxRec.createScriptProcessor(4096, 1, 1);
    const pcmChunks = [];
    pttRecordedChunks = [];
    
    processor.onaudioprocess = (e) => {
      if (!pttIsRecording) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
      }
      pcmChunks.push(new Uint8Array(int16.buffer));
    };
    source.connect(processor);
    processor.connect(audioCtxRec.destination);
    
    pttMediaRecorder = {
      stop: () => {
        pttIsRecording = false;
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach(t => t.stop());
        audioCtxRec.close();
        const totalLength = pcmChunks.reduce((sum, c) => sum + c.length, 0);
        const wavBuffer = new ArrayBuffer(44 + totalLength);
        const view = new DataView(wavBuffer);
        const sampleRate = 16000;
        const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
        writeStr(0, 'RIFF'); view.setUint32(4, 36 + totalLength, true); writeStr(8, 'WAVE');
        writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
        view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
        view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
        writeStr(36, 'data'); view.setUint32(40, totalLength, true);
        let offset = 44;
        pcmChunks.forEach(chunk => { new Uint8Array(wavBuffer).set(chunk, offset); offset += chunk.length; });
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const reader = new FileReader();
        reader.onloadend = () => {
          const rawBase64 = reader.result.split(',')[1];
          if (pttCurrentChannel && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pttTransmit', userId: 'dispatch-console', userRole: 'dispatcher', data: { channelId: pttCurrentChannel.id, audioBase64: rawBase64, mimeType: 'audio/wav', senderName: 'Dispatch Console', duration: 0, targetUserId: pttSelectedTargetUser || null } }));
          }
        };
        reader.readAsDataURL(blob);
      },
      mimeType: 'audio/wav'
    };
    
    pttIsRecording = true;
    console.log('[PTT] Recording format: audio/wav PCM 16kHz');

    const btn = document.getElementById('pttRecordBtn');
    if (btn) { btn.classList.add('recording'); btn.innerHTML = '🔴 ENREGISTREMENT...'; }

    // Notify talking state
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'pttStartTalking', userId: 'dispatch-console', userRole: 'dispatcher', data: { channelId: pttCurrentChannel.id, userName: 'Dispatch Console' } }));
    }
  } catch (e) {
    console.error('[PTT] Microphone error:', e);
    showToast('Erreur: accès au microphone refusé', 'error');
  }
}

function stopDispatchPTT() {
  if (!pttIsRecording || !pttMediaRecorder) return;
  pttIsRecording = false;
  pttMediaRecorder.stop();

  const btn = document.getElementById('pttRecordBtn');
  if (btn) { btn.classList.remove('recording'); btn.innerHTML = '🎙 MAINTENIR POUR PARLER'; }

  // Notify stop talking
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'pttStopTalking', userId: 'dispatch-console', userRole: 'dispatcher', data: { channelId: pttCurrentChannel?.id, userName: 'Dispatch Console' } }));
  }
}

async function finalizePTTRecordingWav() {
  if (pttRecordedChunks.length === 0) return;
  const blob = pttRecordedChunks[0];
  pttRecordedChunks = [];
  const reader = new FileReader();
  reader.onloadend = () => {
    const dataUrl = reader.result;
    const rawBase64 = typeof dataUrl === 'string' && dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    if (pttCurrentChannel) {
      const msg = { type: 'pttTransmit', userId: 'dispatch-console', userRole: 'dispatcher', data: { channelId: pttCurrentChannel.id, audioBase64: rawBase64, mimeType: 'audio/wav', senderName: 'Dispatch Console', duration: 0, targetUserId: pttSelectedTargetUser || null } };
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      if (!pttMessages[pttCurrentChannel.id]) pttMessages[pttCurrentChannel.id] = [];
      pttMessages[pttCurrentChannel.id].push({ senderId: 'dispatch-console', senderName: 'Dispatch Console', senderRole: 'dispatcher', channelId: pttCurrentChannel.id, audioData: rawBase64, mimeType: 'audio/wav', duration: 0, timestamp: new Date().toISOString() });
      renderPTTMessages();
    }
  };
  reader.readAsDataURL(blob);
}

async function finalizePTTRecording(isEmergency) {
  if (pttRecordedChunks.length === 0) return;
  const actualMime = pttMediaRecorder ? pttMediaRecorder.mimeType : 'audio/webm';
  const blob = new Blob(pttRecordedChunks, { type: actualMime });
  pttRecordedChunks = [];

  const reader = new FileReader();
  reader.onloadend = () => {
    const dataUrl = reader.result;
    // Strip data URL prefix to send raw base64 (consistent with mobile app)
    const rawBase64 = typeof dataUrl === 'string' && dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    if (isEmergency) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'pttEmergency', userId: 'dispatch-console', userRole: 'dispatcher', data: { audioBase64: rawBase64, mimeType: 'audio/webm', senderName: 'Dispatch Console', duration: 0 } }));
      }
    } else if (pttCurrentChannel) {
      const actualMimeType = pttMediaRecorder ? pttMediaRecorder.mimeType : 'audio/webm';
      const msg = { type: 'pttTransmit', userId: 'dispatch-console', userRole: 'dispatcher', data: { channelId: pttCurrentChannel.id, audioBase64: rawBase64, mimeType: actualMimeType, senderName: 'Dispatch Console', duration: 0, targetUserId: pttSelectedTargetUser || null } };
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
      // Also add locally (store raw base64)
      if (!pttMessages[pttCurrentChannel.id]) pttMessages[pttCurrentChannel.id] = [];
      pttMessages[pttCurrentChannel.id].push({ senderId: 'dispatch-console', senderName: 'Dispatch Console', senderRole: 'dispatcher', channelId: pttCurrentChannel.id, audioData: rawBase64, mimeType: actualMimeType, duration: 0, timestamp: new Date().toISOString() });
      renderPTTMessages();
    }
  };
  reader.readAsDataURL(blob);
}

function toggleDispatchEmergency() {
  pttEmergencyMode = !pttEmergencyMode;
  const btn = document.getElementById('pttEmergencyBtn');
  if (pttEmergencyMode) {
    btn.classList.add('active');
    btn.innerHTML = '⚠️ URGENCE ACTIVE — Cliquer pour annuler';
    showToast('Mode urgence activé — le prochain message sera diffusé à tous', 'warning');
  } else {
    btn.classList.remove('active');
    btn.innerHTML = '⚠️ URGENCE';
  }
}

function startEmergencyRecording() {
  if (pttIsRecording) return;
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    pttMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
    pttRecordedChunks = [];
    pttMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) pttRecordedChunks.push(e.data);
    };
    pttMediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      finalizePTTRecording(true);
      pttEmergencyMode = false;
      const btn = document.getElementById('pttEmergencyBtn');
      if (btn) { btn.classList.remove('active'); btn.innerHTML = '⚠️ URGENCE'; }
    };
    pttMediaRecorder.start(100);
    pttIsRecording = true;
  }).catch(e => {
    console.error('[PTT] Emergency mic error:', e);
    showToast('Erreur: accès au microphone refusé', 'error');
  });
}

function playEmergencyMessage() {
  if (!pttLastEmergencyMsg || !pttLastEmergencyMsg.audioData) return;
  const emergMime = pttLastEmergencyMsg.mimeType || 'audio/webm';
  const src = pttLastEmergencyMsg.audioData.startsWith('data:') ? pttLastEmergencyMsg.audioData : 'data:' + emergMime + ';base64,' + pttLastEmergencyMsg.audioData;
  const audio = new Audio(src);
  audio.play().catch(e => console.error('[PTT] Emergency playback error:', e));
  const btn = document.getElementById('pttEmergencyPlayBtn');
  if (btn) btn.textContent = '🔊 Lecture...';
  audio.onended = () => { if (btn) btn.textContent = '▶ Écouter'; };
}

function dismissDispatchEmergency() {
  const banner = document.getElementById('pttEmergencyBanner');
  if (banner) banner.style.display = 'none';
  pttLastEmergencyMsg = null;
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
    // Filter out dispatch-console and deactivated users
    const available = allUsers.filter(u => u.id !== 'dispatch-console' && u.status !== 'deactivated');
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
          <div class="ptt-direct-user-name">${name}</div>
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
      body: JSON.stringify({ userId1: 'dispatch-console', userId2: targetUserId, userName1: 'Dispatch', userName2: targetUserName })
    });
    if (!res.ok) throw new Error('Failed to create direct channel');
    const channel = await res.json();
    // Add to local channels if not already present
    if (!pttChannels.find(c => c.id === channel.id)) {
      pttChannels.push(channel);
    }
    renderPTTChannels();
    pttSelectedTargetUser = targetUserId;
    pttSelectedTargetUser = targetUserId;
    selectPTTChannel(channel);
    showToast(`Canal direct avec ${targetUserName} prêt`, 'success');
  } catch (e) {
    console.error('[PTT] Direct call error:', e);
    showToast('Erreur lors de la création du canal direct', 'error');
  }
}

function showCreatePTTGroup() {
  const modal = document.getElementById('pttGroupModal');
  if (modal) modal.style.display = 'flex';
}

function closePTTGroupModal() {
  const modal = document.getElementById('pttGroupModal');
  if (modal) modal.style.display = 'none';
}

async function createDispatchPTTGroup() {
  const name = document.getElementById('pttGroupName')?.value?.trim();
  const desc = document.getElementById('pttGroupDesc')?.value?.trim();
  if (!name) { showToast('Veuillez saisir un nom de groupe', 'error'); return; }

  const roles = [];
  document.querySelectorAll('#pttGroupModal .ptt-role-check input:checked').forEach(cb => roles.push(cb.value));
  if (roles.length === 0) { showToast('Sélectionnez au moins un rôle', 'error'); return; }

  try {
    const res = await fetch(`${API_BASE}/api/ptt/groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description: desc || '', allowedRoles: roles, createdBy: 'dispatch-console' })
    });
    if (res.ok) {
      showToast(`Groupe "${name}" créé`, 'success');
      closePTTGroupModal();
      loadPTTChannels();
    } else {
      const err = await res.json();
      showToast(err.error || 'Erreur de création', 'error');
    }
  } catch (e) {
    showToast('Erreur réseau', 'error');
  }
}

// Override startDispatchPTT to handle emergency mode
const _origStartDispatchPTT = startDispatchPTT;
startDispatchPTT = function() {
  if (pttEmergencyMode) {
    startEmergencyRecording();
  } else {
    _origStartDispatchPTT();
  }
};

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
    `;
    document.head.appendChild(style);
  }

  const latestAlert = alertBannerQueue[alertBannerQueue.length - 1];
  const count = alertBannerQueue.length;
  banner.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; flex:1;">
      <span style="font-size:24px;">🚨</span>
      <div>
        <div style="font-size:16px; font-weight:800; letter-spacing:0.5px;">
          ${count > 1 ? count + ' ALERTES ACTIVES' : latestAlert.id || 'NOUVELLE ALERTE'}
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
      <button onclick="dismissAlertBanner()" style="
        background:rgba(255,255,255,0.2); color:white; border:none; border-radius:6px;
        padding:8px 12px; font-weight:700; cursor:pointer; font-size:13px;
      ">✕</button>
    </div>
  `;

  // Blink page title
  startTitleBlink(latestAlert);

  // Repeat siren every 10s until dismissed
  if (alertBannerInterval) clearInterval(alertBannerInterval);
  alertBannerInterval = setInterval(() => {
    if (document.getElementById('criticalAlertBanner')) {
      playNewAlertSound(latestAlert.type, latestAlert.severity);
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
