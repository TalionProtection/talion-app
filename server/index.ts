import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import path from 'path';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import fs from 'fs';
import sharp from 'sharp';
import { requireAuth, requireRole, optionalAuth } from './auth-middleware';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// ─── Internal health/error tracking (no external service) ────────────────
// Lightweight in-memory ring buffer so staff can see recent server errors
// without a third-party crash reporter — surfaced via GET /admin/health.
// Declared before the crash-safety-net handlers below so they can feed it.
interface HealthErrorEntry { timestamp: number; context: string; message: string; stack?: string; }
const recentErrors: HealthErrorEntry[] = [];
const MAX_HEALTH_ERRORS = 200;
function logHealthError(context: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  recentErrors.unshift({ timestamp: Date.now(), context, message, stack });
  if (recentErrors.length > MAX_HEALTH_ERRORS) recentErrors.length = MAX_HEALTH_ERRORS;
}

// ─── Crash safety net ─────────────────────────────────────────────────────
// Without this, a single unhandled promise rejection anywhere in this file
// (a missed .catch() in any one route, timer, or WS handler) takes down the
// ENTIRE server for every connected family/dispatcher/responder — Node's
// default behavior is to crash the whole process, not just the offending
// request — until Render notices and restarts it. Log and keep running
// instead. A synchronous uncaughtException is left to actually exit, since
// process state may be genuinely corrupted by that point; Render restarts
// it immediately either way, but this at least leaves a clear log line.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection] Kept server alive after:', reason);
  logHealthError('unhandledRejection', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[uncaughtException] Server crashing:', error);
  logHealthError('uncaughtException', error);
  process.exit(1);
});

// ─── Supabase Admin Client (singleton) ───────────────────────────────────
const supabaseAdmin = createSupabaseClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Separate client used ONLY for password sign-in during /auth/login. Calling
// auth.signInWithPassword() on a client mutates its internal session state, and
// that mutated session — not the service-role key — is what the postgrest client
// then sends on every subsequent .from() call made through that SAME instance.
// supabaseAdmin is shared/global and used everywhere for privileged table access,
// so signing in on it would silently downgrade every write across the whole
// server (for every request sharing the event loop) to that logging-in user's
// own restricted role until masked by another login or a restart — exactly the
// RLS-violation bug this comment is here to prevent from recurring.
const supabaseAuthOnly = createSupabaseClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  { auth: { autoRefreshToken: false, persistSession: false } }
);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
// ─── Supabase Admin (pour auth middleware) ────────────────────────────────
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn('[Auth] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set — auth middleware disabled');
}

// ─── Stage 2 auth rollout: real enforcement. Confirmed via Stage 1 logs that
// real admin/dispatcher console sessions send valid tokens; mobile app clients
// already send real Supabase JWTs today (services/api.ts, lib/auth-context.tsx).
// - /dispatch/*        : console-only (no mobile caller for any route in this
//                        group) — dispatcher level.
// - /api/messaging/*   : dispatch console's own conversations alias, separate
//                        from /api/conversations — dispatcher level.
// - /api/patrol/*      : mobile responders + admin console — responder level.
// - /api/conversations/*: messaging used by every role — any authenticated user.
// - /alerts/*          : mixed — baseline any authenticated user, with the
//                        stricter dispatcher/responder routes tightened below.
app.use('/dispatch', requireAuth, requireRole('dispatcher'));
app.use('/api/messaging', requireAuth, requireRole('dispatcher'));
// requireAuth only (not requireRole('responder')) — this prefix also serves
// GET /api/patrol/statuses (static config, any role) and
// GET /api/patrol/rounds/active (any staff role, not just responders).
// Individual routes that need a narrower role add their own requireRole.
// The mobile app's missing Authorization header (the original reason this
// was rolled back to optionalAuth) was fixed in this session's earlier
// auth-header sweep.
app.use('/api/patrol', requireAuth);
app.use('/api/conversations', requireAuth);
app.use('/alerts', requireAuth);

// ─── Resolve project root (works from server/ in dev and dist/ in prod) ───
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── JSON File Persistence Layer ─────────────────────────────────────────
// DATA_DIR should point at a mounted persistent disk in production — without
// one, this directory lives on the container's ephemeral filesystem and gets
// wiped on every deploy/restart (confirmed: this silently erased alerts,
// location history, curfew checks, PTT messages, etc. on Render's free/
// starter plan, which attaches no disk by default).
const dataDir = process.env.DATA_DIR || path.join(PROJECT_ROOT, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const ALERTS_FILE = path.join(dataDir, 'alerts.json');
const LOCATION_HISTORY_FILE = path.join(dataDir, 'location-history.json');
const FAMILY_PERIMETERS_FILE = path.join(dataDir, 'family-perimeters.json');
const CURFEW_CHECKS_FILE = path.join(dataDir, 'curfew-checks.json');
const SCHEDULED_CHECKINS_FILE = path.join(dataDir, 'scheduled-checkins.json');
const PROXIMITY_ALERTS_FILE = path.join(dataDir, 'proximity-alerts.json');
const PATROL_REPORTS_FILE = path.join(dataDir, 'patrol-reports.json');
const PTT_CHANNELS_FILE = path.join(dataDir, 'ptt-channels.json');
const PTT_MESSAGES_FILE = path.join(dataDir, 'ptt-messages.json');
const SECTORS_FILE = path.join(dataDir, 'sectors.json');
const PRESENCE_FILE = path.join(dataDir, 'presence-status.json');
const AUTO_PRESENCE_FILE = path.join(dataDir, 'auto-presence-state.json');

function loadJsonFile<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) { console.error(`[Persist] Failed to load ${filePath}:`, e); }
  return defaultValue;
}

function saveJsonFile(filePath: string, data: any): void {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  } catch (e) { console.error(`[Persist] Failed to save ${filePath}:`, e); }
}

// ─── Acceptance Timer System (2-minute soft nudge, 5-minute hard escalation) ────
const ACCEPTANCE_SOFT_TIMEOUT_MS = 2 * 60 * 1000; // tier 1: soft nudge to dispatch + suggested backup
const ACCEPTANCE_HARD_TIMEOUT_MS = 5 * 60 * 1000; // tier 2: hard escalation (unchanged user-facing timing)
interface AcceptanceTimerHandles {
  soft: ReturnType<typeof setTimeout> | null;
  hard: ReturnType<typeof setTimeout> | null;
}
const acceptanceTimers = new Map<string, AcceptanceTimerHandles>(); // key: `alertId:responderId`

const INCIDENT_TYPE_LABELS: Record<string, string> = {
  sos: 'SOS', medical: 'Médical', fire: 'Incendie', security: 'Sécurité',
  accident: 'Accident', broadcast: 'Broadcast', other: 'Autre',
  home_jacking: 'Home-Jacking', cambriolage: 'Cambriolage',
  animal_perdu: 'Animal perdu', evenement_climatique: 'Événement climatique',
  rodage: 'Rodage', vehicule_suspect: 'Véhicule suspect', fugue: 'Fugue',
  route_bloquee: 'Route bloquée', route_fermee: 'Route fermée',
  malaise: 'Malaise', colis_suspect: 'Colis suspect',
};

function startAcceptanceTimer(alertId: string, responderId: string) {
  const timerKey = `${alertId}:${responderId}`;
  clearAcceptanceTimer(alertId, responderId); // clear any existing pair for this assignment first

  const soft = setTimeout(() => {
    const handles = acceptanceTimers.get(timerKey);
    if (handles) handles.soft = null;
    handleSoftEscalation(alertId, responderId);
  }, ACCEPTANCE_SOFT_TIMEOUT_MS);

  const hard = setTimeout(() => {
    acceptanceTimers.delete(timerKey);
    handleHardEscalation(alertId, responderId);
  }, ACCEPTANCE_HARD_TIMEOUT_MS);

  acceptanceTimers.set(timerKey, { soft, hard });
}

function clearAcceptanceTimer(alertId: string, responderId: string) {
  const timerKey = `${alertId}:${responderId}`;
  const handles = acceptanceTimers.get(timerKey);
  if (handles) {
    if (handles.soft) clearTimeout(handles.soft);
    if (handles.hard) clearTimeout(handles.hard);
    acceptanceTimers.delete(timerKey);
  }
}

// Tier 1 (2 min): responder still hasn't accepted — notify dispatch only (never the responder or a
// backup candidate) with a suggested replacement, so a human can decide to reassign.
function handleSoftEscalation(alertId: string, responderId: string) {
  const alert = alerts.get(alertId);
  if (!alert) return;
  const currentStatus = alert.responderStatuses?.[responderId];
  if (currentStatus && currentStatus !== 'assigned') return; // Already accepted/en_route/on_scene

  const responderName = adminUsers.get(responderId)?.name || responderId;
  console.log(`[AcceptanceTimer] ${responderName} did not accept incident ${alertId} within 2 minutes (soft)`);

  if (!alert.responderEscalation) alert.responderEscalation = {};
  alert.responderEscalation[responderId] = 1;
  recomputeEscalationLevel(alert);
  alerts.set(alertId, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[SoftEscalation] Supabase save error:', e));

  const backup = computeNearbyResponders(alert).find(r => r.suggested) || null;
  const backupNote = backup
    ? ` Suggestion: ${backup.name} (${backup.distanceLabel}${backup.etaLabel ? ', ETA ' + backup.etaLabel : ''}).`
    : '';

  addAuditEntry(
    'incident',
    'Escalade Niveau 1 (Soft)',
    'System',
    `${responderName} n'a pas encore accepté l'incident ${alertId} après 2 minutes.${backupNote}`,
    responderId,
    alert.organizationId
  );

  const typeLabel = INCIDENT_TYPE_LABELS[alert.type] || alert.type;
  const notifiedDispatchers = new Set<string>();
  for (const [_token, entry] of pushTokens) {
    if ((entry.userRole === 'dispatcher' || entry.userRole === 'admin') && !notifiedDispatchers.has(entry.userId)) {
      notifiedDispatchers.add(entry.userId);
      sendPushToUser(
        entry.userId,
        `⚠️ Pas encore accepté (2 min) — ${responderName}`,
        `Incident ${typeLabel} (${alertId}) : ${responderName} n'a pas encore accepté.${backupNote}`,
        { type: 'escalation_soft', alertId, responderId, suggestedBackupId: backup?.id }
      ).catch(() => {});
    }
  }

  broadcastToOrg(alert.organizationId, {
    type: 'escalationSoft',
    alertId,
    responderId,
    responderName,
    suggestedBackup: backup ? {
      id: backup.id, name: backup.name, distanceLabel: backup.distanceLabel,
      etaMinutes: backup.etaMinutes, etaLabel: backup.etaLabel,
    } : null,
    escalationLevel: alert.escalationLevel,
    timestamp: Date.now(),
  });

  broadcastToOrg(alert.organizationId, {
    type: 'alertUpdate',
    data: { ...alert, respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) },
  });
}

// Tier 2 (5 min): responder still hasn't accepted — existing hard-timeout behavior, unchanged,
// plus bumping the alert's escalation state so the dispatch UI reflects it.
function handleHardEscalation(alertId: string, responderId: string) {
  const alert = alerts.get(alertId);
  if (!alert) return;
  // Check if responder has already accepted
  const currentStatus = alert.responderStatuses?.[responderId];
  if (currentStatus && currentStatus !== 'assigned') return; // Already accepted/en_route/on_scene
  // Responder has NOT accepted within 5 minutes — notify dispatchers
  const responderName = adminUsers.get(responderId)?.name || responderId;
  console.log(`[AcceptanceTimer] ${responderName} did not accept incident ${alertId} within 5 minutes`);
  // Add to status history
  if (!alert.statusHistory) alert.statusHistory = [];
  alert.statusHistory.push({
    responderId,
    responderName,
    status: 'assigned', // still assigned, but timed out
    timestamp: Date.now(),
  });
  // Add audit entry
  addAuditEntry('incident', 'Acceptance Timeout', 'System', `${responderName} n'a pas accepté l'incident ${alertId} dans les 5 minutes`, responderId, alert.organizationId);
  // Send push notification to all dispatchers
  const typeLabel = INCIDENT_TYPE_LABELS[alert.type] || alert.type;
  const notifiedDispatchers = new Set<string>();
  for (const [_token, entry] of pushTokens) {
    if ((entry.userRole === 'dispatcher' || entry.userRole === 'admin') && !notifiedDispatchers.has(entry.userId)) {
      notifiedDispatchers.add(entry.userId);
      sendPushToUser(
        entry.userId,
        `⏰ Délai d'acceptation dépassé`,
        `${responderName} n'a pas accepté l'incident ${typeLabel} (${alertId}) dans les 5 minutes. Veuillez réassigner.`,
        { type: 'acceptance_timeout', alertId, responderId }
      ).catch(() => {});
    }
  }
  // Broadcast WebSocket event for real-time console update
  broadcastToOrg(alert.organizationId, {
    type: 'acceptanceTimeout',
    alertId,
    responderId,
    responderName,
    timestamp: Date.now(),
  });

  if (!alert.responderEscalation) alert.responderEscalation = {};
  alert.responderEscalation[responderId] = 2;
  recomputeEscalationLevel(alert);
  alerts.set(alertId, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[HardEscalation] Supabase save error:', e));
  broadcastToOrg(alert.organizationId, {
    type: 'alertUpdate',
    data: { ...alert, respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) },
  });
}

// Debounced save to avoid excessive disk writes
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function debouncedSave(filePath: string, data: any, delayMs = 2000): void {
  const existing = saveTimers.get(filePath);
  if (existing) clearTimeout(existing);
  saveTimers.set(filePath, setTimeout(() => {
    saveJsonFile(filePath, data);
    saveTimers.delete(filePath);
  }, delayMs));
}

// File uploads setup
const uploadsDir = path.join(PROJECT_ROOT, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, '_')}`),
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB — a modern phone photo at moderate compression can exceed the old 5MB cap
const uploadMedia = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB for patrol media (photos + videos)
app.use('/uploads', express.static(uploadsDir));

// Render's filesystem is EPHEMERAL — everything under uploadsDir is wiped
// on every deploy/restart. Multer still writes here first (a same-request
// staging area, safe to read from immediately after), but nothing may be
// treated as durably stored unless it's also pushed to Supabase Storage.
// Mirrors the exact pattern already used for conversation media
// (POST /api/conversations/:id/media) — same bucket, same
// upload-then-getPublicUrl shape, same fallback-to-local-path-on-failure
// (better a broken-after-next-deploy link than no link at all, e.g. if
// Supabase Storage itself is briefly down).
async function uploadFileToSupabaseStorage(file: { path: string; filename: string; mimetype?: string }): Promise<string> {
  let mediaUrl = `/uploads/${file.filename}`;
  try {
    const fileBuffer = fs.readFileSync(file.path);
    const fileName = `${Date.now()}-${file.filename}`;
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('media')
      .upload(fileName, fileBuffer, { contentType: file.mimetype || 'application/octet-stream', upsert: false });
    if (!uploadError && uploadData) {
      const { data: { publicUrl } } = supabaseAdmin.storage.from('media').getPublicUrl(fileName);
      mediaUrl = publicUrl;
    } else {
      console.warn('[Storage] Supabase Storage upload failed, using local (ephemeral) fallback:', uploadError?.message);
    }
  } catch (e) {
    console.warn('[Storage] Storage error, using local (ephemeral) fallback:', e);
  }
  return mediaUrl;
}
app.use('/assets', express.static(path.join(PROJECT_ROOT, 'assets')));

// Dynamic file serving for console static files to bypass CDN/proxy cache
// Reads files from disk on every request so changes are always reflected
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};
function serveConsoleDynamic(basePath: string) {
  return (req: any, res: any) => {
    let filePath = req.path === '/' ? '/index.html' : req.path;
    // Strip query strings
    filePath = filePath.split('?')[0];
    const fullPath = path.join(basePath, filePath);
    // Security: prevent directory traversal
    if (!fullPath.startsWith(basePath)) return res.status(403).send('Forbidden');
    try {
      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        // Try index.html for directory requests
        const indexPath = path.join(fullPath, 'index.html');
        if (fs.existsSync(indexPath)) {
          const content = fs.readFileSync(indexPath, 'utf-8');
          res.set('Content-Type', 'text/html');
          res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.set('Pragma', 'no-cache');
          return res.send(content);
        }
        return res.status(404).send('Not Found');
      }
      const ext = path.extname(fullPath).toLowerCase();
      const mime = MIME_TYPES[ext] || 'application/octet-stream';
      const content = fs.readFileSync(fullPath);
      res.set('Content-Type', mime);
      res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.set('Pragma', 'no-cache');
      res.set('Expires', '0');
      res.send(content);
    } catch (e) {
      res.status(500).send('Internal Server Error');
    }
  };
}

// Serve admin dashboard
app.use('/admin-console', serveConsoleDynamic(path.join(PROJECT_ROOT, 'server', 'admin-web')));

// Serve dispatch dashboard (v2 path to bust CDN cache)
app.use('/dispatch-v2', serveConsoleDynamic(path.join(PROJECT_ROOT, 'server', 'dispatch-web')));
// Keep old path for backward compat
app.use('/dispatch-console', serveConsoleDynamic(path.join(PROJECT_ROOT, 'server', 'dispatch-web')));

// Serve login page
app.use('/console', serveConsoleDynamic(path.join(PROJECT_ROOT, 'server', 'console-login')));
app.use('/console-login', serveConsoleDynamic(path.join(PROJECT_ROOT, 'server', 'console-login')));

// Types
interface User {
  id: string;
  email: string;
  role: 'user' | 'responder' | 'dispatcher' | 'admin' | 'superadmin';
  status?: 'available' | 'on_duty' | 'off_duty' | 'responding';
  location?: { latitude: number; longitude: number };
  lastSeen?: number;
  // The organization this connection belongs to, resolved once at WS auth
  // time from adminUsers.get(userId)?.organizationId — used by
  // broadcastToOrg/broadcastToOrgRole to keep every real-time event within
  // its own tenant. superadmin (Talion staff) has no organizationId and
  // sees across all of them.
  organizationId?: string;
}

interface Organization {
  id: string;
  name: string;
  status: 'active' | 'suspended';
  createdAt: number;
}

// Replaces the old hardcoded PATROL_SITES constant — each organization
// configures its own patrol sites (see /admin/patrol-sites). PatrolReport
// still stores the site as a denormalized name string, not this id, to
// match the existing PatrolReport.location convention.
interface PatrolSite {
  id: string;
  organizationId: string;
  name: string;
  createdAt: number;
  // A site's own location, independent of any checkpoints it may have —
  // checkpoints exist to verify a guard physically walked a route inside
  // the site, not to answer "where is this site." Optional/backfilled:
  // resolveSiteDestination() falls back to the checkpoint centroid for
  // older sites that don't have one set yet.
  address?: string;
  latitude?: number;
  longitude?: number;
}

// A GPS waypoint on a patrol site's route — the responder must get within
// radiusMeters of {latitude,longitude} (and, if minDwellSeconds is set,
// stay within it for at least that long, cumulatively) for it to count as
// visited during a round. Order is intentionally not enforced (see
// ActivePatrolRound) — checkpoints are unordered from the server's
// perspective.
interface PatrolCheckpoint {
  id: string;
  siteId: string;
  organizationId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  minDwellSeconds?: number;
  createdAt: number;
}

interface AdminUser {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  role: 'user' | 'responder' | 'dispatcher' | 'admin' | 'superadmin';
  // The tenant this account belongs to. Undefined only for legacy rows not
  // yet backfilled, or for superadmin (Talion-only, cross-organization).
  // Every access-control check treats a missing organizationId as "deny",
  // never "sees everything" — see canAccessOrg.
  organizationId?: string;
  status: 'active' | 'suspended' | 'deactivated';
  lastLogin: number;
  createdAt: number;
  tags?: string[];
  // New fields for full user management
  address?: string;
  addressComponents?: { street?: string; city?: string; postalCode?: string; country?: string; placeId?: string };
  phoneLandline?: string;
  phoneMobile?: string;
  comments?: string;
  photoUrl?: string;
  relationships?: { userId: string; type: string }[]; // type: 'parent', 'child', 'spouse', 'sibling', 'cohabitant', 'other'
  passwordHash?: string; // bcrypt-hashed password for email+password auth
  ghostMode?: boolean; // hides this user from dispatch's live location view until revealed for an active incident, or the user turns it off themselves
  // Independent of ghostMode (which is dispatch-only, see GET /api/family/members
  // below) — controls whether this user's live position/presence is shown to
  // their OWN family. undefined/true = shared (today's behavior, non-regressive);
  // false = masked from family the same way a member with no known location is.
  shareLocationWithFamily?: boolean;
  // Temporary override: when set and in the future, location is shared with
  // family regardless of shareLocationWithFamily === false — lets someone who
  // normally keeps their location private opt in for a bounded window (e.g.
  // "share for the next 2h while I'm out"). Expires on its own; no explicit
  // "turn back off" action needed.
  shareLocationUntil?: number;
  // Parent-set simplified-UI mode for a child/teen's own account. undefined
  // (or 'standard') = the normal adult UI. Only a parent of this account (or
  // staff) may change it — never the account holder themselves, so a child
  // can't switch their own phone back to the full UI. See isParentOf and
  // PUT /api/users/:id/ui-profile.
  uiProfile?: 'standard' | 'enfant' | 'ado';
  // Duress code: an opt-in alternate SOS-deactivation PIN. Entering the normal
  // PIN cancels SOS exactly as before; entering the duress PIN shows the
  // identical "SOS Désactivé" confirmation but silently raises a real alert to
  // dispatch instead — for a scenario where someone is forced to "cancel" the
  // alarm under coercion. Both PINs are bcrypt-hashed, never stored/sent in
  // plaintext once set. Disabled (undefined/false) by default: zero added
  // friction for anyone who hasn't opted in.
  duressCodeEnabled?: boolean;
  normalPinHash?: string;
  duressPinHash?: string;
  // Only meaningful for role 'dispatcher'/'responder' — the family group ids
  // (getFamilyGroupId) this staff member is restricted to in "calm" views
  // (see canAccessFamily). Empty/undefined = sees every family, unchanged
  // from today's behavior — restriction only activates once an admin
  // explicitly assigns someone, so there's no disruptive cutover.
  assignedFamilyIds?: string[];
}

interface LoginHistoryEntry {
  id: string;
  userId: string;
  userName: string;
  email: string;
  timestamp: number;
  ip: string;
  userAgent: string;
  device: string; // parsed from user-agent
  status: 'success' | 'failed_password' | 'failed_email' | 'account_deactivated' | 'account_suspended' | 'no_password' | 'supabase_sync_failed';
}

// Global login history store
const loginHistory: LoginHistoryEntry[] = [];

function parseDevice(ua: string): string {
  if (!ua) return 'Unknown';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Macintosh|Mac OS/i.test(ua)) return 'Mac';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Other';
}

function addLoginHistory(entry: Omit<LoginHistoryEntry, 'id' | 'device'> & { userAgent: string }) {
  const record: LoginHistoryEntry = {
    ...entry,
    id: `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    device: parseDevice(entry.userAgent),
  };
  loginHistory.unshift(record); // newest first
  // Keep max 1000 entries
  if (loginHistory.length > 1000) loginHistory.length = 1000;
}

// ─── Messaging types ──────────────────────────────────────────────────
interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  text: string;
  type: 'text' | 'location' | 'alert' | 'image' | 'audio' | 'document' | 'video' | 'system';
  timestamp: number;
  mediaUrl?: string;
  mediaType?: string;
  location?: { latitude: number; longitude: number; address?: string };
}

interface Conversation {
  id: string;
  type: 'direct' | 'group' | 'residence';
  name: string;
  participantIds: string[];
  /** For group by role */
  filterRole?: string;
  /** For group by tags */
  filterTags?: string[];
  /** For type === 'residence' — membership resolves live to the address owner + their family, see resolveGroupParticipants */
  addressId?: string;
  createdBy: string;
  createdAt: number;
  lastMessageTime: number;
  lastMessage: string;
  organizationId?: string;
}

type ResponderStatus = 'assigned' | 'accepted' | 'en_route' | 'on_scene';

interface StatusHistoryEntry {
  responderId: string;
  responderName: string;
  status: ResponderStatus;
  timestamp: number; // Date.now()
}

interface Alert {
  id: string;
  type: 'sos' | 'medical' | 'fire' | 'accident' | 'other' | 'broadcast' | 'home_jacking' | 'cambriolage' | 'animal_perdu' | 'evenement_climatique' | 'rodage' | 'vehicule_suspect' | 'fugue' | 'route_bloquee' | 'route_fermee' | 'malaise' | 'colis_suspect';
  severity: 'low' | 'medium' | 'high' | 'critical';
  location: { latitude: number; longitude: number; address: string };
  description: string;
  createdBy: string; // display name/label shown in the UI — not reliably a user id (varies by creation route)
  reporterId?: string; // actual reporting user's id when known; used for duplicate-detection matching
  organizationId?: string; // tenant this alert belongs to — set at creation, never bypassed even for role 'admin'
  createdAt: number;
  status: 'active' | 'acknowledged' | 'resolved' | 'cancelled';
  respondingUsers: string[];
  responderStatuses?: Record<string, ResponderStatus>; // per-responder status tracking
  statusHistory?: StatusHistoryEntry[]; // timestamped history of all status changes
  photos?: string[]; // array of relative URLs e.g. ['/uploads/xxx.jpg']
  responderEscalation?: Record<string, 0 | 1 | 2>; // escalation tier reached per pending assignment
  escalationLevel?: 0 | 1 | 2; // max of responderEscalation, drives dispatch UI sort/style
  visibilityRadiusMeters?: number; // Ghost-mode users within this radius get a reveal-request push
  revealedUserIds?: string[]; // Ghost-mode users who confirmed becoming visible for this incident
  possibleDuplicates?: { id: string; confidence: 'same-reporter' | 'family' | 'proximity' }[]; // auto-suggested correlations, dispatcher confirms or dismisses
  linkedIncidentIds?: string[]; // dispatcher-confirmed links to other incidents (bidirectional)
  origin?: 'dispatch' | 'mobile'; // who created it — console/dispatcher action vs. a mobile app user report
  archived?: boolean; // hidden from the normal active views but kept, findable via the Archives view
  archivedAt?: number;
  // Real response-time tracking for the KPI dashboard (point 6, "think like
  // Palantir") — set once, at the first genuine acknowledge/resolve, not
  // recomputed on subsequent transitions to the same status.
  acknowledgedAt?: number;
  resolvedAt?: number;
  // Set only by the duress-code path (POST /api/sos/duress-check) — never
  // shown to the reporting user's own device, only surfaced to dispatch as a
  // distinct, high-priority banner (a "cancelled" SOS that's actually real).
  isDuress?: boolean;
}

interface AdminIncident {
  id: string;
  type: string;
  severity: string;
  status: string;
  reportedBy: string;
  address: string;
  location?: { latitude: number; longitude: number };
  description?: string;
  timestamp: number;
  resolvedAt?: number;
  assignedCount: number;
  respondingUsers?: string[];
  respondingNames?: string[];
  responderStatuses?: Record<string, ResponderStatus>;
  statusHistory?: StatusHistoryEntry[];
  responderEscalation?: Record<string, 0 | 1 | 2>;
  escalationLevel?: 0 | 1 | 2;
  photos?: string[];
  possibleDuplicates?: { id: string; confidence: 'same-reporter' | 'family' | 'proximity' }[];
  linkedIncidentIds?: string[];
  origin?: 'dispatch' | 'mobile';
  archived?: boolean;
  archivedAt?: number;
  isDuress?: boolean;
}

interface AuditEntry {
  id: string;
  timestamp: number;
  category: 'auth' | 'user' | 'incident' | 'system' | 'broadcast' | 'access_override' | 'threat_analysis';
  action: string;
  performedBy: string;
  targetUser?: string;
  details: string;
  // Best-effort — undefined for genuinely ambiguous/system-wide entries, which
  // means they're only visible to superadmin (fail closed, not fail open).
  organizationId?: string;
}

interface WebSocketMessage {
  type: string;
  userId?: string;
  userRole?: string;
  token?: string; // Supabase access token — verified in handleAuth; userId/userRole
  // above are otherwise just client-asserted claims, not proof of identity.
  data?: any;
  timestamp?: number;
}

// PTT interfaces
interface PTTChannelServer {
  id: string;
  name: string;
  description: string;
  allowedRoles: ('user' | 'responder' | 'dispatcher' | 'admin' | 'superadmin')[];
  isActive: boolean;
  isDefault: boolean; // cannot be deleted
  createdBy: string;
  createdAt: number;
  organizationId?: string;
  members?: string[]; // specific user IDs for custom groups
}

interface PTTMessageServer {
  id: string;
  channelId: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  audioBase64: string; // base64-encoded audio data
  mimeType?: string; // e.g., 'audio/m4a', 'audio/webm'
  duration: number;
  timestamp: number;
}

// Geofence zone interface
interface GeofenceZone {
  id: string;
  center: { latitude: number; longitude: number };
  radiusKm: number;
  severity: string;
  message: string;
  createdAt: number;
  createdBy: string;
  organizationId?: string;
}

// ─── Sector types ───────────────────────────────────────────────────────
// Admin-managed organizational zones shown on the dispatch console map
// (e.g. "Champel", "Florissant") — purely for display/navigation/filtering,
// distinct from GeofenceZone (which drives responder entry/exit alerts).
interface Sector {
  id: string;
  name: string;
  color: string; // hex, used for the map outline/label
  shape: 'circle' | 'polygon';
  center?: { latitude: number; longitude: number }; // circle only
  radiusMeters?: number; // circle only
  points?: { latitude: number; longitude: number }[]; // polygon only, ordered ring (not explicitly closed)
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  organizationId?: string;
}

// ─── Family Perimeter types ────────────────────────────────────────────
interface FamilyPerimeter {
  id: string;
  /** The user who owns this perimeter (parent) */
  ownerId: string;
  /** The family member being watched */
  targetUserId: string;
  targetUserName: string;
  /** Center point of the perimeter */
  center: { latitude: number; longitude: number; address?: string };
  /** Radius in meters */
  radiusMeters: number;
  /** Whether this perimeter is active */
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

// ─── Curfew Check types ────────────────────────────────────────────────
// A one-off or daily-recurring "alert me if this person hasn't arrived" check.
// Decoupled from FamilyPerimeter (own center/radius) so it doesn't depend on one
// existing — the creation UI can prefill from an existing perimeter, though.
interface CurfewCheck {
  id: string;
  ownerId: string;
  targetUserId: string;
  targetUserName: string;
  center: { latitude: number; longitude: number; address?: string };
  radiusMeters: number;
  hour: number; // 0-23, wall-clock — needed to recompute the next occurrence if recurring
  minute: number; // 0-59
  recurrence: 'once' | 'daily';
  // Which direction of crossing should raise an alert at check time:
  // 'exit'  → zone is where the target is expected to be (e.g. home); alert if OUTSIDE.
  // 'entry' → zone is somewhere the target shouldn't be (e.g. off-limits); alert if INSIDE.
  // 'both'  → always notify the owner of the status, regardless of inside/outside.
  alertWhen: 'exit' | 'entry' | 'both';
  nextCheckAt: number; // epoch ms of the next scheduled fire
  active: boolean; // false once a 'once' check has fired, or either kind is cancelled
  createdAt: number;
  lastFiredAt?: number;
  lastResult?: 'inside' | 'outside';
}

// ─── Scheduled Check-in types ──────────────────────────────────────────
// A "confirm you're safe by this time" dead-man's switch — unlike CurfewCheck
// (passive: is the target inside/outside a geofence at time X), this requires
// an affirmative tap from the target; if it doesn't arrive, a reminder push
// fires, then a grace period, then dispatch is alerted. Same setTimeout +
// rehydration-on-boot mechanism as CurfewCheck (see scheduleCurfewCheck).
interface ScheduledCheckIn {
  id: string;
  ownerId: string; // who created it (self, a parent, or dispatch/admin staff)
  targetUserId: string;
  targetUserName: string;
  dueAt: number; // epoch ms — when confirmation is due
  graceMinutes: number; // delay after the reminder before escalating to dispatch
  status: 'pending' | 'awaiting_confirmation' | 'confirmed' | 'escalated' | 'cancelled';
  nextFireAt: number; // epoch ms of the next setTimeout, whatever the stage
  stage: 'due' | 'escalation'; // which handler nextFireAt should invoke
  createdAt: number;
  confirmedAt?: number;
  escalatedAt?: number;
  // 'daily' check-ins reschedule themselves for the same wall-clock time the
  // next day once a cycle completes (confirmed or escalated), same pattern as
  // CurfewCheck.recurrence — hour/minute are required whenever recurrence is
  // 'daily' since dueAt alone doesn't say how to compute the next occurrence.
  recurrence?: 'once' | 'daily';
  hour?: number;
  minute?: number;
}

// ─── Patrol Report types ──────────────────────────────────────────────
type PatrolStatus = 'habituel' | 'inhabituel' | 'identification' | 'suspect' | 'menace' | 'attaque';
type TaskResult = 'ok' | 'pas_ok';

interface PatrolTask {
  name: string; // 'ronde_exterieure' | 'ronde_interieure' | 'ronde_maison' | 'anomalies' | 'autre'
  label: string;
  result: TaskResult;
  comment?: string; // only for 'autre'
}

interface PatrolMedia {
  id: string;
  type: 'photo' | 'video';
  url: string; // relative path e.g. /uploads/filename.jpg
  thumbnail?: string; // for videos
  filename: string;
  uploadedAt: number;
}

// Per-checkpoint outcome recorded on a PatrolReport once a GPS round is
// finalized — a frozen snapshot of the live tracking done in
// ActivePatrolRound, not the checkpoint config itself (which can be
// edited/deleted independently afterward).
interface PatrolCheckpointResult {
  checkpointId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  visited: boolean;
  dwellSeconds: number;
  minDwellSeconds?: number;
  dwellMet: boolean;
}

interface PatrolTrailPoint {
  latitude: number;
  longitude: number;
  timestamp: number;
}

interface PatrolReport {
  id: string;
  createdAt: number;
  createdBy: string; // responder userId
  createdByName: string;
  location: string; // predefined site name
  status: PatrolStatus;
  tasks: PatrolTask[];
  notes?: string;
  media?: PatrolMedia[];
  escalatedIncidentId?: string; // set once a dispatcher has escalated this report to a real incident
  organizationId?: string;
  // Present only for reports generated from a GPS-tracked round (see
  // ActivePatrolRound) — absent for quick/manual reports, which keep
  // working exactly as before.
  siteId?: string;
  checkpoints?: PatrolCheckpointResult[];
  trail?: PatrolTrailPoint[];
  roundStatus?: 'completed' | 'interrupted';
  startedAt?: number;
  interruptReason?: string;
}

// Live per-checkpoint tracking state for a round in progress — internal
// bookkeeping (dwellSeconds/wasInsideLastPing) that gets condensed down to
// PatrolCheckpointResult once the round finalizes.
interface ActivePatrolRoundCheckpointState {
  checkpointId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  minDwellSeconds?: number;
  dwellSeconds: number; // cumulative time spent inside, across possibly-multiple entries
  wasInsideLastPing: boolean;
  visited: boolean;
  dwellMet: boolean;
}

// A patrol round currently being walked — durable (not just a WS broadcast)
// so a reconnecting dispatcher/admin still sees it, mirroring how `alerts`
// backs `alertsSnapshot` on WS handleAuth.
interface ActivePatrolRound {
  id: string;
  siteId: string;
  siteName: string;
  responderId: string;
  responderName: string;
  organizationId?: string;
  startedAt: number;
  checkpoints: ActivePatrolRoundCheckpointState[];
  trail: PatrolTrailPoint[];
  lastLocation?: { latitude: number; longitude: number; timestamp: number };
  lastMovementAt: number;
  immobilityAlertedAt?: number; // set while an immobility episode is being alerted; cleared once movement resumes
}

// A responder's live hand-off to native turn-by-turn nav after finishing a
// round, for the console to mirror. Not durable in Supabase — only
// patrol_route_history (the geometry actually taken) is; this is a
// reconnect-friendly live view, same rationale as ActivePatrolRound.
interface ActiveResponderRoute {
  responderId: string;
  responderName: string;
  organizationId: string;
  toSiteId: string;
  toSiteName: string;
  geometry: { latitude: number; longitude: number }[];
  distanceMeters: number;
  durationSeconds: number;
  rationale: string;
  mode: 'driving' | 'walking';
  startedAt: number;
}

interface ProximityAlert {
  id: string;
  perimeterId: string;
  targetUserId: string;
  targetUserName: string;
  ownerId: string;
  eventType: 'exit' | 'entry' | 'curfew_violation' | 'route_deviation';
  /** Distance from center when alert triggered */
  distanceMeters: number;
  location: { latitude: number; longitude: number };
  timestamp: number;
  acknowledged: boolean;
  /** Only set for eventType 'curfew_violation' — the target's zone status at check time */
  curfewResult?: 'inside' | 'outside';
}

// ─── Location History type ──────────────────────────────────────────────
interface LocationHistoryEntry {
  userId: string;
  latitude: number;
  longitude: number;
  timestamp: number;
}

interface GeofenceEvent {
  id: string;
  zoneId: string;
  responderId: string;
  responderName: string;
  eventType: 'entry' | 'exit';
  timestamp: number;
  location: { latitude: number; longitude: number };
  organizationId?: string;
}

// In-memory storage
const users = new Map<string, User>();
const alerts = new Map<string, Alert>();
const userConnections = new Map<string, Set<any>>();
// Reverse map: ws client -> userId for efficient PTT broadcast
const wsClientMap = new Map<any, string>();

// Organizations (tenants) — source of truth for AdminUser.organizationId.
const organizations = new Map<string, Organization>();
const patrolSites = new Map<string, PatrolSite>();
const patrolCheckpoints = new Map<string, PatrolCheckpoint>();

// Admin storage
const adminUsers = new Map<string, AdminUser>();
const auditLog: AuditEntry[] = [];
const responderStatusOverrides = new Map<string, { status: string; updatedAt: number; updatedBy: string }>();

// Push token storage: Map<pushToken, { userId, userRole, registeredAt }>
interface PushTokenEntry {
  token: string;
  userId: string;
  userRole: string;
  registeredAt: number;
}
const pushTokens = new Map<string, PushTokenEntry>();

// Messaging storage
const conversations = new Map<string, Conversation>();
const messages = new Map<string, ChatMessage[]>(); // conversationId -> messages

// Geofence storage
const geofenceZones = new Map<string, GeofenceZone>();
const geofenceEvents: GeofenceEvent[] = [];

// Sector storage (persisted) — admin-managed display/navigation zones
const sectors = new Map<string, Sector>();

// Manual presence override storage (persisted) — see computeEffectivePresence below
interface PresenceManualStatus {
  status: 'inside' | 'outside';
  placeLabel?: string; // which registered address — only meaningful when status is 'inside'
  setBy: string;
  setAt: number;
}
const manualPresence = new Map<string, PresenceManualStatus>(); // targetUserId -> manual status

// Automatic presence state (persisted — JSON + Supabase, like manualPresence).
// Tracks both the last known place (so an "outside" reading can say which one
// they left) and when the current (status, place) combination began (so
// "Présent" can show "depuis HH:mm" instead of just "right now"). This used
// to be two in-memory-only maps that reset on every server restart/redeploy,
// silently losing arrival times and "sorti de X" context — now persisted.
interface AutoPresenceState {
  status: 'inside' | 'outside' | 'unknown';
  label?: string;
  since: number;
}
const autoPresenceState = new Map<string, AutoPresenceState>();

// Family perimeter storage (persisted)
const familyPerimeters = new Map<string, FamilyPerimeter>();
const proximityAlerts: ProximityAlert[] = [];
// Track which targets are currently outside their perimeter: Map<perimeterId, boolean>
const perimeterState = new Map<string, boolean>(); // true = outside

// Curfew check storage (persisted) + their scheduled timers (in-memory only)
const curfewChecks = new Map<string, CurfewCheck>();
const curfewTimers = new Map<string, ReturnType<typeof setTimeout>>(); // key: check.id

// Scheduled check-in storage (persisted) + their scheduled timers (in-memory only)
const scheduledCheckIns = new Map<string, ScheduledCheckIn>();
const checkInTimers = new Map<string, ReturnType<typeof setTimeout>>(); // key: checkIn.id

// Patrol reports storage
const patrolReports: PatrolReport[] = [];

// Rounds currently being walked (in-memory only — a round either finalizes
// into a PatrolReport, which IS persisted, or it's abandoned by a server
// restart mid-round, which is an acceptable loss for a live-tracking
// session, same tradeoff as PTT's talking-state).
const activePatrolRounds = new Map<string, ActivePatrolRound>();
// Keyed by responderId — a responder can only navigate to one place at a time.
const activeResponderRoutes = new Map<string, ActiveResponderRoute>();

// ─── PTT data stores ─────────────────────────────────────────────────────
const DEFAULT_PTT_CHANNELS: PTTChannelServer[] = [
  { id: 'emergency', name: 'Urgence', description: 'Canal d\'urgence - tous les rôles', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], isActive: true, isDefault: true, createdBy: 'system', createdAt: Date.now() },
  { id: 'dispatch', name: 'Dispatch', description: 'Canal de coordination dispatch', allowedRoles: ['responder', 'dispatcher', 'admin'], isActive: true, isDefault: true, createdBy: 'system', createdAt: Date.now() },
  { id: 'responders', name: 'Intervenants', description: 'Canal équipe intervenants', allowedRoles: ['responder', 'dispatcher', 'admin'], isActive: true, isDefault: true, createdBy: 'system', createdAt: Date.now() },
  { id: 'general', name: 'Général', description: 'Canal de communication général', allowedRoles: ['user', 'responder', 'dispatcher', 'admin'], isActive: true, isDefault: true, createdBy: 'system', createdAt: Date.now() },
];
let pttChannels: PTTChannelServer[] = loadJsonFile<PTTChannelServer[]>(PTT_CHANNELS_FILE, [...DEFAULT_PTT_CHANNELS]);
let pttMessages: PTTMessageServer[] = loadJsonFile<PTTMessageServer[]>(PTT_MESSAGES_FILE, []);
// Keep only last 200 messages in memory
if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);

function persistPTTChannels() { fs.writeFileSync(PTT_CHANNELS_FILE, JSON.stringify(pttChannels, null, 2)); pttChannels.forEach(c => savePTTChannelToSupabase(c)); }
function persistPTTMessages() { fs.writeFileSync(PTT_MESSAGES_FILE, JSON.stringify(pttMessages.slice(-200), null, 2)); }

// Location history storage (persisted, ring buffer per user)
const locationHistory = new Map<string, LocationHistoryEntry[]>();
const MAX_HISTORY_PER_USER = 200; // keep last 200 points per user
// Track which responders are currently inside each zone: Map<zoneId, Set<responderId>>
const responderZoneState = new Map<string, Set<string>>();

// ─── Load persisted data ─────────────────────────────────────────────────
(function loadPersistedData() {
  // Load persisted alerts (overrides seed alerts)
  const savedAlerts = loadJsonFile<Alert[]>(ALERTS_FILE, []);
  if (savedAlerts.length > 0) {
    alerts.clear();
    savedAlerts.forEach(a => alerts.set(a.id, a));
    console.log(`[Persist] Loaded ${savedAlerts.length} alerts from disk`);
  }

  // Load persisted family perimeters
  const savedPerimeters = loadJsonFile<FamilyPerimeter[]>(FAMILY_PERIMETERS_FILE, []);
  savedPerimeters.forEach(p => familyPerimeters.set(p.id, p));
  if (savedPerimeters.length > 0) {
    console.log(`[Persist] Loaded ${savedPerimeters.length} family perimeters from disk`);
  }

  // Load persisted sectors
  const savedSectors = loadJsonFile<Sector[]>(SECTORS_FILE, []);
  savedSectors.forEach(s => sectors.set(s.id, s));
  if (savedSectors.length > 0) {
    console.log(`[Persist] Loaded ${savedSectors.length} sectors from disk`);
  }

  // Load persisted manual presence status
  const savedPresence = loadJsonFile<({ targetUserId: string } & PresenceManualStatus)[]>(PRESENCE_FILE, []);
  savedPresence.forEach(p => manualPresence.set(p.targetUserId, { status: p.status, placeLabel: p.placeLabel, setBy: p.setBy, setAt: p.setAt }));
  if (savedPresence.length > 0) {
    console.log(`[Persist] Loaded ${savedPresence.length} manual presence statuses from disk`);
  }

  // Load persisted automatic presence state (arrival times, last known place)
  const savedAutoPresence = loadJsonFile<({ userId: string } & AutoPresenceState)[]>(AUTO_PRESENCE_FILE, []);
  savedAutoPresence.forEach(p => autoPresenceState.set(p.userId, { status: p.status, label: p.label, since: p.since }));
  if (savedAutoPresence.length > 0) {
    console.log(`[Persist] Loaded ${savedAutoPresence.length} automatic presence states from disk`);
  }

  // Load persisted proximity alerts
  const savedProxAlerts = loadJsonFile<ProximityAlert[]>(PROXIMITY_ALERTS_FILE, []);
  proximityAlerts.push(...savedProxAlerts);
  if (savedProxAlerts.length > 0) {
    console.log(`[Persist] Loaded ${savedProxAlerts.length} proximity alerts from disk`);
  }

  // Load persisted curfew checks (scheduling happens in server.listen()'s callback,
  // once `users` positions can start arriving — see the boot-time rehydration below)
  const savedCurfewChecks = loadJsonFile<CurfewCheck[]>(CURFEW_CHECKS_FILE, []);
  savedCurfewChecks.forEach(c => curfewChecks.set(c.id, c));
  if (savedCurfewChecks.length > 0) {
    console.log(`[Persist] Loaded ${savedCurfewChecks.length} curfew checks from disk`);
  }

  const savedCheckIns = loadJsonFile<ScheduledCheckIn[]>(SCHEDULED_CHECKINS_FILE, []);
  savedCheckIns.forEach(c => scheduledCheckIns.set(c.id, c));
  if (savedCheckIns.length > 0) {
    console.log(`[Persist] Loaded ${savedCheckIns.length} scheduled check-ins from disk`);
  }

  // Load persisted location history
  const savedHistory = loadJsonFile<Record<string, LocationHistoryEntry[]>>(LOCATION_HISTORY_FILE, {});
  for (const [uid, entries] of Object.entries(savedHistory)) {
    locationHistory.set(uid, entries);
  }
  const totalEntries = Object.values(savedHistory).reduce((sum, arr) => sum + arr.length, 0);
  if (totalEntries > 0) {
    console.log(`[Persist] Loaded ${totalEntries} location history entries for ${Object.keys(savedHistory).length} users`);
  }

  // Load persisted patrol reports
  const savedPatrolReports = loadJsonFile<PatrolReport[]>(PATROL_REPORTS_FILE, []);
  patrolReports.push(...savedPatrolReports);
  if (savedPatrolReports.length > 0) {
    console.log(`[Persist] Loaded ${savedPatrolReports.length} patrol reports from disk`);
  }
})();

// Helper: persist alerts to disk (debounced)
function persistAlerts() {
  debouncedSave(ALERTS_FILE, Array.from(alerts.values()));
  alerts.forEach(alert => saveAlertToSupabase(alert));
}

// Helper: persist family perimeters to disk (debounced)
function persistPerimeters() {
  debouncedSave(FAMILY_PERIMETERS_FILE, Array.from(familyPerimeters.values()));
  familyPerimeters.forEach(p => saveFamilyPerimeterToSupabase(p));
}

// Helper: persist curfew checks to disk (debounced)
function persistCurfewChecks() {
  debouncedSave(CURFEW_CHECKS_FILE, Array.from(curfewChecks.values()));
}

// Helper: persist scheduled check-ins to disk (debounced)
function persistCheckIns() {
  debouncedSave(SCHEDULED_CHECKINS_FILE, Array.from(scheduledCheckIns.values()));
}

// Helper: persist sectors to disk (debounced)
function persistSectors() {
  debouncedSave(SECTORS_FILE, Array.from(sectors.values()));
  sectors.forEach(s => saveSectorToSupabase(s));
}

// Helper: persist proximity alerts to disk (debounced)
function persistProximityAlerts() {
  debouncedSave(PROXIMITY_ALERTS_FILE, proximityAlerts);
}

// Helper: persist patrol reports to disk (debounced)
function persistPatrolReports() {
  debouncedSave(PATROL_REPORTS_FILE, patrolReports);
  patrolReports.forEach(r => savePatrolReportToSupabase(r));
}

// Helper: persist location history to disk (debounced)
function persistLocationHistory() {
  const obj: Record<string, LocationHistoryEntry[]> = {};
  locationHistory.forEach((entries, uid) => { obj[uid] = entries; });
  debouncedSave(LOCATION_HISTORY_FILE, obj, 5000); // longer debounce for frequent updates
}

// ─── Helper: recompute an alert's overall escalation level from per-responder state ───
function recomputeEscalationLevel(alert: Alert): void {
  const levels = Object.values(alert.responderEscalation || {});
  alert.escalationLevel = (levels.length ? Math.max(...levels) : 0) as 0 | 1 | 2;
}

// ─── Helper: add audit entry ─────────────────────────────────────────
function addAuditEntry(category: AuditEntry['category'], action: string, performedBy: string, details: string, targetUser?: string, organizationId?: string) {
  auditLog.unshift({
    id: uuidv4(),
    timestamp: Date.now(),
    category,
    action,
    performedBy,
    targetUser,
    details,
    organizationId,
  });
}

// ─── WebSocket server-side ping to keep connections alive through proxies ───
const WS_PING_INTERVAL = 25000; // 25 seconds (< typical 60s proxy timeout)
setInterval(() => {
  wss.clients.forEach((ws: any) => {
    if (ws.isAlive === false) {
      console.log('[WS] Terminating dead connection');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);

// ─── WebSocket connection handler ────────────────────────────────────────
wss.on('connection', (ws: any) => {
  console.log('New WebSocket connection');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let userId: string | null = null;
  let userRole: string | null = null;
  ws.on('message', (rawData) => {
    try {
      const dataStr = rawData.toString();
      const message: WebSocketMessage = JSON.parse(dataStr);
      // Log PTT message sizes for debugging
      if (message.type === 'pttTransmit' || message.type === 'pttEmergency') {
        console.log(`[WS] Received ${message.type} from ${message.userId || userId}: ${(dataStr.length / 1024).toFixed(1)} KB total, audioBase64: ${message.data?.audioBase64 ? (message.data.audioBase64.length / 1024).toFixed(1) + ' KB' : 'MISSING'}`);
      }
      handleMessage(ws, message, (id, role) => {
        userId = id;
        userRole = role;
      }, userId, userRole);
    } catch (error: any) {
      if (error?.message?.includes('undefined') || error?.message?.includes('null')) return;
      console.error('Failed to parse message:', error);
    }
  });

  ws.on('close', () => {
    wsClientMap.delete(ws);
    if (userId) {
      console.log(`User ${userId} disconnected`);
      const conns = userConnections.get(userId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) {
          userConnections.delete(userId);
          // Only announce offline once every connection for this user has closed —
          // the app keeps two sockets open per session (wsManager + legacy
          // websocketService), so without this check a single reconnect cycle
          // fired an online/offline pair per socket, twice the real number.
          broadcastUserStatus(userId, 'offline');
        }
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Message handler
function handleMessage(
  ws: any,
  message: WebSocketMessage,
  setUserContext: (id: string, role: string) => void,
  connUserId?: string | null,
  connUserRole?: string | null
) {
  // The connection-level identity (connUserId/connUserRole) comes from
  // handleAuth, which now verifies a real Supabase token — it must win over
  // message.userId/userRole, which are just claims the client can put in any
  // message. Falling back to message-level values only matters pre-auth
  // (there is no connection-level identity yet); once authenticated, trusting
  // a per-message override would let any connected client silently act as a
  // different user on every subsequent message despite a legitimate handshake.
  const userId = connUserId || message.userId || undefined;
  const userRole = connUserRole || message.userRole || undefined;
  const { type, data, timestamp } = message;

  switch (type) {
    case 'auth':
      handleAuth(ws, message.token, setUserContext).catch(e => console.error('[WS] handleAuth error:', e));
      break;

    case 'sendAlert':
      // All authenticated roles can send alerts (users can trigger SOS)
      if (userId && userRole) {
        handleCreateAlert(ws, userId, userRole, data);
      } else {
        ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized to create alerts - not authenticated' }));
      }
      break;

    case 'updateLocation':
      handleLocationUpdate(ws, userId!, userRole!, data);
      break;

    case 'updateStatus':
      if (userRole === 'responder') {
        handleStatusUpdate(ws, userId!, data);
      }
      break;

    case 'acknowledgeAlert':
      handleAcknowledgeAlert(ws, userId!, data);
      break;

    case 'getAlerts':
      handleGetAlerts(ws, userId!, userRole!);
      break;

    case 'getResponders':
      if (userRole === 'dispatcher') {
        handleGetResponders(ws);
      }
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

    // ─── PTT WebSocket Messages ────────────────────────────────────────────────
    case 'pttTransmit':
      if (userId && userRole) {
        handlePTTTransmit(ws, userId, userRole, data);
      }
      break;

    case 'pttJoinChannel':
      if (userId && userRole) {
        handlePTTJoinChannel(ws, userId, userRole, data);
      }
      break;

    case 'pttStart':
    case 'pttEnd': {
      // Diffuser PTT simple à l'organisation de l'expéditeur uniquement
      // (auparavant diffusé à tous les clients connectés, toutes
      // organisations confondues).
      const pttStartOrgId = userId ? adminUsers.get(userId)?.organizationId : undefined;
      const pttPayload = JSON.stringify({ type: data.type, senderId: data.senderId, senderName: data.senderName, channel: data.channel });
      wss.clients.forEach((client: any) => {
        if (client === ws || client.readyState !== 1) return;
        const connUid = wsClientMap.get(client);
        const connUser = connUid ? users.get(connUid) : undefined;
        if (connUser?.organizationId === pttStartOrgId) client.send(pttPayload);
      });
      break;
    }

    case 'pttStartTalking':
      if (userId && userRole) {
        handlePTTTalkingState(ws, userId, userRole, data, true);
      }
      break;

    case 'pttStopTalking':
      if (userId && userRole) {
        handlePTTTalkingState(ws, userId, userRole, data, false);
      }
      break;

    case 'pttEmergency':
      if (userId && userRole) {
        handlePTTEmergency(ws, userId, userRole, data);
      }
      break;

    default:
      console.warn(`Unknown message type: ${type}`);
  }
}

// Authentication handler — verifies the Supabase access token before trusting
// ANY identity claim. Previously this trusted the client-sent userId/userRole
// outright with no proof at all: any WebSocket client could claim to be any
// user, any role (including 'admin'), and receive every broadcast that
// identity is entitled to. userId/userRole are now derived exclusively from
// the verified token + admin_users lookup, never from client-sent fields.
async function handleAuth(ws: any, token: string | undefined, setUserContext: (id: string, role: string) => void) {
  if (!token) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing auth token' }));
    return;
  }
  const { data: { user: verifiedUser }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !verifiedUser) {
    ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
    return;
  }
  const userId = verifiedUser.id;
  const adminUser = adminUsers.get(userId);
  const userRole = adminUser?.role || 'user';
  const organizationId = adminUser?.organizationId;

  const user: User = {
    id: userId,
    email: adminUser?.email || verifiedUser.email || `${userId}@talion.local`,
    role: userRole as any,
    status: userRole === 'responder' ? 'available' : undefined,
    lastSeen: Date.now(),
    organizationId,
  };

  users.set(userId, user);

  // Same reasoning as the close handler: only the transition from zero to one
  // active connection counts as "coming online" — a second socket for a user
  // already connected elsewhere shouldn't re-announce them.
  const wasAlreadyConnected = (userConnections.get(userId)?.size || 0) > 0;
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId)!.add(ws);
  wsClientMap.set(ws, userId);

  setUserContext(userId, userRole);

  ws.send(JSON.stringify({
    type: 'authSuccess',
    userId,
    userRole,
    timestamp: Date.now(),
  }));

  console.log(`User ${userId} (${userRole}) authenticated`);

  // Log auth event
  addAuditEntry('auth', 'User Login', userId, `${userRole} login via WebSocket`, undefined, organizationId);

  const activeAlerts = Array.from(alerts.values())
    .filter(a => a.status === 'active' && canAccessOrg({ role: userRole, organizationId }, a.organizationId))
    .map(a => ({
      ...a,
      respondingNames: (a.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
    }));
  ws.send(JSON.stringify({
    type: 'alertsSnapshot',
    data: activeAlerts,
  }));

  const activeRounds = Array.from(activePatrolRounds.values())
    .filter(r => canAccessOrg({ role: userRole, organizationId }, r.organizationId));
  ws.send(JSON.stringify({
    type: 'activePatrolRoundsSnapshot',
    data: activeRounds,
  }));

  const activeRoutes = Array.from(activeResponderRoutes.values())
    .filter(r => canAccessOrg({ role: userRole, organizationId }, r.organizationId));
  ws.send(JSON.stringify({
    type: 'activeRoutesSnapshot',
    data: activeRoutes,
  }));

  if (!wasAlreadyConnected) broadcastUserStatus(userId, 'online');
}

// Create alert handler
async function handleCreateAlert(ws: any, userId: string, userRole: string, alertData: any) {
  const alert: Alert = {
    id: await generateIncidentId(alertData.type || 'other', userId, alertData.location || {}),
    type: alertData.type || 'other',
    severity: alertData.severity || 'medium',
    location: alertData.location || { latitude: 0, longitude: 0, address: 'Unknown' },
    description: alertData.description || '',
    createdBy: userId,
    reporterId: userId,
    organizationId: adminUsers.get(userId)?.organizationId,
    origin: 'mobile',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
    photos: [],
  };

  alerts.set(alert.id, alert);
  linkPossibleDuplicates(alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[WS CreateAlert] Supabase save error:', e));
  console.log(`New alert created: ${alert.id} by ${userId}`);

  addAuditEntry('incident', 'Incident Created', userId, `Created ${alert.id}: ${alert.type} at ${alert.location.address}`, undefined, alert.organizationId);

  broadcastToOrg(alert.organizationId, { type: 'newAlert', data: alert });
  ws.send(JSON.stringify({ type: 'alertCreated', alertId: alert.id, timestamp: Date.now() }));
}

// Haversine distance in meters
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Ghost-mode gating: true if this user has confirmed visibility for any currently
// active (non-resolved/cancelled) incident. Computed at read-time from `alerts` —
// no separate expiry timer needed, since it naturally stops counting the moment the
// incident resolves or is cancelled.
function isRevealedForActiveIncident(userId: string): boolean {
  for (const alert of alerts.values()) {
    if (alert.status === 'resolved' || alert.status === 'cancelled') continue;
    if (alert.revealedUserIds?.includes(userId)) return true;
  }
  return false;
}

// ─── ETA estimate (straight-line distance × road-distance factor ÷ assumed speed) ───
const ETA_ROAD_DISTANCE_FACTOR = 1.3; // straight-line → approximate real road distance
const ETA_AVERAGE_SPEED_KMH = 32; // assumed effective average speed (urban, incl. stops/traffic)
const ETA_MIN_MINUTES = 1; // floor so very-close responders don't show "0 min"

function estimateEtaMinutes(distanceMeters: number): number {
  const roadDistanceKm = (distanceMeters / 1000) * ETA_ROAD_DISTANCE_FACTOR;
  const minutes = (roadDistanceKm / ETA_AVERAGE_SPEED_KMH) * 60;
  return Math.max(ETA_MIN_MINUTES, Math.round(minutes));
}

function formatEtaLabel(minutes: number | null): string | null {
  return minutes == null ? null : `~${minutes} min`;
}

// Check geofence entry/exit for a responder
function checkGeofences(userId: string, location: { latitude: number; longitude: number }) {
  const responderUser = users.get(userId);
  const responderName = responderUser ? (adminUsers.get(userId)?.name || userId) : userId;

  geofenceZones.forEach((zone, zoneId) => {
    const dist = haversineDistance(location.latitude, location.longitude, zone.center.latitude, zone.center.longitude);
    const insideNow = dist <= zone.radiusKm * 1000;

    if (!responderZoneState.has(zoneId)) {
      responderZoneState.set(zoneId, new Set());
    }
    const zoneSet = responderZoneState.get(zoneId)!;
    const wasInside = zoneSet.has(userId);

    if (insideNow && !wasInside) {
      // ENTRY event
      zoneSet.add(userId);
      const event: GeofenceEvent = {
        id: uuidv4(),
        zoneId,
        responderId: userId,
        responderName,
        eventType: 'entry',
        timestamp: Date.now(),
        location,
        organizationId: adminUsers.get(userId)?.organizationId,
      };
      geofenceEvents.unshift(event);
      addAuditEntry('broadcast', 'Geofence Entry', userId, `${responderName} entered zone ${zoneId} (${zone.severity} — ${zone.radiusKm}km)`, undefined, adminUsers.get(userId)?.organizationId);
      broadcastToOrg(adminUsers.get(userId)?.organizationId, {
        type: 'geofenceEntry',
        data: { ...event, zone: { id: zone.id, severity: zone.severity, radiusKm: zone.radiusKm, message: zone.message } },
      });
      console.log(`[Geofence] ${responderName} ENTERED zone ${zoneId}`);
    } else if (!insideNow && wasInside) {
      // EXIT event
      zoneSet.delete(userId);
      const event: GeofenceEvent = {
        id: uuidv4(),
        zoneId,
        responderId: userId,
        responderName,
        eventType: 'exit',
        timestamp: Date.now(),
        location,
        organizationId: adminUsers.get(userId)?.organizationId,
      };
      geofenceEvents.unshift(event);
      addAuditEntry('broadcast', 'Geofence Exit', userId, `${responderName} exited zone ${zoneId} (${zone.severity} — ${zone.radiusKm}km)`, undefined, adminUsers.get(userId)?.organizationId);
      broadcastToOrg(adminUsers.get(userId)?.organizationId, {
        type: 'geofenceExit',
        data: { ...event, zone: { id: zone.id, severity: zone.severity, radiusKm: zone.radiusKm, message: zone.message } },
      });
      console.log(`[Geofence] ${responderName} EXITED zone ${zoneId}`);
    }
  });
}

// ─── Active patrol round tracking ────────────────────────────────────────
const MAX_ROUND_TRAIL_POINTS = 2000; // ~5-6h of continuous tracking at typical GPS cadence
const IMMOBILITY_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes, per product decision
const MOVEMENT_NOISE_METERS = 8; // below this, treat consecutive pings as "not moved" (GPS jitter)

// Route-planning tuning constants (post-round "next location" navigation).
const ROUTE_ARRIVAL_RADIUS_METERS = 100; // auto-clears the active nav once within this of the destination
const ROUTE_HISTORY_LOOKBACK_DAYS = 45; // how far back to compare candidate routes against past trips
const ROUTE_HISTORY_MAX_ROWS = 20; // cap on history rows fetched per scoring call
const BLACKBOOK_PROXIMITY_LOOKBACK_DAYS = 90;
const BLACKBOOK_PROXIMITY_RADIUS_METERS = 150;
const ROUTE_GRID_CELL_DEGREES = 0.00068; // ~75m at Geneva's latitude, for coarse route-overlap comparison
const ROUTE_DURATION_CAP_FACTOR = 1.25; // don't recommend a route more than 25% longer than the fastest option

// Intelligence-layer tuning constants (site risk score + live responder
// proximity alerts, built on top of Blackbook + incident + patrol data).
const RISK_SCORE_INCIDENT_LOOKBACK_DAYS = 180; // incidents older than this don't count against a site's score
const RISK_SCORE_SITE_RADIUS_METERS = 300; // wider than BLACKBOOK_PROXIMITY_RADIUS_METERS — site-level, not path-level
const RISK_SCORE_PATROL_REPORT_SAMPLE = 20; // most-recent reports considered for the compliance signal
const BLACKBOOK_TEMPORAL_PATTERN_MIN_OCCURRENCES = 3;
const BLACKBOOK_TEMPORAL_BUCKET_HOURS = 3; // sightings grouped into same-weekday, same N-hour-of-day buckets
const RESPONDER_PROXIMITY_ALERT_RADIUS_METERS = BLACKBOOK_PROXIMITY_RADIUS_METERS;
const RESPONDER_PROXIMITY_ALERT_LOOKBACK_DAYS = BLACKBOOK_PROXIMITY_LOOKBACK_DAYS;

// "Needs attention" notification for a round in progress — mirrors
// handleSoftEscalation's pattern (audit + push loop + broadcast), but scopes
// the push loop to the round's own organization (handleSoftEscalation's
// push loop doesn't, an existing gap out of scope here).
function notifyPatrolRoundAttention(round: ActivePatrolRound, kind: 'immobility' | 'missed_checkpoints', message: string) {
  addAuditEntry('system', kind === 'immobility' ? 'Ronde: immobilité prolongée' : 'Ronde: checkpoint(s) manqué(s)', round.responderName, message, round.responderId, round.organizationId);
  const notifiedStaff = new Set<string>();
  for (const [, entry] of pushTokens) {
    if ((entry.userRole === 'dispatcher' || entry.userRole === 'admin' || entry.userRole === 'superadmin') && !notifiedStaff.has(entry.userId)) {
      if (!canAccessOrg({ role: entry.userRole, organizationId: adminUsers.get(entry.userId)?.organizationId }, round.organizationId)) continue;
      notifiedStaff.add(entry.userId);
      sendPushToUser(entry.userId, kind === 'immobility' ? '⚠️ Ronde — immobilité prolongée' : '⚠️ Ronde — checkpoint(s) manqué(s)', message, { type: 'patrol_round_attention', roundId: round.id, kind }).catch(() => {});
    }
  }
  const payload = { type: 'patrolRoundAttention', data: { roundId: round.id, kind, message, responderId: round.responderId, responderName: round.responderName, siteName: round.siteName } };
  broadcastToOrgRole(round.organizationId, 'dispatcher', payload);
  broadcastToOrgRole(round.organizationId, 'admin', payload);
}

// Checkpoint proximity + cumulative dwell-time detection, plus prolonged-
// immobility detection, for a responder's round in progress (if any).
// Mirrors checkGeofences' haversine-distance approach; called from
// handleLocationUpdate on every ping, same as checkGeofences.
function checkActivePatrolRound(userId: string, location: { latitude: number; longitude: number }) {
  const round = Array.from(activePatrolRounds.values()).find(r => r.responderId === userId);
  if (!round) return;
  const now = Date.now();
  const deltaSeconds = round.lastLocation ? Math.max(0, (now - round.lastLocation.timestamp) / 1000) : 0;

  round.trail.push({ latitude: location.latitude, longitude: location.longitude, timestamp: now });
  if (round.trail.length > MAX_ROUND_TRAIL_POINTS) round.trail.splice(0, round.trail.length - MAX_ROUND_TRAIL_POINTS);

  const movedMeters = round.lastLocation
    ? haversineDistance(round.lastLocation.latitude, round.lastLocation.longitude, location.latitude, location.longitude)
    : Infinity;
  if (movedMeters > MOVEMENT_NOISE_METERS) {
    round.lastMovementAt = now;
    round.immobilityAlertedAt = undefined;
  }
  round.lastLocation = { latitude: location.latitude, longitude: location.longitude, timestamp: now };

  let insideAnyCheckpoint = false;
  const newlySatisfied: ActivePatrolRoundCheckpointState[] = [];
  round.checkpoints.forEach(cp => {
    const dist = haversineDistance(location.latitude, location.longitude, cp.latitude, cp.longitude);
    const insideNow = dist <= cp.radiusMeters;
    if (insideNow) {
      insideAnyCheckpoint = true;
      if (cp.wasInsideLastPing) cp.dwellSeconds += deltaSeconds;
      cp.visited = true;
      const wasMet = cp.dwellMet;
      cp.dwellMet = !cp.minDwellSeconds || cp.dwellSeconds >= cp.minDwellSeconds;
      if (cp.dwellMet && !wasMet) newlySatisfied.push(cp);
    }
    cp.wasInsideLastPing = insideNow;
  });

  if (!insideAnyCheckpoint && !round.immobilityAlertedAt && (now - round.lastMovementAt) > IMMOBILITY_THRESHOLD_MS) {
    round.immobilityAlertedAt = now;
    notifyPatrolRoundAttention(round, 'immobility', `${round.responderName} est immobile depuis plus de 3 minutes pendant la ronde "${round.siteName}".`);
  }

  const locPayload = { type: 'patrolRoundLocationUpdate', data: { roundId: round.id, location, timestamp: now } };
  broadcastToOrgRole(round.organizationId, 'dispatcher', locPayload);
  broadcastToOrgRole(round.organizationId, 'admin', locPayload);
  newlySatisfied.forEach(cp => {
    // Also pushed straight to the responder's own device (not just
    // dispatch/admin) so the round screen can show "checkpoint validated"
    // instantly instead of waiting on a poll.
    const msg = { type: 'patrolCheckpointVisited', data: { roundId: round.id, checkpointId: cp.checkpointId, name: cp.name } };
    broadcastToOrgRole(round.organizationId, 'dispatcher', msg);
    broadcastToOrgRole(round.organizationId, 'admin', msg);
    broadcastToUsers([round.responderId], msg);
  });
}

// Condenses a round in progress into a durable PatrolReport, removes it
// from activePatrolRounds, and notifies dispatch/admin — shared by both the
// interrupt and finish routes, which only differ in roundStatus/reason.
function finalizePatrolRound(
  round: ActivePatrolRound,
  roundStatus: 'completed' | 'interrupted',
  interruptReason?: string,
  questionnaire?: { status: PatrolStatus; tasks: PatrolTask[]; notes?: string }
): PatrolReport {
  const checkpointResults: PatrolCheckpointResult[] = round.checkpoints.map(cp => ({
    checkpointId: cp.checkpointId,
    name: cp.name,
    latitude: cp.latitude,
    longitude: cp.longitude,
    radiusMeters: cp.radiusMeters,
    visited: cp.visited,
    dwellSeconds: Math.round(cp.dwellSeconds),
    minDwellSeconds: cp.minDwellSeconds,
    dwellMet: cp.dwellMet,
  }));
  const missed = checkpointResults.filter(c => !c.dwellMet);

  const report: PatrolReport = {
    id: `PR-${uuidv4().slice(0, 8)}`,
    createdAt: Date.now(),
    createdBy: round.responderId,
    createdByName: round.responderName,
    location: round.siteName,
    // A normal "finish" always carries the same status/tasks/notes
    // questionnaire as a manual report — an interrupt (emergency bail-out)
    // skips it, so falls back to a status derived from checkpoint coverage.
    status: questionnaire?.status || (missed.length > 0 ? 'inhabituel' : 'habituel'),
    tasks: questionnaire?.tasks || [],
    notes: questionnaire?.notes,
    media: [],
    organizationId: round.organizationId,
    siteId: round.siteId,
    checkpoints: checkpointResults,
    trail: round.trail,
    roundStatus,
    startedAt: round.startedAt,
    interruptReason: roundStatus === 'interrupted' ? interruptReason : undefined,
  };

  patrolReports.unshift(report);
  persistPatrolReports();
  savePatrolReportToSupabase(report).catch(e => console.error('[PatrolRound] Supabase save error:', e));

  activePatrolRounds.delete(round.id);

  const finishPayload = {
    type: roundStatus === 'interrupted' ? 'patrolRoundInterrupted' : 'patrolRoundFinished',
    data: { roundId: round.id, report },
  };
  broadcastToOrgRole(round.organizationId, 'dispatcher', finishPayload);
  broadcastToOrgRole(round.organizationId, 'admin', finishPayload);

  addAuditEntry(
    'system',
    roundStatus === 'interrupted' ? 'Ronde interrompue' : 'Ronde terminée',
    round.responderName,
    `Ronde "${round.siteName}" ${roundStatus === 'interrupted' ? 'interrompue' : 'terminée'}${missed.length > 0 ? ` — ${missed.length} checkpoint(s) manqué(s)` : ''}`,
    round.responderId,
    round.organizationId
  );

  if (missed.length > 0) {
    const names = missed.map(c => c.name).join(', ');
    notifyPatrolRoundAttention(
      round,
      'missed_checkpoints',
      `${round.responderName} a ${roundStatus === 'interrupted' ? 'interrompu' : 'terminé'} la ronde "${round.siteName}" sans valider : ${names}.`
    );
  }

  return report;
}

// ─── Post-round route planning: "next location" recommendation ─────────
// A site's destination for routing purposes is its own address/coordinates
// if set (the normal case going forward — set via /admin/patrol-sites).
// Falls back to the centroid of its checkpoints for older sites that
// predate the address field but already have a round configured. Returns
// null (caller responds 400) only when neither is available.
function resolveSiteDestination(siteId: string): { latitude: number; longitude: number } | null {
  const site = patrolSites.get(siteId);
  if (site && typeof site.latitude === 'number' && typeof site.longitude === 'number') {
    return { latitude: site.latitude, longitude: site.longitude };
  }
  const checkpoints = Array.from(patrolCheckpoints.values()).filter(c => c.siteId === siteId);
  if (checkpoints.length === 0) return null;
  const latitude = checkpoints.reduce((sum, c) => sum + c.latitude, 0) / checkpoints.length;
  const longitude = checkpoints.reduce((sum, c) => sum + c.longitude, 0) / checkpoints.length;
  return { latitude, longitude };
}

async function fetchDirectionsAlternatives(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  mode: 'driving' | 'walking'
): Promise<{ geometry: { latitude: number; longitude: number }[]; distanceMeters: number; durationSeconds: number }[]> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) throw new Error('MAPBOX_TOKEN not configured');
  const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
  const url = `https://api.mapbox.com/directions/v5/mapbox/${mode}/${coords}?alternatives=true&geometries=geojson&overview=full&access_token=${token}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Mapbox Directions error: ${response.status}`);
  const data = await response.json();
  if (!data.routes || data.routes.length === 0) throw new Error('No route found');
  return data.routes.map((r: any) => ({
    geometry: (r.geometry.coordinates as [number, number][]).map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
    distanceMeters: r.distance,
    durationSeconds: r.duration,
  }));
}

// Coarse grid bucketing (not a precise metric grid — fine for comparing
// routes that are all local to the same city) used to compare a candidate
// route's footprint against past trips without needing a geo library.
function snapGeometryToGrid(geometry: { latitude: number; longitude: number }[]): Set<string> {
  const cells = new Set<string>();
  for (const p of geometry) {
    const cellLat = Math.round(p.latitude / ROUTE_GRID_CELL_DEGREES);
    const cellLon = Math.round(p.longitude / ROUTE_GRID_CELL_DEGREES);
    cells.add(`${cellLat}:${cellLon}`);
  }
  return cells;
}

function jaccardOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const cell of a) if (b.has(cell)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// Reduces a route's point count before it's persisted to patrol_route_history
// — full-resolution geometry isn't needed for grid-overlap scoring.
function simplifyGeometry(geometry: { latitude: number; longitude: number }[], maxPoints: number): { latitude: number; longitude: number }[] {
  if (geometry.length <= maxPoints) return geometry;
  const step = geometry.length / maxPoints;
  const result: { latitude: number; longitude: number }[] = [];
  for (let i = 0; i < maxPoints; i++) result.push(geometry[Math.floor(i * step)]);
  return result;
}

// Min distance from a point to a polyline (min over consecutive segments of
// point-to-segment distance), in meters. No point-to-polyline helper existed
// anywhere in this file before — snapGeometryToGrid/jaccardOverlap above
// compare whole-route footprints for patrol variety scoring, not live
// point-to-path distance. Uses a local equirectangular projection centered on
// `point` (so it's always at the origin) rather than a proper geodesic —
// plenty accurate at city/commute scale, same tradeoff snapGeometryToGrid
// already makes.
function distanceToPolylineMeters(point: { latitude: number; longitude: number }, geometry: { latitude: number; longitude: number }[]): number {
  if (geometry.length === 0) return Infinity;
  if (geometry.length === 1) return haversineDistance(point.latitude, point.longitude, geometry[0].latitude, geometry[0].longitude);
  const metersPerDegLat = 111320;
  const metersPerDegLon = 111320 * Math.cos((point.latitude * Math.PI) / 180);
  const toXY = (p: { latitude: number; longitude: number }) => ({
    x: (p.longitude - point.longitude) * metersPerDegLon,
    y: (p.latitude - point.latitude) * metersPerDegLat,
  });
  let minDist = Infinity;
  for (let i = 0; i < geometry.length - 1; i++) {
    const a = toXY(geometry[i]);
    const b = toXY(geometry[i + 1]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq === 0 ? 0 : (-a.x * dx - a.y * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = a.x + t * dx;
    const closestY = a.y + t * dy;
    const dist = Math.sqrt(closestX * closestX + closestY * closestY);
    if (dist < minDist) minDist = dist;
  }
  return minDist;
}

function isWithinCommuteWindow(windows: { hour: number; minute: number; durationMinutes: number; daysOfWeek: number[] }[], now: Date = new Date()): boolean {
  const day = now.getDay();
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  return windows.some(w => {
    if (!w.daysOfWeek.includes(day)) return false;
    const start = w.hour * 60 + w.minute;
    return minutesNow >= start && minutesNow <= start + w.durationMinutes;
  });
}

async function fetchRecentRouteHistory(organizationId: string, toSiteId: string): Promise<{ geometry: { latitude: number; longitude: number }[] }[]> {
  try {
    const cutoff = Date.now() - ROUTE_HISTORY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
    const { data, error } = await supabaseAdmin.from('patrol_route_history')
      .select('geometry')
      .eq('organization_id', organizationId)
      .eq('to_site_id', toSiteId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(ROUTE_HISTORY_MAX_ROWS);
    if (error) { console.error('[RouteHistory] fetch error:', error.message); return []; }
    return (data || []).map((row: any) => ({
      geometry: ((row.geometry || []) as [number, number][]).map(([lon, lat]) => ({ latitude: lat, longitude: lon })),
    }));
  } catch (e) { console.error('[RouteHistory] fetch error:', e); return []; }
}

async function saveRouteHistoryToSupabase(row: {
  id: string; organizationId: string; responderId: string; toSiteId: string;
  fromLatitude: number; fromLongitude: number; geometry: { latitude: number; longitude: number }[];
  distanceMeters: number; durationSeconds: number; createdAt: number;
}): Promise<void> {
  try {
    const simplified = simplifyGeometry(row.geometry, 40);
    const { error } = await supabaseAdmin.from('patrol_route_history').insert({
      id: row.id, organization_id: row.organizationId, responder_id: row.responderId,
      to_site_id: row.toSiteId, from_latitude: row.fromLatitude, from_longitude: row.fromLongitude,
      geometry: simplified.map(p => [p.longitude, p.latitude]),
      distance_meters: row.distanceMeters, duration_seconds: row.durationSeconds, created_at: row.createdAt,
    });
    if (error) console.error('[RouteHistory] save error:', error.message);
  } catch (e) { console.error('[RouteHistory] save error:', e); }
}

// Counts distinct Blackbook sightings (this org, recent) that fall within
// BLACKBOOK_PROXIMITY_RADIUS_METERS of a candidate route — the security-
// specific signal a generic maps app has no way to factor in.
function countBlackbookProximity(geometry: { latitude: number; longitude: number }[], organizationId: string): { count: number; mostRecentTimestamp?: number } {
  const cutoff = Date.now() - BLACKBOOK_PROXIMITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const sampled = geometry.filter((_, i) => i % 4 === 0); // bound the O(points * sightings) cost
  const nearSightingIds = new Set<string>();
  let mostRecentTimestamp: number | undefined;
  for (const entry of blackbookEntries.values()) {
    if (entry.organizationId !== organizationId) continue;
    for (const sighting of entry.sightings) {
      if (sighting.timestamp < cutoff) continue;
      const lat = sighting.location?.latitude;
      const lon = sighting.location?.longitude;
      if (lat === undefined || lon === undefined) continue;
      const isNear = sampled.some(p => haversineDistance(p.latitude, p.longitude, lat, lon) <= BLACKBOOK_PROXIMITY_RADIUS_METERS);
      if (isNear) {
        nearSightingIds.add(sighting.id);
        if (!mostRecentTimestamp || sighting.timestamp > mostRecentTimestamp) mostRecentTimestamp = sighting.timestamp;
      }
    }
  }
  return { count: nearSightingIds.size, mostRecentTimestamp };
}

// ─── Site risk score ──────────────────────────────────────────────────
// Same shape as scoreRouteCandidates below: small pure signal functions,
// each returning a 0-100 score + a plain-language detail string, combined
// by a weighted sum into a band + rationale. Deterministic scoring over
// data already collected — not machine learning (see plan notes).
interface SiteRiskSignal { label: string; weight: number; score: number; detail: string; }
interface SiteRiskResult {
  siteId: string; siteName: string; score: number;
  band: 'low' | 'medium' | 'high' | 'critical';
  signals: SiteRiskSignal[]; rationale: string; computedAt: number;
}

const RISK_LEVEL_WEIGHT: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const ALERT_SEVERITY_WEIGHT: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function scoreBlackbookProximitySignal(coords: { latitude: number; longitude: number }, organizationId?: string): SiteRiskSignal {
  const cutoff = Date.now() - BLACKBOOK_PROXIMITY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let weightedCount = 0;
  let nearestMeters: number | undefined;
  for (const entry of blackbookEntries.values()) {
    if (entry.organizationId !== organizationId) continue;
    for (const s of entry.sightings) {
      if (s.timestamp < cutoff || s.location?.latitude === undefined || s.location?.longitude === undefined) continue;
      const dist = haversineDistance(coords.latitude, coords.longitude, s.location.latitude, s.location.longitude);
      if (dist > RISK_SCORE_SITE_RADIUS_METERS) continue;
      weightedCount += RISK_LEVEL_WEIGHT[entry.riskLevel] || 1;
      if (nearestMeters === undefined || dist < nearestMeters) nearestMeters = dist;
    }
  }
  const score = Math.min(100, weightedCount * 12);
  const detail = weightedCount === 0
    ? 'Aucun signalement Blackbook à proximité'
    : `${weightedCount} point(s) de signalement Blackbook pondéré(s) à proximité${nearestMeters !== undefined ? ` (le plus proche à ${Math.round(nearestMeters)}m)` : ''}`;
  return { label: 'Blackbook', weight: 0.45, score, detail };
}

function scoreIncidentHistorySignal(coords: { latitude: number; longitude: number }, organizationId?: string): SiteRiskSignal {
  const cutoff = Date.now() - RISK_SCORE_INCIDENT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  let weightedCount = 0;
  let count = 0;
  for (const alert of alerts.values()) {
    if (alert.organizationId !== organizationId || alert.createdAt < cutoff) continue;
    if (!alert.location) continue;
    const dist = haversineDistance(coords.latitude, coords.longitude, alert.location.latitude, alert.location.longitude);
    if (dist > RISK_SCORE_SITE_RADIUS_METERS) continue;
    weightedCount += ALERT_SEVERITY_WEIGHT[alert.severity] || 1;
    count++;
  }
  const score = Math.min(100, weightedCount * 10);
  const detail = count === 0
    ? 'Aucun incident à proximité'
    : `${count} incident(s) à proximité sur ${RISK_SCORE_INCIDENT_LOOKBACK_DAYS} jours`;
  return { label: 'Incidents', weight: 0.35, score, detail };
}

function scorePatrolComplianceSignal(siteId: string): SiteRiskSignal {
  const reports = patrolReports
    .filter(r => r.siteId === siteId && r.checkpoints && r.checkpoints.length > 0)
    .slice(0, RISK_SCORE_PATROL_REPORT_SAMPLE);
  if (reports.length === 0) return { label: 'Couverture rondes', weight: 0.20, score: 0, detail: 'Pas encore de ronde GPS effectuée sur ce site' };
  let totalCheckpoints = 0, metCheckpoints = 0;
  for (const r of reports) {
    for (const cp of r.checkpoints!) {
      totalCheckpoints++;
      if (cp.dwellMet) metCheckpoints++;
    }
  }
  const complianceRate = totalCheckpoints > 0 ? metCheckpoints / totalCheckpoints : 1;
  const score = Math.round((1 - complianceRate) * 100);
  const detail = `${Math.round(complianceRate * 100)}% des checkpoints validés sur les ${reports.length} dernière(s) ronde(s)`;
  return { label: 'Couverture rondes', weight: 0.20, score, detail };
}

// Family-registered residences left unoccupied are a softer target — this
// signal is neutral (score 0) when the site isn't near any occupancy-tracked
// residence, so it never penalizes sites with nothing to report.
function scoreOccupancyStatusSignal(coords: { latitude: number; longitude: number }): SiteRiskSignal {
  const occupancy = findResidenceOccupancyForCoords(coords);
  if (occupancy === null) return { label: 'Occupation', weight: 0.20, score: 0, detail: 'Occupation non suivie pour ce site' };
  const score = occupancy === 'unoccupied' ? 80 : 10;
  const detail = occupancy === 'unoccupied' ? 'Résidence signalée inoccupée' : 'Résidence signalée occupée';
  return { label: 'Occupation', weight: 0.20, score, detail };
}

function computeSiteRiskScore(siteId: string, organizationId?: string): SiteRiskResult | null {
  const site = patrolSites.get(siteId);
  if (!site) return null;
  const coords = resolveSiteDestination(siteId);
  const signals: SiteRiskSignal[] = coords
    ? [scoreBlackbookProximitySignal(coords, organizationId), scoreIncidentHistorySignal(coords, organizationId), scorePatrolComplianceSignal(siteId), scoreOccupancyStatusSignal(coords)]
    : [scorePatrolComplianceSignal(siteId)]; // no address/checkpoints yet — compliance is all we can compute
  const totalWeight = signals.reduce((s, sig) => s + sig.weight, 0) || 1;
  const score = Math.round(signals.reduce((s, sig) => s + sig.score * sig.weight, 0) / totalWeight);
  const band: SiteRiskResult['band'] = score >= 75 ? 'critical' : score >= 50 ? 'high' : score >= 25 ? 'medium' : 'low';
  const rationale = coords
    ? signals.map(s => `${s.label} : ${s.detail}`).join(' · ')
    : `Site sans adresse configurée — score basé uniquement sur la couverture des rondes. ${signals[0].detail}`;
  return { siteId, siteName: site.name, score, band, signals, rationale, computedAt: Date.now() };
}

interface ScoredRouteCandidate {
  geometry: { latitude: number; longitude: number }[];
  distanceMeters: number;
  durationSeconds: number;
  overlapFraction: number;
  blackbookNearCount: number;
  blackbookMostRecentTimestamp?: number;
  score: number;
}

// The actual "intelligence": among the routing API's alternatives, prefer
// the one least similar to recently-taken paths to the same site (anti-
// routine) and least exposed to recent Blackbook sightings (security),
// without accepting more than a 25% time penalty for it.
function scoreRouteCandidates(
  candidates: { geometry: { latitude: number; longitude: number }[]; distanceMeters: number; durationSeconds: number }[],
  historyRows: { geometry: { latitude: number; longitude: number }[] }[],
  organizationId: string
): { best: ScoredRouteCandidate; rationale: string; alternativesConsidered: number } {
  const shortestDuration = Math.min(...candidates.map(c => c.durationSeconds));
  const historyGrids = historyRows.map(h => snapGeometryToGrid(h.geometry));

  const withinTimeBudget = candidates.filter(c => c.durationSeconds <= shortestDuration * ROUTE_DURATION_CAP_FACTOR);
  const scored: ScoredRouteCandidate[] = withinTimeBudget
    .map(c => {
      const grid = snapGeometryToGrid(c.geometry);
      const overlapFraction = historyGrids.length === 0 ? 0 : Math.max(...historyGrids.map(h => jaccardOverlap(grid, h)));
      const { count: blackbookNearCount, mostRecentTimestamp } = countBlackbookProximity(c.geometry, organizationId);
      const score = 0.6 * overlapFraction + 0.4 * Math.min(blackbookNearCount / 3, 1);
      return { ...c, overlapFraction, blackbookNearCount, blackbookMostRecentTimestamp: mostRecentTimestamp, score };
    })
    .sort((a, b) => a.score - b.score || a.durationSeconds - b.durationSeconds);

  const best = scored[0];
  let rationale: string;
  if (best.blackbookNearCount > 0) {
    const dateStr = best.blackbookMostRecentTimestamp
      ? new Date(best.blackbookMostRecentTimestamp).toLocaleDateString('fr-CH')
      : '';
    rationale = `⚠ Passe à proximité de ${best.blackbookNearCount} signalement(s) Blackbook${dateStr ? ` (dernier : ${dateStr})` : ''} — c'était le meilleur compromis parmi les itinéraires disponibles.`;
  } else if (historyGrids.length === 0) {
    rationale = 'Itinéraire le plus direct (aucun historique récent pour ce trajet).';
  } else if (best.overlapFraction < 0.35) {
    rationale = 'Itinéraire varié — peu ou pas emprunté récemment.';
  } else {
    rationale = 'Itinéraire recommandé (peu de variantes disponibles pour ce trajet).';
  }

  return { best, rationale, alternativesConsidered: candidates.length };
}

// Auto-clears an active navigation once the responder's position comes
// within ROUTE_ARRIVAL_RADIUS_METERS of the destination — reuses the
// existing location-ingestion pipeline, no client "I've arrived" call
// needed, same approach as checkActivePatrolRound.
function checkActiveResponderRoute(userId: string, location: { latitude: number; longitude: number }) {
  const route = activeResponderRoutes.get(userId);
  if (!route) return;
  const destination = resolveSiteDestination(route.toSiteId);
  if (!destination) return;
  const dist = haversineDistance(location.latitude, location.longitude, destination.latitude, destination.longitude);
  if (dist <= ROUTE_ARRIVAL_RADIUS_METERS) {
    activeResponderRoutes.delete(userId);
    const payload = { type: 'patrolRouteEnded', data: { responderId: userId, toSiteId: route.toSiteId } };
    broadcastToOrgRole(route.organizationId, 'dispatcher', payload);
    broadcastToOrgRole(route.organizationId, 'admin', payload);
    addAuditEntry('system', 'Navigation terminée', route.responderName, `Arrivée à "${route.toSiteName}"`, userId, route.organizationId);
  }
}

// ─── Real-time responder proximity to historical Blackbook activity ────
// IMPORTANT FRAMING: this alerts on one of OUR tracked staff (a responder
// on duty) entering a zone with RECENT HISTORICAL Blackbook activity. It
// is NOT live detection of a flagged person's current position — this
// system has no way to track a suspect's live location. Every message
// this produces must make that distinction explicit so it can never be
// misread as "the suspect is here right now."
interface NearbyBlackbookHit { entryId: string; name: string; riskLevel: string; distanceMeters: number; lastSightingAt: number; }
function findNearbyBlackbookEntries(location: { latitude: number; longitude: number }, organizationId?: string): NearbyBlackbookHit[] {
  const cutoff = Date.now() - RESPONDER_PROXIMITY_ALERT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const hits: NearbyBlackbookHit[] = [];
  for (const entry of blackbookEntries.values()) {
    if (entry.organizationId !== organizationId) continue;
    for (const s of entry.sightings) {
      if (s.timestamp < cutoff || s.location?.latitude === undefined || s.location?.longitude === undefined) continue;
      const dist = haversineDistance(location.latitude, location.longitude, s.location.latitude, s.location.longitude);
      if (dist <= RESPONDER_PROXIMITY_ALERT_RADIUS_METERS) {
        hits.push({ entryId: entry.id, name: `${entry.firstName} ${entry.lastName}`.trim(), riskLevel: entry.riskLevel, distanceMeters: Math.round(dist), lastSightingAt: s.timestamp });
        break; // one hit per entry is enough
      }
    }
  }
  return hits;
}

// Fire-once-per-episode dedup, mirrors perimeterState's enter/exit toggle:
// key is `${responderId}:${entryId}`, set on entry, cleared once no longer
// nearby (no exit alert needed — this is a heads-up, not a breach).
const responderBlackbookProximityState = new Map<string, boolean>();

// Same "à l'instant / il y a Xmin / il y a Xh / il y a Xj" convention
// already used client-side (patrol.tsx's formatRelativeTime) — "il y a 0j"
// for a sighting from minutes ago reads as a bug, not a feature.
function formatRelativeTimeFr(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours}h`;
  return `il y a ${Math.floor(hours / 24)}j`;
}

function notifyResponderBlackbookProximity(responderId: string, hit: NearbyBlackbookHit, organizationId?: string) {
  const responderName = adminUsers.get(responderId)?.name || responderId;
  // Risk-level icon (not a generic 📍) so the notification itself signals
  // severity at a glance, matching the color/emoji convention already used
  // for risk badges everywhere else in the app (BLACKBOOK_RISK_LABELS).
  const riskIcon = hit.riskLevel === 'critical' ? '🔴' : hit.riskLevel === 'high' ? '🟠' : hit.riskLevel === 'medium' ? '🟡' : '🟢';
  const title = `${riskIcon} Zone à activité Blackbook connue`;
  const body = `${responderName} est entré(e) dans une zone où "${hit.name}" (risque ${hit.riskLevel}) a été signalé à ${hit.distanceMeters}m, ${formatRelativeTimeFr(hit.lastSightingAt)}. Ceci ne signifie PAS que cette personne est détectée en ce moment.`;
  addAuditEntry('system', 'Blackbook - proximité responder', responderName, body, responderId, organizationId);
  const payload = { type: 'responderBlackbookProximityAlert', data: { responderId, responderName, entryId: hit.entryId, name: hit.name, riskLevel: hit.riskLevel, distanceMeters: hit.distanceMeters, title, body } };
  broadcastToOrgRole(organizationId, 'dispatcher', payload);
  broadcastToOrgRole(organizationId, 'admin', payload);
  const notified = new Set<string>();
  for (const [, entry] of pushTokens) {
    if ((entry.userRole === 'dispatcher' || entry.userRole === 'admin' || entry.userRole === 'superadmin') && !notified.has(entry.userId)) {
      if (!canAccessOrg({ role: entry.userRole, organizationId: adminUsers.get(entry.userId)?.organizationId }, organizationId)) continue;
      notified.add(entry.userId);
      sendPushToUser(entry.userId, title, body, { type: 'blackbook_proximity', entryId: hit.entryId }).catch(() => {});
    }
  }
}

function checkResponderBlackbookProximity(responderId: string, location: { latitude: number; longitude: number }, organizationId?: string) {
  const nearby = findNearbyBlackbookEntries(location, organizationId);
  const nearbyIds = new Set(nearby.map(h => h.entryId));
  for (const hit of nearby) {
    const key = `${responderId}:${hit.entryId}`;
    if (responderBlackbookProximityState.get(key)) continue; // already alerted, still inside
    responderBlackbookProximityState.set(key, true);
    notifyResponderBlackbookProximity(responderId, hit, organizationId);
  }
  for (const key of responderBlackbookProximityState.keys()) {
    if (!key.startsWith(`${responderId}:`)) continue;
    const entryId = key.slice(responderId.length + 1);
    if (!nearbyIds.has(entryId)) responderBlackbookProximityState.delete(key);
  }
}

// Track which users are actively sharing location
const sharingUsers = new Set<string>();
const LOCATION_TTL_MS = 30000; // 30 seconds without update = stale

// ─── Family Location Helpers ─────────────────────────────────────────────
// Get family member IDs for a user (parent, child, sibling, spouse)
function getFamilyMemberIds(userId: string): string[] {
  const adminUser = adminUsers.get(userId);
  if (!adminUser || !adminUser.relationships) return [];
  const familyTypes = ['parent', 'child', 'sibling', 'spouse'];
  return adminUser.relationships
    .filter(r => familyTypes.includes(r.type))
    .map(r => r.userId);
}

// "Parent" means someone at least one family member has an explicit
// 'parent'-type relationship pointing to — i.e. an actual parent of a child
// in this family unit, not just "not a child" (a family with no children
// would have none, which is correct: there's no one to shield notifications
// from either). Used to restrict presence-transition notifications to
// adults only — children must never receive these, about themselves or
// anyone else in the family.
function getFamilyParentIds(userId: string): string[] {
  const groupIds = [userId, ...getFamilyMemberIds(userId)];
  const parentIds = new Set<string>();
  for (const memberId of groupIds) {
    for (const r of (adminUsers.get(memberId)?.relationships || [])) {
      if (r.type === 'parent') parentIds.add(r.userId);
    }
  }
  return Array.from(parentIds);
}

// ─── Presence status (in/out of a known residence) ───────────────────────
// Automatic: computed live from the user's last known location against
// every address on their profile (home, secondary residence, hotel while
// travelling, etc. — anything in userAddresses). Never cached — always
// derived from the current `users` location on request.
// Manual: an explicit override the target, a family owner, or dispatch
// staff can set at any time; it's what dispatch sees in place of the
// automatic value while the target is in Ghost mode (family always sees
// the automatic value regardless of Ghost — Ghost only hides from dispatch).
// (PresenceManualStatus + manualPresence are declared earlier, alongside the
// other storage maps, so the boot-time persisted-data loader can use them.)

function computeAutoPresence(userId: string): { status: 'inside' | 'outside' | 'unknown'; matchedLabel?: string; since?: number } {
  const loc = users.get(userId)?.location;
  const now = Date.now();
  // Expired temporary addresses (e.g. a vacation rental past its end date) no
  // longer count — they stay on file for reference but drop out of matching.
  const addresses = (userAddresses.get(userId) || []).filter(a => !a.temporary || !a.expiresAt || a.expiresAt > now);
  const prevState = autoPresenceState.get(userId);

  let result: { status: 'inside' | 'outside' | 'unknown'; matchedLabel?: string };
  if (!loc || addresses.length === 0) {
    // No live location yet — e.g. right after a server restart, before this
    // user's phone has sent its next GPS ping (the `users` runtime map is
    // never persisted, by design — only this last-confirmed state is).
    // Keep showing the last confirmed status instead of dropping to
    // "unknown", which used to erase a perfectly good known status on every
    // restart even though the persisted state was right there.
    result = prevState && (prevState.status === 'inside' || prevState.status === 'outside')
      ? { status: prevState.status, matchedLabel: prevState.label }
      : { status: 'unknown' };
  } else {
    let matched: typeof addresses[number] | undefined;
    for (const addr of addresses) {
      if (addr.latitude == null || addr.longitude == null) continue;
      const dist = haversineDistance(loc.latitude, loc.longitude, addr.latitude, addr.longitude);
      if (dist <= (addr.radiusMeters || 150)) { matched = addr; break; }
    }
    if (matched) {
      result = { status: 'inside', matchedLabel: matched.label };
    } else {
      // Outside every known address — still surface the last one they were
      // confirmed at (persisted across restarts), so dispatch sees "Sorti de
      // X" instead of just "Sorti".
      result = { status: 'outside', matchedLabel: prevState?.label };
    }
  }

  const since = applyAutoPresenceResult(userId, result, prevState);
  return { ...result, since };
}

// Shared by computeAutoPresence (GPS-based, lazy on read) and the geofence-event
// route (background enter/exit callback, works even with the app fully closed
// as long as iOS/Android haven't had the app force-quit by the user) — both
// arrive at the same { status, matchedLabel } shape and need identical
// transition-tracking/persistence/notification handling.
function applyAutoPresenceResult(
  userId: string,
  result: { status: 'inside' | 'outside' | 'unknown'; matchedLabel?: string },
  prevState: AutoPresenceState | undefined,
): number {
  const now = Date.now();
  // Track when this exact (status, place) combination started, so the
  // display can say "depuis HH:mm" rather than just describing "right now".
  // Only persist on an actual transition — this runs far more often than the
  // state actually changes (every GPS fetch, or every geofence callback).
  const changed = !prevState || prevState.status !== result.status || prevState.label !== result.matchedLabel;
  const since = changed ? now : prevState!.since;
  autoPresenceState.set(userId, { status: result.status, label: result.matchedLabel, since });
  if (changed) persistAutoPresenceState();

  // Notify only on a real entry/exit — i.e. a determinate status that flips
  // to the other determinate status. A first-ever reading (prevState absent,
  // right after boot or a freshly-added address) or a drop into 'unknown'
  // (GPS lost) isn't itself an "entered/left" event worth paging staff for.
  if (changed && prevState && (prevState.status === 'inside' || prevState.status === 'outside') &&
      (result.status === 'inside' || result.status === 'outside') && prevState.status !== result.status) {
    notifyPresenceTransition(userId, result.status, result.matchedLabel, since);
  }
  return since;
}

// Tell dispatch/responder/admin (web + mobile) and the target's family whenever
// someone's inside/outside status flips — live WS for open consoles/app, plus a
// push notification for staff AND family (this is what actually reaches anyone
// whose app is backgrounded or closed — the WS message alone doesn't). Uses
// whichever registered address was actually matched, unlike the single
// manually-configured FamilyPerimeter (checkFamilyPerimeters), which always
// names the one fixed point it was set up against regardless of where the
// person actually is — that's what previously made "left the perimeter"
// notifications confusing while traveling.
function notifyPresenceTransition(userId: string, status: 'inside' | 'outside', matchedLabel: string | undefined, setAt: number, excludeStaffId?: string) {
  const name = adminUsers.get(userId)?.name || userId;
  const payload = { type: 'presenceUpdated', targetUserId: userId, name, status, matchedLabel, setBy: 'auto', setAt };
  // Parents only, never children — whether the transition is the child's own
  // movement or a parent's, per explicit request after a child received one
  // of these during testing.
  const parentIds = getFamilyParentIds(userId).filter(id => id !== userId);
  // Live status (WS) updates immediately — it's just a silent indicator, no
  // harm if it flickers momentarily. The push is what's actually disruptive
  // (a popup per bounce), so it's debounced separately below.
  const presenceOrgId = adminUsers.get(userId)?.organizationId;
  broadcastToOrgRole(presenceOrgId, 'dispatcher', payload);
  broadcastToOrgRole(presenceOrgId, 'admin', payload);
  broadcastToOrgRole(presenceOrgId, 'responder', payload);
  broadcastToUsers(parentIds, payload);
  schedulePresenceChangePush(userId, name, status, matchedLabel, excludeStaffId, parentIds, presenceOrgId);
}

// GPS readings right at a geofence boundary (arriving/leaving a gate, a large
// property) commonly jitter in/out for a short stretch — each bounce is a
// genuine inside<->outside transition, so without this, notifyPresenceTransition
// above would fire (and push) once per bounce: "sorti", "rentré", "sorti"...
// in quick succession. Wait out a settling window and only push if the
// status is still the same one that triggered this call once it elapses —
// a bounce that flips back within the window never reaches a real push.
const pendingPresencePush = new Map<string, ReturnType<typeof setTimeout>>();
const PRESENCE_PUSH_DEBOUNCE_MS = 90000;

function schedulePresenceChangePush(userId: string, name: string, status: 'inside' | 'outside', matchedLabel: string | undefined, excludeStaffId: string | undefined, parentIds: string[], organizationId: string | undefined) {
  const existing = pendingPresencePush.get(userId);
  if (existing) clearTimeout(existing);
  pendingPresencePush.set(userId, setTimeout(() => {
    pendingPresencePush.delete(userId);
    const current = autoPresenceState.get(userId);
    if (current && current.status === status && current.label === matchedLabel) {
      notifyPresenceChangePush(name, status, matchedLabel, excludeStaffId, parentIds, organizationId).catch(() => {});
    }
  }, PRESENCE_PUSH_DEBOUNCE_MS));
}

async function notifyPresenceChangePush(name: string, status: 'inside' | 'outside', matchedLabel: string | undefined, excludeUserId: string | undefined, familyMemberIds: string[], organizationId: string | undefined) {
  const targetTokens: string[] = [];
  for (const [token, entry] of pushTokens) {
    const isStaff = (entry.userRole === 'dispatcher' || entry.userRole === 'responder' || entry.userRole === 'admin') && adminUsers.get(entry.userId)?.organizationId === organizationId;
    const isFamilyMember = familyMemberIds.includes(entry.userId);
    if ((isStaff || isFamilyMember) && entry.userId !== excludeUserId) {
      targetTokens.push(token);
    }
  }
  if (targetTokens.length === 0) return;
  const emoji = status === 'inside' ? '\u{1F3E0}' : '\u{1F6B6}';
  const title = status === 'inside' ? `${emoji} ${name} est rentré(e)` : `${emoji} ${name} est sorti(e)`;
  const body = matchedLabel ? (status === 'inside' ? `Arrivé(e) à ${matchedLabel}` : `A quitté ${matchedLabel}`) : '';
  const messages = targetTokens.map((token) => ({
    to: token, sound: 'default', title, body,
    data: { type: 'presence_change', status },
    priority: 'normal' as const, channelId: 'family-alerts',
  }));
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!response.ok) console.error(`[Push] Expo API error for presence change: ${response.status}`);
  } catch (err) { console.error('[Push] Failed to send presence change push:', err); }
}

// forDispatch=true applies the Ghost-mode rule; family-facing callers should
// pass false to always get the live automatic value.
function computeEffectivePresence(userId: string, forDispatch: boolean): {
  status: 'inside' | 'outside' | 'unknown';
  source: 'auto' | 'manual';
  matchedLabel?: string;
  setBy?: string;
  setAt?: number;
} {
  if (forDispatch) {
    // A manual entry is an explicit human declaration (self, family, or
    // dispatch/admin/responder) — it always wins over the live automatic
    // computation once set, regardless of Ghost mode, until it's changed
    // again or explicitly cleared back to automatic.
    const manual = manualPresence.get(userId);
    if (manual) {
      // 'inside' names the specific place picked when it was set; 'outside'
      // has no place of its own — show the last place they were confirmed
      // at (from either a prior manual 'inside' or the automatic system),
      // so "Sorti" always reads as "Sorti de X" with the change's timestamp.
      const matchedLabel = manual.status === 'inside' ? manual.placeLabel : autoPresenceState.get(userId)?.label;
      return { status: manual.status, source: 'manual', matchedLabel, setBy: manual.setBy, setAt: manual.setAt };
    }
    // No manual override on file: respect Ghost mode by not surfacing the
    // live automatic value to dispatch.
    if (adminUsers.get(userId)?.ghostMode) {
      return { status: 'unknown', source: 'auto' };
    }
  }
  const auto = computeAutoPresence(userId);
  return { status: auto.status, source: 'auto', matchedLabel: auto.matchedLabel, setAt: auto.since };
}

// Connected components over the parent/child/sibling/spouse relationship
// graph across ALL admin users — a "family group" for the dispatch overview,
// not scoped to any single owner's perspective.
function computeFamilyGroups(): string[][] {
  const familyTypes = ['parent', 'child', 'sibling', 'spouse'];
  const visited = new Set<string>();
  const groups: string[][] = [];
  for (const user of adminUsers.values()) {
    if (visited.has(user.id) || !user.relationships?.some(r => familyTypes.includes(r.type))) continue;
    const stack = [user.id];
    const group = new Set<string>();
    while (stack.length) {
      const id = stack.pop()!;
      if (group.has(id)) continue;
      group.add(id);
      visited.add(id);
      (adminUsers.get(id)?.relationships || [])
        .filter(r => familyTypes.includes(r.type))
        .forEach(r => { if (!group.has(r.userId)) stack.push(r.userId); });
    }
    groups.push(Array.from(group));
  }
  return groups;
}

// A stable id for a user's family group, derived from its members (the
// lexicographically-smallest member id) rather than stored separately —
// no persisted "Family" entity exists in this codebase, this is deliberately
// reused instead of inventing one (see canAccessFamily below for the access-
// control feature this also feeds). Unlike getFamilyChannelId, this always
// returns an id, even for a lone individual with no linked relationships —
// a "family of one" can still be assigned to a dispatcher for access
// control, even though it doesn't need its own PTT channel.
function getFamilyGroupId(userId: string): string {
  const groups = computeFamilyGroups();
  const group = groups.find(g => g.includes(userId));
  if (!group || group.length < 2) return `family-${userId}`;
  return `family-${[...group].sort()[0]}`;
}

// ─── PTT channel access (family/staff/group model) ─────────────────────
// A stable id for a family's PTT channel — same derivation as
// getFamilyGroupId, but null for a lone individual since a "family" of one
// doesn't need a channel (unlike access-control assignment, which does still
// apply to single-person families).
function getFamilyChannelId(userId: string): string | null {
  const groups = computeFamilyGroups();
  const group = groups.find(g => g.includes(userId));
  if (!group || group.length < 2) return null;
  return getFamilyGroupId(userId);
}

// ─── Access control by family assignment (point 4, "think like Palantir") ──
// Break-glass emergency override: a dispatcher/responder can temporarily
// bypass their own family-assignment restriction for a fixed window, always
// logged. Incidents/alerts are NEVER gated by this — see canAccessFamily,
// which this only affects for the "calm" views (families/blackbook/visits/
// known people/live map) it's actually applied to.
interface EmergencyOverride { enabledAt: number; expiresAt: number; reason?: string; }
const emergencyOverrides = new Map<string, EmergencyOverride>();
const EMERGENCY_OVERRIDE_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

function hasActiveEmergencyOverride(userId: string): boolean {
  const entry = emergencyOverrides.get(userId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { emergencyOverrides.delete(userId); return false; }
  return true;
}

// The single gate used by every Phase-1 "calm view" route: can this caller
// see data belonging to targetUserId? Admins are never restricted (they're
// the ones defining assignments); an empty/absent assignedFamilyIds means
// "sees everything" (the safe default until an admin explicitly restricts
// someone) - only a caller with a NON-empty assignedFamilyIds is actually
// scoped down to those specific family groups.
function canAccessFamily(caller: { id: string; role: string; assignedFamilyIds?: string[] }, targetUserId: string): boolean {
  if (caller.role === 'admin') return true;
  if (hasActiveEmergencyOverride(caller.id)) return true;
  if (!caller.assignedFamilyIds || caller.assignedFamilyIds.length === 0) return true;
  return caller.assignedFamilyIds.includes(getFamilyGroupId(targetUserId));
}

// ─── Multi-tenant isolation (organization scoping) ───────────────────────
// Deliberately fail-closed, unlike canAccessFamily above: a missing
// organizationId on either side means "deny", never "sees everything".
// superadmin (Talion staff, no organizationId of their own) is the only
// cross-organization role. This is a hard partition layered ON TOP of
// canAccessFamily, not a replacement for it — see canAccessUser.
function canAccessOrg(caller: { role: string; organizationId?: string }, targetOrgId?: string): boolean {
  if (caller.role === 'superadmin') return true;
  if (!caller.organizationId || !targetOrgId) return false;
  return caller.organizationId === targetOrgId;
}

// Combined gate: organization boundary first (hard, no exceptions besides
// superadmin), then the existing family-assignment restriction within that
// organization. Replaces canAccessFamily at every call site that guards
// access to another user's data.
function canAccessUser(caller: { id: string; role: string; organizationId?: string; assignedFamilyIds?: string[] }, targetUserId: string): boolean {
  const targetOrgId = adminUsers.get(targetUserId)?.organizationId;
  return canAccessOrg(caller, targetOrgId) && canAccessFamily(caller, targetUserId);
}

// Gate for owner-created family safety records (perimeters, curfew checks)
// that only their own owner may read/write — organization boundary first,
// then strict ownership (unlike canAccessUser, staff never gets a bypass
// here, these are self-service records, not calm-view data staff reads).
function canAccessOwnedRecord(record: { ownerId: string }, caller: { id: string; role: string; organizationId?: string }): boolean {
  if (!canAccessOrg(caller, adminUsers.get(record.ownerId)?.organizationId)) return false;
  return caller.id === record.ownerId;
}

// Organization boundary first, hard, no exceptions. Within it: staff
// (dispatcher/admin/superadmin) sees every conversation in their own
// organization — matches the existing behavior of always relaying every
// message to dispatch/admin for oversight, just no longer crossing the
// organization boundary to do it. A non-staff caller must actually be a
// participant (explicit or resolved via role/tag filters).
function canAccessConversation(conv: Conversation, caller: { id: string; role: string; organizationId?: string }): boolean {
  if (!canAccessOrg(caller, conv.organizationId)) return false;
  if (caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'superadmin') return true;
  return conv.participantIds.includes(caller.id) || resolveGroupParticipants(conv, conv.organizationId).includes(caller.id);
}

// Shared gate for the /api/family/* "calm view" data (locations, members,
// proximity alerts, location history, check-ins): the target themselves,
// any of their family members, or staff of the target's own organization.
function canAccessFamilyMemberData(targetUserId: string, caller: { id: string; role: string; organizationId?: string }): boolean {
  if (caller.id === targetUserId) return true;
  if (getFamilyMemberIds(targetUserId).includes(caller.id)) return true;
  const isStaff = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder' || caller.role === 'superadmin';
  return isStaff && canAccessOrg(caller, adminUsers.get(targetUserId)?.organizationId);
}

// Family-facing location-sharing consent check: on by default, can be turned
// off permanently (shareLocationWithFamily === false), or temporarily
// re-enabled for a bounded window (shareLocationUntil in the future) even
// while off — e.g. "share for the next 2h while I'm out with friends".
function sharesLocationWithFamily(adminUser?: { shareLocationWithFamily?: boolean; shareLocationUntil?: number }): boolean {
  if (adminUser?.shareLocationWithFamily !== false) return true;
  return (adminUser.shareLocationUntil ?? 0) > Date.now();
}

// True iff callerId is recorded as a 'parent' on targetUserId's own
// relationships (i.e. targetUserId considers callerId their parent) — the
// gate for parent-only controls over a child/teen's account: simplified-UI
// profile, and (for 'ado') their base location-sharing toggle.
function isParentOf(callerId: string, targetUserId: string): boolean {
  const target = adminUsers.get(targetUserId);
  return !!target?.relationships?.some(r => r.userId === callerId && r.type === 'parent');
}

// POST /api/access/emergency-override — break-glass: temporarily lifts the
// caller's own family-assignment restriction (never affects incidents/alerts,
// which are already unrestricted for everyone). Every enable/disable is
// logged via addAuditEntry - not each individual read made during the
// window, which would flood the audit log without adding real accountability
// value (the standard "break-glass" convention: log the grant, not every use).
app.post('/api/access/emergency-override', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const isStaff = caller.role === 'dispatcher' || caller.role === 'responder' || caller.role === 'admin';
  if (!isStaff) return res.status(403).json({ error: 'Staff only' });
  const { enable, reason } = req.body;
  const callerName = adminUsers.get(caller.id)?.name || caller.id;

  if (enable) {
    const entry: EmergencyOverride = { enabledAt: Date.now(), expiresAt: Date.now() + EMERGENCY_OVERRIDE_DURATION_MS, reason: reason || undefined };
    emergencyOverrides.set(caller.id, entry);
    addAuditEntry('access_override', 'Accès d\'urgence activé', callerName, reason || '(aucune raison fournie)', undefined, caller.organizationId);
    return res.json({ success: true, expiresAt: entry.expiresAt });
  } else {
    emergencyOverrides.delete(caller.id);
    addAuditEntry('access_override', 'Accès d\'urgence désactivé', callerName, reason || '', undefined, caller.organizationId);
    return res.json({ success: true });
  }
});

// GET /api/access/emergency-override — the caller's own current override
// status, so console/app can render the persistent banner correctly on load.
app.get('/api/access/emergency-override', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const entry = emergencyOverrides.get(caller.id);
  const active = !!entry && hasActiveEmergencyOverride(caller.id);
  res.json({ active, expiresAt: active ? entry!.expiresAt : undefined });
});

// Auto-provisions the caller's family channel the first time it's needed
// (e.g. when listing channels) rather than requiring dispatch/admin to set
// it up — every family gets one automatically, membership is exactly the
// family group, and it's re-synced (name/members) on every call in case
// relationships changed since it was first created.
function ensureFamilyChannel(userId: string): PTTChannelServer | null {
  const channelId = getFamilyChannelId(userId);
  if (!channelId) return null;
  const groups = computeFamilyGroups();
  const group = groups.find(g => g.includes(userId))!;
  const memberNames = group.map(id => adminUsers.get(id)?.name || id);
  let channel = pttChannels.find(c => c.id === channelId);
  if (!channel) {
    channel = {
      id: channelId, name: `Famille ${memberNames[0]}`, description: 'Canal familial (privé)',
      allowedRoles: ['user', 'responder', 'dispatcher', 'admin', 'superadmin'], isActive: true, isDefault: false,
      createdBy: 'system', createdAt: Date.now(), members: group,
      organizationId: adminUsers.get(userId)?.organizationId,
    };
    pttChannels.push(channel);
    persistPTTChannels();
  } else if (JSON.stringify([...channel.members || []].sort()) !== JSON.stringify([...group].sort())) {
    // Family membership changed (relationship added/removed) — keep it in sync.
    channel.members = group;
    persistPTTChannels();
  }
  return channel;
}

// Single source of truth for "can this user join/see this channel" — used by
// both the channel list and the LiveKit token issuance, so a client can never
// get a working token for a room the list wouldn't have shown them anyway.
function canJoinPTTChannel(userId: string, role: string, channel: PTTChannelServer): boolean {
  if (role === 'admin') return true;
  if (!channel.allowedRoles.includes(role as any)) return false;
  if (channel.members && channel.members.length > 0) return channel.members.includes(userId);
  return true;
}

function persistManualPresence() {
  debouncedSave(PRESENCE_FILE, Array.from(manualPresence.entries()).map(([targetUserId, p]) => ({ targetUserId, ...p })));
  manualPresence.forEach((p, targetUserId) => saveManualPresenceToSupabase(targetUserId, p));
}

function persistAutoPresenceState() {
  debouncedSave(AUTO_PRESENCE_FILE, Array.from(autoPresenceState.entries()).map(([userId, p]) => ({ userId, ...p })));
  autoPresenceState.forEach((p, userId) => saveAutoPresenceStateToSupabase(userId, p));
}

// ─── Duplicate incident detection ────────────────────────────────────────
// Same real-world event reported more than once — most often several family
// members each hitting SOS/reporting the same break-in, fire, etc. Never
// auto-merges or changes status; only surfaces a confidence-tiered suggestion
// for the dispatcher to confirm (link) or dismiss.
const DUPLICATE_TIME_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const DUPLICATE_DISTANCE_METERS = 300;

function findPossibleDuplicates(alert: Alert): { id: string; confidence: 'same-reporter' | 'family' | 'proximity' }[] {
  if (!alert.location) return [];
  const reporterId = alert.reporterId || alert.createdBy;
  const reporterFamilyIds = new Set(getFamilyMemberIds(reporterId));
  const matches: { id: string; confidence: 'same-reporter' | 'family' | 'proximity' }[] = [];
  for (const other of alerts.values()) {
    if (other.id === alert.id) continue;
    if (other.organizationId !== alert.organizationId) continue;
    if (other.status === 'resolved' || other.status === 'cancelled') continue;
    if (!other.location) continue;
    if (Math.abs(other.createdAt - alert.createdAt) > DUPLICATE_TIME_WINDOW_MS) continue;
    const dist = haversineDistance(alert.location.latitude, alert.location.longitude, other.location.latitude, other.location.longitude);
    if (dist > DUPLICATE_DISTANCE_METERS) continue;
    const otherReporterId = other.reporterId || other.createdBy;
    let confidence: 'same-reporter' | 'family' | 'proximity';
    if (otherReporterId === reporterId) confidence = 'same-reporter';
    else if (reporterFamilyIds.has(otherReporterId)) confidence = 'family';
    else confidence = 'proximity';
    matches.push({ id: other.id, confidence });
  }
  return matches;
}

// Computes matches for a newly created alert and retroactively updates the
// matched (already-existing) alerts too, since they don't yet know about this
// new one. Caller is responsible for persistAlerts() afterwards.
function linkPossibleDuplicates(alert: Alert): void {
  const matches = findPossibleDuplicates(alert);
  if (matches.length === 0) return;
  alert.possibleDuplicates = matches;
  for (const match of matches) {
    const other = alerts.get(match.id);
    if (!other) continue;
    other.possibleDuplicates = other.possibleDuplicates || [];
    if (!other.possibleDuplicates.some(d => d.id === alert.id)) {
      other.possibleDuplicates.push({ id: alert.id, confidence: match.confidence });
      alerts.set(other.id, other);
      saveAlertToSupabase(other).catch(e => console.error('[LinkDuplicates] Supabase save error:', e));
      broadcastToOrg(other.organizationId, { type: 'alertUpdate', data: { ...other, respondingNames: (other.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
    }
  }
}

// Broadcast a message to specific user IDs (for family location sharing)
function broadcastToUsers(userIds: string[], message: any) {
  const data = JSON.stringify(message);
  userIds.forEach(uid => {
    const connections = userConnections.get(uid);
    if (connections) {
      connections.forEach(client => {
        if (client.readyState === 1) { client.send(data); }
      });
    }
  });
}

// Check family perimeters for a given user's location update
function checkFamilyPerimeters(userId: string, locationData: any) {
  if (!locationData?.latitude || !locationData?.longitude) return;

  // Find all active perimeters where this user is the target
  for (const [pId, perimeter] of familyPerimeters) {
    if (!perimeter.active || perimeter.targetUserId !== userId) continue;

    const dist = haversineDistance(
      perimeter.center.latitude, perimeter.center.longitude,
      locationData.latitude, locationData.longitude
    );
    const isOutside = dist > perimeter.radiusMeters;
    const wasOutside = perimeterState.get(pId) || false;

    if (isOutside && !wasOutside) {
      // EXIT: target just left the perimeter
      perimeterState.set(pId, true);
      const alert: ProximityAlert = {
        id: uuidv4(),
        perimeterId: pId,
        targetUserId: userId,
        targetUserName: perimeter.targetUserName,
        ownerId: perimeter.ownerId,
        eventType: 'exit',
        distanceMeters: Math.round(dist),
        location: { latitude: locationData.latitude, longitude: locationData.longitude },
        timestamp: Date.now(),
        acknowledged: false,
      };
      proximityAlerts.unshift(alert);
      // Keep only last 500 proximity alerts
      if (proximityAlerts.length > 500) proximityAlerts.length = 500;
      persistProximityAlerts();

      // Notify the perimeter owner via WebSocket
      broadcastToUsers([perimeter.ownerId], {
        type: 'proximityAlert',
        data: alert,
      });

      // Send push notification to the owner
      sendProximityPush(perimeter.ownerId, alert, perimeter);

      console.log(`[Proximity] ${perimeter.targetUserName} LEFT perimeter ${pId} (${Math.round(dist)}m from center, radius ${perimeter.radiusMeters}m)`);
    } else if (!isOutside && wasOutside) {
      // ENTRY: target returned inside the perimeter
      perimeterState.set(pId, false);
      const alert: ProximityAlert = {
        id: uuidv4(),
        perimeterId: pId,
        targetUserId: userId,
        targetUserName: perimeter.targetUserName,
        ownerId: perimeter.ownerId,
        eventType: 'entry',
        distanceMeters: Math.round(dist),
        location: { latitude: locationData.latitude, longitude: locationData.longitude },
        timestamp: Date.now(),
        acknowledged: false,
      };
      proximityAlerts.unshift(alert);
      if (proximityAlerts.length > 500) proximityAlerts.length = 500;
      persistProximityAlerts();

      broadcastToUsers([perimeter.ownerId], {
        type: 'proximityAlert',
        data: alert,
      });

      // sendProximityPush already fully supports the 'entry' case (its own
      // ternaries branch on alert.eventType) - it was just never called here,
      // unlike the exit branch above. The WS broadcast alone only reaches an
      // app that's open with a live connection, so this is why "retour dans
      // le périmètre" notifications were silently missing while "sortie"
      // ones worked fine.
      sendProximityPush(perimeter.ownerId, alert, perimeter);

      console.log(`[Proximity] ${perimeter.targetUserName} RETURNED to perimeter ${pId}`);
    }
  }
}

// Minimum time a reading must persist before it's treated as a confirmed
// on_route/off_route state — requires 2 consecutive readings roughly this far
// apart before a deviation fires, so a single noisy GPS ping never triggers a
// security escalation on its own.
const SCHOOL_ROUTE_CONFIRM_MS = 30 * 1000;

function checkSchoolRouteDeviation(userId: string, locationData: any) {
  if (!locationData?.latitude || !locationData?.longitude) return;
  const routes = schoolRoutes.get(userId) || [];
  if (routes.length === 0) return;
  const now = new Date();

  for (const route of routes) {
    if (!route.active) continue;
    if (!isWithinCommuteWindow(route.commuteWindows, now)) continue; // time-window gate

    const dist = distanceToPolylineMeters({ latitude: locationData.latitude, longitude: locationData.longitude }, route.geometry);
    const currentReading: 'on_route' | 'off_route' = dist > route.corridorMeters ? 'off_route' : 'on_route';
    const prev = schoolRouteState.get(route.id);

    if (!prev || prev.state !== currentReading) {
      // Reading changed (or first ever reading for this route) — start a
      // fresh, not-yet-confirmed streak.
      schoolRouteState.set(route.id, { state: currentReading, since: Date.now(), confirmed: false });
      continue;
    }
    if (prev.confirmed || Date.now() - prev.since < SCHOOL_ROUTE_CONFIRM_MS) continue;

    prev.confirmed = true;
    if (currentReading !== 'off_route') continue; // confirmed back on route — no alert needed, just update state above

    const alert: ProximityAlert = {
      id: uuidv4(),
      perimeterId: route.id,
      targetUserId: userId,
      targetUserName: route.targetUserName,
      ownerId: route.ownerId,
      eventType: 'route_deviation',
      distanceMeters: Math.round(dist),
      location: { latitude: locationData.latitude, longitude: locationData.longitude },
      timestamp: Date.now(),
      acknowledged: false,
    };
    proximityAlerts.unshift(alert);
    if (proximityAlerts.length > 500) proximityAlerts.length = 500;
    persistProximityAlerts();

    broadcastToUsers([route.ownerId], { type: 'proximityAlert', data: alert });

    const parentIds = getFamilyParentIds(userId).filter(id => id !== userId);
    const notifyIds = Array.from(new Set([route.ownerId, ...parentIds]));
    sendFamilyPush(notifyIds, '🚸 Écart de trajet détecté',
      `${route.targetUserName} s'est écarté(e) du trajet habituel vers ${route.schoolLabel}.`,
      { type: 'route_deviation', routeId: route.id, alertId: alert.id }, { priority: 'high' }).catch(() => {});

    console.log(`[SchoolRoute] ${route.targetUserName} deviated from route ${route.id} (${Math.round(dist)}m from corridor, tolerance ${route.corridorMeters}m)`);
  }
}

// Send push notification for proximity alert
async function sendProximityPush(ownerId: string, alert: ProximityAlert, perimeter: FamilyPerimeter) {
  const targetTokens: string[] = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userId === ownerId) targetTokens.push(token);
  }
  if (targetTokens.length === 0) return;

  const emoji = alert.eventType === 'exit' ? '\u{26A0}\u{FE0F}' : '\u{2705}';
  const action = alert.eventType === 'exit' ? 'a quitt\u00e9' : 'est revenu(e) dans';
  const messages = targetTokens.map(token => ({
    to: token,
    sound: 'default',
    title: `${emoji} Alerte de proximit\u00e9`,
    body: `${alert.targetUserName} ${action} le p\u00e9rim\u00e8tre (${Math.round(alert.distanceMeters)}m${perimeter.center.address ? ' - ' + perimeter.center.address : ''})`,
    data: { type: 'proximity', alertId: alert.id, perimeterId: perimeter.id },
    priority: alert.eventType === 'exit' ? 'high' : 'normal',
    channelId: 'family-alerts',
  }));

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (e) { console.error('[Proximity Push] Error:', e); }
}

// Generic family-facing push helper — same shape as sendProximityPush but
// for any (title, body, data) rather than one hardcoded proximity-alert
// message, so new family features don't each hand-roll their own Expo-push
// call. channelId:'family-alerts' throughout (distinct from staff's
// 'incident-updates'/'sos-alerts'), matching the existing convention.
async function sendFamilyPush(userIds: string[], title: string, body: string, data: Record<string, any> = {}, opts?: { priority?: 'normal' | 'high' }) {
  const targetTokens: string[] = [];
  const idSet = new Set(userIds);
  for (const [token, entry] of pushTokens) {
    if (idSet.has(entry.userId)) targetTokens.push(token);
  }
  if (targetTokens.length === 0) return;
  const messages = targetTokens.map(token => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
    priority: opts?.priority || 'normal',
    channelId: 'family-alerts',
  }));
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (e) { console.error('[Family Push] Error:', e); }
}

// ─── Curfew Checks ──────────────────────────────────────────────────────
// One-off or daily "alert me if this person hasn't arrived" checks, modeled on the
// acceptance-timer pattern (setTimeout-per-entity in a Map) but — unlike acceptance
// timers — rehydrated on server restart (see server.listen() below), since this is
// a promise made to the user rather than an internal nudge.

function computeNextOccurrence(hour: number, minute: number, from: number = Date.now()): number {
  const d = new Date(from);
  d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  return d.getTime();
}

function clearCurfewTimer(id: string) {
  const t = curfewTimers.get(id);
  if (t) { clearTimeout(t); curfewTimers.delete(id); }
}

function scheduleCurfewCheck(check: CurfewCheck) {
  clearCurfewTimer(check.id);
  if (!check.active) return;
  const delay = Math.max(0, check.nextCheckAt - Date.now());
  curfewTimers.set(check.id, setTimeout(() => fireCurfewCheck(check.id), delay));
}

async function fireCurfewCheck(id: string) {
  const check = curfewChecks.get(id);
  if (!check || !check.active) return;

  const target = users.get(check.targetUserId);
  let result: 'inside' | 'outside' = 'outside';
  if (target?.location) {
    const dist = haversineDistance(check.center.latitude, check.center.longitude, target.location.latitude, target.location.longitude);
    result = dist <= check.radiusMeters ? 'inside' : 'outside';
  }
  check.lastFiredAt = Date.now();
  check.lastResult = result;

  const alertWhen = check.alertWhen || 'exit'; // legacy checks predating this field default to prior behavior
  const shouldAlert =
    alertWhen === 'both' ||
    (alertWhen === 'exit' && result === 'outside') ||
    (alertWhen === 'entry' && result === 'inside');

  if (shouldAlert) {
    const address = check.center.address ? ` (${check.center.address})` : '';
    let title: string;
    let body: string;
    if (alertWhen === 'entry') {
      title = result === 'inside' ? '⚠️ Présence signalée' : '⏰ Vérification couvre-feu';
      body = result === 'inside'
        ? `${check.targetUserName} est dans la zone surveillée${address}.`
        : `${check.targetUserName} n'est pas dans la zone surveillée${address}.`;
    } else if (alertWhen === 'both') {
      title = '⏰ Vérification couvre-feu';
      body = result === 'inside'
        ? `${check.targetUserName} est dans la zone attendue${address}.`
        : `${check.targetUserName} n'est pas dans la zone attendue${address}.`;
    } else {
      title = '⏰ Couvre-feu non respecté';
      body = `${check.targetUserName} n'est pas dans la zone attendue${address}.`;
    }

    sendPushToUser(check.ownerId, title, body, { type: 'curfew_check', curfewCheckId: check.id }).catch(() => {});

    const alert: ProximityAlert = {
      id: uuidv4(),
      perimeterId: check.id,
      targetUserId: check.targetUserId,
      targetUserName: check.targetUserName,
      ownerId: check.ownerId,
      eventType: 'curfew_violation',
      distanceMeters: target?.location
        ? Math.round(haversineDistance(check.center.latitude, check.center.longitude, target.location.latitude, target.location.longitude))
        : -1,
      location: target?.location || check.center,
      timestamp: Date.now(),
      acknowledged: false,
      curfewResult: result,
    };
    proximityAlerts.unshift(alert);
    if (proximityAlerts.length > 500) proximityAlerts.length = 500;
    persistProximityAlerts();
  }

  if (check.recurrence === 'once') {
    check.active = false;
  } else {
    check.nextCheckAt = computeNextOccurrence(check.hour, check.minute);
    scheduleCurfewCheck(check);
  }
  curfewChecks.set(check.id, check);
  persistCurfewChecks();
}

// ─── Scheduled Check-ins ────────────────────────────────────────────────
// "Confirm you're safe by X" dead-man's switch. Same setTimeout + rehydration
// mechanism as CurfewCheck above, but with an active-confirmation semantics:
// due time → reminder push + grace timer → still unconfirmed → dispatch alert.

function clearCheckInTimer(id: string) {
  const t = checkInTimers.get(id);
  if (t) { clearTimeout(t); checkInTimers.delete(id); }
}

function scheduleCheckIn(checkIn: ScheduledCheckIn) {
  clearCheckInTimer(checkIn.id);
  if (checkIn.status !== 'pending' && checkIn.status !== 'awaiting_confirmation') return;
  const delay = Math.max(0, checkIn.nextFireAt - Date.now());
  const handler = checkIn.stage === 'due' ? fireCheckInDue : fireCheckInEscalation;
  checkInTimers.set(checkIn.id, setTimeout(() => handler(checkIn.id), delay));
}

// Called once a 'daily' check-in's cycle completes (confirmed or escalated) to
// reset it for the next occurrence, same wall-clock time tomorrow — mirrors
// CurfewCheck's always-recurring behavior, but here confirmation state must be
// explicitly reset too since (unlike CurfewCheck) each cycle carries a status.
function rescheduleIfRecurring(checkIn: ScheduledCheckIn) {
  if (checkIn.recurrence !== 'daily' || checkIn.hour == null || checkIn.minute == null) return;
  checkIn.dueAt = computeNextOccurrence(checkIn.hour, checkIn.minute);
  checkIn.status = 'pending';
  checkIn.stage = 'due';
  checkIn.nextFireAt = checkIn.dueAt;
  checkIn.confirmedAt = undefined;
  checkIn.escalatedAt = undefined;
  scheduledCheckIns.set(checkIn.id, checkIn);
  persistCheckIns();
  scheduleCheckIn(checkIn);
}

async function fireCheckInDue(id: string) {
  const checkIn = scheduledCheckIns.get(id);
  if (!checkIn || checkIn.status !== 'pending') return;

  sendPushToUser(
    checkIn.targetUserId,
    '⏰ Confirmation de sécurité',
    `Confirme que tu vas bien — prévu(e) avant ${new Date(checkIn.dueAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`,
    { type: 'checkin_reminder', checkInId: checkIn.id }
  ).catch(() => {});

  checkIn.status = 'awaiting_confirmation';
  checkIn.stage = 'escalation';
  checkIn.nextFireAt = Date.now() + checkIn.graceMinutes * 60 * 1000;
  scheduledCheckIns.set(checkIn.id, checkIn);
  persistCheckIns();
  scheduleCheckIn(checkIn);
}

async function fireCheckInEscalation(id: string) {
  const checkIn = scheduledCheckIns.get(id);
  if (!checkIn || checkIn.status !== 'awaiting_confirmation') return;

  checkIn.status = 'escalated';
  checkIn.escalatedAt = Date.now();
  scheduledCheckIns.set(checkIn.id, checkIn);
  persistCheckIns();

  const target = users.get(checkIn.targetUserId);
  const location = target?.location
    ? { latitude: target.location.latitude, longitude: target.location.longitude, address: 'Dernière position connue' }
    : { latitude: 0, longitude: 0, address: 'Position inconnue' };

  const alert: Alert = {
    id: await generateIncidentId('other', checkIn.targetUserName, location),
    type: 'other',
    severity: 'high',
    location,
    description: `Check-in manqué — ${checkIn.targetUserName} n'a pas confirmé être en sécurité.`,
    createdBy: 'system',
    reporterId: checkIn.targetUserId,
    organizationId: adminUsers.get(checkIn.targetUserId)?.organizationId,
    origin: 'mobile',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
    photos: [],
  };
  alerts.set(alert.id, alert);
  linkPossibleDuplicates(alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[CheckIn] Supabase save error:', e));
  addAuditEntry('incident', 'Check-in manqué', checkIn.ownerId, `Check-in ${checkIn.id}: ${checkIn.targetUserName}`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'newAlert', data: alert });
  sendPushToDispatchersAndResponders(alert, checkIn.targetUserName).catch(() => {});
  rescheduleIfRecurring(checkIn);
}

// Location update handler
function handleLocationUpdate(ws: any, userId: string, userRole: string, locationData: any) {
  if (!userId) return;
  console.log(`[Location] WS update from ${userId} (${userRole}): lat=${locationData?.latitude}, lng=${locationData?.longitude}`);
  let user = users.get(userId);
  if (!user) {
    // Create user entry if not in map yet (e.g. logged in via REST but not yet tracked)
    const adminUser = adminUsers.get(userId);
    user = {
      id: userId,
      email: adminUser?.email || `${userId}@unknown`,
      role: userRole as any,
      status: 'active',
      lastSeen: Date.now(),
    };
    users.set(userId, user);
    console.log(`[Location] Created user entry for ${userId} (${userRole})`);
  }
  user.location = locationData;
  user.lastSeen = Date.now();
  users.set(userId, user);
  sharingUsers.add(userId);

  // Record location history (ring buffer per user)
  if (locationData?.latitude != null && locationData?.longitude != null) {
    const entry: LocationHistoryEntry = {
      userId,
      latitude: locationData.latitude,
      longitude: locationData.longitude,
      timestamp: Date.now(),
    };
    let history = locationHistory.get(userId);
    if (!history) { history = []; locationHistory.set(userId, history); }
    history.push(entry);
    if (history.length > MAX_HISTORY_PER_USER) {
      history.splice(0, history.length - MAX_HISTORY_PER_USER);
    }
    persistLocationHistory();
  }

  // Check family perimeters (proximity alerts)
  checkFamilyPerimeters(userId, locationData);
  checkSchoolRouteDeviation(userId, locationData);

  // Broadcast to dispatchers - use appropriate event type based on role
  const userName = adminUsers.get(userId)?.name || userId;
  const locationOrgId = adminUsers.get(userId)?.organizationId;
  if (user.role === 'responder') {
    broadcastToOrgRole(locationOrgId, 'dispatcher', {
      type: 'responderLocationUpdate',
      userId,
      name: userName,
      location: locationData,
      timestamp: Date.now(),
    });
    // Also broadcast to admins
    broadcastToOrgRole(locationOrgId, 'admin', {
      type: 'responderLocationUpdate',
      userId,
      name: userName,
      location: locationData,
      timestamp: Date.now(),
    });
    checkGeofences(userId, locationData);
    checkActivePatrolRound(userId, locationData);
    checkActiveResponderRoute(userId, locationData);
    checkResponderBlackbookProximity(userId, locationData, locationOrgId);
  } else {
    // Regular user location update - broadcast as userLocationUpdate to dispatch (both
    // dispatcher and admin consoles), unless this user is in Ghost mode and hasn't
    // confirmed visibility for a currently active incident.
    const isGhosted = adminUsers.get(userId)?.ghostMode && !isRevealedForActiveIncident(userId);
    if (!isGhosted) {
      const msg = { type: 'userLocationUpdate', userId, name: userName, location: locationData, timestamp: Date.now() };
      broadcastToOrgRole(locationOrgId, 'dispatcher', msg);
      broadcastToOrgRole(locationOrgId, 'admin', msg);
    }
  }
  // Family location sharing: broadcast to family members regardless of role
  const familyIds = getFamilyMemberIds(userId);
  if (familyIds.length > 0) {
    const adminUser = adminUsers.get(userId);
    broadcastToUsers(familyIds, {
      type: 'familyLocationUpdate',
      userId,
      userName: adminUser?.name || userId,
      location: locationData,
      timestamp: Date.now(),
    });
  }
}

// Status update handler
function handleStatusUpdate(ws: any, userId: string, statusData: any) {
  const user = users.get(userId);
  if (user && user.role === 'responder') {
    user.status = statusData.status;
    user.lastSeen = Date.now();
    users.set(userId, user);
    console.log(`Responder ${userId} status updated to ${statusData.status}`);
    broadcastToOrgRole(adminUsers.get(userId)?.organizationId, 'dispatcher', {
      type: 'responderStatusUpdate',
      userId,
      status: statusData.status,
      timestamp: Date.now(),
    });
  }
}

// Acknowledge alert handler
function handleAcknowledgeAlert(ws: any, userId: string, alertData: any) {
  const alert = alerts.get(alertData.alertId);
  if (alert) {
    if (!alert.respondingUsers.includes(userId)) {
      alert.respondingUsers.push(userId);
    }
    alert.status = 'acknowledged';
    if (!alert.acknowledgedAt) alert.acknowledgedAt = Date.now();
    alerts.set(alert.id, alert);
    persistAlerts();
    saveAlertToSupabase(alert).catch(e => console.error('[WS Acknowledge] Supabase save error:', e));
    console.log(`Alert ${alert.id} acknowledged by ${userId}`);
    addAuditEntry('incident', 'Alert Acknowledged', userId, `Acknowledged ${alert.id}`, undefined, alert.organizationId);
    broadcastToOrg(alert.organizationId, { type: 'alertAcknowledged', alertId: alert.id, userId, timestamp: Date.now() });
  }
}

// Get alerts handler
function handleGetAlerts(ws: any, userId: string, userRole: string) {
  const caller = { role: userRole, organizationId: adminUsers.get(userId)?.organizationId };
  const userAlerts = Array.from(alerts.values()).filter(alert => {
    if (!canAccessOrg(caller, alert.organizationId)) return false;
    if (alert.status === 'resolved' || alert.status === 'cancelled') return false;
    return true;
  });
  ws.send(JSON.stringify({ type: 'alertsList', data: userAlerts, timestamp: Date.now() }));
}

// Get responders handler
function handleGetResponders(ws: any) {
  const connectedResponders = Array.from(users.values()).filter(u => u.role === 'responder');
  // Enrich with real names from adminUsers
  const enriched = connectedResponders.map(r => {
    const adminUser = adminUsers.get(r.id);
    return {
      ...r,
      name: adminUser?.name || r.id,
      firstName: adminUser?.firstName || '',
      lastName: adminUser?.lastName || '',
      email: adminUser?.email || '',
      phone: adminUser?.phoneMobile || '',
      tags: adminUser?.tags || [],
      isConnected: true,
    };
  });
  ws.send(JSON.stringify({ type: 'respondersList', data: enriched, timestamp: Date.now() }));
}

// Broadcast helpers — organization-scoped. Renamed from broadcastMessage/
// broadcastToRole (rather than adding an optional param) so tsc turns every
// call site into a compile error until it's given an explicit
// organizationId — a silently-omitted optional param would be exactly the
// kind of cross-tenant leak this rename exists to prevent.
function broadcastToOrg(organizationId: string | undefined, message: any) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client: any) => {
    if (client.readyState !== 1) return;
    const uid = wsClientMap.get(client);
    const u = uid ? users.get(uid) : undefined;
    if (u?.organizationId && u.organizationId === organizationId) client.send(data);
  });
}

function broadcastToOrgRole(organizationId: string | undefined, role: string, message: any) {
  const data = JSON.stringify(message);
  const targetUsers = Array.from(users.values()).filter(u => u.role === role && u.organizationId === organizationId);
  targetUsers.forEach(user => {
    const connections = userConnections.get(user.id);
    if (connections) {
      connections.forEach(client => {
        if (client.readyState === 1) { client.send(data); }
      });
    }
  });
}

function broadcastUserStatus(userId: string, status: 'online' | 'offline') {
  const payload = {
    type: 'userStatusChange',
    userId,
    name: adminUsers.get(userId)?.name || userId,
    status,
    timestamp: Date.now(),
  };
  const statusOrgId = adminUsers.get(userId)?.organizationId;
  broadcastToOrgRole(statusOrgId, 'dispatcher', payload);
  broadcastToOrgRole(statusOrgId, 'admin', payload);
}

// ─── REST API endpoints ────────────────────────────────────────────// ─── Authentication ───────────────────────────────────────────────────────
app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const ip = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const userAgent = req.headers['user-agent'] || 'unknown';

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }
  const user = Array.from(adminUsers.values()).find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    addLoginHistory({ userId: 'unknown', userName: 'Unknown', email, timestamp: Date.now(), ip, userAgent, status: 'failed_email' });
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  if (user.status === 'deactivated') {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: 'account_deactivated' });
    return res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });
  }
  if (user.status === 'suspended') {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: 'account_suspended' });
    return res.status(403).json({ error: 'Account is suspended. Contact your administrator.' });
  }
  if (!user.passwordHash) {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: 'no_password' });
    return res.status(401).json({ error: 'No password set for this account. Contact your administrator.' });
  }
  const valid = bcrypt.compareSync(password, user.passwordHash);
  if (!valid) {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: 'failed_password' });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Local password check passed — now obtain a real, verifiable Supabase Auth JWT
  // (requireAuth validates tokens via supabase.auth.getUser, not the local bcrypt hash).
  let accessToken: string | null = null;
  try {
    const { data: signInData, error: signInError } = await supabaseAuthOnly.auth.signInWithPassword({ email, password });
    if (!signInError && signInData.session) {
      accessToken = signInData.session.access_token;
    } else {
      // Supabase Auth identity missing or password drifted from the local bcrypt hash
      // (e.g. changed via PUT /admin/users/:id, which only updates the local hash) — self-heal.
      const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, { password });
      if (!updateError) {
        const { data: retryData, error: retryError } = await supabaseAuthOnly.auth.signInWithPassword({ email, password });
        if (!retryError && retryData.session) {
          accessToken = retryData.session.access_token;
          addAuditEntry('auth', 'Supabase Auth Re-sync', user.name, `Password re-synced to Supabase Auth for ${email} after drift detected`, user.id, user.organizationId);
        }
      }
    }
  } catch (e) {
    console.error('[Login] Supabase Auth sign-in error:', e);
  }

  if (!accessToken) {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: 'supabase_sync_failed' });
    return res.status(401).json({ error: "Compte non synchronisé avec Supabase Auth. Contactez un administrateur." });
  }

  // Success
  addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: 'success' });
  user.lastLogin = Date.now();
  adminUsers.set(user.id, user);
  addAuditEntry('auth', 'User Login', user.name, `Login via email/password from ${parseDevice(userAgent)} (${ip})`, undefined, user.organizationId);
  const { passwordHash, ...safeUser } = user;
  res.json({
    success: true,
    user: safeUser,
    token: accessToken,
  });
});

// Change password endpoint
// Self-service only — previously took userId from the body with no auth at
// all, and silently skipped the current-password check whenever the client
// simply omitted it, amounting to unauthenticated account takeover of any
// user on the platform. An admin resetting someone else's password already
// has PUT /admin/users/:id for that (protected since Phase 0/2), so this
// route has no legitimate reason to ever target anyone but the caller.
app.put('/auth/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!newPassword) {
    return res.status(400).json({ error: 'newPassword is required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const userId = req.supabaseUser!.id;
  const user = adminUsers.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // Current password is required whenever one is already set — only a
  // brand-new account with no password yet can skip this.
  if (user.passwordHash) {
    if (!currentPassword || !bcrypt.compareSync(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }
  // The bcrypt hash below only backs the legacy /auth/login REST route — the
  // app itself signs in directly against Supabase Auth
  // (supabase.auth.signInWithPassword), so THAT password is the one that
  // actually has to change for this to take effect on the next login.
  const { error: authUpdateError } = await supabaseAdmin.auth.admin.updateUserById(userId, { password: newPassword });
  if (authUpdateError) {
    console.error('[ChangePassword] Supabase Auth update error:', authUpdateError.message);
    return res.status(500).json({ error: 'Impossible de mettre à jour le mot de passe. Réessayez.' });
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user).catch(e => console.error('[ChangePassword] Supabase save error:', e));
  addAuditEntry('auth', 'Password Changed', user.name, 'Password updated', undefined, user.organizationId);
  res.json({ success: true });
});

// Password reset request — generates a temporary reset code
// In production this would send an email; here we store the code and return it for the admin console
const passwordResetCodes = new Map<string, { userId: string; code: string; expiresAt: number }>();

app.post('/auth/request-password-reset', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const user = Array.from(adminUsers.values()).find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    // Don't reveal whether the email exists — always return success
    return res.json({ success: true, message: 'Si un compte existe avec cet email, un code de réinitialisation a été généré.' });
  }
  if (user.status === 'deactivated' || user.status === 'suspended') {
    return res.json({ success: true, message: 'Si un compte existe avec cet email, un code de réinitialisation a été généré.' });
  }

  // Generate a 6-digit code valid for 15 minutes
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = Date.now() + 15 * 60 * 1000;
  passwordResetCodes.set(code, { userId: user.id, code, expiresAt });

  addAuditEntry('auth', 'Password Reset Requested', user.name, `Reset code generated for ${user.email}`, undefined, user.organizationId);

  // Broadcast to dispatch/admin consoles so they can relay the code
  wss.clients.forEach((client: any) => {
    if (client.readyState === 1 && (client.userRole === 'admin' || client.userRole === 'dispatcher')) {
      client.send(JSON.stringify({
        type: 'passwordResetRequest',
        userId: user.id,
        userName: user.name,
        email: user.email,
        code,
        expiresAt,
      }));
    }
  });

  console.log(`[Auth] Password reset code for ${user.email}: ${code} (expires in 15 min)`);
  res.json({ success: true, message: 'Si un compte existe avec cet email, un code de réinitialisation a été généré.' });
});

// Confirm password reset with code
app.post('/auth/reset-password', (req, res) => {
  const { code, newPassword } = req.body;
  if (!code || !newPassword) return res.status(400).json({ error: 'Code and new password are required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const resetEntry = passwordResetCodes.get(code);
  if (!resetEntry) return res.status(400).json({ error: 'Code invalide ou expiré' });
  if (Date.now() > resetEntry.expiresAt) {
    passwordResetCodes.delete(code);
    return res.status(400).json({ error: 'Code expiré. Veuillez en demander un nouveau.' });
  }

  const user = adminUsers.get(resetEntry.userId);
  if (!user) {
    passwordResetCodes.delete(code);
    return res.status(404).json({ error: 'User not found' });
  }

  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  adminUsers.set(user.id, user);
  passwordResetCodes.delete(code);

  addAuditEntry('auth', 'Password Reset Completed', user.name, `Password reset via code for ${user.email}`, undefined, user.organizationId);
  console.log(`[Auth] Password reset completed for ${user.email}`);
  res.json({ success: true, message: 'Mot de passe réinitialisé avec succès.' });
});

// ─── Login History Endpoints ─────────────────────────────────────────
// Global login history (all users)
app.get('/admin/login-history', requireAuth, requireRole('admin'), (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const status = req.query.status as string; // filter by status
  const userId = req.query.userId as string; // filter by user
  const search = (req.query.search as string || '').toLowerCase();

  let filtered = loginHistory.filter(e => canAccessOrg(req.supabaseUser!, adminUsers.get(e.userId)?.organizationId));
  if (status && status !== 'all') {
    filtered = filtered.filter(e => e.status === status);
  }
  if (userId) {
    filtered = filtered.filter(e => e.userId === userId);
  }
  if (search) {
    filtered = filtered.filter(e =>
      e.userName.toLowerCase().includes(search) ||
      e.email.toLowerCase().includes(search) ||
      e.ip.includes(search) ||
      e.device.toLowerCase().includes(search)
    );
  }

  const total = filtered.length;
  const start = (page - 1) * limit;
  const entries = filtered.slice(start, start + limit);

  res.json({
    entries,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
});

// Login history for a specific user
app.get('/admin/users/:id/login-history', requireAuth, requireRole('admin'), (req, res) => {
  const userId = req.params.id as string;
  const user = adminUsers.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });

  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const entries = loginHistory.filter(e => e.userId === userId);
  const total = entries.length;
  const start = (page - 1) * limit;

  res.json({
    user: { id: user.id, name: user.name, email: user.email },
    entries: entries.slice(start, start + limit),
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
});

// Login history stats (for dashboard)
app.get('/admin/login-stats', requireAuth, requireRole('admin'), (req, res) => {
  const scopedHistory = loginHistory.filter(e => canAccessOrg(req.supabaseUser!, adminUsers.get(e.userId)?.organizationId));
  const now = Date.now();
  const last24h = scopedHistory.filter(e => e.timestamp > now - 86400000);
  const last7d = scopedHistory.filter(e => e.timestamp > now - 7 * 86400000);

  const successCount24h = last24h.filter(e => e.status === 'success').length;
  const failedCount24h = last24h.filter(e => e.status !== 'success').length;
  const successCount7d = last7d.filter(e => e.status === 'success').length;
  const failedCount7d = last7d.filter(e => e.status !== 'success').length;

  // Unique users who logged in last 24h
  const uniqueUsers24h = new Set(last24h.filter(e => e.status === 'success').map(e => e.userId)).size;

  // Most active users
  const userCounts: Record<string, { name: string; count: number }> = {};
  last7d.filter(e => e.status === 'success').forEach(e => {
    if (!userCounts[e.userId]) userCounts[e.userId] = { name: e.userName, count: 0 };
    userCounts[e.userId].count++;
  });
  const topUsers = Object.entries(userCounts)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([id, data]) => ({ userId: id, name: data.name, loginCount: data.count }));

  // Failed attempts by IP (security)
  const failedByIp: Record<string, number> = {};
  last24h.filter(e => e.status !== 'success').forEach(e => {
    failedByIp[e.ip] = (failedByIp[e.ip] || 0) + 1;
  });
  const suspiciousIps = Object.entries(failedByIp)
    .filter(([_, count]) => count >= 3)
    .map(([ip, count]) => ({ ip, failedAttempts: count }));

  res.json({
    last24h: { success: successCount24h, failed: failedCount24h, uniqueUsers: uniqueUsers24h },
    last7d: { success: successCount7d, failed: failedCount7d },
    topUsers,
    suspiciousIps,
    totalEntries: scopedHistory.length,
  });
});

// Photo upload endpoint
app.post('/admin/users/:id/photo', requireAuth, requireRole('admin'), upload.single('photo'), async (req: any, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  user.photoUrl = await uploadFileToSupabaseStorage(req.file);
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry('user_updated', `Profile photo updated for ${user.firstName} ${user.lastName}`, 'admin');
  const { passwordHash, ...safe } = user;
  res.json({ success: true, user: safe });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedUsers: users.size,
    activeAlerts: Array.from(alerts.values()).filter(a => a.status === 'active').length,
    timestamp: Date.now(),
  });
});

// Geocode proxy for Nominatim (avoids CORS/403 issues from browser)
const geocodeCache = new Map<string, {data: any, ts: number}>();

app.get('/api/geocode', requireAuth, async (req, res) => {
  const q = req.query.q as string;
  if (!q || q.length < 2) return res.json([]);
  // Check cache (5 min TTL)
  const cached = geocodeCache.get(q);
  if (cached && Date.now() - cached.ts < 300000) return res.json(cached.data);
  try {
    const mapboxToken = process.env.MAPBOX_TOKEN;
    if (mapboxToken) {
      const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=5&types=address&language=fr`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Mapbox error');
      const data = await response.json();
      const results = (data.features || []).map((f: any) => {
        const ctx = f.context || [];
        const city = ctx.find((c: any) => c.id?.startsWith('place'))?.text || '';
        const country = ctx.find((c: any) => c.id?.startsWith('country'))?.text || '';
        const postcode = ctx.find((c: any) => c.id?.startsWith('postcode'))?.text || '';
        return {
          display_name: f.place_name,
          lat: f.center[1].toString(),
          lon: f.center[0].toString(),
          address: {
            house_number: f.address || '',
            road: f.text || '',
            city, town: city, postcode, country,
          }
        };
      });
      geocodeCache.set(q, { data: results, ts: Date.now() });
      return res.json(results);
    }
    // Fallback Nominatim
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=5`;
    const response = await fetch(url, { headers: { 'User-Agent': 'TalionCrisisComm/1.0' } });
    if (!response.ok) return res.status(response.status).json({ error: 'Geocode error' });
    const data = await response.json();
    geocodeCache.set(q, { data, ts: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('Geocode proxy error:', err);
    res.status(500).json({ error: 'Geocode proxy failed' });
  }
});

// Gated by the 'app.use(\'/alerts\', requireAuth)' prefix middleware near
// the top of the file — req.supabaseUser is always populated by the time
// this handler runs, so it's safe to org-scope via the verified caller
// rather than the unverified role/userId query params below (those are
// still used for the per-user "own incidents" narrowing further down).
app.get('/alerts', (req, res) => {
  const userRole = req.query.role as string;
  const userId = req.query.userId as string;
  const visibleAlerts = Array.from(alerts.values()).filter(a => {
    if (!canAccessOrg(req.supabaseUser!, a.organizationId)) return false;
    if (a.status === 'resolved') return false;
    if (userRole === 'user') {
      // User voit ses propres incidents + incidents créés par Dispatch le concernant
      const userName = adminUsers.get(userId)?.name || userId;
      return a.createdBy === userId || a.createdBy === userName ||
        (a.respondingUsers || []).includes(userId) ||
        (a.status === 'active' || a.status === 'acknowledged' || a.status === 'dispatched'); // incidents en cours visibles pour les users
    }
    return true;
  }).map(a => {
    const respondingNames = (a.respondingUsers || []).map(uid => {
      const admin = adminUsers.get(uid);
      return admin?.name || uid;
    });
    const creatorName = adminUsers.get(a.createdBy)?.name || a.createdBy;
    return { ...a, respondingNames, createdByName: creatorName };
  });
  res.json(visibleAlerts);
});

app.get('/alerts/:id', requireRole('dispatcher'), (req, res) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  // Return full alert with responding user details (enriched with names)
  const respondingDetails = alert.respondingUsers.map(uid => {
    const user = users.get(uid);
    const admin = adminUsers.get(uid);
    return {
      id: uid,
      name: admin?.name || uid,
      phone: admin?.phoneMobile || '',
      tags: admin?.tags || [],
      status: user?.status || responderStatusOverrides.get(uid)?.status || 'unknown',
      location: user?.location || null,
      isConnected: !!user,
    };
  });
  const respondingNames = alert.respondingUsers.map(uid => adminUsers.get(uid)?.name || uid);
  res.json({ ...alert, respondingDetails, respondingNames });
});

// Mobile app: acknowledge alert
// Update alert (location, etc.)
app.put('/alerts/:id', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  const { location, description } = req.body;
  if (location) alert.location = location;
  if (description) alert.description = description;
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Unassign] Supabase save error:', e));
  broadcastToOrg(alert.organizationId, { type: 'alertUpdate', data: { ...alert, respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
  res.json({ success: true });
});

app.put('/alerts/:id/acknowledge', requireRole('dispatcher'), (req, res) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.status = 'acknowledged';
  if (!alert.acknowledgedAt) alert.acknowledgedAt = Date.now();
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Acknowledge] Supabase save error:', e));
  addAuditEntry('incident', 'Alert Acknowledged', req.body?.userId || 'Mobile App', `Acknowledged ${alert.id}`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'alertAcknowledged', alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});

// Mobile app: resolve alert
app.put('/alerts/:id/resolve', requireRole('dispatcher'), (req, res) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.status = 'resolved';
  if (!alert.resolvedAt) alert.resolvedAt = Date.now();
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Resolve] Supabase save error:', e));
  addAuditEntry('incident', 'Incident Resolved', req.body?.userId || 'Mobile App', `Resolved ${alert.id}: ${alert.type} at ${alert.location.address}`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'alertResolved', alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});

// Archiving hides an incident from the normal active views (list, map, table)
// without deleting it — it stays fully queryable via the Archives view. Status
// (resolved/cancelled/etc.) is untouched; archived is an orthogonal flag.
app.put('/alerts/:id/archive', requireRole('dispatcher'), (req, res) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.archived = true;
  alert.archivedAt = Date.now();
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Archive] Supabase save error:', e));
  addAuditEntry('incident', 'Incident Archived', req.supabaseUser?.id || 'Dispatch Console', `Archived ${alert.id}`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'alertUpdate', data: { ...alert, respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
  res.json({ success: true });
});

app.put('/alerts/:id/unarchive', requireRole('dispatcher'), (req, res) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.archived = false;
  alert.archivedAt = undefined;
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Unarchive] Supabase save error:', e));
  addAuditEntry('incident', 'Incident Unarchived', req.supabaseUser?.id || 'Dispatch Console', `Unarchived ${alert.id}`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'alertUpdate', data: { ...alert, respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
  res.json({ success: true });
});

// Mobile app: a user's own archived alerts history — separate from the
// console's /admin/incidents since it's scoped to the authenticated caller
// and doesn't require dispatcher/admin access.
app.get('/api/my-alerts/archive', requireAuth, (req, res) => {
  const userId = req.supabaseUser!.id;
  const mine = Array.from(alerts.values())
    .filter(a => a.archived && (a.reporterId === userId || a.createdBy === userId))
    .sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0))
    .map(a => ({
      id: a.id,
      type: a.type,
      severity: a.severity,
      status: a.status,
      address: a.location?.address || 'Unknown',
      description: a.description,
      timestamp: a.createdAt,
      archivedAt: a.archivedAt,
      photos: a.photos || [],
    }));
  res.json(mine);
});

// Dispatcher confirms two incidents are reports of the same real-world event.
// Bidirectional link; drops the pair from possibleDuplicates on both sides
// since it's now a confirmed correlation rather than a suggestion.
app.post('/alerts/:id/link/:otherId', requireRole('dispatcher'), (req, res) => {
  const id = req.params.id as string;
  const otherId = req.params.otherId as string;
  const alert = alerts.get(id);
  const other = alerts.get(otherId);
  if (!alert || !other) return res.status(404).json({ error: 'Incident not found' });
  alert.linkedIncidentIds = alert.linkedIncidentIds || [];
  other.linkedIncidentIds = other.linkedIncidentIds || [];
  if (!alert.linkedIncidentIds.includes(otherId)) alert.linkedIncidentIds.push(otherId);
  if (!other.linkedIncidentIds.includes(id)) other.linkedIncidentIds.push(id);
  alert.possibleDuplicates = (alert.possibleDuplicates || []).filter(d => d.id !== otherId);
  other.possibleDuplicates = (other.possibleDuplicates || []).filter(d => d.id !== id);
  alerts.set(alert.id, alert);
  alerts.set(other.id, other);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Link] Supabase save error:', e));
  saveAlertToSupabase(other).catch(e => console.error('[Link] Supabase save error:', e));
  addAuditEntry('incident', 'Incidents Linked', req.supabaseUser?.id || 'Dispatch Console', `Linked ${alert.id} and ${other.id} as the same event`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'alertUpdate', data: { ...alert, respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
  broadcastToOrg(other.organizationId, { type: 'alertUpdate', data: { ...other, respondingNames: (other.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
  res.json({ success: true });
});

// Dispatcher dismisses a suggested correlation (not the same event) — hides it
// from both sides without touching either incident's status or data.
app.delete('/alerts/:id/duplicate-suggestion/:otherId', requireRole('dispatcher'), (req, res) => {
  const id = req.params.id as string;
  const otherId = req.params.otherId as string;
  const alert = alerts.get(id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  alert.possibleDuplicates = (alert.possibleDuplicates || []).filter(d => d.id !== otherId);
  alerts.set(alert.id, alert);
  saveAlertToSupabase(alert).catch(e => console.error('[DismissDuplicate] Supabase save error:', e));
  const other = alerts.get(otherId);
  if (other) {
    other.possibleDuplicates = (other.possibleDuplicates || []).filter(d => d.id !== id);
    alerts.set(other.id, other);
    saveAlertToSupabase(other).catch(e => console.error('[DismissDuplicate] Supabase save error:', e));
  }
  persistAlerts();
  broadcastToOrg(alert.organizationId, { type: 'alertUpdate', data: { ...alert, respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
  if (other) broadcastToOrg(other.organizationId, { type: 'alertUpdate', data: { ...other, respondingNames: (other.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
  res.json({ success: true });
});

// Permanently deletes an incident record. Unlike resolve (a status change,
// meant to be part of the normal workflow), this is a hard delete — reserved
// for admins, intended for cleaning up test/duplicate/junk data rather than
// day-to-day dispatch use. Scrubs the deleted id out of any other incident's
// possibleDuplicates/linkedIncidentIds so no dangling references remain.
app.delete('/alerts/:id', requireRole('admin'), async (req, res) => {
  const id = req.params.id as string;
  const alert = alerts.get(id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });

  alerts.delete(id);
  for (const other of alerts.values()) {
    let changed = false;
    if (other.possibleDuplicates?.some(d => d.id === id)) {
      other.possibleDuplicates = other.possibleDuplicates.filter(d => d.id !== id);
      changed = true;
    }
    if (other.linkedIncidentIds?.includes(id)) {
      other.linkedIncidentIds = other.linkedIncidentIds.filter(otherId => otherId !== id);
      changed = true;
    }
    if (changed) {
      alerts.set(other.id, other);
      saveAlertToSupabase(other).catch(e => console.error('[Delete cleanup] Supabase save error:', e));
    }
  }
  persistAlerts();
  await deleteAlertFromSupabase(id);
  addAuditEntry('incident', 'Incident Deleted', req.supabaseUser?.id || 'Dispatch Console', `Deleted ${id}: ${alert.type} at ${alert.location?.address || 'unknown'}`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'alertDeleted', alertId: id });
  res.json({ success: true });
});

app.get('/responders', requireAuth, (req, res) => {
  const responders = Array.from(users.values()).filter(u => u.role === 'responder' && canAccessOrg(req.supabaseUser!, u.organizationId));
  res.json(responders);
});

// Dispatch console: create incident (auth via the '/dispatch' prefix
// middleware at the top of the file, not repeated here — the "without
// auth" in this comment predates that middleware and is stale)
app.post('/dispatch/incidents', async (req, res) => {
  const { type, severity, location, description, createdBy, visibilityRadiusMeters } = req.body;
  const alert: Alert = {
    id: await generateIncidentId(type || 'other', createdBy || 'Dispatch Console', location || {}),
    type: type || 'other',
    severity: severity || 'medium',
    location: location || { latitude: 0, longitude: 0, address: 'Unknown' },
    description: description || '',
    createdBy: createdBy || 'Dispatch Console',
    organizationId: req.supabaseUser?.organizationId,
    origin: 'dispatch',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
    visibilityRadiusMeters: visibilityRadiusMeters ? Number(visibilityRadiusMeters) : undefined,
    revealedUserIds: [],
  };
  alerts.set(alert.id, alert);
  linkPossibleDuplicates(alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(() => {});
  broadcastToOrg(alert.organizationId, { type: 'newAlert', data: alert });
  sendPushToDispatchersAndResponders(alert, alert.createdBy).catch(() => {});
  // Push aussi aux users
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === 'user') {
      sendPushToUser(entry.userId,
        `🚨 Nouvel incident — ${alert.type.toUpperCase()}`,
        alert.description || alert.location?.address || 'Incident signalé',
        { type: alert.type, alertId: alert.id }
      ).catch(() => {});
    }
  }
  // Ask Ghost-mode users within the visibility radius to confirm becoming visible
  if (alert.visibilityRadiusMeters && alert.visibilityRadiusMeters > 0) {
    const ghostUserIds = findGhostUsersNearLocation(alert.location, alert.visibilityRadiusMeters);
    for (const ghostUserId of ghostUserIds) {
      sendPushToUser(
        ghostUserId,
        '📍 Incident à proximité',
        'Confirmez pour partager votre position avec les secours.',
        { type: 'reveal_request', alertId: alert.id }
      ).catch(() => {});
    }
  }
  res.json({ success: true, id: alert.id, alert });
});

app.post('/alerts', requireAuth, async (req, res) => {
  const { type, severity, location, description, createdBy } = req.body;
  const alert: Alert = {
    id: await generateIncidentId(type || 'other', createdBy || 'system', location || {}),
    type: type || 'other',
    severity: severity || 'medium',
    location: location || { latitude: 0, longitude: 0, address: 'Unknown' },
    description: description || '',
    createdBy: createdBy || 'system',
    reporterId: req.supabaseUser?.id || createdBy || undefined,
    organizationId: req.supabaseUser?.organizationId,
    origin: 'mobile',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
  };
  alerts.set(alert.id, alert);
  linkPossibleDuplicates(alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Alerts] Supabase save error:', e));
  broadcastToOrg(alert.organizationId, { type: 'newAlert', data: alert });

  // Send push notifications for the new incident
  if (alert.type === 'sos') {
    sendPushToDispatchersAndResponders(alert, createdBy || 'system');
  } else {
    // Non-SOS incidents (medical, fire, accident, etc.) → notify all users
    sendPushToAllUsers({
      title: `\u{1F6A8} ${(alert.type || 'Incident').toUpperCase()} - ${(alert.severity || 'medium').toUpperCase()}`,
      body: `${alert.description || 'New incident reported'}${alert.location?.address ? '\n\u{1F4CD} ' + alert.location.address : ''}`,
      data: { type: 'incident', alertId: alert.id, severity: alert.severity },
    });
  }

  res.json({ success: true, alertId: alert.id });
});

// ─── Push Token Registration ────────────────────────────────────────
app.post('/api/push-token', requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }
  // userId/userRole are derived from the verified caller, never trusted from
  // the body — previously anyone could register a token claiming to be any
  // userId, which the unfiltered push fan-outs would then happily deliver to.
  const userId = req.supabaseUser!.id;
  const userRole = req.supabaseUser!.role;

  pushTokens.set(token, {
    token,
    userId,
    userRole,
    registeredAt: Date.now(),
  });
  savePushTokenToSupabase({ token, userId, userRole, registeredAt: Date.now() });

  console.log(`[Push] Token registered for ${userId} (${userRole}). Total tokens: ${pushTokens.size}`);
  res.json({ success: true });
});

// Debug: list all push tokens
app.get('/api/debug/push-tokens', requireAuth, requireRole('superadmin'), (_req, res) => {
  const tokens = Array.from(pushTokens.values()).map(e => ({
    userId: e.userId,
    userRole: e.userRole,
    token: e.token,
    registeredAt: e.registeredAt,
  }));
  res.json(tokens);
});

app.delete('/api/push-token', requireAuth, (req, res) => {
  const { token } = req.body;
  if (token) {
    const entry = pushTokens.get(token);
    if (entry && entry.userId !== req.supabaseUser!.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    pushTokens.delete(token);
    deletePushTokenFromSupabase(token);
  }
  res.json({ success: true });
});

/**
 * Send push notification to a specific user by userId.
 * Used for targeted notifications like assignment alerts.
 */
async function sendPushToUser(userId: string, title: string, body: string, data: Record<string, any> = {}) {
  const targetTokens: string[] = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userId === userId) {
      targetTokens.push(token);
    }
  }
  if (targetTokens.length === 0) {
    console.log(`[Push] No tokens for user ${userId}, skipping`);
    return;
  }
  console.log(`[Push] Sending targeted push to ${userId} (${targetTokens.length} device(s))`);
  const messages = targetTokens.map((token) => ({
    to: token,
    sound: 'default',
    title,
    body,
    data,
    priority: 'high' as const,
    channelId: 'incident-updates',
  }));
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messages),
    });
    if (!response.ok) {
      console.error(`[Push] Expo API error for ${userId}: ${response.status}`);
    } else {
      const result = await response.json();
      console.log(`[Push] Sent to ${userId}:`, result.data?.length || 0, 'tickets');
    }
  } catch (err) {
    console.error(`[Push] Failed to send to ${userId}:`, err);
  }
}

/**
 * Send push notifications to all dispatchers and responders via Expo Push API.
 * This is called when a new SOS alert is created.
 */
async function sendPushToDispatchersAndResponders(alert: Alert, senderName: string) {
  // Filter tokens for dispatchers and responders only
  const targetTokens: string[] = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === 'dispatcher' || entry.userRole === 'responder' || entry.userRole === 'admin') {
      if (adminUsers.get(entry.userId)?.organizationId !== alert.organizationId) continue;
      // Don't send push to the person who triggered the SOS
      if (entry.userId !== alert.createdBy) {
        targetTokens.push(token);
      }
    }
  }
  
  if (targetTokens.length === 0) {
    console.log('[Push] No dispatcher/responder tokens registered, skipping push');
    return;
  }
  
  console.log(`[Push] Sending SOS push to ${targetTokens.length} dispatcher/responder devices`);

  // Duress gets its own, unmistakably different push content and channel —
  // a dispatcher glancing at a lock-screen notification needs to tell this
  // apart from an ordinary SOS at a glance, not just once they open the app.
  const isDuress = alert.isDuress === true;

  // Build Expo push messages
  const messages = targetTokens.map((token) => ({
    to: token,
    sound: 'default',
    title: isDuress
      ? `\u{1F534} CODE DE CONTRAINTE — ${senderName}`
      : `\u{1F6A8} SOS ALERT - ${alert.type.toUpperCase()}`,
    body: isDuress
      ? `SOS "annulé" sous la contrainte — menace réelle probable. ${alert.location?.address || 'Position partagée'}`
      : `${senderName} triggered an emergency alert. ${alert.location?.address || 'Location shared'}`,
    data: {
      type: isDuress ? 'duress' : 'sos',
      alertId: alert.id,
      severity: alert.severity,
      alertType: alert.type,
    },
    priority: 'high',
    channelId: isDuress ? 'duress-alerts' : 'sos-alerts',
  }));
  
  // Send via Expo Push API (batch of up to 100)
  try {
    const chunks: typeof messages[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      chunks.push(messages.slice(i, i + 100));
    }
    
    for (const chunk of chunks) {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });
      
      if (!response.ok) {
        console.error(`[Push] Expo API error: ${response.status} ${response.statusText}`);
      } else {
        const result = await response.json();
        console.log(`[Push] Expo API response:`, JSON.stringify(result.data?.length || 0), 'tickets');
      }
    }
  } catch (error) {
    console.error('[Push] Failed to send push notifications:', error);
  }
}

/**
 * Send push notifications to ALL registered users for zone broadcasts.
 */
async function sendPushToAllUsers(alert: Alert, senderName: string) {
  const targetTokens: string[] = [];
  for (const [token, entry] of pushTokens) {
    if (adminUsers.get(entry.userId)?.organizationId !== alert.organizationId) continue;
    targetTokens.push(token);
  }

  if (targetTokens.length === 0) {
    console.log('[Push] No tokens registered, skipping broadcast push');
    return;
  }

  console.log(`[Push] Sending broadcast push to ${targetTokens.length} devices`);

  const SEVERITY_EMOJI: Record<string, string> = { critical: '\u{1F6A8}', high: '\u{26A0}\u{FE0F}', medium: '\u{1F4E2}', low: '\u{2139}\u{FE0F}' };
  const emoji = SEVERITY_EMOJI[alert.severity] || '\u{1F4E2}';

  const messages = targetTokens.map((token) => ({
    to: token,
    sound: 'default',
    title: `${emoji} BROADCAST - ${alert.severity.toUpperCase()}`,
    body: `${senderName}: ${alert.description}`,
    data: {
      type: 'broadcast',
      alertId: alert.id,
      severity: alert.severity,
    },
    priority: alert.severity === 'critical' || alert.severity === 'high' ? 'high' : 'normal',
    channelId: 'broadcast-alerts',
  }));

  try {
    const chunks: typeof messages[] = [];
    for (let i = 0; i < messages.length; i += 100) {
      chunks.push(messages.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });
      if (!response.ok) {
        console.error(`[Push] Expo API error: ${response.status} ${response.statusText}`);
      } else {
        const result = await response.json();
        console.log(`[Push] Broadcast push sent:`, JSON.stringify(result.data?.length || 0), 'tickets');
      }
    }
  } catch (error) {
    console.error('[Push] Failed to send broadcast push notifications:', error);
  }
}

// ─── SOS REST API (reliable fallback for mobile app) ────────────────
// This endpoint is the PRIMARY way the mobile app sends SOS alerts.
// It uses HTTP POST instead of WebSocket for maximum reliability on real devices.
app.post('/api/sos', async (req, res) => {
  const { type, severity, location, description, userId, userName, userRole } = req.body;
  console.log(`[SOS REST] Received SOS from ${userName || userId || 'unknown'}`);
  
  const alert: Alert = {
    id: await generateIncidentId(type || 'sos', userName || userId || 'mobile-user', location || {}),
    type: type || 'sos',
    severity: severity || 'critical',
    location: location || { latitude: 0, longitude: 0, address: 'Unknown' },
    description: description || `SOS Alert from ${userName || 'Unknown'}`,
    createdBy: userName || userId || 'mobile-user',
    reporterId: userId || undefined,
    // No requireAuth on this route by design (SOS must go through even if a
    // token refresh has failed) — best-effort org resolution from the
    // client-supplied userId, same reliability trade-off as reporterId above.
    organizationId: userId ? adminUsers.get(userId)?.organizationId : undefined,
    origin: 'mobile',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
    photos: [],
  };

  alerts.set(alert.id, alert);
  linkPossibleDuplicates(alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[SOS REST] Supabase save error:', e));
  addAuditEntry('incident', 'SOS Alert Created (REST)', userId || 'unknown', `SOS ${alert.id}: ${alert.location.address}`, undefined, alert.organizationId);

  // Broadcast to ALL connected WebSocket clients (Dispatch console, admin, etc.)
  broadcastToOrg(alert.organizationId, { type: 'newAlert', data: alert });
  
  // Send push notifications to dispatchers and responders
  sendPushToDispatchersAndResponders(alert, userName || userId || 'Unknown').catch(err => {
    console.error('[SOS REST] Push notification error:', err);
  });

  // Also notify the reporter's own parents directly (never done today —
  // family members otherwise have no way to know a child triggered an
  // SOS). Deliberately NOT done on the duress-check path — that must stay
  // dispatch-only, notifying family there could tip off a coerced person's
  // own device.
  if (alert.reporterId) {
    const parentIds = getFamilyParentIds(alert.reporterId).filter(id => id !== alert.reporterId);
    if (parentIds.length > 0) {
      sendFamilyPush(
        parentIds,
        `🚨 SOS de ${userName || 'votre enfant'}`,
        `Alerte déclenchée${alert.location?.address ? ' — ' + alert.location.address : ''}`,
        { type: 'family_sos', alertId: alert.id },
        { priority: 'high' }
      ).catch(() => {});
    }
  }

  console.log(`[SOS REST] Alert ${alert.id} created and broadcast to ${wss.clients.size} clients`);
  res.json({ success: true, alertId: alert.id, broadcast: true });
});

// POST /api/family/quick-alert — non-emergency family-initiated alerts
// ("je ne me sens pas bien" / colis suspect). Unlike /api/sos this doesn't
// need the no-auth emergency exception, so it's a normal requireAuth route.
// Mirrors /api/sos's alert-construction, fixed at severity 'medium'.
app.post('/api/family/quick-alert', requireAuth, async (req, res) => {
  const { type, description, location } = req.body;
  if (type !== 'malaise' && type !== 'colis_suspect') {
    return res.status(400).json({ error: "type doit être 'malaise' ou 'colis_suspect'" });
  }
  const caller = req.supabaseUser!;
  const userName = adminUsers.get(caller.id)?.name || caller.id;

  const alert: Alert = {
    id: await generateIncidentId(type, userName, location || {}),
    type,
    severity: 'medium',
    location: location || { latitude: 0, longitude: 0, address: 'Unknown' },
    description: description || (type === 'malaise' ? `${userName} ne se sent pas bien` : `Colis suspect signalé par ${userName}`),
    createdBy: userName,
    reporterId: caller.id,
    organizationId: caller.organizationId,
    origin: 'mobile',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
    photos: [],
  };

  alerts.set(alert.id, alert);
  linkPossibleDuplicates(alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[QuickAlert] Supabase save error:', e));
  addAuditEntry('incident', 'Quick Alert Created', caller.id, `${INCIDENT_TYPE_LABELS[type]} ${alert.id}: ${alert.location.address}`, undefined, alert.organizationId);

  broadcastToOrg(alert.organizationId, { type: 'newAlert', data: alert });
  sendPushToDispatchersAndResponders(alert, userName).catch(err => console.error('[QuickAlert] Push error:', err));

  // A non-emergency medical signal from a minor is still worth telling a
  // parent about directly, same rationale as the SOS parent-notification
  // above — "colis suspect" doesn't need this, it's not about the reporter.
  if (type === 'malaise') {
    const parentIds = getFamilyParentIds(caller.id).filter(id => id !== caller.id);
    if (parentIds.length > 0) {
      sendFamilyPush(
        parentIds,
        `⚕️ ${userName} ne se sent pas bien`,
        alert.location.address && alert.location.address !== 'Unknown' ? `Position : ${alert.location.address}` : 'Signalement envoyé à votre équipe sécurité.',
        { type: 'family_malaise', alertId: alert.id },
        { priority: 'high' }
      ).catch(() => {});
    }
  }

  res.json({ success: true, alertId: alert.id });
});

// ─── Alert Photo Upload ──────────────────────────────────────────────
// Upload photos to an existing alert (called after alert creation)
app.post('/api/alerts/:id/photos', requireAuth, upload.array('photos', 4), async (req: any, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const photoUrls: string[] = await Promise.all(req.files.map((f: any) => uploadFileToSupabaseStorage(f)));
  if (!alert.photos) alert.photos = [];
  alert.photos.push(...photoUrls);
  persistAlerts();

  console.log(`[Alert Photos] ${photoUrls.length} photo(s) uploaded to alert ${alert.id}`);

  // Broadcast photo update to all connected clients
  broadcastToOrg(alert.organizationId, { type: 'alertPhotosUpdated', data: { alertId: alert.id, photos: alert.photos } });

  res.json({ success: true, photos: alert.photos });
});

// GET alert photos
app.get('/api/alerts/:id/photos', requireAuth, (req, res) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  res.json({ photos: alert.photos || [] });
});

// ─── Location REST API (reliable fallback for mobile app) ────────────
// This endpoint lets the mobile app send location updates via HTTP POST
// when WebSocket is not connected or unreliable (e.g. Expo Go on real devices).
app.post('/api/location', requireAuth, (req, res) => {
  const { latitude, longitude } = req.body;
  const userId = req.supabaseUser!.id;
  const userRole = req.supabaseUser!.role;
  console.log(`[Location REST] Received from userId=${userId} (${userRole}): lat=${latitude}, lng=${longitude}`);
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'latitude and longitude required' });
  }
  const locationData = { latitude: Number(latitude), longitude: Number(longitude) };
  // Reuse the same handler as WebSocket
  handleLocationUpdate(null as any, userId, userRole, locationData);
  sharingUsers.add(userId);
  console.log(`[Location REST] Processed for ${userId}, now in users map: ${users.has(userId)}, sharing: true`);
  res.json({ success: true, userId, location: locationData, timestamp: Date.now() });
});

// ─── Location TTL Cleanup ─────────────────────────────────────────────
// Periodically clean up stale location-sharing users
setInterval(() => {
  const now = Date.now();
  const staleUsers: string[] = [];
  sharingUsers.forEach(userId => {
    const user = users.get(userId);
    if (!user || !user.lastSeen || (now - user.lastSeen > LOCATION_TTL_MS)) {
      staleUsers.push(userId);
    }
  });
  staleUsers.forEach(userId => {
    console.log(`[Location TTL] Removing stale user ${userId} (no update for ${LOCATION_TTL_MS/1000}s)`);
    sharingUsers.delete(userId);
    // Don't delete from users map entirely (they may still be connected), just clear location
    const user = users.get(userId);
    if (user) {
      user.location = undefined;
      users.set(userId, user);
    }
    broadcastToOrgRole(adminUsers.get(userId)?.organizationId, 'dispatcher', {
      type: 'userLocationRemoved',
      userId,
      timestamp: Date.now(),
    });
  });
  if (staleUsers.length > 0) {
    console.log(`[Location TTL] Cleaned up ${staleUsers.length} stale users`);
  }
}, 15000);

// Stop sharing location - shared handler
function handleStopSharing(userId: string, res: any) {
  console.log(`[Location REST] Stop sharing from userId=${userId}`);
  if (!userId) {
    return res.status(400).json({ error: 'userId required' });
  }
  // Remove user from sharing set and clear their location
  sharingUsers.delete(userId);
  const user = users.get(userId);
  if (user) {
    user.location = undefined;
    users.set(userId, user);
  }
  console.log(`[Location REST] Removed ${userId} from users map entirely`);
  // Broadcast removal to dispatchers so they remove the marker
  broadcastToOrgRole(adminUsers.get(userId)?.organizationId, 'dispatcher', {
    type: 'userLocationRemoved',
    userId,
    timestamp: Date.now(),
  });
  res.json({ success: true, userId, timestamp: Date.now() });
}

// DELETE /api/location - supports body or query param. Previously took
// userId from the client with no auth, letting anyone erase anyone's
// shared location — for a security company, silently hiding someone's
// live position is as serious as a spoofing bug.
app.delete('/api/location', requireAuth, (req, res) => {
  handleStopSharing(req.supabaseUser!.id, res);
});

// POST /api/location/stop - more reliable alternative for mobile clients
app.post('/api/location/stop', requireAuth, (req, res) => {
  handleStopSharing(req.supabaseUser!.id, res);
});

// GET /api/location/live-count - number of users currently sharing location,
// scoped to the caller's own organization (previously listed every sharing
// user's id platform-wide, unauthenticated).
app.get('/api/location/live-count', requireAuth, (req, res) => {
  const orgUserIds = Array.from(sharingUsers).filter(uid => canAccessOrg(req.supabaseUser!, adminUsers.get(uid)?.organizationId));
  res.json({ count: orgUserIds.length, userIds: orgUserIds });
});

// GET /api/family/locations - get locations of family members for a given user
app.get('/api/family/locations', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canAccessFamilyMemberData(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const familyIds = getFamilyMemberIds(userId);
  const familyLocations = familyIds
    .map(fid => {
      const u = users.get(fid);
      const adminUser = adminUsers.get(fid);
      const rel = adminUsers.get(userId)?.relationships?.find(r => r.userId === fid);
      if (!u || !u.location) return null;
      if (!sharesLocationWithFamily(adminUser)) return null;
      return {
        userId: fid,
        userName: adminUser?.name || fid,
        relationship: rel?.type || 'family',
        latitude: u.location.latitude,
        longitude: u.location.longitude,
        lastSeen: u.lastSeen || Date.now(),
      };
    })
    .filter(Boolean);
  res.json({ familyMembers: familyIds.length, locations: familyLocations });
});

// GET /api/family/members - get family member info for a given user (no location required)
app.get('/api/family/members', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canAccessFamilyMemberData(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const adminUser = adminUsers.get(userId);
  if (!adminUser) return res.status(404).json({ error: 'User not found' });
  const familyTypes = ['parent', 'child', 'sibling', 'spouse'];
  const members = (adminUser.relationships || [])
    .filter(r => familyTypes.includes(r.type))
    .map(r => {
      const relUser = adminUsers.get(r.userId);
      const isSharing = sharingUsers.has(r.userId);
      const runtimeUser = users.get(r.userId);
      // Family always sees the live automatic status regardless of Ghost mode
      // — Ghost only hides a user from dispatch's live map, never from family.
      // shareLocationWithFamily is the separate, family-facing consent switch:
      // when explicitly off, mask location/presence the same way an unknown
      // location renders today (member still listed, just no position/status).
      const sharesLocation = sharesLocationWithFamily(relUser);
      const presence = sharesLocation ? computeEffectivePresence(r.userId, false) : null;
      return {
        userId: r.userId,
        name: relUser?.name || 'Unknown',
        relationship: r.type,
        isSharing,
        lastSeen: sharesLocation ? (runtimeUser?.lastSeen || null) : null,
        location: sharesLocation ? (runtimeUser?.location || null) : null,
        presenceStatus: presence?.status || 'unknown',
        presenceLabel: presence?.matchedLabel,
        presenceSetAt: presence?.setAt,
        uiProfile: relUser?.uiProfile || 'standard',
        // Persisted consent toggle, as opposed to `isSharing` above (a
        // runtime "is this device actively transmitting right now" flag) —
        // this is what a parent's location-sharing switch on an 'ado'
        // account should reflect and control.
        shareLocationWithFamily: relUser?.shareLocationWithFamily !== false,
      };
    });
  res.json(members);
});

// GET /api/family/parent-contacts?userId= - phone numbers for the 'enfant'
// simplified UI's "call a parent" screen. A narrow, purpose-built route
// rather than adding phone numbers to GET /api/family/members generally,
// which would leak them into every other view of the family list.
app.get('/api/family/parent-contacts', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canAccessFamilyMemberData(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const parentIds = getFamilyParentIds(userId);
  const contacts = parentIds
    .map(id => {
      const p = adminUsers.get(id);
      const phone = p?.phoneMobile || p?.phoneLandline;
      if (!p || !phone) return null;
      return { userId: id, name: p.name, phone };
    })
    .filter((c): c is { userId: string; name: string; phone: string } => c !== null);
  res.json(contacts);
});

// GET /api/family/presence/:userId - this is the "what is currently being
// communicated externally" view (i.e. what dispatch would see: automatic
// unless Ghost mode is on, in which case the manual override). Used by the
// mobile app to show the caller their OWN effective status so the manual
// toggle makes sense — pressing it only matters while in Ghost, and this
// tells them whether it currently does. The family member list uses
// computeEffectivePresence(id, false) instead, since family always sees the
// live automatic value regardless of Ghost.
app.get('/api/family/presence/:userId', requireAuth, (req, res) => {
  const targetUserId = req.params.userId as string;
  const caller = req.supabaseUser!;
  const isSelf = caller.id === targetUserId;
  const isFamilyMember = getFamilyMemberIds(targetUserId).includes(caller.id);
  const isStaff = (caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder') && canAccessOrg(caller, adminUsers.get(targetUserId)?.organizationId);
  if (!isSelf && !isFamilyMember && !isStaff) return res.status(403).json({ error: 'Not authorized' });
  const presence = computeEffectivePresence(targetUserId, true);
  res.json(presence);
});

// PUT /api/family/presence/:targetUserId - set a manual presence override.
// Allowed for the target themselves, a family owner (reciprocal relation),
// or dispatch/admin/responder staff.
app.put('/api/family/presence/:targetUserId', requireAuth, (req, res) => {
  const targetUserId = req.params.targetUserId as string;
  const { status, placeLabel } = req.body;
  if (status !== 'inside' && status !== 'outside' && status !== 'auto') {
    return res.status(400).json({ error: "status must be 'inside', 'outside', or 'auto'" });
  }
  if (status === 'inside' && !placeLabel) {
    return res.status(400).json({ error: 'placeLabel is required when marking someone present — pick which registered address' });
  }
  const caller = req.supabaseUser!;
  const isSelf = caller.id === targetUserId;
  const isFamilyOwner = getFamilyMemberIds(targetUserId).includes(caller.id);
  const isStaff = (caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder') && canAccessOrg(caller, adminUsers.get(targetUserId)?.organizationId);
  if (!isSelf && !isFamilyOwner && !isStaff) {
    return res.status(403).json({ error: 'Not authorized to set this presence status' });
  }
  const name = adminUsers.get(targetUserId)?.name || targetUserId;
  // Captured before mutating anything, so we can tell whether this call actually
  // flips the status (vs. re-setting the same one) before paging staff about it.
  const previousStatus = computeEffectivePresence(targetUserId, true).status;

  if (status === 'auto') {
    // Clear the manual override, handing control back to the live automatic computation.
    manualPresence.delete(targetUserId);
    persistManualPresence();
    deleteManualPresenceFromSupabase(targetUserId).catch(() => {});
    const payload = { type: 'presenceUpdated', targetUserId, name, status: 'auto', setBy: caller.id, setAt: Date.now() };
    const presenceOrgId = adminUsers.get(targetUserId)?.organizationId;
    broadcastToOrgRole(presenceOrgId, 'dispatcher', payload);
    broadcastToOrgRole(presenceOrgId, 'admin', payload);
    broadcastToOrgRole(presenceOrgId, 'responder', payload);
    broadcastToUsers(getFamilyParentIds(targetUserId).filter(id => id !== targetUserId), payload);
    return res.json({ success: true });
  }

  const entry: PresenceManualStatus = { status, placeLabel: status === 'inside' ? placeLabel : undefined, setBy: caller.id, setAt: Date.now() };
  manualPresence.set(targetUserId, entry);
  if (status === 'inside') {
    // Keep the automatic-state cache in sync so "the last known place" is
    // still correct if this later reverts to automatic.
    autoPresenceState.set(targetUserId, { status: 'inside', label: placeLabel, since: entry.setAt });
    persistAutoPresenceState();
  }
  persistManualPresence();
  const matchedLabel = status === 'inside' ? placeLabel : autoPresenceState.get(targetUserId)?.label;
  const payload = { type: 'presenceUpdated', targetUserId, name, status: entry.status, matchedLabel, setBy: entry.setBy, setAt: entry.setAt };
  const presenceOrgId2 = adminUsers.get(targetUserId)?.organizationId;
  broadcastToOrgRole(presenceOrgId2, 'dispatcher', payload);
  broadcastToOrgRole(presenceOrgId2, 'admin', payload);
  broadcastToOrgRole(presenceOrgId2, 'responder', payload);
  broadcastToUsers(getFamilyParentIds(targetUserId).filter(id => id !== targetUserId), payload);
  if (previousStatus !== entry.status) {
    notifyPresenceChangePush(name, entry.status, matchedLabel, isStaff ? caller.id : undefined, getFamilyParentIds(targetUserId).filter(id => id !== targetUserId), presenceOrgId2).catch(() => {});
  }
  res.json({ success: true });
});

// POST /api/presence/geofence-event - reports a native geofence enter/exit for
// one of the caller's own registered addresses. Called directly from a
// headless background TaskManager task (services/presence-geofence-task.ts),
// not through the WebSocket/app-foreground location pipeline, so this is what
// makes auto presence keep updating even with the app fully closed (subject
// to iOS/Android's own constraints on background execution after a user
// force-quits the app - no client-side trick can override that).
// Sets the AUTOMATIC layer only; a manual override (PUT above) still wins
// via computeEffectivePresence regardless of what this reports.
app.post('/api/presence/geofence-event', requireAuth, (req, res) => {
  const userId = req.supabaseUser!.id;
  const { addressId, eventType } = req.body;
  if (!addressId || (eventType !== 'enter' && eventType !== 'exit')) {
    return res.status(400).json({ error: "addressId and eventType ('enter'|'exit') required" });
  }
  const address = (userAddresses.get(userId) || []).find(a => a.id === addressId);
  if (!address) return res.status(404).json({ error: 'Address not found for this user' });

  const prevState = autoPresenceState.get(userId);
  const result: { status: 'inside' | 'outside'; matchedLabel?: string } = eventType === 'enter'
    ? { status: 'inside', matchedLabel: address.label }
    : { status: 'outside', matchedLabel: prevState?.label };

  applyAutoPresenceResult(userId, result, prevState);
  console.log(`[Presence] Geofence ${eventType} for ${adminUsers.get(userId)?.name || userId} @ ${address.label}`);
  res.json({ success: true, status: result.status, matchedLabel: result.matchedLabel });
});

// ─── Family Perimeter CRUD ───────────────────────────────────────────

// GET /api/family/perimeters - list perimeters for a user (owner)
app.get('/api/family/perimeters', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canAccessOwnedRecord({ ownerId: userId }, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const userPerimeters = Array.from(familyPerimeters.values())
    .filter(p => p.ownerId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(userPerimeters);
});

// POST /api/family/perimeters - create a new perimeter
app.post('/api/family/perimeters', requireAuth, (req, res) => {
  const { ownerId, targetUserId, center, radiusMeters } = req.body;
  if (!ownerId || !targetUserId || !center?.latitude || !center?.longitude || !radiusMeters) {
    return res.status(400).json({ error: 'ownerId, targetUserId, center {latitude, longitude}, and radiusMeters required' });
  }
  if (!canAccessOwnedRecord({ ownerId }, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  // Verify the target is a family member of the owner
  const familyIds = getFamilyMemberIds(ownerId);
  if (!familyIds.includes(targetUserId)) {
    return res.status(403).json({ error: 'Target user is not a family member' });
  }
  const targetAdmin = adminUsers.get(targetUserId);
  const perimeter: FamilyPerimeter = {
    id: uuidv4(),
    ownerId,
    targetUserId,
    targetUserName: targetAdmin?.name || targetUserId,
    center: { latitude: center.latitude, longitude: center.longitude, address: center.address || undefined },
    radiusMeters: Number(radiusMeters),
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  familyPerimeters.set(perimeter.id, perimeter);
  persistPerimeters();
  console.log(`[Perimeter] Created ${perimeter.id} for ${targetAdmin?.name || targetUserId} by ${ownerId} (${radiusMeters}m)`);
  res.json(perimeter);
});

// PUT /api/family/perimeters/:id - update a perimeter
app.put('/api/family/perimeters/:id', requireAuth, (req, res) => {
  const perimeter = familyPerimeters.get(req.params.id as string);
  if (!perimeter) return res.status(404).json({ error: 'Perimeter not found' });
  if (!canAccessOwnedRecord(perimeter, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const { center, radiusMeters, active } = req.body;
  if (center) {
    perimeter.center = { latitude: center.latitude, longitude: center.longitude, address: center.address || perimeter.center.address };
  }
  if (radiusMeters != null) perimeter.radiusMeters = Number(radiusMeters);
  if (active != null) perimeter.active = Boolean(active);
  perimeter.updatedAt = Date.now();
  familyPerimeters.set(perimeter.id, perimeter);
  persistPerimeters();
  res.json(perimeter);
});

// DELETE /api/family/perimeters/:id - delete a perimeter
app.delete('/api/family/perimeters/:id', requireAuth, (req, res) => {
  const perimeterId = req.params.id as string;
  const perimeter = familyPerimeters.get(perimeterId);
  if (!perimeter) return res.status(404).json({ error: 'Perimeter not found' });
  if (!canAccessOwnedRecord(perimeter, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const existed = familyPerimeters.delete(perimeterId);
  if (existed) deleteFamilyPerimeterFromSupabase(perimeterId);
  perimeterState.delete(perimeterId);
  if (existed) persistPerimeters();
  res.json({ success: existed });
});

// GET /api/family/curfew-checks - list a user's curfew checks (owner)
app.get('/api/family/curfew-checks', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canAccessOwnedRecord({ ownerId: userId }, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const userChecks = Array.from(curfewChecks.values())
    .filter(c => c.ownerId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(userChecks);
});

// POST /api/family/curfew-checks - create a one-off or daily curfew check
app.post('/api/family/curfew-checks', requireAuth, (req, res) => {
  const { ownerId, targetUserId, center, radiusMeters, hour, minute, recurrence, alertWhen } = req.body;
  if (!ownerId || !targetUserId || !center?.latitude || !center?.longitude || !radiusMeters) {
    return res.status(400).json({ error: 'ownerId, targetUserId, center {latitude, longitude}, and radiusMeters required' });
  }
  if (!canAccessOwnedRecord({ ownerId }, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  if (hour == null || minute == null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return res.status(400).json({ error: 'hour (0-23) and minute (0-59) required' });
  }
  if (recurrence !== 'once' && recurrence !== 'daily') {
    return res.status(400).json({ error: "recurrence must be 'once' or 'daily'" });
  }
  if (alertWhen != null && !['exit', 'entry', 'both'].includes(alertWhen)) {
    return res.status(400).json({ error: "alertWhen must be 'exit', 'entry', or 'both'" });
  }
  const familyIds = getFamilyMemberIds(ownerId);
  if (!familyIds.includes(targetUserId)) {
    return res.status(403).json({ error: 'Target user is not a family member' });
  }
  const targetAdmin = adminUsers.get(targetUserId);
  const check: CurfewCheck = {
    id: uuidv4(),
    ownerId,
    targetUserId,
    targetUserName: targetAdmin?.name || targetUserId,
    center: { latitude: center.latitude, longitude: center.longitude, address: center.address || undefined },
    radiusMeters: Number(radiusMeters),
    hour: Number(hour),
    minute: Number(minute),
    recurrence,
    alertWhen: alertWhen || 'exit',
    nextCheckAt: computeNextOccurrence(Number(hour), Number(minute)),
    active: true,
    createdAt: Date.now(),
  };
  curfewChecks.set(check.id, check);
  persistCurfewChecks();
  scheduleCurfewCheck(check);
  console.log(`[Curfew] Created ${check.id} for ${check.targetUserName} by ${ownerId} at ${hour}:${String(minute).padStart(2, '0')} (${recurrence})`);
  res.json(check);
});

// DELETE /api/family/curfew-checks/:id - cancel a curfew check
app.delete('/api/family/curfew-checks/:id', requireAuth, (req, res) => {
  const checkId = req.params.id as string;
  const check = curfewChecks.get(checkId);
  if (!check) return res.status(404).json({ error: 'Curfew check not found' });
  if (!canAccessOwnedRecord(check, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  clearCurfewTimer(checkId);
  const existed = curfewChecks.delete(checkId);
  if (existed) persistCurfewChecks();
  res.json({ success: existed });
});

// GET /api/family/checkins?userId= - list scheduled check-ins owned by a user
app.get('/api/family/checkins', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canAccessFamilyMemberData(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const userCheckIns = Array.from(scheduledCheckIns.values())
    .filter(c => c.ownerId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(userCheckIns);
});

// POST /api/family/checkins - create a scheduled check-in (dead-man's switch)
app.post('/api/family/checkins', requireAuth, (req, res) => {
  // ownerId always comes from the authenticated caller, never the request body
  // — this both closes a pre-existing gap (any caller could previously name
  // an arbitrary ownerId as long as targetUserId was in THAT owner's family)
  // and lets dispatch/admin staff request a check-in from any user without
  // needing to know or spoof a family relationship.
  const caller = req.supabaseUser!;
  const ownerId = caller.id;
  const { targetUserId, dueAt, graceMinutes, recurrence, hour, minute } = req.body;
  if (!targetUserId || !dueAt) {
    return res.status(400).json({ error: 'targetUserId and dueAt required' });
  }
  const isDispatchStaff = caller.role === 'dispatcher' || caller.role === 'admin';
  const familyIds = getFamilyMemberIds(ownerId);
  if (!isDispatchStaff && !familyIds.includes(targetUserId)) {
    return res.status(403).json({ error: 'Target user is not a family member' });
  }
  const isRecurring = recurrence === 'daily';
  if (isRecurring && (hour == null || minute == null)) {
    return res.status(400).json({ error: 'hour and minute required for a recurring check-in' });
  }
  const targetAdmin = adminUsers.get(targetUserId);
  const checkIn: ScheduledCheckIn = {
    id: uuidv4(),
    ownerId,
    targetUserId,
    targetUserName: targetAdmin?.name || targetUserId,
    dueAt: Number(dueAt),
    graceMinutes: graceMinutes != null ? Number(graceMinutes) : 30,
    status: 'pending',
    nextFireAt: Number(dueAt),
    stage: 'due',
    createdAt: Date.now(),
    recurrence: isRecurring ? 'daily' : 'once',
    ...(isRecurring ? { hour: Number(hour), minute: Number(minute) } : {}),
  };
  scheduledCheckIns.set(checkIn.id, checkIn);
  persistCheckIns();
  scheduleCheckIn(checkIn);
  console.log(`[CheckIn] Created ${checkIn.id} for ${checkIn.targetUserName} by ${ownerId}, due ${new Date(checkIn.dueAt).toISOString()}`);
  res.json(checkIn);
});

// POST /api/family/checkins/:id/confirm - the target user confirms they're safe
app.post('/api/family/checkins/:id/confirm', requireAuth, (req, res) => {
  const checkIn = scheduledCheckIns.get(req.params.id as string);
  if (!checkIn) return res.status(404).json({ error: 'Check-in not found' });
  const caller = req.supabaseUser!;
  if (caller.id !== checkIn.targetUserId) return res.status(403).json({ error: 'Not authorized' });
  if (checkIn.status === 'confirmed' || checkIn.status === 'cancelled') return res.json(checkIn);
  clearCheckInTimer(checkIn.id);
  checkIn.status = 'confirmed';
  checkIn.confirmedAt = Date.now();
  scheduledCheckIns.set(checkIn.id, checkIn);
  persistCheckIns();
  rescheduleIfRecurring(checkIn);
  res.json(checkIn);
});

// DELETE /api/family/checkins/:id - cancel a scheduled check-in
app.delete('/api/family/checkins/:id', requireAuth, (req, res) => {
  clearCheckInTimer(req.params.id as string);
  const existed = scheduledCheckIns.delete(req.params.id as string);
  if (existed) persistCheckIns();
  res.json({ success: existed });
});

// GET /api/family/proximity-alerts - get proximity alerts for a user (owner)
app.get('/api/family/proximity-alerts', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canAccessFamilyMemberData(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const userAlerts = proximityAlerts
    .filter(a => a.ownerId === userId)
    .slice(0, limit);
  res.json(userAlerts);
});

// PUT /api/family/proximity-alerts/:id/acknowledge
app.put('/api/family/proximity-alerts/:id/acknowledge', requireAuth, (req, res) => {
  const alert = proximityAlerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (!canAccessFamilyMemberData(alert.ownerId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  alert.acknowledged = true;
  persistProximityAlerts();
  res.json({ success: true });
});

// A raw GPS ping every few minutes isn't useful to read — collapse the
// history into "entered X" / "left X" transitions against the target's known
// addresses, which is what a family member actually wants ("where did they
// go and when"), not a dense stream of coordinates.
interface LocationEvent {
  type: 'entered' | 'left';
  label: string;
  timestamp: number;
  latitude: number;
  longitude: number;
}

function computeLocationEvents(targetUserId: string, history: LocationHistoryEntry[]): LocationEvent[] {
  const now = Date.now();
  const addresses = (userAddresses.get(targetUserId) || []).filter(a => !a.temporary || !a.expiresAt || a.expiresAt > now);
  const events: LocationEvent[] = [];
  let previousAddr: UserAddress | null = null;
  for (const point of history) {
    const matched = addresses.find(a =>
      a.latitude != null && a.longitude != null &&
      haversineDistance(point.latitude, point.longitude, a.latitude, a.longitude) <= (a.radiusMeters || 150)
    ) || null;
    if ((matched?.id || null) !== (previousAddr?.id || null)) {
      if (matched) {
        events.push({ type: 'entered', label: matched.label, timestamp: point.timestamp, latitude: point.latitude, longitude: point.longitude });
      } else if (previousAddr) {
        events.push({ type: 'left', label: previousAddr.label, timestamp: point.timestamp, latitude: point.latitude, longitude: point.longitude });
      }
      previousAddr = matched;
    }
  }
  return events;
}

// GET /api/family/location-history - entry/exit events (not raw pings) for a family member
app.get('/api/family/location-history', requireAuth, (req, res) => {
  const targetUserId = req.query.targetUserId as string;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
  if (!canAccessFamilyMemberData(targetUserId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const history = locationHistory.get(targetUserId) || [];
  const since = Number(req.query.since) || 0;
  const filtered = since > 0 ? history.filter(h => h.timestamp >= since) : history;
  const events = computeLocationEvents(targetUserId, filtered);
  res.json(events.slice(-200));
});

// ─── Admin REST API ──────────────────────────────────────────────

// ─── Health check helpers ─────────────────────────────────────────────────
async function checkSupabaseHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  try {
    const { error } = await supabaseAdmin.from('admin_users').select('id').limit(1);
    if (error) return { ok: false, error: error.message };
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function checkLiveKitHealth(): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  const start = Date.now();
  const url = process.env.LIVEKIT_URL;
  if (!url) return { ok: false, error: 'LIVEKIT_URL not configured' };
  try {
    const httpUrl = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    const res = await fetch(httpUrl, { signal: AbortSignal.timeout(5000) });
    return { ok: res.ok, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// Responders/dispatchers who are supposedly on duty but haven't sent a
// location ping in a while — usually means the app crashed, was killed, or
// lost connectivity without anyone noticing yet.
const STALE_DEVICE_THRESHOLD_MS = 10 * 60 * 1000;
function computeStaleDevices(): { userId: string; name: string; role: string; lastSeenMinutesAgo: number }[] {
  const now = Date.now();
  const stale: { userId: string; name: string; role: string; lastSeenMinutesAgo: number }[] = [];
  for (const [userId, user] of users) {
    const isTrackedRole = user.role === 'responder' || user.role === 'dispatcher';
    const shouldBeActive = isTrackedRole && (user.status === 'on_duty' || user.status === 'available' || user.status === 'responding');
    if (shouldBeActive && user.lastSeen && (now - user.lastSeen) > STALE_DEVICE_THRESHOLD_MS) {
      stale.push({
        userId,
        name: adminUsers.get(userId)?.name || userId,
        role: user.role,
        lastSeenMinutesAgo: Math.round((now - user.lastSeen) / 60000),
      });
    }
  }
  return stale.sort((a, b) => b.lastSeenMinutesAgo - a.lastSeenMinutesAgo);
}

// Admin health (extended) — staff-only (dispatcher or admin), since this now
// surfaces recent server error messages/stack traces alongside the counts.
app.get('/admin/health', requireAuth, requireRole('dispatcher'), async (req, res) => {
  const [supabaseHealth, livekitHealth] = await Promise.all([checkSupabaseHealth(), checkLiveKitHealth()]);
  const caller = req.supabaseUser!;
  // Tenant data (who/what belongs to an organization) is scoped for a plain
  // admin, global only for superadmin. Infra facts about the Node process
  // itself (memory, uptime, ws/supabase/livekit connectivity, stale device
  // count) aren't tenant data — scoping them would only reduce their value
  // as a diagnostic for an org admin without protecting anything. The error
  // log can contain details from any organization's requests, so it's
  // superadmin-only rather than partially filtered.
  const orgUsers = Array.from(adminUsers.values()).filter(u => canAccessOrg(caller, u.organizationId));
  const orgAlerts = Array.from(alerts.values()).filter(a => canAccessOrg(caller, a.organizationId));
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    connectedUsers: userConnections.size,
    totalUsers: orgUsers.length,
    activeAlerts: orgAlerts.filter(a => a.status === 'active').length,
    totalAlerts: orgAlerts.length,
    wsClients: wss.clients.size,
    supabase: supabaseHealth,
    livekit: livekitHealth,
    staleDevices: computeStaleDevices(),
    recentErrors: caller.role === 'superadmin' ? recentErrors.slice(0, 50) : [],
    timestamp: Date.now(),
  });
});

// ─── Operational KPIs (point 6, "think like Palantir") ───────────────────
// Real response-time metrics, computed from acknowledgedAt/resolvedAt set at
// the moment those transitions actually happen (see the six call sites that
// set alert.status = 'acknowledged'/'resolved') - replaces what used to be a
// randomly-generated fake resolvedAt in /admin/incidents. False-alarm rate
// and per-severity breakdowns use only real, already-tracked status data.
function computeIncidentKPIs(days: number, caller: { role: string; organizationId?: string }) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const relevant = Array.from(alerts.values()).filter(a => a.createdAt >= since && canAccessOrg(caller, a.organizationId));

  const bySeverity: Record<string, { count: number; ackTimes: number[]; resolveTimes: number[] }> = {};
  let cancelledCount = 0;
  const byStatus: Record<string, number> = {};

  for (const a of relevant) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1;
    if (a.status === 'cancelled') cancelledCount++;

    if (!bySeverity[a.severity]) bySeverity[a.severity] = { count: 0, ackTimes: [], resolveTimes: [] };
    const bucket = bySeverity[a.severity];
    bucket.count++;
    if (a.acknowledgedAt) bucket.ackTimes.push(a.acknowledgedAt - a.createdAt);
    if (a.resolvedAt) bucket.resolveTimes.push(a.resolvedAt - a.createdAt);
  }

  const avg = (nums: number[]) => nums.length === 0 ? null : Math.round(nums.reduce((s, n) => s + n, 0) / nums.length);

  const bySeverityOut: Record<string, { count: number; avgTimeToAcknowledgeMs: number | null; avgTimeToResolveMs: number | null }> = {};
  for (const [severity, bucket] of Object.entries(bySeverity)) {
    bySeverityOut[severity] = {
      count: bucket.count,
      avgTimeToAcknowledgeMs: avg(bucket.ackTimes),
      avgTimeToResolveMs: avg(bucket.resolveTimes),
    };
  }

  return {
    periodDays: days,
    totalIncidents: relevant.length,
    falseAlarmRate: relevant.length > 0 ? cancelledCount / relevant.length : 0,
    incidentsByStatus: byStatus,
    incidentsBySeverity: bySeverityOut,
  };
}

app.get('/admin/kpis', requireAuth, requireRole('dispatcher'), (req, res) => {
  const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
  res.json(computeIncidentKPIs(days, req.supabaseUser!));
});

// Admin users list
app.get('/admin/users', requireAuth, requireRole('admin'), (req, res) => {
  const users = Array.from(adminUsers.values())
    .filter(u => canAccessOrg(req.supabaseUser!, u.organizationId))
    .map(u => {
      const { passwordHash, ...safeUser } = u;
      return { ...safeUser, hasPassword: !!passwordHash };
    });
  res.json(users);
});

// GET /admin/family-groups — every family unit with its stable assignment id
// (getFamilyGroupId) and member names, for the "Familles assignées" picker in
// a dispatcher/responder's user drawer (see canAccessFamily).
app.get('/admin/family-groups', requireAuth, requireRole('admin'), (req, res) => {
  const caller = req.supabaseUser!;
  const groups = computeFamilyGroups()
    .filter(memberIds => canAccessUser(caller, memberIds[0]))
    .map(memberIds => ({
      id: getFamilyGroupId(memberIds[0]),
      memberNames: memberIds.map(uid => adminUsers.get(uid)?.name || uid),
    }));
  res.json(groups);
});

// Admin change user role
app.put('/admin/users/:id/role', requireAuth, requireRole('admin'), (req, res) => {
  const user = adminUsers.get(req.params.id as string);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const { role } = req.body;
  const allowedRoles = req.supabaseUser!.role === 'superadmin'
    ? ['superadmin', 'admin', 'dispatcher', 'responder', 'user']
    : ['admin', 'dispatcher', 'responder', 'user'];
  if (!allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const oldRole = user.role;
  user.role = role;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry('user', 'Role Changed', 'Admin', `Role changed from ${oldRole} to ${role}`, user.name, user.organizationId);
  res.json({ success: true });
});

// Admin change user status
app.put('/admin/users/:id/status', requireAuth, requireRole('admin'), (req, res) => {
  const user = adminUsers.get(req.params.id as string);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const { status } = req.body;
  if (!['active', 'suspended', 'deactivated'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const oldStatus = user.status;
  user.status = status;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  const actionName = status === 'suspended' ? 'User Suspended' : status === 'deactivated' ? 'User Deactivated' : 'User Reactivated';
  addAuditEntry('user', actionName, 'Admin', `Status changed from ${oldStatus} to ${status}`, user.name, user.organizationId);
  res.json({ success: true });
});

// ─── Admin User CRUD ─────────────────────────────────────────────────

// GET single user by ID
app.get('/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const user = adminUsers.get(req.params.id as string);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  // Resolve relationship names
  const enrichedRelationships = (user.relationships || []).map(r => {
    const relUser = adminUsers.get(r.userId);
    return { ...r, userName: relUser?.name || r.userId, relatedUser: relUser ? { name: relUser.name, role: relUser.role, email: relUser.email } : null };
  });
  // Find users at same address
  const sameAddress: { id: string; name: string; role: string }[] = [];
  if (user.address) {
    adminUsers.forEach(u => {
      if (u.id !== user.id && u.address && u.address === user.address) {
        sameAddress.push({ id: u.id, name: u.name, role: u.role });
      }
    });
  }
  const { passwordHash, ...safeUser } = user;
  res.json({ ...safeUser, hasPassword: !!passwordHash, relationships: enrichedRelationships, sameAddress });
});

// POST create new user
app.post('/admin/users', requireAuth, requireRole('admin'), async (req, res) => {
  const { firstName, lastName, email, role, tags, address, addressComponents, phoneLandline, phoneMobile, comments, photoUrl, relationships, password } = req.body;
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'firstName, lastName, and email are required' });
  }
  const isSuperadminCaller = req.supabaseUser!.role === 'superadmin';
  const allowedRoles = isSuperadminCaller
    ? ['superadmin', 'admin', 'dispatcher', 'responder', 'user']
    : ['admin', 'dispatcher', 'responder', 'user'];
  if (role && !allowedRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  // An organization admin can only ever create accounts in their own
  // organization — the client can't override this. A superadmin has no
  // organization of their own, so they must pick one explicitly (typically
  // to create an org's first admin), validated against real organizations.
  let organizationId: string | undefined;
  if (isSuperadminCaller) {
    organizationId = req.body.organizationId;
    if (!organizationId || !organizations.has(organizationId)) {
      return res.status(400).json({ error: 'A valid organizationId is required' });
    }
  } else {
    organizationId = req.supabaseUser!.organizationId;
  }
  // Check email uniqueness
  const existing = Array.from(adminUsers.values()).find(u => u.email === email);
  if (existing) {
    return res.status(409).json({ error: 'A user with this email already exists' });
  }

  // ─── Créer le compte Supabase Auth ───────────────────────────────
  let supabaseUserId: string | null = null;
  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: password || Math.random().toString(36).slice(-12), // mot de passe aléatoire si non fourni
      email_confirm: true,
    });
    if (authError) {
  console.error('[Admin] Supabase Auth create error:', authError.message, authError.status);
} else {
  supabaseUserId = authData.user.id;
  console.log('[Admin] Supabase Auth user created:', supabaseUserId);
}
  } catch (e) {
    console.error('[Admin] Supabase Auth import error:', e);
  }

  // Utilise l'UUID Supabase si disponible, sinon génère un ID local
  const id = supabaseUserId || `usr-${uuidv4().slice(0, 8)}`;
  const now = Date.now();
  const newUser: AdminUser = {
    id,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email,
    role: role || 'user',
    status: 'active',
    lastLogin: 0,
    createdAt: now,
    tags: tags || [],
    address: address || '',
    addressComponents: addressComponents || undefined,
    phoneLandline: phoneLandline || '',
    phoneMobile: phoneMobile || '',
    comments: comments || '',
    photoUrl: photoUrl || '',
    relationships: relationships || [],
    passwordHash: password ? bcrypt.hashSync(password, 10) : undefined,
    organizationId,
  };
  adminUsers.set(id, newUser);
  saveAdminUserToSupabase(newUser);
  // Add reciprocal relationships
  (relationships || []).forEach((rel: { userId: string; type: string }) => {
    const relUser = adminUsers.get(rel.userId);
    if (relUser) {
      const reciprocal = getReciprocalRelType(rel.type);
      if (!relUser.relationships) relUser.relationships = [];
      if (!relUser.relationships.find(r => r.userId === id)) {
        relUser.relationships.push({ userId: id, type: reciprocal });
        adminUsers.set(relUser.id, relUser);
      }
    }
  });
  addAuditEntry('user', 'User Created', 'Admin', `New ${role || 'user'}: ${firstName} ${lastName} (${email})`, newUser.name, newUser.organizationId);
  const { passwordHash: _pwh, ...safeNewUser } = newUser;
  res.status(201).json({ ...safeNewUser, hasPassword: !!newUser.passwordHash });
});

// PUT update user
app.put('/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const user = adminUsers.get(req.params.id as string);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const { firstName, lastName, email, role, tags, address, addressComponents, phoneLandline, phoneMobile, comments, photoUrl, relationships, status, password, assignedFamilyIds } = req.body;
  // Check email uniqueness if changed
  if (email && email !== user.email) {
    const existing = Array.from(adminUsers.values()).find(u => u.email === email && u.id !== user.id);
    if (existing) return res.status(409).json({ error: 'A user with this email already exists' });
  }
  const allowedRolesForUpdate = req.supabaseUser!.role === 'superadmin'
    ? ['superadmin', 'admin', 'dispatcher', 'responder', 'user']
    : ['admin', 'dispatcher', 'responder', 'user'];
  if (role && !allowedRolesForUpdate.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const changes: string[] = [];
  if (firstName !== undefined) { user.firstName = firstName; changes.push('firstName'); }
  if (lastName !== undefined) { user.lastName = lastName; changes.push('lastName'); }
  if (firstName !== undefined || lastName !== undefined) {
    user.name = `${user.firstName} ${user.lastName}`;
  }
  if (email !== undefined) { user.email = email; changes.push('email'); }
  if (role !== undefined && role !== user.role) { const old = user.role; user.role = role; changes.push(`role:${old}->${role}`); }
  if (status !== undefined && status !== user.status) { const old = user.status; user.status = status; changes.push(`status:${old}->${status}`); }
  if (tags !== undefined) { user.tags = tags; changes.push('tags'); }
  if (address !== undefined) { user.address = address; changes.push('address'); }
  if (addressComponents !== undefined) { user.addressComponents = addressComponents; }
  if (phoneLandline !== undefined) { user.phoneLandline = phoneLandline; changes.push('phoneLandline'); }
  if (phoneMobile !== undefined) { user.phoneMobile = phoneMobile; changes.push('phoneMobile'); }
  if (comments !== undefined) { user.comments = comments; changes.push('comments'); }
  if (photoUrl !== undefined) { user.photoUrl = photoUrl; changes.push('photo'); }
  if (assignedFamilyIds !== undefined) { user.assignedFamilyIds = assignedFamilyIds; changes.push('assignedFamilyIds'); }
  if (password) { user.passwordHash = bcrypt.hashSync(password, 10); changes.push('password'); }
  if (relationships !== undefined) {
    // Remove old reciprocal relationships
    (user.relationships || []).forEach(oldRel => {
      const relUser = adminUsers.get(oldRel.userId);
      if (relUser && relUser.relationships) {
        relUser.relationships = relUser.relationships.filter(r => r.userId !== user.id);
        adminUsers.set(relUser.id, relUser);
      }
    });
    user.relationships = relationships;
    // Add new reciprocal relationships
    relationships.forEach((rel: { userId: string; type: string }) => {
      const relUser = adminUsers.get(rel.userId);
      if (relUser) {
        const reciprocal = getReciprocalRelType(rel.type);
        if (!relUser.relationships) relUser.relationships = [];
        if (!relUser.relationships.find((r: any) => r.userId === user.id)) {
          relUser.relationships.push({ userId: user.id, type: reciprocal });
          adminUsers.set(relUser.id, relUser);
          saveAdminUserToSupabase(relUser);
        }
      }
    });
    changes.push('relationships');
  }
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry('user', 'User Updated', 'Admin', `Updated: ${changes.join(', ')}`, user.name, user.organizationId);
  const { passwordHash: _pw, ...safeUpdatedUser } = user;
  res.json({ ...safeUpdatedUser, hasPassword: !!user.passwordHash });
});

// DELETE user
app.delete('/admin/users/:id', requireAuth, requireRole('admin'), (req, res) => {
  const user = adminUsers.get(req.params.id as string);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  // Remove reciprocal relationships
  (user.relationships || []).forEach(rel => {
    const relUser = adminUsers.get(rel.userId);
    if (relUser && relUser.relationships) {
      relUser.relationships = relUser.relationships.filter(r => r.userId !== user.id);
      adminUsers.set(relUser.id, relUser);
    }
  });
  adminUsers.delete(user.id);
  deleteAdminUserFromSupabase(user.id);
  addAuditEntry('user', 'User Deleted', 'Admin', `Deleted user: ${user.name} (${user.email})`, user.name, user.organizationId);
  res.json({ success: true, deletedUser: user.name });
});

// GET users at same address
app.get('/admin/users/:id/cohabitants', requireAuth, requireRole('admin'), (req, res) => {
  const user = adminUsers.get(req.params.id as string);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  if (!user.address) return res.json([]);
  const cohabitants: AdminUser[] = [];
  adminUsers.forEach(u => {
    if (u.id !== user.id && u.address && u.address === user.address) {
      cohabitants.push(u);
    }
  });
  res.json(cohabitants);
});

// GET user family/relationships
app.get('/admin/users/:id/relationships', requireAuth, requireRole('admin'), (req, res) => {
  const user = adminUsers.get(req.params.id as string);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const enriched = (user.relationships || []).map(r => {
    const relUser = adminUsers.get(r.userId);
    return { ...r, userName: relUser?.name || 'Unknown', userEmail: relUser?.email || '', userRole: relUser?.role || '' };
  });
  res.json(enriched);
});

// ─── Organizations (superadmin only) ─────────────────────────────────
// Talion-side tenant management — create/list/update the organizations
// that /admin/users' organizationId scoping (above) partitions everyone
// into. requireRole('superadmin') already rejects plain 'admin' callers
// via the level comparison in ROLE_HIERARCHY, no extra check needed.
app.get('/admin/organizations', requireAuth, requireRole('superadmin'), (req, res) => {
  const result = Array.from(organizations.values()).map(o => ({
    ...o,
    memberCount: Array.from(adminUsers.values()).filter(u => u.organizationId === o.id).length,
  }));
  res.json(result);
});

app.post('/admin/organizations', requireAuth, requireRole('superadmin'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const org: Organization = {
    id: uuidv4(),
    name,
    status: 'active',
    createdAt: Date.now(),
  };
  organizations.set(org.id, org);
  saveOrganizationToSupabase(org).catch(e => console.error('[Organizations] Supabase save error:', e));
  addAuditEntry('system', 'Organization Created', req.supabaseUser!.id, `New organization: ${name}`, org.id, org.id);
  res.status(201).json(org);
});

app.put('/admin/organizations/:id', requireAuth, requireRole('superadmin'), (req, res) => {
  const org = organizations.get(req.params.id as string);
  if (!org) return res.status(404).json({ error: 'Organization not found' });
  const { name, status } = req.body;
  if (status !== undefined && status !== 'active' && status !== 'suspended') {
    return res.status(400).json({ error: "status must be 'active' or 'suspended'" });
  }
  if (name !== undefined) org.name = name;
  if (status !== undefined) org.status = status;
  organizations.set(org.id, org);
  saveOrganizationToSupabase(org).catch(e => console.error('[Organizations] Supabase save error:', e));
  addAuditEntry('system', 'Organization Updated', req.supabaseUser!.id, `Organization ${org.id}: ${JSON.stringify({ name, status })}`, org.id, org.id);
  res.json(org);
});

// Helper: get reciprocal relationship type
function getReciprocalRelType(type: string): string {
  const map: Record<string, string> = {
    'parent': 'child', 'child': 'parent',
    'spouse': 'spouse', 'sibling': 'sibling',
    'cohabitant': 'cohabitant', 'other': 'other',
  };
  return map[type] || 'other';
}

// Admin incidents list (formatted for dashboard). Previously had no auth
// check at all despite returning full incident data — both consoles
// already attach a Bearer token to every fetch (see the window.fetch
// wrapper in admin-web/app.v2.js and dispatch-web/app.v2.js), so adding
// the check here is not a breaking change for either caller.
app.get('/admin/incidents', requireAuth, requireRole('dispatcher'), (req, res) => {
  // NOTE: this list is also what the 30s polling refresh replaces `incidents` with
  // client-side — it must carry every field the card/table rendering and the
  // duplicate-suggestion UI read, or those otherwise-live-updated fields flicker
  // away on the next poll.
  const incidents: AdminIncident[] = Array.from(alerts.values()).filter(a => canAccessOrg(req.supabaseUser!, a.organizationId)).map(a => ({
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    reportedBy: a.createdBy,
    address: a.location.address,
    location: { latitude: a.location.latitude, longitude: a.location.longitude },
    description: a.description,
    timestamp: a.createdAt,
    resolvedAt: a.resolvedAt,
    assignedCount: a.respondingUsers.length,
    respondingUsers: a.respondingUsers || [],
    respondingNames: (a.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
    responderStatuses: a.responderStatuses || {},
    statusHistory: a.statusHistory || [],
    responderEscalation: a.responderEscalation || {},
    escalationLevel: a.escalationLevel || 0,
    photos: a.photos || [],
    possibleDuplicates: a.possibleDuplicates || [],
    linkedIncidentIds: a.linkedIncidentIds || [],
    // Legacy alerts predate the origin field — infer from reporterId as a
    // best-effort fallback rather than defaulting everything to 'dispatch'.
    origin: a.origin || (a.reporterId ? 'mobile' : 'dispatch'),
    archived: a.archived || false,
    archivedAt: a.archivedAt,
    isDuress: a.isDuress || false,
  }));
  res.json(incidents);
});

// Admin audit log
// requireRole('dispatcher') not 'admin' — the dispatch console's dashboard
// (dispatcher-tier login) fetches this alongside /admin/health and
// /admin/incidents, both of which are already dispatcher-accessible.
app.get('/admin/audit', requireAuth, requireRole('dispatcher'), (req, res) => {
  res.json(auditLog.filter(e => canAccessOrg(req.supabaseUser!, e.organizationId)));
});

// Redirect /admin to /admin-console/
app.get('/admin', (req, res) => {
  res.redirect('/admin-console/');
});

// Redirect /dispatch to /dispatch-v2/
app.get('/dispatch', (req, res) => {
  res.redirect('/dispatch-v2/');
});

// ─── Dispatch REST API ──────────────────────────────────────────────

// Family groups overview: every family unit (connected component over the
// parent/child/sibling/spouse graph, across ALL admin users — not scoped to
// one owner), each member's residences and effective presence status.
function buildFamilyGroupsOverview(caller?: { id: string; role: string; organizationId?: string; assignedFamilyIds?: string[] }) {
  const groups = computeFamilyGroups();
  return groups
    .filter(memberIds => !caller || canAccessUser(caller, memberIds[0]))
    .map((memberIds) => ({
    id: getFamilyGroupId(memberIds[0]), // stable across calls, unlike the previous array-index id
    members: memberIds.map(uid => {
      const u = adminUsers.get(uid);
      const presence = computeEffectivePresence(uid, true);
      return {
        id: uid,
        name: u?.name || uid,
        ghostMode: u?.ghostMode || false,
        status: presence.status,
        source: presence.source,
        matchedLabel: presence.matchedLabel,
        setBy: presence.setBy ? (adminUsers.get(presence.setBy)?.name || presence.setBy) : undefined,
        setAt: presence.setAt,
        addresses: (userAddresses.get(uid) || []).map(a => ({
          id: a.id, label: a.label, address: a.address, isPrimary: a.isPrimary,
          temporary: a.temporary || false, expiresAt: a.expiresAt,
        })),
      };
    }),
  }));
}

app.get('/dispatch/family-groups', (req, res) => {
  const caller = req.supabaseUser!;
  res.json(buildFamilyGroupsOverview({ id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds }));
});

// Same overview, reachable from the mobile app for staff roles (responders
// included — they sit below 'dispatcher' in the role hierarchy so the
// /dispatch prefix's requireRole('dispatcher') would otherwise block them).
app.get('/api/family-groups', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  if (caller.role !== 'responder' && caller.role !== 'dispatcher' && caller.role !== 'admin' && caller.role !== 'superadmin') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  res.json(buildFamilyGroupsOverview({ id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds }));
});

// Dispatch responders list (with location and assignment info)
app.get('/dispatch/responders', (req, res) => {
  // Build responder list from adminUsers (the authoritative source with real names)
  const now = Date.now();
  const allResponders: any[] = [];
  
  // Get all users with role 'responder' from adminUsers
  adminUsers.forEach((user) => {
    if (user.role !== 'responder') return;
    if (user.status === 'deactivated') return; // skip deactivated
    if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return;

    // Check if this responder is currently connected (has runtime data)
    const runtimeUser = users.get(user.id);
    
    // Find incidents assigned to this responder
    const assignedIncidents: { id: string; type: string; severity: string; status: string; address: string; latitude?: number; longitude?: number; responderStatus?: string }[] = [];
    alerts.forEach((alert) => {
      if (alert.status !== 'resolved' && alert.respondingUsers.includes(user.id)) {
        const respStatus = alert.responderStatuses?.[user.id] || 'assigned';
        assignedIncidents.push({
          id: alert.id,
          type: alert.type,
          severity: alert.severity,
          status: alert.status,
          address: alert.location?.address || 'Unknown',
          latitude: alert.location?.latitude,
          longitude: alert.location?.longitude,
          responderStatus: respStatus,
        });
      }
    });
    
    allResponders.push({
      id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phoneMobile || '',
      tags: user.tags || [],
      accountStatus: user.status, // 'active' | 'suspended'
      // Runtime status from WS connection, then dispatch override, then default
      status: runtimeUser?.status || responderStatusOverrides.get(user.id)?.status || 'off_duty',
      location: runtimeUser?.location || null,
      lastSeen: runtimeUser?.lastSeen || user.lastLogin || now - 3600000,
      isConnected: !!runtimeUser,
      assignedIncidents,
      assignedCount: assignedIncidents.length,
    });
  });
  
  // Sort: connected first, then by status (on_duty > available > off_duty), then by name
  const statusOrder: Record<string, number> = { on_duty: 0, available: 1, responding: 1, off_duty: 2 };
  allResponders.sort((a, b) => {
    if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
    const sa = statusOrder[a.status] ?? 3;
    const sb = statusOrder[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
  
  res.json(allResponders);
});

// Dispatch: change responder status
app.put('/dispatch/responders/:id/status', (req, res) => {
  const responderId = req.params.id;
  const { status } = req.body;
  const validStatuses = ['available', 'on_duty', 'off_duty', 'responding'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }
  
  // Update runtime user if connected
  const runtimeUser = users.get(responderId);
  if (runtimeUser) {
    runtimeUser.status = status;
    runtimeUser.lastSeen = Date.now();
    users.set(responderId, runtimeUser);
  }
  
  // Also store in a persistent status map so it persists even if user is not connected
  responderStatusOverrides.set(responderId, { status, updatedAt: Date.now(), updatedBy: 'dispatch' });
  
  const adminUser = adminUsers.get(responderId);
  const responderName = adminUser?.name || responderId;
  
  addAuditEntry('responder', 'Status Changed', 'Dispatch Console', `${responderName} status changed to ${status}`, responderId, adminUser?.organizationId);
  
  // Broadcast status change to all dispatchers
  broadcastToOrgRole(adminUser?.organizationId, 'dispatcher', {
    type: 'responderStatusUpdate',
    userId: responderId,
    status,
    timestamp: Date.now(),
  });
  
  res.json({ success: true, responderId, status, name: responderName });
});

// Dispatch: acknowledge incident
app.put('/dispatch/incidents/:id/acknowledge', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  alert.status = 'acknowledged';
  if (!alert.acknowledgedAt) alert.acknowledgedAt = Date.now();
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[DispatchAcknowledge] Supabase save error:', e));
  addAuditEntry('incident', 'Alert Acknowledged', 'Dispatch Console', `Acknowledged ${alert.id}`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'alertAcknowledged', alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});

// Dispatch: assign responder to incident
app.put('/dispatch/incidents/:id/assign', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const { responderId } = req.body;
  if (responderId && !alert.respondingUsers.includes(responderId)) {
    alert.respondingUsers.push(responderId);
  }
  if (alert.status === 'active' || alert.status === 'acknowledged') {
    alert.status = 'acknowledged';
    if (!alert.acknowledgedAt) alert.acknowledgedAt = Date.now();
  }
  alerts.set(alert.id, alert);
  persistAlerts();
  // Initialize responderStatuses if not present
  if (!alert.responderStatuses) alert.responderStatuses = {};
  if (!alert.statusHistory) alert.statusHistory = [];
  if (responderId && !alert.responderStatuses[responderId]) {
    alert.responderStatuses[responderId] = 'assigned';
  }
  if (responderId) {
    if (!alert.responderEscalation) alert.responderEscalation = {};
    alert.responderEscalation[responderId] = 0;
    recomputeEscalationLevel(alert);
  }
  const responderName = adminUsers.get(responderId)?.name || responderId;
  // Record assignment in status history
  alert.statusHistory.push({
    responderId,
    responderName,
    status: 'assigned',
    timestamp: Date.now(),
  });
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Assign] Supabase save error:', e));
  addAuditEntry('incident', 'Responder Assigned', 'Dispatch Console', `Assigned ${responderName} to ${alert.id}`, responderId, alert.organizationId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
  };
  broadcastToOrg(alert.organizationId, { type: 'alertUpdate', data: enrichedAlert });

  // Send push notification to the assigned responder
  const TYPE_LABELS: Record<string, string> = {
    sos: 'SOS', medical: 'M\u00e9dical', fire: 'Incendie', security: 'S\u00e9curit\u00e9',
    hazard: 'Danger', accident: 'Accident', broadcast: 'Broadcast',
    home_jacking: 'Home-Jacking', cambriolage: 'Cambriolage', animal_perdu: 'Animal perdu',
    evenement_climatique: '\u00c9v\u00e9nement climatique', rodage: 'Rodage',
    vehicule_suspect: 'V\u00e9hicule suspect', fugue: 'Fugue',
    route_bloquee: 'Route bloqu\u00e9e', route_fermee: 'Route ferm\u00e9e', other: 'Autre',
    malaise: 'Malaise', colis_suspect: 'Colis suspect',
  };
  const typeLabel = TYPE_LABELS[alert.type] || alert.type;
  const sevLabel = alert.severity === 'critical' ? 'CRITIQUE' : alert.severity === 'high' ? '\u00c9LEV\u00c9' : alert.severity === 'medium' ? 'MOYEN' : 'FAIBLE';
  sendPushToUser(
    responderId,
    `\u{1F6A8} Incident assign\u00e9 — ${typeLabel} (${sevLabel})`,
    `Vous avez \u00e9t\u00e9 assign\u00e9 \u00e0 l'incident ${alert.id}.\n\u{1F4CD} ${alert.location?.address || 'Adresse inconnue'}`,
    { type: 'assignment', alertId: alert.id, severity: alert.severity, alertType: alert.type }
  ).catch(err => console.error('[Assign Push] Error:', err));

  // Start 5-minute acceptance timer for this responder
  if (responderId) {
    startAcceptanceTimer(alert.id, responderId);
  }

  res.json({ success: true, responderName });
});

// Dispatch: unassign responder from incident
app.put('/dispatch/incidents/:id/unassign', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const { responderId } = req.body;
  if (!responderId) return res.status(400).json({ error: 'responderId required' });
  const idx = alert.respondingUsers.indexOf(responderId);
  if (idx === -1) return res.status(400).json({ error: 'Responder not assigned to this incident' });
  alert.respondingUsers.splice(idx, 1);
  // Clear acceptance timer and remove from responderStatuses
  clearAcceptanceTimer(alert.id, responderId);
  if (alert.responderStatuses) delete alert.responderStatuses[responderId];
  if (alert.responderEscalation) {
    delete alert.responderEscalation[responderId];
    recomputeEscalationLevel(alert);
  }
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Unassign] Supabase save error:', e));
  const responderName = adminUsers.get(responderId)?.name || responderId;
  addAuditEntry('incident', 'Responder Unassigned', 'Dispatch Console', `Unassigned ${responderName} from ${alert.id}`, responderId, alert.organizationId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
  };
  broadcastToOrg(alert.organizationId, { type: 'alertUpdate', data: enrichedAlert });
  res.json({ success: true, responderName });
});

// Statuses considered eligible for one-click assignment/suggestion in the dispatch UI
const NEARBY_AVAILABLE_STATUSES = new Set(['available', 'on_duty', 'responding']);

interface NearbyResponderInfo {
  id: string;
  name: string;
  phone: string;
  tags: string[];
  status: string;
  isConnected: boolean;
  isAssigned: boolean;
  distanceMeters: number | null;
  distanceLabel: string;
  etaMinutes: number | null;
  etaLabel: string | null;
  suggested: boolean;
}

// Responders eligible to be assigned to an incident, sorted (assigned first, then distance, then name)
// with the nearest available unassigned candidate flagged as `suggested`.
function computeNearbyResponders(alert: Alert): NearbyResponderInfo[] {
  const incidentLat = alert.location.latitude;
  const incidentLng = alert.location.longitude;
  const result: NearbyResponderInfo[] = [];

  adminUsers.forEach((user) => {
    if (user.role !== 'responder') return;
    if (user.status === 'deactivated') return;
    const runtimeUser = users.get(user.id);
    const location = runtimeUser?.location || null;
    let distanceMeters: number | null = null;
    let distanceLabel = 'Position inconnue';
    let etaMinutes: number | null = null;
    let etaLabel: string | null = null;
    if (location && location.latitude && location.longitude) {
      distanceMeters = haversineDistance(location.latitude, location.longitude, incidentLat, incidentLng);
      distanceLabel = distanceMeters < 1000 ? `${Math.round(distanceMeters)} m` : `${(distanceMeters / 1000).toFixed(1)} km`;
      etaMinutes = estimateEtaMinutes(distanceMeters);
      etaLabel = formatEtaLabel(etaMinutes);
    }
    result.push({
      id: user.id,
      name: user.name,
      phone: user.phoneMobile || '',
      tags: user.tags || [],
      status: runtimeUser?.status || responderStatusOverrides.get(user.id)?.status || 'off_duty',
      isConnected: !!runtimeUser,
      isAssigned: alert.respondingUsers.includes(user.id),
      distanceMeters,
      distanceLabel,
      etaMinutes,
      etaLabel,
      suggested: false,
    });
  });

  // Sort: assigned first, then by distance (null last), then by name
  result.sort((a, b) => {
    if (a.isAssigned !== b.isAssigned) return a.isAssigned ? -1 : 1;
    if (a.distanceMeters !== null && b.distanceMeters !== null) return a.distanceMeters - b.distanceMeters;
    if (a.distanceMeters !== null) return -1;
    if (b.distanceMeters !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  const candidate = result.find(r => !r.isAssigned && NEARBY_AVAILABLE_STATUSES.has(r.status) && r.distanceMeters !== null);
  if (candidate) candidate.suggested = true;

  return result;
}

// Civilian users (non-responder) within radiusMeters of a location, for the dispatch
// map's "nearby users" panel on an incident. Same Ghost-mode gating as the live map
// (/dispatch/map/users) so a hidden user isn't exposed just because an incident is nearby.
function computeNearbyUsers(location: { latitude: number; longitude: number }, radiusMeters: number) {
  const now = Date.now();
  return Array.from(users.values())
    .filter(u => u.location && u.role !== 'responder')
    .filter(u => !(adminUsers.get(u.id)?.ghostMode && !isRevealedForActiveIncident(u.id)))
    .map(u => {
      const adminUser = adminUsers.get(u.id);
      const name = adminUser ? `${adminUser.firstName} ${adminUser.lastName}`.trim() : u.id;
      const distanceMeters = Math.round(haversineDistance(u.location!.latitude, u.location!.longitude, location.latitude, location.longitude));
      return {
        id: u.id,
        name,
        role: u.role,
        status: u.status || 'available',
        location: u.location,
        lastSeen: u.lastSeen || now,
        distanceMeters,
      };
    })
    .filter(u => u.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters);
}

// Ghost-mode users (role 'user') within radiusMeters of a location — used to send
// reveal-request pushes when an incident is created with a visibility radius.
function findGhostUsersNearLocation(location: { latitude: number; longitude: number }, radiusMeters: number): string[] {
  const nearby: string[] = [];
  adminUsers.forEach((user) => {
    if (user.role !== 'user') return;
    if (!user.ghostMode) return;
    const runtimeUser = users.get(user.id);
    const loc = runtimeUser?.location;
    if (!loc) return;
    const dist = haversineDistance(location.latitude, location.longitude, loc.latitude, loc.longitude);
    if (dist <= radiusMeters) nearby.push(user.id);
  });
  return nearby;
}

// Dispatch: get responders with distance/ETA to a specific incident (for assign modal)
app.get('/dispatch/incidents/:id/responders-nearby', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const result = computeNearbyResponders(alert);
  const suggested = result.find(r => r.suggested) || null;
  res.json({
    incidentId: alert.id,
    incidentAddress: alert.location.address,
    responders: result,
    suggestedResponderId: suggested ? suggested.id : null,
  });
});

// Dispatch: civilian users within an adjustable radius of an incident (for the map panel).
// Radius is a query param, not stored on the incident — the dispatcher can widen/narrow it
// live and get a fresh list, defaulting to 200m.
app.get('/dispatch/incidents/:id/nearby-users', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const radiusMeters = Math.max(50, Math.min(50000, parseFloat(req.query.radius as string) || 200));
  const nearbyUsers = computeNearbyUsers(alert.location, radiusMeters);
  res.json({ incidentId: alert.id, radiusMeters, users: nearbyUsers });
});

// Dispatch: resolve incident
app.put('/dispatch/incidents/:id/resolve', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  alert.status = 'resolved';
  if (!alert.resolvedAt) alert.resolvedAt = Date.now();
  // Stop any pending soft/hard escalation timers so a resolved incident can't keep "escalating"
  (alert.respondingUsers || []).forEach(uid => clearAcceptanceTimer(alert.id, uid));
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[DispatchResolve] Supabase save error:', e));
  addAuditEntry('incident', 'Incident Resolved', 'Dispatch Console', `Resolved ${alert.id}: ${alert.type} at ${alert.location.address}`, undefined, alert.organizationId);
  broadcastToOrg(alert.organizationId, { type: 'alertResolved', alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});

// Responder: update their response status on an incident (accept, en_route, on_scene)
app.put('/alerts/:id/respond', requireRole('responder'), (req, res) => {
  const alertIdParam = req.params.id as string;
  // Try direct lookup first, then try decoded variants
  let alert = alerts.get(alertIdParam);
  if (!alert) {
    // Try decoding the ID (handles em dash and special chars)
    try { alert = alerts.get(decodeURIComponent(alertIdParam)); } catch(e) {}
  }
  if (!alert) {
    // Try finding by partial match (last resort)
    for (const [key, val] of alerts) {
      if (key.includes(alertIdParam) || alertIdParam.includes(key)) { alert = val; break; }
    }
  }
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  const { responderId, status } = req.body;
  if (!responderId) return res.status(400).json({ error: 'responderId required' });
  const validStatuses: ResponderStatus[] = ['accepted', 'en_route', 'on_scene'];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }
  // Must be assigned to this incident
  if (!alert.respondingUsers.includes(responderId)) {
    return res.status(400).json({ error: 'Responder not assigned to this incident' });
  }
  if (!alert.responderStatuses) alert.responderStatuses = {};
  if (!alert.statusHistory) alert.statusHistory = [];
  alert.responderStatuses[responderId] = status;
  // Clear acceptance timer when responder accepts or moves to any status beyond 'assigned'
  clearAcceptanceTimer(alert.id, responderId);
  if (alert.responderEscalation) {
    delete alert.responderEscalation[responderId];
    recomputeEscalationLevel(alert);
  }
  const responderName = adminUsers.get(responderId)?.name || responderId;
  // Record status change in history
  alert.statusHistory.push({
    responderId,
    responderName,
    status,
    timestamp: Date.now(),
  });
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Respond] Supabase save error:', e));
  const STATUS_LABELS: Record<string, string> = { accepted: 'Accept\u00e9', en_route: 'En route', on_scene: 'Sur place' };
  const statusLabel = STATUS_LABELS[status] || status;
  addAuditEntry('incident', `Responder ${statusLabel}`, responderName, `${responderName} — ${statusLabel} pour ${alert.id}`, responderId, alert.organizationId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
  };
  broadcastToOrg(alert.organizationId, { type: 'alertUpdate', data: enrichedAlert });
  // Notify dispatchers via push
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === 'dispatcher' || entry.userRole === 'admin') {
      sendPushToUser(entry.userId, `${responderName} — ${statusLabel}`, `Incident ${alert.id}: ${responderName} est ${statusLabel.toLowerCase()}`, { type: 'responder_status', alertId: alert.id, responderId, status }).catch(() => {});
      break; // one notification per dispatcher is enough via broadcast
    }
  }
  res.json({ success: true, responderId, status, statusLabel });
});

// POST /alerts/:id/reveal - a Ghost-mode user confirms becoming visible to dispatch
// for this specific incident, in response to a reveal-request push notification.
app.post('/alerts/:id/reveal', (req, res) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });

  if (!alert.revealedUserIds) alert.revealedUserIds = [];
  if (!alert.revealedUserIds.includes(userId)) {
    alert.revealedUserIds.push(userId);
  }
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Reveal] Supabase save error:', e));

  // Broadcast this user's current location immediately, rather than waiting for
  // their next natural location ping, so they appear on the map right away.
  const runtimeUser = users.get(userId);
  if (runtimeUser?.location) {
    const msg = { type: 'userLocationUpdate', userId, location: runtimeUser.location, timestamp: Date.now() };
    const revealOrgId = adminUsers.get(userId)?.organizationId;
    broadcastToOrgRole(revealOrgId, 'dispatcher', msg);
    broadcastToOrgRole(revealOrgId, 'admin', msg);
  }

  addAuditEntry('incident', 'Utilisateur révélé', adminUsers.get(userId)?.name || userId, `Position partagée pour l'incident ${alert.id}`, userId, alert.organizationId);
  res.json({ success: true });
});

// Dispatch: send broadcast — creates a real alert so mobile apps receive it via polling + WS
app.post('/dispatch/broadcast', async (req, res) => {
  const { message, severity, radiusKm, by, latitude, longitude } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const sev = (severity || 'medium') as Alert['severity'];
  const alert: Alert = {
    id: await generateIncidentId('broadcast', by || 'Dispatch Console', { address: `Zone broadcast (${radiusKm || 5}km radius)` }),
    type: 'broadcast',
    severity: sev,
    location: {
      latitude: latitude || 46.1950,
      longitude: longitude || 6.1580,
      address: `Zone broadcast (${radiusKm || 5}km radius)`,
    },
    description: message,
    createdBy: by || 'Dispatch Console',
    organizationId: req.supabaseUser?.organizationId,
    origin: 'dispatch',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
  };

  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(e => console.error('[Broadcast] Supabase save error:', e));
  addAuditEntry('broadcast', 'Zone Broadcast Sent', by || 'Dispatch Console', `[${sev.toUpperCase()}] ${message} (${radiusKm || 5}km radius)`, undefined, alert.organizationId);

  // Broadcast as newAlert so all WS clients (including mobile) receive it
  broadcastToOrg(alert.organizationId, { type: 'newAlert', data: alert });
  // Also send the legacy zoneBroadcast event for dispatch console UI
  broadcastToOrg(alert.organizationId, { type: 'zoneBroadcast', data: { message, severity: sev, radiusKm, by, timestamp: Date.now() } });

  // Send push notifications to ALL users (broadcasts are for everyone)
  sendPushToAllUsers(alert, by || 'Dispatch Console').catch(err => {
    console.error('[Broadcast] Push notification error:', err);
  });

  console.log(`[Broadcast] Alert ${alert.id} created and broadcast to ${wss.clients.size} clients`);
  res.json({ success: true, alertId: alert.id });
});

// ─── Geofence REST API ──────────────────────────────────────────────

// Create geofence zone
app.post('/dispatch/geofence/zones', (req, res) => {
  const { center, radiusKm, severity, message, createdBy } = req.body;
  if (!center || !radiusKm) return res.status(400).json({ error: 'center and radiusKm required' });
  // Normalize center to {latitude, longitude} format (client may send {lat, lng})
  const normalizedCenter = {
    latitude: center.latitude ?? center.lat,
    longitude: center.longitude ?? center.lng,
  };
  const zone: GeofenceZone = {
    id: 'gf-' + Date.now(),
    center: normalizedCenter,
    radiusKm: parseFloat(radiusKm),
    severity: severity || 'medium',
    message: message || '',
    createdAt: Date.now(),
    createdBy: createdBy || 'Dispatch Console',
    organizationId: req.supabaseUser?.organizationId,
  };
  geofenceZones.set(zone.id, zone);
  responderZoneState.set(zone.id, new Set());

  // Check which responders are already inside the zone
  const allResponders = Array.from(users.values()).filter(u => u.role === 'responder' && u.location);
  const respondersToCheck = allResponders.map(r => ({ id: r.id, lat: r.location!.latitude, lng: r.location!.longitude }));

  respondersToCheck.forEach(r => {
    const dist = haversineDistance(r.lat, r.lng, zone.center.latitude, zone.center.longitude);
    if (dist <= zone.radiusKm * 1000) {
      responderZoneState.get(zone.id)!.add(r.id);
    }
  });

  addAuditEntry('broadcast', 'Geofence Zone Created', zone.createdBy, `Zone ${zone.id}: ${zone.severity} — ${zone.radiusKm}km radius`, undefined, req.supabaseUser?.organizationId);
  broadcastToOrg(req.supabaseUser?.organizationId, { type: 'geofenceZoneCreated', data: zone });
  res.json({ success: true, zone });
});

// List geofence zones
app.get('/dispatch/geofence/zones', (req, res) => {
  const zones = Array.from(geofenceZones.values())
    .filter(z => canAccessOrg(req.supabaseUser!, z.organizationId))
    .map(z => ({
      ...z,
      respondersInside: responderZoneState.get(z.id)?.size || 0,
    }));
  res.json(zones);
});

// Delete geofence zone
app.delete('/dispatch/geofence/zones/:id', (req, res) => {
  const zoneId = req.params.id;
  const zone = geofenceZones.get(zoneId);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  if (!canAccessOrg(req.supabaseUser!, zone.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  geofenceZones.delete(zoneId);
  responderZoneState.delete(zoneId);
  addAuditEntry('broadcast', 'Geofence Zone Deleted', 'Dispatch Console', `Zone ${zoneId} removed`, undefined, req.supabaseUser?.organizationId);
  broadcastToOrg(req.supabaseUser?.organizationId, { type: 'geofenceZoneDeleted', data: { zoneId } });
  res.json({ success: true });
});

// Geofence events log
app.get('/dispatch/geofence/events', (req, res) => {
  const events = geofenceEvents.filter(e => canAccessOrg(req.supabaseUser!, e.organizationId)).slice(0, 100);
  res.json({ success: true, events });
});

// Simulate responder movement (for testing geofence entry/exit)
app.post('/dispatch/geofence/simulate-move', (req, res) => {
  const { responderId, latitude, longitude } = req.body;
  if (!responderId || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'responderId, latitude, longitude required' });
  }
  if (!canAccessOrg(req.supabaseUser!, adminUsers.get(responderId)?.organizationId)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  // Update or create the responder in users map
  let user = users.get(responderId);
  if (!user) {
    user = { id: responderId, email: `${responderId}@talion.local`, role: 'responder', status: 'on_duty', lastSeen: Date.now() };
    users.set(responderId, user);
  }
  user.location = { latitude, longitude };
  user.lastSeen = Date.now();
  users.set(responderId, user);

  // Check geofences
  checkGeofences(responderId, { latitude, longitude });

  // Broadcast location update
  broadcastToOrg(adminUsers.get(responderId)?.organizationId, {
    type: 'responderLocationUpdate',
    userId: responderId,
    location: { latitude, longitude },
    timestamp: Date.now(),
  });

  res.json({ success: true, responderId, location: { latitude, longitude } });
});

// ─── Sectors (admin-managed organizational zones shown on the map) ──────
// Viewable by anyone with console access (dispatcher+, enforced by the
// app.use('/dispatch', ...) prefix middleware); mutations require admin.
app.get('/dispatch/sectors', (req, res) => {
  res.json(Array.from(sectors.values()).filter(s => canAccessOrg(req.supabaseUser!, s.organizationId)));
});

app.post('/dispatch/sectors', requireRole('admin'), (req, res) => {
  const { name, color, shape, center, radiusMeters, points } = req.body;
  if (!name || !shape) {
    return res.status(400).json({ error: 'name and shape required' });
  }
  if (shape === 'circle') {
    if (!center?.latitude || !center?.longitude || !radiusMeters) {
      return res.status(400).json({ error: 'center {latitude, longitude} and radiusMeters required for circle sectors' });
    }
  } else if (shape === 'polygon') {
    if (!Array.isArray(points) || points.length < 3) {
      return res.status(400).json({ error: 'points (at least 3) required for polygon sectors' });
    }
  } else {
    return res.status(400).json({ error: "shape must be 'circle' or 'polygon'" });
  }
  const now = Date.now();
  const sector: Sector = {
    id: uuidv4(),
    name,
    color: color || '#3b82f6',
    shape,
    center: shape === 'circle' ? { latitude: center.latitude, longitude: center.longitude } : undefined,
    radiusMeters: shape === 'circle' ? Number(radiusMeters) : undefined,
    points: shape === 'polygon' ? points.map((p: any) => ({ latitude: p.latitude, longitude: p.longitude })) : undefined,
    createdBy: req.supabaseUser!.id,
    createdAt: now,
    updatedAt: now,
    organizationId: req.supabaseUser!.organizationId,
  };
  sectors.set(sector.id, sector);
  persistSectors();
  broadcastToOrgRole(sector.organizationId, 'dispatcher', { type: 'sectorCreated', sector });
  broadcastToOrgRole(sector.organizationId, 'admin', { type: 'sectorCreated', sector });
  console.log(`[Sector] Created ${sector.id} "${sector.name}" (${shape}) by ${req.supabaseUser!.id}`);
  res.json(sector);
});

app.put('/dispatch/sectors/:id', requireRole('admin'), (req, res) => {
  const sectorId = req.params.id as string;
  const sector = sectors.get(sectorId);
  if (!sector) return res.status(404).json({ error: 'Sector not found' });
  const { name, color, center, radiusMeters, points } = req.body;
  if (name != null) sector.name = name;
  if (color != null) sector.color = color;
  if (sector.shape === 'circle') {
    if (center?.latitude != null && center?.longitude != null) {
      sector.center = { latitude: center.latitude, longitude: center.longitude };
    }
    if (radiusMeters != null) sector.radiusMeters = Number(radiusMeters);
  } else if (sector.shape === 'polygon') {
    if (Array.isArray(points) && points.length >= 3) {
      sector.points = points.map((p: any) => ({ latitude: p.latitude, longitude: p.longitude }));
    }
  }
  sector.updatedAt = Date.now();
  sectors.set(sector.id, sector);
  persistSectors();
  broadcastToOrgRole(sector.organizationId, 'dispatcher', { type: 'sectorUpdated', sector });
  broadcastToOrgRole(sector.organizationId, 'admin', { type: 'sectorUpdated', sector });
  res.json(sector);
});

app.delete('/dispatch/sectors/:id', requireRole('admin'), (req, res) => {
  const sectorId = req.params.id as string;
  const sectorOrgId = sectors.get(sectorId)?.organizationId;
  const existed = sectors.delete(sectorId);
  if (existed) {
    persistSectors();
    deleteSectorFromSupabase(sectorId).catch(() => {});
    broadcastToOrgRole(sectorOrgId, 'dispatcher', { type: 'sectorDeleted', sectorId });
    broadcastToOrgRole(sectorOrgId, 'admin', { type: 'sectorDeleted', sectorId });
  }
  res.json({ success: existed });
});

// ─── Map REST API ───────────────────────────────────────────────────

// Map: all users with locations (for map display)
app.get('/dispatch/map/users', (req, res) => {
  const now = Date.now();
  const caller = req.supabaseUser!;
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  const connectedUsersList = Array.from(users.values())
    .filter(u => u.location && u.role !== 'responder')
    .filter(u => !(adminUsers.get(u.id)?.ghostMode && !isRevealedForActiveIncident(u.id)))
    .filter(u => canAccessUser(callerAccess, u.id))
    .map(u => {
      const adminUser = adminUsers.get(u.id);
      const name = adminUser ? `${adminUser.firstName} ${adminUser.lastName}`.trim() : u.id;
      return {
        id: u.id,
        name,
        role: u.role,
        status: u.status || 'available',
        location: u.location,
        lastSeen: u.lastSeen || now,
      };
    });

  res.json(connectedUsersList);
});

// Map: all entities combined (incidents + responders + users)
app.get('/dispatch/map/all', (req, res) => {
  const now = Date.now();
  const allAlerts = Array.from(alerts.values()).filter(a => canAccessOrg(req.supabaseUser!, a.organizationId)).map(a => ({
    entityType: 'incident',
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    location: a.location,
    description: a.description,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    respondingUsers: a.respondingUsers,
    photos: a.photos || [],
  }));
  res.json({ incidents: allAlerts, timestamp: now });
});
// ─── Messaging REST API ─────────────────────────────────────────────────

// Helper: resolve group participants dynamically. organizationId is
// required (not optional) specifically so tsc flags every call site that
// doesn't pass one — role/tag-filtered groups previously resolved via
// adminUsers.forEach with no org check at all, silently mixing every
// tenant's staff into "all dispatchers"/"all tag X" groups.
function resolveGroupParticipants(conv: Conversation, organizationId: string | undefined): string[] {
  const ids = new Set(conv.participantIds);
  const activeStatuses = ['active', 'available', 'on_duty'];
  if (conv.filterRole) {
    adminUsers.forEach((u) => {
      if (u.organizationId === organizationId && u.role === conv.filterRole && activeStatuses.includes(u.status)) ids.add(u.id);
    });
  }
  if (conv.filterTags && conv.filterTags.length > 0) {
    adminUsers.forEach((u) => {
      if (u.organizationId === organizationId && activeStatuses.includes(u.status) && u.tags && conv.filterTags!.some(t => u.tags!.includes(t))) ids.add(u.id);
    });
  }
  if (conv.type === 'residence' && conv.addressId) {
    // Computed live from the address owner's current family, never stale.
    const ownerId = resolveAddressOwner(conv.addressId);
    if (ownerId) {
      ids.add(ownerId);
      getFamilyMemberIds(ownerId).forEach(id => ids.add(id));
    }
  }
  return Array.from(ids);
}

// GET /api/users - list all active users (for contact list)
app.get('/api/users', requireAuth, (req, res) => {
  const allUsers = Array.from(adminUsers.values())
    .filter(u => u.status === 'active' && canAccessOrg(req.supabaseUser!, u.organizationId))
    .map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, tags: u.tags || [] }));
  res.json(allUsers);
});

// GET /api/contacts?userId=X - the same directory as /api/users, but
// split into sections for the "new conversation" contact picker: the caller's
// direct family (spouse/child/parent/sibling — same relation set the presence
// system already uses), Dispatch (dispatcher + admin, so a responder always has
// a specific person to reach), and everyone else. Lets the picker show curated
// sections instead of one flat, undifferentiated list of every user.
app.get('/api/contacts', requireAuth, (req, res) => {
  const callerId = req.query.userId as string;
  const familyIds = new Set(callerId ? getFamilyMemberIds(callerId) : []);
  const toContact = (u: AdminUser) => ({ id: u.id, name: u.name, email: u.email, role: u.role, tags: u.tags || [] });

  const family: ReturnType<typeof toContact>[] = [];
  const dispatch: ReturnType<typeof toContact>[] = [];
  const others: ReturnType<typeof toContact>[] = [];

  adminUsers.forEach((u) => {
    if (u.status !== 'active' || u.id === callerId) return;
    if (!canAccessOrg(req.supabaseUser!, u.organizationId)) return;
    if (familyIds.has(u.id)) family.push(toContact(u));
    else if (u.role === 'dispatcher' || u.role === 'admin') dispatch.push(toContact(u));
    else others.push(toContact(u));
  });

  res.json({ family, dispatch, others });
});

// GET /api/tags - list all unique tags
app.get('/api/tags', requireAuth, (req, res) => {
  const tagSet = new Set<string>();
  adminUsers.forEach(u => { if (canAccessOrg(req.supabaseUser!, u.organizationId)) (u.tags || []).forEach(t => tagSet.add(t)); });
  res.json(Array.from(tagSet).sort());
});

// PUT /api/users/:id/tags - update user tags
app.put('/api/users/:id/tags', requireAuth, (req, res) => {
  const user = adminUsers.get(req.params.id as string);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!canAccessOrg(req.supabaseUser!, user.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  user.tags = req.body.tags || [];
  adminUsers.set(user.id, user);
  res.json({ success: true, user: { id: user.id, name: user.name, tags: user.tags } });
});

// PUT /api/users/:id/ghost-mode - toggle whether this user is hidden from dispatch's
// live location view. Goes through the server (not a direct client->Supabase write)
// so the in-memory adminUsers map — and therefore the broadcast/snapshot gating in
// handleLocationUpdate and GET /dispatch/map/users — reflects the change immediately.
app.put('/api/users/:id/ghost-mode', requireAuth, (req, res) => {
  const targetId = req.params.id as string;
  const caller = req.supabaseUser!;
  const isSelf = caller.id === targetId;
  const isDispatchStaff = caller.role === 'dispatcher' || caller.role === 'admin';
  if (!isSelf && !isDispatchStaff) {
    return res.status(403).json({ error: 'Not authorized to change this user\'s Ghost mode' });
  }
  const user = adminUsers.get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.ghostMode = Boolean(req.body.ghostMode);
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user).catch(e => console.error('[GhostMode] Supabase save error:', e));

  // Push the visibility change to dispatch immediately, rather than waiting for the
  // next location ping — enabling Ghost mode removes an already-rendered marker;
  // disabling it re-shows the user right away using their last known location.
  // (Skip hiding if they're currently revealed for an active incident — that reveal
  // should still hold even if they happen to re-toggle Ghost mode while it's active.)
  if (user.ghostMode && !isRevealedForActiveIncident(targetId)) {
    const removeMsg = { type: 'userLocationRemoved', userId: targetId, timestamp: Date.now() };
    broadcastToOrgRole(user.organizationId, 'dispatcher', removeMsg);
    broadcastToOrgRole(user.organizationId, 'admin', removeMsg);
  } else if (!user.ghostMode) {
    const runtimeUser = users.get(targetId);
    if (runtimeUser?.location) {
      const showMsg = { type: 'userLocationUpdate', userId: targetId, name: user.name, location: runtimeUser.location, timestamp: Date.now() };
      broadcastToOrgRole(user.organizationId, 'dispatcher', showMsg);
      broadcastToOrgRole(user.organizationId, 'admin', showMsg);
    }
  }

  res.json({ success: true, ghostMode: user.ghostMode });
});

// PUT /api/users/:id/location-sharing - self, a parent of this account, or
// staff. Independent of Ghost mode (which only ever affects dispatch's live
// map). This one controls whether the user's live position/presence is shown
// to their own family in GET /api/family/members. Parent access exists so a
// parent can manage location sharing for a teen's ('ado' profile) account —
// see isParentOf.
app.put('/api/users/:id/location-sharing', requireAuth, (req, res) => {
  const targetId = req.params.id as string;
  const caller = req.supabaseUser!;
  const isStaff = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'superadmin';
  if (caller.id !== targetId && !isParentOf(caller.id, targetId) && !(isStaff && canAccessOrg(caller, adminUsers.get(targetId)?.organizationId))) {
    return res.status(403).json({ error: 'Not authorized to change this user\'s location sharing' });
  }
  const user = adminUsers.get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.shareLocationWithFamily = Boolean(req.body.shareLocationWithFamily);
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user).catch(e => console.error('[LocationSharing] Supabase save error:', e));
  res.json({ success: true, shareLocationWithFamily: user.shareLocationWithFamily });
});

// PUT /api/users/:id/ui-profile - parent-of-target or staff only, never the
// account holder themselves (so a child/teen can't switch their own phone
// back to the full UI). Switching TO 'ado' also turns on base location
// sharing by default, per spec — the parent remains free to turn it back off
// afterwards via the route above.
app.put('/api/users/:id/ui-profile', requireAuth, (req, res) => {
  const targetId = req.params.id as string;
  const caller = req.supabaseUser!;
  const target = adminUsers.get(targetId);
  if (!target) return res.status(404).json({ error: 'User not found' });
  const isStaff = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'superadmin';
  if (!isParentOf(caller.id, targetId) && !(isStaff && canAccessOrg(caller, target.organizationId))) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const { uiProfile } = req.body;
  if (uiProfile !== 'standard' && uiProfile !== 'enfant' && uiProfile !== 'ado') {
    return res.status(400).json({ error: "uiProfile must be 'standard', 'enfant' or 'ado'" });
  }
  if (uiProfile === 'ado' && target.uiProfile !== 'ado') {
    target.shareLocationWithFamily = true;
  }
  target.uiProfile = uiProfile;
  adminUsers.set(target.id, target);
  saveAdminUserToSupabase(target).catch(e => console.error('[UiProfile] Supabase save error:', e));
  // So the change takes effect on the child/teen's own device without
  // requiring them to log out and back in.
  broadcastToUsers([target.id], { type: 'uiProfileUpdated', data: { userId: target.id, uiProfile: target.uiProfile } });
  res.json({ success: true, uiProfile: target.uiProfile, shareLocationWithFamily: target.shareLocationWithFamily });
});

// POST /api/users/:id/share-location-temporary - self only. Lets someone who
// keeps shareLocationWithFamily off share their live position with family for
// a bounded window without permanently flipping the main toggle — e.g. "share
// for the next 2h while I'm out with friends". Expires on its own.
app.post('/api/users/:id/share-location-temporary', requireAuth, (req, res) => {
  const targetId = req.params.id as string;
  const caller = req.supabaseUser!;
  if (caller.id !== targetId) {
    return res.status(403).json({ error: 'Not authorized to change this user\'s location sharing' });
  }
  const user = adminUsers.get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const minutes = Number(req.body.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return res.status(400).json({ error: 'minutes must be a positive number' });
  const cappedMinutes = Math.min(minutes, 360);
  user.shareLocationUntil = Date.now() + cappedMinutes * 60 * 1000;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user).catch(e => console.error('[LocationSharing] Supabase save error:', e));
  res.json({ success: true, shareLocationUntil: user.shareLocationUntil });
});

// GET /api/users/:id/duress-settings — self only, never exposes the hashes,
// only whether the feature is turned on (the app uses this to decide whether
// to prompt for a PIN on SOS deactivation at all).
app.get('/api/users/:id/duress-settings', requireAuth, (req, res) => {
  const targetId = req.params.id as string;
  const caller = req.supabaseUser!;
  if (caller.id !== targetId) return res.status(403).json({ error: 'Not authorized' });
  const user = adminUsers.get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ enabled: Boolean(user.duressCodeEnabled) });
});

// PUT /api/users/:id/duress-settings — self only. Set/replace both PINs together
// (never independently — a stale duress PIN left over from a previous normal
// PIN would be a real safety bug) or disable the feature entirely.
app.put('/api/users/:id/duress-settings', requireAuth, (req, res) => {
  const targetId = req.params.id as string;
  const caller = req.supabaseUser!;
  if (caller.id !== targetId) return res.status(403).json({ error: 'Not authorized' });
  const user = adminUsers.get(targetId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { enabled } = req.body;
  if (enabled === false) {
    user.duressCodeEnabled = false;
    user.normalPinHash = undefined;
    user.duressPinHash = undefined;
    adminUsers.set(user.id, user);
    saveAdminUserToSupabase(user).catch(e => console.error('[Duress] Supabase save error:', e));
    return res.json({ success: true, enabled: false });
  }

  const { normalPin, duressPin } = req.body;
  const pinPattern = /^\d{4,6}$/;
  if (!pinPattern.test(normalPin || '') || !pinPattern.test(duressPin || '')) {
    return res.status(400).json({ error: 'normalPin and duressPin must be 4-6 digits' });
  }
  if (normalPin === duressPin) {
    return res.status(400).json({ error: 'normalPin and duressPin must be different' });
  }
  user.duressCodeEnabled = true;
  user.normalPinHash = bcrypt.hashSync(normalPin, 10);
  user.duressPinHash = bcrypt.hashSync(duressPin, 10);
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user).catch(e => console.error('[Duress] Supabase save error:', e));
  res.json({ success: true, enabled: true });
});

// POST /api/sos/duress-check — called from the SOS button's "deactivate" flow
// when the caller has a duress code configured. Always looks and feels the
// same to the person typing regardless of which PIN they enter; only the
// server-side branch differs, silently, based on which hash matched.
app.post('/api/sos/duress-check', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const user = adminUsers.get(caller.id);
  if (!user || !user.duressCodeEnabled || !user.normalPinHash || !user.duressPinHash) {
    return res.status(400).json({ error: 'Duress code not configured' });
  }
  const { pin, alertId } = req.body;
  if (typeof pin !== 'string') return res.status(400).json({ error: 'pin required' });

  if (bcrypt.compareSync(pin, user.normalPinHash)) {
    return res.json({ result: 'normal' });
  }

  if (bcrypt.compareSync(pin, user.duressPinHash)) {
    // The normal case: SOS was already active (that's the only way this modal
    // shows), so an alert already exists — mark it rather than creating a
    // duplicate. Only falls back to a fresh alert if the original POST /api/sos
    // never reached the server (e.g. was queued offline).
    let alert = alertId ? alerts.get(alertId) : undefined;
    const isNew = !alert;
    if (!alert) {
      alert = {
        id: uuidv4(),
        type: 'sos',
        severity: 'critical',
        location: { latitude: 0, longitude: 0, address: 'Position inconnue' },
        description: `Code de contrainte activé par ${user.name}.`,
        createdBy: user.name,
        reporterId: user.id,
        organizationId: user.organizationId,
        origin: 'mobile',
        createdAt: Date.now(),
        status: 'active',
        respondingUsers: [],
        photos: [],
      };
    }
    alert.isDuress = true;
    alert.description = isNew ? alert.description : `⚠️ Code de contrainte — "annulation" de SOS forcée. ${alert.description}`;
    if (!alert.revealedUserIds) alert.revealedUserIds = [];
    if (!alert.revealedUserIds.includes(user.id)) alert.revealedUserIds.push(user.id);
    alerts.set(alert.id, alert);
    if (isNew) linkPossibleDuplicates(alert);
    persistAlerts();
    saveAlertToSupabase(alert).catch(e => console.error('[Duress] Supabase save error:', e));
    addAuditEntry('incident', 'Duress code triggered', user.id, `Alert ${alert.id}`, undefined, user.organizationId);

    // Auto-reveal: same effect as POST /alerts/:id/reveal, but performed
    // synchronously here rather than waiting on the push+confirm round trip —
    // someone forced into this has no time to spare on a second tap.
    const runtimeUser = users.get(user.id);
    if (runtimeUser?.location) {
      const showMsg = { type: 'userLocationUpdate', userId: user.id, name: user.name, location: runtimeUser.location, timestamp: Date.now() };
      broadcastToOrgRole(user.organizationId, 'dispatcher', showMsg);
      broadcastToOrgRole(user.organizationId, 'admin', showMsg);
    }

    // Deliberately role-scoped rather than the usual broadcastToOrg() fan-out
    // to every connected client in the organization — that would also reach
    // the reporter's own phone (which stays connected) and could trigger a
    // siren/visible update on the exact device this whole feature exists to
    // keep quiet.
    const duressMsg = {
      type: isNew ? 'newAlert' : 'alertUpdate',
      data: { ...alert, respondingNames: alert.respondingUsers.map(uid => adminUsers.get(uid)?.name || uid) },
    };
    broadcastToOrgRole(user.organizationId, 'dispatcher', duressMsg);
    broadcastToOrgRole(user.organizationId, 'admin', duressMsg);
    broadcastToOrgRole(user.organizationId, 'responder', duressMsg);
    sendPushToDispatchersAndResponders(alert, user.name).catch(() => {});

    return res.json({ result: 'duress' });
  }

  res.status(401).json({ result: 'invalid' });
});

// GET /api/conversations?userId=xxx - list conversations for a user. userId
// defaults to the caller; requesting someone else's requires staff + same org.
app.get('/api/conversations', (req, res) => {
  const caller = req.supabaseUser!;
  const userId = (req.query.userId as string) || caller.id;
  if (userId !== caller.id) {
    const isStaff = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'superadmin';
    if (!isStaff || !canAccessOrg(caller, adminUsers.get(userId)?.organizationId)) {
      return res.status(403).json({ error: 'Not authorized' });
    }
  }
  const userConvos: any[] = [];
  conversations.forEach((conv) => {
    if (!canAccessOrg(caller, conv.organizationId)) return;
    const allParticipants = resolveGroupParticipants(conv, conv.organizationId);
    const isStaffCaller = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder' || caller.role === 'superadmin';
    const staffSeesResidence = conv.type === 'residence' && isStaffCaller && userId === caller.id
      && conv.addressId && canAccessUser(caller, resolveAddressOwner(conv.addressId) || '');
    if (allParticipants.includes(userId) || conv.createdBy === userId || staffSeesResidence) {
      const convMessages = messages.get(conv.id) || [];
      const lastMsg = convMessages.length > 0 ? convMessages[convMessages.length - 1] : null;
      // For direct conversations, resolve the other participant's name
      let displayName = conv.name;
      if (conv.type === 'direct') {
        const otherId = conv.participantIds.find(id => id !== userId);
        const otherUser = otherId ? adminUsers.get(otherId) : null;
        displayName = otherUser ? otherUser.name : conv.name;
      }
      const unreadCounts = (conv as any).unreadCounts || {};
      userConvos.push({
        ...conv,
        displayName,
        participantCount: allParticipants.length,
        lastMessage: lastMsg ? lastMsg.text : conv.lastMessage,
        lastMessageTime: lastMsg ? lastMsg.timestamp : conv.lastMessageTime,
        lastSenderName: lastMsg ? lastMsg.senderName : '',
        unreadCount: unreadCounts[userId] || 0,
      });
    }
  });
  userConvos.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  res.json(userConvos);
});

// POST /api/conversations - create a conversation (direct or group)
app.post('/api/conversations', (req, res) => {
  const { type, name, participantIds, filterRole, filterTags } = req.body;
  const caller = req.supabaseUser!;
  const createdBy = caller.id;
  if (!type) return res.status(400).json({ error: 'type required (direct or group)' });
  // Never trust participantIds from the client beyond filtering to the
  // caller's own organization — closes both identity spoofing (any id, any
  // role) and cross-org conversation creation in one pass.
  const orgParticipantIds = Array.isArray(participantIds)
    ? participantIds.filter((id: string) => id === createdBy || adminUsers.get(id)?.organizationId === caller.organizationId)
    : [];

  // For direct conversations, check if one already exists between these two users
  if (type === 'direct' && orgParticipantIds.length === 2 && orgParticipantIds.includes(createdBy)) {
    const sorted = [...orgParticipantIds].sort();
    const existingId = `dm-${sorted[0]}-${sorted[1]}`;
    const existing = conversations.get(existingId);
    if (existing) return res.json(existing);

    const conv: Conversation = {
      id: existingId,
      type: 'direct',
      name: name || 'Direct Message',
      participantIds: sorted,
      createdBy,
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
      lastMessage: '',
      organizationId: caller.organizationId,
    };
    conversations.set(conv.id, conv);
    messages.set(conv.id, []);
    return res.json(conv);
  }

  // Group conversation
  const convId = `grp-${uuidv4().slice(0, 8)}`;
  const conv: Conversation = {
    id: convId,
    type: 'group',
    name: name || 'Group Chat',
    participantIds: orgParticipantIds.length > 0 ? orgParticipantIds : [createdBy],
    filterRole: filterRole || undefined,
    filterTags: filterTags || undefined,
    createdBy,
    createdAt: Date.now(),
    lastMessageTime: Date.now(),
    lastMessage: '',
    organizationId: caller.organizationId,
  };
  conversations.set(conv.id, conv);
  messages.set(conv.id, []);

  // Add system message
  const creatorUser = adminUsers.get(createdBy);
  const sysMsg: ChatMessage = {
    id: uuidv4(),
    conversationId: convId,
    senderId: 'system',
    senderName: 'System',
    senderRole: 'system',
    text: `Group "${conv.name}" created by ${creatorUser?.name || createdBy}`,
    type: 'system',
    timestamp: Date.now(),
  };
  messages.get(convId)!.push(sysMsg);

  res.json(conv);
});

// POST /api/family/team-conversation - get-or-create the standing group chat
// between a family and their dispatch team. Deterministic id per family
// (team-${familyGroupId}) so every tap of "Parler à mon équipe" reopens the
// same thread instead of spawning duplicates; membership resolves live via
// filterRole:'dispatcher' (resolveGroupParticipants), same as any other
// role-filtered group.
app.post('/api/family/team-conversation', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const convId = `team-${getFamilyGroupId(caller.id)}`;
  const existing = conversations.get(convId);
  if (existing) return res.json(existing);
  const conv: Conversation = {
    id: convId,
    type: 'group',
    name: 'Mon équipe sécurité',
    participantIds: [caller.id],
    filterRole: 'dispatcher',
    createdBy: caller.id,
    createdAt: Date.now(),
    lastMessageTime: Date.now(),
    lastMessage: '',
    organizationId: caller.organizationId,
  };
  conversations.set(conv.id, conv);
  messages.set(conv.id, []);
  saveConversationToSupabase(conv).catch(() => {});
  res.json(conv);
});

// POST /api/addresses/:addressId/conversation - get-or-create the standing
// chat channel for a residence (family + assigned staff of that address).
// Idempotent (deterministic id res-${addressId}) so "💬 Discussion résidence"
// always opens the same thread; membership resolves live via
// resolveGroupParticipants's 'residence' branch, never goes stale as family
// membership changes.
app.post('/api/addresses/:addressId/conversation', requireAuth, (req, res) => {
  const addressId = req.params.addressId as string;
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canViewAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const convId = `res-${addressId}`;
  const existing = conversations.get(convId);
  if (existing) return res.json(existing);
  const owner = adminUsers.get(ownerId);
  const addr = (userAddresses.get(ownerId) || []).find(a => a.id === addressId);
  const conv: Conversation = {
    id: convId,
    type: 'residence',
    name: addr?.label ? `Résidence — ${addr.label}` : `Résidence de ${owner?.name || ownerId}`,
    participantIds: [],
    addressId,
    createdBy: caller.id,
    createdAt: Date.now(),
    lastMessageTime: Date.now(),
    lastMessage: '',
    organizationId: owner?.organizationId,
  };
  conversations.set(conv.id, conv);
  messages.set(conv.id, []);
  saveConversationToSupabase(conv).catch(() => {});
  res.json(conv);
});

// POST /api/conversations/:id/media - upload image or audio
app.post('/api/conversations/:id/media', uploadMedia.single('file'), async (req: any, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!canAccessConversation(conv, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { senderName, mediaType } = req.body;
  const senderId = req.supabaseUser!.id;

  const senderUser = adminUsers.get(senderId);

  // Upload vers Supabase Storage pour persistance
  let mediaUrl = `/uploads/${req.file.filename}`; // fallback local
  try {
    const fileBuffer = fs.readFileSync(req.file.path);
    const fileName = `${Date.now()}-${req.file.filename}`;
    const mimeType = req.file.mimetype || (mediaType === 'audio' ? 'audio/m4a' : 'image/jpeg');
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
      .from('media')
      .upload(fileName, fileBuffer, { contentType: mimeType, upsert: false });
    if (!uploadError && uploadData) {
      const { data: { publicUrl } } = supabaseAdmin.storage.from('media').getPublicUrl(fileName);
      mediaUrl = publicUrl;
      console.log('[Media] Uploaded to Supabase Storage:', mediaUrl);
    } else {
      console.warn('[Media] Supabase Storage upload failed, using local:', uploadError?.message);
    }
  } catch (e) {
    console.warn('[Media] Storage error, using local fallback:', e);
  }
  const msgType = mediaType === 'audio' ? 'audio' : mediaType === 'document' ? 'document' : mediaType === 'video' ? 'video' : 'image';
  const fileName = req.body.fileName || req.file.originalname || 'Document';
  const text = mediaType === 'audio' ? '🎤 Message vocal' : mediaType === 'document' ? `📎 ${fileName}` : mediaType === 'video' ? '🎥 Vidéo' : '📷 Photo';

  const msg: ChatMessage = {
    id: uuidv4(),
    conversationId: conv.id,
    senderId,
    senderName: senderName || senderUser?.name || senderId,
    senderRole: senderUser?.role || 'user',
    text,
    type: msgType,
    mediaUrl,
    mediaType: msgType,
    timestamp: Date.now(),
  };

  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id)!.push(msg);
  saveMessageToSupabase(msg).catch(() => {});
  conv.lastMessage = text;
  conv.lastMessageTime = msg.timestamp;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {});

  const allParticipants = resolveGroupParticipants(conv, conv.organizationId);
  const wsPayload = JSON.stringify({ type: 'newMessage', data: { ...msg, conversationName: conv.name, conversationType: conv.type } });
  allParticipants.forEach(pid => {
    const conns = userConnections.get(pid);
    if (conns) conns.forEach(ws => { try { ws.send(wsPayload); } catch {} });
  });

  for (const pid of allParticipants) {
    if (pid === senderId) continue;
    sendPushToUser(pid, `${msgType === 'audio' ? '🎤' : '📷'} ${msg.senderName}`,
      msgType === 'audio' ? 'Message vocal' : msgType === 'document' ? 'Document partagé' : msgType === 'video' ? 'Vidéo partagée' : 'Photo',
      { type: 'message', conversationId: conv.id, senderId }
    ).catch(() => {});
  }

  console.log(`[MSG Media] ${msg.senderName} -> ${conv.name} (${conv.id}): ${msgType}`);
  res.json({ message: { ...msg, content: msg.text } });
});

// PUT /api/conversations/:id/read - mark conversation as read for a user
app.put('/api/conversations/:id/read', async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!canAccessConversation(conv, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const userId = req.supabaseUser!.id;
  const unreadCounts = (conv as any).unreadCounts || {};
  unreadCounts[userId] = 0;
  (conv as any).unreadCounts = unreadCounts;
  conversations.set(conv.id, conv);
  await supabaseAdmin.from('conversations').update({ unread_counts: unreadCounts }).eq('id', conv.id);
  res.json({ success: true });
});

// GET /api/conversations/:id/messages - get messages for a conversation
app.get('/api/conversations/:id/messages', async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!canAccessConversation(conv, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  if (!messages.has(conv.id)) {
    try {
      const { data } = await supabaseAdmin.from('messages')
        .select('*').eq('conversation_id', conv.id).order('timestamp', { ascending: true });
      if (data && data.length > 0) {
        const loaded = data.map((m: any) => ({
          id: m.id, conversationId: m.conversation_id, senderId: m.sender_id,
          senderName: m.sender_name, senderRole: m.sender_role,
          text: m.text, type: m.type, timestamp: m.timestamp,
          mediaUrl: m.media_url || undefined, mediaType: m.media_type || undefined,
          location: m.location || undefined,
        }));
        messages.set(conv.id, loaded);
      }
    } catch (e) { console.error('[Messages] Supabase load error:', e); }
  }
  const convMessages = messages.get(conv.id) || [];
  const since = req.query.since ? parseInt(req.query.since as string) : 0;
  const filtered = since > 0 ? convMessages.filter(m => m.timestamp > since) : convMessages;
  res.json(filtered);
});

// POST /api/conversations/:id/messages - send a message
app.post('/api/conversations/:id/messages', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!canAccessConversation(conv, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const { text, type: msgType } = req.body;
  const senderId = req.supabaseUser!.id;
  if (!text) return res.status(400).json({ error: 'text required' });

  const senderUser = adminUsers.get(senderId);
  const msg: ChatMessage = {
    id: uuidv4(),
    conversationId: conv.id,
    senderId,
    senderName: senderUser?.name || senderId,
    senderRole: senderUser?.role || 'user',
    text,
    type: msgType || 'text',
    timestamp: Date.now(),
  };

  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id)!.push(msg);
  saveMessageToSupabase(msg).catch(() => {});

  // Update conversation metadata + unread counts
  conv.lastMessage = text;
  conv.lastMessageTime = msg.timestamp;
  // Incrémenter unread pour tous les participants sauf l'expéditeur
  const allPartsForUnread = resolveGroupParticipants(conv, conv.organizationId);
  const unreadCounts: Record<string, number> = (conv as any).unreadCounts || {};
  for (const pid of allPartsForUnread) {
    if (pid !== senderId) {
      unreadCounts[pid] = (unreadCounts[pid] || 0) + 1;
    }
  }
  (conv as any).unreadCounts = unreadCounts;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {});
  // Sauvegarder unread_counts dans Supabase
  supabaseAdmin.from('conversations').update({ unread_counts: unreadCounts }).eq('id', conv.id).then(() => {}).catch(() => {});

  // Broadcast to all participants via WebSocket
  const allParticipants = resolveGroupParticipants(conv, conv.organizationId);
  const wsMessage = {
    type: 'newMessage',
    data: { ...msg, conversationName: conv.name, conversationType: conv.type },
  };
  const wsPayload = JSON.stringify(wsMessage);
  allParticipants.forEach(pid => {
    const conns = userConnections.get(pid);
    if (conns) {
      conns.forEach(ws => {
        try { ws.send(wsPayload); } catch (e) { /* ignore */ }
      });
    }
  });
  // Also relay to dispatch/admin of this conversation's own organization
  // (so dispatch console always receives) — previously an unscoped
  // userConnections.forEach that reached every org's dispatchers/admins.
  // Skips anyone already reached via allParticipants above, same as before.
  userConnections.forEach((conns, uid) => {
    const u = adminUsers.get(uid);
    if (u && (u.role === 'dispatcher' || u.role === 'admin') && u.organizationId === conv.organizationId && !allParticipants.includes(uid)) {
      conns.forEach(ws => {
        try { ws.send(wsPayload); } catch (e) { /* ignore */ }
      });
    }
  });

  // Push notifications à tous les participants (sauf l'expéditeur)
  for (const pid of allParticipants) {
    if (pid === senderId) continue;
    sendPushToUser(pid, `💬 ${msg.senderName}`, text.substring(0, 100),
      { type: 'message', conversationId: conv.id, senderId, senderName: msg.senderName }
    ).catch(() => {});
  }
  console.log(`[MSG] ${msg.senderName} -> ${conv.name} (${conv.id}): ${text.substring(0, 50)}`);
  res.json(msg);
});

// ─── Messaging Alias Routes (for dispatch console) ─────────────────────

// GET /api/messaging/users - list all users with tags
app.get('/api/messaging/users', (req, res) => {
  const users = Array.from(adminUsers.values())
    .filter(u => canAccessOrg(req.supabaseUser!, u.organizationId))
    .map(u => ({
      id: u.id,
      name: u.name,
      role: u.role,
      tags: u.tags || [],
      status: u.status,
    }));
  res.json({ users });
});

// GET /api/messaging/conversations - alias for /api/conversations
app.get('/api/messaging/conversations', (req, res) => {
  const caller = req.supabaseUser!;
  const userId = req.query.userId as string;
  // No userId -> every conversation of the caller's own organization
  // (previously every conversation of every organization on the platform).
  const orgConvs = Array.from(conversations.values()).filter(c => canAccessOrg(caller, c.organizationId));
  const filtered = userId
    ? orgConvs.filter(c => {
        const participants = resolveGroupParticipants(c, c.organizationId);
        return participants.includes(userId);
      })
    : orgConvs;
  const result = filtered.map(c => {
    const msgs = messages.get(c.id) || [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return {
      ...c,
      participants: resolveGroupParticipants(c, c.organizationId),
      lastMessage: lastMsg ? lastMsg.text : c.lastMessage,
      lastMessageAt: lastMsg ? new Date(lastMsg.timestamp).toISOString() : (c.lastMessageTime ? new Date(c.lastMessageTime).toISOString() : null),
    };
  });
  // Sort by last message time
  result.sort((a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime());
  res.json({ conversations: result });
});

// POST /api/messaging/conversations - create conversation
app.post('/api/messaging/conversations', (req, res) => {
  const { type, name, groupType, participants, tags } = req.body;
  if (!type) return res.status(400).json({ error: 'type required' });
  const caller = req.supabaseUser!;
  const createdBy = caller.id;

  // Client-supplied participants are trusted only for org membership —
  // filtered, never rejected outright, same reasoning as POST /api/conversations.
  let finalParticipants: string[] = Array.isArray(participants)
    ? participants.filter((id: string) => id === createdBy || adminUsers.get(id)?.organizationId === caller.organizationId)
    : [];

  // If tags are provided, resolve participants by tags — scoped to the
  // caller's own organization (previously matched tag names across every
  // organization's staff roster).
  if (tags && tags.length > 0 && (!participants || participants.length <= 1)) {
    const tagUsers = Array.from(adminUsers.values())
      .filter(u => u.organizationId === caller.organizationId && u.tags && u.tags.some((t: string) => tags.includes(t)))
      .map(u => u.id);
    finalParticipants = [...new Set([createdBy, ...tagUsers])];
  }

  // For direct conversations, check if one already exists
  if (type === 'direct' && finalParticipants.length === 2) {
    const sorted = [...finalParticipants].sort();
    const existingId = `dm-${sorted[0]}-${sorted[1]}`;
    const existing = conversations.get(existingId);
    if (existing) {
      return res.json({ conversation: { ...existing, participants: existing.participantIds } });
    }
  }

  // Determine filterTags from groupType if provided
  let filterTags: string[] | undefined;
  let filterRole: string | undefined;
  if (groupType?.startsWith('role:')) {
    filterRole = groupType.replace('role:', '');
  }
  if (groupType?.startsWith('tags:') || (tags && tags.length > 0)) {
    filterTags = tags || groupType?.replace('tags:', '').split(',');
  }

  const convId = type === 'direct' && finalParticipants.length === 2
    ? `dm-${[...finalParticipants].sort().join('-')}`
    : `grp-${uuidv4().slice(0, 8)}`;

  const conv: Conversation = {
    id: convId,
    type: type || 'direct',
    name: name || (type === 'direct' ? 'Direct Message' : 'Group'),
    participantIds: finalParticipants,
    filterRole,
    filterTags,
    createdBy,
    createdAt: Date.now(),
    lastMessage: '',
    lastMessageTime: Date.now(),
    organizationId: caller.organizationId,
  };

  conversations.set(conv.id, conv);
  messages.set(conv.id, []);

  // Add system message for groups
  if (type === 'group') {
    const creatorUser = adminUsers.get(createdBy);
    const sysMsg: ChatMessage = {
      id: uuidv4(),
      conversationId: convId,
      senderId: 'system',
      senderName: 'System',
      senderRole: 'system',
      text: `Group "${conv.name}" created by ${creatorUser?.name || createdBy}`,
      type: 'system',
      timestamp: Date.now(),
    };
    messages.get(convId)!.push(sysMsg);
  }

  saveConversationToSupabase(conv).catch(() => {});
  console.log(`[MSG] Conversation created: ${conv.name || conv.type} (${conv.id}) by ${createdBy}`);
  // Return with 'participants' alias for dispatch console compatibility
  res.json({ conversation: { ...conv, participants: conv.participantIds } });
});

// GET /api/messaging/conversations/:id/messages - get messages
app.get('/api/messaging/conversations/:id/messages', async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!canAccessConversation(conv, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  // Si pas en mémoire, charger depuis Supabase
  if (!messages.has(conv.id)) {
    try {
      const { data } = await supabaseAdmin.from('messages')
        .select('*').eq('conversation_id', conv.id).order('timestamp', { ascending: true });
      if (data && data.length > 0) {
        const loaded = data.map((m: any) => ({
          id: m.id, conversationId: m.conversation_id, senderId: m.sender_id,
          senderName: m.sender_name, senderRole: m.sender_role,
          text: m.text, type: m.type, timestamp: m.timestamp,
          mediaUrl: m.media_url || undefined, mediaType: m.media_type || undefined,
          location: m.location || undefined,
        }));
        messages.set(conv.id, loaded);
      }
    } catch (e) { console.error('[Messages] Supabase load error:', e); }
  }
  const msgs = messages.get(conv.id) || [];
  // Map to use 'content' field for dispatch console compatibility
  const mapped = msgs.map(m => ({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: m.senderName,
    senderRole: m.senderRole,
    content: m.text,
    text: m.text,
    type: m.type,
    timestamp: new Date(m.timestamp).toISOString(),
    mediaUrl: m.mediaUrl || undefined,
    mediaType: m.mediaType || undefined,
    location: m.location || undefined,
  }));
  res.json({ messages: mapped });
});

// POST /api/messaging/conversations/:id/messages - send message
app.post('/api/messaging/conversations/:id/messages', (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!canAccessConversation(conv, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const { senderName, content } = req.body;
  const senderId = req.supabaseUser!.id;
  if (!content) return res.status(400).json({ error: 'content required' });

  const senderUser = adminUsers.get(senderId);
  const msg: ChatMessage = {
    id: uuidv4(),
    conversationId: conv.id,
    senderId,
    senderName: senderName || senderUser?.name || senderId,
    senderRole: senderUser?.role || 'dispatcher',
    text: content,
    type: 'text',
    timestamp: Date.now(),
  };

  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id)!.push(msg);
  saveMessageToSupabase(msg).catch(() => {});

  conv.lastMessage = content;
  conv.lastMessageTime = msg.timestamp;
  // Incrémenter unread pour tous les participants sauf l'expéditeur
  const unreadCountsMsg: Record<string, number> = (conv as any).unreadCounts || {};
  const allPartsMsg = resolveGroupParticipants(conv, conv.organizationId);
  for (const pid of allPartsMsg) {
    if (pid !== senderId) {
      unreadCountsMsg[pid] = (unreadCountsMsg[pid] || 0) + 1;
    }
  }
  (conv as any).unreadCounts = unreadCountsMsg;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {});
  supabaseAdmin.from('conversations').update({ unread_counts: unreadCountsMsg }).eq('id', conv.id).then(() => {}).catch(() => {});

  // Broadcast to all participants via WebSocket
  const allParticipants = resolveGroupParticipants(conv, conv.organizationId);
  const wsPayload = JSON.stringify({
    type: 'newMessage',
    data: { ...msg, content: msg.text, conversationName: conv.name, conversationType: conv.type },
  });
  allParticipants.forEach(pid => {
    const conns = userConnections.get(pid);
    if (conns) {
      conns.forEach(ws => {
        try { ws.send(wsPayload); } catch (e) { /* ignore */ }
      });
    }
  });
  // Also broadcast to dispatcher/admin connections of this conversation's
  // own organization (previously reached every org's dispatchers/admins).
  userConnections.forEach((conns, uid) => {
    const u = adminUsers.get(uid);
    if (u && (u.role === 'dispatcher' || u.role === 'admin') && u.organizationId === conv.organizationId && !allParticipants.includes(uid)) {
      conns.forEach(ws => {
        try { ws.send(wsPayload); } catch (e) { /* ignore */ }
      });
    }
  });

  // Push notifications à tous les participants (sauf l'expéditeur)
  const notifiedPids = new Set<string>([senderId]);
  for (const pid of allParticipants) {
    if (notifiedPids.has(pid)) continue;
    notifiedPids.add(pid);
    sendPushToUser(pid, `💬 ${msg.senderName}`, content.substring(0, 100),
      { type: 'message', conversationId: conv.id, senderId, senderName: msg.senderName }
    ).catch(() => {});
  }

  console.log(`[MSG] ${msg.senderName} -> ${conv.name || conv.type} (${conv.id}): ${content.substring(0, 50)}`);
  res.json({ message: { ...msg, content: msg.text } });
});

// GET /api/messaging/tags - list all available tags
app.get('/api/messaging/tags', (req, res) => {
  const caller = req.supabaseUser!;
  const tagSet = new Set<string>();
  adminUsers.forEach(u => {
    if (u.organizationId === caller.organizationId) (u.tags || []).forEach((t: string) => tagSet.add(t));
  });
  res.json({ tags: [...tagSet].sort() });
});
// ─── Patrol Reports REST API ─────────────────────────────────────────────────────────────

// Predefined patrol statuses with severity levels
const PATROL_STATUS_CONFIG: Record<PatrolStatus, { label: string; color: string; severity: number }> = {
  habituel:       { label: 'Habituel',       color: '#22C55E', severity: 0 },
  inhabituel:     { label: 'Inhabituel',     color: '#EAB308', severity: 1 },
  identification: { label: 'Identification', color: '#F97316', severity: 2 },
  suspect:        { label: 'Suspect',        color: '#EF4444', severity: 3 },
  menace:         { label: 'Menace',         color: '#8B5CF6', severity: 4 },
  attaque:        { label: 'Attaque',        color: '#000000', severity: 5 },
};

// Coverage thresholds for the dispatch console's per-site "last patrolled" view
const PATROL_COVERAGE_WARNING_HOURS = 4;
const PATROL_COVERAGE_CRITICAL_HOURS = 8;

// GET /api/patrol/sites - list this caller's organization's patrol sites.
// Response shape ({ sites: string[] }) is unchanged from the old hardcoded
// PATROL_SITES constant, so app/(tabs)/patrol.tsx needs no changes.
app.get('/api/patrol/sites', requireAuth, (req, res) => {
  const accessibleSites = Array.from(patrolSites.values())
    .filter(s => canAccessOrg(req.supabaseUser!, s.organizationId));
  res.json({
    sites: accessibleSites.map(s => s.name), // back-compat: name-only list for the quick-report picker
    siteObjects: accessibleSites.map(s => ({ id: s.id, name: s.name })), // needed for GPS rounds, which key sites by id
  });
});

// ─── Patrol sites management (each organization configures its own) ─────
app.get('/admin/patrol-sites', requireAuth, requireRole('admin'), (req, res) => {
  const sites = Array.from(patrolSites.values()).filter(s => canAccessOrg(req.supabaseUser!, s.organizationId));
  res.json(sites);
});

// GET /admin/patrol-sites/risk-scores — batch, all sites this caller can
// access, for a dashboard table. Computed on read (no precomputation/cache
// — cheap at this data volume, see computeSiteRiskScore).
app.get('/admin/patrol-sites/risk-scores', requireAuth, requireRole('admin'), (req, res) => {
  const sites = Array.from(patrolSites.values()).filter(s => canAccessOrg(req.supabaseUser!, s.organizationId));
  const results = sites.map(s => computeSiteRiskScore(s.id, s.organizationId)).filter((r): r is SiteRiskResult => r !== null);
  res.json(results);
});

app.get('/admin/patrol-sites/:id/risk-score', requireAuth, requireRole('admin'), (req, res) => {
  const site = patrolSites.get(req.params.id as string);
  if (!site) return res.status(404).json({ error: 'Patrol site not found' });
  if (!canAccessOrg(req.supabaseUser!, site.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const result = computeSiteRiskScore(site.id, site.organizationId);
  res.json(result);
});

app.post('/admin/patrol-sites', requireAuth, requireRole('admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const isSuperadminCaller = req.supabaseUser!.role === 'superadmin';
  let organizationId: string | undefined;
  if (isSuperadminCaller) {
    organizationId = req.body.organizationId;
    if (!organizationId || !organizations.has(organizationId)) {
      return res.status(400).json({ error: 'A valid organizationId is required' });
    }
  } else {
    organizationId = req.supabaseUser!.organizationId;
  }
  const { address, latitude, longitude } = req.body;
  const site: PatrolSite = {
    id: uuidv4(), organizationId: organizationId!, name, createdAt: Date.now(),
    address: address || undefined,
    latitude: typeof latitude === 'number' ? latitude : undefined,
    longitude: typeof longitude === 'number' ? longitude : undefined,
  };
  patrolSites.set(site.id, site);
  savePatrolSiteToSupabase(site).catch(e => console.error('[PatrolSites] Supabase save error:', e));
  addAuditEntry('system', 'Patrol Site Created', req.supabaseUser!.id, `New patrol site: ${name}`, site.id, site.organizationId);
  res.status(201).json(site);
});

// PUT /admin/patrol-sites/:id - edit name/address, mainly so an existing
// site (created name-only before this field existed) can get a real
// destination for route-planning without needing to configure checkpoints.
app.put('/admin/patrol-sites/:id', requireAuth, requireRole('admin'), (req, res) => {
  const site = patrolSites.get(req.params.id as string);
  if (!site) return res.status(404).json({ error: 'Patrol site not found' });
  if (!canAccessOrg(req.supabaseUser!, site.organizationId)) return res.status(403).json({ error: 'Not authorized' });

  if (typeof req.body.name === 'string' && req.body.name.trim()) site.name = req.body.name.trim();
  if ('address' in req.body) site.address = req.body.address || undefined;
  if (typeof req.body.latitude === 'number') site.latitude = req.body.latitude;
  if (typeof req.body.longitude === 'number') site.longitude = req.body.longitude;

  patrolSites.set(site.id, site);
  savePatrolSiteToSupabase(site).catch(e => console.error('[PatrolSites] Supabase save error:', e));
  addAuditEntry('system', 'Patrol Site Updated', req.supabaseUser!.id, `Updated patrol site: ${site.name}`, site.id, site.organizationId);
  res.json(site);
});

app.delete('/admin/patrol-sites/:id', requireAuth, requireRole('admin'), (req, res) => {
  const site = patrolSites.get(req.params.id as string);
  if (!site) return res.status(404).json({ error: 'Patrol site not found' });
  if (!canAccessOrg(req.supabaseUser!, site.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  patrolSites.delete(site.id);
  deletePatrolSiteFromSupabase(site.id).catch(e => console.error('[PatrolSites] Supabase delete error:', e));
  addAuditEntry('system', 'Patrol Site Deleted', req.supabaseUser!.id, `Deleted patrol site: ${site.name}`, site.id, site.organizationId);
  res.json({ success: true });
});

// ─── Patrol checkpoints (GPS waypoints per site, for ronde verification) ─
app.get('/admin/patrol-checkpoints', requireAuth, requireRole('admin'), (req, res) => {
  const siteId = req.query.siteId as string | undefined;
  let checkpoints = Array.from(patrolCheckpoints.values()).filter(c => canAccessOrg(req.supabaseUser!, c.organizationId));
  if (siteId) checkpoints = checkpoints.filter(c => c.siteId === siteId);
  res.json(checkpoints);
});

app.post('/admin/patrol-checkpoints', requireAuth, requireRole('admin'), (req, res) => {
  const { siteId, name, latitude, longitude, radiusMeters, minDwellSeconds } = req.body;
  const trimmedName = (name || '').trim();
  if (!siteId || !trimmedName || latitude == null || longitude == null || !radiusMeters) {
    return res.status(400).json({ error: 'siteId, name, latitude, longitude and radiusMeters are required' });
  }
  const site = patrolSites.get(siteId);
  if (!site) return res.status(404).json({ error: 'Patrol site not found' });
  if (!canAccessOrg(req.supabaseUser!, site.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const checkpoint: PatrolCheckpoint = {
    id: uuidv4(),
    siteId,
    organizationId: site.organizationId,
    name: trimmedName,
    latitude: Number(latitude),
    longitude: Number(longitude),
    radiusMeters: Number(radiusMeters),
    minDwellSeconds: minDwellSeconds != null ? Number(minDwellSeconds) : undefined,
    createdAt: Date.now(),
  };
  patrolCheckpoints.set(checkpoint.id, checkpoint);
  savePatrolCheckpointToSupabase(checkpoint).catch(e => console.error('[PatrolCheckpoints] Supabase save error:', e));
  addAuditEntry('system', 'Patrol Checkpoint Created', req.supabaseUser!.id, `New checkpoint "${checkpoint.name}" on site ${site.name}`, checkpoint.id, checkpoint.organizationId);
  res.status(201).json(checkpoint);
});

app.put('/admin/patrol-checkpoints/:id', requireAuth, requireRole('admin'), (req, res) => {
  const checkpoint = patrolCheckpoints.get(req.params.id as string);
  if (!checkpoint) return res.status(404).json({ error: 'Checkpoint not found' });
  if (!canAccessOrg(req.supabaseUser!, checkpoint.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const { name, latitude, longitude, radiusMeters, minDwellSeconds } = req.body;
  if (name !== undefined) checkpoint.name = String(name).trim();
  if (latitude !== undefined) checkpoint.latitude = Number(latitude);
  if (longitude !== undefined) checkpoint.longitude = Number(longitude);
  if (radiusMeters !== undefined) checkpoint.radiusMeters = Number(radiusMeters);
  if (minDwellSeconds !== undefined) checkpoint.minDwellSeconds = minDwellSeconds === null ? undefined : Number(minDwellSeconds);
  patrolCheckpoints.set(checkpoint.id, checkpoint);
  savePatrolCheckpointToSupabase(checkpoint).catch(e => console.error('[PatrolCheckpoints] Supabase save error:', e));
  addAuditEntry('system', 'Patrol Checkpoint Updated', req.supabaseUser!.id, `Updated checkpoint "${checkpoint.name}"`, checkpoint.id, checkpoint.organizationId);
  res.json(checkpoint);
});

app.delete('/admin/patrol-checkpoints/:id', requireAuth, requireRole('admin'), (req, res) => {
  const checkpoint = patrolCheckpoints.get(req.params.id as string);
  if (!checkpoint) return res.status(404).json({ error: 'Checkpoint not found' });
  if (!canAccessOrg(req.supabaseUser!, checkpoint.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  patrolCheckpoints.delete(checkpoint.id);
  deletePatrolCheckpointFromSupabase(checkpoint.id).catch(e => console.error('[PatrolCheckpoints] Supabase delete error:', e));
  addAuditEntry('system', 'Patrol Checkpoint Deleted', req.supabaseUser!.id, `Deleted checkpoint "${checkpoint.name}"`, checkpoint.id, checkpoint.organizationId);
  res.json({ success: true });
});

// ─── Patrol rounds (GPS-tracked, live) ───────────────────────────────────
// POST /api/patrol/rounds/start - begin a GPS-tracked round tied to a site.
// Checkpoint detection then runs automatically off the responder's normal
// location pings (see checkActivePatrolRound, wired into handleLocationUpdate)
// - no separate tracking call needed from the client.
app.post('/api/patrol/rounds/start', requireAuth, requireRole('responder'), (req, res) => {
  const { siteId } = req.body;
  if (!siteId) return res.status(400).json({ error: 'siteId is required' });
  const site = patrolSites.get(siteId);
  if (!site) return res.status(404).json({ error: 'Patrol site not found' });
  if (!canAccessOrg(req.supabaseUser!, site.organizationId)) return res.status(403).json({ error: 'Not authorized' });

  const caller = req.supabaseUser!;
  const existing = Array.from(activePatrolRounds.values()).find(r => r.responderId === caller.id);
  if (existing) return res.status(409).json({ error: 'Une ronde est déjà en cours', roundId: existing.id });

  const siteCheckpoints = Array.from(patrolCheckpoints.values()).filter(c => c.siteId === siteId);
  const responderName = adminUsers.get(caller.id)?.name || caller.id;
  const now = Date.now();
  const round: ActivePatrolRound = {
    id: uuidv4(),
    siteId,
    siteName: site.name,
    responderId: caller.id,
    responderName,
    organizationId: site.organizationId,
    startedAt: now,
    checkpoints: siteCheckpoints.map(c => ({
      checkpointId: c.id,
      name: c.name,
      latitude: c.latitude,
      longitude: c.longitude,
      radiusMeters: c.radiusMeters,
      minDwellSeconds: c.minDwellSeconds,
      dwellSeconds: 0,
      wasInsideLastPing: false,
      visited: false,
      dwellMet: false,
    })),
    trail: [],
    lastMovementAt: now,
  };
  activePatrolRounds.set(round.id, round);

  const payload = { type: 'patrolRoundStarted', data: round };
  broadcastToOrgRole(round.organizationId, 'dispatcher', payload);
  broadcastToOrgRole(round.organizationId, 'admin', payload);
  addAuditEntry('system', 'Ronde démarrée', responderName, `Ronde démarrée sur le site "${site.name}" (${round.checkpoints.length} checkpoint(s))`, caller.id, round.organizationId);

  res.status(201).json(round);
});

// POST /api/patrol/rounds/:id/interrupt - end early (emergency) — still produces a report
app.post('/api/patrol/rounds/:id/interrupt', requireAuth, requireRole('responder'), (req, res) => {
  const round = activePatrolRounds.get(req.params.id as string);
  if (!round) return res.status(404).json({ error: 'Active round not found' });
  if (round.responderId !== req.supabaseUser!.id) return res.status(403).json({ error: 'Not authorized' });
  const report = finalizePatrolRound(round, 'interrupted', req.body?.reason);
  res.json({ success: true, report });
});

// POST /api/patrol/rounds/:id/finish - normal completion
// A normal finish carries the same questionnaire (status/tasks/notes) a
// manual report does — media is attached afterward via the existing
// POST /api/patrol/reports/:id/media route, same as a manual report.
app.post('/api/patrol/rounds/:id/finish', requireAuth, requireRole('responder'), (req, res) => {
  const round = activePatrolRounds.get(req.params.id as string);
  if (!round) return res.status(404).json({ error: 'Active round not found' });
  if (round.responderId !== req.supabaseUser!.id) return res.status(403).json({ error: 'Not authorized' });
  const { status, tasks, notes } = req.body;
  if (!status || !PATROL_STATUS_CONFIG[status as PatrolStatus]) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${Object.keys(PATROL_STATUS_CONFIG).join(', ')}` });
  }
  if (!Array.isArray(tasks)) {
    return res.status(400).json({ error: 'tasks is required' });
  }
  const report = finalizePatrolRound(round, 'completed', undefined, { status: status as PatrolStatus, tasks, notes: notes || undefined });
  res.json({ success: true, report });
});

// GET /api/patrol/rounds/active - rounds currently in progress, org-scoped
// (used for initial page/screen load; live updates arrive via WS)
app.get('/api/patrol/rounds/active', requireAuth, (req, res) => {
  const rounds = Array.from(activePatrolRounds.values()).filter(r => canAccessOrg(req.supabaseUser!, r.organizationId));
  res.json(rounds);
});

// POST /api/patrol/routes/plan - preview a recommended route to a site,
// scored for variety (vs recent patrol_route_history) and Blackbook
// proximity. Pure preview: no persistence, no broadcast — see
// /routes/confirm for what happens once the responder actually navigates.
app.post('/api/patrol/routes/plan', requireAuth, requireRole('responder'), async (req, res) => {
  const { fromLatitude, fromLongitude, toSiteId, mode } = req.body;
  if (typeof fromLatitude !== 'number' || typeof fromLongitude !== 'number') {
    return res.status(400).json({ error: 'fromLatitude/fromLongitude are required' });
  }
  if (!toSiteId) return res.status(400).json({ error: 'toSiteId is required' });
  const site = patrolSites.get(toSiteId);
  if (!site) return res.status(404).json({ error: 'Patrol site not found' });
  if (!canAccessOrg(req.supabaseUser!, site.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  const travelMode: 'driving' | 'walking' = mode === 'walking' ? 'walking' : 'driving';

  const destination = resolveSiteDestination(toSiteId);
  if (!destination) return res.status(400).json({ error: "Ce site n'a pas d'adresse configurée — impossible de calculer une destination." });

  try {
    const candidates = await fetchDirectionsAlternatives({ latitude: fromLatitude, longitude: fromLongitude }, destination, travelMode);
    const historyRows = await fetchRecentRouteHistory(site.organizationId, toSiteId);
    const { best, rationale, alternativesConsidered } = scoreRouteCandidates(candidates, historyRows, site.organizationId);
    res.json({
      geometry: best.geometry,
      distanceMeters: best.distanceMeters,
      durationSeconds: best.durationSeconds,
      rationale,
      mode: travelMode,
      alternativesConsidered,
      toSiteId,
      toSiteName: site.name,
    });
  } catch (e: any) {
    console.error('[RoutePlan] error:', e);
    res.status(502).json({ error: 'Impossible de calculer un itinéraire pour le moment.' });
  }
});

// POST /api/patrol/routes/confirm - the responder actually starts
// navigating: persists the taken geometry to patrol_route_history (so
// future planning for this site avoids it) and broadcasts the live route
// to dispatch/admin.
app.post('/api/patrol/routes/confirm', requireAuth, requireRole('responder'), async (req, res) => {
  const { toSiteId, geometry, distanceMeters, durationSeconds, rationale, mode, fromLatitude, fromLongitude } = req.body;
  if (!toSiteId || !Array.isArray(geometry) || geometry.length === 0) {
    return res.status(400).json({ error: 'toSiteId and geometry are required' });
  }
  const site = patrolSites.get(toSiteId);
  if (!site) return res.status(404).json({ error: 'Patrol site not found' });
  if (!canAccessOrg(req.supabaseUser!, site.organizationId)) return res.status(403).json({ error: 'Not authorized' });

  const caller = req.supabaseUser!;
  const responderName = adminUsers.get(caller.id)?.name || caller.id;
  const now = Date.now();
  const travelMode: 'driving' | 'walking' = mode === 'walking' ? 'walking' : 'driving';

  saveRouteHistoryToSupabase({
    id: uuidv4(), organizationId: site.organizationId, responderId: caller.id, toSiteId,
    fromLatitude: typeof fromLatitude === 'number' ? fromLatitude : geometry[0].latitude,
    fromLongitude: typeof fromLongitude === 'number' ? fromLongitude : geometry[0].longitude,
    geometry, distanceMeters: distanceMeters || 0, durationSeconds: durationSeconds || 0, createdAt: now,
  }).catch(() => {});

  const route: ActiveResponderRoute = {
    responderId: caller.id, responderName, organizationId: site.organizationId,
    toSiteId, toSiteName: site.name, geometry, distanceMeters: distanceMeters || 0,
    durationSeconds: durationSeconds || 0, rationale: rationale || '', mode: travelMode, startedAt: now,
  };
  activeResponderRoutes.set(caller.id, route);

  const payload = { type: 'patrolRouteStarted', data: route };
  broadcastToOrgRole(site.organizationId, 'dispatcher', payload);
  broadcastToOrgRole(site.organizationId, 'admin', payload);
  addAuditEntry('system', 'Navigation démarrée', responderName, `Navigation vers "${site.name}" (${travelMode === 'walking' ? 'à pied' : 'en véhicule'})`, caller.id, site.organizationId);

  res.json({ success: true });
});

// GET /api/patrol/statuses - list predefined patrol statuses
app.get('/api/patrol/statuses', (_req, res) => {
  res.json({ statuses: PATROL_STATUS_CONFIG });
});

// POST /api/patrol/reports - create a new patrol report
app.post('/api/patrol/reports', (req, res) => {
  const { location, status, tasks, notes } = req.body;
  if (!location || !status || !tasks) {
    return res.status(400).json({ error: 'location, status, and tasks are required' });
  }

  // Validate status
  if (!PATROL_STATUS_CONFIG[status as PatrolStatus]) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${Object.keys(PATROL_STATUS_CONFIG).join(', ')}` });
  }

  const createdBy = req.supabaseUser!.id;
  const user = adminUsers.get(createdBy);
  if (!user) {
    return res.status(404).json({ error: 'User profile not found' });
  }

  const report: PatrolReport = {
    id: `PR-${uuidv4().slice(0, 8)}`,
    createdAt: Date.now(),
    createdBy,
    createdByName: user.name || createdBy,
    location,
    status: status as PatrolStatus,
    tasks,
    notes: notes || undefined,
    media: [],
    organizationId: user.organizationId,
  };

  patrolReports.unshift(report); // newest first
  persistPatrolReports();

  // Add audit log entry
  const statusConf = PATROL_STATUS_CONFIG[report.status];
  auditLog.unshift({
    id: uuidv4(),
    timestamp: Date.now(),
    category: 'patrol',
    action: 'Patrol Report Created',
    performedBy: report.createdByName,
    details: `Rapport de ronde: ${report.location} — Statut: ${statusConf.label}`,
  });

  // If status is NOT 'habituel' (green), send alert to dispatchers and admins
  if (report.status !== 'habituel') {
    const alertMsg = {
      type: 'patrolAlert',
      data: {
        reportId: report.id,
        location: report.location,
        status: report.status,
        statusLabel: statusConf.label,
        statusColor: statusConf.color,
        createdByName: report.createdByName,
        createdAt: report.createdAt,
        tasks: report.tasks,
        notes: report.notes,
      },
    };
    broadcastToOrgRole(user.organizationId, 'dispatcher', alertMsg);
    broadcastToOrgRole(user.organizationId, 'admin', alertMsg);

    // Also send push notifications to dispatchers and admins
    const pushTitle = `\u26A0\uFE0F Ronde ${statusConf.label}`;
    const pushBody = `${report.createdByName} — ${report.location}\nStatut: ${statusConf.label}${report.notes ? '\n' + report.notes : ''}`;
    const pushTokenEntries = Array.from(pushTokens.entries());
    const dispatchAdminTokens = pushTokenEntries
      .filter(([_, entry]) => {
        const u = adminUsers.get(entry.userId);
        return u && (u.role === 'dispatcher' || u.role === 'admin');
      })
      .map(([token]) => token);

    if (dispatchAdminTokens.length > 0) {
      const pushMessages = dispatchAdminTokens.map(token => ({
        to: token,
        sound: 'default',
        title: pushTitle,
        body: pushBody,
        data: { type: 'patrol_alert', reportId: report.id },
      }));
      fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pushMessages),
      }).catch(err => console.error('[Patrol] Push notification error:', err));
    }

    console.log(`[Patrol] ALERT: ${statusConf.label} report at ${report.location} by ${report.createdByName}`);
  } else {
    console.log(`[Patrol] Report created: ${report.location} by ${report.createdByName} (Habituel)`);
  }

  res.json({ success: true, report });
});

// GET /api/patrol/reports - list patrol reports (restricted to responders, dispatchers, admins)
app.get('/api/patrol/reports', (req, res) => {
  const locationFilter = req.query.location as string;
  const statusFilter = req.query.status as string;
  const agentFilter = (req.query.agent || req.query.createdBy) as string;
  const from = req.query.from ? Number(req.query.from) : null;
  const to = req.query.to ? Number(req.query.to) : null;
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  const currentUserId = req.supabaseUser!.id;
  const currentRole = req.supabaseUser!.role;

  let filtered = [...patrolReports].filter(r => canAccessOrg(req.supabaseUser!, r.organizationId));
  if (locationFilter) {
    filtered = filtered.filter(r => r.location === locationFilter);
  }
  if (statusFilter) {
    filtered = filtered.filter(r => r.status === statusFilter);
  }
  if (agentFilter) {
    filtered = filtered.filter(r => r.createdBy === agentFilter);
  }
  if (from !== null) {
    filtered = filtered.filter(r => r.createdAt >= from);
  }
  if (to !== null) {
    filtered = filtered.filter(r => r.createdAt <= to);
  }
  // Responders only see their own reports; dispatchers/admins see all — applied last so
  // agent/date filters above can't be used to widen a responder's own view.
  if (currentRole === 'responder') {
    filtered = filtered.filter(r => r.createdBy === currentUserId);
  }

  res.json({ reports: filtered.slice(0, limit), total: filtered.length });
});

// GET /api/patrol/coverage - last patrol time per site, for dispatch oversight
app.get('/api/patrol/coverage', requireAuth, (req, res) => {
  const now = Date.now();
  const orgSites = Array.from(patrolSites.values()).filter(s => canAccessOrg(req.supabaseUser!, s.organizationId));
  const sites = orgSites.map((site) => {
    const location = site.name;
    const reportsForSite = patrolReports.filter(r => r.location === location && canAccessOrg(req.supabaseUser!, r.organizationId));
    const lastReportAt = reportsForSite.length
      ? Math.max(...reportsForSite.map(r => r.createdAt))
      : null;
    const hoursSince = lastReportAt !== null ? (now - lastReportAt) / (60 * 60 * 1000) : null;
    // An unoccupied family residence is a softer target — flag it and tighten
    // the coverage thresholds so it reads as overdue sooner than an occupied site.
    const coords = resolveSiteDestination(site.id);
    const occupancyBoost = coords ? findResidenceOccupancyForCoords(coords) === 'unoccupied' : false;
    const criticalHours = occupancyBoost ? PATROL_COVERAGE_CRITICAL_HOURS / 2 : PATROL_COVERAGE_CRITICAL_HOURS;
    const warningHours = occupancyBoost ? PATROL_COVERAGE_WARNING_HOURS / 2 : PATROL_COVERAGE_WARNING_HOURS;
    const level: 'ok' | 'warning' | 'critical' =
      hoursSince === null || hoursSince >= criticalHours ? 'critical'
      : hoursSince >= warningHours ? 'warning'
      : 'ok';
    return { location, lastReportAt, hoursSince, level, ...(occupancyBoost ? { occupancyBoost: true } : {}) };
  });
  res.json({ sites });
});

// GET /api/patrol/reports/:id - get a single patrol report
app.get('/api/patrol/reports/:id', (req, res) => {
  const report = patrolReports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Patrol report not found' });
  if (!canAccessOrg(req.supabaseUser!, report.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  res.json(report);
});

// POST /api/patrol/reports/:id/escalate-to-incident - dispatch escalates a patrol
// report to a real incident in one round trip (creates the incident + marks the
// report escalated), so it can't end up created-but-unmarked on a client error.
app.post('/api/patrol/reports/:id/escalate-to-incident', async (req, res) => {
  const report = patrolReports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Patrol report not found' });
  if (!canAccessOrg(req.supabaseUser!, report.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  if (report.escalatedIncidentId) {
    return res.status(400).json({ error: 'Report already escalated', incidentId: report.escalatedIncidentId });
  }

  const severityConfig = PATROL_STATUS_CONFIG[report.status];
  const severity: Alert['severity'] =
    severityConfig.severity >= 5 ? 'critical'
    : severityConfig.severity >= 4 ? 'high'
    : severityConfig.severity >= 3 ? 'medium'
    : 'low';

  const coords = await geocodeAddress(report.location);
  const location = coords
    ? { ...coords, address: report.location }
    : { latitude: 46.1950, longitude: 6.1580, address: report.location }; // same fallback as the console's manual incident creation

  const alert: Alert = {
    id: await generateIncidentId('other', report.createdByName, location),
    type: 'other',
    severity,
    location,
    description: `Ronde escaladée — ${severityConfig.label} (rapport ${report.id})`,
    createdBy: report.createdByName,
    reporterId: report.createdBy,
    organizationId: adminUsers.get(report.createdBy)?.organizationId,
    origin: 'dispatch',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
  };
  alerts.set(alert.id, alert);
  linkPossibleDuplicates(alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(() => {});
  broadcastToOrg(alert.organizationId, { type: 'newAlert', data: alert });
  sendPushToDispatchersAndResponders(alert, alert.createdBy).catch(() => {});

  report.escalatedIncidentId = alert.id;
  persistPatrolReports();
  addAuditEntry('incident', 'Ronde escaladée', 'Dispatch Console', `Ronde ${report.id} escaladée vers l'incident ${alert.id}`, undefined, alert.organizationId);

  res.json({ success: true, incidentId: alert.id, alert });
});

// POST /api/patrol/reports/:id/media - upload media (photo/video) to a patrol report
app.post('/api/patrol/reports/:id/media', uploadMedia.single('media'), async (req: any, res) => {
  const report = patrolReports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Patrol report not found' });
  if (!canAccessOrg(req.supabaseUser!, report.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = req.file.originalname.split('.').pop()?.toLowerCase() || '';
  const isVideo = ['mp4', 'mov', 'avi', 'webm', 'm4v'].includes(ext);
  const mediaUrl = await uploadFileToSupabaseStorage(req.file);
  const mediaItem: PatrolMedia = {
    id: uuidv4().slice(0, 8),
    type: isVideo ? 'video' : 'photo',
    url: mediaUrl,
    filename: req.file.originalname,
    uploadedAt: Date.now(),
  };

  if (!report.media) report.media = [];
  report.media.push(mediaItem);
  persistPatrolReports();

  console.log(`[Patrol] Media uploaded to report ${report.id}: ${mediaItem.type} ${mediaItem.filename}`);
  res.json({ success: true, media: mediaItem });
});

// DELETE /api/patrol/reports/:id/media/:mediaId - remove media from a patrol report
app.delete('/api/patrol/reports/:id/media/:mediaId', (req, res) => {
  const report = patrolReports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Patrol report not found' });
  if (!canAccessOrg(req.supabaseUser!, report.organizationId)) return res.status(403).json({ error: 'Not authorized' });
  if (!report.media) return res.status(404).json({ error: 'No media found' });

  const idx = report.media.findIndex(m => m.id === req.params.mediaId);
  if (idx < 0) return res.status(404).json({ error: 'Media not found' });

  const removed = report.media.splice(idx, 1)[0];
  persistPatrolReports();

  // Try to delete the file from disk
  const filePath = path.join(uploadsDir, removed.url.replace('/uploads/', ''));
  fs.unlink(filePath, () => {}); // ignore errors

  res.json({ success: true });
});

// ─── PTT WebSocket Handlers ────────────────────────────────────────────────────────────────────
async function handlePTTTransmit(ws: any, senderId: string, senderRole: string, data: any) {
  const { channelId, audioBase64, duration, senderName, mimeType } = data;
  if (!channelId || !audioBase64) {
    console.error(`[PTT] REJECTED: Missing channelId=${channelId ? 'yes' : 'NO'} or audioBase64=${audioBase64 ? audioBase64.length + ' chars' : 'EMPTY/MISSING'}. Full data keys: ${Object.keys(data || {}).join(', ')}`);
    ws.send(JSON.stringify({ type: 'error', message: `Missing channelId or audioBase64. Got channelId=${!!channelId}, audioBase64=${!!audioBase64}` }));
    return;
  }

  const channel = pttChannels.find(c => c.id === channelId);
  if (!channel) {
    ws.send(JSON.stringify({ type: 'error', message: 'Channel not found' }));
    return;
  }

  // Check if user can transmit on this channel
  if (!channel.allowedRoles.includes(senderRole as any) && senderRole !== 'admin') {
    ws.send(JSON.stringify({ type: 'error', message: 'Not authorized to transmit on this channel' }));
    return;
  }

  // If channel has specific members, check membership (admin always allowed)
  if (channel.members && channel.members.length > 0 && senderRole !== 'admin') {
    if (!channel.members.includes(senderId)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Not a member of this channel' }));
      return;
    }
  }

  const pttMsg: PTTMessageServer = {
    id: `ptt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId,
    senderId,
    senderName: senderName || senderId,
    senderRole,
    audioBase64,
    mimeType: mimeType || 'audio/webm',
    duration: duration || 0,
    timestamp: Date.now(),
  };

  pttMessages.push(pttMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();

  console.log(`[PTT] ${senderName} (${senderRole}) transmitted on ${channel.name} - ${duration?.toFixed(1)}s, audioBase64: ${audioBase64 ? (audioBase64.length / 1024).toFixed(1) + ' KB' : 'EMPTY'}, mimeType: ${mimeType || 'default'}`);

  // Broadcast to all users who can access this channel
  const broadcastData = JSON.stringify({
    type: 'pttMessage',
    data: {
      id: pttMsg.id,
      channelId: pttMsg.channelId,
      senderId: pttMsg.senderId,
      senderName: pttMsg.senderName,
      senderRole: pttMsg.senderRole,
      audioBase64: pttMsg.audioBase64,
      mimeType: pttMsg.mimeType,
      duration: pttMsg.duration,
      timestamp: pttMsg.timestamp,
    },
  });

  // Send to all connected clients that have the right role for this channel.
  // Uses the sender's own organization rather than channel.organizationId —
  // the default seeded channels (emergency/dispatch/responders/general)
  // have no organizationId of their own (Phase 1, still Phase 3 cleanup
  // territory), so falling back to the channel's id would silently
  // broadcast to nobody. Use wsClientMap for O(1) lookup instead of
  // searching userConnections.
  const pttTransmitOrgId = adminUsers.get(senderId)?.organizationId;
  wss.clients.forEach((client: any) => {
    if (client.readyState !== 1) return;
    // Don't echo back to sender (they already have it locally)
    if (client === ws) return;
    const connUserId = wsClientMap.get(client);
    if (!connUserId) return;
    const connUserData = users.get(connUserId);
    if (!connUserData) return;
    if (connUserData.organizationId !== pttTransmitOrgId) return;
    const role = connUserData.role || 'user';
    // Admin and dispatcher always receive all PTT messages
    if (role === 'admin' || role === 'dispatcher') {
      client.send(broadcastData);
      return;
    }
    // Other roles: check allowedRoles
    if (channel.allowedRoles.includes(role as any)) {
      // If channel has specific members, also check membership
      if (channel.members && channel.members.length > 0) {
        if (!channel.members.includes(connUserId)) return;
      }
      client.send(broadcastData);
    }
  });

  // Confirm to sender
  ws.send(JSON.stringify({ type: 'pttTransmitAck', messageId: pttMsg.id, timestamp: pttMsg.timestamp }));

  // Aussi envoyer via messagerie pour que les users reçoivent même en background
  if (senderRole === 'dispatcher' || senderRole === 'admin') {
    try {
      const { targetUserId } = data; // optionnel - si absent, envoie à tous
      console.log('[PTT→Msg] Starting upload, audioBase64 length:', audioBase64?.length);
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const audioFileName = `${Date.now()}-ptt-dispatch.m4a`;
      console.log('[PTT→Msg] Buffer size:', audioBuffer.length, 'bytes');
      // Sauvegarder avec le mimeType original
      const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
        .from('media')
        .upload(audioFileName, audioBuffer, { contentType: mimeType || 'audio/webm', upsert: false });
      
      if (uploadError) { console.error('[PTT→Msg] Upload error:', uploadError.message); }
      if (!uploadError && uploadData) {
        console.log('[PTT→Msg] Uploaded to Supabase:', uploadData.path);
        const { data: { publicUrl } } = supabaseAdmin.storage.from('media').getPublicUrl(audioFileName);
        
        // Si targetUserId spécifié, envoyer seulement à cet user
        let channelUsers: any[] = [];
        if (targetUserId) {
          const targetUser = adminUsers.get(targetUserId);
          if (targetUser) channelUsers = [targetUser];
        } else {
          // Envoyer à tous les users actifs du canal, de l'organisation de
          // l'expéditeur uniquement — auparavant diffusé à tous les
          // users/responders actifs de toutes les organisations.
          const senderOrgId = adminUsers.get(senderId)?.organizationId;
          channelUsers = Array.from(adminUsers.values()).filter(u =>
            (u.role === 'user' || u.role === 'responder') && u.status === 'active' && u.organizationId === senderOrgId
          );
        }
        
        for (const targetUser of channelUsers) {
          const sorted = [senderId, targetUser.id].sort();
          const convId = `dm-${sorted[0]}-${sorted[1]}`;
          
          let conv = conversations.get(convId);
          if (!conv) {
            conv = {
              id: convId, type: 'direct', name: 'Direct Message',
              participantIds: sorted, createdBy: senderId,
              createdAt: Date.now(), lastMessage: '🎙 Message vocal',
              lastMessageTime: Date.now(),
              organizationId: adminUsers.get(senderId)?.organizationId,
            };
            conversations.set(convId, conv);
            saveConversationToSupabase(conv).catch(() => {});
          }

          const msg: ChatMessage = {
            id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            conversationId: convId, senderId, senderName: senderName || 'Dispatch',
            senderRole, text: '🎙 Message vocal PTT',
            type: 'audio', timestamp: Date.now(),
            mediaUrl: publicUrl, mediaType: 'audio',
            // Note: webm format from dispatch - iOS may not play directly
          };
          if (!messages.has(convId)) messages.set(convId, []);
          messages.get(convId)!.push(msg);
          saveMessageToSupabase(msg).catch(() => {});
          conv.lastMessage = '🎙 Message vocal PTT';
          conv.lastMessageTime = msg.timestamp;
          conversations.set(convId, conv);

          // Push notification
          sendPushToUser(targetUser.id, `🎙 ${senderName || 'Dispatch'}`, 'Message vocal PTT', { type: 'ptt' });
        }
      }
    } catch (e: any) { console.error('[PTT→Msg] Error:', e?.message || e); }
  }
}

function handlePTTJoinChannel(ws: any, userId: string, userRole: string, data: any) {
  const { channelId } = data;
  const channel = pttChannels.find(c => c.id === channelId);
  if (!channel) {
    ws.send(JSON.stringify({ type: 'error', message: 'Channel not found' }));
    return;
  }

  // Send recent messages for this channel (last 50)
  const channelMsgs = pttMessages
    .filter(m => m.channelId === channelId)
    .slice(-50)
    .map(m => ({
      id: m.id,
      channelId: m.channelId,
      senderId: m.senderId,
      senderName: m.senderName,
      senderRole: m.senderRole,
      audioBase64: m.audioBase64,
      mimeType: m.mimeType || 'audio/webm',
      duration: m.duration,
      timestamp: m.timestamp,
    }));

  ws.send(JSON.stringify({
    type: 'pttChannelHistory',
    channelId,
    data: channelMsgs,
  }));
}

// ─── PTT Talking State Handler ─────────────────────────────────────────────────────────────────
function handlePTTTalkingState(ws: any, userId: string, userRole: string, data: any, isTalking: boolean) {
  const { channelId, userName } = data;
  const channel = pttChannels.find(c => c.id === channelId);
  if (!channel) return;

  // Broadcast talking state to all users on this channel
  const broadcastData = JSON.stringify({
    type: isTalking ? 'pttTalkingStart' : 'pttTalkingStop',
    data: {
      channelId,
      userId,
      userName: userName || userId,
      userRole,
    },
  });

  // Same reasoning as handlePTTTransmit: derive org from the sender, not
  // channel.organizationId, since the default seeded channels have none.
  const pttTalkingOrgId = adminUsers.get(userId)?.organizationId;
  wss.clients.forEach((client: any) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    const connUserId = wsClientMap.get(client);
    if (!connUserId) return;
    const connUserData = users.get(connUserId);
    if (!connUserData) return;
    if (connUserData.organizationId !== pttTalkingOrgId) return;
    const role = connUserData.role || 'user';
    if (role === 'admin' || role === 'dispatcher') {
      client.send(broadcastData);
      return;
    }
    if (channel.allowedRoles.includes(role as any)) {
      if (channel.members && channel.members.length > 0) {
        if (!channel.members.includes(connUserId)) return;
      }
      client.send(broadcastData);
    }
  });
}

// ─── PTT Emergency Handler ────────────────────────────────────────────────────────────────────
function handlePTTEmergency(ws: any, userId: string, userRole: string, data: any) {
  // Only dispatchers and admins can trigger emergency
  if (userRole !== 'dispatcher' && userRole !== 'admin') {
    ws.send(JSON.stringify({ type: 'error', message: 'Only dispatchers and admins can trigger emergency PTT' }));
    return;
  }

  const { audioBase64, duration, senderName, mimeType } = data;
  const emergencyMsg: PTTMessageServer = {
    id: `ptt-emergency-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId: 'emergency',
    senderId: userId,
    senderName: senderName || userId,
    senderRole: userRole,
    audioBase64: audioBase64 || '',
    mimeType: mimeType || 'audio/webm',
    duration: duration || 0,
    timestamp: Date.now(),
  };

  pttMessages.push(emergencyMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();

  console.log(`[PTT] EMERGENCY broadcast by ${senderName} (${userRole}) - ${duration?.toFixed(1)}s`);

  // Broadcast to ALL connected clients regardless of channel
  const broadcastData = JSON.stringify({
    type: 'pttEmergencyMessage',
    data: {
      id: emergencyMsg.id,
      channelId: 'emergency',
      senderId: emergencyMsg.senderId,
      senderName: emergencyMsg.senderName,
      senderRole: emergencyMsg.senderRole,
      audioBase64: emergencyMsg.audioBase64,
      mimeType: emergencyMsg.mimeType,
      duration: emergencyMsg.duration,
      timestamp: emergencyMsg.timestamp,
    },
  });

  // The 'emergency' channel is a default seeded channel with no
  // organization of its own (see Phase 1) — scoped to the sender's
  // organization instead, same as the REST /api/ptt/emergency route and
  // POST /api/ptt/transmit. Previously reached every connected client and
  // every registered user's push token, across every organization.
  const emergencyOrgId = adminUsers.get(userId)?.organizationId;
  wss.clients.forEach((client: any) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    const connUid = wsClientMap.get(client);
    const connUser = connUid ? users.get(connUid) : undefined;
    if (connUser?.organizationId !== emergencyOrgId) return;
    client.send(broadcastData);
  });

  // Also send push notifications to the sender's own organization
  const allUserIds = Array.from(users.keys()).filter(uid => adminUsers.get(uid)?.organizationId === emergencyOrgId);
  allUserIds.forEach(uid => {
    if (uid === userId) return;
    sendPushToUser(
      uid,
      '🚨 ALERTE URGENCE PTT',
      `Message d'urgence de ${senderName} (${userRole})`,
      { type: 'pttEmergency', messageId: emergencyMsg.id }
    ).catch(() => {});
  });

  ws.send(JSON.stringify({ type: 'pttEmergencyAck', messageId: emergencyMsg.id }));
}

// ─── PTT REST API ──────────────────────────────────────────────────────────────────────────────

// GET /api/ptt/channels - list channels accessible by the caller (verified
// identity — not a client-supplied role/userId, unlike before). Every user
// with family gets their private family channel auto-provisioned here.
app.get('/api/ptt/channels', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  ensureFamilyChannel(caller.id);
  const accessible = pttChannels.filter(ch => canJoinPTTChannel(caller.id, caller.role, ch));
  res.json(accessible);
});

// POST /api/ptt/channels - create a custom group channel (dispatcher/admin
// only) — dispatch picks the members explicitly, per the intended model of
// "dispatch decides who's in the group."
app.post('/api/ptt/channels', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  if (caller.role !== 'dispatcher' && caller.role !== 'admin' && caller.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only dispatchers and admins can create channels' });
  }
  const { name, description, members } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const callerUser = adminUsers.get(caller.id);

  const channel: PTTChannelServer = {
    id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    name,
    description: description || '',
    allowedRoles: ['user', 'responder', 'dispatcher', 'admin', 'superadmin'],
    isActive: true,
    isDefault: false,
    createdBy: caller.id,
    createdAt: Date.now(),
    members: Array.isArray(members) ? members : [],
    organizationId: caller.organizationId,
  };

  pttChannels.push(channel);
  persistPTTChannels();
  broadcastToOrg(channel.organizationId, { type: 'pttChannelCreated', data: channel });
  console.log(`[PTT] Channel "${name}" created by ${callerUser?.name || caller.id}`);
  res.json(channel);
});

// DELETE /api/ptt/channels/:id - delete a custom channel (dispatcher/admin only)
app.delete('/api/ptt/channels/:id', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  if (caller.role !== 'dispatcher' && caller.role !== 'admin' && caller.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only dispatchers and admins can delete channels' });
  }
  const id = req.params.id as string;
  const idx = pttChannels.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' });
  if (pttChannels[idx].isDefault) return res.status(400).json({ error: 'Cannot delete default channels' });

  const removed = pttChannels.splice(idx, 1)[0];
  deletePTTChannelFromSupabase(id);
  persistPTTChannels();

  pttMessages = pttMessages.filter(m => m.channelId !== id);
  persistPTTMessages();

  broadcastToOrg(removed.organizationId, { type: 'pttChannelDeleted', channelId: id });
  console.log(`[PTT] Channel "${removed.name}" deleted`);
  res.json({ success: true });
});

// POST /api/ptt/channels/direct - create or find a direct 1-on-1 PTT channel
// between the caller and another user. The caller's own identity always comes
// from their verified session — they can't fabricate either side as someone
// else, only pick who they're calling.
app.post('/api/ptt/channels/direct', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const { userId2 } = req.body;
  if (!userId2) return res.status(400).json({ error: 'userId2 is required' });
  const callerUser = adminUsers.get(caller.id);
  const targetUser = adminUsers.get(userId2);
  if (!targetUser) return res.status(404).json({ error: 'Target user not found' });

  const existing = pttChannels.find(ch =>
    ch.members && ch.members.length === 2 &&
    ch.members.includes(caller.id) && ch.members.includes(userId2) &&
    ch.id.startsWith('direct-')
  );
  if (existing) return res.json(existing);

  const name1 = callerUser?.name || caller.id;
  const name2 = targetUser.name || userId2;
  const channel: PTTChannelServer = {
    id: `direct-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    name: `${name1} ↔ ${name2}`,
    description: `Appel direct entre ${name1} et ${name2}`,
    allowedRoles: ['user', 'responder', 'dispatcher', 'admin', 'superadmin'],
    isActive: true,
    isDefault: false,
    createdBy: caller.id,
    createdAt: Date.now(),
    members: [caller.id, userId2],
    organizationId: caller.organizationId,
  };
  pttChannels.push(channel);
  persistPTTChannels();
  broadcastToOrg(channel.organizationId, { type: 'pttChannelCreated', data: channel });
  console.log(`[PTT] Direct channel created: ${name1} ↔ ${name2}`);
  res.json(channel);
});

// POST /api/ptt/emergency - trigger the emergency PTT broadcast (dispatcher/
// admin only, verified). Replaces the old WS pttEmergency path, which trusted
// a client-declared role and called a push-sending function that didn't even
// exist (silently threw on every use). This only triggers the notification —
// the actual audio happens over the caller's LiveKit "emergency" room join,
// which every client gets pushed to open.
app.post('/api/ptt/emergency', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (caller.role !== 'dispatcher' && caller.role !== 'admin' && caller.role !== 'superadmin') {
    return res.status(403).json({ error: 'Only dispatchers and admins can trigger emergency PTT' });
  }
  const senderName = adminUsers.get(caller.id)?.name || caller.id;
  const payload = { type: 'pttEmergencyTriggered', data: { channelId: 'emergency', senderId: caller.id, senderName, senderRole: caller.role, timestamp: Date.now() } };
  broadcastToOrg(caller.organizationId, payload);

  const targetTokens: string[] = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userId !== caller.id) targetTokens.push(token);
  }
  if (targetTokens.length > 0) {
    const messages = targetTokens.map((token) => ({
      to: token, sound: 'default', title: '🚨 ALERTE URGENCE PTT',
      body: `${senderName} déclenche le canal d'urgence`,
      data: { type: 'pttEmergency' }, priority: 'high' as const, channelId: 'incident-updates',
    }));
    try {
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate', 'Content-Type': 'application/json' },
        body: JSON.stringify(messages),
      });
    } catch (e) { console.error('[PTT] Emergency push error:', e); }
  }
  console.log(`[PTT] EMERGENCY triggered by ${senderName}`);
  res.json({ success: true });
});

// GET /api/ptt/messages/:channelId - get recent messages for a channel
app.get('/api/ptt/messages/:channelId', (req, res) => {
  const { channelId } = req.params;
  const limit = parseInt(req.query.limit as string) || 50;
  const msgs = pttMessages
    .filter(m => m.channelId === channelId)
    .slice(-limit);
  res.json(msgs);
});

// POST /api/ptt/transmit - REST fallback for PTT transmission (when WS is unreliable)
app.post('/api/ptt/transmit', (req, res) => {
  const { channelId, audioBase64, mimeType, duration, senderId, senderName, senderRole } = req.body;
  if (!channelId || !audioBase64 || !senderId) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const channel = pttChannels.find(c => c.id === channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  if (!channel.allowedRoles.includes(senderRole as any) && senderRole !== 'admin') {
    return res.status(403).json({ error: 'Not authorized to transmit on this channel' });
  }

  const pttMsg: PTTMessageServer = {
    id: `ptt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId,
    senderId,
    senderName: senderName || senderId,
    senderRole: senderRole || 'user',
    audioBase64,
    mimeType: mimeType || 'audio/webm',
    duration: duration || 0,
    timestamp: Date.now(),
  };

  pttMessages.push(pttMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();

  // Broadcast via WebSocket to all eligible clients. Uses the sender's own
  // organization rather than channel.organizationId — the default seeded
  // channels (emergency/dispatch/responders/general) have no organizationId
  // of their own (a Phase 3 cleanup item, not yet per-organization), so
  // falling back to the channel's id would silently broadcast to nobody.
  broadcastToOrg(adminUsers.get(senderId)?.organizationId, {
    type: 'pttMessage',
    data: {
      id: pttMsg.id,
      channelId: pttMsg.channelId,
      senderId: pttMsg.senderId,
      senderName: pttMsg.senderName,
      senderRole: pttMsg.senderRole,
      audioBase64: pttMsg.audioBase64,
      mimeType: pttMsg.mimeType,
      duration: pttMsg.duration,
      timestamp: pttMsg.timestamp,
    },
  });

  res.json({ success: true, messageId: pttMsg.id });
});

// ─── Global error handler ────────────────────────────────────────────────
// Express 5 auto-catches thrown/rejected errors from async route handlers
// AND from middleware (e.g. multer) and forwards them here — without this,
// they fall through to Express's default handler, which returns an opaque
// HTML page (not JSON) and never surfaces in recentErrors, making failures
// like this one invisible both to the client and to /admin/health. Must be
// registered after every route (Express matches error middleware by
// position), right before server.listen.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[GlobalErrorHandler] ${req.method} ${req.path}:`, err);
  logHealthError(`${req.method} ${req.path}`, err);
  if (res.headersSent) return;
  const status = err?.status || err?.statusCode || (err?.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  res.status(status).json({ error: err?.code === 'LIMIT_FILE_SIZE' ? 'Fichier trop volumineux' : (message || 'Internal server error') });
});

// ─── Start server ─────────────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// Avoid 504 Gateway Timeout from reverse proxies
// Keep-alive timeout must be > proxy timeout (typically 60s)
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000;   // slightly > keepAliveTimeout

server.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`Talion's Eye Server running on port ${PORT}`);
  // Charger toutes les données depuis Supabase avant d'accepter les requêtes
  // organizations avant admin_users : chaque AdminUser référence son organizationId.
  await loadOrganizationsFromSupabase();
  await Promise.all([
    loadAdminUsersFromSupabase(),
    loadAlertsFromSupabase(),
    loadPatrolReportsFromSupabase(),
    loadPatrolSitesFromSupabase(),
    loadPatrolCheckpointsFromSupabase(),
    loadBlackbookFromSupabase(),
    loadPTTChannelsFromSupabase(),
    loadFamilyPerimetersFromSupabase(),
    loadSectorsFromSupabase(),
    loadManualPresenceFromSupabase(),
    loadAutoPresenceStateFromSupabase(),
    loadPushTokensFromSupabase(),
    loadUserAddressesFromSupabase(),
    loadConversationsFromSupabase(),
    loadMessagesFromSupabase(),
    loadKnownPeopleFromSupabase(),
    loadPlannedInterventionsFromSupabase(),
    loadTravelItinerariesFromSupabase(),
    loadPreauthorizedGuestsFromSupabase(),
    loadAuthorizedPickupPeopleFromSupabase(),
    loadMedicalInfoFromSupabase(),
    loadSchoolRoutesFromSupabase(),
    loadMainCouranteNotesFromSupabase(),
    loadThreatAnalysesFromSupabase(),
  ]);
  console.log('[Startup] All Supabase data loaded — ready to serve requests');

  // Rehydrate curfew checks: unlike acceptance timers, these must survive a restart
  // since they're a promise made to the user. Any check whose time already passed
  // while the server was down fires immediately (late) rather than being silently
  // dropped; anything still upcoming gets its setTimeout re-armed for the remaining delay.
  let rehydratedCount = 0;
  for (const check of curfewChecks.values()) {
    if (!check.active) continue;
    rehydratedCount++;
    if (check.nextCheckAt <= Date.now()) {
      fireCurfewCheck(check.id).catch(e => console.error('[Curfew] Rehydration fire error:', e));
    } else {
      scheduleCurfewCheck(check);
    }
  }
  if (rehydratedCount > 0) {
    console.log(`[Startup] Rehydrated ${rehydratedCount} active curfew checks`);
  }

  // Rehydrate scheduled check-ins — same rationale as curfew checks above.
  let rehydratedCheckInCount = 0;
  for (const checkIn of scheduledCheckIns.values()) {
    if (checkIn.status !== 'pending' && checkIn.status !== 'awaiting_confirmation') continue;
    rehydratedCheckInCount++;
    const handler = checkIn.stage === 'due' ? fireCheckInDue : fireCheckInEscalation;
    if (checkIn.nextFireAt <= Date.now()) {
      handler(checkIn.id).catch(e => console.error('[CheckIn] Rehydration fire error:', e));
    } else {
      scheduleCheckIn(checkIn);
    }
  }
  if (rehydratedCheckInCount > 0) {
    console.log(`[Startup] Rehydrated ${rehydratedCheckInCount} active scheduled check-ins`);
  }

  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Admin Console: http://localhost:${PORT}/admin-console/`);
  console.log(`Dispatch Console: http://localhost:${PORT}/dispatch-console/`);
  console.log(`Console Login: http://localhost:${PORT}/console/`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

export { app, server, wss };

// ─── Sync admin_users from Supabase on startup ───────────────────────────
async function loadAdminUsersFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('admin_users').select('*');
    if (error) { console.error('[Supabase] Failed to load admin_users:', error.message); return; }
    if (data && data.length > 0) {
      adminUsers.clear();
      data.forEach((u: any) => {
        adminUsers.set(u.id, {
          id: u.id, firstName: u.first_name || '', lastName: u.last_name || '',
          name: u.name || `${u.first_name} ${u.last_name}`.trim(),
          email: u.email, role: u.role, status: u.status || 'active',
          lastLogin: u.last_login || 0, createdAt: u.created_at || Date.now(),
          tags: u.tags || [], address: u.address || '',
          phoneLandline: u.phone_landline || '', phoneMobile: u.phone_mobile || '',
          comments: u.comments || '', photoUrl: u.photo_url || '',
          relationships: u.relationships || [], passwordHash: u.password_hash || undefined,
          ghostMode: u.ghost_mode || false,
          shareLocationWithFamily: u.share_location_with_family !== false,
          shareLocationUntil: u.share_location_until || undefined,
          uiProfile: u.ui_profile || undefined,
          duressCodeEnabled: u.duress_code_enabled || false,
          normalPinHash: u.normal_pin_hash || undefined,
          duressPinHash: u.duress_pin_hash || undefined,
          assignedFamilyIds: u.assigned_family_ids || [],
          organizationId: u.organization_id || undefined,
        });
      });
      console.log(`[Supabase] Loaded ${data.length} users from admin_users`);
    }
  } catch (e) { console.error('[Supabase] loadAdminUsersFromSupabase error:', e); }
}

// ─── Sync organizations from Supabase on startup ─────────────────────────
async function loadOrganizationsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('organizations').select('*');
    if (error) { console.error('[Supabase] Failed to load organizations:', error.message); return; }
    if (data && data.length > 0) {
      organizations.clear();
      data.forEach((o: any) => {
        organizations.set(o.id, { id: o.id, name: o.name, status: o.status || 'active', createdAt: o.created_at || Date.now() });
      });
      console.log(`[Supabase] Loaded ${data.length} organizations`);
    }
  } catch (e) { console.error('[Supabase] loadOrganizationsFromSupabase error:', e); }
}

async function saveOrganizationToSupabase(org: Organization): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('organizations').upsert({
      id: org.id, name: org.name, status: org.status, created_at: org.createdAt,
    });
    if (error) console.error('[Supabase] saveOrganizationToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] saveOrganizationToSupabase error:', e); }
}

async function deleteOrganizationFromSupabase(orgId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('organizations').delete().eq('id', orgId);
    if (error) console.error('[Supabase] deleteOrganizationFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deleteOrganizationFromSupabase error:', e); }
}

async function loadPatrolSitesFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('patrol_sites').select('*');
    if (error) { console.error('[Supabase] Failed to load patrol_sites:', error.message); return; }
    if (data && data.length > 0) {
      patrolSites.clear();
      data.forEach((s: any) => {
        patrolSites.set(s.id, {
          id: s.id, organizationId: s.organization_id, name: s.name, createdAt: s.created_at || Date.now(),
          address: s.address ?? undefined,
          latitude: s.latitude ?? undefined,
          longitude: s.longitude ?? undefined,
        });
      });
      console.log(`[Supabase] Loaded ${data.length} patrol sites`);
    }
  } catch (e) { console.error('[Supabase] loadPatrolSitesFromSupabase error:', e); }
}

async function savePatrolSiteToSupabase(site: PatrolSite): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('patrol_sites').upsert({
      id: site.id, organization_id: site.organizationId, name: site.name, created_at: site.createdAt,
      address: site.address ?? null, latitude: site.latitude ?? null, longitude: site.longitude ?? null,
    });
    if (error) console.error('[Supabase] savePatrolSiteToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] savePatrolSiteToSupabase error:', e); }
}

async function deletePatrolSiteFromSupabase(siteId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('patrol_sites').delete().eq('id', siteId);
    if (error) console.error('[Supabase] deletePatrolSiteFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deletePatrolSiteFromSupabase error:', e); }
}

async function loadPatrolCheckpointsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('patrol_checkpoints').select('*');
    if (error) { console.error('[Supabase] Failed to load patrol_checkpoints:', error.message); return; }
    if (data && data.length > 0) {
      patrolCheckpoints.clear();
      data.forEach((c: any) => {
        patrolCheckpoints.set(c.id, {
          id: c.id, siteId: c.site_id, organizationId: c.organization_id, name: c.name,
          latitude: c.latitude, longitude: c.longitude, radiusMeters: c.radius_meters,
          minDwellSeconds: c.min_dwell_seconds ?? undefined, createdAt: c.created_at || Date.now(),
        });
      });
      console.log(`[Supabase] Loaded ${data.length} patrol checkpoints`);
    }
  } catch (e) { console.error('[Supabase] loadPatrolCheckpointsFromSupabase error:', e); }
}

async function savePatrolCheckpointToSupabase(checkpoint: PatrolCheckpoint): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('patrol_checkpoints').upsert({
      id: checkpoint.id, site_id: checkpoint.siteId, organization_id: checkpoint.organizationId,
      name: checkpoint.name, latitude: checkpoint.latitude, longitude: checkpoint.longitude,
      radius_meters: checkpoint.radiusMeters, min_dwell_seconds: checkpoint.minDwellSeconds ?? null,
      created_at: checkpoint.createdAt,
    });
    if (error) console.error('[Supabase] savePatrolCheckpointToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] savePatrolCheckpointToSupabase error:', e); }
}

async function deletePatrolCheckpointFromSupabase(checkpointId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('patrol_checkpoints').delete().eq('id', checkpointId);
    if (error) console.error('[Supabase] deletePatrolCheckpointFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deletePatrolCheckpointFromSupabase error:', e); }
}

async function saveAdminUserToSupabase(user: AdminUser): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('admin_users').upsert({
      id: user.id, first_name: user.firstName, last_name: user.lastName,
      name: user.name, email: user.email, role: user.role, status: user.status,
      last_login: user.lastLogin, created_at: user.createdAt,
      tags: user.tags || [], address: user.address || '',
      phone_landline: user.phoneLandline || '', phone_mobile: user.phoneMobile || '',
      comments: user.comments || '', photo_url: user.photoUrl || '',
      relationships: user.relationships || [], password_hash: user.passwordHash || null,
      ghost_mode: user.ghostMode || false,
      share_location_with_family: user.shareLocationWithFamily !== false,
      share_location_until: user.shareLocationUntil || null,
      ui_profile: user.uiProfile || null,
      duress_code_enabled: user.duressCodeEnabled || false,
      normal_pin_hash: user.normalPinHash || null,
      duress_pin_hash: user.duressPinHash || null,
      assigned_family_ids: user.assignedFamilyIds || [],
      organization_id: user.organizationId || null,
    });
    if (error) console.error('[Supabase] saveAdminUserToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] saveAdminUserToSupabase error:', e); }
}

async function deleteAdminUserFromSupabase(userId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('admin_users').delete().eq('id', userId);
    if (error) console.error('[Supabase] deleteAdminUserFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deleteAdminUserFromSupabase error:', e); }
}

// ─── Sync alerts from Supabase on startup ────────────────────────────────
async function loadAlertsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('alerts').select('*');
    if (error) { console.error('[Supabase] Failed to load alerts:', error.message); return; }
    if (data && data.length > 0) {
      alerts.clear();
      data.forEach((a: any) => {
        alerts.set(a.id, {
          id: a.id,
          type: a.type,
          severity: a.severity,
          status: a.status,
          description: a.description || '',
          createdBy: a.created_by,
          reporterId: a.reporter_id || undefined,
          createdAt: a.created_at,
          location: a.location || { latitude: 0, longitude: 0, address: 'Unknown' },
          respondingUsers: a.responding_users || [],
          responderStatuses: a.responder_statuses || {},
          statusHistory: a.status_history || [],
          photos: a.photos || [],
          responderEscalation: a.responder_escalation || {},
          escalationLevel: a.escalation_level || 0,
          visibilityRadiusMeters: a.visibility_radius_meters || undefined,
          revealedUserIds: a.revealed_user_ids || [],
          possibleDuplicates: a.possible_duplicates || [],
          linkedIncidentIds: a.linked_incident_ids || [],
          origin: a.origin || undefined,
          archived: a.archived || false,
          archivedAt: a.archived_at || undefined,
          isDuress: a.is_duress || false,
          acknowledgedAt: a.acknowledged_at || undefined,
          resolvedAt: a.resolved_at || undefined,
          organizationId: a.organization_id || undefined,
        });
      });
      console.log(`[Supabase] Loaded ${data.length} alerts`);
    }
  } catch (e) { console.error('[Supabase] loadAlertsFromSupabase error:', e); }
}

async function saveAlertToSupabase(alert: Alert): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('alerts').upsert({
      id: alert.id,
      type: alert.type,
      severity: alert.severity,
      status: alert.status,
      description: alert.description,
      created_by: alert.createdBy,
      reporter_id: alert.reporterId || null,
      created_at: alert.createdAt,
      location: alert.location,
      responding_users: alert.respondingUsers || [],
      responder_statuses: alert.responderStatuses || {},
      status_history: alert.statusHistory || [],
      photos: alert.photos || [],
      responder_escalation: alert.responderEscalation || {},
      escalation_level: alert.escalationLevel || 0,
      visibility_radius_meters: alert.visibilityRadiusMeters || null,
      revealed_user_ids: alert.revealedUserIds || [],
      possible_duplicates: alert.possibleDuplicates || [],
      linked_incident_ids: alert.linkedIncidentIds || [],
      origin: alert.origin || null,
      archived: alert.archived || false,
      archived_at: alert.archivedAt || null,
      is_duress: alert.isDuress || false,
      acknowledged_at: alert.acknowledgedAt || null,
      resolved_at: alert.resolvedAt || null,
      organization_id: alert.organizationId || null,
    });
    if (error) console.error('[Supabase] saveAlertToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] saveAlertToSupabase error:', e); }
}

async function deleteAlertFromSupabase(alertId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('alerts').delete().eq('id', alertId);
    if (error) console.error('[Supabase] deleteAlertFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deleteAlertFromSupabase error:', e); }
}

// ─── Patrol Reports ───────────────────────────────────────────────────────
async function loadPatrolReportsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('patrol_reports').select('*').order('created_at', { ascending: false });
    if (error) { console.error('[Supabase] Failed to load patrol_reports:', error.message); return; }
    if (data && data.length > 0) {
      patrolReports.length = 0;
      data.forEach((r: any) => patrolReports.push({
        id: r.id, createdAt: r.created_at, createdBy: r.created_by,
        createdByName: r.created_by_name, location: r.location,
        status: r.status, tasks: r.tasks || [], notes: r.notes, media: r.media || [],
        organizationId: r.organization_id || undefined,
        siteId: r.site_id || undefined, checkpoints: r.checkpoints || undefined,
        trail: r.trail || undefined, roundStatus: r.round_status || undefined,
        startedAt: r.started_at || undefined, interruptReason: r.interrupt_reason || undefined,
      }));
      console.log(`[Supabase] Loaded ${data.length} patrol reports`);
    }
  } catch (e) { console.error('[Supabase] loadPatrolReportsFromSupabase error:', e); }
}

async function savePatrolReportToSupabase(report: PatrolReport): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('patrol_reports').upsert({
      id: report.id, created_at: report.createdAt, created_by: report.createdBy,
      created_by_name: report.createdByName, location: report.location,
      status: report.status, tasks: report.tasks, notes: report.notes || null, media: report.media || [],
      organization_id: report.organizationId || null,
      site_id: report.siteId || null, checkpoints: report.checkpoints || null,
      trail: report.trail || null, round_status: report.roundStatus || null,
      started_at: report.startedAt || null, interrupt_reason: report.interruptReason || null,
    });
    if (error) console.error('[Supabase] savePatrolReportToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] savePatrolReportToSupabase error:', e); }
}

// ─── PTT Channels ─────────────────────────────────────────────────────────
async function loadPTTChannelsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('ptt_channels').select('*');
    if (error) { console.error('[Supabase] Failed to load ptt_channels:', error.message); return; }
    if (data && data.length > 0) {
      pttChannels.length = 0;
      data.forEach((c: any) => pttChannels.push({
        id: c.id, name: c.name, description: c.description || '',
        allowedRoles: c.allowed_roles || [], isActive: c.is_active,
        isDefault: c.is_default, createdBy: c.created_by,
        createdAt: c.created_at, members: c.members || [],
        organizationId: c.organization_id || undefined,
      }));
      console.log(`[Supabase] Loaded ${data.length} PTT channels`);
    }
  } catch (e) { console.error('[Supabase] loadPTTChannelsFromSupabase error:', e); }
}

async function savePTTChannelToSupabase(channel: PTTChannelServer): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('ptt_channels').upsert({
      id: channel.id, name: channel.name, description: channel.description,
      allowed_roles: channel.allowedRoles, is_active: channel.isActive,
      is_default: channel.isDefault, created_by: channel.createdBy,
      created_at: channel.createdAt, members: channel.members || [],
      organization_id: channel.organizationId || null,
    });
    if (error) console.error('[Supabase] savePTTChannelToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] savePTTChannelToSupabase error:', e); }
}

async function deletePTTChannelFromSupabase(channelId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('ptt_channels').delete().eq('id', channelId);
    if (error) console.error('[Supabase] deletePTTChannelFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deletePTTChannelFromSupabase error:', e); }
}

// ─── Family Perimeters ────────────────────────────────────────────────────
async function loadFamilyPerimetersFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('family_perimeters').select('*');
    if (error) { console.error('[Supabase] Failed to load family_perimeters:', error.message); return; }
    if (data && data.length > 0) {
      familyPerimeters.clear();
      data.forEach((p: any) => familyPerimeters.set(p.id, {
        id: p.id, ownerId: p.owner_id, targetUserId: p.target_user_id,
        targetUserName: p.target_user_name, center: p.center,
        radiusMeters: p.radius_meters, active: p.active,
        createdAt: p.created_at, updatedAt: p.updated_at,
      }));
      console.log(`[Supabase] Loaded ${data.length} family perimeters`);
    }
  } catch (e) { console.error('[Supabase] loadFamilyPerimetersFromSupabase error:', e); }
}

async function saveFamilyPerimeterToSupabase(p: FamilyPerimeter): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('family_perimeters').upsert({
      id: p.id, owner_id: p.ownerId, target_user_id: p.targetUserId,
      target_user_name: p.targetUserName, center: p.center,
      radius_meters: p.radiusMeters, active: p.active,
      created_at: p.createdAt, updated_at: p.updatedAt,
    });
    if (error) console.error('[Supabase] saveFamilyPerimeterToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] saveFamilyPerimeterToSupabase error:', e); }
}

async function deleteFamilyPerimeterFromSupabase(perimeterId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('family_perimeters').delete().eq('id', perimeterId);
    if (error) console.error('[Supabase] deleteFamilyPerimeterFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deleteFamilyPerimeterFromSupabase error:', e); }
}

// ─── Sectors ──────────────────────────────────────────────────────────────
async function loadSectorsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('sectors').select('*');
    if (error) { console.error('[Supabase] Failed to load sectors:', error.message); return; }
    if (data && data.length > 0) {
      sectors.clear();
      data.forEach((s: any) => sectors.set(s.id, {
        id: s.id, name: s.name, color: s.color, shape: s.shape,
        center: s.center || undefined, radiusMeters: s.radius_meters ?? undefined,
        points: s.points || undefined,
        createdBy: s.created_by, createdAt: s.created_at, updatedAt: s.updated_at,
        organizationId: s.organization_id || undefined,
      }));
      console.log(`[Supabase] Loaded ${data.length} sectors`);
    }
  } catch (e) { console.error('[Supabase] loadSectorsFromSupabase error:', e); }
}

async function saveSectorToSupabase(s: Sector): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('sectors').upsert({
      id: s.id, name: s.name, color: s.color, shape: s.shape,
      center: s.center || null, radius_meters: s.radiusMeters ?? null,
      points: s.points || null,
      created_by: s.createdBy, created_at: s.createdAt, updated_at: s.updatedAt,
      organization_id: s.organizationId || null,
    });
    if (error) console.error('[Supabase] saveSectorToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] saveSectorToSupabase error:', e); }
}

async function deleteSectorFromSupabase(sectorId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('sectors').delete().eq('id', sectorId);
    if (error) console.error('[Supabase] deleteSectorFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deleteSectorFromSupabase error:', e); }
}

async function loadManualPresenceFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('presence_status').select('*');
    if (error) { console.error('[Supabase] Failed to load presence_status:', error.message); return; }
    if (data && data.length > 0) {
      manualPresence.clear();
      data.forEach((p: any) => {
        manualPresence.set(p.target_user_id, { status: p.status, placeLabel: p.place_label || undefined, setBy: p.set_by, setAt: p.set_at });
        if (p.status === 'inside' && p.place_label) autoPresenceState.set(p.target_user_id, { status: 'inside', label: p.place_label, since: p.set_at });
      });
      console.log(`[Supabase] Loaded ${data.length} manual presence statuses`);
    }
  } catch (e) { console.error('[Supabase] loadManualPresenceFromSupabase error:', e); }
}

async function saveManualPresenceToSupabase(targetUserId: string, p: PresenceManualStatus): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('presence_status').upsert({
      target_user_id: targetUserId, status: p.status, place_label: p.placeLabel || null, set_by: p.setBy, set_at: p.setAt,
    });
    if (error) console.error('[Supabase] saveManualPresenceToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] saveManualPresenceToSupabase error:', e); }
}

async function deleteManualPresenceFromSupabase(targetUserId: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('presence_status').delete().eq('target_user_id', targetUserId);
    if (error) console.error('[Supabase] deleteManualPresenceFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deleteManualPresenceFromSupabase error:', e); }
}

async function loadAutoPresenceStateFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('auto_presence_state').select('*');
    if (error) { console.error('[Supabase] Failed to load auto_presence_state:', error.message); return; }
    if (data && data.length > 0) {
      autoPresenceState.clear();
      data.forEach((p: any) => autoPresenceState.set(p.user_id, { status: p.status, label: p.label || undefined, since: p.since }));
      console.log(`[Supabase] Loaded ${data.length} automatic presence states`);
    }
  } catch (e) { console.error('[Supabase] loadAutoPresenceStateFromSupabase error:', e); }
}

async function saveAutoPresenceStateToSupabase(userId: string, p: AutoPresenceState): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('auto_presence_state').upsert({
      user_id: userId, status: p.status, label: p.label || null, since: p.since,
    });
    if (error) console.error('[Supabase] saveAutoPresenceStateToSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] saveAutoPresenceStateToSupabase error:', e); }
}

// ─── Sync push_tokens from Supabase on startup ───────────────────────────
async function loadPushTokensFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('push_tokens').select('*');
    if (error) { console.error('[Supabase] Failed to load push_tokens:', error.message); return; }
    if (data && data.length > 0) {
      pushTokens.clear();
      data.forEach((t: any) => {
        pushTokens.set(t.token, {
          token: t.token,
          userId: t.user_id,
          userRole: t.user_role,
          registeredAt: t.registered_at,
        });
      });
      console.log(`[Supabase] Loaded ${data.length} push tokens`);
    }
  } catch (e) { console.error('[Supabase] loadPushTokensFromSupabase error:', e); }
}

async function savePushTokenToSupabase(entry: PushTokenEntry): Promise<void> {
  try {
    console.log('[Supabase] Saving push token for', entry.userId, entry.userRole);
    const { error } = await supabaseAdmin.from('push_tokens').upsert({
      token: entry.token,
      user_id: entry.userId,
      user_role: entry.userRole,
      registered_at: entry.registeredAt,
    });
    if (error) {
      console.error('[Supabase] savePushTokenToSupabase error:', error.message, 'code:', error.code);
    } else {
      console.log('[Supabase] Push token saved OK for', entry.userId);
    }
  } catch (e) { console.error('[Supabase] savePushTokenToSupabase error:', e); }
}

async function deletePushTokenFromSupabase(token: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('push_tokens').delete().eq('token', token);
    if (error) console.error('[Supabase] deletePushTokenFromSupabase error:', error.message);
  } catch (e) { console.error('[Supabase] deletePushTokenFromSupabase error:', e); }
}

// ─── Incident Counter (sequential, persistent in Supabase) ───────────────
async function getNextIncidentNumber(): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin
      .from('incident_counter')
      .update({ last_number: supabaseAdmin.rpc('increment', { row_id: 1 }) })
      .eq('id', 1)
      .select('last_number')
      .single();
    if (error || !data) {
      // Fallback: use timestamp-based number
      return Date.now() % 100000;
    }
    return data.last_number;
  } catch (e) {
    return Date.now() % 100000;
  }
}

async function generateIncidentId(type: string, createdBy: string, location: { address?: string }): Promise<string> {
  try {
    // Increment counter atomically
    const { data, error } = await supabaseAdmin.rpc('increment_incident_counter');
    const num = (!error && data) ? data : Date.now() % 10000;

    // Get creator name
    const creator = adminUsers.get(createdBy);
    const creatorName = creator?.name || createdBy;

    // Extract city from address
    const address = location?.address || '';
    let city = '';
    if (address) {
      const parts = address.split(',').map((p: string) => p.trim());
      // Try to find city — usually 2nd or 3rd part
      city = parts[1] || parts[0] || '';
      // Limit city length
      if (city.length > 20) city = city.substring(0, 20);
    }

    // Type label
    const TYPE_LABELS: Record<string, string> = {
      sos: 'SOS', medical: 'MÉDICAL', fire: 'INCENDIE', security: 'SÉCURITÉ',
      accident: 'ACCIDENT', broadcast: 'BROADCAST', home_jacking: 'HOME-JACKING',
      cambriolage: 'CAMBRIOLAGE', other: 'INCIDENT',
      malaise: 'MALAISE', colis_suspect: 'COLIS SUSPECT',
    };
    const typeLabel = TYPE_LABELS[type] || type.toUpperCase();

    const parts = [typeLabel];
    if (creatorName && creatorName !== 'system' && creatorName !== 'mobile-user') parts.push(creatorName);
    if (city) parts.push(city);
    parts.push(`#${String(num).padStart(4, '0')}`);

    return parts.join(' — ');
  } catch (e) {
    return `INC-${uuidv4().slice(0, 8).toUpperCase()}`;
  }
}


// ─── Mapbox Geocoding Helper ──────────────────────────────────────────────
async function geocodeAddress(addressText: string): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const token = process.env.MAPBOX_TOKEN;
    if (!token) { console.warn('[Geocode] MAPBOX_TOKEN not set'); return null; }
    const encoded = encodeURIComponent(addressText);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${token}&limit=1`;
    const resp = await fetch(url);
    if (!resp.ok) { console.warn('[Geocode] Mapbox error', resp.status); return null; }
    const data = await resp.json() as any;
    const feature = data.features?.[0];
    if (!feature) { console.warn('[Geocode] No results for:', addressText); return null; }
    const [longitude, latitude] = feature.center;
    return { latitude, longitude };
  } catch (e) {
    console.error('[Geocode] geocodeAddress error:', e);
    return null;
  }
}


// ─── Messaging Persistence (Supabase) ────────────────────────────────────────

async function saveConversationToSupabase(conv: Conversation): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('conversations').upsert({
      id: conv.id, type: conv.type, name: conv.name,
      participant_ids: conv.participantIds, filter_role: conv.filterRole || null,
      filter_tags: conv.filterTags || null, address_id: conv.addressId || null,
      created_by: conv.createdBy,
      created_at: conv.createdAt, last_message: conv.lastMessage || '',
      last_message_time: conv.lastMessageTime || 0,
      organization_id: conv.organizationId || null,
    });
    if (error) console.error('[Supabase] saveConversation error:', error.message);
  } catch (e) { console.error('[Supabase] saveConversation error:', e); }
}

async function saveMessageToSupabase(msg: ChatMessage): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('messages').upsert({
      id: msg.id, conversation_id: msg.conversationId, sender_id: msg.senderId,
      sender_name: msg.senderName, sender_role: msg.senderRole,
      text: msg.text, type: msg.type, timestamp: msg.timestamp,
      media_url: msg.mediaUrl || null, media_type: msg.mediaType || null,
      location: msg.location || null,
    });
    if (error) console.error('[Supabase] saveMessage error:', error.message);
  } catch (e) { console.error('[Supabase] saveMessage error:', e); }
}

async function loadConversationsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('conversations').select('*');
    if (error) { console.error('[Supabase] loadConversations error:', error.message); return; }
    if (data && data.length > 0) {
      conversations.clear();
      data.forEach((c: any) => {
        const conv: any = {
          id: c.id, type: c.type, name: c.name,
          participantIds: c.participant_ids || [], filterRole: c.filter_role,
          filterTags: c.filter_tags, addressId: c.address_id || undefined,
          createdBy: c.created_by,
          createdAt: c.created_at, lastMessage: c.last_message || '',
          lastMessageTime: c.last_message_time || 0,
          unreadCounts: c.unread_counts || {},
          organizationId: c.organization_id || undefined,
        };
        conversations.set(c.id, conv);
      });
      console.log(`[Supabase] Loaded ${data.length} conversations`);
    }
  } catch (e) { console.error('[Supabase] loadConversations error:', e); }
}

async function loadMessagesFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('messages').select('*').order('timestamp', { ascending: true });
    if (error) { console.error('[Supabase] loadMessages error:', error.message); return; }
    if (data && data.length > 0) {
      messages.clear();
      data.forEach((m: any) => {
        const msg: ChatMessage = {
          id: m.id, conversationId: m.conversation_id, senderId: m.sender_id,
          senderName: m.sender_name, senderRole: m.sender_role,
          text: m.text, type: m.type, timestamp: m.timestamp,
          mediaUrl: m.media_url || undefined, mediaType: m.media_type || undefined,
          location: m.location || undefined,
        };
        if (!messages.has(msg.conversationId)) messages.set(msg.conversationId, []);
        messages.get(msg.conversationId)!.push(msg);
      });
      console.log(`[Supabase] Loaded ${data.length} messages`);
    }
  } catch (e) { console.error('[Supabase] loadMessages error:', e); }
}


// ─── LiveKit PTT ──────────────────────────────────────────────────────────────

// POST /api/livekit/token - générer un token pour rejoindre une room (PTT).
// Identity comes from the verified session, never the request body, and the
// requested room must be a channel the caller is actually allowed to join —
// otherwise this would just be a second, unguarded way to reach any PTT
// audio room regardless of what /api/ptt/channels would have shown them.
app.post('/api/livekit/token', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  const { roomName } = req.body;
  if (!roomName) return res.status(400).json({ error: 'roomName required' });

  ensureFamilyChannel(caller.id);
  const channel = pttChannels.find(c => c.id === roomName);
  if (!channel || !canJoinPTTChannel(caller.id, caller.role, channel)) {
    return res.status(403).json({ error: 'Not authorized to join this channel' });
  }

  try {
    const { AccessToken } = await import('livekit-server-sdk');
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    const livekitUrl = process.env.LIVEKIT_URL;
    if (!apiKey || !apiSecret || !livekitUrl) {
      return res.status(500).json({ error: 'LiveKit is not configured on the server' });
    }
    const callerUser = adminUsers.get(caller.id);
    const at = new AccessToken(apiKey, apiSecret, {
      identity: caller.id,
      name: callerUser?.name || caller.id,
      ttl: '4h',
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
    });
    const token = await at.toJwt();
    res.json({ token, url: livekitUrl, room: roomName });
    console.log(`[LiveKit] Token généré pour ${callerUser?.name || caller.id} dans room ${roomName}`);
  } catch (e: any) {
    console.error('[LiveKit] Token error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/livekit/rooms - the caller's actual accessible PTT channels (family/
// staff/group/direct), not the previous hardcoded single-room stub.
app.get('/api/livekit/rooms', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  ensureFamilyChannel(caller.id);
  const accessible = pttChannels.filter(ch => canJoinPTTChannel(caller.id, caller.role, ch));
  res.json({
    rooms: accessible.map(ch => ({ name: ch.id, label: ch.name, description: ch.description, type: ch.members?.length ? 'group' : 'broadcast' })),
    livekitUrl: process.env.LIVEKIT_URL,
  });
});

// ─── User Addresses ───────────────────────────────────────────────────────
interface UserAddress {
  id: string;
  userId: string;
  label: string;
  address: string;
  latitude?: number;
  longitude?: number;
  placeId?: string;
  isPrimary: boolean;
  alarmCode?: string;
  notes?: string;
  radiusMeters?: number; // "at this address" proximity radius for presence detection; defaults to 150m
  temporary?: boolean; // e.g. a vacation rental — surfaced distinctly and auto-excluded once expired
  expiresAt?: number; // only meaningful when temporary; the address stops counting for presence after this
  occupancyStatus?: 'occupied' | 'unoccupied'; // undefined = not tracked
  createdAt: number;
  updatedAt: number;
}

const userAddresses = new Map<string, UserAddress[]>(); // userId -> addresses

async function loadUserAddressesFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('user_addresses').select('*');
    if (error) { console.error('[Supabase] Failed to load user_addresses:', error.message); return; }
    if (data && data.length > 0) {
      userAddresses.clear();
      data.forEach((a: any) => {
        const addr: UserAddress = {
          id: a.id, userId: a.user_id, label: a.label, address: a.address,
          latitude: a.latitude, longitude: a.longitude, placeId: a.place_id,
          isPrimary: a.is_primary, alarmCode: a.alarm_code, notes: a.notes,
          radiusMeters: a.radius_meters || undefined,
          temporary: a.temporary || false,
          expiresAt: a.expires_at || undefined,
          occupancyStatus: a.occupancy_status || undefined,
          createdAt: a.created_at, updatedAt: a.updated_at,
        };
        if (!userAddresses.has(addr.userId)) userAddresses.set(addr.userId, []);
        userAddresses.get(addr.userId)!.push(addr);
      });
      console.log(`[Supabase] Loaded ${data.length} user addresses`);
    }
  } catch (e) { console.error('[Supabase] loadUserAddressesFromSupabase error:', e); }
}

// ─── Known People & Planned Interventions (per residence) ────────────────
// Service providers/contractors/visitors known at a residence (gardener, pool
// maintenance, plumber, etc.) and their scheduled visits — so staff reviewing
// an incident or on-site can recognize an expected person/vehicle, and dispatch
// can see a cross-residence calendar of who's expected where.

interface KnownPerson {
  id: string;
  addressId: string;
  userId: string; // residence owner
  name: string;
  category: string; // freeform, e.g. 'jardinier'|'piscine'|'plombier'|'electricien'|'menage'|'securite'|'entrepreneur'|'livraison'|'visiteur'|'autre'
  company?: string;
  phone?: string;
  email?: string;
  vehiclePlate?: string;
  vehicleDescription?: string;
  photoUrl?: string;
  notes?: string;
  verificationStatus?: 'verified' | 'pending' | 'flagged';
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface PlannedIntervention {
  id: string;
  addressId: string;
  userId: string;
  personId?: string;
  personName: string; // denormalized snapshot — stays displayable even if the linked person is later deleted
  category?: string;
  scheduledStart: number;
  scheduledEnd?: number;
  recurrence?: { frequency: 'weekly'; daysOfWeek: number[] }; // simple weekly recurrence, 0=Sun..6=Sat
  status: 'scheduled' | 'in_progress' | 'completed' | 'cancelled';
  arrivedAt?: number; // set by POST .../arrival when staff confirms the provider is on-site
  notes?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Travel Itineraries ─────────────────────────────────────────────────
// Calqued on PlannedIntervention (same CRUD + Supabase shape) but scoped by
// userId (the traveling family member) rather than addressId, since travel
// isn't tied to one residence. Status ('à venir'/'en cours'/'terminé') is
// derived at read time from now vs departureAt/returnAt rather than stored,
// to avoid a second timer/scheduling system alongside CurfewCheck/ScheduledCheckIn.
interface TravelItinerary {
  id: string;
  userId: string;
  userName: string; // denormalized snapshot
  destinationLabel: string;
  destinationAddress?: string;
  departureAt: number;
  returnAt?: number;
  notes?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

// ─── Pre-authorized guests ──────────────────────────────────────────────
// Calqued on KnownPerson (same address-scoped CRUD shape) but for a time-
// bounded guest list checked at the gate for a specific event, rather than
// a standing directory of recurring providers/staff.
interface PreAuthorizedGuest {
  id: string;
  addressId: string;
  userId: string; // residence owner
  guestName: string;
  guestPhone?: string;
  eventLabel?: string;
  validFrom: number;
  validUntil: number;
  addedBy: string;
  createdAt: number;
}

// Authorization belongs to the CHILD, not a residence — a pickup list
// shouldn't need to be duplicated per address the way guests/interventions are.
interface AuthorizedPickupPerson {
  id: string;
  childUserId: string;
  name: string;
  relationship?: string;
  phone?: string;
  photoUrl?: string;
  notes?: string;
  addedBy: string;
  createdAt: number;
  updatedAt: number;
}

// One record per person, self/family-editable, staff-readable during an
// active incident. Backed by Supabase (not a local-JSON-only Map like
// scheduledCheckIns) — this session already found that local-disk-only
// data silently vanishes on every Render redeploy, and medical info is
// exactly the kind of data that must never be lost that way.
interface MedicalInfo {
  userId: string;
  bloodType?: string;
  allergies?: string;
  conditions?: string;
  medications?: string;
  physicianName?: string;
  physicianPhone?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  notes?: string;
  updatedBy: string;
  updatedAt: number;
}

// A reference commute route (e.g. home -> school) with a deviation
// "corridor" — the one genuinely new geometry primitive in the family
// features work, everything else reuses point/radius perimeters. Time-window
// gated (commuteWindows) so it's only ever evaluated during an actual
// commute, and only alerts on a confirmed multi-reading transition (see
// checkSchoolRouteDeviation) to keep false positives bounded.
interface SchoolRoute {
  id: string;
  ownerId: string;
  targetUserId: string;
  targetUserName: string;
  homeAddressId?: string;
  schoolLabel: string;
  schoolLocation: { latitude: number; longitude: number; address?: string };
  geometry: { latitude: number; longitude: number }[];
  corridorMeters: number;
  commuteWindows: { hour: number; minute: number; durationMinutes: number; daysOfWeek: number[] }[];
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

const knownPeople = new Map<string, KnownPerson[]>(); // addressId -> people
const plannedInterventions = new Map<string, PlannedIntervention[]>(); // addressId -> interventions
const travelItineraries = new Map<string, TravelItinerary[]>(); // userId -> itineraries
const preauthorizedGuests = new Map<string, PreAuthorizedGuest[]>(); // addressId -> guests
const authorizedPickupPeople = new Map<string, AuthorizedPickupPerson[]>(); // childUserId -> people
const medicalInfoByUser = new Map<string, MedicalInfo>(); // userId -> record
const schoolRoutes = new Map<string, SchoolRoute[]>(); // targetUserId -> routes
// route deviation hysteresis: only alert on a confirmed on_route -> off_route
// transition across 2 consecutive readings, not a single noisy GPS ping.
const schoolRouteState = new Map<string, { state: 'on_route' | 'off_route'; since: number; confirmed: boolean }>(); // routeId -> state

async function loadKnownPeopleFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('known_people').select('*');
    if (error) { console.error('[Supabase] Failed to load known_people:', error.message); return; }
    if (data && data.length > 0) {
      knownPeople.clear();
      data.forEach((p: any) => {
        const person: KnownPerson = {
          id: p.id, addressId: p.address_id, userId: p.user_id, name: p.name, category: p.category,
          company: p.company || undefined, phone: p.phone || undefined, email: p.email || undefined,
          vehiclePlate: p.vehicle_plate || undefined, vehicleDescription: p.vehicle_description || undefined,
          photoUrl: p.photo_url || undefined, notes: p.notes || undefined,
          verificationStatus: p.verification_status || undefined,
          createdBy: p.created_by, createdAt: p.created_at, updatedAt: p.updated_at,
        };
        if (!knownPeople.has(person.addressId)) knownPeople.set(person.addressId, []);
        knownPeople.get(person.addressId)!.push(person);
      });
      console.log(`[Supabase] Loaded ${data.length} known people`);
    }
  } catch (e) { console.error('[Supabase] loadKnownPeopleFromSupabase error:', e); }
}

async function loadAuthorizedPickupPeopleFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('authorized_pickup_people').select('*');
    if (error) { console.error('[Supabase] Failed to load authorized_pickup_people:', error.message); return; }
    if (data && data.length > 0) {
      authorizedPickupPeople.clear();
      data.forEach((p: any) => {
        const person: AuthorizedPickupPerson = {
          id: p.id, childUserId: p.child_user_id, name: p.name,
          relationship: p.relationship || undefined, phone: p.phone || undefined,
          photoUrl: p.photo_url || undefined, notes: p.notes || undefined,
          addedBy: p.added_by, createdAt: p.created_at, updatedAt: p.updated_at,
        };
        if (!authorizedPickupPeople.has(person.childUserId)) authorizedPickupPeople.set(person.childUserId, []);
        authorizedPickupPeople.get(person.childUserId)!.push(person);
      });
      console.log(`[Supabase] Loaded ${data.length} authorized pickup people`);
    }
  } catch (e) { console.error('[Supabase] loadAuthorizedPickupPeopleFromSupabase error:', e); }
}

async function loadMedicalInfoFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('medical_info').select('*');
    if (error) { console.error('[Supabase] Failed to load medical_info:', error.message); return; }
    if (data && data.length > 0) {
      medicalInfoByUser.clear();
      data.forEach((m: any) => {
        medicalInfoByUser.set(m.user_id, {
          userId: m.user_id, bloodType: m.blood_type || undefined, allergies: m.allergies || undefined,
          conditions: m.conditions || undefined, medications: m.medications || undefined,
          physicianName: m.physician_name || undefined, physicianPhone: m.physician_phone || undefined,
          emergencyContactName: m.emergency_contact_name || undefined, emergencyContactPhone: m.emergency_contact_phone || undefined,
          notes: m.notes || undefined, updatedBy: m.updated_by, updatedAt: m.updated_at,
        });
      });
      console.log(`[Supabase] Loaded ${data.length} medical info records`);
    }
  } catch (e) { console.error('[Supabase] loadMedicalInfoFromSupabase error:', e); }
}

async function loadSchoolRoutesFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('school_routes').select('*');
    if (error) { console.error('[Supabase] Failed to load school_routes:', error.message); return; }
    if (data && data.length > 0) {
      schoolRoutes.clear();
      data.forEach((r: any) => {
        const route: SchoolRoute = {
          id: r.id, ownerId: r.owner_id, targetUserId: r.target_user_id, targetUserName: r.target_user_name || '',
          homeAddressId: r.home_address_id || undefined, schoolLabel: r.school_label || '',
          schoolLocation: { latitude: r.school_lat, longitude: r.school_lon, address: r.school_address || undefined },
          geometry: r.geometry || [], corridorMeters: r.corridor_meters || 275,
          commuteWindows: r.commute_windows || [], active: r.active !== false,
          createdAt: r.created_at, updatedAt: r.updated_at,
        };
        if (!schoolRoutes.has(route.targetUserId)) schoolRoutes.set(route.targetUserId, []);
        schoolRoutes.get(route.targetUserId)!.push(route);
      });
      console.log(`[Supabase] Loaded ${data.length} school routes`);
    }
  } catch (e) { console.error('[Supabase] loadSchoolRoutesFromSupabase error:', e); }
}

async function saveSchoolRouteToSupabase(route: SchoolRoute): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('school_routes').upsert({
      id: route.id, owner_id: route.ownerId, target_user_id: route.targetUserId, target_user_name: route.targetUserName,
      home_address_id: route.homeAddressId || null, school_label: route.schoolLabel,
      school_lat: route.schoolLocation.latitude, school_lon: route.schoolLocation.longitude,
      school_address: route.schoolLocation.address || null,
      geometry: route.geometry, corridor_meters: route.corridorMeters, commute_windows: route.commuteWindows,
      active: route.active, created_at: route.createdAt, updated_at: route.updatedAt,
    });
    if (error) console.error('[Supabase] saveSchoolRoute error:', error.message);
  } catch (e) { console.error('[Supabase] saveSchoolRoute error:', e); }
}

async function loadPlannedInterventionsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('planned_interventions').select('*');
    if (error) { console.error('[Supabase] Failed to load planned_interventions:', error.message); return; }
    if (data && data.length > 0) {
      plannedInterventions.clear();
      data.forEach((iv: any) => {
        const intervention: PlannedIntervention = {
          id: iv.id, addressId: iv.address_id, userId: iv.user_id, personId: iv.person_id || undefined,
          personName: iv.person_name, category: iv.category || undefined,
          scheduledStart: iv.scheduled_start, scheduledEnd: iv.scheduled_end || undefined,
          recurrence: iv.recurrence || undefined, status: iv.status, arrivedAt: iv.arrived_at || undefined, notes: iv.notes || undefined,
          createdBy: iv.created_by, createdAt: iv.created_at, updatedAt: iv.updated_at,
        };
        if (!plannedInterventions.has(intervention.addressId)) plannedInterventions.set(intervention.addressId, []);
        plannedInterventions.get(intervention.addressId)!.push(intervention);
      });
      console.log(`[Supabase] Loaded ${data.length} planned interventions`);
    }
  } catch (e) { console.error('[Supabase] loadPlannedInterventionsFromSupabase error:', e); }
}

async function loadTravelItinerariesFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('travel_itineraries').select('*');
    if (error) { console.error('[Supabase] Failed to load travel_itineraries:', error.message); return; }
    if (data && data.length > 0) {
      travelItineraries.clear();
      data.forEach((it: any) => {
        const itinerary: TravelItinerary = {
          id: it.id, userId: it.user_id, userName: it.user_name,
          destinationLabel: it.destination_label, destinationAddress: it.destination_address || undefined,
          departureAt: it.departure_at, returnAt: it.return_at || undefined, notes: it.notes || undefined,
          createdBy: it.created_by, createdAt: it.created_at, updatedAt: it.updated_at,
        };
        if (!travelItineraries.has(itinerary.userId)) travelItineraries.set(itinerary.userId, []);
        travelItineraries.get(itinerary.userId)!.push(itinerary);
      });
      console.log(`[Supabase] Loaded ${data.length} travel itineraries`);
    }
  } catch (e) { console.error('[Supabase] loadTravelItinerariesFromSupabase error:', e); }
}

async function loadPreauthorizedGuestsFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('preauthorized_guests').select('*');
    if (error) { console.error('[Supabase] Failed to load preauthorized_guests:', error.message); return; }
    if (data && data.length > 0) {
      preauthorizedGuests.clear();
      data.forEach((g: any) => {
        const guest: PreAuthorizedGuest = {
          id: g.id, addressId: g.address_id, userId: g.user_id, guestName: g.guest_name,
          guestPhone: g.guest_phone || undefined, eventLabel: g.event_label || undefined,
          validFrom: g.valid_from, validUntil: g.valid_until,
          addedBy: g.added_by, createdAt: g.created_at,
        };
        if (!preauthorizedGuests.has(guest.addressId)) preauthorizedGuests.set(guest.addressId, []);
        preauthorizedGuests.get(guest.addressId)!.push(guest);
      });
      console.log(`[Supabase] Loaded ${data.length} preauthorized guests`);
    }
  } catch (e) { console.error('[Supabase] loadPreauthorizedGuestsFromSupabase error:', e); }
}

// A caller may view/manage a residence's known people & interventions if they own it,
// are a direct family member of the owner, or are staff — matching the access rules
// already established for addresses/presence elsewhere in this file.
function resolveAddressOwner(addressId: string): string | undefined {
  for (const [uid, addrs] of userAddresses) {
    if (addrs.some(a => a.id === addressId)) return uid;
  }
  return undefined;
}
// Organization boundary first, hard, no exceptions — derived from the
// owning AdminUser rather than stored redundantly on every address/
// known-person/intervention/guest/itinerary row, since all of those are
// unambiguously scoped to a single real user already.
function canViewAddressAssets(ownerId: string, caller: { id: string; role: string; organizationId?: string }): boolean {
  if (!canAccessOrg(caller, adminUsers.get(ownerId)?.organizationId)) return false;
  return caller.id === ownerId || getFamilyMemberIds(ownerId).includes(caller.id) ||
    caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder';
}
function canEditAddressAssets(ownerId: string, caller: { id: string; role: string; organizationId?: string }): boolean {
  if (!canAccessOrg(caller, adminUsers.get(ownerId)?.organizationId)) return false;
  return caller.id === ownerId || getFamilyMemberIds(ownerId).includes(caller.id) ||
    caller.role === 'dispatcher' || caller.role === 'admin';
}

// GET /api/addresses/:addressId/people
app.get('/api/addresses/:addressId/people', requireAuth, (req, res) => {
  const ownerId = resolveAddressOwner((req.params.addressId as string));
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  if (!canViewAddressAssets(ownerId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  res.json(knownPeople.get((req.params.addressId as string)) || []);
});

// POST /api/addresses/:addressId/people
app.post('/api/addresses/:addressId/people', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const { name, category, company, phone, email, vehiclePlate, vehicleDescription, photoUrl, notes, verificationStatus } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  const now = Date.now();
  const person: KnownPerson = {
    id: uuidv4(), addressId, userId: ownerId, name, category: category || 'autre',
    company: company || undefined, phone: phone || undefined, email: email || undefined,
    vehiclePlate: vehiclePlate || undefined, vehicleDescription: vehicleDescription || undefined,
    photoUrl: photoUrl || undefined, notes: notes || undefined,
    verificationStatus: verificationStatus || 'pending',
    createdBy: caller.id, createdAt: now, updatedAt: now,
  };
  if (!knownPeople.has(addressId)) knownPeople.set(addressId, []);
  knownPeople.get(addressId)!.push(person);
  const { error } = await supabaseAdmin.from('known_people').insert({
    id: person.id, address_id: addressId, user_id: ownerId, name: person.name, category: person.category,
    company: person.company || null, phone: person.phone || null, email: person.email || null,
    vehicle_plate: person.vehiclePlate || null, vehicle_description: person.vehicleDescription || null,
    photo_url: person.photoUrl || null, notes: person.notes || null,
    verification_status: person.verificationStatus || null,
    created_by: person.createdBy, created_at: now, updated_at: now,
  });
  if (error) console.error('[Supabase] Failed to persist known person:', error.message);
  res.status(201).json(person);
});

// PUT /api/addresses/:addressId/people/:personId
app.put('/api/addresses/:addressId/people/:personId', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const people = knownPeople.get(addressId) || [];
  const idx = people.findIndex(p => p.id === (req.params.personId as string));
  if (idx === -1) return res.status(404).json({ error: 'Person not found' });
  const { name, category, company, phone, email, vehiclePlate, vehicleDescription, photoUrl, notes, verificationStatus } = req.body;
  const updated: KnownPerson = {
    ...people[idx],
    name: name ?? people[idx].name,
    category: category ?? people[idx].category,
    company: company !== undefined ? company : people[idx].company,
    phone: phone !== undefined ? phone : people[idx].phone,
    email: email !== undefined ? email : people[idx].email,
    vehiclePlate: vehiclePlate !== undefined ? vehiclePlate : people[idx].vehiclePlate,
    vehicleDescription: vehicleDescription !== undefined ? vehicleDescription : people[idx].vehicleDescription,
    photoUrl: photoUrl !== undefined ? photoUrl : people[idx].photoUrl,
    notes: notes !== undefined ? notes : people[idx].notes,
    verificationStatus: verificationStatus !== undefined ? verificationStatus : people[idx].verificationStatus,
    updatedAt: Date.now(),
  };
  people[idx] = updated;
  const { error } = await supabaseAdmin.from('known_people').update({
    name: updated.name, category: updated.category, company: updated.company || null,
    phone: updated.phone || null, email: updated.email || null, vehicle_plate: updated.vehiclePlate || null,
    vehicle_description: updated.vehicleDescription || null, photo_url: updated.photoUrl || null,
    notes: updated.notes || null, verification_status: updated.verificationStatus || null, updated_at: updated.updatedAt,
  }).eq('id', updated.id);
  if (error) console.error('[Supabase] Failed to persist known person update:', error.message);
  res.json(updated);
});

// DELETE /api/addresses/:addressId/people/:personId
app.delete('/api/addresses/:addressId/people/:personId', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const people = knownPeople.get(addressId) || [];
  const idx = people.findIndex(p => p.id === (req.params.personId as string));
  if (idx === -1) return res.status(404).json({ error: 'Person not found' });
  people.splice(idx, 1);
  const { error } = await supabaseAdmin.from('known_people').delete().eq('id', (req.params.personId as string));
  if (error) console.error('[Supabase] Failed to persist known person deletion:', error.message);
  res.json({ success: true });
});

// ─── Authorized pickup list (per child, not per address) ────────────────
app.get('/api/family/pickup-list', requireAuth, (req, res) => {
  const childUserId = req.query.childUserId as string;
  if (!childUserId) return res.status(400).json({ error: 'childUserId required' });
  if (!canAccessFamilyMemberData(childUserId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  res.json(authorizedPickupPeople.get(childUserId) || []);
});

app.post('/api/family/pickup-list', requireAuth, async (req, res) => {
  const { childUserId, name, relationship, phone, photoUrl, notes } = req.body;
  if (!childUserId || !name) return res.status(400).json({ error: 'childUserId and name are required' });
  const caller = req.supabaseUser!;
  if (!canAccessFamilyMemberData(childUserId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const now = Date.now();
  const person: AuthorizedPickupPerson = {
    id: uuidv4(), childUserId, name,
    relationship: relationship || undefined, phone: phone || undefined,
    photoUrl: photoUrl || undefined, notes: notes || undefined,
    addedBy: caller.id, createdAt: now, updatedAt: now,
  };
  if (!authorizedPickupPeople.has(childUserId)) authorizedPickupPeople.set(childUserId, []);
  authorizedPickupPeople.get(childUserId)!.push(person);
  const { error } = await supabaseAdmin.from('authorized_pickup_people').insert({
    id: person.id, child_user_id: childUserId, name: person.name,
    relationship: person.relationship || null, phone: person.phone || null,
    photo_url: person.photoUrl || null, notes: person.notes || null,
    added_by: person.addedBy, created_at: now, updated_at: now,
  });
  if (error) console.error('[Supabase] Failed to persist pickup person:', error.message);
  res.status(201).json(person);
});

app.put('/api/family/pickup-list/:id', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  let found: AuthorizedPickupPerson | undefined;
  let list: AuthorizedPickupPerson[] | undefined;
  for (const people of authorizedPickupPeople.values()) {
    const p = people.find(x => x.id === (req.params.id as string));
    if (p) { found = p; list = people; break; }
  }
  if (!found || !list) return res.status(404).json({ error: 'Person not found' });
  if (!canAccessFamilyMemberData(found.childUserId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const { name, relationship, phone, photoUrl, notes } = req.body;
  found.name = name ?? found.name;
  found.relationship = relationship !== undefined ? relationship : found.relationship;
  found.phone = phone !== undefined ? phone : found.phone;
  found.photoUrl = photoUrl !== undefined ? photoUrl : found.photoUrl;
  found.notes = notes !== undefined ? notes : found.notes;
  found.updatedAt = Date.now();
  const { error } = await supabaseAdmin.from('authorized_pickup_people').update({
    name: found.name, relationship: found.relationship || null, phone: found.phone || null,
    photo_url: found.photoUrl || null, notes: found.notes || null, updated_at: found.updatedAt,
  }).eq('id', found.id);
  if (error) console.error('[Supabase] Failed to persist pickup person update:', error.message);
  res.json(found);
});

app.delete('/api/family/pickup-list/:id', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  let ownerList: AuthorizedPickupPerson[] | undefined;
  let idx = -1;
  for (const people of authorizedPickupPeople.values()) {
    const i = people.findIndex(x => x.id === (req.params.id as string));
    if (i !== -1) { ownerList = people; idx = i; break; }
  }
  if (!ownerList || idx === -1) return res.status(404).json({ error: 'Person not found' });
  if (!canAccessFamilyMemberData(ownerList[idx].childUserId, caller)) return res.status(403).json({ error: 'Not authorized' });
  ownerList.splice(idx, 1);
  const { error } = await supabaseAdmin.from('authorized_pickup_people').delete().eq('id', (req.params.id as string));
  if (error) console.error('[Supabase] Failed to persist pickup person deletion:', error.message);
  res.json({ success: true });
});

// ─── Emergency medical info card (one per person) ────────────────────────
app.get('/api/family/medical-info', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canAccessFamilyMemberData(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  res.json(medicalInfoByUser.get(userId) || null);
});

app.put('/api/family/medical-info', requireAuth, async (req, res) => {
  const { userId, bloodType, allergies, conditions, medications, physicianName, physicianPhone, emergencyContactName, emergencyContactPhone, notes } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const caller = req.supabaseUser!;
  if (!canAccessFamilyMemberData(userId, caller)) return res.status(403).json({ error: 'Not authorized' });
  // An 'ado' profile can view their own medical info but not edit it — a
  // parent has to be the one to set it up. Doesn't apply when someone else
  // (a parent, staff) is doing the editing on the ado's behalf.
  if (caller.id === userId && adminUsers.get(caller.id)?.uiProfile === 'ado') {
    return res.status(403).json({ error: 'Not authorized to edit your own medical info' });
  }
  const now = Date.now();
  const record: MedicalInfo = {
    userId, bloodType: bloodType || undefined, allergies: allergies || undefined,
    conditions: conditions || undefined, medications: medications || undefined,
    physicianName: physicianName || undefined, physicianPhone: physicianPhone || undefined,
    emergencyContactName: emergencyContactName || undefined, emergencyContactPhone: emergencyContactPhone || undefined,
    notes: notes || undefined, updatedBy: caller.id, updatedAt: now,
  };
  medicalInfoByUser.set(userId, record);
  const { error } = await supabaseAdmin.from('medical_info').upsert({
    user_id: userId, blood_type: record.bloodType || null, allergies: record.allergies || null,
    conditions: record.conditions || null, medications: record.medications || null,
    physician_name: record.physicianName || null, physician_phone: record.physicianPhone || null,
    emergency_contact_name: record.emergencyContactName || null, emergency_contact_phone: record.emergencyContactPhone || null,
    notes: record.notes || null, updated_by: record.updatedBy, updated_at: now,
  });
  if (error) console.error('[Supabase] Failed to persist medical info:', error.message);
  res.json(record);
});

// GET /api/family/weekly-summary?userId= - a "here's what your security team
// did this week" transparency report, computed on-demand from existing data
// (no new scheduler/persistence for MVP): for each of the target's registered
// addresses, find nearby patrol sites (same match radius as the occupancy ->
// patrol-response helper) and aggregate trailing-7-day patrol coverage,
// nearby alerts by status, and completed provider interventions.
app.get('/api/family/weekly-summary', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const caller = req.supabaseUser!;
  if (!canAccessFamilyMemberData(userId, caller)) return res.status(403).json({ error: 'Not authorized' });

  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const addresses = (userAddresses.get(userId) || []).filter(a => a.latitude != null && a.longitude != null);
  const orgId = adminUsers.get(userId)?.organizationId;

  const residences = addresses.map(addr => {
    const coords = { latitude: addr.latitude!, longitude: addr.longitude! };
    const nearbySites = Array.from(patrolSites.values()).filter(site => {
      if (site.organizationId !== orgId) return false;
      const siteCoords = resolveSiteDestination(site.id);
      return siteCoords ? haversineDistance(coords.latitude, coords.longitude, siteCoords.latitude, siteCoords.longitude) <= PATROL_SITE_FAMILY_MATCH_METERS : false;
    });
    const siteNames = new Set(nearbySites.map(s => s.name));
    const weekReports = patrolReports.filter(r => siteNames.has(r.location) && r.createdAt >= since);
    const patrolCount = weekReports.length;
    let totalCheckpoints = 0, metCheckpoints = 0;
    for (const r of weekReports) {
      for (const cp of r.checkpoints || []) { totalCheckpoints++; if (cp.dwellMet) metCheckpoints++; }
    }
    const complianceRate = totalCheckpoints > 0 ? Math.round((metCheckpoints / totalCheckpoints) * 100) : null;

    const nearbyAlerts = Array.from(alerts.values()).filter(a => {
      if (a.createdAt < since || !a.location) return false;
      return haversineDistance(coords.latitude, coords.longitude, a.location.latitude, a.location.longitude) <= RISK_SCORE_SITE_RADIUS_METERS;
    });
    const alertsByStatus: Record<string, number> = {};
    for (const a of nearbyAlerts) alertsByStatus[a.status] = (alertsByStatus[a.status] || 0) + 1;

    const interventions = (plannedInterventions.get(addr.id) || []).filter(iv => iv.status === 'completed' && iv.updatedAt >= since);

    return {
      addressId: addr.id,
      label: addr.label,
      patrolRoundsCount: patrolCount,
      patrolComplianceRate: complianceRate,
      alertsByStatus,
      alertsCount: nearbyAlerts.length,
      completedInterventionsCount: interventions.length,
    };
  });

  res.json({ userId, since, until: Date.now(), residences });
});

// ─── School commute route deviation alerts ───────────────────────────────
app.get('/api/family/school-routes', requireAuth, (req, res) => {
  const targetUserId = req.query.targetUserId as string;
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId required' });
  if (!canEditAddressAssets(targetUserId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  res.json(schoolRoutes.get(targetUserId) || []);
});

// Fetches the route geometry once via fetchDirectionsAlternatives/Mapbox (the
// same routing engine the patrol route-planning feature uses) and stores it
// simplified — the corridor is checked against this stored geometry on every
// location update, not recomputed live.
app.post('/api/family/school-routes', requireAuth, async (req, res) => {
  const { targetUserId, targetUserName, homeAddressId, schoolLabel, schoolLocation, corridorMeters, commuteWindows, mode } = req.body;
  if (!targetUserId || !schoolLabel || schoolLocation?.latitude == null || schoolLocation?.longitude == null) {
    return res.status(400).json({ error: 'targetUserId, schoolLabel and schoolLocation are required' });
  }
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(targetUserId, caller)) return res.status(403).json({ error: 'Not authorized' });

  const targetAddresses = userAddresses.get(targetUserId) || [];
  let origin: { latitude: number; longitude: number } | null = null;
  if (homeAddressId) {
    const addr = targetAddresses.find(a => a.id === homeAddressId);
    if (addr?.latitude != null && addr?.longitude != null) origin = { latitude: addr.latitude, longitude: addr.longitude };
  }
  if (!origin) {
    const primary = targetAddresses.find(a => a.isPrimary) || targetAddresses[0];
    if (primary?.latitude != null && primary?.longitude != null) origin = { latitude: primary.latitude, longitude: primary.longitude };
  }
  if (!origin) return res.status(400).json({ error: 'No home address with coordinates found for this family member' });

  let geometry: { latitude: number; longitude: number }[];
  try {
    const candidates = await fetchDirectionsAlternatives(origin, { latitude: schoolLocation.latitude, longitude: schoolLocation.longitude }, mode === 'walking' ? 'walking' : 'driving');
    geometry = simplifyGeometry(candidates[0].geometry, 80);
  } catch (e) {
    console.error('[SchoolRoute] Failed to fetch route geometry:', e);
    return res.status(502).json({ error: "Impossible de calculer l'itinéraire" });
  }

  const now = Date.now();
  const route: SchoolRoute = {
    id: uuidv4(), ownerId: caller.id, targetUserId,
    targetUserName: targetUserName || adminUsers.get(targetUserId)?.name || targetUserId,
    homeAddressId: homeAddressId || undefined, schoolLabel, schoolLocation, geometry,
    corridorMeters: corridorMeters ? Number(corridorMeters) : 275,
    commuteWindows: Array.isArray(commuteWindows) ? commuteWindows : [],
    active: true, createdAt: now, updatedAt: now,
  };
  if (!schoolRoutes.has(targetUserId)) schoolRoutes.set(targetUserId, []);
  schoolRoutes.get(targetUserId)!.push(route);
  saveSchoolRouteToSupabase(route).catch(e => console.error('[Supabase] Failed to persist school route:', e));
  res.status(201).json(route);
});

app.put('/api/family/school-routes/:id', requireAuth, async (req, res) => {
  let found: SchoolRoute | undefined;
  for (const list of schoolRoutes.values()) { const r = list.find(x => x.id === (req.params.id as string)); if (r) { found = r; break; } }
  if (!found) return res.status(404).json({ error: 'Route not found' });
  if (!canEditAddressAssets(found.targetUserId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const { active, corridorMeters, commuteWindows } = req.body;
  if (active !== undefined) found.active = Boolean(active);
  if (corridorMeters !== undefined) found.corridorMeters = Number(corridorMeters);
  if (Array.isArray(commuteWindows)) found.commuteWindows = commuteWindows;
  found.updatedAt = Date.now();
  saveSchoolRouteToSupabase(found).catch(e => console.error('[Supabase] Failed to persist school route update:', e));
  res.json(found);
});

app.delete('/api/family/school-routes/:id', requireAuth, async (req, res) => {
  for (const list of schoolRoutes.values()) {
    const idx = list.findIndex(x => x.id === (req.params.id as string));
    if (idx !== -1) {
      if (!canEditAddressAssets(list[idx].targetUserId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
      list.splice(idx, 1);
      schoolRouteState.delete(req.params.id as string);
      const { error } = await supabaseAdmin.from('school_routes').delete().eq('id', req.params.id as string);
      if (error) console.error('[Supabase] Failed to persist school route deletion:', error.message);
      return res.json({ success: true });
    }
  }
  res.status(404).json({ error: 'Route not found' });
});

// GET /api/addresses/:addressId/guests
app.get('/api/addresses/:addressId/guests', requireAuth, (req, res) => {
  const ownerId = resolveAddressOwner((req.params.addressId as string));
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  if (!canViewAddressAssets(ownerId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  res.json(preauthorizedGuests.get((req.params.addressId as string)) || []);
});

// POST /api/addresses/:addressId/guests
app.post('/api/addresses/:addressId/guests', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const { guestName, guestPhone, eventLabel, validFrom, validUntil } = req.body;
  if (!guestName || !validFrom || !validUntil) {
    return res.status(400).json({ error: 'guestName, validFrom, and validUntil are required' });
  }
  const now = Date.now();
  const guest: PreAuthorizedGuest = {
    id: uuidv4(), addressId, userId: ownerId, guestName,
    guestPhone: guestPhone || undefined, eventLabel: eventLabel || undefined,
    validFrom: Number(validFrom), validUntil: Number(validUntil),
    addedBy: caller.id, createdAt: now,
  };
  if (!preauthorizedGuests.has(addressId)) preauthorizedGuests.set(addressId, []);
  preauthorizedGuests.get(addressId)!.push(guest);
  const { error } = await supabaseAdmin.from('preauthorized_guests').insert({
    id: guest.id, address_id: addressId, user_id: ownerId, guest_name: guest.guestName,
    guest_phone: guest.guestPhone || null, event_label: guest.eventLabel || null,
    valid_from: guest.validFrom, valid_until: guest.validUntil,
    added_by: guest.addedBy, created_at: now,
  });
  if (error) console.error('[Supabase] Failed to persist preauthorized guest:', error.message);
  res.status(201).json(guest);
});

// DELETE /api/addresses/:addressId/guests/:guestId
app.delete('/api/addresses/:addressId/guests/:guestId', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const guests = preauthorizedGuests.get(addressId) || [];
  const idx = guests.findIndex(g => g.id === (req.params.guestId as string));
  if (idx === -1) return res.status(404).json({ error: 'Guest not found' });
  guests.splice(idx, 1);
  const { error } = await supabaseAdmin.from('preauthorized_guests').delete().eq('id', (req.params.guestId as string));
  if (error) console.error('[Supabase] Failed to persist preauthorized guest deletion:', error.message);
  res.json({ success: true });
});

// GET /api/addresses/:addressId/interventions
app.get('/api/addresses/:addressId/interventions', requireAuth, (req, res) => {
  const ownerId = resolveAddressOwner((req.params.addressId as string));
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  if (!canViewAddressAssets(ownerId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  res.json(plannedInterventions.get((req.params.addressId as string)) || []);
});

// POST /api/addresses/:addressId/interventions
app.post('/api/addresses/:addressId/interventions', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const { personId, personName, category, scheduledStart, scheduledEnd, recurrence, notes } = req.body;
  if (!scheduledStart) return res.status(400).json({ error: 'scheduledStart is required' });
  let resolvedPersonName = personName;
  if (personId && !resolvedPersonName) {
    const person = (knownPeople.get(addressId) || []).find(p => p.id === personId);
    resolvedPersonName = person?.name;
  }
  if (!resolvedPersonName) return res.status(400).json({ error: 'personId or personName is required' });
  const now = Date.now();
  const intervention: PlannedIntervention = {
    id: uuidv4(), addressId, userId: ownerId, personId: personId || undefined, personName: resolvedPersonName,
    category: category || undefined, scheduledStart: Number(scheduledStart),
    scheduledEnd: scheduledEnd ? Number(scheduledEnd) : undefined,
    recurrence: recurrence || undefined, status: 'scheduled', notes: notes || undefined,
    createdBy: caller.id, createdAt: now, updatedAt: now,
  };
  if (!plannedInterventions.has(addressId)) plannedInterventions.set(addressId, []);
  plannedInterventions.get(addressId)!.push(intervention);
  const { error } = await supabaseAdmin.from('planned_interventions').insert({
    id: intervention.id, address_id: addressId, user_id: ownerId, person_id: intervention.personId || null,
    person_name: intervention.personName, category: intervention.category || null,
    scheduled_start: intervention.scheduledStart, scheduled_end: intervention.scheduledEnd || null,
    recurrence: intervention.recurrence || null, status: intervention.status, notes: intervention.notes || null,
    created_by: caller.id, created_at: now, updated_at: now,
  });
  if (error) console.error('[Supabase] Failed to persist intervention:', error.message);
  res.status(201).json(intervention);
});

// PUT /api/addresses/:addressId/interventions/:interventionId
app.put('/api/addresses/:addressId/interventions/:interventionId', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const list = plannedInterventions.get(addressId) || [];
  const idx = list.findIndex(iv => iv.id === (req.params.interventionId as string));
  if (idx === -1) return res.status(404).json({ error: 'Intervention not found' });
  const { personId, personName, category, scheduledStart, scheduledEnd, recurrence, status, notes } = req.body;
  const updated: PlannedIntervention = {
    ...list[idx],
    personId: personId !== undefined ? personId : list[idx].personId,
    personName: personName ?? list[idx].personName,
    category: category !== undefined ? category : list[idx].category,
    scheduledStart: scheduledStart !== undefined ? Number(scheduledStart) : list[idx].scheduledStart,
    scheduledEnd: scheduledEnd !== undefined ? Number(scheduledEnd) : list[idx].scheduledEnd,
    recurrence: recurrence !== undefined ? recurrence : list[idx].recurrence,
    status: status ?? list[idx].status,
    notes: notes !== undefined ? notes : list[idx].notes,
    updatedAt: Date.now(),
  };
  list[idx] = updated;
  const { error } = await supabaseAdmin.from('planned_interventions').update({
    person_id: updated.personId || null, person_name: updated.personName, category: updated.category || null,
    scheduled_start: updated.scheduledStart, scheduled_end: updated.scheduledEnd || null,
    recurrence: updated.recurrence || null, status: updated.status, notes: updated.notes || null,
    updated_at: updated.updatedAt,
  }).eq('id', updated.id);
  if (error) console.error('[Supabase] Failed to persist intervention update:', error.message);
  res.json(updated);
});

// POST /api/addresses/:addressId/interventions/:interventionId/arrival - staff
// confirms a provider is on-site. Gated by canViewAddressAssets (includes
// responder), deliberately not the wider canEditAddressAssets — this is a
// one-way status confirmation a responder should be able to make, not full
// edit rights over someone else's provider schedule.
app.post('/api/addresses/:addressId/interventions/:interventionId/arrival', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canViewAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const list = plannedInterventions.get(addressId) || [];
  const idx = list.findIndex(iv => iv.id === (req.params.interventionId as string));
  if (idx === -1) return res.status(404).json({ error: 'Intervention not found' });
  const updated: PlannedIntervention = { ...list[idx], status: 'in_progress', arrivedAt: Date.now(), updatedAt: Date.now() };
  list[idx] = updated;
  const { error } = await supabaseAdmin.from('planned_interventions').update({
    status: updated.status, arrived_at: updated.arrivedAt, updated_at: updated.updatedAt,
  }).eq('id', updated.id);
  if (error) console.error('[Supabase] Failed to persist intervention arrival:', error.message);
  sendFamilyPush([ownerId, ...getFamilyMemberIds(ownerId)], '🚗 Arrivée confirmée',
    `${updated.personName} est arrivé(e) sur place.`,
    { type: 'intervention_arrival', interventionId: updated.id, addressId }).catch(() => {});
  res.json(updated);
});

// DELETE /api/addresses/:addressId/interventions/:interventionId
app.delete('/api/addresses/:addressId/interventions/:interventionId', requireAuth, async (req, res) => {
  const addressId = (req.params.addressId as string);
  const ownerId = resolveAddressOwner(addressId);
  if (!ownerId) return res.status(404).json({ error: 'Address not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(ownerId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const list = plannedInterventions.get(addressId) || [];
  const idx = list.findIndex(iv => iv.id === (req.params.interventionId as string));
  if (idx === -1) return res.status(404).json({ error: 'Intervention not found' });
  list.splice(idx, 1);
  const { error } = await supabaseAdmin.from('planned_interventions').delete().eq('id', (req.params.interventionId as string));
  if (error) console.error('[Supabase] Failed to persist intervention deletion:', error.message);
  res.json({ success: true });
});

// ─── Travel Itineraries ─────────────────────────────────────────────────

function findItineraryById(id: string): { itinerary: TravelItinerary; userId: string } | undefined {
  for (const [userId, list] of travelItineraries) {
    const itinerary = list.find(it => it.id === id);
    if (itinerary) return { itinerary, userId };
  }
  return undefined;
}

// GET /api/family/itineraries?userId= - itineraries for a user and their family
app.get('/api/family/itineraries', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  if (!canViewAddressAssets(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const familyIds = new Set([userId, ...getFamilyMemberIds(userId)]);
  const all: TravelItinerary[] = [];
  for (const [uid, list] of travelItineraries) {
    if (familyIds.has(uid)) all.push(...list);
  }
  all.sort((a, b) => b.departureAt - a.departureAt);
  res.json(all);
});

// POST /api/family/itineraries
app.post('/api/family/itineraries', requireAuth, async (req, res) => {
  const { userId, destinationLabel, destinationAddress, departureAt, returnAt, notes } = req.body;
  if (!userId || !destinationLabel || !departureAt) {
    return res.status(400).json({ error: 'userId, destinationLabel, and departureAt required' });
  }
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(userId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const now = Date.now();
  const itinerary: TravelItinerary = {
    id: uuidv4(), userId, userName: adminUsers.get(userId)?.name || userId,
    destinationLabel, destinationAddress: destinationAddress || undefined,
    departureAt: Number(departureAt), returnAt: returnAt ? Number(returnAt) : undefined,
    notes: notes || undefined, createdBy: caller.id, createdAt: now, updatedAt: now,
  };
  if (!travelItineraries.has(userId)) travelItineraries.set(userId, []);
  travelItineraries.get(userId)!.push(itinerary);
  const { error } = await supabaseAdmin.from('travel_itineraries').insert({
    id: itinerary.id, user_id: userId, user_name: itinerary.userName,
    destination_label: itinerary.destinationLabel, destination_address: itinerary.destinationAddress || null,
    departure_at: itinerary.departureAt, return_at: itinerary.returnAt || null, notes: itinerary.notes || null,
    created_by: caller.id, created_at: now, updated_at: now,
  });
  if (error) console.error('[Supabase] Failed to persist travel itinerary:', error.message);
  res.status(201).json(itinerary);
});

// PUT /api/family/itineraries/:id
app.put('/api/family/itineraries/:id', requireAuth, async (req, res) => {
  const found = findItineraryById(req.params.id as string);
  if (!found) return res.status(404).json({ error: 'Itinerary not found' });
  const caller = req.supabaseUser!;
  if (!canEditAddressAssets(found.userId, caller)) return res.status(403).json({ error: 'Not authorized' });
  const { destinationLabel, destinationAddress, departureAt, returnAt, notes } = req.body;
  const updated: TravelItinerary = {
    ...found.itinerary,
    destinationLabel: destinationLabel ?? found.itinerary.destinationLabel,
    destinationAddress: destinationAddress !== undefined ? destinationAddress : found.itinerary.destinationAddress,
    departureAt: departureAt !== undefined ? Number(departureAt) : found.itinerary.departureAt,
    returnAt: returnAt !== undefined ? Number(returnAt) : found.itinerary.returnAt,
    notes: notes !== undefined ? notes : found.itinerary.notes,
    updatedAt: Date.now(),
  };
  const list = travelItineraries.get(found.userId)!;
  list[list.findIndex(it => it.id === updated.id)] = updated;
  const { error } = await supabaseAdmin.from('travel_itineraries').update({
    destination_label: updated.destinationLabel, destination_address: updated.destinationAddress || null,
    departure_at: updated.departureAt, return_at: updated.returnAt || null, notes: updated.notes || null,
    updated_at: updated.updatedAt,
  }).eq('id', updated.id);
  if (error) console.error('[Supabase] Failed to persist travel itinerary update:', error.message);
  const notifyIds = getFamilyMemberIds(found.userId).filter(id => id !== caller.id);
  if (notifyIds.length > 0) {
    sendFamilyPush(notifyIds, '✏️ Plan de voyage modifié',
      `Le voyage de ${updated.userName} vers ${updated.destinationLabel} a été mis à jour.`,
      { type: 'itinerary_updated', itineraryId: updated.id }).catch(() => {});
  }
  res.json(updated);
});

// DELETE /api/family/itineraries/:id
app.delete('/api/family/itineraries/:id', requireAuth, async (req, res) => {
  const found = findItineraryById(req.params.id as string);
  if (!found) return res.status(404).json({ error: 'Itinerary not found' });
  if (!canEditAddressAssets(found.userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const list = travelItineraries.get(found.userId)!;
  list.splice(list.findIndex(it => it.id === found.itinerary.id), 1);
  const { error } = await supabaseAdmin.from('travel_itineraries').delete().eq('id', found.itinerary.id);
  if (error) console.error('[Supabase] Failed to persist travel itinerary deletion:', error.message);
  res.json({ success: true });
});

// GET /api/itineraries/upcoming?from=&to= - staff-only, who's traveling in a window
app.get('/api/itineraries/upcoming', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const isStaff = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder';
  if (!isStaff) return res.status(403).json({ error: 'Staff only' });
  const from = req.query.from ? Number(req.query.from) : Date.now();
  const to = req.query.to ? Number(req.query.to) : from + 7 * 24 * 60 * 60 * 1000;
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  const results: TravelItinerary[] = [];
  for (const [userId, list] of travelItineraries) {
    if (!canAccessUser(callerAccess, userId)) continue;
    for (const it of list) {
      const end = it.returnAt ?? it.departureAt;
      if (it.departureAt <= to && end >= from) results.push(it);
    }
  }
  results.sort((a, b) => a.departureAt - b.departureAt);
  res.json(results);
});

// ─── Travel risk (UK GOV.UK FCDO advisories) ─────────────────────────────
// Public, unauthenticated, free, structured JSON:
// https://www.gov.uk/api/content/foreign-travel-advice/:countrySlug
// In-memory cache — no API key/quota to worry about, but no reason to hit it
// on every screen open either.
const travelAdvisoryCache = new Map<string, { data: any; cachedAt: number }>();
const TRAVEL_ADVISORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

app.get('/api/travel-advisory/:countrySlug', requireAuth, async (req, res) => {
  const slug = (req.params.countrySlug as string).toLowerCase();
  const cached = travelAdvisoryCache.get(slug);
  if (cached && Date.now() - cached.cachedAt < TRAVEL_ADVISORY_CACHE_TTL_MS) {
    return res.json(cached.data);
  }
  try {
    const response = await fetch(`https://www.gov.uk/api/content/foreign-travel-advice/${encodeURIComponent(slug)}`);
    if (!response.ok) {
      return res.status(response.status === 404 ? 404 : 502).json({
        error: response.status === 404 ? 'No advisory found for this destination' : 'Upstream error',
      });
    }
    const json: any = await response.json();
    const details = json.details || {};
    const result = {
      countrySlug: slug,
      title: json.title || slug,
      alertStatus: details.alert_status || [],
      summary: details.summary || '',
      changeHistory: (details.change_history || []).slice(0, 10),
      updatedAt: json.updated_at || null,
      sourceUrl: `https://www.gov.uk/foreign-travel-advice/${slug}`,
    };
    travelAdvisoryCache.set(slug, { data: result, cachedAt: Date.now() });
    res.json(result);
  } catch (e) {
    console.error('[TravelAdvisory] fetch error:', e);
    res.status(502).json({ error: 'Failed to fetch travel advisory' });
  }
});

// GET /api/known-people/all — every known provider/visitor across every residence,
// regardless of whether they currently have a scheduled visit. This is the "who is
// this person/plate/company" lookup for doubt resolution (someone's at the gate or
// on camera and dispatch needs to check if they're a known contact anywhere at all,
// not just today's calendar).
app.get('/api/known-people/all', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const isStaff = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder';
  if (!isStaff) return res.status(403).json({ error: 'Staff only' });
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  const result: any[] = [];
  for (const [addressId, people] of knownPeople) {
    for (const p of people) {
      if (!canAccessUser(callerAccess, p.userId)) continue;
      const owner = adminUsers.get(p.userId);
      const addr = (userAddresses.get(p.userId) || []).find(a => a.id === addressId);
      result.push({
        id: p.id, addressId, addressLabel: addr?.label, address: addr?.address, ownerName: owner?.name,
        name: p.name, category: p.category, company: p.company, phone: p.phone, email: p.email,
        vehiclePlate: p.vehiclePlate, vehicleDescription: p.vehicleDescription, notes: p.notes,
      });
    }
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  res.json(result);
});

// GET /api/entity-search?q= — cross-references a name/phone/plate against every
// place a person can be known to the system today: Blackbook (threats/suspicious
// persons), known people (providers/visitors per residence), and system accounts
// (families/staff). These are three separate, unrelated data structures with no
// links between them - this is a read-only unification layer answering "is this
// person/vehicle known ANYWHERE" without a schema migration. Point 2 of the
// ontology/entity-resolution discussion - the lightweight version.
app.get('/api/entity-search', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const isStaff = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder';
  if (!isStaff) return res.status(403).json({ error: 'Staff only' });
  const query = ((req.query.q as string) || '').trim().toLowerCase();
  if (query.length < 2) return res.json([]);
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };

  const results: any[] = [];

  for (const entry of blackbookEntries.values()) {
    if (!canAccessOrg(caller, entry.organizationId)) continue;
    // Within the organization, entries not linked to any specific family are
    // general threats, not confidential to one client — only gate entries
    // that ARE linked at the family level.
    if (entry.linkedUserId && !canAccessUser(callerAccess, entry.linkedUserId)) continue;
    const haystacks = [
      `${entry.firstName} ${entry.lastName}`,
      ...entry.aliases,
      ...entry.vehicles.map(v => v.plate || ''),
    ].filter(Boolean).map(s => s.toLowerCase());
    if (haystacks.some(h => h.includes(query))) {
      const plates = entry.vehicles.map(v => v.plate).filter(Boolean).join(', ');
      results.push({
        source: 'blackbook',
        id: entry.id,
        name: `${entry.firstName} ${entry.lastName}`,
        detail: `Blackbook — risque ${entry.riskLevel}${plates ? ` — ${plates}` : ''}`,
        riskLevel: entry.riskLevel,
        status: entry.status,
      });
    }
  }

  for (const [addressId, people] of knownPeople) {
    for (const p of people) {
      if (!canAccessUser(callerAccess, p.userId)) continue;
      const haystack = [p.name, p.company, p.phone, p.vehiclePlate].filter(Boolean).join(' ').toLowerCase();
      if (haystack.includes(query)) {
        const owner = adminUsers.get(p.userId);
        const addr = (userAddresses.get(p.userId) || []).find(a => a.id === addressId);
        results.push({
          source: 'known_person',
          id: p.id,
          name: p.name,
          detail: `Personne connue — ${p.category}${owner ? ` — ${owner.name}` : ''}${addr ? ` (${addr.label})` : ''}`,
          category: p.category,
        });
      }
    }
  }

  for (const u of adminUsers.values()) {
    // Only civilian ('user') accounts are family-confidential data; staff
    // directory entries (dispatcher/responder/admin) aren't a client's
    // private information and stay visible to any staff searching.
    if (u.role === 'user' && !canAccessUser(callerAccess, u.id)) continue;
    const haystack = [u.name, u.email, u.phoneMobile, u.phoneLandline].filter(Boolean).join(' ').toLowerCase();
    if (haystack.includes(query)) {
      results.push({
        source: 'system_account',
        id: u.id,
        name: u.name,
        detail: `Compte système — ${u.role}`,
        role: u.role,
      });
    }
  }

  res.json(results);
});

// GET /api/interventions/upcoming?from=&to= — cross-residence calendar for staff situational
// awareness ("who's expected where today"), expanding simple weekly recurrences into
// concrete occurrences within [from, to]. Defaults to the next 7 days.
app.get('/api/interventions/upcoming', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const isStaff = caller.role === 'dispatcher' || caller.role === 'admin' || caller.role === 'responder';
  if (!isStaff) return res.status(403).json({ error: 'Staff only' });
  const from = req.query.from ? Number(req.query.from) : Date.now();
  const to = req.query.to ? Number(req.query.to) : from + 7 * 24 * 60 * 60 * 1000;
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  const occurrences: any[] = [];

  for (const [addressId, list] of plannedInterventions) {
    for (const iv of list) {
      if (iv.status === 'cancelled') continue;
      if (!canAccessUser(callerAccess, iv.userId)) continue;
      const owner = adminUsers.get(iv.userId);
      const addr = (userAddresses.get(iv.userId) || []).find(a => a.id === addressId);
      const person = iv.personId ? (knownPeople.get(addressId) || []).find(p => p.id === iv.personId) : undefined;
      const base = {
        interventionId: iv.id, addressId, addressLabel: addr?.label, address: addr?.address,
        ownerName: owner?.name, personName: iv.personName, category: iv.category, status: iv.status, notes: iv.notes,
        personCompany: person?.company, personPhone: person?.phone, personVehiclePlate: person?.vehiclePlate,
      };
      if (iv.recurrence?.frequency === 'weekly' && iv.recurrence.daysOfWeek?.length) {
        const startTime = new Date(iv.scheduledStart);
        const durationMs = (iv.scheduledEnd || iv.scheduledStart) - iv.scheduledStart;
        const cursor = new Date(Math.max(from, iv.scheduledStart));
        cursor.setHours(0, 0, 0, 0);
        const end = new Date(to);
        while (cursor.getTime() <= end.getTime()) {
          if (iv.recurrence.daysOfWeek.includes(cursor.getDay())) {
            const occStart = new Date(cursor);
            occStart.setHours(startTime.getHours(), startTime.getMinutes(), 0, 0);
            if (occStart.getTime() >= from && occStart.getTime() <= to) {
              occurrences.push({ ...base, scheduledStart: occStart.getTime(), scheduledEnd: durationMs > 0 ? occStart.getTime() + durationMs : undefined });
            }
          }
          cursor.setDate(cursor.getDate() + 1);
        }
      } else if (iv.scheduledStart >= from && iv.scheduledStart <= to) {
        occurrences.push({ ...base, scheduledStart: iv.scheduledStart, scheduledEnd: iv.scheduledEnd });
      }
    }
  }
  occurrences.sort((a, b) => a.scheduledStart - b.scheduledStart);
  res.json(occurrences);
});

// ─── Blackbook: suspicious persons registry ────────────────────────────────
// Not tied to any one residence — a person can be sighted at multiple
// properties, so this is its own top-level entity (unlike KnownPerson, which
// is address-scoped). Staff-only (responder/dispatcher/admin): field staff
// log sightings, dispatch/admin manage the full record.

interface BlackbookSighting {
  id: string;
  timestamp: number;
  category: 'prise_info' | 'intrusion' | 'menaces' | 'envoi_courrier' | 'reperage' | 'autre';
  location?: { latitude?: number; longitude?: number; address?: string };
  // When the sighting is at a known residence rather than a freeform place —
  // denormalized (label/owner name) so display never needs a second lookup,
  // and stays correct even if the address is later renamed or deleted.
  residenceId?: string;
  residenceLabel?: string;
  residenceOwnerId?: string;
  residenceOwnerName?: string;
  notes?: string;
  reportedBy: string;
  reportedByName: string;
}

interface BlackbookVehicle {
  plate?: string;
  description?: string;
}

interface BlackbookEntry {
  id: string;
  firstName: string;
  lastName: string;
  aliases: string[];
  dateOfBirth?: string; // YYYY-MM-DD
  physicalDescription?: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  status: 'active' | 'resolved' | 'archived';
  photos: string[];
  vehicles: BlackbookVehicle[];
  tags: string[];
  notes?: string;
  sightings: BlackbookSighting[];
  linkedIncidentIds: string[];
  linkedUserId?: string; // family/residence this person is associated with, if any
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  organizationId?: string;
}

const blackbookEntries = new Map<string, BlackbookEntry>();
const BLACKBOOK_CATEGORY_LABELS: Record<string, string> = {
  prise_info: "Prise d'info", intrusion: 'Intrusion', menaces: 'Menaces',
  envoi_courrier: 'Envoi de courrier', reperage: 'Repérage', autre: 'Autre',
};

async function loadBlackbookFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('blackbook_entries').select('*');
    if (error) { console.error('[Supabase] Failed to load blackbook_entries:', error.message); return; }
    if (data && data.length > 0) {
      blackbookEntries.clear();
      data.forEach((e: any) => {
        blackbookEntries.set(e.id, {
          id: e.id, firstName: e.first_name, lastName: e.last_name, aliases: e.aliases || [],
          dateOfBirth: e.date_of_birth || undefined, physicalDescription: e.physical_description || undefined,
          riskLevel: e.risk_level, status: e.status, photos: e.photos || [], vehicles: e.vehicles || [],
          tags: e.tags || [], notes: e.notes || undefined, sightings: e.sightings || [],
          linkedIncidentIds: e.linked_incident_ids || [], linkedUserId: e.linked_user_id || undefined,
          createdBy: e.created_by, createdByName: e.created_by_name, createdAt: e.created_at, updatedAt: e.updated_at,
          organizationId: e.organization_id || undefined,
        });
      });
      console.log(`[Supabase] Loaded ${data.length} blackbook entries`);
    }
  } catch (e) { console.error('[Supabase] loadBlackbookFromSupabase error:', e); }
}

async function saveBlackbookEntryToSupabase(entry: BlackbookEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('blackbook_entries').upsert({
      id: entry.id, first_name: entry.firstName, last_name: entry.lastName, aliases: entry.aliases,
      date_of_birth: entry.dateOfBirth || null, physical_description: entry.physicalDescription || null,
      risk_level: entry.riskLevel, status: entry.status, photos: entry.photos, vehicles: entry.vehicles,
      tags: entry.tags, notes: entry.notes || null, sightings: entry.sightings,
      linked_incident_ids: entry.linkedIncidentIds, linked_user_id: entry.linkedUserId || null,
      created_by: entry.createdBy, created_by_name: entry.createdByName, created_at: entry.createdAt, updated_at: entry.updatedAt,
      organization_id: entry.organizationId || null,
    });
    if (error) console.error('[Supabase] Failed to persist blackbook entry:', error.message);
  } catch (e) { console.error('[Supabase] saveBlackbookEntryToSupabase error:', e); }
}

async function deleteBlackbookEntryFromSupabase(id: string): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('blackbook_entries').delete().eq('id', id);
    if (error) console.error('[Supabase] Failed to delete blackbook entry:', error.message);
  } catch (e) { console.error('[Supabase] deleteBlackbookEntryFromSupabase error:', e); }
}

function isBlackbookStaff(role: string): boolean {
  return role === 'responder' || role === 'dispatcher' || role === 'admin' || role === 'superadmin';
}

// ─── Main Courante + Analyse IA ────────────────────────────────────────
// Main Courante is a unified chronological log — it doesn't store its own
// events for patrol reports/Blackbook sightings (those already live in
// patrolReports/blackbookEntries), it merges them at read time. Only
// free-text manual notes need their own store.
interface MainCouranteNote {
  id: string;
  timestamp: number;
  ownerId: string; // family anchor, same convention as UserAddress.userId
  residenceId?: string;
  residenceLabel?: string;
  text: string;
  createdBy: string;
  createdByName: string;
}

const mainCouranteNotes = new Map<string, MainCouranteNote>();

async function loadMainCouranteNotesFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('main_courante_notes').select('*');
    if (error) { console.error('[Supabase] Failed to load main_courante_notes:', error.message); return; }
    if (data && data.length > 0) {
      mainCouranteNotes.clear();
      data.forEach((n: any) => {
        mainCouranteNotes.set(n.id, {
          id: n.id, timestamp: n.timestamp, ownerId: n.owner_id,
          residenceId: n.residence_id || undefined, residenceLabel: n.residence_label || undefined,
          text: n.text, createdBy: n.created_by, createdByName: n.created_by_name,
        });
      });
      console.log(`[Supabase] Loaded ${data.length} main courante notes`);
    }
  } catch (e) { console.error('[Supabase] loadMainCouranteNotesFromSupabase error:', e); }
}

async function saveMainCouranteNoteToSupabase(note: MainCouranteNote): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('main_courante_notes').upsert({
      id: note.id, timestamp: note.timestamp, owner_id: note.ownerId,
      residence_id: note.residenceId || null, residence_label: note.residenceLabel || null,
      text: note.text, created_by: note.createdBy, created_by_name: note.createdByName,
    });
    if (error) console.error('[Supabase] Failed to persist main courante note:', error.message);
  } catch (e) { console.error('[Supabase] saveMainCouranteNoteToSupabase error:', e); }
}

// PATROL_SITES are fixed neighborhood beats (e.g. "Champel — Avenue de
// Champel 24") that read like real addresses but carry no stored link to
// any UserAddress/family — patrol reports used to show up in every family's
// Main Courante unfiltered, which defeats the point of filtering by family
// at all. Resolve each site to the nearest registered residence (if any)
// once, by geocoding it and matching against every family's addresses —
// same geocodeAddress()/haversineDistance() building blocks already used
// for residence dedup. Cached per site name: there are only 8 sites today,
// they don't move, so this costs at most 8 geocoding calls per server
// lifetime, not one per report.
const PATROL_SITE_FAMILY_MATCH_METERS = 250;
const patrolSiteFamilyCache = new Map<string, { ownerId: string; ownerName: string; residenceLabel: string } | null>();

async function resolvePatrolSiteFamily(siteName: string): Promise<{ ownerId: string; ownerName: string; residenceLabel: string } | null> {
  if (patrolSiteFamilyCache.has(siteName)) return patrolSiteFamilyCache.get(siteName)!;
  let result: { ownerId: string; ownerName: string; residenceLabel: string } | null = null;
  try {
    // PATROL_SITES strings (e.g. "Champel — Avenue de Champel 24") have no
    // city/country, unlike every registered residence address — append one
    // so the geocoder has the same context it gets everywhere else.
    const coords = await geocodeAddress(`${siteName}, Genève, Suisse`);
    if (coords) {
      let best: { ownerId: string; label: string; dist: number } | null = null;
      for (const [ownerId, addresses] of userAddresses) {
        for (const a of addresses) {
          if (a.latitude == null || a.longitude == null) continue;
          const dist = haversineDistance(coords.latitude, coords.longitude, a.latitude, a.longitude);
          if (dist <= PATROL_SITE_FAMILY_MATCH_METERS && (!best || dist < best.dist)) best = { ownerId, label: a.label, dist };
        }
      }
      if (best) result = { ownerId: best.ownerId, ownerName: adminUsers.get(best.ownerId)?.name || best.ownerId, residenceLabel: best.label };
    }
  } catch (e) {
    console.error('[Patrol] resolvePatrolSiteFamily error:', e);
  }
  patrolSiteFamilyCache.set(siteName, result);
  return result;
}

// Synchronous counterpart to resolvePatrolSiteFamily for callers that already
// have coordinates (e.g. via resolveSiteDestination) and don't want a geocode
// round-trip just to check whether a site sits on a family's registered,
// occupancy-tracked residence. Returns the matched address's occupancyStatus
// ('occupied'/'unoccupied'), or null if no residence is within range or the
// matched residence doesn't track occupancy.
function findResidenceOccupancyForCoords(coords: { latitude: number; longitude: number }): 'occupied' | 'unoccupied' | null {
  let best: { addr: UserAddress; dist: number } | null = null;
  for (const addresses of userAddresses.values()) {
    for (const a of addresses) {
      if (a.latitude == null || a.longitude == null) continue;
      const dist = haversineDistance(coords.latitude, coords.longitude, a.latitude, a.longitude);
      if (dist <= PATROL_SITE_FAMILY_MATCH_METERS && (!best || dist < best.dist)) best = { addr: a, dist };
    }
  }
  return best?.addr.occupancyStatus || null;
}

interface MainCouranteEntry {
  id: string;
  timestamp: number;
  source: 'patrol' | 'blackbook' | 'manual';
  ownerId?: string; // family this entry belongs to, when known — for
  // patrol, resolved live via resolvePatrolSiteFamily; absent if the site
  // isn't within range of any registered residence.
  ownerName?: string;
  residenceLabel?: string;
  category: string;
  summary: string;
  notes?: string;
  createdBy: string;
  createdByName: string;
  refId: string;
}

// Shared by the Main Courante tab (family-filterable) and the AI analysis
// (always called with a specific family's ownerIds). When ownerIds is null
// (unfiltered view), every patrol report is included regardless of whether
// its site resolved to a family; when scoped, only reports whose resolved
// family is in ownerIds are included — a site with no nearby residence
// simply never appears in any family-scoped view.
async function computeMainCouranteEntries(ownerIds: string[] | null, fromMs: number, toMs: number): Promise<MainCouranteEntry[]> {
  const entries: MainCouranteEntry[] = [];

  for (const r of patrolReports) {
    if (r.createdAt < fromMs || r.createdAt > toMs) continue;
    const family = await resolvePatrolSiteFamily(r.location);
    if (ownerIds && (!family || !ownerIds.includes(family.ownerId))) continue;
    entries.push({
      id: `patrol-${r.id}`, timestamp: r.createdAt, source: 'patrol',
      ownerId: family?.ownerId, ownerName: family?.ownerName, residenceLabel: family?.residenceLabel,
      category: r.status,
      summary: `Ronde — ${r.location}${family ? ` (${family.ownerName})` : ''} — ${PATROL_STATUS_CONFIG[r.status]?.label || r.status}`,
      notes: r.notes, createdBy: r.createdBy, createdByName: r.createdByName, refId: r.id,
    });
  }

  for (const entry of blackbookEntries.values()) {
    for (const s of entry.sightings) {
      if (s.timestamp < fromMs || s.timestamp > toMs) continue;
      if (ownerIds && (!s.residenceOwnerId || !ownerIds.includes(s.residenceOwnerId))) continue;
      entries.push({
        id: `bb-${s.id}`, timestamp: s.timestamp, source: 'blackbook',
        ownerId: s.residenceOwnerId, ownerName: s.residenceOwnerName, residenceLabel: s.residenceLabel,
        category: s.category,
        summary: `${entry.firstName} ${entry.lastName} — ${BLACKBOOK_CATEGORY_LABELS[s.category] || s.category}${s.residenceLabel ? ' — ' + s.residenceLabel : ''}`,
        notes: s.notes, createdBy: s.reportedBy, createdByName: s.reportedByName, refId: entry.id,
      });
    }
  }

  for (const note of mainCouranteNotes.values()) {
    if (note.timestamp < fromMs || note.timestamp > toMs) continue;
    if (ownerIds && !ownerIds.includes(note.ownerId)) continue;
    entries.push({
      id: `note-${note.id}`, timestamp: note.timestamp, source: 'manual',
      ownerId: note.ownerId, residenceLabel: note.residenceLabel,
      category: 'note', summary: note.text.length > 80 ? note.text.slice(0, 80) + '…' : note.text,
      notes: note.text, createdBy: note.createdBy, createdByName: note.createdByName, refId: note.id,
    });
  }

  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}

// GET /api/main-courante?userId=&days= - unified log for a family (staff only)
app.get('/api/main-courante', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  if (!canAccessUser(callerAccess, userId)) return res.status(403).json({ error: 'Not authorized for this family' });
  const days = Math.min(Number(req.query.days) || 30, 365);
  const now = Date.now();
  const ownerIds = Array.from(new Set([userId, ...getFamilyMemberIds(userId)]));
  res.json(await computeMainCouranteEntries(ownerIds, now - days * 24 * 60 * 60 * 1000, now));
});

// POST /api/main-courante - add a free-text log entry (staff only)
app.post('/api/main-courante', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const { userId, residenceId, residenceLabel, text } = req.body;
  if (!userId || !text || !String(text).trim()) return res.status(400).json({ error: 'userId and text required' });
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  if (!canAccessUser(callerAccess, userId)) return res.status(403).json({ error: 'Not authorized for this family' });
  const note: MainCouranteNote = {
    id: uuidv4(), timestamp: Date.now(), ownerId: userId,
    residenceId: residenceId || undefined, residenceLabel: residenceLabel || undefined,
    text: String(text).trim(), createdBy: caller.id, createdByName: adminUsers.get(caller.id)?.name || caller.id,
  };
  mainCouranteNotes.set(note.id, note);
  await saveMainCouranteNoteToSupabase(note);
  res.json(note);
});

interface ThreatAnalysisItem {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  rationale: string;
  sourceRefs: string[];
  acknowledged: boolean;
  acknowledgedBy?: string;
  acknowledgedAt?: number;
}

interface ThreatAnalysis {
  id: string;
  ownerId: string;
  ownerName: string;
  generatedAt: number;
  generatedBy: string;
  generatedByName: string;
  periodDays: number;
  entryCount: number;
  summary: string;
  flaggedItems: ThreatAnalysisItem[];
}

const threatAnalyses = new Map<string, ThreatAnalysis>();

async function loadThreatAnalysesFromSupabase(): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.from('threat_analyses').select('*');
    if (error) { console.error('[Supabase] Failed to load threat_analyses:', error.message); return; }
    if (data && data.length > 0) {
      threatAnalyses.clear();
      data.forEach((a: any) => {
        threatAnalyses.set(a.id, {
          id: a.id, ownerId: a.owner_id, ownerName: a.owner_name,
          generatedAt: a.generated_at, generatedBy: a.generated_by, generatedByName: a.generated_by_name,
          periodDays: a.period_days, entryCount: a.entry_count, summary: a.summary,
          flaggedItems: a.flagged_items || [],
        });
      });
      console.log(`[Supabase] Loaded ${data.length} threat analyses`);
    }
  } catch (e) { console.error('[Supabase] loadThreatAnalysesFromSupabase error:', e); }
}

async function saveThreatAnalysisToSupabase(a: ThreatAnalysis): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('threat_analyses').upsert({
      id: a.id, owner_id: a.ownerId, owner_name: a.ownerName,
      generated_at: a.generatedAt, generated_by: a.generatedBy, generated_by_name: a.generatedByName,
      period_days: a.periodDays, entry_count: a.entryCount, summary: a.summary,
      flagged_items: a.flaggedItems,
    });
    if (error) console.error('[Supabase] Failed to persist threat analysis:', error.message);
  } catch (e) { console.error('[Supabase] saveThreatAnalysisToSupabase error:', e); }
}

// Calls the Anthropic Messages API directly (fetch, no SDK — same convention
// as geocodeAddress's Mapbox call). Returns null on any failure so the
// caller can respond with a clean 503 instead of crashing — this must never
// take down the server the way an uncaught throw would.
type ThreatAnalysisAIResult =
  | { ok: true; summary: string; flaggedItems: Array<{ severity: string; title: string; rationale: string; sourceRefs: string[] }> }
  | { ok: false; reason: string };

async function callThreatAnalysisAI(entriesText: string, entryCount: number): Promise<ThreatAnalysisAIResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.warn('[ThreatAnalysis] ANTHROPIC_API_KEY not set'); return { ok: false, reason: 'Clé API non configurée sur le serveur (ANTHROPIC_API_KEY absente)' }; }
  if (entryCount === 0) return { ok: true, summary: 'Aucune activité enregistrée sur cette période.', flaggedItems: [] };
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 2000,
        system: `Tu es un analyste protection pour une société de sécurité résidentielle (clients UHNWI). On te fournit la main courante (rondes, sightings Blackbook, notes manuelles) d'une famille sur une période donnée. Réponds UNIQUEMENT en JSON strict, sans texte autour ni bloc de code markdown (pas de \`\`\`), avec exactement cette forme :
{"summary": "résumé narratif court en français", "flaggedItems": [{"severity": "low|medium|high|critical", "title": "titre court", "rationale": "pourquoi c'est signalé, en te basant uniquement sur les faits fournis", "sourceRefs": ["id des entrées concernées"]}]}
Si rien de notable ne ressort des données, renvoie un summary qui le dit explicitement et flaggedItems: [] — n'invente jamais un pattern qui n'est pas soutenu par les données. Les rondes ne sont pas rattachées à une famille spécifique (secteur général) — ne leur attribue pas une signification propre à cette famille sans justification claire.`,
        messages: [{ role: 'user', content: entriesText }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[ThreatAnalysis] Anthropic API error:', resp.status, body);
      return { ok: false, reason: `Anthropic a répondu ${resp.status}: ${body.slice(0, 300)}` };
    }
    const data = await resp.json() as any;
    const text = data?.content?.[0]?.text;
    if (!text) return { ok: false, reason: 'Réponse Anthropic sans contenu texte exploitable' };
    // Models frequently wrap JSON in a markdown code fence despite being told
    // not to — strip it before parsing rather than relying on the prompt
    // instruction alone.
    const fenceMatch = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    const jsonText = fenceMatch ? fenceMatch[1] : text.trim();
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      return { ok: false, reason: `JSON invalide renvoyé par le modèle: ${String(text).slice(0, 300)}` };
    }
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.flaggedItems)) {
      return { ok: false, reason: 'Forme JSON inattendue renvoyée par le modèle' };
    }
    return { ok: true, summary: parsed.summary, flaggedItems: parsed.flaggedItems };
  } catch (e) {
    console.error('[ThreatAnalysis] callThreatAnalysisAI error:', e);
    return { ok: false, reason: `Erreur réseau: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ─── Entity extraction from free-text notes ─────────────────────────────
// Explicit-trigger only (an "Analyser" button client-side, never automatic
// on keystroke/save) — same fetch/env-var/fence-stripping/error convention
// as callThreatAnalysisAI above, copied deliberately rather than
// reinvented. Only surfaces what's explicitly in the text; never invents.
type EntityExtractionResult =
  | { ok: true; candidates: { type: 'name' | 'plate' | 'location'; value: string; context: string }[] }
  | { ok: false; reason: string };

async function callEntityExtractionAI(freeText: string): Promise<EntityExtractionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.warn('[EntityExtraction] ANTHROPIC_API_KEY not set'); return { ok: false, reason: 'Clé API non configurée sur le serveur (ANTHROPIC_API_KEY absente)' }; }
  if (!freeText.trim()) return { ok: true, candidates: [] };
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1000,
        system: `Tu extrais des entités structurées depuis une note libre de sécurité résidentielle. Réponds UNIQUEMENT en JSON strict, sans texte autour ni bloc de code markdown (pas de \`\`\`), avec exactement cette forme :
{"candidates": [{"type": "name|plate|location", "value": "...", "context": "extrait de phrase autour"}]}
N'invente rien qui n'est pas explicitement présent dans le texte. Si rien n'est trouvé, renvoie candidates: [].`,
        messages: [{ role: 'user', content: freeText }],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[EntityExtraction] Anthropic API error:', resp.status, body);
      return { ok: false, reason: `Anthropic a répondu ${resp.status}: ${body.slice(0, 300)}` };
    }
    const data = await resp.json() as any;
    const text = data?.content?.[0]?.text;
    if (!text) return { ok: false, reason: 'Réponse Anthropic sans contenu texte exploitable' };
    const fenceMatch = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
    const jsonText = fenceMatch ? fenceMatch[1] : text.trim();
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch (parseErr) {
      return { ok: false, reason: `JSON invalide renvoyé par le modèle: ${String(text).slice(0, 300)}` };
    }
    if (!Array.isArray(parsed.candidates)) return { ok: false, reason: 'Forme JSON inattendue renvoyée par le modèle' };
    return { ok: true, candidates: parsed.candidates };
  } catch (e) {
    console.error('[EntityExtraction] callEntityExtractionAI error:', e);
    return { ok: false, reason: `Erreur réseau: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// POST /api/notes/extract-entities — generic (Blackbook sighting notes,
// patrol report notes, or any other free-text field), no persistence.
app.post('/api/notes/extract-entities', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const result = await callEntityExtractionAI(text);
  if (!result.ok) return res.status(503).json({ error: 'Analyse IA indisponible : ' + result.reason });
  res.json({ candidates: result.candidates });
});

// POST /admin/threat-analysis/generate - on-demand, 30-day window (dispatcher+)
app.post('/admin/threat-analysis/generate', requireAuth, requireRole('dispatcher'), async (req, res) => {
  const caller = req.supabaseUser!;
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  if (!canAccessUser(callerAccess, userId)) return res.status(403).json({ error: 'Not authorized for this family' });

  const owner = adminUsers.get(userId);
  if (!owner) return res.status(404).json({ error: 'User not found' });

  const periodDays = 30;
  const now = Date.now();
  const ownerIds = Array.from(new Set([userId, ...getFamilyMemberIds(userId)]));
  const entries = await computeMainCouranteEntries(ownerIds, now - periodDays * 24 * 60 * 60 * 1000, now);
  const entriesText = entries.map(e =>
    `[${e.id}] ${new Date(e.timestamp).toISOString()} (${e.source}) ${e.summary}${e.notes ? ' — ' + e.notes : ''}`
  ).join('\n');

  const result = await callThreatAnalysisAI(entriesText, entries.length);
  if (!result.ok) return res.status(503).json({ error: `Analyse IA indisponible : ${result.reason}` });

  const analysis: ThreatAnalysis = {
    id: uuidv4(), ownerId: userId, ownerName: owner.name,
    generatedAt: now, generatedBy: caller.id, generatedByName: adminUsers.get(caller.id)?.name || caller.id,
    periodDays, entryCount: entries.length, summary: result.summary,
    flaggedItems: result.flaggedItems.map(item => ({
      id: uuidv4(),
      severity: (['low', 'medium', 'high', 'critical'].includes(item.severity) ? item.severity : 'low') as ThreatAnalysisItem['severity'],
      title: item.title, rationale: item.rationale, sourceRefs: item.sourceRefs || [],
      acknowledged: false,
    })),
  };
  threatAnalyses.set(analysis.id, analysis);
  await saveThreatAnalysisToSupabase(analysis);
  addAuditEntry('threat_analysis', 'Analyse IA générée', caller.id, `${owner.name} — ${entries.length} entrées, ${analysis.flaggedItems.length} élément(s) signalé(s)`, userId, owner.organizationId);
  res.json(analysis);
});

// GET /admin/threat-analysis?userId=&limit= - history for a family (dispatcher+)
app.get('/admin/threat-analysis', requireAuth, requireRole('dispatcher'), (req, res) => {
  const caller = req.supabaseUser!;
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  if (!canAccessUser(callerAccess, userId)) return res.status(403).json({ error: 'Not authorized for this family' });
  const limit = Math.min(Number(req.query.limit) || 20, 100);
  const list = Array.from(threatAnalyses.values())
    .filter(a => a.ownerId === userId)
    .sort((a, b) => b.generatedAt - a.generatedAt)
    .slice(0, limit);
  res.json(list);
});

// PUT /admin/threat-analysis/:id/items/:itemId/acknowledge (dispatcher+)
app.put('/admin/threat-analysis/:id/items/:itemId/acknowledge', requireAuth, requireRole('dispatcher'), async (req, res) => {
  const caller = req.supabaseUser!;
  const analysis = threatAnalyses.get(req.params.id as string);
  if (!analysis) return res.status(404).json({ error: 'Analysis not found' });
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  if (!canAccessUser(callerAccess, analysis.ownerId)) return res.status(403).json({ error: 'Not authorized for this family' });
  const item = analysis.flaggedItems.find(i => i.id === req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  item.acknowledged = true;
  item.acknowledgedBy = adminUsers.get(caller.id)?.name || caller.id;
  item.acknowledgedAt = Date.now();
  await saveThreatAnalysisToSupabase(analysis);
  addAuditEntry('threat_analysis', 'Élément signalé acquitté', caller.id, `${analysis.ownerName} — ${item.title}`, analysis.ownerId, adminUsers.get(analysis.ownerId)?.organizationId);
  res.json(analysis);
});

// GET /api/blackbook — full list; client handles search/sort/filter (same
// pattern as the Visites tab — dataset is small enough this stays instant).
function enrichBlackbookEntry(entry: BlackbookEntry) {
  return { ...entry, linkedUserName: entry.linkedUserId ? adminUsers.get(entry.linkedUserId)?.name : undefined };
}

// Cross-references vehicle plates (exact, normalized) and names/aliases
// (case-insensitive) against every other entry in the same organization —
// deterministic string matching, not AI. Same org-scoping convention as
// countBlackbookProximity (direct equality, no cross-org matches).
interface RelatedBlackbookEntry { entryId: string; name: string; riskLevel: string; matchType: 'plate' | 'name' | 'alias'; matchValue: string; }
function findRelatedBlackbookEntries(entry: BlackbookEntry, organizationId?: string): RelatedBlackbookEntry[] {
  const results: RelatedBlackbookEntry[] = [];
  const myPlates = new Set(entry.vehicles.map(v => (v.plate || '').trim().toUpperCase()).filter(Boolean));
  const myNames = new Set([entry.firstName, entry.lastName, ...entry.aliases].map(n => (n || '').trim().toLowerCase()).filter(Boolean));
  for (const other of blackbookEntries.values()) {
    if (other.id === entry.id || other.organizationId !== organizationId) continue;
    const otherName = `${other.firstName} ${other.lastName}`.trim();
    for (const v of other.vehicles) {
      const p = (v.plate || '').trim().toUpperCase();
      if (p && myPlates.has(p)) results.push({ entryId: other.id, name: otherName, riskLevel: other.riskLevel, matchType: 'plate', matchValue: p });
    }
    const firstLower = (other.firstName || '').trim().toLowerCase();
    const lastLower = (other.lastName || '').trim().toLowerCase();
    for (const n of [other.firstName, other.lastName, ...other.aliases].map(x => (x || '').trim().toLowerCase()).filter(Boolean)) {
      if (myNames.has(n)) results.push({ entryId: other.id, name: otherName, riskLevel: other.riskLevel, matchType: (n === firstLower || n === lastLower) ? 'name' : 'alias', matchValue: n });
    }
  }
  const seen = new Set<string>();
  return results.filter(r => (seen.has(r.entryId) ? false : (seen.add(r.entryId), true)));
}

app.get('/api/blackbook', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  // Organization boundary first, hard, no exceptions — then, within that
  // organization, entries not linked to any specific family are general
  // threats, not confidential to one client, so only gate entries that ARE
  // linked at the family level.
  const entries = Array.from(blackbookEntries.values())
    .filter(e => canAccessOrg(caller, e.organizationId))
    .filter(e => !e.linkedUserId || canAccessUser(callerAccess, e.linkedUserId))
    .sort((a, b) => b.updatedAt - a.updatedAt).map(enrichBlackbookEntry);
  res.json(entries);
});

// GET /api/blackbook/:id
app.get('/api/blackbook/:id', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (!canAccessOrg(caller, entry.organizationId)) return res.status(403).json({ error: 'Not authorized for this entry' });
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  if (entry.linkedUserId && !canAccessUser(callerAccess, entry.linkedUserId)) return res.status(403).json({ error: 'Not authorized for this entry' });
  res.json(enrichBlackbookEntry(entry));
});

// GET /api/blackbook/:id/related — entries sharing a plate or name/alias
// with this one (see findRelatedBlackbookEntries).
app.get('/api/blackbook/:id/related', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (!canAccessOrg(caller, entry.organizationId)) return res.status(403).json({ error: 'Not authorized for this entry' });
  res.json(findRelatedBlackbookEntries(entry, entry.organizationId));
});

// POST /api/blackbook
app.post('/api/blackbook', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const { firstName, lastName, aliases, dateOfBirth, physicalDescription, riskLevel, vehicles, tags, notes, linkedUserId } = req.body;
  if (!firstName && !lastName) return res.status(400).json({ error: 'firstName or lastName is required' });
  const now = Date.now();
  const callerUser = adminUsers.get(caller.id);
  const entry: BlackbookEntry = {
    id: uuidv4(), firstName: firstName || '', lastName: lastName || '',
    aliases: Array.isArray(aliases) ? aliases : [],
    dateOfBirth: dateOfBirth || undefined, physicalDescription: physicalDescription || undefined,
    riskLevel: riskLevel || 'medium', status: 'active', photos: [],
    vehicles: Array.isArray(vehicles) ? vehicles : [], tags: Array.isArray(tags) ? tags : [],
    notes: notes || undefined, sightings: [], linkedIncidentIds: [], linkedUserId: linkedUserId || undefined,
    createdBy: caller.id, createdByName: callerUser?.name || caller.id, createdAt: now, updatedAt: now,
    organizationId: caller.organizationId,
  };
  blackbookEntries.set(entry.id, entry);
  saveBlackbookEntryToSupabase(entry).catch(() => {});
  addAuditEntry('system', 'Blackbook: fiche créée', entry.createdByName, `${entry.firstName} ${entry.lastName}`.trim(), caller.id, entry.organizationId);
  res.status(201).json(entry);
});

// PUT /api/blackbook/:id
app.put('/api/blackbook/:id', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (!canAccessOrg(caller, entry.organizationId)) return res.status(403).json({ error: 'Not authorized for this entry' });
  const { firstName, lastName, aliases, dateOfBirth, physicalDescription, riskLevel, status, vehicles, tags, notes, linkedUserId, linkedIncidentIds } = req.body;
  if (firstName !== undefined) entry.firstName = firstName;
  if (lastName !== undefined) entry.lastName = lastName;
  if (aliases !== undefined) entry.aliases = aliases;
  if (dateOfBirth !== undefined) entry.dateOfBirth = dateOfBirth || undefined;
  if (physicalDescription !== undefined) entry.physicalDescription = physicalDescription || undefined;
  if (riskLevel !== undefined) entry.riskLevel = riskLevel;
  if (status !== undefined) entry.status = status;
  if (vehicles !== undefined) entry.vehicles = vehicles;
  if (tags !== undefined) entry.tags = tags;
  if (notes !== undefined) entry.notes = notes || undefined;
  if (linkedUserId !== undefined) entry.linkedUserId = linkedUserId || undefined;
  if (linkedIncidentIds !== undefined) entry.linkedIncidentIds = linkedIncidentIds;
  entry.updatedAt = Date.now();
  blackbookEntries.set(entry.id, entry);
  saveBlackbookEntryToSupabase(entry).catch(() => {});
  res.json(entry);
});

// DELETE /api/blackbook/:id — dispatcher/admin only, a field responder shouldn't
// be able to erase a shared record they didn't create.
app.delete('/api/blackbook/:id', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (caller.role !== 'dispatcher' && caller.role !== 'admin' && caller.role !== 'superadmin') return res.status(403).json({ error: 'Dispatcher/admin only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (!canAccessOrg(caller, entry.organizationId)) return res.status(403).json({ error: 'Not authorized for this entry' });
  blackbookEntries.delete(entry.id);
  deleteBlackbookEntryFromSupabase(entry.id).catch(() => {});
  addAuditEntry('system', 'Blackbook: fiche supprimée', adminUsers.get(caller.id)?.name || caller.id, `${entry.firstName} ${entry.lastName}`.trim(), caller.id, entry.organizationId);
  res.json({ success: true });
});

// POST /api/blackbook/:id/sightings — log a new sighting (location/time/category/notes)
app.post('/api/blackbook/:id/sightings', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const { timestamp, category, location, residenceId, notes } = req.body;
  const callerUser = adminUsers.get(caller.id);
  let resolvedLocation = location || undefined;
  let residenceLabel: string | undefined, residenceOwnerId: string | undefined, residenceOwnerName: string | undefined;
  if (residenceId) {
    const ownerId = resolveAddressOwner(residenceId);
    const addr = ownerId ? (userAddresses.get(ownerId) || []).find(a => a.id === residenceId) : undefined;
    if (addr && ownerId) {
      residenceLabel = addr.label;
      residenceOwnerId = ownerId;
      residenceOwnerName = adminUsers.get(ownerId)?.name;
      resolvedLocation = { address: addr.address, latitude: addr.latitude, longitude: addr.longitude };
    }
  }
  const sighting: BlackbookSighting = {
    id: uuidv4(), timestamp: timestamp ? Number(timestamp) : Date.now(),
    category: category || 'autre', location: resolvedLocation,
    residenceId: residenceId || undefined, residenceLabel, residenceOwnerId, residenceOwnerName,
    notes: notes || undefined,
    reportedBy: caller.id, reportedByName: callerUser?.name || caller.id,
  };
  // Distinct residences this entry has been sighted at, BEFORE this new
  // sighting, so the correlation check below only fires when this specific
  // sighting is what crosses/extends the multi-residence threshold - not on
  // every single sighting logged once an entry is already flagged.
  const priorDistinctResidences = new Set(
    entry.sightings.filter(s => s.residenceOwnerId).map(s => s.residenceOwnerId)
  );

  entry.sightings.push(sighting);
  entry.updatedAt = Date.now();
  blackbookEntries.set(entry.id, entry);
  saveBlackbookEntryToSupabase(entry).catch(() => {});
  checkBlackbookCrossResidencePattern(entry, priorDistinctResidences);
  checkBlackbookTemporalPattern(entry);
  res.status(201).json(sighting);
});

// Proactive signal, not just a passive record: if this entry (a
// person/vehicle flagged in the Blackbook) has now been sighted at more than
// one DIFFERENT family's residence within a rolling window, that's a
// "casing multiple properties" pattern worth surfacing to dispatch right
// away rather than waiting for someone to notice it buried in the entry's
// own sighting history. Point 3 of the "think like Palantir" review -
// reactive-to-proactive, built on the residence linking already on
// BlackbookSighting.
const BLACKBOOK_CORRELATION_WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
function checkBlackbookCrossResidencePattern(entry: BlackbookEntry, priorDistinctResidences: Set<string | undefined>) {
  const now = Date.now();
  const distinctResidences = new Map<string, { ownerName: string; label: string }>();
  for (const s of entry.sightings) {
    if (!s.residenceOwnerId || (now - s.timestamp) > BLACKBOOK_CORRELATION_WINDOW_MS) continue;
    if (!distinctResidences.has(s.residenceOwnerId)) {
      distinctResidences.set(s.residenceOwnerId, { ownerName: s.residenceOwnerName || '', label: s.residenceLabel || '' });
    }
  }
  if (distinctResidences.size < 2 || distinctResidences.size <= priorDistinctResidences.size) return;

  const name = `${entry.firstName} ${entry.lastName}`;
  const residenceList = Array.from(distinctResidences.values()).map(r => `${r.ownerName} (${r.label})`).join(', ');
  const title = `⚠️ Pattern Blackbook détecté : ${name}`;
  const body = `Signalé(e) à ${distinctResidences.size} résidences différentes en 90 jours : ${residenceList}`;

  addAuditEntry('system', 'Blackbook - pattern multi-résidences', name, body, undefined, entry.organizationId);
  const payload = {
    type: 'blackbookPatternDetected',
    data: { entryId: entry.id, name, riskLevel: entry.riskLevel, residenceCount: distinctResidences.size, residences: Array.from(distinctResidences.values()), title, body },
  };
  broadcastToOrgRole(entry.organizationId, 'dispatcher', payload);
  broadcastToOrgRole(entry.organizationId, 'admin', payload);
  notifyStaffBlackbookPatternPush(title, body).catch(() => {});
  console.log(`[Blackbook] Cross-residence pattern detected for ${name}: ${distinctResidences.size} residences`);
}

async function notifyStaffBlackbookPatternPush(title: string, body: string) {
  const targetTokens: string[] = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === 'dispatcher' || entry.userRole === 'admin') targetTokens.push(token);
  }
  if (targetTokens.length === 0) return;
  const messages = targetTokens.map((token) => ({
    to: token, sound: 'default', title, body,
    data: { type: 'blackbook_pattern' },
    priority: 'high' as const, channelId: 'family-alerts',
  }));
  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip, deflate', 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!response.ok) console.error(`[Push] Expo API error for blackbook pattern: ${response.status}`);
  } catch (err) { console.error('[Push] Failed to send blackbook pattern push:', err); }
}

// Second proactive signal alongside the cross-residence one above: the same
// entity sighted repeatedly at a similar time of day/day of week suggests a
// deliberate routine (surveillance/casing), not coincidence. Buckets recent
// sightings by (weekday, N-hour-of-day) and fires once a bucket crosses a
// minimum-occurrence threshold — deterministic bucketing/counting, not ML.
const blackbookTemporalPatternsAlerted = new Set<string>(); // `${entryId}:${bucketKey}`, in-memory only — resets on restart, same category as other dedup state in this file
function checkBlackbookTemporalPattern(entry: BlackbookEntry) {
  const now = Date.now();
  const recent = entry.sightings.filter(s => now - s.timestamp <= BLACKBOOK_CORRELATION_WINDOW_MS);
  if (recent.length < BLACKBOOK_TEMPORAL_PATTERN_MIN_OCCURRENCES) return;

  const buckets = new Map<string, BlackbookSighting[]>();
  for (const s of recent) {
    const d = new Date(s.timestamp);
    const key = `${d.getDay()}:${Math.floor(d.getHours() / BLACKBOOK_TEMPORAL_BUCKET_HOURS)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(s); else buckets.set(key, [s]);
  }
  const top = Array.from(buckets.entries()).sort((a, b) => b[1].length - a[1].length)[0];
  if (!top || top[1].length < BLACKBOOK_TEMPORAL_PATTERN_MIN_OCCURRENCES) return;

  const [bucketKey, bucketSightings] = top;
  const dedupKey = `${entry.id}:${bucketKey}`;
  if (blackbookTemporalPatternsAlerted.has(dedupKey)) return;
  blackbookTemporalPatternsAlerted.add(dedupKey);

  const [weekdayStr, hourBucketStr] = bucketKey.split(':');
  const weekday = Number(weekdayStr), hourBucket = Number(hourBucketStr);
  const dayNames = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];
  const name = `${entry.firstName} ${entry.lastName}`;
  const title = `🕒 Pattern horaire détecté : ${name}`;
  const body = `${bucketSightings.length} signalements ${dayNames[weekday]} entre ${hourBucket * BLACKBOOK_TEMPORAL_BUCKET_HOURS}h et ${(hourBucket + 1) * BLACKBOOK_TEMPORAL_BUCKET_HOURS}h sur 90 jours.`;

  addAuditEntry('system', 'Blackbook - pattern horaire', name, body, undefined, entry.organizationId);
  const payload = {
    type: 'blackbookTemporalPatternDetected',
    data: { entryId: entry.id, name, riskLevel: entry.riskLevel, weekday, hourBucket, occurrences: bucketSightings.length, title, body },
  };
  broadcastToOrgRole(entry.organizationId, 'dispatcher', payload);
  broadcastToOrgRole(entry.organizationId, 'admin', payload);
  notifyStaffBlackbookPatternPush(title, body).catch(() => {});
}

// DELETE /api/blackbook/:id/sightings/:sightingId
app.delete('/api/blackbook/:id/sightings/:sightingId', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const idx = entry.sightings.findIndex(s => s.id === (req.params.sightingId as string));
  if (idx === -1) return res.status(404).json({ error: 'Sighting not found' });
  entry.sightings.splice(idx, 1);
  entry.updatedAt = Date.now();
  blackbookEntries.set(entry.id, entry);
  saveBlackbookEntryToSupabase(entry).catch(() => {});
  res.json({ success: true });
});

// ─── Vehicle/plate recognition (ANPR) on Blackbook photo upload ────────
// Plate Recognizer (platerecognizer.com) — a dedicated ANPR SaaS, not
// generic OCR retrofitted for plates, chosen for accuracy on angled/
// partial plates over hand-rolled Cloud Vision text-detection heuristics.
// Never auto-writes to a Blackbook entry — always a suggestion the
// operator must explicitly confirm client-side (sensitive dossier data).
type PlateRecognitionResult =
  | { ok: true; plate: string; confidence: number; vehicle?: { make?: string; color?: string } }
  | { ok: false; reason: string };

async function recognizePlateFromFile(filePath: string): Promise<PlateRecognitionResult> {
  const token = process.env.PLATERECOGNIZER_API_TOKEN;
  if (!token) { console.warn('[ANPR] PLATERECOGNIZER_API_TOKEN not set'); return { ok: false, reason: 'Reconnaissance de plaque non configurée sur le serveur' }; }
  try {
    // Resize/recompress before sending — plate OCR doesn't need full
    // resolution, and a modern phone photo can comfortably exceed Plate
    // Recognizer's own upload size limit even though it's well within
    // ours (confirmed via a live 413 from their API on an unresized
    // upload). Falls back to the original bytes if sharp itself fails for
    // any reason, rather than skipping recognition entirely.
    let uploadBuffer: Buffer;
    try {
      uploadBuffer = await sharp(filePath)
        // Bakes the EXIF orientation tag into the actual pixel data before
        // re-encoding — .jpeg().toBuffer() strips metadata by default, so
        // without this a photo whose orientation depends on that tag (very
        // common straight out of a phone camera) would be sent to Plate
        // Recognizer sideways/upside-down with no way for it to know, even
        // though it displays correctly everywhere else that does respect
        // EXIF. Suspected cause of a very legible plate coming back as "no
        // plate detected".
        .rotate()
        .resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (resizeErr) {
      console.warn('[ANPR] Resize failed, sending original file:', resizeErr);
      uploadBuffer = fs.readFileSync(filePath);
    }
    const form = new FormData();
    form.append('upload', new Blob([new Uint8Array(uploadBuffer)]));
    const resp = await fetch('https://api.platerecognizer.com/v1/plate-reader/', {
      method: 'POST',
      headers: { Authorization: `Token ${token}` },
      body: form as any,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('[ANPR] Plate Recognizer error:', resp.status, body);
      return { ok: false, reason: `Service ANPR indisponible (${resp.status})` };
    }
    const data = await resp.json() as any;
    const best = data.results?.[0];
    if (!best) return { ok: false, reason: 'Aucune plaque détectée sur la photo' };
    return {
      ok: true,
      plate: String(best.plate || '').toUpperCase(),
      confidence: typeof best.score === 'number' ? best.score : 0,
      vehicle: { make: best.vehicle?.type, color: best.color?.[0]?.name },
    };
  } catch (e) {
    console.error('[ANPR] recognizePlateFromFile error:', e);
    return { ok: false, reason: `Erreur réseau : ${e instanceof Error ? e.message : String(e)}` };
  }
}

function findEntriesWithPlate(plate: string, organizationId?: string, excludeEntryId?: string): { entryId: string; name: string }[] {
  const normalized = plate.trim().toUpperCase();
  const matches: { entryId: string; name: string }[] = [];
  for (const other of blackbookEntries.values()) {
    if (other.id === excludeEntryId || other.organizationId !== organizationId) continue;
    if (other.vehicles.some(v => (v.plate || '').trim().toUpperCase() === normalized)) {
      matches.push({ entryId: other.id, name: `${other.firstName} ${other.lastName}`.trim() });
    }
  }
  return matches;
}

// POST /api/blackbook/:id/photos — multipart upload, up to 6 photos per call
app.post('/api/blackbook/:id/photos', requireAuth, upload.array('photos', 6), async (req: any, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (!canAccessOrg(caller, entry.organizationId)) return res.status(403).json({ error: 'Not authorized for this entry' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });
  const newUrls: string[] = await Promise.all(req.files.map((f: any) => uploadFileToSupabaseStorage(f)));
  entry.photos.push(...newUrls);
  entry.updatedAt = Date.now();
  blackbookEntries.set(entry.id, entry);
  saveBlackbookEntryToSupabase(entry).catch(() => {});

  // Opportunistic ANPR on the first uploaded file only — most Blackbook
  // photos are of a person, not a vehicle, so this isn't guaranteed to
  // find anything. The photo itself is already saved above, so wrap this
  // whole block defensively — a bonus suggestion must never be able to
  // break the response for an upload that already succeeded.
  let plateSuggestion: (PlateRecognitionResult & { matchingEntries?: { entryId: string; name: string }[] }) | undefined;
  try {
    const firstFile = req.files[0];
    if (firstFile?.path) {
      const result = await recognizePlateFromFile(firstFile.path);
      plateSuggestion = result.ok
        ? { ...result, matchingEntries: findEntriesWithPlate(result.plate, entry.organizationId, entry.id) }
        : result;
    }
  } catch (e) {
    console.error('[ANPR] plate suggestion block error (upload itself already succeeded):', e);
    logHealthError('ANPR exception', e);
  }

  res.json({ photos: entry.photos, plateSuggestion });
});

// DELETE /api/blackbook/:id/photos — body: { url }
app.delete('/api/blackbook/:id/photos', requireAuth, async (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (!canAccessOrg(caller, entry.organizationId)) return res.status(403).json({ error: 'Not authorized for this entry' });
  const { url } = req.body;
  entry.photos = entry.photos.filter(p => p !== url);
  entry.updatedAt = Date.now();
  blackbookEntries.set(entry.id, entry);
  saveBlackbookEntryToSupabase(entry).catch(() => {});
  res.json({ photos: entry.photos });
});

// GET /api/blackbook/:id/pdf — full dossier: identity, description, vehicles,
// notes, photos, and the complete sighting history.
app.get('/api/blackbook/:id/pdf', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  const entry = blackbookEntries.get(req.params.id as string);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });

  const PDFDocument = require('pdfkit');
  const fileName = `blackbook-${(entry.lastName || 'sans-nom').replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  const doc = new PDFDocument({ margin: 50 });
  doc.pipe(res);

  const RISK_LABELS: Record<string, string> = { low: 'Faible', medium: 'Moyen', high: 'Élevé', critical: 'Critique' };
  const STATUS_LABELS: Record<string, string> = { active: 'Surveillance active', resolved: 'Résolu', archived: 'Archivé' };

  doc.fontSize(20).font('Helvetica-Bold').text(`${entry.firstName} ${entry.lastName}`.trim() || 'Sans nom');
  if (entry.aliases.length > 0) doc.fontSize(11).font('Helvetica-Oblique').text(`Alias : ${entry.aliases.join(', ')}`);
  doc.moveDown(0.5);
  doc.fontSize(12).font('Helvetica');
  if (entry.dateOfBirth) doc.text(`Date de naissance : ${entry.dateOfBirth}`);
  doc.text(`Niveau de risque : ${RISK_LABELS[entry.riskLevel] || entry.riskLevel}`);
  doc.text(`Statut : ${STATUS_LABELS[entry.status] || entry.status}`);
  if (entry.linkedUserId) doc.font('Helvetica-Bold').text(`Associé à : ${adminUsers.get(entry.linkedUserId)?.name || entry.linkedUserId}`).font('Helvetica');
  if (entry.tags.length > 0) doc.text(`Tags : ${entry.tags.join(', ')}`);
  doc.text(`Créé par ${entry.createdByName} le ${new Date(entry.createdAt).toLocaleDateString('fr-FR')}`);

  if (entry.physicalDescription) {
    doc.moveDown(0.5).font('Helvetica-Bold').text('Description physique');
    doc.font('Helvetica').text(entry.physicalDescription);
  }
  if (entry.vehicles.length > 0) {
    doc.moveDown(0.5).font('Helvetica-Bold').text('Véhicule(s)');
    doc.font('Helvetica');
    entry.vehicles.forEach(v => doc.text(`- ${[v.plate, v.description].filter(Boolean).join(' — ')}`));
  }
  if (entry.notes) {
    doc.moveDown(0.5).font('Helvetica-Bold').text('Notes');
    doc.font('Helvetica').text(entry.notes);
  }

  doc.moveDown(1).font('Helvetica-Bold').fontSize(14).text('Historique des signalements');
  doc.fontSize(11);
  const sortedSightings = [...entry.sightings].sort((a, b) => b.timestamp - a.timestamp);
  if (sortedSightings.length === 0) {
    doc.font('Helvetica').text('Aucun signalement enregistré.');
  } else {
    sortedSightings.forEach(s => {
      doc.moveDown(0.4);
      doc.font('Helvetica-Bold').text(`${new Date(s.timestamp).toLocaleString('fr-FR')} — ${BLACKBOOK_CATEGORY_LABELS[s.category] || s.category}`);
      doc.font('Helvetica');
      if (s.residenceId) {
        doc.font('Helvetica-Bold').text(`🏠 Résidence : ${s.residenceLabel || ''} — Famille : ${s.residenceOwnerName || ''}`).font('Helvetica');
        if (s.location?.address) doc.text(s.location.address);
      } else if (s.location?.address) {
        doc.text(`Lieu : ${s.location.address}`);
      }
      if (s.notes) doc.text(s.notes);
      doc.fontSize(9).font('Helvetica-Oblique').text(`Signalé par ${s.reportedByName}`);
      doc.fontSize(11);
    });
  }

  for (const photoUrl of entry.photos) {
    try {
      const photoPath = path.join(PROJECT_ROOT, photoUrl.replace(/^\//, ''));
      if (fs.existsSync(photoPath)) {
        doc.addPage();
        doc.image(photoPath, { fit: [480, 650], align: 'center', valign: 'center' });
      }
    } catch (e) { /* skip unreadable photo, don't fail the whole export */ }
  }

  doc.end();
});

// ─── User Addresses REST API ──────────────────────────────────────────────

// GET /api/users/:id/addresses — previously had NO auth check at all, meaning
// anyone could read any user's registered addresses. Allowed for: the user
// themselves, a family member (getFamilyMemberIds), or staff who can access
// this family (canAccessFamily).
app.get('/api/users/:id/addresses', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  const targetId = req.params.id as string;
  const isSelf = caller.id === targetId;
  const isFamilyMember = getFamilyMemberIds(targetId).includes(caller.id);
  const isStaff = caller.role === 'dispatcher' || caller.role === 'responder' || caller.role === 'admin';
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  if (!isSelf && !isFamilyMember && !(isStaff && canAccessUser(callerAccess, targetId))) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const addresses = userAddresses.get(targetId) || [];
  res.json(addresses);
});

function computeAllResidences(caller?: { id: string; role: string; organizationId?: string; assignedFamilyIds?: string[] }): { id: string; userId: string; latitude: number; longitude: number; label: string; address: string; userName: string }[] {
  const now = Date.now();
  const result: { id: string; userId: string; latitude: number; longitude: number; label: string; address: string; userName: string }[] = [];
  for (const [userId, addresses] of userAddresses) {
    // Skip residences left behind by a deleted account (orphaned userId no
    // longer in adminUsers) - surfacing the raw id as a fake "name" is
    // confusing (found via the same-address bug for Eytan Boon), and a
    // deleted account's old address isn't useful data anyway.
    const owner = adminUsers.get(userId);
    if (!owner) continue;
    if (caller && !canAccessUser(caller, userId)) continue;
    const userName = owner.name;
    for (const a of addresses) {
      if (a.latitude == null || a.longitude == null) continue;
      if (a.temporary && a.expiresAt && a.expiresAt <= now) continue;
      result.push({ id: a.id, userId, latitude: a.latitude, longitude: a.longitude, label: a.label, address: a.address, userName });
    }
  }
  return result;
}

// Per-member detail for a single (already-deduplicated) residence — used by
// the map's house-pin popup (app + dispatch). `memberIds` is the union of
// every owner clustered into this residence plus their family, not derived
// from a single ownerId (see computeResidenceSummaries below for why).
// Two independent masking axes apply here, same as elsewhere this session:
// shareLocationWithFamily gates the family-facing view
// (GET /api/family/residences), ghostMode (+ isRevealedForActiveIncident)
// gates the dispatch-facing view (GET /dispatch/residences-detailed) — they
// never influence each other.
function computeResidenceMembersFor(memberIds: string[], primaryOwnerId: string, addr: UserAddress, forDispatch: boolean) {
  return memberIds.map(memberId => {
    const adminUser = adminUsers.get(memberId);
    const runtimeUser = users.get(memberId);
    const relationship = memberId === primaryOwnerId
      ? 'self'
      : (adminUsers.get(primaryOwnerId)?.relationships?.find(r => r.userId === memberId)?.type
        || adminUser?.relationships?.find(r => r.userId === primaryOwnerId)?.type
        || 'family');
    const visible = forDispatch
      ? !(adminUser?.ghostMode && !isRevealedForActiveIncident(memberId))
      : sharesLocationWithFamily(adminUser);
    // Reuse the same presence computation as the rest of the app (Famille
    // tab, dispatch map) instead of a fresh distance check against only the
    // live `users` location — that map is never persisted and has no
    // fallback, so a momentary gap (a missed background ping, a server
    // restart) showed "Sorti" here even when computeEffectivePresence's own
    // fallback to the last confirmed state got it right everywhere else.
    const presence = visible ? computeEffectivePresence(memberId, forDispatch) : null;
    const isPresent = !!presence && presence.status === 'inside' && presence.matchedLabel === addr.label;
    return {
      userId: memberId,
      name: adminUser?.name || memberId,
      relationship,
      photoUrl: adminUser?.photoUrl || null,
      isPresent,
      lastSeen: visible ? (runtimeUser?.lastSeen || null) : null,
    };
  });
}

// Address management is per-individual (each family member keeps their own
// copy of "Résidence principale", "Megève", etc. in userAddresses), so the
// same physical residence shows up once per family member who registered
// it — same label, near-identical coordinates (small rounding differences
// between whoever geocoded it). Cluster entries within RESIDENCE_MERGE_METERS
// of each other into a single pin instead of showing duplicates for the
// same house.
const RESIDENCE_MERGE_METERS = 150;

// Shared clustering step — kept separate from computeResidenceSummaries so the
// rename endpoint below can locate every underlying address row (across every
// owner) that a given pin represents, not just the merged/display view of it.
// `entries` hold direct references into the userAddresses arrays, so mutating
// `entry.addr` here is visible everywhere else that reads userAddresses.
function clusterResidenceAddresses(ownerIds: string[]): Array<{ entries: Array<{ ownerId: string; addr: UserAddress }>; addr: UserAddress }> {
  const now = Date.now();
  const raw: Array<{ ownerId: string; addr: UserAddress }> = [];
  for (const ownerId of ownerIds) {
    if (!adminUsers.get(ownerId)) continue;
    for (const a of (userAddresses.get(ownerId) || [])) {
      if (a.latitude == null || a.longitude == null) continue;
      if (a.temporary && a.expiresAt && a.expiresAt <= now) continue;
      raw.push({ ownerId, addr: a });
    }
  }

  // Group into clusters first, keyed only by proximity — the representative
  // address (whose id/label/coordinates the cluster displays) is picked
  // afterward, deterministically, rather than "whichever raw entry happened
  // to be seen first". Supabase's `select('*')` has no ORDER BY, so without
  // this, the representative — and therefore the pin's public id — could
  // silently change across a server restart, breaking any id a client had
  // already fetched (this is what broke the rename feature).
  const clusters: Array<{ entries: Array<{ ownerId: string; addr: UserAddress }>; addr: UserAddress }> = [];
  for (const entry of raw) {
    const existing = clusters.find(c =>
      haversineDistance(c.addr.latitude!, c.addr.longitude!, entry.addr.latitude!, entry.addr.longitude!) <= RESIDENCE_MERGE_METERS
    );
    if (existing) existing.entries.push(entry);
    else clusters.push({ entries: [entry], addr: entry.addr });
  }

  for (const cluster of clusters) {
    const sorted = cluster.entries.slice().sort((a, b) => a.addr.id.localeCompare(b.addr.id));
    const representative = sorted[0].addr;
    const bestOccupancy = cluster.entries.map(e => e.addr.occupancyStatus).find(Boolean) || null;
    const bestRadius = Math.max(0, ...cluster.entries.map(e => e.addr.radiusMeters || 0)) || undefined;
    cluster.addr = { ...representative, occupancyStatus: bestOccupancy || representative.occupancyStatus, radiusMeters: bestRadius || representative.radiusMeters };
  }
  return clusters;
}

function computeResidenceSummaries(ownerIds: string[], forDispatch: boolean) {
  return clusterResidenceAddresses(ownerIds).map(cluster => {
    const clusterOwnerIds = Array.from(new Set(cluster.entries.map(e => e.ownerId)));
    const memberIds = new Set<string>();
    for (const ownerId of clusterOwnerIds) {
      memberIds.add(ownerId);
      for (const fid of getFamilyMemberIds(ownerId)) memberIds.add(fid);
    }
    const a = cluster.addr;
    // primaryOwnerId MUST be whoever actually owns the representative address
    // (a.id), not independently "whichever owner id sorts first" — those two
    // can point to different people once a cluster spans unrelated accounts
    // (e.g. test/demo profiles that happen to share the same coordinates),
    // and the rename endpoint relies on ownerId's family to re-locate a.id.
    const primaryOwnerId = cluster.entries.find(e => e.addr.id === a.id)?.ownerId || clusterOwnerIds[0];
    const members = computeResidenceMembersFor(Array.from(memberIds), primaryOwnerId, a, forDispatch);
    // Occupancy is derived live from whether anyone tracked is actually there,
    // not the address's stored occupancyStatus field — that field is a
    // separate manual flag (set via the place-management form) and was
    // showing "Occupée" while every member read "Sorti", which read as
    // contradictory/wrong on this card. The stored field itself is untouched
    // (still used for the residence/place management UI and incident context).
    const occupancyStatus: 'occupied' | 'unoccupied' = members.some(m => m.isPresent) ? 'occupied' : 'unoccupied';
    return {
      id: a.id, ownerId: primaryOwnerId, ownerName: adminUsers.get(primaryOwnerId)?.name || primaryOwnerId,
      label: a.label, address: a.address,
      latitude: a.latitude!, longitude: a.longitude!, radiusMeters: a.radiusMeters || 150,
      occupancyStatus,
      members,
    };
  });
}

// PATCH /api/family/residences/:id/label - rename a residence pin. The same
// physical address is duplicated across every family member's own address
// list (see clusterResidenceAddresses above), so this updates the label on
// every underlying copy — otherwise the pin would read differently depending
// on whose account happened to be picked as the cluster's representative.
// Self, family members, and dispatch/admin staff (who already edit these
// labels through the residence/place management UI) may rename.
app.patch('/api/family/residences/:id/label', requireAuth, async (req, res) => {
  const { userId, label } = req.body;
  if (!userId || !label || !String(label).trim()) return res.status(400).json({ error: 'userId and label required' });
  const caller = req.supabaseUser!;
  const isSelf = caller.id === userId;
  const isFamilyMember = getFamilyMemberIds(userId).includes(caller.id);
  const isDispatchStaff = (caller.role === 'dispatcher' || caller.role === 'admin') && canAccessOrg(caller, adminUsers.get(userId)?.organizationId);
  if (!isSelf && !isFamilyMember && !isDispatchStaff) return res.status(403).json({ error: 'Not authorized' });

  const ownerIds = Array.from(new Set([userId, ...getFamilyMemberIds(userId)]));
  const cluster = clusterResidenceAddresses(ownerIds).find(c => c.addr.id === req.params.id);
  if (!cluster) return res.status(404).json({ error: 'Residence not found' });

  const trimmed = String(label).trim();
  const now = Date.now();
  for (const { addr } of cluster.entries) {
    addr.label = trimmed;
    addr.updatedAt = now;
    const { error } = await supabaseAdmin.from('user_addresses').update({ label: trimmed, updated_at: now }).eq('id', addr.id);
    if (error) console.error('[Supabase] Failed to persist residence label rename:', error.message);
  }
  res.json({ success: true, label: trimmed, updatedCount: cluster.entries.length });
});

// GET /api/family/residences?userId= - residences for the caller's own family
// group (self + every family member's own address entries), with per-member
// presence AT THAT ADDRESS — the house-pin detail view on the app's map tab.
app.get('/api/family/residences', requireAuth, (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const caller = req.supabaseUser!;
  const isSelf = caller.id === userId;
  const isFamilyMember = getFamilyMemberIds(userId).includes(caller.id);
  if (!isSelf && !isFamilyMember) return res.status(403).json({ error: 'Not authorized' });
  const ownerIds = Array.from(new Set([userId, ...getFamilyMemberIds(userId)]));
  res.json(computeResidenceSummaries(ownerIds, false));
});

// GET /dispatch/residences-detailed - every residence across every family
// unit the caller can access, with composition + dispatch-facing presence —
// the house-pin detail view on the dispatch console's map tab.
app.get('/dispatch/residences-detailed', (req, res) => {
  const caller = req.supabaseUser!;
  const callerAccess = { id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds };
  const ownerIds = Array.from(userAddresses.keys()).filter(ownerId => canAccessUser(callerAccess, ownerId));
  res.json(computeResidenceSummaries(ownerIds, true));
});

// GET /api/all-residences — same data as /dispatch/all-residences, but reachable
// by responders too (the /dispatch prefix requires dispatcher+, which blocks them) —
// needed for the Blackbook sighting residence picker on mobile.
app.get('/api/all-residences', requireAuth, (req, res) => {
  const caller = req.supabaseUser!;
  if (!isBlackbookStaff(caller.role)) return res.status(403).json({ error: 'Staff only' });
  res.json(computeAllResidences({ id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds }));
});

// GET /dispatch/all-residences — every geocoded address across every user
// profile (not scoped to family units), used by the map's "Tout" zoom-out
// to fit the view to wherever people's registered places actually are,
// instead of a hardcoded city.
app.get('/dispatch/all-residences', (req, res) => {
  const caller = req.supabaseUser!;
  res.json(computeAllResidences({ id: caller.id, role: caller.role, organizationId: caller.organizationId, assignedFamilyIds: adminUsers.get(caller.id)?.assignedFamilyIds }));
});

// POST /api/users/:id/addresses
app.post('/api/users/:id/addresses', requireAuth, async (req, res) => {
  const { label, address, latitude, longitude, placeId, isPrimary, alarmCode, notes, radiusMeters, temporary, expiresAt } = req.body;
  if (!label || !address) return res.status(400).json({ error: 'label and address are required' });
  const userId = req.params.id as string;
  if (!canEditAddressAssets(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const now = Date.now();

  // Géocoder si pas de coordonnées fournies
  let lat = latitude || null;
  let lng = longitude || null;
  if (!lat || !lng) {
    const coords = await geocodeAddress(address);
    if (coords) { lat = coords.latitude; lng = coords.longitude; }
    else console.warn('[Addresses] Could not geocode: ' + address);
  }

  const newAddr: UserAddress = {
    id: require('crypto').randomUUID(),
    userId, label, address,
    latitude: lat,
    longitude: lng,
    placeId: placeId || null,
    isPrimary: isPrimary || false,
    alarmCode: alarmCode || null,
    notes: notes || null,
    radiusMeters: radiusMeters ? Number(radiusMeters) : undefined,
    temporary: temporary || false,
    expiresAt: expiresAt ? Number(expiresAt) : undefined,
    createdAt: now, updatedAt: now,
  };
  // If primary, unset other primary addresses
  if (isPrimary) {
    const existing = userAddresses.get(userId) || [];
    existing.forEach(a => { if (a.isPrimary) a.isPrimary = false; });
  }
  if (!userAddresses.has(userId)) userAddresses.set(userId, []);
  userAddresses.get(userId)!.push(newAddr);
  // Save to Supabase — this is the ONLY persistence for addresses (no JSON fallback),
  // so a failed insert here means the address silently vanishes on the next restart.
  const { error: insertAddrError } = await supabaseAdmin.from('user_addresses').insert({
    id: newAddr.id, user_id: userId, label, address,
    latitude: newAddr.latitude, longitude: newAddr.longitude,
    place_id: newAddr.placeId, is_primary: newAddr.isPrimary,
    alarm_code: newAddr.alarmCode, notes: newAddr.notes,
    radius_meters: newAddr.radiusMeters || null,
    temporary: newAddr.temporary || false,
    expires_at: newAddr.expiresAt || null,
    created_at: now, updated_at: now,
  });
  if (insertAddrError) console.error('[Supabase] Failed to persist new address (will be lost on restart):', insertAddrError.message);
  res.status(201).json(newAddr);
});

// PUT /api/users/:id/addresses/:addressId
app.put('/api/users/:id/addresses/:addressId', requireAuth, async (req, res) => {
  const { label, address, latitude, longitude, placeId, isPrimary, alarmCode, notes, radiusMeters, temporary, expiresAt, occupancyStatus } = req.body;
  const userId = req.params.id as string;
  if (!canEditAddressAssets(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const addresses = userAddresses.get(userId) || [];
  const idx = addresses.findIndex(a => a.id === req.params.addressId);
  if (idx === -1) return res.status(404).json({ error: 'Address not found' });
  if (isPrimary) addresses.forEach(a => { a.isPrimary = false; });

  // Géocoder si l'adresse a changé et pas de nouvelles coords fournies
  let finalLat = latitude ?? addresses[idx].latitude;
  let finalLng = longitude ?? addresses[idx].longitude;
  const addressChanged = address && address !== addresses[idx].address;
  if (addressChanged && !latitude && !longitude) {
    const coords = await geocodeAddress(address ?? addresses[idx].address);
    if (coords) { finalLat = coords.latitude; finalLng = coords.longitude; }
  }

  const updated = { ...addresses[idx], label: label ?? addresses[idx].label,
    address: address ?? addresses[idx].address, latitude: finalLat,
    longitude: finalLng, isPrimary: isPrimary ?? addresses[idx].isPrimary,
    alarmCode: alarmCode ?? addresses[idx].alarmCode, notes: notes ?? addresses[idx].notes,
    radiusMeters: radiusMeters != null ? Number(radiusMeters) : addresses[idx].radiusMeters,
    temporary: temporary != null ? Boolean(temporary) : addresses[idx].temporary,
    expiresAt: expiresAt != null ? Number(expiresAt) : addresses[idx].expiresAt,
    occupancyStatus: occupancyStatus !== undefined ? occupancyStatus : addresses[idx].occupancyStatus,
    updatedAt: Date.now() };
  addresses[idx] = updated;
  const { error: updateAddrError } = await supabaseAdmin.from('user_addresses').update({
    label: updated.label, address: updated.address, latitude: updated.latitude,
    longitude: updated.longitude, is_primary: updated.isPrimary,
    alarm_code: updated.alarmCode, notes: updated.notes, radius_meters: updated.radiusMeters || null,
    temporary: updated.temporary || false, expires_at: updated.expiresAt || null,
    occupancy_status: updated.occupancyStatus || null,
    updated_at: updated.updatedAt,
  }).eq('id', updated.id);
  if (updateAddrError) console.error('[Supabase] Failed to persist address update (will revert on restart):', updateAddrError.message);
  res.json(updated);
});

// PATCH /api/users/:id/addresses/:addressId/occupancy — lightweight toggle so the
// app (which has no full address-edit UI) can flip this without going through PUT.
app.patch('/api/users/:id/addresses/:addressId/occupancy', requireAuth, async (req, res) => {
  const userId = req.params.id as string;
  const addresses = userAddresses.get(userId) || [];
  const idx = addresses.findIndex(a => a.id === req.params.addressId);
  if (idx === -1) return res.status(404).json({ error: 'Address not found' });
  if (!canEditAddressAssets(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const { occupancyStatus } = req.body;
  if (occupancyStatus !== 'occupied' && occupancyStatus !== 'unoccupied') {
    return res.status(400).json({ error: "occupancyStatus must be 'occupied' or 'unoccupied'" });
  }
  const updated = { ...addresses[idx], occupancyStatus, updatedAt: Date.now() };
  addresses[idx] = updated;
  const { error } = await supabaseAdmin.from('user_addresses')
    .update({ occupancy_status: updated.occupancyStatus, updated_at: updated.updatedAt })
    .eq('id', updated.id);
  if (error) console.error('[Supabase] Failed to persist occupancy status:', error.message);
  res.json(updated);
});

// DELETE /api/users/:id/addresses/:addressId
app.delete('/api/users/:id/addresses/:addressId', requireAuth, async (req, res) => {
  const userId = req.params.id as string;
  if (!canEditAddressAssets(userId, req.supabaseUser!)) return res.status(403).json({ error: 'Not authorized' });
  const addresses = userAddresses.get(userId) || [];
  const idx = addresses.findIndex(a => a.id === req.params.addressId);
  if (idx === -1) return res.status(404).json({ error: 'Address not found' });
  addresses.splice(idx, 1);
  const { error: deleteAddrError } = await supabaseAdmin.from('user_addresses').delete().eq('id', req.params.addressId);
  if (deleteAddrError) console.error('[Supabase] Failed to persist address deletion:', deleteAddrError.message);
  res.json({ success: true });
});


// POST /api/admin/geocode-addresses — géocode rétroactivement toutes les adresses sans coords
app.post('/api/admin/geocode-addresses', requireAuth, requireRole('admin'), async (req, res) => {
  let processed = 0, updated = 0, failed = 0;
  for (const [userId, addrs] of userAddresses) {
    for (const addr of addrs) {
      if (addr.latitude && addr.longitude) continue;
      processed++;
      const coords = await geocodeAddress(addr.address);
      if (!coords) { failed++; console.warn('[BatchGeocode] Failed: ' + addr.address); continue; }
      addr.latitude = coords.latitude;
      addr.longitude = coords.longitude;
      addr.updatedAt = Date.now();
      await supabaseAdmin.from('user_addresses').update({
        latitude: coords.latitude,
        longitude: coords.longitude,
        updated_at: addr.updatedAt,
      }).eq('id', addr.id);
      updated++;
      await new Promise(r => setTimeout(r, 150));
    }
  }
  res.json({ processed, updated, failed });
});

// GET /api/alerts/:id/context - get full client context for an alert
app.get('/api/alerts/:id/context', requireAuth, async (req, res) => {
  const alert = alerts.get(req.params.id as string);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (!canAccessOrg(req.supabaseUser!, alert.organizationId)) return res.status(403).json({ error: 'Not authorized' });

  // Find the user who triggered the alert
  const createdBy = alert.createdBy;
  // Try by UUID first, then fallback to name match
  let user = adminUsers.get(createdBy);
  let resolvedUserId = createdBy;
  if (!user) {
    for (const [uid, u] of adminUsers) {
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.name || '';
      if (fullName === createdBy || u.name === createdBy || u.email === createdBy) {
        user = u; resolvedUserId = uid; break;
      }
    }
  }
  if (!user) return res.json({ alert, user: null, addresses: [], family: [], locationContext: null, residenceContext: null });

  // Get user addresses
  const addresses = userAddresses.get(resolvedUserId) || [];

  // Detect proximity to known addresses
  let locationContext = null;
  let matchedAddress: UserAddress | null = null;
  if (alert.location?.latitude && alert.location?.longitude && addresses.length > 0) {
    let closest: UserAddress | null = null;
    let minDist = Infinity;
    for (const addr of addresses) {
      if (!addr.latitude || !addr.longitude) continue;
      const dist = haversineDistance(alert.location.latitude, alert.location.longitude, addr.latitude, addr.longitude);
      if (dist < minDist) { minDist = dist; closest = addr; }
    }
    if (closest && minDist < 500) {
      matchedAddress = closest;
      locationContext = {
        type: 'known_address',
        label: closest.label,
        address: closest.address,
        distanceMeters: Math.round(minDist),
        alarmCode: closest.alarmCode,
        isHomeJacking: minDist < 100,
      };
    }
  }

  // Known providers/visitors at the matched residence, and who's expected there
  // today — so staff on scene can recognize an expected vehicle/person.
  let residenceContext: { addressId: string; knownPeople: KnownPerson[]; todayInterventions: PlannedIntervention[]; occupancyStatus?: 'occupied' | 'unoccupied' } | null = null;
  if (matchedAddress) {
    const now = new Date();
    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date(now); todayEnd.setHours(23, 59, 59, 999);
    const todayInterventions = (plannedInterventions.get(matchedAddress.id) || []).filter(iv => {
      if (iv.status === 'cancelled') return false;
      if (iv.recurrence?.frequency === 'weekly') return iv.recurrence.daysOfWeek.includes(now.getDay());
      return iv.scheduledStart >= todayStart.getTime() && iv.scheduledStart <= todayEnd.getTime();
    });
    residenceContext = {
      addressId: matchedAddress.id,
      knownPeople: knownPeople.get(matchedAddress.id) || [],
      todayInterventions,
      occupancyStatus: matchedAddress.occupancyStatus,
    };
  }

  // Get family members
  const family = (user.relationships || []).map(rel => {
    // Try direct lookup first, then scan all users for matching id
    let member = adminUsers.get(rel.userId);
    if (!member) {
      for (const [, u] of adminUsers) {
        if (u.id === rel.userId) { member = u; break; }
      }
    }
    if (!member) return null;
    return {
      id: member.id, name: member.name, role: rel.type, phone: member.phoneMobile, photoUrl: member.photoUrl,
      presence: computeEffectivePresence(member.id, true),
    };
  }).filter(Boolean);

  // The reporter's own current presence — separate from where the incident
  // was reported FROM, since they may have moved since. Same Ghost-mode rule
  // as everywhere else: automatic unless Ghost with no manual override.
  const reporterPresence = computeEffectivePresence(resolvedUserId, true);

  const { passwordHash, ...safeUser } = user;
  res.json({ user: { ...safeUser, hasPassword: !!user.passwordHash }, addresses, family, locationContext, reporterPresence, residenceContext });
});
// livekit-server-sdk installed
