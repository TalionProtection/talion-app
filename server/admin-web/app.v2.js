// ─── Talion Crisis Comm - Admin Console JS ──────────────────────
// Derive API base: if accessed via a proxy with a different port prefix,
// replace with 3000 to reach the actual API server.
const API_BASE = (() => {
  const origin = window.location.origin;
  const host = window.location.hostname;
  const proxyMatch = host.match(/^(\d+)-(.+)$/);
  if (proxyMatch && proxyMatch[1] !== '3000') {
    return origin.replace(/^(https?:\/\/)\d+-/, '$13000-');
  }
  return origin;
})();

// State
let allUsers = [];
let allIncidents = [];
let allAudit = [];
let currentIncidentFilter = 'all';
let currentAuditFilter = 'all';
let selectedUserForRole = null;

// Format helpers
function formatIncidentId(id) {
  if (!id) return 'INC-????';
  const cleaned = id.replace(/^alert-/i, '').replace(/^incident-/i, '').replace(/^inc-/i, '');
  const alphanumeric = cleaned.replace(/[^a-zA-Z0-9]/g, '');
  return `INC-${(alphanumeric.substring(0, 4) || '????').toUpperCase()}`;
}
const SEV_LABELS = { critical: 'Critique', high: '\u00c9lev\u00e9', medium: 'Moyen', low: 'Faible' };
const STAT_LABELS = { active: 'Actif', acknowledged: 'Acquitt\u00e9', dispatched: 'Dispatch\u00e9', resolved: 'R\u00e9solu' };
const TYPE_LABELS_FR = { sos: 'SOS', medical: 'M\u00e9dical', fire: 'Feu', security: 'S\u00e9curit\u00e9', hazard: 'Danger', accident: 'Accident', broadcast: 'Broadcast', home_jacking: 'Home-Jacking', cambriolage: 'Cambriolage', animal_perdu: 'Animal perdu', evenement_climatique: '\u00c9v\u00e9nement climatique', rodage: 'Rodage', vehicule_suspect: 'V\u00e9hicule suspect', fugue: 'Fugue', route_bloquee: 'Route bloqu\u00e9e', route_fermee: 'Route ferm\u00e9e', other: 'Autre' };
function sevLbl(s) { return SEV_LABELS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : ''); }
function statLbl(s) { return STAT_LABELS[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : ''); }
function typeLbl(t) { return TYPE_LABELS_FR[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : ''); }

// User drawer state
let editingUserId = null; // null = new user, string = editing
let currentTags = [];
let currentRelationships = []; // [{userId, type}]
let currentPhotoUrl = '';
let addressDebounceTimer = null;

// ─── WebSocket Real-Time Client ───────────────────────────────────────
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
    wsReconnectDelay = 2000;
    updateWsStatus('online');
    ws.send(JSON.stringify({ type: 'auth', userId: 'admin-console', userRole: 'admin' }));
    ws.send(JSON.stringify({ type: 'getAlerts' }));
    refreshData();
  };
  ws.onmessage = (event) => {
    try { handleWsMessage(JSON.parse(event.data)); } catch (e) { console.warn('[WS] Parse error:', e); }
  };
  ws.onclose = () => { updateWsStatus('offline'); scheduleReconnect(); };
  ws.onerror = () => { updateWsStatus('offline'); };
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
  const topIndicator = document.getElementById('wsTopIndicator');
  if (dot) dot.className = `status-dot ${state === 'online' ? 'online' : state === 'connecting' ? 'connecting' : 'offline'}`;
  if (text) text.textContent = state === 'online' ? 'Live' : state === 'connecting' ? 'Connecting...' : 'Offline';
  if (indicator) {
    indicator.textContent = state === 'online' ? '⚡ Real-time' : state === 'connecting' ? '⏳ Connecting' : '❌ Disconnected';
    indicator.className = `ws-indicator ws-${state}`;
  }
  if (topIndicator) {
    topIndicator.textContent = state === 'online' ? '⚡ Real-time' : state === 'connecting' ? '⏳ Connecting...' : '❌ Offline';
    topIndicator.style.color = state === 'online' ? '#34d399' : state === 'connecting' ? '#fbbf24' : '#f87171';
    topIndicator.style.borderColor = state === 'online' ? 'rgba(5,150,105,0.2)' : state === 'connecting' ? 'rgba(217,119,6,0.2)' : 'rgba(220,38,38,0.2)';
    topIndicator.style.background = state === 'online' ? 'rgba(5,150,105,0.1)' : state === 'connecting' ? 'rgba(217,119,6,0.1)' : 'rgba(220,38,38,0.1)';
  }
}

function handleWsMessage(msg) {
  const now = Date.now();
  switch (msg.type) {
    case 'authSuccess': break;
    case 'newAlert': {
      const alert = msg.data;
      const formatted = { id: alert.id, type: alert.type, severity: alert.severity, status: alert.status, reportedBy: alert.createdBy, address: alert.location?.address || 'Unknown', timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0 };
      const idx = allIncidents.findIndex(i => i.id === alert.id);
      if (idx >= 0) allIncidents[idx] = formatted; else allIncidents.unshift(formatted);
      allAudit.unshift({ timestamp: now, category: 'incident', action: `New ${alert.type} alert`, performedBy: alert.createdBy || 'System', targetUser: '', details: alert.location?.address || '' });
      showToast(`🚨 New Incident: ${alert.type.toUpperCase()} - ${alert.location?.address || 'Unknown'}`, 'error');
      sendBrowserNotification(`New ${alert.severity?.toUpperCase()} Incident`, `${alert.type.toUpperCase()} - ${alert.location?.address || 'Unknown'}`, alert.severity || 'high', `incident-${alert.id}`);
      updateAllViews();
      break;
    }
    case 'alertAcknowledged': {
      const inc = allIncidents.find(i => i.id === msg.alertId);
      if (inc) inc.status = 'acknowledged';
      allAudit.unshift({ timestamp: now, category: 'incident', action: `Incident ${formatIncidentId(msg.alertId)} acquitt\u00e9`, performedBy: msg.userId || 'Dispatcher', targetUser: '', details: '' });
      showToast(`\u2705 Incident ${formatIncidentId(msg.alertId)} acquitt\u00e9`, 'success');
      updateAllViews();
      break;
    }
    case 'alertUpdate': {
      const alert = msg.data;
      const formatted = { id: alert.id, type: alert.type, severity: alert.severity, status: alert.status, reportedBy: alert.createdBy, address: alert.location?.address || 'Unknown', timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0 };
      const idx = allIncidents.findIndex(i => i.id === alert.id);
      if (idx >= 0) allIncidents[idx] = formatted; else allIncidents.unshift(formatted);
      showToast(`\ud83d\udccb Incident ${formatIncidentId(alert.id)} mis \u00e0 jour`, 'info');
      updateAllViews();
      break;
    }
    case 'alertResolved': {
      const inc = allIncidents.find(i => i.id === msg.alertId);
      if (inc) { inc.status = 'resolved'; inc.resolvedAt = now; }
      allAudit.unshift({ timestamp: now, category: 'incident', action: `Incident ${formatIncidentId(msg.alertId)} r\u00e9solu`, performedBy: msg.userId || 'Dispatcher', targetUser: '', details: '' });
      showToast(`\ud83d\udfe2 Incident ${formatIncidentId(msg.alertId)} r\u00e9solu`, 'success');
      updateAllViews();
      break;
    }
    case 'alertsSnapshot':
    case 'alertsList': {
      if (Array.isArray(msg.data)) {
        msg.data.forEach(alert => {
          const idx = allIncidents.findIndex(i => i.id === alert.id);
          const formatted = { id: alert.id, type: alert.type, severity: alert.severity, status: alert.status, reportedBy: alert.createdBy, address: alert.location?.address || 'Unknown', timestamp: alert.createdAt, assignedCount: alert.respondingUsers?.length || 0 };
          if (idx >= 0) allIncidents[idx] = formatted; else allIncidents.push(formatted);
        });
        updateAllViews();
      }
      break;
    }
    case 'userStatusChange': {
      showToast(`👤 User ${msg.userId} is now ${msg.status}`, 'info');
      fetch(`${API_BASE}/admin/users`).then(r => r.json()).then(users => { allUsers = users; renderUsers(); updateDashboard(); });
      break;
    }
    case 'zoneBroadcast': {
      const bc = msg.data;
      allAudit.unshift({ timestamp: now, category: 'broadcast', action: 'Zone Broadcast', performedBy: bc.by || 'Unknown', targetUser: '', details: `[${(bc.severity || 'medium').toUpperCase()}] ${bc.message} (${bc.radiusKm || 5}km)` });
      showToast(`📢 Broadcast: ${bc.message}`, 'warning');
      renderAudit(); updateDashboard();
      break;
    }
    case 'pong': break;
    default: console.log('[WS] Unhandled:', msg.type);
  }
}

