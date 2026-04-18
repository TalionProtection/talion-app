import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';
import path from 'path';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import fs from 'fs';
import { requireAuth, requireRole } from './auth-middleware';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

// ─── Supabase Admin Client (singleton) ───────────────────────────────────
const supabaseAdmin = createSupabaseClient(
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

// ─── Resolve project root (works from server/ in dev and dist/ in prod) ───
const PROJECT_ROOT = path.resolve(__dirname, '..');

// ─── JSON File Persistence Layer ─────────────────────────────────────────
const dataDir = path.join(PROJECT_ROOT, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const ALERTS_FILE = path.join(dataDir, 'alerts.json');
const LOCATION_HISTORY_FILE = path.join(dataDir, 'location-history.json');
const FAMILY_PERIMETERS_FILE = path.join(dataDir, 'family-perimeters.json');
const PROXIMITY_ALERTS_FILE = path.join(dataDir, 'proximity-alerts.json');
const PATROL_REPORTS_FILE = path.join(dataDir, 'patrol-reports.json');
const PTT_CHANNELS_FILE = path.join(dataDir, 'ptt-channels.json');
const PTT_MESSAGES_FILE = path.join(dataDir, 'ptt-messages.json');

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

// ─── Acceptance Timer System (5-minute timeout) ────────────────────────
const ACCEPTANCE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const acceptanceTimers = new Map<string, ReturnType<typeof setTimeout>>(); // key: `alertId:responderId`

function startAcceptanceTimer(alertId: string, responderId: string) {
  const timerKey = `${alertId}:${responderId}`;
  // Clear any existing timer for this assignment
  const existing = acceptanceTimers.get(timerKey);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    acceptanceTimers.delete(timerKey);
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
    addAuditEntry('incident', 'Acceptance Timeout', 'System', `${responderName} n'a pas accepté l'incident ${alertId} dans les 5 minutes`, responderId);
    // Send push notification to all dispatchers
    const TYPE_LABELS: Record<string, string> = {
      sos: 'SOS', medical: 'Médical', fire: 'Incendie', security: 'Sécurité',
      accident: 'Accident', broadcast: 'Broadcast', other: 'Autre',
      home_jacking: 'Home-Jacking', cambriolage: 'Cambriolage',
      animal_perdu: 'Animal perdu', evenement_climatique: 'Événement climatique',
      rodage: 'Rodage', vehicule_suspect: 'Véhicule suspect', fugue: 'Fugue',
      route_bloquee: 'Route bloquée', route_fermee: 'Route fermée',
    };
    const typeLabel = TYPE_LABELS[alert.type] || alert.type;
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
    broadcastMessage({
      type: 'acceptanceTimeout',
      alertId,
      responderId,
      responderName,
      timestamp: Date.now(),
    });
  }, ACCEPTANCE_TIMEOUT_MS);

  acceptanceTimers.set(timerKey, timer);
}

function clearAcceptanceTimer(alertId: string, responderId: string) {
  const timerKey = `${alertId}:${responderId}`;
  const timer = acceptanceTimers.get(timerKey);
  if (timer) {
    clearTimeout(timer);
    acceptanceTimers.delete(timerKey);
  }
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
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
const uploadMedia = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB for patrol media (photos + videos)
app.use('/uploads', express.static(uploadsDir));
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
  role: 'user' | 'responder' | 'dispatcher' | 'admin';
  status?: 'available' | 'on_duty' | 'off_duty' | 'responding';
  location?: { latitude: number; longitude: number };
  lastSeen?: number;
}

interface AdminUser {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  role: 'user' | 'responder' | 'dispatcher' | 'admin';
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
  status: 'success' | 'failed_password' | 'failed_email' | 'account_deactivated' | 'account_suspended' | 'no_password';
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
  type: 'text' | 'location' | 'alert' | 'image' | 'audio' | 'document' | 'system';
  timestamp: number;
  mediaUrl?: string;
  mediaType?: string;
  location?: { latitude: number; longitude: number; address?: string };
}

interface Conversation {
  id: string;
  type: 'direct' | 'group';
  name: string;
  participantIds: string[];
  /** For group by role */
  filterRole?: string;
  /** For group by tags */
  filterTags?: string[];
  createdBy: string;
  createdAt: number;
  lastMessageTime: number;
  lastMessage: string;
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
  type: 'sos' | 'medical' | 'fire' | 'accident' | 'other' | 'broadcast' | 'home_jacking' | 'cambriolage' | 'animal_perdu' | 'evenement_climatique' | 'rodage' | 'vehicule_suspect' | 'fugue' | 'route_bloquee' | 'route_fermee';
  severity: 'low' | 'medium' | 'high' | 'critical';
  location: { latitude: number; longitude: number; address: string };
  description: string;
  createdBy: string;
  createdAt: number;
  status: 'active' | 'acknowledged' | 'resolved' | 'cancelled';
  respondingUsers: string[];
  responderStatuses?: Record<string, ResponderStatus>; // per-responder status tracking
  statusHistory?: StatusHistoryEntry[]; // timestamped history of all status changes
  photos?: string[]; // array of relative URLs e.g. ['/uploads/xxx.jpg']
}

interface AdminIncident {
  id: string;
  type: string;
  severity: string;
  status: string;
  reportedBy: string;
  address: string;
  timestamp: number;
  resolvedAt?: number;
  assignedCount: number;
}

interface AuditEntry {
  id: string;
  timestamp: number;
  category: 'auth' | 'user' | 'incident' | 'system' | 'broadcast';
  action: string;
  performedBy: string;
  targetUser?: string;
  details: string;
}

interface WebSocketMessage {
  type: string;
  userId?: string;
  userRole?: string;
  data?: any;
  timestamp?: number;
}

// PTT interfaces
interface PTTChannelServer {
  id: string;
  name: string;
  description: string;
  allowedRoles: ('user' | 'responder' | 'dispatcher' | 'admin')[];
  isActive: boolean;
  isDefault: boolean; // cannot be deleted
  createdBy: string;
  createdAt: number;
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
}

interface ProximityAlert {
  id: string;
  perimeterId: string;
  targetUserId: string;
  targetUserName: string;
  ownerId: string;
  eventType: 'exit' | 'entry';
  /** Distance from center when alert triggered */
  distanceMeters: number;
  location: { latitude: number; longitude: number };
  timestamp: number;
  acknowledged: boolean;
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
}

// In-memory storage
const users = new Map<string, User>();
const alerts = new Map<string, Alert>();
const userConnections = new Map<string, Set<any>>();
// Reverse map: ws client -> userId for efficient PTT broadcast
const wsClientMap = new Map<any, string>();

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

// Family perimeter storage (persisted)
const familyPerimeters = new Map<string, FamilyPerimeter>();
const proximityAlerts: ProximityAlert[] = [];
// Track which targets are currently outside their perimeter: Map<perimeterId, boolean>
const perimeterState = new Map<string, boolean>(); // true = outside

// Patrol reports storage
const patrolReports: PatrolReport[] = [];

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