function updateAllViews() {
  updateDashboard(); renderIncidents(); renderAudit();
  document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
}

// ─── Toast Notifications ──────────────────────────────────────────────
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

// ─── WS Keepalive ─────────────────────────────────────────────────────
setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
}, 25000);

// ─── Initialization ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  connectWebSocket();
  refreshData();
  setInterval(refreshData, 30000);
});

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(item.dataset.tab);
    });
  });
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-tab="${tab}"]`).classList.add('active');
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  const titles = { dashboard: 'Dashboard', users: 'Gestion des Utilisateurs', incidents: 'Gestion des Incidents', audit: 'Journal d\'Audit', 'login-history': 'Historique de Connexion' };
  document.getElementById('pageTitle').textContent = titles[tab] || tab;
  if (tab === 'login-history') {
    loadLoginHistory(1);
    loadLoginStats();
    populateLoginHistoryUserFilter();
  }
}

// ─── Data Fetching ───────────────────────────────────────────────────
async function refreshData() {
  try {
    const [healthRes, usersRes, incidentsRes, auditRes] = await Promise.all([
      fetch(`${API_BASE}/admin/health`).then(r => r.json()),
      fetch(`${API_BASE}/admin/users`).then(r => r.json()),
      fetch(`${API_BASE}/admin/incidents`).then(r => r.json()),
      fetch(`${API_BASE}/admin/audit`).then(r => r.json()),
    ]);
    allUsers = usersRes;
    allIncidents = incidentsRes;
    allAudit = auditRes;
    updateServerStatus(healthRes);
    updateDashboard();
    renderUsers();
    renderIncidents();
    renderAudit();
    document.getElementById('lastUpdated').textContent = new Date().toLocaleTimeString();
  } catch (err) {
    console.error('Failed to fetch data:', err);
    document.getElementById('serverStatusDot').className = 'status-dot offline';
    document.getElementById('serverStatusText').textContent = 'Offline';
  }
}

function updateServerStatus(health) {
  const countEl = document.getElementById('connectedCount');
  if (countEl) countEl.textContent = health.connectedUsers || 0;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    document.getElementById('serverStatusDot').className = 'status-dot online';
    document.getElementById('serverStatusText').textContent = 'Online';
  }
}

// ─── Dashboard ───────────────────────────────────────────────────────
function updateDashboard() {
  document.getElementById('kpiTotalUsers').textContent = allUsers.length;
  const activeInc = allIncidents.filter(i => i.status !== 'resolved');
  const resolvedInc = allIncidents.filter(i => i.status === 'resolved');
  document.getElementById('kpiActiveIncidents').textContent = activeInc.length;
  document.getElementById('kpiResolvedIncidents').textContent = resolvedInc.length;
  const withResolveTime = allIncidents.filter(i => i.resolvedAt);
  const avgResp = withResolveTime.length > 0
    ? Math.round(withResolveTime.reduce((s, i) => s + (i.resolvedAt - i.timestamp) / 60000, 0) / withResolveTime.length)
    : '--';
  document.getElementById('kpiAvgResponse').textContent = avgResp;

  const roleCount = { admin: 0, dispatcher: 0, responder: 0, user: 0 };
  allUsers.forEach(u => { if (roleCount[u.role] !== undefined) roleCount[u.role]++; });
  const roleColors = { admin: '#7c3aed', dispatcher: '#1e3a5f', responder: '#059669', user: '#6b7280' };
  const maxRole = Math.max(...Object.values(roleCount), 1);
  document.getElementById('chartUsersByRole').innerHTML = Object.entries(roleCount).map(([role, count]) => `
    <div class="bar-row">
      <span class="bar-label">${role.charAt(0).toUpperCase() + role.slice(1)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(count/maxRole)*100}%;background:${roleColors[role]}"></div></div>
      <span class="bar-value">${count}</span>
    </div>
  `).join('');

  const sevCount = { critical: 0, high: 0, medium: 0, low: 0 };
  allIncidents.forEach(i => { if (sevCount[i.severity] !== undefined) sevCount[i.severity]++; });
  const sevColors = { critical: '#ef4444', high: '#f59e0b', medium: '#3b82f6', low: '#6b7280' };
  const maxSev = Math.max(...Object.values(sevCount), 1);
  document.getElementById('chartBySeverity').innerHTML = Object.entries(sevCount).map(([sev, count]) => `
    <div class="bar-row">
      <span class="bar-label">${sev.charAt(0).toUpperCase() + sev.slice(1)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(count/maxSev)*100}%;background:${sevColors[sev]}"></div></div>
      <span class="bar-value">${count}</span>
    </div>
  `).join('');

  document.getElementById('healthGrid').innerHTML = [
    { label: 'API Server', ok: true },
    { label: 'WebSocket Server', ok: true },
    { label: 'Push Notifications', ok: true },
    { label: 'Active Incidents', ok: activeInc.length === 0, text: activeInc.length > 0 ? `${activeInc.length} Active` : 'None' },
  ].map(h => `
    <div class="health-item">
      <span class="status-dot" style="width:10px;height:10px;border-radius:50%;background:${h.ok ? '#22c55e' : '#f59e0b'};flex-shrink:0"></span>
      <span class="health-label">${h.label}</span>
      <span class="health-status ${h.ok ? 'ok' : 'warn'}">${h.text || (h.ok ? 'Online' : 'Warning')}</span>
    </div>
  `).join('');

  const recent = [...allAudit].sort((a, b) => b.timestamp - a.timestamp).slice(0, 8);
  const catIcons = { auth: '🔐', incident: '🚨', user: '👤', system: '⚙️', broadcast: '📢' };
  document.getElementById('recentActivity').innerHTML = recent.map(e => `
    <div class="activity-item">
      <span class="activity-icon">${catIcons[e.category] || '📋'}</span>
      <span class="activity-text"><strong>${e.action}</strong> by ${e.performedBy}${e.targetUser ? ` → ${e.targetUser}` : ''}</span>
      <span class="activity-time">${formatTimeAgo(e.timestamp)}</span>
    </div>
  `).join('') || '<p style="color:#94a3b8;font-size:13px;padding:8px">No recent activity</p>';
}

// ═══════════════════════════════════════════════════════════
// USERS — Rendering & Actions
// ═══════════════════════════════════════════════════════════
function renderUsers() {
  const query = (document.getElementById('userSearch')?.value || '').toLowerCase();
  let filtered = allUsers;
  if (query) {
    filtered = filtered.filter(u =>
      (u.name || '').toLowerCase().includes(query) ||
      (u.email || '').toLowerCase().includes(query) ||
      (u.role || '').toLowerCase().includes(query) ||
      (u.tags || []).some(t => t.toLowerCase().includes(query)) ||
      (u.address || '').toLowerCase().includes(query) ||
      (u.phoneMobile || '').includes(query) ||
      (u.phoneLandline || '').includes(query)
    );
  }

  document.getElementById('usersActive').textContent = `${allUsers.filter(u => u.status === 'active').length} Actifs`;
  document.getElementById('usersSuspended').textContent = `${allUsers.filter(u => u.status === 'suspended').length} Suspendus`;
  document.getElementById('usersDeactivated').textContent = `${allUsers.filter(u => u.status === 'deactivated').length} Désactivés`;

  const roleColors = { admin: '#7c3aed', dispatcher: '#1e3a5f', responder: '#059669', user: '#6b7280' };
  const roleLabels = { admin: 'ADMIN', dispatcher: 'DISPATCH', responder: 'INTERVENANT', user: 'UTILISATEUR' };
  const relTypeLabels = { spouse: 'Conjoint(e)', parent: 'Parent', child: 'Enfant', sibling: 'Frère/Sœur', cohabitant: 'Cohabitant', other: 'Autre' };

  document.getElementById('usersTableBody').innerHTML = filtered.map(u => {
    const avatar = u.photoUrl
      ? `<img class="user-avatar-photo" src="${u.photoUrl}" alt="${u.name}">`
      : `<div class="user-avatar" style="background:${roleColors[u.role] || '#6b7280'}">${(u.firstName || u.name || '?').charAt(0)}</div>`;

    const tags = (u.tags || []).map(t => `<span class="tag-chip" style="font-size:10px;padding:1px 6px">${t}</span>`).join(' ') || '<span style="color:var(--text-faint);font-size:11px">—</span>';

    const rels = (u.relationships || []).map(r => {
      const relUser = allUsers.find(ru => ru.id === r.userId);
      return `<span style="font-size:11px;color:var(--text-secondary)">${relTypeLabels[r.type] || r.type}: ${relUser?.name || r.userId}</span>`;
    }).join('<br>') || '<span style="color:var(--text-faint);font-size:11px">—</span>';

    const contact = [
      u.phoneMobile ? `📱 ${u.phoneMobile}` : '',
      u.phoneLandline ? `📞 ${u.phoneLandline}` : '',
    ].filter(Boolean).join('<br>') || '<span style="color:var(--text-faint);font-size:11px">—</span>';

    return `
      <tr style="cursor:pointer" onclick="openUserDrawer('${u.id}')">
        <td>
          <div class="user-cell-enhanced">
            ${avatar}
            <div class="user-info-col">
              <span class="user-name-main">${u.name || `${u.firstName || ''} ${u.lastName || ''}`}</span>
              <span class="user-email-sub">${u.email}</span>
            </div>
          </div>
        </td>
        <td style="font-size:12px">${contact}</td>
        <td><span class="badge badge-${u.role}">${roleLabels[u.role] || u.role.toUpperCase()}</span></td>
        <td style="max-width:160px">${tags}</td>
        <td><span class="badge badge-${u.status}">${u.status.toUpperCase()}</span></td>
        <td style="font-size:11px;max-width:180px">${rels}</td>
        <td>
          <div class="action-group" onclick="event.stopPropagation()">
            <button class="btn btn-sm btn-secondary" onclick="openUserDrawer('${u.id}')">✏️ Éditer</button>
            <button class="btn btn-sm btn-danger" onclick="confirmDeleteUser('${u.id}', '${(u.name || '').replace(/'/g, "\\'")}')">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

function filterUsers() { renderUsers(); }

// ═══════════════════════════════════════════════════════════
// USER DRAWER — Add / Edit / View
// ═══════════════════════════════════════════════════════════
function openUserDrawer(userId) {
  editingUserId = userId || null;
  currentTags = [];
  currentRelationships = [];
  currentPhotoUrl = '';

  if (editingUserId) {
    // Edit mode
    const user = allUsers.find(u => u.id === editingUserId);
    if (!user) { showToast('Utilisateur non trouvé', 'error'); return; }
    document.getElementById('drawerTitle').textContent = `Éditer: ${user.name}`;
    document.getElementById('fieldFirstName').value = user.firstName || '';
    document.getElementById('fieldLastName').value = user.lastName || '';
    document.getElementById('fieldEmail').value = user.email || '';
    document.getElementById('fieldPhoneMobile').value = user.phoneMobile || '';
    document.getElementById('fieldPhoneLandline').value = user.phoneLandline || '';
    document.getElementById('fieldAddress').value = user.address || '';
    document.getElementById('fieldRole').value = user.role || 'user';
    document.getElementById('fieldStatus').value = user.status || 'active';
    document.getElementById('fieldComments').value = user.comments || '';
    document.getElementById('fieldPassword').value = '';
    document.getElementById('fieldPassword').placeholder = user.hasPassword ? '••••••••  (laisser vide pour ne pas changer)' : 'Définir un mot de passe';
    document.getElementById('passwordIndicator').textContent = user.hasPassword ? '✅ Mot de passe défini' : '⚠️ Aucun mot de passe';
    document.getElementById('passwordIndicator').className = user.hasPassword ? 'password-indicator set' : 'password-indicator not-set';
    currentTags = [...(user.tags || [])];
    currentRelationships = [...(user.relationships || [])];
    currentPhotoUrl = user.photoUrl || '';
    document.getElementById('deleteZone').style.display = 'block';
    document.getElementById('btnSaveUser').textContent = '💾 Mettre à jour';
  } else {
    // New user mode
    document.getElementById('drawerTitle').textContent = 'Nouvel Utilisateur';
    document.getElementById('fieldFirstName').value = '';
    document.getElementById('fieldLastName').value = '';
    document.getElementById('fieldEmail').value = '';
    document.getElementById('fieldPhoneMobile').value = '';
    document.getElementById('fieldPhoneLandline').value = '';
    document.getElementById('fieldAddress').value = '';
    document.getElementById('fieldRole').value = 'user';
    document.getElementById('fieldStatus').value = 'active';
    document.getElementById('fieldComments').value = '';
    document.getElementById('fieldPassword').value = '';
    document.getElementById('fieldPassword').placeholder = 'Mot de passe initial';
    document.getElementById('passwordIndicator').textContent = '';
    document.getElementById('passwordIndicator').className = 'password-indicator';
    document.getElementById('deleteZone').style.display = 'none';
    document.getElementById('btnSaveUser').textContent = '💾 Enregistrer';
  }

  renderTagsInDrawer();
  currentAddresses = [];
  if (editingUserId) loadUserAddresses(editingUserId);
  renderRelationshipsInDrawer();
  updatePhotoPreview();
  populateRelUserSelect();
  updateSameAddressInfo();

  document.getElementById('userDrawer').classList.add('visible');
}