// ─── Seed demo data ──────────────────────────────────────────────────
function seedDemoData() {
  const now = Date.now();
  const hour = 3600000;
  const day = 86400000;

  // Default password hash for all demo users: 'talion2026'
  const defaultPwHash = bcrypt.hashSync('talion2026', 10);

  // Seed admin users
  const demoUsers: AdminUser[] = [
    { id: 'admin-001', firstName: 'Marie', lastName: 'Dupont', name: 'Marie Dupont', email: 'admin@talion.io', role: 'admin', status: 'active', lastLogin: now - 5 * 60000, createdAt: now - 90 * day, tags: ['command', 'zone-champel'], address: 'Avenue de Champel 24, 1206 Genève, Suisse', phoneMobile: '+41 79 123 45 67', phoneLandline: '+41 22 700 00 01', comments: 'Administratrice principale', passwordHash: defaultPwHash },
    { id: 'disp-001', firstName: 'Jean', lastName: 'Moreau', name: 'Jean Moreau', email: 'dispatch@talion.io', role: 'dispatcher', status: 'active', lastLogin: now - 12 * 60000, createdAt: now - 75 * day, tags: ['equipe-alpha', 'zone-florissant'], address: 'Route de Florissant 62, 1206 Genève, Suisse', phoneMobile: '+41 79 234 56 78', comments: 'Dispatcher senior, equipe jour', passwordHash: defaultPwHash },
    { id: 'disp-002', firstName: 'Sophie', lastName: 'Laurent', name: 'Sophie Laurent', email: 'dispatch2@talion.io', role: 'dispatcher', status: 'active', lastLogin: now - 2 * hour, createdAt: now - 60 * day, tags: ['equipe-bravo', 'zone-malagnou'], address: 'Route de Malagnou 32, 1208 Genève, Suisse', phoneMobile: '+41 79 345 67 89', passwordHash: defaultPwHash },
    { id: 'resp-001', firstName: 'Pierre', lastName: 'Martin', name: 'Pierre Martin', email: 'responder@talion.io', role: 'responder', status: 'active', lastLogin: now - 8 * 60000, createdAt: now - 80 * day, tags: ['equipe-alpha', 'zone-champel', 'medical'], address: 'Chemin de Beau-Soleil 8, 1206 Genève, Suisse', phoneMobile: '+41 79 456 78 90', comments: 'Secouriste certifie', passwordHash: defaultPwHash },
    { id: 'resp-002', firstName: 'Camille', lastName: 'Bernard', name: 'Camille Bernard', email: 'responder2@talion.io', role: 'responder', status: 'active', lastLogin: now - 30 * 60000, createdAt: now - 65 * day, tags: ['equipe-alpha', 'zone-malagnou', 'fire'], address: 'Avenue de Frontenex 45, 1207 Genève, Suisse', phoneMobile: '+41 79 567 89 01', passwordHash: defaultPwHash },
    { id: 'resp-003', firstName: 'Lucas', lastName: 'Petit', name: 'Lucas Petit', email: 'responder3@talion.io', role: 'responder', status: 'active', lastLogin: now - 1 * hour, createdAt: now - 50 * day, tags: ['equipe-bravo', 'zone-vesenaz'], address: 'Route de Thonon 85, 1222 Vésenaz, Suisse', phoneMobile: '+41 79 678 90 12', passwordHash: defaultPwHash },
    { id: 'resp-004', firstName: 'Emma', lastName: 'Roux', name: 'Emma Roux', email: 'responder4@talion.io', role: 'responder', status: 'suspended', lastLogin: now - 5 * day, createdAt: now - 45 * day, tags: ['equipe-bravo', 'medical'], address: 'Chemin de la Capite 12, 1222 Vésenaz, Suisse', phoneMobile: '+41 79 789 01 23', passwordHash: defaultPwHash },
    { id: 'user-001', firstName: 'Thomas', lastName: 'Leroy', name: 'Thomas Leroy', email: 'thomas@example.com', role: 'user', status: 'active', lastLogin: now - 3 * hour, createdAt: now - 30 * day, tags: ['zone-champel', 'observateur'], address: 'Avenue de Miremont 30, 1206 Genève, Suisse', phoneMobile: '+41 79 890 12 34', relationships: [{ userId: 'user-002', type: 'spouse' }, { userId: 'user-004', type: 'parent' }, { userId: 'user-005', type: 'parent' }], passwordHash: defaultPwHash },
    { id: 'user-002', firstName: 'Julie', lastName: 'Morel', name: 'Julie Morel', email: 'julie@example.com', role: 'user', status: 'active', lastLogin: now - 6 * hour, createdAt: now - 25 * day, tags: ['zone-florissant', 'observateur'], address: 'Avenue de Miremont 30, 1206 Genève, Suisse', phoneMobile: '+41 79 901 23 45', relationships: [{ userId: 'user-001', type: 'spouse' }, { userId: 'user-004', type: 'parent' }, { userId: 'user-005', type: 'parent' }], passwordHash: defaultPwHash },
    { id: 'user-003', firstName: 'Nicolas', lastName: 'Fournier', name: 'Nicolas Fournier', email: 'nicolas@example.com', role: 'user', status: 'deactivated', lastLogin: now - 15 * day, createdAt: now - 40 * day, tags: [], address: 'Chemin du Velours 10, 1208 Genève, Suisse', passwordHash: defaultPwHash },
    { id: 'user-004', firstName: 'Lea', lastName: 'Leroy', name: 'Lea Leroy', email: 'lea@example.com', role: 'user', status: 'active', lastLogin: now - 45 * 60000, createdAt: now - 20 * day, tags: ['zone-champel'], address: 'Avenue de Miremont 30, 1206 Genève, Suisse', phoneMobile: '+41 79 012 34 56', relationships: [{ userId: 'user-005', type: 'sibling' }, { userId: 'user-001', type: 'child' }, { userId: 'user-002', type: 'child' }], passwordHash: defaultPwHash },
    { id: 'user-005', firstName: 'Hugo', lastName: 'Leroy', name: 'Hugo Leroy', email: 'hugo@example.com', role: 'user', status: 'active', lastLogin: now - 2 * day, createdAt: now - 10 * day, tags: ['zone-vesenaz'], address: 'Avenue de Miremont 30, 1206 Genève, Suisse', phoneMobile: '+41 79 123 45 00', relationships: [{ userId: 'user-004', type: 'sibling' }, { userId: 'user-001', type: 'child' }, { userId: 'user-002', type: 'child' }], passwordHash: defaultPwHash },
  ];
  demoUsers.forEach(u => adminUsers.set(u.id, u));
  // Seed audit log
  const demoAudit: AuditEntry[] = [
    { id: uuidv4(), timestamp: now - 2 * 60000, category: 'incident', action: 'Incident Created', performedBy: 'Jean Moreau', details: 'Created INC-001: Urgence médicale à Avenue de Champel' },
    { id: uuidv4(), timestamp: now - 5 * 60000, category: 'incident', action: 'Incident Created', performedBy: 'Sophie Laurent', details: 'Created INC-008: Feu de cuisine au Chemin du Velours' },
    { id: uuidv4(), timestamp: now - 5 * 60000, category: 'auth', action: 'User Login', performedBy: 'Marie Dupont', details: 'Admin login from 192.168.1.100' },
    { id: uuidv4(), timestamp: now - 8 * 60000, category: 'incident', action: 'Alert Acknowledged', performedBy: 'Pierre Martin', details: 'Acknowledged INC-002: Alarme incendie Route de Florissant' },
    { id: uuidv4(), timestamp: now - 12 * 60000, category: 'auth', action: 'User Login', performedBy: 'Jean Moreau', details: 'Dispatcher login from mobile device' },
    { id: uuidv4(), timestamp: now - 15 * 60000, category: 'user', action: 'Role Changed', performedBy: 'Marie Dupont', targetUser: 'Lucas Petit', details: 'Role changed from user to responder' },
    { id: uuidv4(), timestamp: now - 30 * 60000, category: 'incident', action: 'Responder Assigned', performedBy: 'Jean Moreau', targetUser: 'Camille Bernard', details: 'Assigned to INC-003: Chemical spill' },
    { id: uuidv4(), timestamp: now - 45 * 60000, category: 'incident', action: 'Incident Resolved', performedBy: 'Pierre Martin', details: 'Resolved INC-005: Alerte SOS à Vésenaz' },
    { id: uuidv4(), timestamp: now - 1 * hour, category: 'broadcast', action: 'Zone Broadcast Sent', performedBy: 'Sophie Laurent', details: 'Alerte broadcast dans un rayon de 2km autour de Route de Malagnou' },
    { id: uuidv4(), timestamp: now - 2 * hour, category: 'system', action: 'Server Restart', performedBy: 'System', details: 'Scheduled maintenance restart completed' },
    { id: uuidv4(), timestamp: now - 2 * hour, category: 'incident', action: 'Incident Resolved', performedBy: 'Lucas Petit', details: 'Resolved INC-006: Chute personne âgée à Vésenaz' },
    { id: uuidv4(), timestamp: now - 3 * hour, category: 'user', action: 'User Suspended', performedBy: 'Marie Dupont', targetUser: 'Emma Roux', details: 'Suspended for policy violation' },
    { id: uuidv4(), timestamp: now - 4 * hour, category: 'incident', action: 'Incident Resolved', performedBy: 'Pierre Martin', details: 'Resolved INC-007: Minor vehicle collision' },
    { id: uuidv4(), timestamp: now - 5 * hour, category: 'auth', action: 'User Login', performedBy: 'Thomas Leroy', details: 'User login from mobile device' },
    { id: uuidv4(), timestamp: now - 6 * hour, category: 'system', action: 'Backup Completed', performedBy: 'System', details: 'Automated daily backup completed successfully' },
    { id: uuidv4(), timestamp: now - 1 * day, category: 'user', action: 'User Deactivated', performedBy: 'Marie Dupont', targetUser: 'Nicolas Fournier', details: 'Account deactivated upon request' },
  ];
  auditLog.push(...demoAudit);
}

seedDemoData();