function closeUserDrawer() {
  document.getElementById('userDrawer').classList.remove('visible');
  editingUserId = null;
}

function closeUserDrawerOverlay(event) {
  if (event.target === document.getElementById('userDrawer')) {
    closeUserDrawer();
  }
}

// ─── Tags ────────────────────────────────────────────────────────
function renderTagsInDrawer() {
  const container = document.getElementById('tagsContainer');
  const input = document.getElementById('tagInput');
  // Remove all tag chips, keep only the input
  container.querySelectorAll('.tag-chip').forEach(c => c.remove());
  currentTags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';
    chip.innerHTML = `${tag}<span class="tag-remove" onclick="removeTag(${i})">&times;</span>`;
    container.insertBefore(chip, input);
  });
}

function handleTagKeydown(event) {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    const val = event.target.value.trim().replace(/,/g, '');
    if (val && !currentTags.includes(val)) {
      currentTags.push(val);
      renderTagsInDrawer();
    }
    event.target.value = '';
  } else if (event.key === 'Backspace' && !event.target.value && currentTags.length > 0) {
    currentTags.pop();
    renderTagsInDrawer();
  }
}

function removeTag(index) {
  currentTags.splice(index, 1);
  renderTagsInDrawer();
}

// ─── Photo ───────────────────────────────────────────────────────
function handlePhotoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    currentPhotoUrl = e.target.result; // data URL
    updatePhotoPreview();
  };
  reader.readAsDataURL(file);
}

function clearPhoto() {
  currentPhotoUrl = '';
  document.getElementById('photoInput').value = '';
  updatePhotoPreview();
}

function updatePhotoPreview() {
  const preview = document.getElementById('photoPreview');
  const clearBtn = document.getElementById('btnClearPhoto');
  if (currentPhotoUrl) {
    preview.innerHTML = `<img src="${currentPhotoUrl}" alt="Photo">`;
    clearBtn.style.display = 'inline-flex';
  } else {
    preview.innerHTML = '👤';
    clearBtn.style.display = 'none';
  }
}

// ─── Relationships ───────────────────────────────────────────────
const relTypeLabelsMap = { spouse: 'Conjoint(e)', parent: 'Parent', child: 'Enfant', sibling: 'Frère/Sœur', cohabitant: 'Cohabitant', other: 'Autre' };

function renderRelationshipsInDrawer() {
  const list = document.getElementById('relationshipsList');
  if (currentRelationships.length === 0) {
    list.innerHTML = '<p style="color:var(--text-faint);font-size:12px;padding:4px 0">Aucune relation définie</p>';
    return;
  }
  list.innerHTML = currentRelationships.map((rel, i) => {
    const relUser = allUsers.find(u => u.id === rel.userId);
    return `
      <div class="relationship-row">
        <span class="rel-type">${relTypeLabelsMap[rel.type] || rel.type}</span>
        <span class="rel-user">${relUser?.name || rel.userId}</span>
        <span class="rel-remove" onclick="removeRelationship(${i})">&times;</span>
      </div>
    `;
  }).join('');
}

function populateRelUserSelect() {
  const select = document.getElementById('relUserSelect');
  const otherUsers = allUsers.filter(u => u.id !== editingUserId);
  select.innerHTML = '<option value="">-- Sélectionner un utilisateur --</option>' +
    otherUsers.map(u => `<option value="${u.id}">${u.name} (${u.role})</option>`).join('');
}

function addRelationship() {
  const userId = document.getElementById('relUserSelect').value;
  const type = document.getElementById('relTypeSelect').value;
  if (!userId) { showToast('Sélectionnez un utilisateur', 'warning'); return; }
  if (currentRelationships.find(r => r.userId === userId)) {
    showToast('Cette relation existe déjà', 'warning'); return;
  }
  currentRelationships.push({ userId, type });
  renderRelationshipsInDrawer();
  document.getElementById('relUserSelect').value = '';
}

function removeRelationship(index) {
  currentRelationships.splice(index, 1);
  renderRelationshipsInDrawer();
}

// ─── Same Address Info ───────────────────────────────────────────
function updateSameAddressInfo() {
  const address = document.getElementById('fieldAddress').value.trim();
  const infoDiv = document.getElementById('sameAddressInfo');
  if (!address) { infoDiv.style.display = 'none'; return; }
  const sameAddr = allUsers.filter(u => u.id !== editingUserId && u.address && u.address.toLowerCase() === address.toLowerCase());
  if (sameAddr.length > 0) {
    infoDiv.style.display = 'block';
    infoDiv.innerHTML = `
      <div class="info-box info-box-blue">
        <span class="info-box-icon">🏠</span>
        <div class="info-box-text">
          <strong>${sameAddr.length} autre(s) utilisateur(s) à la même adresse :</strong><br>
          ${sameAddr.map(u => `• ${u.name} (${u.role})`).join('<br>')}
        </div>
      </div>
    `;
  } else {
    infoDiv.style.display = 'none';
  }
}

// Listen for address changes to update same-address info
document.addEventListener('DOMContentLoaded', () => {
  const addrField = document.getElementById('fieldAddress');
  if (addrField) {
    addrField.addEventListener('input', () => {
      updateSameAddressInfo();
      // Address autocomplete with debounce
      clearTimeout(addressDebounceTimer);
      addressDebounceTimer = setTimeout(() => searchAddress(addrField.value), 400);
    });
    addrField.addEventListener('blur', () => {
      setTimeout(() => {
        document.getElementById('addressSuggestions').classList.remove('visible');
      }, 200);
    });
  }
});