// ─── Load persisted data (overrides seed data if files exist) ───────────
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

  // Load persisted proximity alerts
  const savedProxAlerts = loadJsonFile<ProximityAlert[]>(PROXIMITY_ALERTS_FILE, []);
  proximityAlerts.push(...savedProxAlerts);
  if (savedProxAlerts.length > 0) {
    console.log(`[Persist] Loaded ${savedProxAlerts.length} proximity alerts from disk`);
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

// ─── Helper: add audit entry ─────────────────────────────────────────
function addAuditEntry(category: AuditEntry['category'], action: string, performedBy: string, details: string, targetUser?: string) {
  auditLog.unshift({
    id: uuidv4(),
    timestamp: Date.now(),
    category,
    action,
    performedBy,
    targetUser,
    details,
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
        if (conns.size === 0) userConnections.delete(userId);
      }
      broadcastUserStatus(userId, 'offline');
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
  // Use message-level userId/userRole, falling back to connection-level context
  const userId = message.userId || connUserId || undefined;
  const userRole = message.userRole || connUserRole || undefined;
  const { type, data, timestamp } = message;

  switch (type) {
    case 'auth':
      handleAuth(ws, userId, userRole, setUserContext);
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
    case 'pttEnd':
      // Diffuser PTT simple à tous les connectés
      const pttPayload = JSON.stringify({ type: data.type, senderId: data.senderId, senderName: data.senderName, channel: data.channel });
      wss.clients.forEach((client: any) => {
        if (client !== ws && client.readyState === 1) {
          client.send(pttPayload);
        }
      });
      break;

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

// Authentication handler
function handleAuth(ws: any, userId: string | undefined, userRole: string | undefined, setUserContext: (id: string, role: string) => void) {
  if (!userId || !userRole) {
    ws.send(JSON.stringify({ type: 'error', message: 'Missing userId or userRole' }));
    return;
  }

  const user: User = {
    id: userId,
    email: `${userId}@talion.local`,
    role: userRole as any,
    status: userRole === 'responder' ? 'available' : undefined,
    lastSeen: Date.now(),
  };

  users.set(userId, user);

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
  addAuditEntry('auth', 'User Login', userId, `${userRole} login via WebSocket`);

  const activeAlerts = Array.from(alerts.values()).filter(a => a.status === 'active').map(a => ({
    ...a,
    respondingNames: (a.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
  }));
  ws.send(JSON.stringify({
    type: 'alertsSnapshot',
    data: activeAlerts,
  }));

  broadcastUserStatus(userId, 'online');
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
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
    photos: [],
  };

  alerts.set(alert.id, alert);
  persistAlerts();
  console.log(`New alert created: ${alert.id} by ${userId}`);

  addAuditEntry('incident', 'Incident Created', userId, `Created ${alert.id}: ${alert.type} at ${alert.location.address}`);

  broadcastMessage({ type: 'newAlert', data: alert });
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
      };
      geofenceEvents.unshift(event);
      addAuditEntry('broadcast', 'Geofence Entry', userId, `${responderName} entered zone ${zoneId} (${zone.severity} — ${zone.radiusKm}km)`);
      broadcastMessage({
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
      };
      geofenceEvents.unshift(event);
      addAuditEntry('broadcast', 'Geofence Exit', userId, `${responderName} exited zone ${zoneId} (${zone.severity} — ${zone.radiusKm}km)`);
      broadcastMessage({
        type: 'geofenceExit',
        data: { ...event, zone: { id: zone.id, severity: zone.severity, radiusKm: zone.radiusKm, message: zone.message } },
      });
      console.log(`[Geofence] ${responderName} EXITED zone ${zoneId}`);
    }
  });
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

      console.log(`[Proximity] ${perimeter.targetUserName} RETURNED to perimeter ${pId}`);
    }
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

  // Broadcast to dispatchers - use appropriate event type based on role
  if (user.role === 'responder') {
    broadcastToRole('dispatcher', {
      type: 'responderLocationUpdate',
      userId,
      location: locationData,
      timestamp: Date.now(),
    });
    // Also broadcast to admins
    broadcastToRole('admin', {
      type: 'responderLocationUpdate',
      userId,
      location: locationData,
      timestamp: Date.now(),
    });
    checkGeofences(userId, locationData);
  } else {
    // Regular user location update - broadcast as userLocationUpdate to dispatchers
    broadcastToRole('dispatcher', {
      type: 'userLocationUpdate',
      userId,
      location: locationData,
      timestamp: Date.now(),
    });
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
    broadcastToRole('dispatcher', {
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
    alerts.set(alert.id, alert);
    persistAlerts();
    console.log(`Alert ${alert.id} acknowledged by ${userId}`);
    addAuditEntry('incident', 'Alert Acknowledged', userId, `Acknowledged ${alert.id}`);
    broadcastMessage({ type: 'alertAcknowledged', alertId: alert.id, userId, timestamp: Date.now() });
  }
}

// Get alerts handler
function handleGetAlerts(ws: any, userId: string, userRole: string) {
  const userAlerts = Array.from(alerts.values()).filter(alert => {
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

// Broadcast helpers
function broadcastMessage(message: any) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) { client.send(data); }
  });
}

function broadcastToRole(role: string, message: any) {
  const data = JSON.stringify(message);
  const targetUsers = Array.from(users.values()).filter(u => u.role === role);
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
  broadcastToRole('dispatcher', {
    type: 'userStatusChange',
    userId,
    status,
    timestamp: Date.now(),
  });
}

// ─── REST API endpoints ────────────────────────────────────────────// ─── Authentication ───────────────────────────────────────────────────────
app.post('/auth/login', (req, res) => {
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
  // Success
  addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: 'success' });
  user.lastLogin = Date.now();
  adminUsers.set(user.id, user);
  addAuditEntry('auth', 'User Login', user.name, `Login via email/password from ${parseDevice(userAgent)} (${ip})`, undefined);
  const { passwordHash, ...safeUser } = user;
  res.json({
    success: true,
    user: safeUser,
    token: `session-${user.id}-${Date.now()}`,
  });
});