// ─── Address Autocomplete (Nominatim / OpenStreetMap) ────────────
async function searchAddress(query) {
  const suggestionsDiv = document.getElementById('addressSuggestions');
  if (!query || query.length < 3) {
    suggestionsDiv.classList.remove('visible');
    return;
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=1&accept-language=fr`);
    const results = await res.json();
    if (results.length === 0) {
      suggestionsDiv.classList.remove('visible');
      return;
    }
    suggestionsDiv.innerHTML = results.map(r => `
      <div class="address-suggestion-item" onclick="selectAddress('${r.display_name.replace(/'/g, "\\'")}')">
        📍 ${r.display_name}
      </div>
    `).join('');
    suggestionsDiv.classList.add('visible');
  } catch (err) {
    console.error('Address search error:', err);
    suggestionsDiv.classList.remove('visible');
  }
}

function selectAddress(address) {
  document.getElementById('fieldAddress').value = address;
  document.getElementById('addressSuggestions').classList.remove('visible');
  updateSameAddressInfo();
}

// ─── Save User ───────────────────────────────────────────────────
async function saveUser() {
  const firstName = document.getElementById('fieldFirstName').value.trim();
  const lastName = document.getElementById('fieldLastName').value.trim();
  const email = document.getElementById('fieldEmail').value.trim();

  if (!firstName || !lastName || !email) {
    showToast('Prénom, nom et email sont obligatoires', 'error');
    return;
  }

  const password = document.getElementById('fieldPassword').value;
  const payload = {
    firstName,
    lastName,
    email,
    role: document.getElementById('fieldRole').value,
    status: document.getElementById('fieldStatus').value,
    tags: currentTags,
    address: document.getElementById('fieldAddress').value.trim(),
    phoneMobile: document.getElementById('fieldPhoneMobile').value.trim(),
    phoneLandline: document.getElementById('fieldPhoneLandline').value.trim(),
    comments: document.getElementById('fieldComments').value.trim(),
    photoUrl: currentPhotoUrl,
    relationships: currentRelationships,
  };
  // Only include password if user typed one
  if (password) payload.password = password;

  try {
    let res;
    if (editingUserId) {
      res = await fetch(`${API_BASE}/admin/users/${editingUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      res = await fetch(`${API_BASE}/admin/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }

    if (res.ok) {
      showToast(editingUserId ? `✅ ${firstName} ${lastName} mis à jour` : `✅ ${firstName} ${lastName} créé`, 'success');
      closeUserDrawer();
      await refreshData();
    } else {
      const err = await res.json();
      showToast(`❌ Erreur: ${err.error || 'Échec'}`, 'error');
    }
  } catch (err) {
    console.error('Save user error:', err);
    showToast('❌ Erreur de connexion au serveur', 'error');
  }
}

// ─── Delete User ─────────────────────────────────────────────────
function deleteCurrentUser() {
  if (!editingUserId) return;
  const user = allUsers.find(u => u.id === editingUserId);
  if (!confirm(`Êtes-vous sûr de vouloir supprimer définitivement ${user?.name || 'cet utilisateur'} ?`)) return;
  performDeleteUser(editingUserId);
}

function confirmDeleteUser(userId, userName) {
  if (!confirm(`Êtes-vous sûr de vouloir supprimer définitivement ${userName} ?`)) return;
  performDeleteUser(userId);
}

async function performDeleteUser(userId) {
  try {
    const res = await fetch(`${API_BASE}/admin/users/${userId}`, { method: 'DELETE' });
    if (res.ok) {
      showToast('🗑️ Utilisateur supprimé', 'success');
      closeUserDrawer();
      await refreshData();
    } else {
      const err = await res.json();
      showToast(`❌ Erreur: ${err.error}`, 'error');
    }
  } catch (err) {
    showToast('❌ Erreur de connexion', 'error');
  }
}

// ─── Legacy User Actions (Role Modal) ────────────────────────────
function openRoleModal(userId) {
  selectedUserForRole = allUsers.find(u => u.id === userId);
  if (!selectedUserForRole) return;
  document.getElementById('roleModalSubtitle').textContent =
    `${selectedUserForRole.name} - Actuellement: ${selectedUserForRole.role.charAt(0).toUpperCase() + selectedUserForRole.role.slice(1)}`;
  const roles = ['admin', 'dispatcher', 'responder', 'user'];
  const roleColors = { admin: '#7c3aed', dispatcher: '#1e3a5f', responder: '#059669', user: '#6b7280' };
  document.getElementById('roleOptions').innerHTML = roles.map(role => `
    <div class="role-option ${selectedUserForRole.role === role ? 'disabled' : ''}" onclick="changeRole('${userId}', '${role}')">
      <span class="role-dot" style="background:${roleColors[role]}"></span>
      <span class="role-option-label">${role.charAt(0).toUpperCase() + role.slice(1)}</span>
    </div>
  `).join('');
  document.getElementById('roleModal').classList.add('visible');
}

function closeRoleModal() {
  document.getElementById('roleModal').classList.remove('visible');
  selectedUserForRole = null;
}

async function changeRole(userId, newRole) {
  try {
    const res = await fetch(`${API_BASE}/admin/users/${userId}/role`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) { closeRoleModal(); await refreshData(); }
  } catch (err) { console.error('Failed to change role:', err); }
}

async function toggleUserStatus(userId) {
  const user = allUsers.find(u => u.id === userId);
  if (!user) return;
  const newStatus = user.status === 'active' ? 'suspended' : 'active';
  try {
    await fetch(`${API_BASE}/admin/users/${userId}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }),
    });
    await refreshData();
  } catch (err) { console.error('Failed to toggle status:', err); }
}

async function deactivateUser(userId) {
  if (!confirm('Êtes-vous sûr de vouloir désactiver cet utilisateur ?')) return;
  try {
    await fetch(`${API_BASE}/admin/users/${userId}/status`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'deactivated' }),
    });
    await refreshData();
  } catch (err) { console.error('Failed to deactivate:', err); }
}

// ═══════════════════════════════════════════════════════════
// INCIDENTS
// ═══════════════════════════════════════════════════════════
function renderIncidents() {
  let filtered = allIncidents;
  if (currentIncidentFilter !== 'all') {
    if (currentIncidentFilter === 'active') {
      filtered = filtered.filter(i => i.status !== 'resolved');
    } else {
      filtered = filtered.filter(i => i.status === currentIncidentFilter);
    }
  }
  filtered.sort((a, b) => b.timestamp - a.timestamp);

  document.getElementById('incActive').textContent = `${allIncidents.filter(i => i.status !== 'resolved').length} Active`;
  document.getElementById('incResolved').textContent = `${allIncidents.filter(i => i.status === 'resolved').length} Resolved`;
  document.getElementById('incTotal').textContent = `${allIncidents.length} Total`;

  const typeIcons = { sos: '🆘', medical: '🏥', fire: '🔥', security: '🔒', hazard: '⚠️', accident: '🚗' };
  document.getElementById('incidentsTableBody').innerHTML = filtered.map(i => `
    <tr>
      <td><strong>${formatIncidentId(i.id)}</strong></td>
      <td>${typeIcons[i.type] || '\ud83d\udea8'} ${typeLbl(i.type)}</td>
      <td><span class="badge badge-${i.severity}">${sevLbl(i.severity)}</span></td>
      <td><span class="badge badge-${i.status}">${statLbl(i.status)}</span></td>
      <td>${i.reportedBy}</td>
      <td>${i.address}</td>
      <td>${formatDate(i.timestamp)}</td>
      <td>${i.assignedCount}</td>
    </tr>
  `).join('');
}

function filterIncidents(filter) {
  currentIncidentFilter = filter;
  document.querySelectorAll('#tab-incidents .chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`#tab-incidents .chip[data-filter="${filter}"]`).classList.add('active');
  renderIncidents();
}

// ═══════════════════════════════════════════════════════════
// AUDIT LOG
// ═══════════════════════════════════════════════════════════
function renderAudit() {
  let filtered = allAudit;
  if (currentAuditFilter !== 'all') {
    filtered = filtered.filter(e => e.category === currentAuditFilter);
  }
  filtered.sort((a, b) => b.timestamp - a.timestamp);

  const catIcons = { auth: '🔐', incident: '🚨', user: '👤', system: '⚙️', broadcast: '📢' };
  document.getElementById('auditTableBody').innerHTML = filtered.map(e => `
    <tr>
      <td>${formatDate(e.timestamp)}</td>
      <td><span class="badge badge-${e.category}">${(catIcons[e.category] || '') + ' ' + e.category.toUpperCase()}</span></td>
      <td><strong>${e.action}</strong></td>
      <td>${e.performedBy}</td>
      <td>${e.targetUser || '-'}</td>
      <td>${e.details}</td>
    </tr>
  `).join('');
}

function filterAudit(filter) {
  currentAuditFilter = filter;
  document.querySelectorAll('#tab-audit .chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`#tab-audit .chip[data-filter="${filter}"]`).classList.add('active');
  renderAudit();
}

function exportAuditCSV() {
  let data = allAudit;
  if (currentAuditFilter !== 'all') data = data.filter(e => e.category === currentAuditFilter);
  const header = 'Time,Category,Action,Performed By,Target,Details\n';
  const rows = data.map(e =>
    `"${formatDate(e.timestamp)}","${e.category}","${e.action}","${e.performedBy}","${e.targetUser || ''}","${e.details.replace(/"/g, '""')}"`
  ).join('\n');
  const blob = new Blob([header + rows], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `talion_audit_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'À l\'instant';
  if (minutes < 60) return `il y a ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days}j`;
  return `il y a ${Math.floor(days / 30)} mois`;
}

function formatDate(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ═══════════════════════════════════════════════════════════
// BROWSER NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
let browserNotificationsEnabled = false;
let notifPermission = 'default';

function initBrowserNotifications() {
  if (!('Notification' in window)) { updateNotifButton('unsupported'); return; }
  notifPermission = Notification.permission;
  if (notifPermission === 'granted') { browserNotificationsEnabled = true; updateNotifButton('enabled'); }
  else if (notifPermission === 'denied') { updateNotifButton('denied'); }
  else { updateNotifButton('disabled'); }
}

function toggleBrowserNotifications() {
  if (!('Notification' in window)) { showToast('❌ Votre navigateur ne supporte pas les notifications', 'error'); return; }
  if (browserNotificationsEnabled) { browserNotificationsEnabled = false; updateNotifButton('disabled'); showToast('🔕 Notifications désactivées', 'info'); return; }
  if (notifPermission === 'denied') { showToast('⚠️ Notifications bloquées. Activez-les dans les paramètres du navigateur.', 'warning'); return; }
  Notification.requestPermission().then(permission => {
    notifPermission = permission;
    if (permission === 'granted') {
      browserNotificationsEnabled = true; updateNotifButton('enabled');
      showToast('🔔 Notifications activées', 'success');
    } else { updateNotifButton('denied'); showToast('⚠️ Permission refusée', 'warning'); }
  });
}

function updateNotifButton(state) {
  const btn = document.getElementById('btnNotifToggle');
  if (!btn) return;
  switch (state) {
    case 'enabled': btn.textContent = '🔔 Notifications ON'; btn.style.background = '#059669'; btn.style.color = '#fff'; btn.style.borderColor = '#059669'; break;
    case 'disabled': btn.textContent = '🔕 Notifications OFF'; btn.style.background = 'transparent'; btn.style.color = '#94a3b8'; btn.style.borderColor = '#334155'; break;
    case 'denied': btn.textContent = '🚫 Notifications Blocked'; btn.style.background = 'transparent'; btn.style.color = '#f87171'; btn.style.borderColor = '#7f1d1d'; break;
    case 'unsupported': btn.textContent = '❌ Not Supported'; btn.style.background = 'transparent'; btn.style.color = '#6b7280'; btn.style.borderColor = '#374151'; btn.disabled = true; break;
  }
}

function sendBrowserNotification(title, body, severity, tag) {
  if (!browserNotificationsEnabled || notifPermission !== 'granted') return;
  if (document.hasFocus()) return;
  const iconMap = { critical: '🆘', high: '🔥', medium: '⚠️', low: 'ℹ️', info: 'ℹ️', success: '✅', warning: '⚠️', error: '🚨' };
  try {
    const notif = new Notification(`${iconMap[severity] || '📢'} ${title}`, {
      body, tag: tag || `talion-admin-${Date.now()}`, requireInteraction: severity === 'critical' || severity === 'high', silent: false,
    });
    notif.onclick = () => { window.focus(); notif.close(); };
    if (severity !== 'critical' && severity !== 'high') setTimeout(() => notif.close(), 10000);
  } catch (e) { console.warn('[Notif] Failed:', e); }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initBrowserNotifications);
} else {
  initBrowserNotifications();
}

// ═══════════════════════════════════════════════════════════
// THEME TOGGLE
// ═══════════════════════════════════════════════════════════
(function initTheme() {
  const saved = localStorage.getItem('talion-admin-theme');
  if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else if (saved === 'light') document.documentElement.removeAttribute('data-theme');
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.setAttribute('data-theme', 'dark');
  updateThemeButton();
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('talion-admin-theme')) {
        if (e.matches) document.documentElement.setAttribute('data-theme', 'dark');
        else document.documentElement.removeAttribute('data-theme');
        updateThemeButton();
      }
    });
  }
})();

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) { document.documentElement.removeAttribute('data-theme'); localStorage.setItem('talion-admin-theme', 'light'); }
  else { document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('talion-admin-theme', 'dark'); }
  updateThemeButton();
}

function updateThemeButton() {
  const btn = document.getElementById('btnThemeToggle');
  if (!btn) return;
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  btn.textContent = isDark ? '☀️ Clair' : '🌙 Sombre';
  btn.title = isDark ? 'Passer en mode clair' : 'Passer en mode sombre';
}

// ─── Password Toggle ────────────────────────────────────────────
function togglePasswordVisibility() {
  const field = document.getElementById('fieldPassword');
  if (field.type === 'password') {
    field.type = 'text';
  } else {
    field.type = 'password';
  }
}


// ─── Login History ──────────────────────────────────────────────────
let currentLHPage = 1;
let currentLHFilter = 'all';
let currentLHSearch = '';
let currentLHUserFilter = '';

const STATUS_LABELS = {
  success: { label: 'Succès', cls: 'badge-success', icon: '✅' },
  failed_password: { label: 'Mot de passe incorrect', cls: 'badge-error', icon: '❌' },
  failed_email: { label: 'Email inconnu', cls: 'badge-error', icon: '🚫' },
  account_deactivated: { label: 'Compte désactivé', cls: 'badge-warning', icon: '🛑' },
  account_suspended: { label: 'Compte suspendu', cls: 'badge-warning', icon: '⚠️' },
  no_password: { label: 'Pas de mot de passe', cls: 'badge-warning', icon: '🔓' },
};

async function loadLoginHistory(page = 1) {
  currentLHPage = page;
  try {
    const params = new URLSearchParams({ page: String(page), limit: '50' });
    if (currentLHFilter && currentLHFilter !== 'all') params.set('status', currentLHFilter);
    if (currentLHUserFilter) params.set('userId', currentLHUserFilter);
    if (currentLHSearch) params.set('search', currentLHSearch);

    const res = await fetch(`${API_BASE}/admin/login-history?${params}`);
    const data = await res.json();
    renderLoginHistoryTable(data.entries);
    updateLHPagination(data.page, data.totalPages, data.total);
  } catch (err) {
    console.error('Failed to load login history:', err);
  }
}

function renderLoginHistoryTable(entries) {
  const tbody = document.getElementById('loginHistoryTableBody');
  if (!entries || entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text-secondary);font-style:italic;">Aucun historique de connexion disponible. Les connexions seront enregistrées ici.</td></tr>';
    return;
  }
  tbody.innerHTML = entries.map(e => {
    const date = new Date(e.timestamp);
    const dateStr = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const st = STATUS_LABELS[e.status] || { label: e.status, cls: '', icon: '?' };
    const uaShort = e.userAgent.length > 60 ? e.userAgent.substring(0, 60) + '...' : e.userAgent;
    return `<tr class="${e.status !== 'success' ? 'row-error' : ''}">
      <td><div style="font-weight:500">${dateStr}</div><div style="font-size:11px;color:var(--text-secondary)">${timeStr}</div></td>
      <td>${e.userName !== 'Unknown' ? `<a href="#" onclick="viewUserLoginHistory('${e.userId}');return false;" style="color:var(--primary);text-decoration:none;font-weight:500;">${e.userName}</a>` : '<span style="color:var(--text-secondary);font-style:italic;">Inconnu</span>'}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${e.email}</td>
      <td><span class="badge ${st.cls}">${st.icon} ${st.label}</span></td>
      <td style="font-family:monospace;font-size:12px;">${e.ip}</td>
      <td><span class="badge badge-info">${e.device}</span></td>
      <td style="font-size:11px;color:var(--text-secondary);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${e.userAgent}">${uaShort}</td>
    </tr>`;
  }).join('');
}

function updateLHPagination(page, totalPages, total) {
  document.getElementById('lhPageInfo').textContent = `Page ${page} / ${Math.max(totalPages, 1)} (${total} entrées)`;
  document.getElementById('lhPrevBtn').disabled = page <= 1;
  document.getElementById('lhNextBtn').disabled = page >= totalPages;
}

async function loadLoginStats() {
  try {
    const res = await fetch(`${API_BASE}/admin/login-stats`);
    const data = await res.json();
    document.getElementById('loginSuccess24h').textContent = data.last24h.success;
    document.getElementById('loginFailed24h').textContent = data.last24h.failed;
    document.getElementById('loginUniqueUsers24h').textContent = data.last24h.uniqueUsers;
    document.getElementById('loginTotal').textContent = data.totalEntries;

    // Suspicious IPs
    const alertEl = document.getElementById('suspiciousIpsAlert');
    if (data.suspiciousIps && data.suspiciousIps.length > 0) {
      alertEl.style.display = 'block';
      document.getElementById('suspiciousIpsList').textContent = data.suspiciousIps.map(s => `${s.ip} (${s.failedAttempts} échecs)`).join(', ');
    } else {
      alertEl.style.display = 'none';
    }
  } catch (err) {
    console.error('Failed to load login stats:', err);
  }
}

function populateLoginHistoryUserFilter() {
  const select = document.getElementById('loginHistoryUserFilter');
  // Keep first option
  select.innerHTML = '<option value="">Tous les utilisateurs</option>';
  allUsers.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.name;
    if (u.id === currentLHUserFilter) opt.selected = true;
    select.appendChild(opt);
  });
}

function filterLoginHistory(status) {
  currentLHFilter = status;
  // Update chip active state
  document.querySelectorAll('[data-lh-filter]').forEach(c => c.classList.remove('active'));
  const activeChip = document.querySelector(`[data-lh-filter="${status}"]`);
  if (activeChip) activeChip.classList.add('active');
  loadLoginHistory(1);
}

function searchLoginHistory() {
  clearTimeout(window._lhSearchTimer);
  window._lhSearchTimer = setTimeout(() => {
    currentLHSearch = document.getElementById('loginHistorySearch').value.trim();
    loadLoginHistory(1);
  }, 300);
}

function filterLoginHistoryByUser() {
  currentLHUserFilter = document.getElementById('loginHistoryUserFilter').value;
  loadLoginHistory(1);
}

function viewUserLoginHistory(userId) {
  currentLHUserFilter = userId;
  document.getElementById('loginHistoryUserFilter').value = userId;
  currentLHFilter = 'all';
  document.querySelectorAll('[data-lh-filter]').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-lh-filter="all"]').classList.add('active');
  loadLoginHistory(1);
}

function exportLoginHistoryCSV() {
  const params = new URLSearchParams({ page: '1', limit: '10000' });
  if (currentLHFilter && currentLHFilter !== 'all') params.set('status', currentLHFilter);
  if (currentLHUserFilter) params.set('userId', currentLHUserFilter);
  if (currentLHSearch) params.set('search', currentLHSearch);

  fetch(`${API_BASE}/admin/login-history?${params}`)
    .then(r => r.json())
    .then(data => {
      const rows = [['Date', 'Heure', 'Utilisateur', 'Email', 'Statut', 'IP', 'Appareil', 'User Agent']];
      data.entries.forEach(e => {
        const d = new Date(e.timestamp);
        rows.push([
          d.toLocaleDateString('fr-FR'),
          d.toLocaleTimeString('fr-FR'),
          e.userName,
          e.email,
          (STATUS_LABELS[e.status] || {}).label || e.status,
          e.ip,
          e.device,
          `"${e.userAgent.replace(/"/g, '""')}"`,
        ]);
      });
      const csv = rows.map(r => r.join(',')).join('\n');
      const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `login-history-${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
    });
}

// ─── User Addresses Management ────────────────────────────────────────────
let currentAddresses = [];

const ADDR_TYPE_ICONS = {
  'Résidence principale': '🏠',
  'Résidence secondaire': '🏡',
  'Bureau': '🏢',
  'École': '🏫',
  'Hôtel': '🏨',
  'Autre': '📍',
};

function getAddrIcon(label) {
  for (const [key, icon] of Object.entries(ADDR_TYPE_ICONS)) {
    if (label && label.includes(key)) return icon;
  }
  return '📍';
}

async function loadUserAddresses(userId) {
  try {
    const res = await fetch(`${API_BASE}/api/users/${userId}/addresses`);
    currentAddresses = await res.json();
    renderAddressesInDrawer();
  } catch (e) {
    currentAddresses = [];
    renderAddressesInDrawer();
  }
}

function renderAddressesInDrawer() {
  const container = document.getElementById('addressesContainer');
  if (!container) return;
  if (currentAddresses.length === 0) {
    container.innerHTML = '<p style="color:var(--text-faint);font-size:12px;padding:4px 0">Aucune adresse enregistrée</p>';
    return;
  }
  container.innerHTML = currentAddresses.map((addr) => {
    const icon = getAddrIcon(addr.label);
    return `
    <div style="background:var(--bg-secondary);border-radius:10px;padding:12px 14px;margin-bottom:8px;border:1px solid var(--border);${addr.isPrimary ? 'border-left:3px solid #1e3a5f;' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div style="flex:1;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="font-size:18px;">${icon}</span>
            <span style="font-weight:700;font-size:13px;color:var(--text-primary);">${addr.label}</span>
            ${addr.isPrimary ? '<span style="background:#1e3a5f;color:white;font-size:10px;padding:2px 8px;border-radius:12px;font-weight:600;">PRINCIPAL</span>' : ''}
          </div>
          <div style="font-size:12px;color:var(--text-secondary);margin-left:26px;">${addr.address}</div>
          ${addr.alarmCode ? `<div style="font-size:11px;color:var(--text-faint);margin-top:3px;margin-left:26px;">🔑 Code alarme: <strong>${addr.alarmCode}</strong></div>` : ''}
          ${addr.notes ? `<div style="font-size:11px;color:var(--text-faint);margin-top:2px;margin-left:26px;">📝 ${addr.notes}</div>` : ''}
        </div>
        <div style="display:flex;gap:4px;margin-left:8px;">
          <button onclick="editAddress('${addr.id}')" style="background:none;border:1px solid #e5e7eb;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;">✏️</button>
          <button onclick="deleteAddress('${addr.id}')" style="background:none;border:1px solid #fecaca;border-radius:6px;padding:4px 8px;cursor:pointer;font-size:11px;color:#dc2626;">🗑️</button>
        </div>
      </div>
    </div>`;
  }).join('');
}

function selectAddrType(label, icon) {
  document.getElementById('addrLabel').value = label;
  document.getElementById('addrTypeIcon').value = icon;
  document.querySelectorAll('.addr-type-btn').forEach(btn => {
    const isSelected = btn.dataset.type === label;
    btn.style.border = isSelected ? '2px solid #1e3a5f' : '2px solid var(--border)';
    btn.style.background = isSelected ? '#e8f0fe' : 'none';
  });
}

let addrSearchTimer = null;
function searchAddrAddress(query) {
  clearTimeout(addrSearchTimer);
  const suggestions = document.getElementById('addrAddressSuggestions');
  if (!query || query.length < 3) { suggestions.style.display = 'none'; return; }
  addrSearchTimer = setTimeout(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/geocode?q=${encodeURIComponent(query)}`);
      const results = await res.json();
      if (!results.length) { suggestions.style.display = 'none'; return; }
      suggestions._results = results;
      suggestions.innerHTML = results.map((r, i) => {
        const a = r.address || {};
        const street = [a.house_number, a.road].filter(Boolean).join(' ') || r.display_name.split(',')[0];
        const city = a.city || a.town || a.village || a.municipality || '';
        const country = a.country || '';
        const subText = [city, country].filter(Boolean).join(', ');
        return `<div onclick="selectAddrSuggestion(${i})"
             style="padding:10px 14px;cursor:pointer;border-bottom:1px solid #f3f4f6;background:#fff;"
             onmouseover="this.style.background='#f9fafb'" onmouseout="this.style.background='#fff'">
          <div style="font-size:13px;font-weight:600;color:#1f2937;">📍 ${street}</div>
          <div style="font-size:11px;color:#6b7280;margin-top:2px;">${subText}</div>
        </div>`;
      }).join('');
      suggestions.style.display = 'block';
    } catch(e) { console.error('Geocode error:', e); }
  }, 800);
}