// Change password endpoint
app.put('/auth/change-password', (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  if (!userId || !newPassword) {
    return res.status(400).json({ error: 'userId and newPassword are required' });
  }
  const user = adminUsers.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  // If user has a current password, verify it
  if (user.passwordHash && currentPassword) {
    if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  adminUsers.set(user.id, user);
  addAuditEntry('auth', 'Password Changed', user.name, 'Password updated', undefined);
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

  addAuditEntry('auth', 'Password Reset Requested', user.name, `Reset code generated for ${user.email}`, undefined);

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

  addAuditEntry('auth', 'Password Reset Completed', user.name, `Password reset via code for ${user.email}`, undefined);
  console.log(`[Auth] Password reset completed for ${user.email}`);
  res.json({ success: true, message: 'Mot de passe réinitialisé avec succès.' });
});

// ─── Login History Endpoints ─────────────────────────────────────────
// Global login history (all users)
app.get('/admin/login-history', (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const status = req.query.status as string; // filter by status
  const userId = req.query.userId as string; // filter by user
  const search = (req.query.search as string || '').toLowerCase();

  let filtered = [...loginHistory];
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
app.get('/admin/users/:id/login-history', (req, res) => {
  const userId = req.params.id;
  const user = adminUsers.get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

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
app.get('/admin/login-stats', (req, res) => {
  const now = Date.now();
  const last24h = loginHistory.filter(e => e.timestamp > now - 86400000);
  const last7d = loginHistory.filter(e => e.timestamp > now - 7 * 86400000);

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
    totalEntries: loginHistory.length,
  });
});

// Photo upload endpoint
app.post('/admin/users/:id/photo', upload.single('photo'), (req: any, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  user.photoUrl = `/uploads/${req.file.filename}`;
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

app.get('/api/geocode', async (req, res) => {
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

app.get('/alerts', (req, res) => {
  const userRole = req.query.role as string;
  const userId = req.query.userId as string;
  const visibleAlerts = Array.from(alerts.values()).filter(a => {
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

app.get('/alerts/:id', (req, res) => {
  const alert = alerts.get(req.params.id);
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
  broadcastMessage({ type: 'alertUpdate', data: { ...alert, respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid) } });
  res.json({ success: true });
});

app.put('/alerts/:id/acknowledge', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.status = 'acknowledged';
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry('incident', 'Alert Acknowledged', req.body?.userId || 'Mobile App', `Acknowledged ${alert.id}`);
  broadcastMessage({ type: 'alertAcknowledged', alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});

// Mobile app: resolve alert
app.put('/alerts/:id/resolve', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.status = 'resolved';
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry('incident', 'Incident Resolved', req.body?.userId || 'Mobile App', `Resolved ${alert.id}: ${alert.type} at ${alert.location.address}`);
  broadcastMessage({ type: 'alertResolved', alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});

app.get('/responders', (req, res) => {
  const responders = Array.from(users.values()).filter(u => u.role === 'responder');
  res.json(responders);
});

// Dispatch console: create incident without auth (internal use)
app.post('/dispatch/incidents', async (req, res) => {
  const { type, severity, location, description, createdBy } = req.body;
  const alert: Alert = {
    id: await generateIncidentId(type || 'other', createdBy || 'Dispatch Console', location || {}),
    type: type || 'other',
    severity: severity || 'medium',
    location: location || { latitude: 0, longitude: 0, address: 'Unknown' },
    description: description || '',
    createdBy: createdBy || 'Dispatch Console',
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(() => {});
  broadcastMessage({ type: 'newAlert', data: alert });
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
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  broadcastMessage({ type: 'newAlert', data: alert });

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
app.post('/api/push-token', (req, res) => {
  const { token, userId, userRole } = req.body;
  if (!token || !userId) {
    return res.status(400).json({ error: 'Missing token or userId' });
  }
  
  pushTokens.set(token, {
    token,
    userId,
    userRole: userRole || 'user',
    registeredAt: Date.now(),
  });
  savePushTokenToSupabase({ token, userId, userRole: userRole || 'user', registeredAt: Date.now() });
  
  console.log(`[Push] Token registered for ${userId} (${userRole}). Total tokens: ${pushTokens.size}`);
  res.json({ success: true });
});

// Debug: list all push tokens
app.get('/api/debug/push-tokens', (_req, res) => {
  const tokens = Array.from(pushTokens.values()).map(e => ({
    userId: e.userId,
    userRole: e.userRole,
    token: e.token,
    registeredAt: e.registeredAt,
  }));
  res.json(tokens);
});

app.delete('/api/push-token', (req, res) => {
  const { token } = req.body;
  if (token) {
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
  
  // Build Expo push messages
  const messages = targetTokens.map((token) => ({
    to: token,
    sound: 'default',
    title: `\u{1F6A8} SOS ALERT - ${alert.type.toUpperCase()}`,
    body: `${senderName} triggered an emergency alert. ${alert.location?.address || 'Location shared'}`,
    data: {
      type: 'sos',
      alertId: alert.id,
      severity: alert.severity,
      alertType: alert.type,
    },
    priority: 'high',
    channelId: 'sos-alerts',
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
  for (const [token, _entry] of pushTokens) {
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
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
    photos: [],
  };
  
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry('incident', 'SOS Alert Created (REST)', userId || 'unknown', `SOS ${alert.id}: ${alert.location.address}`);
  
  // Broadcast to ALL connected WebSocket clients (Dispatch console, admin, etc.)
  broadcastMessage({ type: 'newAlert', data: alert });
  
  // Send push notifications to dispatchers and responders
  sendPushToDispatchersAndResponders(alert, userName || userId || 'Unknown').catch(err => {
    console.error('[SOS REST] Push notification error:', err);
  });
  
  console.log(`[SOS REST] Alert ${alert.id} created and broadcast to ${wss.clients.size} clients`);
  res.json({ success: true, alertId: alert.id, broadcast: true });
});

// ─── Alert Photo Upload ──────────────────────────────────────────────
// Upload photos to an existing alert (called after alert creation)
app.post('/api/alerts/:id/photos', upload.array('photos', 4), (req: any, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const photoUrls: string[] = req.files.map((f: any) => `/uploads/${f.filename}`);
  if (!alert.photos) alert.photos = [];
  alert.photos.push(...photoUrls);
  persistAlerts();

  console.log(`[Alert Photos] ${photoUrls.length} photo(s) uploaded to alert ${alert.id}`);

  // Broadcast photo update to all connected clients
  broadcastMessage({ type: 'alertPhotosUpdated', data: { alertId: alert.id, photos: alert.photos } });

  res.json({ success: true, photos: alert.photos });
});

// GET alert photos
app.get('/api/alerts/:id/photos', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  res.json({ photos: alert.photos || [] });
});

// ─── Location REST API (reliable fallback for mobile app) ────────────
// This endpoint lets the mobile app send location updates via HTTP POST
// when WebSocket is not connected or unreliable (e.g. Expo Go on real devices).
app.post('/api/location', (req, res) => {
  const { userId, userRole, latitude, longitude } = req.body;
  console.log(`[Location REST] Received from userId=${userId} (${userRole}): lat=${latitude}, lng=${longitude}`);
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: 'latitude and longitude required' });
  }
  // Generate anonymous ID if userId is empty (e.g. web preview without login)
  const resolvedUserId = userId || `anon-${Date.now()}`;
  const locationData = { latitude: Number(latitude), longitude: Number(longitude) };
  // Reuse the same handler as WebSocket
  handleLocationUpdate(null as any, resolvedUserId, userRole || 'user', locationData);
  sharingUsers.add(resolvedUserId);
  console.log(`[Location REST] Processed for ${resolvedUserId}, now in users map: ${users.has(resolvedUserId)}, sharing: true`);
  res.json({ success: true, userId: resolvedUserId, location: locationData, timestamp: Date.now() });
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
    broadcastToRole('dispatcher', {
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
  broadcastToRole('dispatcher', {
    type: 'userLocationRemoved',
    userId,
    timestamp: Date.now(),
  });
  res.json({ success: true, userId, timestamp: Date.now() });
}

// DELETE /api/location - supports body or query param
app.delete('/api/location', (req, res) => {
  const userId = req.body?.userId || req.query.userId as string;
  handleStopSharing(userId, res);
});

// POST /api/location/stop - more reliable alternative for mobile clients
app.post('/api/location/stop', (req, res) => {
  const userId = req.body?.userId || req.query.userId as string;
  handleStopSharing(userId, res);
});

// GET /api/location/live-count - number of users currently sharing location
app.get('/api/location/live-count', (_req, res) => {
  res.json({ count: sharingUsers.size, userIds: Array.from(sharingUsers) });
});

// GET /api/family/locations - get locations of family members for a given user
app.get('/api/family/locations', (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const familyIds = getFamilyMemberIds(userId);
  const familyLocations = familyIds
    .map(fid => {
      const u = users.get(fid);
      const adminUser = adminUsers.get(fid);
      const rel = adminUsers.get(userId)?.relationships?.find(r => r.userId === fid);
      if (!u || !u.location) return null;
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
app.get('/api/family/members', (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const adminUser = adminUsers.get(userId);
  if (!adminUser) return res.status(404).json({ error: 'User not found' });
  const familyTypes = ['parent', 'child', 'sibling', 'spouse'];
  const members = (adminUser.relationships || [])
    .filter(r => familyTypes.includes(r.type))
    .map(r => {
      const relUser = adminUsers.get(r.userId);
      const isSharing = sharingUsers.has(r.userId);
      const runtimeUser = users.get(r.userId);
      return {
        userId: r.userId,
        name: relUser?.name || 'Unknown',
        relationship: r.type,
        isSharing,
        lastSeen: runtimeUser?.lastSeen || null,
      };
    });
  res.json(members);
});

// ─── Family Perimeter CRUD ───────────────────────────────────────────

// GET /api/family/perimeters - list perimeters for a user (owner)
app.get('/api/family/perimeters', (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const userPerimeters = Array.from(familyPerimeters.values())
    .filter(p => p.ownerId === userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(userPerimeters);
});

// POST /api/family/perimeters - create a new perimeter
app.post('/api/family/perimeters', (req, res) => {
  const { ownerId, targetUserId, center, radiusMeters } = req.body;
  if (!ownerId || !targetUserId || !center?.latitude || !center?.longitude || !radiusMeters) {
    return res.status(400).json({ error: 'ownerId, targetUserId, center {latitude, longitude}, and radiusMeters required' });
  }
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
app.put('/api/family/perimeters/:id', (req, res) => {
  const perimeter = familyPerimeters.get(req.params.id);
  if (!perimeter) return res.status(404).json({ error: 'Perimeter not found' });
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
app.delete('/api/family/perimeters/:id', (req, res) => {
  const existed = familyPerimeters.delete(req.params.id);
  if (existed) deleteFamilyPerimeterFromSupabase(req.params.id);
  perimeterState.delete(req.params.id);
  if (existed) persistPerimeters();
  res.json({ success: existed });
});

// GET /api/family/proximity-alerts - get proximity alerts for a user (owner)
app.get('/api/family/proximity-alerts', (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const userAlerts = proximityAlerts
    .filter(a => a.ownerId === userId)
    .slice(0, limit);
  res.json(userAlerts);
});

// PUT /api/family/proximity-alerts/:id/acknowledge
app.put('/api/family/proximity-alerts/:id/acknowledge', (req, res) => {
  const alert = proximityAlerts.find(a => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });
  alert.acknowledged = true;
  persistProximityAlerts();
  res.json({ success: true });
});

// GET /api/family/location-history - get location history for a family member
app.get('/api/family/location-history', (req, res) => {
  const userId = req.query.userId as string;
  const targetUserId = req.query.targetUserId as string;
  if (!userId || !targetUserId) return res.status(400).json({ error: 'userId and targetUserId required' });
  // Verify the target is a family member (or self)
  if (userId !== targetUserId) {
    const familyIds = getFamilyMemberIds(userId);
    if (!familyIds.includes(targetUserId)) {
      return res.status(403).json({ error: 'Target user is not a family member' });
    }
  }
  const history = locationHistory.get(targetUserId) || [];
  const since = Number(req.query.since) || 0;
  const filtered = since > 0 ? history.filter(h => h.timestamp >= since) : history;
  res.json(filtered.slice(-100)); // return last 100 entries
});

// ─── Admin REST API ──────────────────────────────────────────────

// Admin health (extended)
app.get('/admin/health', (req, res) => {
  res.json({
    status: 'ok',
    connectedUsers: userConnections.size,
    totalUsers: adminUsers.size,
    activeAlerts: Array.from(alerts.values()).filter(a => a.status === 'active').length,
    totalAlerts: alerts.size,
    wsClients: wss.clients.size,
    timestamp: Date.now(),
  });
});

// Admin users list
app.get('/admin/users', (req, res) => {
  const users = Array.from(adminUsers.values()).map(u => {
    const { passwordHash, ...safeUser } = u;
    return { ...safeUser, hasPassword: !!passwordHash };
  });
  res.json(users);
});

// Admin change user role
app.put('/admin/users/:id/role', (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { role } = req.body;
  if (!['admin', 'dispatcher', 'responder', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }
  const oldRole = user.role;
  user.role = role;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry('user', 'Role Changed', 'Admin', `Role changed from ${oldRole} to ${role}`, user.name);
  res.json({ success: true });
});

// Admin change user status
app.put('/admin/users/:id/status', (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { status } = req.body;
  if (!['active', 'suspended', 'deactivated'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  const oldStatus = user.status;
  user.status = status;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  const actionName = status === 'suspended' ? 'User Suspended' : status === 'deactivated' ? 'User Deactivated' : 'User Reactivated';
  addAuditEntry('user', actionName, 'Admin', `Status changed from ${oldStatus} to ${status}`, user.name);
  res.json({ success: true });
});

// ─── Admin User CRUD ─────────────────────────────────────────────────

// GET single user by ID
app.get('/admin/users/:id', (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
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
app.post('/admin/users', async (req, res) => {
  const { firstName, lastName, email, role, tags, address, addressComponents, phoneLandline, phoneMobile, comments, photoUrl, relationships, password } = req.body;
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'firstName, lastName, and email are required' });
  }
  if (role && !['admin', 'dispatcher', 'responder', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
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
  addAuditEntry('user', 'User Created', 'Admin', `New ${role || 'user'}: ${firstName} ${lastName} (${email})`, newUser.name);
  const { passwordHash: _pwh, ...safeNewUser } = newUser;
  res.status(201).json({ ...safeNewUser, hasPassword: !!newUser.passwordHash });
});

// PUT update user
app.put('/admin/users/:id', (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { firstName, lastName, email, role, tags, address, addressComponents, phoneLandline, phoneMobile, comments, photoUrl, relationships, status, password } = req.body;
  // Check email uniqueness if changed
  if (email && email !== user.email) {
    const existing = Array.from(adminUsers.values()).find(u => u.email === email && u.id !== user.id);
    if (existing) return res.status(409).json({ error: 'A user with this email already exists' });
  }
  if (role && !['admin', 'dispatcher', 'responder', 'user'].includes(role)) {
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
  addAuditEntry('user', 'User Updated', 'Admin', `Updated: ${changes.join(', ')}`, user.name);
  const { passwordHash: _pw, ...safeUpdatedUser } = user;
  res.json({ ...safeUpdatedUser, hasPassword: !!user.passwordHash });
});

// DELETE user
app.delete('/admin/users/:id', (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
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
  addAuditEntry('user', 'User Deleted', 'Admin', `Deleted user: ${user.name} (${user.email})`, user.name);
  res.json({ success: true, deletedUser: user.name });
});

// GET users at same address
app.get('/admin/users/:id/cohabitants', (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
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
app.get('/admin/users/:id/relationships', (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const enriched = (user.relationships || []).map(r => {
    const relUser = adminUsers.get(r.userId);
    return { ...r, userName: relUser?.name || 'Unknown', userEmail: relUser?.email || '', userRole: relUser?.role || '' };
  });
  res.json(enriched);
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

// Admin incidents list (formatted for dashboard)
app.get('/admin/incidents', (req, res) => {
  const incidents: AdminIncident[] = Array.from(alerts.values()).map(a => ({
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    reportedBy: a.createdBy,
    address: a.location.address,
    timestamp: a.createdAt,
    resolvedAt: a.status === 'resolved' ? a.createdAt + Math.floor(Math.random() * 3600000) : undefined,
    assignedCount: a.respondingUsers.length,
  }));
  res.json(incidents);
});

// Admin audit log
app.get('/admin/audit', (req, res) => {
  res.json(auditLog);
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

// Dispatch responders list (with location and assignment info)
app.get('/dispatch/responders', (req, res) => {
  // Build responder list from adminUsers (the authoritative source with real names)
  const now = Date.now();
  const allResponders: any[] = [];
  
  // Get all users with role 'responder' from adminUsers
  adminUsers.forEach((user) => {
    if (user.role !== 'responder') return;
    if (user.status === 'deactivated') return; // skip deactivated
    
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
  
  addAuditEntry('responder', 'Status Changed', 'Dispatch Console', `${responderName} status changed to ${status}`, responderId);
  
  // Broadcast status change to all dispatchers
  broadcastToRole('dispatcher', {
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
  alert.status = 'acknowledged';
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry('incident', 'Alert Acknowledged', 'Dispatch Console', `Acknowledged ${alert.id}`);
  broadcastMessage({ type: 'alertAcknowledged', alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});

// Dispatch: assign responder to incident
app.put('/dispatch/incidents/:id/assign', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  const { responderId } = req.body;
  if (responderId && !alert.respondingUsers.includes(responderId)) {
    alert.respondingUsers.push(responderId);
  }
  if (alert.status === 'active' || alert.status === 'acknowledged') {
    alert.status = 'acknowledged';
  }
  alerts.set(alert.id, alert);
  persistAlerts();
  // Initialize responderStatuses if not present
  if (!alert.responderStatuses) alert.responderStatuses = {};
  if (!alert.statusHistory) alert.statusHistory = [];
  if (responderId && !alert.responderStatuses[responderId]) {
    alert.responderStatuses[responderId] = 'assigned';
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
  addAuditEntry('incident', 'Responder Assigned', 'Dispatch Console', `Assigned ${responderName} to ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
  };
  broadcastMessage({ type: 'alertUpdate', data: enrichedAlert });

  // Send push notification to the assigned responder
  const TYPE_LABELS: Record<string, string> = {
    sos: 'SOS', medical: 'M\u00e9dical', fire: 'Incendie', security: 'S\u00e9curit\u00e9',
    hazard: 'Danger', accident: 'Accident', broadcast: 'Broadcast',
    home_jacking: 'Home-Jacking', cambriolage: 'Cambriolage', animal_perdu: 'Animal perdu',
    evenement_climatique: '\u00c9v\u00e9nement climatique', rodage: 'Rodage',
    vehicule_suspect: 'V\u00e9hicule suspect', fugue: 'Fugue',
    route_bloquee: 'Route bloqu\u00e9e', route_fermee: 'Route ferm\u00e9e', other: 'Autre',
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
  const { responderId } = req.body;
  if (!responderId) return res.status(400).json({ error: 'responderId required' });
  const idx = alert.respondingUsers.indexOf(responderId);
  if (idx === -1) return res.status(400).json({ error: 'Responder not assigned to this incident' });
  alert.respondingUsers.splice(idx, 1);
  // Clear acceptance timer and remove from responderStatuses
  clearAcceptanceTimer(alert.id, responderId);
  if (alert.responderStatuses) delete alert.responderStatuses[responderId];
  alerts.set(alert.id, alert);
  persistAlerts();
  const responderName = adminUsers.get(responderId)?.name || responderId;
  addAuditEntry('incident', 'Responder Unassigned', 'Dispatch Console', `Unassigned ${responderName} from ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
  };
  broadcastMessage({ type: 'alertUpdate', data: enrichedAlert });
  res.json({ success: true, responderName });
});

// Dispatch: get responders with distance to a specific incident (for assign modal)
app.get('/dispatch/incidents/:id/responders-nearby', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  const incidentLat = alert.location.latitude;
  const incidentLng = alert.location.longitude;
  const now = Date.now();
  const result: any[] = [];

  adminUsers.forEach((user) => {
    if (user.role !== 'responder') return;
    if (user.status === 'deactivated') return;
    const runtimeUser = users.get(user.id);
    const location = runtimeUser?.location || null;
    let distanceMeters: number | null = null;
    let distanceLabel = 'Position inconnue';
    if (location && location.latitude && location.longitude) {
      distanceMeters = haversineDistance(location.latitude, location.longitude, incidentLat, incidentLng);
      if (distanceMeters < 1000) {
        distanceLabel = `${Math.round(distanceMeters)} m`;
      } else {
        distanceLabel = `${(distanceMeters / 1000).toFixed(1)} km`;
      }
    }
    const isAssigned = alert.respondingUsers.includes(user.id);
    result.push({
      id: user.id,
      name: user.name,
      phone: user.phoneMobile || '',
      tags: user.tags || [],
      status: runtimeUser?.status || responderStatusOverrides.get(user.id)?.status || 'off_duty',
      isConnected: !!runtimeUser,
      isAssigned,
      distanceMeters,
      distanceLabel,
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

  res.json({ incidentId: alert.id, incidentAddress: alert.location.address, responders: result });
});

// Dispatch: resolve incident
app.put('/dispatch/incidents/:id/resolve', (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Incident not found' });
  alert.status = 'resolved';
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry('incident', 'Incident Resolved', 'Dispatch Console', `Resolved ${alert.id}: ${alert.type} at ${alert.location.address}`);
  broadcastMessage({ type: 'alertResolved', alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});

// Responder: update their response status on an incident (accept, en_route, on_scene)
app.put('/alerts/:id/respond', (req, res) => {
  // Try direct lookup first, then try decoded variants
  let alert = alerts.get(req.params.id);
  if (!alert) {
    // Try decoding the ID (handles em dash and special chars)
    try { alert = alerts.get(decodeURIComponent(req.params.id)); } catch(e) {}
  }
  if (!alert) {
    // Try finding by partial match (last resort)
    for (const [key, val] of alerts) {
      if (key.includes(req.params.id) || req.params.id.includes(key)) { alert = val; break; }
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
  addAuditEntry('incident', `Responder ${statusLabel}`, responderName, `${responderName} — ${statusLabel} pour ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map(uid => adminUsers.get(uid)?.name || uid),
  };
  broadcastMessage({ type: 'alertUpdate', data: enrichedAlert });
  // Notify dispatchers via push
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === 'dispatcher' || entry.userRole === 'admin') {
      sendPushToUser(entry.userId, `${responderName} — ${statusLabel}`, `Incident ${alert.id}: ${responderName} est ${statusLabel.toLowerCase()}`, { type: 'responder_status', alertId: alert.id, responderId, status }).catch(() => {});
      break; // one notification per dispatcher is enough via broadcast
    }
  }
  res.json({ success: true, responderId, status, statusLabel });
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
    createdAt: Date.now(),
    status: 'active',
    respondingUsers: [],
  };

  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry('broadcast', 'Zone Broadcast Sent', by || 'Dispatch Console', `[${sev.toUpperCase()}] ${message} (${radiusKm || 5}km radius)`);

  // Broadcast as newAlert so all WS clients (including mobile) receive it
  broadcastMessage({ type: 'newAlert', data: alert });
  // Also send the legacy zoneBroadcast event for dispatch console UI
  broadcastMessage({ type: 'zoneBroadcast', data: { message, severity: sev, radiusKm, by, timestamp: Date.now() } });

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
  };
  geofenceZones.set(zone.id, zone);
  responderZoneState.set(zone.id, new Set());

  // Check which responders are already inside the zone
  const demoResponderLocations = [
    { id: 'resp-001', lat: 46.1930, lng: 6.1540 },
    { id: 'resp-002', lat: 46.2010, lng: 6.1620 },
    { id: 'resp-003', lat: 46.1960, lng: 6.1680 },
    { id: 'resp-004', lat: 46.2310, lng: 6.2050 },
  ];
  const allResponders = Array.from(users.values()).filter(u => u.role === 'responder' && u.location);
  const respondersToCheck = allResponders.length > 0
    ? allResponders.map(r => ({ id: r.id, lat: r.location!.latitude, lng: r.location!.longitude }))
    : demoResponderLocations;

  respondersToCheck.forEach(r => {
    const dist = haversineDistance(r.lat, r.lng, zone.center.latitude, zone.center.longitude);
    if (dist <= zone.radiusKm * 1000) {
      responderZoneState.get(zone.id)!.add(r.id);
    }
  });

  addAuditEntry('broadcast', 'Geofence Zone Created', zone.createdBy, `Zone ${zone.id}: ${zone.severity} — ${zone.radiusKm}km radius`);
  broadcastMessage({ type: 'geofenceZoneCreated', data: zone });
  res.json({ success: true, zone });
});

// List geofence zones
app.get('/dispatch/geofence/zones', (req, res) => {
  const zones = Array.from(geofenceZones.values()).map(z => ({
    ...z,
    respondersInside: responderZoneState.get(z.id)?.size || 0,
  }));
  res.json(zones);
});

// Delete geofence zone
app.delete('/dispatch/geofence/zones/:id', (req, res) => {
  const zoneId = req.params.id;
  if (!geofenceZones.has(zoneId)) return res.status(404).json({ error: 'Zone not found' });
  geofenceZones.delete(zoneId);
  responderZoneState.delete(zoneId);
  addAuditEntry('broadcast', 'Geofence Zone Deleted', 'Dispatch Console', `Zone ${zoneId} removed`);
  broadcastMessage({ type: 'geofenceZoneDeleted', data: { zoneId } });
  res.json({ success: true });
});

// Geofence events log
app.get('/dispatch/geofence/events', (req, res) => {
  res.json({ success: true, events: geofenceEvents.slice(0, 100) });
});

// Simulate responder movement (for testing geofence entry/exit)
app.post('/dispatch/geofence/simulate-move', (req, res) => {
  const { responderId, latitude, longitude } = req.body;
  if (!responderId || latitude == null || longitude == null) {
    return res.status(400).json({ error: 'responderId, latitude, longitude required' });
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
  broadcastMessage({
    type: 'responderLocationUpdate',
    userId: responderId,
    location: { latitude, longitude },
    timestamp: Date.now(),
  });

  res.json({ success: true, responderId, location: { latitude, longitude } });
});

// ─── Map REST API ───────────────────────────────────────────────────

// Map: all users with locations (for map display)
app.get('/dispatch/map/users', (req, res) => {
  const now = Date.now();
  // Combine real connected users with demo user locations
  const connectedUsersList = Array.from(users.values())
    .filter(u => u.location && u.role !== 'responder')
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

  // Demo users with Geneva locations (Champel, Florissant, Malagnou, Vésenaz)
  const demoUserLocations = [
    { id: 'user-001', name: 'Thomas Leroy', role: 'user', status: 'active', location: { latitude: 46.1940, longitude: 6.1560 }, lastSeen: now - 3 * 3600000 },
    { id: 'user-002', name: 'Julie Morel', role: 'user', status: 'active', location: { latitude: 46.1950, longitude: 6.1670 }, lastSeen: now - 6 * 3600000 },
    { id: 'user-004', name: 'Lea Leroy', role: 'user', status: 'active', location: { latitude: 46.2020, longitude: 6.1640 }, lastSeen: now - 45 * 60000 },
    { id: 'user-005', name: 'Hugo Leroy', role: 'user', status: 'active', location: { latitude: 46.2320, longitude: 6.2070 }, lastSeen: now - 2 * 86400000 },
    { id: 'disp-001', name: 'Jean Moreau', role: 'dispatcher', status: 'active', location: { latitude: 46.1955, longitude: 6.1675 }, lastSeen: now - 12 * 60000 },
    { id: 'disp-002', name: 'Sophie Laurent', role: 'dispatcher', status: 'active', location: { latitude: 46.2005, longitude: 6.1615 }, lastSeen: now - 2 * 3600000 },
    { id: 'admin-001', name: 'Marie Dupont', role: 'admin', status: 'active', location: { latitude: 46.1925, longitude: 6.1535 }, lastSeen: now - 5 * 60000 },
  ];

  // Merge: real users override demo ones by id
  const mergedIds = new Set(connectedUsersList.map(u => u.id));
  const merged = [
    ...connectedUsersList,
    ...demoUserLocations.filter(d => !mergedIds.has(d.id)),
  ];
  res.json(merged);
});

// Map: all entities combined (incidents + responders + users)
app.get('/dispatch/map/all', (req, res) => {
  const now = Date.now();
  const allAlerts = Array.from(alerts.values()).map(a => ({
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

// Helper: resolve group participants dynamically
function resolveGroupParticipants(conv: Conversation): string[] {
  const ids = new Set(conv.participantIds);
  const activeStatuses = ['active', 'available', 'on_duty'];
  if (conv.filterRole) {
    adminUsers.forEach((u) => {
      if (u.role === conv.filterRole && activeStatuses.includes(u.status)) ids.add(u.id);
    });
  }
  if (conv.filterTags && conv.filterTags.length > 0) {
    adminUsers.forEach((u) => {
      if (activeStatuses.includes(u.status) && u.tags && conv.filterTags!.some(t => u.tags!.includes(t))) ids.add(u.id);
    });
  }
  return Array.from(ids);
}

// GET /api/users - list all active users (for contact list)
app.get('/api/users', (req, res) => {
  const allUsers = Array.from(adminUsers.values())
    .filter(u => u.status === 'active')
    .map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, tags: u.tags || [] }));
  res.json(allUsers);
});

// GET /api/tags - list all unique tags
app.get('/api/tags', (req, res) => {
  const tagSet = new Set<string>();
  adminUsers.forEach(u => (u.tags || []).forEach(t => tagSet.add(t)));
  res.json(Array.from(tagSet).sort());
});

// PUT /api/users/:id/tags - update user tags
app.put('/api/users/:id/tags', (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.tags = req.body.tags || [];
  adminUsers.set(user.id, user);
  res.json({ success: true, user: { id: user.id, name: user.name, tags: user.tags } });
});

// GET /api/conversations?userId=xxx - list conversations for a user
app.get('/api/conversations', (req, res) => {
  const userId = req.query.userId as string;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const userConvos: any[] = [];
  conversations.forEach((conv) => {
    const allParticipants = resolveGroupParticipants(conv);
    if (allParticipants.includes(userId) || conv.createdBy === userId) {
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
  const { type, name, participantIds, filterRole, filterTags, createdBy } = req.body;
  if (!createdBy) return res.status(400).json({ error: 'createdBy required' });
  if (!type) return res.status(400).json({ error: 'type required (direct or group)' });

  // For direct conversations, check if one already exists between these two users
  if (type === 'direct' && participantIds && participantIds.length === 2) {
    const sorted = [...participantIds].sort();
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
    participantIds: participantIds || [createdBy],
    filterRole: filterRole || undefined,
    filterTags: filterTags || undefined,
    createdBy,
    createdAt: Date.now(),
    lastMessageTime: Date.now(),
    lastMessage: '',
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

// POST /api/conversations/:id/media - upload image or audio
app.post('/api/conversations/:id/media', uploadMedia.single('file'), async (req: any, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const { senderId, senderName, mediaType } = req.body;
  if (!senderId) return res.status(400).json({ error: 'senderId required' });

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
  const msgType = mediaType === 'audio' ? 'audio' : mediaType === 'document' ? 'document' : 'image';
  const fileName = req.body.fileName || req.file.originalname || 'Document';
  const text = mediaType === 'audio' ? '🎤 Message vocal' : mediaType === 'document' ? `📎 ${fileName}` : '📷 Photo';

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

  const allParticipants = resolveGroupParticipants(conv);
  const wsPayload = JSON.stringify({ type: 'newMessage', data: { ...msg, conversationName: conv.name, conversationType: conv.type } });
  allParticipants.forEach(pid => {
    const conns = userConnections.get(pid);
    if (conns) conns.forEach(ws => { try { ws.send(wsPayload); } catch {} });
  });

  for (const pid of allParticipants) {
    if (pid === senderId) continue;
    sendPushToUser(pid, `${msgType === 'audio' ? '🎤' : '📷'} ${msg.senderName}`,
      msgType === 'audio' ? 'Message vocal' : msgType === 'document' ? 'Document partagé' : 'Photo',
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
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
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
  const { senderId, text, type: msgType } = req.body;
  if (!senderId || !text) return res.status(400).json({ error: 'senderId and text required' });

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
  const allPartsForUnread = resolveGroupParticipants(conv);
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
  const allParticipants = resolveGroupParticipants(conv);
  const wsPayload = JSON.stringify({
    type: 'newMessage',
    data: { ...msg, conversationName: conv.name, conversationType: conv.type },
  });
  allParticipants.forEach(pid => {
    const conns = userConnections.get(pid);
    if (conns) {
      conns.forEach(ws => {
        try { ws.send(wsPayload); } catch (e) { /* ignore */ }
      });
    }
  });
  // Also broadcast to all dispatcher connections (so dispatch console always receives)
  userConnections.forEach((conns, uid) => {
    const u = adminUsers.get(uid);
    if (u && (u.role === 'dispatcher' || u.role === 'admin') && !allParticipants.includes(uid)) {
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
app.get('/api/messaging/users', (_req, res) => {
  const users = Array.from(adminUsers.values()).map(u => ({
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
  const userId = req.query.userId as string;
  const allConvs = Array.from(conversations.values());
  const filtered = userId
    ? allConvs.filter(c => {
        const participants = resolveGroupParticipants(c);
        return participants.includes(userId);
      })
    : allConvs;
  const result = filtered.map(c => {
    const msgs = messages.get(c.id) || [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return {
      ...c,
      participants: resolveGroupParticipants(c),
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
  const { type, name, groupType, createdBy, participants, tags } = req.body;
  if (!type || !createdBy) return res.status(400).json({ error: 'type and createdBy required' });

  let finalParticipants = participants || [];

  // If tags are provided, resolve participants by tags
  if (tags && tags.length > 0 && (!participants || participants.length <= 1)) {
    const tagUsers = Array.from(adminUsers.values())
      .filter(u => u.tags && u.tags.some((t: string) => tags.includes(t)))
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
  const { senderId, senderName, content } = req.body;
  if (!senderId || !content) return res.status(400).json({ error: 'senderId and content required' });

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
  const allPartsMsg = resolveGroupParticipants(conv);
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
  const allParticipants = resolveGroupParticipants(conv);
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
  // Also broadcast to all dispatcher/admin connections
  userConnections.forEach((conns, uid) => {
    const u = adminUsers.get(uid);
    if (u && (u.role === 'dispatcher' || u.role === 'admin') && !allParticipants.includes(uid)) {
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
app.get('/api/messaging/tags', (_req, res) => {
  const tagSet = new Set<string>();
  adminUsers.forEach(u => (u.tags || []).forEach((t: string) => tagSet.add(t)));
  res.json({ tags: [...tagSet].sort() });
});
// ─── Patrol Reports REST API ─────────────────────────────────────────────────────────────

// Predefined patrol sites (Geneva communes)
const PATROL_SITES = [
  'Champel — Avenue de Champel 24',
  'Champel — Chemin des Crêts-de-Champel 2',
  'Florissant — Route de Florissant 62',
  'Florissant — Avenue de Miremont 30',
  'Malagnou — Route de Malagnou 32',
  'Malagnou — Chemin du Velours 10',
  'Vésenaz — Route de Thonon 85',
  'Vésenaz — Chemin de la Capite 12',
];

// Predefined patrol statuses with severity levels
const PATROL_STATUS_CONFIG: Record<PatrolStatus, { label: string; color: string; severity: number }> = {
  habituel:       { label: 'Habituel',       color: '#22C55E', severity: 0 },
  inhabituel:     { label: 'Inhabituel',     color: '#EAB308', severity: 1 },
  identification: { label: 'Identification', color: '#F97316', severity: 2 },
  suspect:        { label: 'Suspect',        color: '#EF4444', severity: 3 },
  menace:         { label: 'Menace',         color: '#8B5CF6', severity: 4 },
  attaque:        { label: 'Attaque',        color: '#000000', severity: 5 },
};

// GET /api/patrol/sites - list predefined patrol sites
app.get('/api/patrol/sites', (_req, res) => {
  res.json({ sites: PATROL_SITES });
});

// GET /api/patrol/statuses - list predefined patrol statuses
app.get('/api/patrol/statuses', (_req, res) => {
  res.json({ statuses: PATROL_STATUS_CONFIG });
});

// POST /api/patrol/reports - create a new patrol report
app.post('/api/patrol/reports', (req, res) => {
  const { createdBy, location, status, tasks, notes } = req.body;
  if (!createdBy || !location || !status || !tasks) {
    return res.status(400).json({ error: 'createdBy, location, status, and tasks are required' });
  }

  // Validate status
  if (!PATROL_STATUS_CONFIG[status as PatrolStatus]) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${Object.keys(PATROL_STATUS_CONFIG).join(', ')}` });
  }

  // Validate role: only responders can create patrol reports
  const user = adminUsers.get(createdBy);
  if (!user || (user.role !== 'responder' && user.role !== 'dispatcher' && user.role !== 'admin')) {
    return res.status(403).json({ error: 'Only responders, dispatchers, and admins can create patrol reports' });
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
    broadcastToRole('dispatcher', alertMsg);
    broadcastToRole('admin', alertMsg);

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
  const userId = req.query.userId as string;
  const role = req.query.role as string;
  const locationFilter = req.query.location as string;
  const statusFilter = req.query.status as string;
  const limit = Math.min(Number(req.query.limit) || 100, 500);

  // Access control: only responders, dispatchers, and admins
  if (userId) {
    const user = adminUsers.get(userId);
    if (user && user.role === 'user') {
      return res.status(403).json({ error: 'Regular users cannot access patrol reports' });
    }
  }

  let filtered = [...patrolReports];
  if (locationFilter) {
    filtered = filtered.filter(r => r.location === locationFilter);
  }
  if (statusFilter) {
    filtered = filtered.filter(r => r.status === statusFilter);
  }
  // Responders only see their own reports; dispatchers/admins see all
  if (role === 'responder' && userId) {
    filtered = filtered.filter(r => r.createdBy === userId);
  }

  res.json({ reports: filtered.slice(0, limit), total: filtered.length });
});

// GET /api/patrol/reports/:id - get a single patrol report
app.get('/api/patrol/reports/:id', (req, res) => {
  const report = patrolReports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Patrol report not found' });
  res.json(report);
});

// POST /api/patrol/reports/:id/media - upload media (photo/video) to a patrol report
app.post('/api/patrol/reports/:id/media', uploadMedia.single('media'), (req: any, res) => {
  const report = patrolReports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Patrol report not found' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const ext = req.file.originalname.split('.').pop()?.toLowerCase() || '';
  const isVideo = ['mp4', 'mov', 'avi', 'webm', 'm4v'].includes(ext);
  const mediaItem: PatrolMedia = {
    id: uuidv4().slice(0, 8),
    type: isVideo ? 'video' : 'photo',
    url: `/uploads/${req.file.filename}`,
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

  // Send to all connected clients that have the right role for this channel
  // Use wsClientMap for O(1) lookup instead of searching userConnections
  wss.clients.forEach((client: any) => {
    if (client.readyState !== 1) return;
    // Don't echo back to sender (they already have it locally)
    if (client === ws) return;
    const connUserId = wsClientMap.get(client);
    if (!connUserId) return;
    const connUserData = users.get(connUserId);
    if (!connUserData) return;
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
      // Uploader l'audio dans Supabase Storage
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      const audioFileName = `${Date.now()}-ptt-dispatch.m4a`;
      const { data: uploadData, error: uploadError } = await supabaseAdmin.storage
        .from('media')
        .upload(audioFileName, audioBuffer, { contentType: mimeType || 'audio/webm', upsert: false });
      
      if (!uploadError && uploadData) {
        const { data: { publicUrl } } = supabaseAdmin.storage.from('media').getPublicUrl(audioFileName);
        
        // Trouver ou créer une conversation avec chaque user connecté au canal
        const channelUsers = channel.allowedRoles.includes('user' as any) ? 
          Array.from(adminUsers.values()).filter(u => u.role === 'user' || u.role === 'responder') : [];
        
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
    } catch (e) { console.error('[PTT→Msg] Error:', e); }
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

  wss.clients.forEach((client: any) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    const connUserId = wsClientMap.get(client);
    if (!connUserId) return;
    const connUserData = users.get(connUserId);
    if (!connUserData) return;
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

  wss.clients.forEach((client: any) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    client.send(broadcastData);
  });

  // Also send push notifications to everyone
  const allUserIds = Array.from(users.keys());
  allUserIds.forEach(uid => {
    if (uid === userId) return;
    const tokens = pushTokens.get(uid);
    if (tokens) {
      tokens.forEach(token => {
        sendPushNotification(token, {
          title: '🚨 ALERTE URGENCE PTT',
          body: `Message d'urgence de ${senderName} (${userRole})`,
          data: { type: 'pttEmergency', messageId: emergencyMsg.id },
        });
      });
    }
  });

  ws.send(JSON.stringify({ type: 'pttEmergencyAck', messageId: emergencyMsg.id }));
}

// ─── PTT REST API ──────────────────────────────────────────────────────────────────────────────

// GET /api/ptt/channels - list all channels accessible by the user
app.get('/api/ptt/channels', (req, res) => {
  const userRole = (req.query.role as string) || 'user';
  const userId = req.query.userId as string;
  const accessible = pttChannels.filter(ch => {
    if (userRole === 'admin') return true;
    // Dispatchers see all channels including direct channels (for monitoring)
    if (userRole === 'dispatcher') {
      if (!ch.allowedRoles.includes('dispatcher')) return false;
      return true;
    }
    if (!ch.allowedRoles.includes(userRole as any)) return false;
    // For member-restricted channels, check membership
    if (ch.members && ch.members.length > 0 && !ch.members.includes(userId)) return false;
    return true;
  });
  res.json(accessible);
});

// POST /api/ptt/channels - create a custom channel (dispatcher/admin only)
app.post('/api/ptt/channels', (req, res) => {
  const { name, description, allowedRoles, members, createdBy, createdByRole } = req.body;
  if (!name || !createdBy) {
    return res.status(400).json({ error: 'name and createdBy are required' });
  }
  if (createdByRole !== 'dispatcher' && createdByRole !== 'admin') {
    return res.status(403).json({ error: 'Only dispatchers and admins can create channels' });
  }

  const channel: PTTChannelServer = {
    id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    name,
    description: description || '',
    allowedRoles: allowedRoles || ['user', 'responder', 'dispatcher', 'admin'],
    isActive: true,
    isDefault: false,
    createdBy,
    createdAt: Date.now(),
    members: members || [],
  };

  pttChannels.push(channel);
  persistPTTChannels();

  // Broadcast new channel to all clients
  broadcastMessage({ type: 'pttChannelCreated', data: channel });

  console.log(`[PTT] Channel "${name}" created by ${createdBy}`);
  res.json(channel);
});

// DELETE /api/ptt/channels/:id - delete a custom channel (dispatcher/admin only)
app.delete('/api/ptt/channels/:id', (req, res) => {
  const { id } = req.params;
  const { userRole } = req.query;
  if (userRole !== 'dispatcher' && userRole !== 'admin') {
    return res.status(403).json({ error: 'Only dispatchers and admins can delete channels' });
  }
  const idx = pttChannels.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Channel not found' });
  if (pttChannels[idx].isDefault) return res.status(400).json({ error: 'Cannot delete default channels' });

  const removed = pttChannels.splice(idx, 1)[0];
  deletePTTChannelFromSupabase(id);
  persistPTTChannels();

  // Also remove messages for this channel
  pttMessages = pttMessages.filter(m => m.channelId !== id);
  persistPTTMessages();

  broadcastMessage({ type: 'pttChannelDeleted', channelId: id });
  console.log(`[PTT] Channel "${removed.name}" deleted`);
  res.json({ success: true });
});

// POST /api/ptt/channels/direct - create or find a direct 1-on-1 PTT channel between two users
app.post('/api/ptt/channels/direct', (req, res) => {
  const { userId1, userId2, userName1, userName2 } = req.body;
  if (!userId1 || !userId2) {
    return res.status(400).json({ error: 'userId1 and userId2 are required' });
  }
  // Check if a direct channel already exists between these two users
  const existing = pttChannels.find(ch =>
    ch.members && ch.members.length === 2 &&
    ch.members.includes(userId1) && ch.members.includes(userId2) &&
    ch.id.startsWith('direct-')
  );
  if (existing) {
    return res.json(existing);
  }
  // Create a new direct channel
  const name1 = userName1 || userId1;
  const name2 = userName2 || userId2;
  const channel: PTTChannelServer = {
    id: `direct-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    name: `${name1} ↔ ${name2}`,
    description: `Appel direct entre ${name1} et ${name2}`,
    allowedRoles: ['user', 'responder', 'dispatcher', 'admin'],
    isActive: true,
    isDefault: false,
    createdBy: userId1,
    createdAt: Date.now(),
    members: [userId1, userId2],
  };
  pttChannels.push(channel);
  persistPTTChannels();
  // Broadcast to both users and all dispatchers/admins
  broadcastMessage({ type: 'pttChannelCreated', data: channel });
  console.log(`[PTT] Direct channel created: ${name1} ↔ ${name2}`);
  res.json(channel);
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

  // Broadcast via WebSocket to all eligible clients
  broadcastMessage({
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

// ─── Start server ─────────────────────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
// Avoid 504 Gateway Timeout from reverse proxies
// Keep-alive timeout must be > proxy timeout (typically 60s)
server.keepAliveTimeout = 65000; // 65 seconds
server.headersTimeout = 66000;   // slightly > keepAliveTimeout

server.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`Talion Crisis Comm Server running on port ${PORT}`);
  // Charger toutes les données depuis Supabase avant d'accepter les requêtes
  await Promise.all([
    loadAdminUsersFromSupabase(),
    loadAlertsFromSupabase(),
    loadPatrolReportsFromSupabase(),
    loadPTTChannelsFromSupabase(),
    loadFamilyPerimetersFromSupabase(),
    loadPushTokensFromSupabase(),
    loadUserAddressesFromSupabase(),
    loadConversationsFromSupabase(),
    loadMessagesFromSupabase(),
  ]);
  console.log('[Startup] All Supabase data loaded — ready to serve requests');
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
        });
      });
      console.log(`[Supabase] Loaded ${data.length} users from admin_users`);
    }
  } catch (e) { console.error('[Supabase] loadAdminUsersFromSupabase error:', e); }
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
          createdAt: a.created_at,
          location: a.location || { latitude: 0, longitude: 0, address: 'Unknown' },
          respondingUsers: a.responding_users || [],
          responderStatuses: a.responder_statuses || {},
          statusHistory: a.status_history || [],
          photos: a.photos || [],
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
      created_at: alert.createdAt,
      location: alert.location,
      responding_users: alert.respondingUsers || [],
      responder_statuses: alert.responderStatuses || {},
      status_history: alert.statusHistory || [],
      photos: alert.photos || [],
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
      filter_tags: conv.filterTags || null, created_by: conv.createdBy,
      created_at: conv.createdAt, last_message: conv.lastMessage || '',
      last_message_time: conv.lastMessageTime || 0,
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
          filterTags: c.filter_tags, createdBy: c.created_by,
          createdAt: c.created_at, lastMessage: c.last_message || '',
          lastMessageTime: c.last_message_time || 0,
          unreadCounts: c.unread_counts || {},
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

// POST /api/livekit/token - générer un token pour rejoindre une room
app.post('/api/livekit/token', async (req, res) => {
  const { userId, userName, roomName } = req.body;
  if (!userId || !roomName) return res.status(400).json({ error: 'userId and roomName required' });

  try {
    const { AccessToken } = await import('livekit-server-sdk');
    const apiKey = process.env.LIVEKIT_API_KEY || 'talioncd15c681';
    const apiSecret = process.env.LIVEKIT_API_SECRET || '759155227f75206216d399f37e676a010a92658ef655727358dddba0271c9f0f';
    const livekitUrl = process.env.LIVEKIT_URL || 'wss://talion-livekit.onrender.com';
    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: userName || userId,
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
    console.log(`[LiveKit] Token généré pour ${userName} dans room ${roomName}`);
  } catch (e: any) {
    console.error('[LiveKit] Token error:', e);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/livekit/rooms - lister les rooms actives (pour le dispatch)
app.get('/api/livekit/rooms', async (req, res) => {
  res.json({
    rooms: [
      { name: 'dispatch', label: 'Canal Dispatch', type: 'group' },
    ],
    livekitUrl: process.env.LIVEKIT_URL || 'wss://talion-livekit.onrender.com',
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
          createdAt: a.created_at, updatedAt: a.updated_at,
        };
        if (!userAddresses.has(addr.userId)) userAddresses.set(addr.userId, []);
        userAddresses.get(addr.userId)!.push(addr);
      });
      console.log(`[Supabase] Loaded ${data.length} user addresses`);
    }
  } catch (e) { console.error('[Supabase] loadUserAddressesFromSupabase error:', e); }
}

// ─── User Addresses REST API ──────────────────────────────────────────────

// GET /api/users/:id/addresses
app.get('/api/users/:id/addresses', (req, res) => {
  const addresses = userAddresses.get(req.params.id) || [];
  res.json(addresses);
});

// POST /api/users/:id/addresses
app.post('/api/users/:id/addresses', async (req, res) => {
  const { label, address, latitude, longitude, placeId, isPrimary, alarmCode, notes } = req.body;
  if (!label || !address) return res.status(400).json({ error: 'label and address are required' });
  const userId = req.params.id;
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
    createdAt: now, updatedAt: now,
  };
  // If primary, unset other primary addresses
  if (isPrimary) {
    const existing = userAddresses.get(userId) || [];
    existing.forEach(a => { if (a.isPrimary) a.isPrimary = false; });
  }
  if (!userAddresses.has(userId)) userAddresses.set(userId, []);
  userAddresses.get(userId)!.push(newAddr);
  // Save to Supabase
  await supabaseAdmin.from('user_addresses').insert({
    id: newAddr.id, user_id: userId, label, address,
    latitude: newAddr.latitude, longitude: newAddr.longitude,
    place_id: newAddr.placeId, is_primary: newAddr.isPrimary,
    alarm_code: newAddr.alarmCode, notes: newAddr.notes,
    created_at: now, updated_at: now,
  });
  res.status(201).json(newAddr);
});

// PUT /api/users/:id/addresses/:addressId
app.put('/api/users/:id/addresses/:addressId', async (req, res) => {
  const { label, address, latitude, longitude, placeId, isPrimary, alarmCode, notes } = req.body;
  const userId = req.params.id;
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
    updatedAt: Date.now() };
  addresses[idx] = updated;
  await supabaseAdmin.from('user_addresses').update({
    label: updated.label, address: updated.address, latitude: updated.latitude,
    longitude: updated.longitude, is_primary: updated.isPrimary,
    alarm_code: updated.alarmCode, notes: updated.notes, updated_at: updated.updatedAt,
  }).eq('id', updated.id);
  res.json(updated);
});

// DELETE /api/users/:id/addresses/:addressId
app.delete('/api/users/:id/addresses/:addressId', async (req, res) => {
  const userId = req.params.id;
  const addresses = userAddresses.get(userId) || [];
  const idx = addresses.findIndex(a => a.id === req.params.addressId);
  if (idx === -1) return res.status(404).json({ error: 'Address not found' });
  addresses.splice(idx, 1);
  await supabaseAdmin.from('user_addresses').delete().eq('id', req.params.addressId);
  res.json({ success: true });
});


// POST /api/admin/geocode-addresses — géocode rétroactivement toutes les adresses sans coords
app.post('/api/admin/geocode-addresses', async (req, res) => {
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
app.get('/api/alerts/:id/context', async (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Alert not found' });

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
  if (!user) return res.json({ alert, user: null, addresses: [], family: [], locationContext: null });

  // Get user addresses
  const addresses = userAddresses.get(resolvedUserId) || [];

  // Detect proximity to known addresses
  let locationContext = null;
  if (alert.location?.latitude && alert.location?.longitude && addresses.length > 0) {
    let closest = null;
    let minDist = Infinity;
    for (const addr of addresses) {
      if (!addr.latitude || !addr.longitude) continue;
      const dist = haversineDistance(alert.location.latitude, alert.location.longitude, addr.latitude, addr.longitude);
      if (dist < minDist) { minDist = dist; closest = addr; }
    }
    if (closest && minDist < 500) {
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
    return { id: member.id, name: member.name, role: rel.type, phone: member.phoneMobile, photoUrl: member.photoUrl };
  }).filter(Boolean);

  const { passwordHash, ...safeUser } = user;
  res.json({ user: { ...safeUser, hasPassword: !!user.passwordHash }, addresses, family, locationContext });
});
// livekit-server-sdk installed