function selectAddrSuggestion(idx) {
  const suggestions = document.getElementById('addrAddressSuggestions');
  if (!suggestions._results || !suggestions._results[idx]) return;
  const r = suggestions._results[idx];
  const a = r.address || {};
  const street = [a.house_number, a.road].filter(Boolean).join(' ') || r.display_name.split(',')[0];
  const city = a.city || a.town || a.village || a.municipality || '';
  const country = a.country || '';
  const fullAddress = [street, city, country].filter(Boolean).join(', ');

  const addrEl = document.getElementById('addrAddress');
  if (addrEl) { addrEl.value = fullAddress; addrEl.dataset.lat = r.lat; addrEl.dataset.lon = r.lon; }

  const searchEl = document.getElementById('addrSearch');
  if (searchEl) searchEl.value = fullAddress;
  const streetEl = document.getElementById('addrStreet');
  if (streetEl) streetEl.value = street;
  const cityEl = document.getElementById('addrCity');
  if (cityEl) cityEl.value = city;
  const countryEl = document.getElementById('addrCountry');
  if (countryEl) countryEl.value = country;

  suggestions.style.display = 'none';
}


function showAddAddressForm() {
  const modal = document.getElementById('addAddressModal');
  if (modal) {
    selectAddrType('Résidence principale', '🏠');
    const addrEl = document.getElementById('addrAddress');
    addrEl.value = '';
    addrEl.removeAttribute('data-lat');
    addrEl.removeAttribute('data-lon');
    const countryEl = document.getElementById('addrCountry');
    if (countryEl) countryEl.value = '';
    document.getElementById('addrAlarmCode').value = '';
    document.getElementById('addrNotes').value = '';
    document.getElementById('addrIsPrimary').checked = currentAddresses.length === 0;
    document.getElementById('addrAddressSuggestions').style.display = 'none';
    modal.style.display = 'flex';
  }
}

function closeAddAddressModal() {
  const modal = document.getElementById('addAddressModal');
  if (modal) modal.style.display = 'none';
}

async function saveAddress() {
  const label = document.getElementById('addrLabel').value.trim();
  const addrEl = document.getElementById('addrAddress');
  const street = document.getElementById('addrStreet')?.value.trim() || '';
  const city = document.getElementById('addrCity')?.value.trim() || '';
  const countryVal = document.getElementById('addrCountry')?.value.trim() || '';
  const address = addrEl.value.trim() || [street, city, countryVal].filter(Boolean).join(', ');
  const alarmCode = document.getElementById('addrAlarmCode').value.trim();
  const notes = document.getElementById('addrNotes').value.trim();
  const isPrimary = document.getElementById('addrIsPrimary').checked;
  const latitude = parseFloat(addrEl.dataset.lat) || null;
  const longitude = parseFloat(addrEl.dataset.lon) || null;
  const country = document.getElementById('addrCountry')?.value.trim() || null;

  if (!label || !address) { showToast('Type et adresse obligatoires', 'error'); return; }
  if (!editingUserId) { showToast('Sauvegardez d\'abord l\'utilisateur', 'error'); return; }

  const modal = document.getElementById('addAddressModal');
  const editingAddressId = modal?._editingAddressId;
  if (modal) modal._editingAddressId = null;

  const method = editingAddressId ? 'PUT' : 'POST';
  const url = editingAddressId 
    ? `${API_BASE}/api/users/${editingUserId}/addresses/${editingAddressId}`
    : `${API_BASE}/api/users/${editingUserId}/addresses`;

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, address, latitude, longitude, isPrimary, alarmCode: alarmCode || null, notes: notes || null, country: country || null }),
    });
    if (res.ok) {
      showToast(editingAddressId ? '✅ Adresse mise à jour' : '✅ Adresse ajoutée', 'success');
      closeAddAddressModal();
      await loadUserAddresses(editingUserId);
    } else {
      showToast('❌ Erreur lors de l\'ajout', 'error');
    }
  } catch (e) {
    showToast('❌ Erreur de connexion', 'error');
  }
}

async function deleteAddress(addressId) {
  if (!confirm('Supprimer cette adresse ?')) return;
  try {
    await fetch(`${API_BASE}/api/users/${editingUserId}/addresses/${addressId}`, { method: 'DELETE' });
    showToast('🗑️ Adresse supprimée', 'success');
    await loadUserAddresses(editingUserId);
  } catch (e) {
    showToast('❌ Erreur', 'error');
  }
}

async function editAddress(addressId) {
  const addr = currentAddresses.find(a => a.id === addressId);
  if (!addr) return;
  
  const modal = document.getElementById('addAddressModal');
  if (!modal) return;

  // Pre-fill form
  selectAddrType(addr.label, getAddrIcon(addr.label));
  
  const parts = addr.address.split(',').map(p => p.trim());
  const streetEl = document.getElementById('addrStreet');
  const cityEl = document.getElementById('addrCity');
  const countryEl = document.getElementById('addrCountry');
  const searchEl = document.getElementById('addrSearch');
  const addrEl = document.getElementById('addrAddress');
  
  if (searchEl) searchEl.value = addr.address;
  if (addrEl) { addrEl.value = addr.address; addrEl.dataset.lat = addr.latitude || ''; addrEl.dataset.lon = addr.longitude || ''; }
  if (streetEl) streetEl.value = parts[0] || '';
  if (cityEl) cityEl.value = parts[1] || '';
  if (countryEl) countryEl.value = addr.country || parts[parts.length - 1] || '';
  
  document.getElementById('addrAlarmCode').value = addr.alarmCode || '';
  document.getElementById('addrNotes').value = addr.notes || '';
  document.getElementById('addrIsPrimary').checked = addr.isPrimary;
  
  // Store editing ID
  modal._editingAddressId = addressId;
  modal.style.display = 'flex';
}
