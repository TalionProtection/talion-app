"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// server/index.ts
var index_exports = {};
__export(index_exports, {
  app: () => app,
  server: () => server,
  wss: () => wss
});
module.exports = __toCommonJS(index_exports);
var import_express = __toESM(require("express"));
var import_http = require("http");
var import_ws = require("ws");
var import_uuid = require("uuid");
var import_cors = __toESM(require("cors"));
var import_path = __toESM(require("path"));
var import_bcryptjs = __toESM(require("bcryptjs"));
var import_multer = __toESM(require("multer"));
var import_fs = __toESM(require("fs"));

// server/auth-middleware.ts
var import_supabase_js = require("@supabase/supabase-js");
var _supabaseAdmin = null;
function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
    _supabaseAdmin = (0, import_supabase_js.createClient)(url, key, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }
  return _supabaseAdmin;
}
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ error: "Missing or invalid Authorization header" });
  const token = authHeader.split(" ")[1];
  try {
    const supabase = getSupabaseAdmin();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: "Invalid or expired token" });
    const { data: adminUser } = await supabase.from("admin_users").select("role").eq("id", user.id).single();
    const role = adminUser?.role ?? "user";
    req.supabaseUser = { id: user.id, email: user.email, role };
    next();
  } catch (err) {
    console.error("[requireAuth] Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// server/index.ts
var import_supabase_js2 = require("@supabase/supabase-js");
var supabaseAdmin = (0, import_supabase_js2.createClient)(
  process.env.SUPABASE_URL || "",
  process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  { auth: { autoRefreshToken: false, persistSession: false } }
);
var app = (0, import_express.default)();
var server = (0, import_http.createServer)(app);
var wss = new import_ws.WebSocketServer({ server, maxPayload: 50 * 1024 * 1024 });
app.use((0, import_cors.default)());
app.use(import_express.default.json({ limit: "50mb" }));
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.warn("[Auth] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set \u2014 auth middleware disabled");
}
var PROJECT_ROOT = import_path.default.resolve(__dirname, "..");
var dataDir = import_path.default.join(PROJECT_ROOT, "data");
if (!import_fs.default.existsSync(dataDir)) import_fs.default.mkdirSync(dataDir, { recursive: true });
var ALERTS_FILE = import_path.default.join(dataDir, "alerts.json");
var LOCATION_HISTORY_FILE = import_path.default.join(dataDir, "location-history.json");
var FAMILY_PERIMETERS_FILE = import_path.default.join(dataDir, "family-perimeters.json");
var PROXIMITY_ALERTS_FILE = import_path.default.join(dataDir, "proximity-alerts.json");
var PATROL_REPORTS_FILE = import_path.default.join(dataDir, "patrol-reports.json");
var PTT_CHANNELS_FILE = import_path.default.join(dataDir, "ptt-channels.json");
var PTT_MESSAGES_FILE = import_path.default.join(dataDir, "ptt-messages.json");
function loadJsonFile(filePath, defaultValue) {
  try {
    if (import_fs.default.existsSync(filePath)) {
      return JSON.parse(import_fs.default.readFileSync(filePath, "utf-8"));
    }
  } catch (e) {
    console.error(`[Persist] Failed to load ${filePath}:`, e);
  }
  return defaultValue;
}
function saveJsonFile(filePath, data) {
  try {
    import_fs.default.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (e) {
    console.error(`[Persist] Failed to save ${filePath}:`, e);
  }
}
var ACCEPTANCE_TIMEOUT_MS = 5 * 60 * 1e3;
var acceptanceTimers = /* @__PURE__ */ new Map();
function startAcceptanceTimer(alertId, responderId) {
  const timerKey = `${alertId}:${responderId}`;
  const existing = acceptanceTimers.get(timerKey);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    acceptanceTimers.delete(timerKey);
    const alert = alerts.get(alertId);
    if (!alert) return;
    const currentStatus = alert.responderStatuses?.[responderId];
    if (currentStatus && currentStatus !== "assigned") return;
    const responderName = adminUsers.get(responderId)?.name || responderId;
    console.log(`[AcceptanceTimer] ${responderName} did not accept incident ${alertId} within 5 minutes`);
    if (!alert.statusHistory) alert.statusHistory = [];
    alert.statusHistory.push({
      responderId,
      responderName,
      status: "assigned",
      // still assigned, but timed out
      timestamp: Date.now()
    });
    addAuditEntry("incident", "Acceptance Timeout", "System", `${responderName} n'a pas accept\xE9 l'incident ${alertId} dans les 5 minutes`, responderId);
    const TYPE_LABELS = {
      sos: "SOS",
      medical: "M\xE9dical",
      fire: "Incendie",
      security: "S\xE9curit\xE9",
      accident: "Accident",
      broadcast: "Broadcast",
      other: "Autre",
      home_jacking: "Home-Jacking",
      cambriolage: "Cambriolage",
      animal_perdu: "Animal perdu",
      evenement_climatique: "\xC9v\xE9nement climatique",
      rodage: "Rodage",
      vehicule_suspect: "V\xE9hicule suspect",
      fugue: "Fugue",
      route_bloquee: "Route bloqu\xE9e",
      route_fermee: "Route ferm\xE9e"
    };
    const typeLabel = TYPE_LABELS[alert.type] || alert.type;
    const notifiedDispatchers = /* @__PURE__ */ new Set();
    for (const [_token, entry] of pushTokens) {
      if ((entry.userRole === "dispatcher" || entry.userRole === "admin") && !notifiedDispatchers.has(entry.userId)) {
        notifiedDispatchers.add(entry.userId);
        sendPushToUser(
          entry.userId,
          `\u23F0 D\xE9lai d'acceptation d\xE9pass\xE9`,
          `${responderName} n'a pas accept\xE9 l'incident ${typeLabel} (${alertId}) dans les 5 minutes. Veuillez r\xE9assigner.`,
          { type: "acceptance_timeout", alertId, responderId }
        ).catch(() => {
        });
      }
    }
    broadcastMessage({
      type: "acceptanceTimeout",
      alertId,
      responderId,
      responderName,
      timestamp: Date.now()
    });
  }, ACCEPTANCE_TIMEOUT_MS);
  acceptanceTimers.set(timerKey, timer);
}
function clearAcceptanceTimer(alertId, responderId) {
  const timerKey = `${alertId}:${responderId}`;
  const timer = acceptanceTimers.get(timerKey);
  if (timer) {
    clearTimeout(timer);
    acceptanceTimers.delete(timerKey);
  }
}
var saveTimers = /* @__PURE__ */ new Map();
function debouncedSave(filePath, data, delayMs = 2e3) {
  const existing = saveTimers.get(filePath);
  if (existing) clearTimeout(existing);
  saveTimers.set(filePath, setTimeout(() => {
    saveJsonFile(filePath, data);
    saveTimers.delete(filePath);
  }, delayMs));
}
var uploadsDir = import_path.default.join(PROJECT_ROOT, "uploads");
if (!import_fs.default.existsSync(uploadsDir)) import_fs.default.mkdirSync(uploadsDir, { recursive: true });
var storage = import_multer.default.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")}`)
});
var upload = (0, import_multer.default)({ storage, limits: { fileSize: 5 * 1024 * 1024 } });
var uploadMedia = (0, import_multer.default)({ storage, limits: { fileSize: 50 * 1024 * 1024 } });
app.use("/uploads", import_express.default.static(uploadsDir));
app.use("/assets", import_express.default.static(import_path.default.join(PROJECT_ROOT, "assets")));
var MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf"
};
function serveConsoleDynamic(basePath) {
  return (req, res) => {
    let filePath = req.path === "/" ? "/index.html" : req.path;
    filePath = filePath.split("?")[0];
    const fullPath = import_path.default.join(basePath, filePath);
    if (!fullPath.startsWith(basePath)) return res.status(403).send("Forbidden");
    try {
      if (!import_fs.default.existsSync(fullPath) || import_fs.default.statSync(fullPath).isDirectory()) {
        const indexPath = import_path.default.join(fullPath, "index.html");
        if (import_fs.default.existsSync(indexPath)) {
          const content2 = import_fs.default.readFileSync(indexPath, "utf-8");
          res.set("Content-Type", "text/html");
          res.set("Cache-Control", "no-cache, no-store, must-revalidate");
          res.set("Pragma", "no-cache");
          return res.send(content2);
        }
        return res.status(404).send("Not Found");
      }
      const ext = import_path.default.extname(fullPath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const content = import_fs.default.readFileSync(fullPath);
      res.set("Content-Type", mime);
      res.set("Cache-Control", "no-cache, no-store, must-revalidate");
      res.set("Pragma", "no-cache");
      res.set("Expires", "0");
      res.send(content);
    } catch (e) {
      res.status(500).send("Internal Server Error");
    }
  };
}
app.use("/admin-console", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "admin-web")));
app.use("/dispatch-v2", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "dispatch-web")));
app.use("/dispatch-console", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "dispatch-web")));
app.use("/console", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "console-login")));
app.use("/console-login", serveConsoleDynamic(import_path.default.join(PROJECT_ROOT, "server", "console-login")));
var loginHistory = [];
function parseDevice(ua) {
  if (!ua) return "Unknown";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux";
  return "Other";
}
function addLoginHistory(entry) {
  const record = {
    ...entry,
    id: `login-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    device: parseDevice(entry.userAgent)
  };
  loginHistory.unshift(record);
  if (loginHistory.length > 1e3) loginHistory.length = 1e3;
}
var users = /* @__PURE__ */ new Map();
var alerts = /* @__PURE__ */ new Map();
var userConnections = /* @__PURE__ */ new Map();
var wsClientMap = /* @__PURE__ */ new Map();
var adminUsers = /* @__PURE__ */ new Map();
var auditLog = [];
var responderStatusOverrides = /* @__PURE__ */ new Map();
var pushTokens = /* @__PURE__ */ new Map();
var conversations = /* @__PURE__ */ new Map();
var messages = /* @__PURE__ */ new Map();
var geofenceZones = /* @__PURE__ */ new Map();
var geofenceEvents = [];
var familyPerimeters = /* @__PURE__ */ new Map();
var proximityAlerts = [];
var perimeterState = /* @__PURE__ */ new Map();
var patrolReports = [];
var DEFAULT_PTT_CHANNELS = [
  { id: "emergency", name: "Urgence", description: "Canal d'urgence - tous les r\xF4les", allowedRoles: ["user", "responder", "dispatcher", "admin"], isActive: true, isDefault: true, createdBy: "system", createdAt: Date.now() },
  { id: "dispatch", name: "Dispatch", description: "Canal de coordination dispatch", allowedRoles: ["responder", "dispatcher", "admin"], isActive: true, isDefault: true, createdBy: "system", createdAt: Date.now() },
  { id: "responders", name: "Intervenants", description: "Canal \xE9quipe intervenants", allowedRoles: ["responder", "dispatcher", "admin"], isActive: true, isDefault: true, createdBy: "system", createdAt: Date.now() },
  { id: "general", name: "G\xE9n\xE9ral", description: "Canal de communication g\xE9n\xE9ral", allowedRoles: ["user", "responder", "dispatcher", "admin"], isActive: true, isDefault: true, createdBy: "system", createdAt: Date.now() }
];
var pttChannels = loadJsonFile(PTT_CHANNELS_FILE, [...DEFAULT_PTT_CHANNELS]);
var pttMessages = loadJsonFile(PTT_MESSAGES_FILE, []);
if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
function persistPTTChannels() {
  import_fs.default.writeFileSync(PTT_CHANNELS_FILE, JSON.stringify(pttChannels, null, 2));
  pttChannels.forEach((c) => savePTTChannelToSupabase(c));
}
function persistPTTMessages() {
  import_fs.default.writeFileSync(PTT_MESSAGES_FILE, JSON.stringify(pttMessages.slice(-200), null, 2));
}
var locationHistory = /* @__PURE__ */ new Map();
var MAX_HISTORY_PER_USER = 200;
var responderZoneState = /* @__PURE__ */ new Map();
function seedDemoData() {
  const now = Date.now();
  const hour = 36e5;
  const day = 864e5;
  const defaultPwHash = import_bcryptjs.default.hashSync("talion2026", 10);
  const demoUsers = [
    { id: "admin-001", firstName: "Marie", lastName: "Dupont", name: "Marie Dupont", email: "admin@talion.io", role: "admin", status: "active", lastLogin: now - 5 * 6e4, createdAt: now - 90 * day, tags: ["command", "zone-champel"], address: "Avenue de Champel 24, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 123 45 67", phoneLandline: "+41 22 700 00 01", comments: "Administratrice principale", passwordHash: defaultPwHash },
    { id: "disp-001", firstName: "Jean", lastName: "Moreau", name: "Jean Moreau", email: "dispatch@talion.io", role: "dispatcher", status: "active", lastLogin: now - 12 * 6e4, createdAt: now - 75 * day, tags: ["equipe-alpha", "zone-florissant"], address: "Route de Florissant 62, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 234 56 78", comments: "Dispatcher senior, equipe jour", passwordHash: defaultPwHash },
    { id: "disp-002", firstName: "Sophie", lastName: "Laurent", name: "Sophie Laurent", email: "dispatch2@talion.io", role: "dispatcher", status: "active", lastLogin: now - 2 * hour, createdAt: now - 60 * day, tags: ["equipe-bravo", "zone-malagnou"], address: "Route de Malagnou 32, 1208 Gen\xE8ve, Suisse", phoneMobile: "+41 79 345 67 89", passwordHash: defaultPwHash },
    { id: "resp-001", firstName: "Pierre", lastName: "Martin", name: "Pierre Martin", email: "responder@talion.io", role: "responder", status: "active", lastLogin: now - 8 * 6e4, createdAt: now - 80 * day, tags: ["equipe-alpha", "zone-champel", "medical"], address: "Chemin de Beau-Soleil 8, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 456 78 90", comments: "Secouriste certifie", passwordHash: defaultPwHash },
    { id: "resp-002", firstName: "Camille", lastName: "Bernard", name: "Camille Bernard", email: "responder2@talion.io", role: "responder", status: "active", lastLogin: now - 30 * 6e4, createdAt: now - 65 * day, tags: ["equipe-alpha", "zone-malagnou", "fire"], address: "Avenue de Frontenex 45, 1207 Gen\xE8ve, Suisse", phoneMobile: "+41 79 567 89 01", passwordHash: defaultPwHash },
    { id: "resp-003", firstName: "Lucas", lastName: "Petit", name: "Lucas Petit", email: "responder3@talion.io", role: "responder", status: "active", lastLogin: now - 1 * hour, createdAt: now - 50 * day, tags: ["equipe-bravo", "zone-vesenaz"], address: "Route de Thonon 85, 1222 V\xE9senaz, Suisse", phoneMobile: "+41 79 678 90 12", passwordHash: defaultPwHash },
    { id: "resp-004", firstName: "Emma", lastName: "Roux", name: "Emma Roux", email: "responder4@talion.io", role: "responder", status: "suspended", lastLogin: now - 5 * day, createdAt: now - 45 * day, tags: ["equipe-bravo", "medical"], address: "Chemin de la Capite 12, 1222 V\xE9senaz, Suisse", phoneMobile: "+41 79 789 01 23", passwordHash: defaultPwHash },
    { id: "user-001", firstName: "Thomas", lastName: "Leroy", name: "Thomas Leroy", email: "thomas@example.com", role: "user", status: "active", lastLogin: now - 3 * hour, createdAt: now - 30 * day, tags: ["zone-champel", "observateur"], address: "Avenue de Miremont 30, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 890 12 34", relationships: [{ userId: "user-002", type: "spouse" }, { userId: "user-004", type: "parent" }, { userId: "user-005", type: "parent" }], passwordHash: defaultPwHash },
    { id: "user-002", firstName: "Julie", lastName: "Morel", name: "Julie Morel", email: "julie@example.com", role: "user", status: "active", lastLogin: now - 6 * hour, createdAt: now - 25 * day, tags: ["zone-florissant", "observateur"], address: "Avenue de Miremont 30, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 901 23 45", relationships: [{ userId: "user-001", type: "spouse" }, { userId: "user-004", type: "parent" }, { userId: "user-005", type: "parent" }], passwordHash: defaultPwHash },
    { id: "user-003", firstName: "Nicolas", lastName: "Fournier", name: "Nicolas Fournier", email: "nicolas@example.com", role: "user", status: "deactivated", lastLogin: now - 15 * day, createdAt: now - 40 * day, tags: [], address: "Chemin du Velours 10, 1208 Gen\xE8ve, Suisse", passwordHash: defaultPwHash },
    { id: "user-004", firstName: "Lea", lastName: "Leroy", name: "Lea Leroy", email: "lea@example.com", role: "user", status: "active", lastLogin: now - 45 * 6e4, createdAt: now - 20 * day, tags: ["zone-champel"], address: "Avenue de Miremont 30, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 012 34 56", relationships: [{ userId: "user-005", type: "sibling" }, { userId: "user-001", type: "child" }, { userId: "user-002", type: "child" }], passwordHash: defaultPwHash },
    { id: "user-005", firstName: "Hugo", lastName: "Leroy", name: "Hugo Leroy", email: "hugo@example.com", role: "user", status: "active", lastLogin: now - 2 * day, createdAt: now - 10 * day, tags: ["zone-vesenaz"], address: "Avenue de Miremont 30, 1206 Gen\xE8ve, Suisse", phoneMobile: "+41 79 123 45 00", relationships: [{ userId: "user-004", type: "sibling" }, { userId: "user-001", type: "child" }, { userId: "user-002", type: "child" }], passwordHash: defaultPwHash }
  ];
  demoUsers.forEach((u) => adminUsers.set(u.id, u));
  const demoAudit = [
    { id: (0, import_uuid.v4)(), timestamp: now - 2 * 6e4, category: "incident", action: "Incident Created", performedBy: "Jean Moreau", details: "Created INC-001: Urgence m\xE9dicale \xE0 Avenue de Champel" },
    { id: (0, import_uuid.v4)(), timestamp: now - 5 * 6e4, category: "incident", action: "Incident Created", performedBy: "Sophie Laurent", details: "Created INC-008: Feu de cuisine au Chemin du Velours" },
    { id: (0, import_uuid.v4)(), timestamp: now - 5 * 6e4, category: "auth", action: "User Login", performedBy: "Marie Dupont", details: "Admin login from 192.168.1.100" },
    { id: (0, import_uuid.v4)(), timestamp: now - 8 * 6e4, category: "incident", action: "Alert Acknowledged", performedBy: "Pierre Martin", details: "Acknowledged INC-002: Alarme incendie Route de Florissant" },
    { id: (0, import_uuid.v4)(), timestamp: now - 12 * 6e4, category: "auth", action: "User Login", performedBy: "Jean Moreau", details: "Dispatcher login from mobile device" },
    { id: (0, import_uuid.v4)(), timestamp: now - 15 * 6e4, category: "user", action: "Role Changed", performedBy: "Marie Dupont", targetUser: "Lucas Petit", details: "Role changed from user to responder" },
    { id: (0, import_uuid.v4)(), timestamp: now - 30 * 6e4, category: "incident", action: "Responder Assigned", performedBy: "Jean Moreau", targetUser: "Camille Bernard", details: "Assigned to INC-003: Chemical spill" },
    { id: (0, import_uuid.v4)(), timestamp: now - 45 * 6e4, category: "incident", action: "Incident Resolved", performedBy: "Pierre Martin", details: "Resolved INC-005: Alerte SOS \xE0 V\xE9senaz" },
    { id: (0, import_uuid.v4)(), timestamp: now - 1 * hour, category: "broadcast", action: "Zone Broadcast Sent", performedBy: "Sophie Laurent", details: "Alerte broadcast dans un rayon de 2km autour de Route de Malagnou" },
    { id: (0, import_uuid.v4)(), timestamp: now - 2 * hour, category: "system", action: "Server Restart", performedBy: "System", details: "Scheduled maintenance restart completed" },
    { id: (0, import_uuid.v4)(), timestamp: now - 2 * hour, category: "incident", action: "Incident Resolved", performedBy: "Lucas Petit", details: "Resolved INC-006: Chute personne \xE2g\xE9e \xE0 V\xE9senaz" },
    { id: (0, import_uuid.v4)(), timestamp: now - 3 * hour, category: "user", action: "User Suspended", performedBy: "Marie Dupont", targetUser: "Emma Roux", details: "Suspended for policy violation" },
    { id: (0, import_uuid.v4)(), timestamp: now - 4 * hour, category: "incident", action: "Incident Resolved", performedBy: "Pierre Martin", details: "Resolved INC-007: Minor vehicle collision" },
    { id: (0, import_uuid.v4)(), timestamp: now - 5 * hour, category: "auth", action: "User Login", performedBy: "Thomas Leroy", details: "User login from mobile device" },
    { id: (0, import_uuid.v4)(), timestamp: now - 6 * hour, category: "system", action: "Backup Completed", performedBy: "System", details: "Automated daily backup completed successfully" },
    { id: (0, import_uuid.v4)(), timestamp: now - 1 * day, category: "user", action: "User Deactivated", performedBy: "Marie Dupont", targetUser: "Nicolas Fournier", details: "Account deactivated upon request" }
  ];
  auditLog.push(...demoAudit);
}
seedDemoData();
(function loadPersistedData() {
  const savedAlerts = loadJsonFile(ALERTS_FILE, []);
  if (savedAlerts.length > 0) {
    alerts.clear();
    savedAlerts.forEach((a) => alerts.set(a.id, a));
    console.log(`[Persist] Loaded ${savedAlerts.length} alerts from disk`);
  }
  const savedPerimeters = loadJsonFile(FAMILY_PERIMETERS_FILE, []);
  savedPerimeters.forEach((p) => familyPerimeters.set(p.id, p));
  if (savedPerimeters.length > 0) {
    console.log(`[Persist] Loaded ${savedPerimeters.length} family perimeters from disk`);
  }
  const savedProxAlerts = loadJsonFile(PROXIMITY_ALERTS_FILE, []);
  proximityAlerts.push(...savedProxAlerts);
  if (savedProxAlerts.length > 0) {
    console.log(`[Persist] Loaded ${savedProxAlerts.length} proximity alerts from disk`);
  }
  const savedHistory = loadJsonFile(LOCATION_HISTORY_FILE, {});
  for (const [uid, entries] of Object.entries(savedHistory)) {
    locationHistory.set(uid, entries);
  }
  const totalEntries = Object.values(savedHistory).reduce((sum, arr) => sum + arr.length, 0);
  if (totalEntries > 0) {
    console.log(`[Persist] Loaded ${totalEntries} location history entries for ${Object.keys(savedHistory).length} users`);
  }
  const savedPatrolReports = loadJsonFile(PATROL_REPORTS_FILE, []);
  patrolReports.push(...savedPatrolReports);
  if (savedPatrolReports.length > 0) {
    console.log(`[Persist] Loaded ${savedPatrolReports.length} patrol reports from disk`);
  }
})();
function persistAlerts() {
  debouncedSave(ALERTS_FILE, Array.from(alerts.values()));
  alerts.forEach((alert) => saveAlertToSupabase(alert));
}
function persistPerimeters() {
  debouncedSave(FAMILY_PERIMETERS_FILE, Array.from(familyPerimeters.values()));
  familyPerimeters.forEach((p) => saveFamilyPerimeterToSupabase(p));
}
function persistProximityAlerts() {
  debouncedSave(PROXIMITY_ALERTS_FILE, proximityAlerts);
}
function persistPatrolReports() {
  debouncedSave(PATROL_REPORTS_FILE, patrolReports);
  patrolReports.forEach((r) => savePatrolReportToSupabase(r));
}
function persistLocationHistory() {
  const obj = {};
  locationHistory.forEach((entries, uid) => {
    obj[uid] = entries;
  });
  debouncedSave(LOCATION_HISTORY_FILE, obj, 5e3);
}
function addAuditEntry(category, action, performedBy, details, targetUser) {
  auditLog.unshift({
    id: (0, import_uuid.v4)(),
    timestamp: Date.now(),
    category,
    action,
    performedBy,
    targetUser,
    details
  });
}
var WS_PING_INTERVAL = 25e3;
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("[WS] Terminating dead connection");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, WS_PING_INTERVAL);
wss.on("connection", (ws) => {
  console.log("New WebSocket connection");
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  let userId = null;
  let userRole = null;
  ws.on("message", (rawData) => {
    try {
      const dataStr = rawData.toString();
      const message = JSON.parse(dataStr);
      if (message.type === "pttTransmit" || message.type === "pttEmergency") {
        console.log(`[WS] Received ${message.type} from ${message.userId || userId}: ${(dataStr.length / 1024).toFixed(1)} KB total, audioBase64: ${message.data?.audioBase64 ? (message.data.audioBase64.length / 1024).toFixed(1) + " KB" : "MISSING"}`);
      }
      handleMessage(ws, message, (id, role) => {
        userId = id;
        userRole = role;
      }, userId, userRole);
    } catch (error) {
      console.error("Failed to parse message:", error);
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  });
  ws.on("close", () => {
    wsClientMap.delete(ws);
    if (userId) {
      console.log(`User ${userId} disconnected`);
      const conns = userConnections.get(userId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) userConnections.delete(userId);
      }
      broadcastUserStatus(userId, "offline");
    }
  });
  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});
function handleMessage(ws, message, setUserContext, connUserId, connUserRole) {
  const userId = message.userId || connUserId || void 0;
  const userRole = message.userRole || connUserRole || void 0;
  const { type, data, timestamp } = message;
  switch (type) {
    case "auth":
      handleAuth(ws, userId, userRole, setUserContext);
      break;
    case "sendAlert":
      if (userId && userRole) {
        handleCreateAlert(ws, userId, userRole, data);
      } else {
        ws.send(JSON.stringify({ type: "error", message: "Unauthorized to create alerts - not authenticated" }));
      }
      break;
    case "updateLocation":
      handleLocationUpdate(ws, userId, userRole, data);
      break;
    case "updateStatus":
      if (userRole === "responder") {
        handleStatusUpdate(ws, userId, data);
      }
      break;
    case "acknowledgeAlert":
      handleAcknowledgeAlert(ws, userId, data);
      break;
    case "getAlerts":
      handleGetAlerts(ws, userId, userRole);
      break;
    case "getResponders":
      if (userRole === "dispatcher") {
        handleGetResponders(ws);
      }
      break;
    case "ping":
      ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      break;
    // ─── PTT WebSocket Messages ────────────────────────────────────────────────
    case "pttTransmit":
      if (userId && userRole) {
        handlePTTTransmit(ws, userId, userRole, data);
      }
      break;
    case "pttJoinChannel":
      if (userId && userRole) {
        handlePTTJoinChannel(ws, userId, userRole, data);
      }
      break;
    case "pttStart":
    case "pttEnd":
      const pttPayload = JSON.stringify({ type: data.type, senderId: data.senderId, senderName: data.senderName, channel: data.channel });
      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === 1) {
          client.send(pttPayload);
        }
      });
      break;
    case "pttStartTalking":
      if (userId && userRole) {
        handlePTTTalkingState(ws, userId, userRole, data, true);
      }
      break;
    case "pttStopTalking":
      if (userId && userRole) {
        handlePTTTalkingState(ws, userId, userRole, data, false);
      }
      break;
    case "pttEmergency":
      if (userId && userRole) {
        handlePTTEmergency(ws, userId, userRole, data);
      }
      break;
    default:
      console.warn(`Unknown message type: ${type}`);
  }
}
function handleAuth(ws, userId, userRole, setUserContext) {
  if (!userId || !userRole) {
    ws.send(JSON.stringify({ type: "error", message: "Missing userId or userRole" }));
    return;
  }
  const user = {
    id: userId,
    email: `${userId}@talion.local`,
    role: userRole,
    status: userRole === "responder" ? "available" : void 0,
    lastSeen: Date.now()
  };
  users.set(userId, user);
  if (!userConnections.has(userId)) {
    userConnections.set(userId, /* @__PURE__ */ new Set());
  }
  userConnections.get(userId).add(ws);
  wsClientMap.set(ws, userId);
  setUserContext(userId, userRole);
  ws.send(JSON.stringify({
    type: "authSuccess",
    userId,
    userRole,
    timestamp: Date.now()
  }));
  console.log(`User ${userId} (${userRole}) authenticated`);
  addAuditEntry("auth", "User Login", userId, `${userRole} login via WebSocket`);
  const activeAlerts = Array.from(alerts.values()).filter((a) => a.status === "active").map((a) => ({
    ...a,
    respondingNames: (a.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid)
  }));
  ws.send(JSON.stringify({
    type: "alertsSnapshot",
    data: activeAlerts
  }));
  broadcastUserStatus(userId, "online");
}
async function handleCreateAlert(ws, userId, userRole, alertData) {
  const alert = {
    id: await generateIncidentId(alertData.type || "other", userId, alertData.location || {}),
    type: alertData.type || "other",
    severity: alertData.severity || "medium",
    location: alertData.location || { latitude: 0, longitude: 0, address: "Unknown" },
    description: alertData.description || "",
    createdBy: userId,
    createdAt: Date.now(),
    status: "active",
    respondingUsers: [],
    photos: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  console.log(`New alert created: ${alert.id} by ${userId}`);
  addAuditEntry("incident", "Incident Created", userId, `Created ${alert.id}: ${alert.type} at ${alert.location.address}`);
  broadcastMessage({ type: "newAlert", data: alert });
  ws.send(JSON.stringify({ type: "alertCreated", alertId: alert.id, timestamp: Date.now() }));
}
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function checkGeofences(userId, location) {
  const responderUser = users.get(userId);
  const responderName = responderUser ? adminUsers.get(userId)?.name || userId : userId;
  geofenceZones.forEach((zone, zoneId) => {
    const dist = haversineDistance(location.latitude, location.longitude, zone.center.latitude, zone.center.longitude);
    const insideNow = dist <= zone.radiusKm * 1e3;
    if (!responderZoneState.has(zoneId)) {
      responderZoneState.set(zoneId, /* @__PURE__ */ new Set());
    }
    const zoneSet = responderZoneState.get(zoneId);
    const wasInside = zoneSet.has(userId);
    if (insideNow && !wasInside) {
      zoneSet.add(userId);
      const event = {
        id: (0, import_uuid.v4)(),
        zoneId,
        responderId: userId,
        responderName,
        eventType: "entry",
        timestamp: Date.now(),
        location
      };
      geofenceEvents.unshift(event);
      addAuditEntry("broadcast", "Geofence Entry", userId, `${responderName} entered zone ${zoneId} (${zone.severity} \u2014 ${zone.radiusKm}km)`);
      broadcastMessage({
        type: "geofenceEntry",
        data: { ...event, zone: { id: zone.id, severity: zone.severity, radiusKm: zone.radiusKm, message: zone.message } }
      });
      console.log(`[Geofence] ${responderName} ENTERED zone ${zoneId}`);
    } else if (!insideNow && wasInside) {
      zoneSet.delete(userId);
      const event = {
        id: (0, import_uuid.v4)(),
        zoneId,
        responderId: userId,
        responderName,
        eventType: "exit",
        timestamp: Date.now(),
        location
      };
      geofenceEvents.unshift(event);
      addAuditEntry("broadcast", "Geofence Exit", userId, `${responderName} exited zone ${zoneId} (${zone.severity} \u2014 ${zone.radiusKm}km)`);
      broadcastMessage({
        type: "geofenceExit",
        data: { ...event, zone: { id: zone.id, severity: zone.severity, radiusKm: zone.radiusKm, message: zone.message } }
      });
      console.log(`[Geofence] ${responderName} EXITED zone ${zoneId}`);
    }
  });
}
var sharingUsers = /* @__PURE__ */ new Set();
var LOCATION_TTL_MS = 3e4;
function getFamilyMemberIds(userId) {
  const adminUser = adminUsers.get(userId);
  if (!adminUser || !adminUser.relationships) return [];
  const familyTypes = ["parent", "child", "sibling", "spouse"];
  return adminUser.relationships.filter((r) => familyTypes.includes(r.type)).map((r) => r.userId);
}
function broadcastToUsers(userIds, message) {
  const data = JSON.stringify(message);
  userIds.forEach((uid) => {
    const connections = userConnections.get(uid);
    if (connections) {
      connections.forEach((client) => {
        if (client.readyState === 1) {
          client.send(data);
        }
      });
    }
  });
}
function checkFamilyPerimeters(userId, locationData) {
  if (!locationData?.latitude || !locationData?.longitude) return;
  for (const [pId, perimeter] of familyPerimeters) {
    if (!perimeter.active || perimeter.targetUserId !== userId) continue;
    const dist = haversineDistance(
      perimeter.center.latitude,
      perimeter.center.longitude,
      locationData.latitude,
      locationData.longitude
    );
    const isOutside = dist > perimeter.radiusMeters;
    const wasOutside = perimeterState.get(pId) || false;
    if (isOutside && !wasOutside) {
      perimeterState.set(pId, true);
      const alert = {
        id: (0, import_uuid.v4)(),
        perimeterId: pId,
        targetUserId: userId,
        targetUserName: perimeter.targetUserName,
        ownerId: perimeter.ownerId,
        eventType: "exit",
        distanceMeters: Math.round(dist),
        location: { latitude: locationData.latitude, longitude: locationData.longitude },
        timestamp: Date.now(),
        acknowledged: false
      };
      proximityAlerts.unshift(alert);
      if (proximityAlerts.length > 500) proximityAlerts.length = 500;
      persistProximityAlerts();
      broadcastToUsers([perimeter.ownerId], {
        type: "proximityAlert",
        data: alert
      });
      sendProximityPush(perimeter.ownerId, alert, perimeter);
      console.log(`[Proximity] ${perimeter.targetUserName} LEFT perimeter ${pId} (${Math.round(dist)}m from center, radius ${perimeter.radiusMeters}m)`);
    } else if (!isOutside && wasOutside) {
      perimeterState.set(pId, false);
      const alert = {
        id: (0, import_uuid.v4)(),
        perimeterId: pId,
        targetUserId: userId,
        targetUserName: perimeter.targetUserName,
        ownerId: perimeter.ownerId,
        eventType: "entry",
        distanceMeters: Math.round(dist),
        location: { latitude: locationData.latitude, longitude: locationData.longitude },
        timestamp: Date.now(),
        acknowledged: false
      };
      proximityAlerts.unshift(alert);
      if (proximityAlerts.length > 500) proximityAlerts.length = 500;
      persistProximityAlerts();
      broadcastToUsers([perimeter.ownerId], {
        type: "proximityAlert",
        data: alert
      });
      console.log(`[Proximity] ${perimeter.targetUserName} RETURNED to perimeter ${pId}`);
    }
  }
}
async function sendProximityPush(ownerId, alert, perimeter) {
  const targetTokens = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userId === ownerId) targetTokens.push(token);
  }
  if (targetTokens.length === 0) return;
  const emoji = alert.eventType === "exit" ? "\u26A0\uFE0F" : "\u2705";
  const action = alert.eventType === "exit" ? "a quitt\xE9" : "est revenu(e) dans";
  const messages2 = targetTokens.map((token) => ({
    to: token,
    sound: "default",
    title: `${emoji} Alerte de proximit\xE9`,
    body: `${alert.targetUserName} ${action} le p\xE9rim\xE8tre (${Math.round(alert.distanceMeters)}m${perimeter.center.address ? " - " + perimeter.center.address : ""})`,
    data: { type: "proximity", alertId: alert.id, perimeterId: perimeter.id },
    priority: alert.eventType === "exit" ? "high" : "normal",
    channelId: "family-alerts"
  }));
  try {
    await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(messages2)
    });
  } catch (e) {
    console.error("[Proximity Push] Error:", e);
  }
}
function handleLocationUpdate(ws, userId, userRole, locationData) {
  if (!userId) return;
  console.log(`[Location] WS update from ${userId} (${userRole}): lat=${locationData?.latitude}, lng=${locationData?.longitude}`);
  let user = users.get(userId);
  if (!user) {
    const adminUser = adminUsers.get(userId);
    user = {
      id: userId,
      email: adminUser?.email || `${userId}@unknown`,
      role: userRole,
      status: "active",
      lastSeen: Date.now()
    };
    users.set(userId, user);
    console.log(`[Location] Created user entry for ${userId} (${userRole})`);
  }
  user.location = locationData;
  user.lastSeen = Date.now();
  users.set(userId, user);
  sharingUsers.add(userId);
  if (locationData?.latitude != null && locationData?.longitude != null) {
    const entry = {
      userId,
      latitude: locationData.latitude,
      longitude: locationData.longitude,
      timestamp: Date.now()
    };
    let history = locationHistory.get(userId);
    if (!history) {
      history = [];
      locationHistory.set(userId, history);
    }
    history.push(entry);
    if (history.length > MAX_HISTORY_PER_USER) {
      history.splice(0, history.length - MAX_HISTORY_PER_USER);
    }
    persistLocationHistory();
  }
  checkFamilyPerimeters(userId, locationData);
  if (user.role === "responder") {
    broadcastToRole("dispatcher", {
      type: "responderLocationUpdate",
      userId,
      location: locationData,
      timestamp: Date.now()
    });
    broadcastToRole("admin", {
      type: "responderLocationUpdate",
      userId,
      location: locationData,
      timestamp: Date.now()
    });
    checkGeofences(userId, locationData);
  } else {
    broadcastToRole("dispatcher", {
      type: "userLocationUpdate",
      userId,
      location: locationData,
      timestamp: Date.now()
    });
  }
  const familyIds = getFamilyMemberIds(userId);
  if (familyIds.length > 0) {
    const adminUser = adminUsers.get(userId);
    broadcastToUsers(familyIds, {
      type: "familyLocationUpdate",
      userId,
      userName: adminUser?.name || userId,
      location: locationData,
      timestamp: Date.now()
    });
  }
}
function handleStatusUpdate(ws, userId, statusData) {
  const user = users.get(userId);
  if (user && user.role === "responder") {
    user.status = statusData.status;
    user.lastSeen = Date.now();
    users.set(userId, user);
    console.log(`Responder ${userId} status updated to ${statusData.status}`);
    broadcastToRole("dispatcher", {
      type: "responderStatusUpdate",
      userId,
      status: statusData.status,
      timestamp: Date.now()
    });
  }
}
function handleAcknowledgeAlert(ws, userId, alertData) {
  const alert = alerts.get(alertData.alertId);
  if (alert) {
    if (!alert.respondingUsers.includes(userId)) {
      alert.respondingUsers.push(userId);
    }
    alert.status = "acknowledged";
    alerts.set(alert.id, alert);
    persistAlerts();
    console.log(`Alert ${alert.id} acknowledged by ${userId}`);
    addAuditEntry("incident", "Alert Acknowledged", userId, `Acknowledged ${alert.id}`);
    broadcastMessage({ type: "alertAcknowledged", alertId: alert.id, userId, timestamp: Date.now() });
  }
}
function handleGetAlerts(ws, userId, userRole) {
  const userAlerts = Array.from(alerts.values()).filter((alert) => {
    if (alert.status === "resolved" || alert.status === "cancelled") return false;
    return true;
  });
  ws.send(JSON.stringify({ type: "alertsList", data: userAlerts, timestamp: Date.now() }));
}
function handleGetResponders(ws) {
  const connectedResponders = Array.from(users.values()).filter((u) => u.role === "responder");
  const enriched = connectedResponders.map((r) => {
    const adminUser = adminUsers.get(r.id);
    return {
      ...r,
      name: adminUser?.name || r.id,
      firstName: adminUser?.firstName || "",
      lastName: adminUser?.lastName || "",
      email: adminUser?.email || "",
      phone: adminUser?.phoneMobile || "",
      tags: adminUser?.tags || [],
      isConnected: true
    };
  });
  ws.send(JSON.stringify({ type: "respondersList", data: enriched, timestamp: Date.now() }));
}
function broadcastMessage(message) {
  const data = JSON.stringify(message);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      client.send(data);
    }
  });
}
function broadcastToRole(role, message) {
  const data = JSON.stringify(message);
  const targetUsers = Array.from(users.values()).filter((u) => u.role === role);
  targetUsers.forEach((user) => {
    const connections = userConnections.get(user.id);
    if (connections) {
      connections.forEach((client) => {
        if (client.readyState === 1) {
          client.send(data);
        }
      });
    }
  });
}
function broadcastUserStatus(userId, status) {
  broadcastToRole("dispatcher", {
    type: "userStatusChange",
    userId,
    status,
    timestamp: Date.now()
  });
}
app.post("/auth/login", (req, res) => {
  const { email, password } = req.body;
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const userAgent = req.headers["user-agent"] || "unknown";
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }
  const user = Array.from(adminUsers.values()).find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    addLoginHistory({ userId: "unknown", userName: "Unknown", email, timestamp: Date.now(), ip, userAgent, status: "failed_email" });
    return res.status(401).json({ error: "Invalid email or password" });
  }
  if (user.status === "deactivated") {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "account_deactivated" });
    return res.status(403).json({ error: "Account is deactivated. Contact your administrator." });
  }
  if (user.status === "suspended") {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "account_suspended" });
    return res.status(403).json({ error: "Account is suspended. Contact your administrator." });
  }
  if (!user.passwordHash) {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "no_password" });
    return res.status(401).json({ error: "No password set for this account. Contact your administrator." });
  }
  const valid = import_bcryptjs.default.compareSync(password, user.passwordHash);
  if (!valid) {
    addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "failed_password" });
    return res.status(401).json({ error: "Invalid email or password" });
  }
  addLoginHistory({ userId: user.id, userName: user.name, email, timestamp: Date.now(), ip, userAgent, status: "success" });
  user.lastLogin = Date.now();
  adminUsers.set(user.id, user);
  addAuditEntry("auth", "User Login", user.name, `Login via email/password from ${parseDevice(userAgent)} (${ip})`, void 0);
  const { passwordHash, ...safeUser } = user;
  res.json({
    success: true,
    user: safeUser,
    token: `session-${user.id}-${Date.now()}`
  });
});
app.put("/auth/change-password", (req, res) => {
  const { userId, currentPassword, newPassword } = req.body;
  if (!userId || !newPassword) {
    return res.status(400).json({ error: "userId and newPassword are required" });
  }
  const user = adminUsers.get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (user.passwordHash && currentPassword) {
    if (!import_bcryptjs.default.compareSync(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }
  }
  user.passwordHash = import_bcryptjs.default.hashSync(newPassword, 10);
  adminUsers.set(user.id, user);
  addAuditEntry("auth", "Password Changed", user.name, "Password updated", void 0);
  res.json({ success: true });
});
var passwordResetCodes = /* @__PURE__ */ new Map();
app.post("/auth/request-password-reset", (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required" });
  const user = Array.from(adminUsers.values()).find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) {
    return res.json({ success: true, message: "Si un compte existe avec cet email, un code de r\xE9initialisation a \xE9t\xE9 g\xE9n\xE9r\xE9." });
  }
  if (user.status === "deactivated" || user.status === "suspended") {
    return res.json({ success: true, message: "Si un compte existe avec cet email, un code de r\xE9initialisation a \xE9t\xE9 g\xE9n\xE9r\xE9." });
  }
  const code = String(Math.floor(1e5 + Math.random() * 9e5));
  const expiresAt = Date.now() + 15 * 60 * 1e3;
  passwordResetCodes.set(code, { userId: user.id, code, expiresAt });
  addAuditEntry("auth", "Password Reset Requested", user.name, `Reset code generated for ${user.email}`, void 0);
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && (client.userRole === "admin" || client.userRole === "dispatcher")) {
      client.send(JSON.stringify({
        type: "passwordResetRequest",
        userId: user.id,
        userName: user.name,
        email: user.email,
        code,
        expiresAt
      }));
    }
  });
  console.log(`[Auth] Password reset code for ${user.email}: ${code} (expires in 15 min)`);
  res.json({ success: true, message: "Si un compte existe avec cet email, un code de r\xE9initialisation a \xE9t\xE9 g\xE9n\xE9r\xE9." });
});
app.post("/auth/reset-password", (req, res) => {
  const { code, newPassword } = req.body;
  if (!code || !newPassword) return res.status(400).json({ error: "Code and new password are required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const resetEntry = passwordResetCodes.get(code);
  if (!resetEntry) return res.status(400).json({ error: "Code invalide ou expir\xE9" });
  if (Date.now() > resetEntry.expiresAt) {
    passwordResetCodes.delete(code);
    return res.status(400).json({ error: "Code expir\xE9. Veuillez en demander un nouveau." });
  }
  const user = adminUsers.get(resetEntry.userId);
  if (!user) {
    passwordResetCodes.delete(code);
    return res.status(404).json({ error: "User not found" });
  }
  user.passwordHash = import_bcryptjs.default.hashSync(newPassword, 10);
  adminUsers.set(user.id, user);
  passwordResetCodes.delete(code);
  addAuditEntry("auth", "Password Reset Completed", user.name, `Password reset via code for ${user.email}`, void 0);
  console.log(`[Auth] Password reset completed for ${user.email}`);
  res.json({ success: true, message: "Mot de passe r\xE9initialis\xE9 avec succ\xE8s." });
});
app.get("/admin/login-history", (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const status = req.query.status;
  const userId = req.query.userId;
  const search = (req.query.search || "").toLowerCase();
  let filtered = [...loginHistory];
  if (status && status !== "all") {
    filtered = filtered.filter((e) => e.status === status);
  }
  if (userId) {
    filtered = filtered.filter((e) => e.userId === userId);
  }
  if (search) {
    filtered = filtered.filter(
      (e) => e.userName.toLowerCase().includes(search) || e.email.toLowerCase().includes(search) || e.ip.includes(search) || e.device.toLowerCase().includes(search)
    );
  }
  const total = filtered.length;
  const start = (page - 1) * limit;
  const entries = filtered.slice(start, start + limit);
  res.json({
    entries,
    total,
    page,
    totalPages: Math.ceil(total / limit)
  });
});
app.get("/admin/users/:id/login-history", (req, res) => {
  const userId = req.params.id;
  const user = adminUsers.get(userId);
  if (!user) return res.status(404).json({ error: "User not found" });
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 50;
  const entries = loginHistory.filter((e) => e.userId === userId);
  const total = entries.length;
  const start = (page - 1) * limit;
  res.json({
    user: { id: user.id, name: user.name, email: user.email },
    entries: entries.slice(start, start + limit),
    total,
    page,
    totalPages: Math.ceil(total / limit)
  });
});
app.get("/admin/login-stats", (req, res) => {
  const now = Date.now();
  const last24h = loginHistory.filter((e) => e.timestamp > now - 864e5);
  const last7d = loginHistory.filter((e) => e.timestamp > now - 7 * 864e5);
  const successCount24h = last24h.filter((e) => e.status === "success").length;
  const failedCount24h = last24h.filter((e) => e.status !== "success").length;
  const successCount7d = last7d.filter((e) => e.status === "success").length;
  const failedCount7d = last7d.filter((e) => e.status !== "success").length;
  const uniqueUsers24h = new Set(last24h.filter((e) => e.status === "success").map((e) => e.userId)).size;
  const userCounts = {};
  last7d.filter((e) => e.status === "success").forEach((e) => {
    if (!userCounts[e.userId]) userCounts[e.userId] = { name: e.userName, count: 0 };
    userCounts[e.userId].count++;
  });
  const topUsers = Object.entries(userCounts).sort((a, b) => b[1].count - a[1].count).slice(0, 5).map(([id, data]) => ({ userId: id, name: data.name, loginCount: data.count }));
  const failedByIp = {};
  last24h.filter((e) => e.status !== "success").forEach((e) => {
    failedByIp[e.ip] = (failedByIp[e.ip] || 0) + 1;
  });
  const suspiciousIps = Object.entries(failedByIp).filter(([_, count]) => count >= 3).map(([ip, count]) => ({ ip, failedAttempts: count }));
  res.json({
    last24h: { success: successCount24h, failed: failedCount24h, uniqueUsers: uniqueUsers24h },
    last7d: { success: successCount7d, failed: failedCount7d },
    topUsers,
    suspiciousIps,
    totalEntries: loginHistory.length
  });
});
app.post("/admin/users/:id/photo", upload.single("photo"), (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  user.photoUrl = `/uploads/${req.file.filename}`;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry("user_updated", `Profile photo updated for ${user.firstName} ${user.lastName}`, "admin");
  const { passwordHash, ...safe } = user;
  res.json({ success: true, user: safe });
});
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    connectedUsers: users.size,
    activeAlerts: Array.from(alerts.values()).filter((a) => a.status === "active").length,
    timestamp: Date.now()
  });
});
var geocodeCache = /* @__PURE__ */ new Map();
app.get("/api/geocode", async (req, res) => {
  const q = req.query.q;
  if (!q || q.length < 2) return res.json([]);
  const cached = geocodeCache.get(q);
  if (cached && Date.now() - cached.ts < 3e5) return res.json(cached.data);
  try {
    const mapboxToken = process.env.MAPBOX_TOKEN;
    if (mapboxToken) {
      const url2 = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${mapboxToken}&limit=5&types=address&language=fr`;
      const response2 = await fetch(url2);
      if (!response2.ok) throw new Error("Mapbox error");
      const data2 = await response2.json();
      const results = (data2.features || []).map((f) => {
        const ctx = f.context || [];
        const city = ctx.find((c) => c.id?.startsWith("place"))?.text || "";
        const country = ctx.find((c) => c.id?.startsWith("country"))?.text || "";
        const postcode = ctx.find((c) => c.id?.startsWith("postcode"))?.text || "";
        return {
          display_name: f.place_name,
          lat: f.center[1].toString(),
          lon: f.center[0].toString(),
          address: {
            house_number: f.address || "",
            road: f.text || "",
            city,
            town: city,
            postcode,
            country
          }
        };
      });
      geocodeCache.set(q, { data: results, ts: Date.now() });
      return res.json(results);
    }
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&addressdetails=1&limit=5`;
    const response = await fetch(url, { headers: { "User-Agent": "TalionCrisisComm/1.0" } });
    if (!response.ok) return res.status(response.status).json({ error: "Geocode error" });
    const data = await response.json();
    geocodeCache.set(q, { data, ts: Date.now() });
    res.json(data);
  } catch (err) {
    console.error("Geocode proxy error:", err);
    res.status(500).json({ error: "Geocode proxy failed" });
  }
});
app.get("/alerts", (req, res) => {
  const userRole = req.query.role;
  const userId = req.query.userId;
  const visibleAlerts = Array.from(alerts.values()).filter((a) => {
    if (a.status === "resolved") return false;
    if (userRole === "user") {
      const userName = adminUsers.get(userId)?.name || userId;
      return a.createdBy === userId || a.createdBy === userName || (a.respondingUsers || []).includes(userId) || (a.status === "active" || a.status === "acknowledged" || a.status === "dispatched");
    }
    return true;
  }).map((a) => {
    const respondingNames = (a.respondingUsers || []).map((uid) => {
      const admin = adminUsers.get(uid);
      return admin?.name || uid;
    });
    const creatorName = adminUsers.get(a.createdBy)?.name || a.createdBy;
    return { ...a, respondingNames, createdByName: creatorName };
  });
  res.json(visibleAlerts);
});
app.get("/alerts/:id", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  const respondingDetails = alert.respondingUsers.map((uid) => {
    const user = users.get(uid);
    const admin = adminUsers.get(uid);
    return {
      id: uid,
      name: admin?.name || uid,
      phone: admin?.phoneMobile || "",
      tags: admin?.tags || [],
      status: user?.status || responderStatusOverrides.get(uid)?.status || "unknown",
      location: user?.location || null,
      isConnected: !!user
    };
  });
  const respondingNames = alert.respondingUsers.map((uid) => adminUsers.get(uid)?.name || uid);
  res.json({ ...alert, respondingDetails, respondingNames });
});
app.put("/alerts/:id", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  const { location, description } = req.body;
  if (location) alert.location = location;
  if (description) alert.description = description;
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch((e) => console.error("[Unassign] Supabase save error:", e));
  broadcastMessage({ type: "alertUpdate", data: { ...alert, respondingNames: (alert.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid) } });
  res.json({ success: true });
});
app.put("/alerts/:id/acknowledge", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  alert.status = "acknowledged";
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "Alert Acknowledged", req.body?.userId || "Mobile App", `Acknowledged ${alert.id}`);
  broadcastMessage({ type: "alertAcknowledged", alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});
app.put("/alerts/:id/resolve", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  alert.status = "resolved";
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "Incident Resolved", req.body?.userId || "Mobile App", `Resolved ${alert.id}: ${alert.type} at ${alert.location.address}`);
  broadcastMessage({ type: "alertResolved", alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});
app.get("/responders", (req, res) => {
  const responders = Array.from(users.values()).filter((u) => u.role === "responder");
  res.json(responders);
});
app.post("/dispatch/incidents", async (req, res) => {
  const { type, severity, location, description, createdBy } = req.body;
  const alert = {
    id: await generateIncidentId(type || "other", createdBy || "Dispatch Console", location || {}),
    type: type || "other",
    severity: severity || "medium",
    location: location || { latitude: 0, longitude: 0, address: "Unknown" },
    description: description || "",
    createdBy: createdBy || "Dispatch Console",
    createdAt: Date.now(),
    status: "active",
    respondingUsers: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch(() => {
  });
  broadcastMessage({ type: "newAlert", data: alert });
  sendPushToDispatchersAndResponders(alert, alert.createdBy).catch(() => {
  });
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === "user") {
      sendPushToUser(
        entry.userId,
        `\u{1F6A8} Nouvel incident \u2014 ${alert.type.toUpperCase()}`,
        alert.description || alert.location?.address || "Incident signal\xE9",
        { type: alert.type, alertId: alert.id }
      ).catch(() => {
      });
    }
  }
  res.json({ success: true, id: alert.id, alert });
});
app.post("/alerts", requireAuth, async (req, res) => {
  const { type, severity, location, description, createdBy } = req.body;
  const alert = {
    id: await generateIncidentId(type || "other", createdBy || "system", location || {}),
    type: type || "other",
    severity: severity || "medium",
    location: location || { latitude: 0, longitude: 0, address: "Unknown" },
    description: description || "",
    createdBy: createdBy || "system",
    createdAt: Date.now(),
    status: "active",
    respondingUsers: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  broadcastMessage({ type: "newAlert", data: alert });
  if (alert.type === "sos") {
    sendPushToDispatchersAndResponders(alert, createdBy || "system");
  } else {
    sendPushToAllUsers({
      title: `\u{1F6A8} ${(alert.type || "Incident").toUpperCase()} - ${(alert.severity || "medium").toUpperCase()}`,
      body: `${alert.description || "New incident reported"}${alert.location?.address ? "\n\u{1F4CD} " + alert.location.address : ""}`,
      data: { type: "incident", alertId: alert.id, severity: alert.severity }
    });
  }
  res.json({ success: true, alertId: alert.id });
});
app.post("/api/push-token", (req, res) => {
  const { token, userId, userRole } = req.body;
  if (!token || !userId) {
    return res.status(400).json({ error: "Missing token or userId" });
  }
  pushTokens.set(token, {
    token,
    userId,
    userRole: userRole || "user",
    registeredAt: Date.now()
  });
  savePushTokenToSupabase({ token, userId, userRole: userRole || "user", registeredAt: Date.now() });
  console.log(`[Push] Token registered for ${userId} (${userRole}). Total tokens: ${pushTokens.size}`);
  res.json({ success: true });
});
app.get("/api/debug/push-tokens", (_req, res) => {
  const tokens = Array.from(pushTokens.values()).map((e) => ({
    userId: e.userId,
    userRole: e.userRole,
    token: e.token,
    registeredAt: e.registeredAt
  }));
  res.json(tokens);
});
app.delete("/api/push-token", (req, res) => {
  const { token } = req.body;
  if (token) {
    pushTokens.delete(token);
    deletePushTokenFromSupabase(token);
  }
  res.json({ success: true });
});
async function sendPushToUser(userId, title, body, data = {}) {
  const targetTokens = [];
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
  const messages2 = targetTokens.map((token) => ({
    to: token,
    sound: "default",
    title,
    body,
    data,
    priority: "high",
    channelId: "incident-updates"
  }));
  try {
    const response = await fetch("https://exp.host/--/api/v2/push/send", {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(messages2)
    });
    if (!response.ok) {
      console.error(`[Push] Expo API error for ${userId}: ${response.status}`);
    } else {
      const result = await response.json();
      console.log(`[Push] Sent to ${userId}:`, result.data?.length || 0, "tickets");
    }
  } catch (err) {
    console.error(`[Push] Failed to send to ${userId}:`, err);
  }
}
async function sendPushToDispatchersAndResponders(alert, senderName) {
  const targetTokens = [];
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === "dispatcher" || entry.userRole === "responder" || entry.userRole === "admin") {
      if (entry.userId !== alert.createdBy) {
        targetTokens.push(token);
      }
    }
  }
  if (targetTokens.length === 0) {
    console.log("[Push] No dispatcher/responder tokens registered, skipping push");
    return;
  }
  console.log(`[Push] Sending SOS push to ${targetTokens.length} dispatcher/responder devices`);
  const messages2 = targetTokens.map((token) => ({
    to: token,
    sound: "default",
    title: `\u{1F6A8} SOS ALERT - ${alert.type.toUpperCase()}`,
    body: `${senderName} triggered an emergency alert. ${alert.location?.address || "Location shared"}`,
    data: {
      type: "sos",
      alertId: alert.id,
      severity: alert.severity,
      alertType: alert.type
    },
    priority: "high",
    channelId: "sos-alerts"
  }));
  try {
    const chunks = [];
    for (let i = 0; i < messages2.length; i += 100) {
      chunks.push(messages2.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(chunk)
      });
      if (!response.ok) {
        console.error(`[Push] Expo API error: ${response.status} ${response.statusText}`);
      } else {
        const result = await response.json();
        console.log(`[Push] Expo API response:`, JSON.stringify(result.data?.length || 0), "tickets");
      }
    }
  } catch (error) {
    console.error("[Push] Failed to send push notifications:", error);
  }
}
async function sendPushToAllUsers(alert, senderName) {
  const targetTokens = [];
  for (const [token, _entry] of pushTokens) {
    targetTokens.push(token);
  }
  if (targetTokens.length === 0) {
    console.log("[Push] No tokens registered, skipping broadcast push");
    return;
  }
  console.log(`[Push] Sending broadcast push to ${targetTokens.length} devices`);
  const SEVERITY_EMOJI = { critical: "\u{1F6A8}", high: "\u26A0\uFE0F", medium: "\u{1F4E2}", low: "\u2139\uFE0F" };
  const emoji = SEVERITY_EMOJI[alert.severity] || "\u{1F4E2}";
  const messages2 = targetTokens.map((token) => ({
    to: token,
    sound: "default",
    title: `${emoji} BROADCAST - ${alert.severity.toUpperCase()}`,
    body: `${senderName}: ${alert.description}`,
    data: {
      type: "broadcast",
      alertId: alert.id,
      severity: alert.severity
    },
    priority: alert.severity === "critical" || alert.severity === "high" ? "high" : "normal",
    channelId: "broadcast-alerts"
  }));
  try {
    const chunks = [];
    for (let i = 0; i < messages2.length; i += 100) {
      chunks.push(messages2.slice(i, i + 100));
    }
    for (const chunk of chunks) {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip, deflate",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(chunk)
      });
      if (!response.ok) {
        console.error(`[Push] Expo API error: ${response.status} ${response.statusText}`);
      } else {
        const result = await response.json();
        console.log(`[Push] Broadcast push sent:`, JSON.stringify(result.data?.length || 0), "tickets");
      }
    }
  } catch (error) {
    console.error("[Push] Failed to send broadcast push notifications:", error);
  }
}
app.post("/api/sos", async (req, res) => {
  const { type, severity, location, description, userId, userName, userRole } = req.body;
  console.log(`[SOS REST] Received SOS from ${userName || userId || "unknown"}`);
  const alert = {
    id: await generateIncidentId(type || "sos", userName || userId || "mobile-user", location || {}),
    type: type || "sos",
    severity: severity || "critical",
    location: location || { latitude: 0, longitude: 0, address: "Unknown" },
    description: description || `SOS Alert from ${userName || "Unknown"}`,
    createdBy: userName || userId || "mobile-user",
    createdAt: Date.now(),
    status: "active",
    respondingUsers: [],
    photos: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "SOS Alert Created (REST)", userId || "unknown", `SOS ${alert.id}: ${alert.location.address}`);
  broadcastMessage({ type: "newAlert", data: alert });
  sendPushToDispatchersAndResponders(alert, userName || userId || "Unknown").catch((err) => {
    console.error("[SOS REST] Push notification error:", err);
  });
  console.log(`[SOS REST] Alert ${alert.id} created and broadcast to ${wss.clients.size} clients`);
  res.json({ success: true, alertId: alert.id, broadcast: true });
});
app.post("/api/alerts/:id/photos", upload.array("photos", 4), (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: "No files uploaded" });
  const photoUrls = req.files.map((f) => `/uploads/${f.filename}`);
  if (!alert.photos) alert.photos = [];
  alert.photos.push(...photoUrls);
  persistAlerts();
  console.log(`[Alert Photos] ${photoUrls.length} photo(s) uploaded to alert ${alert.id}`);
  broadcastMessage({ type: "alertPhotosUpdated", data: { alertId: alert.id, photos: alert.photos } });
  res.json({ success: true, photos: alert.photos });
});
app.get("/api/alerts/:id/photos", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  res.json({ photos: alert.photos || [] });
});
app.post("/api/location", (req, res) => {
  const { userId, userRole, latitude, longitude } = req.body;
  console.log(`[Location REST] Received from userId=${userId} (${userRole}): lat=${latitude}, lng=${longitude}`);
  if (latitude == null || longitude == null) {
    return res.status(400).json({ error: "latitude and longitude required" });
  }
  const resolvedUserId = userId || `anon-${Date.now()}`;
  const locationData = { latitude: Number(latitude), longitude: Number(longitude) };
  handleLocationUpdate(null, resolvedUserId, userRole || "user", locationData);
  sharingUsers.add(resolvedUserId);
  console.log(`[Location REST] Processed for ${resolvedUserId}, now in users map: ${users.has(resolvedUserId)}, sharing: true`);
  res.json({ success: true, userId: resolvedUserId, location: locationData, timestamp: Date.now() });
});
setInterval(() => {
  const now = Date.now();
  const staleUsers = [];
  sharingUsers.forEach((userId) => {
    const user = users.get(userId);
    if (!user || !user.lastSeen || now - user.lastSeen > LOCATION_TTL_MS) {
      staleUsers.push(userId);
    }
  });
  staleUsers.forEach((userId) => {
    console.log(`[Location TTL] Removing stale user ${userId} (no update for ${LOCATION_TTL_MS / 1e3}s)`);
    sharingUsers.delete(userId);
    const user = users.get(userId);
    if (user) {
      user.location = void 0;
      users.set(userId, user);
    }
    broadcastToRole("dispatcher", {
      type: "userLocationRemoved",
      userId,
      timestamp: Date.now()
    });
  });
  if (staleUsers.length > 0) {
    console.log(`[Location TTL] Cleaned up ${staleUsers.length} stale users`);
  }
}, 15e3);
function handleStopSharing(userId, res) {
  console.log(`[Location REST] Stop sharing from userId=${userId}`);
  if (!userId) {
    return res.status(400).json({ error: "userId required" });
  }
  sharingUsers.delete(userId);
  const user = users.get(userId);
  if (user) {
    user.location = void 0;
    users.set(userId, user);
  }
  console.log(`[Location REST] Removed ${userId} from users map entirely`);
  broadcastToRole("dispatcher", {
    type: "userLocationRemoved",
    userId,
    timestamp: Date.now()
  });
  res.json({ success: true, userId, timestamp: Date.now() });
}
app.delete("/api/location", (req, res) => {
  const userId = req.body?.userId || req.query.userId;
  handleStopSharing(userId, res);
});
app.post("/api/location/stop", (req, res) => {
  const userId = req.body?.userId || req.query.userId;
  handleStopSharing(userId, res);
});
app.get("/api/location/live-count", (_req, res) => {
  res.json({ count: sharingUsers.size, userIds: Array.from(sharingUsers) });
});
app.get("/api/family/locations", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const familyIds = getFamilyMemberIds(userId);
  const familyLocations = familyIds.map((fid) => {
    const u = users.get(fid);
    const adminUser = adminUsers.get(fid);
    const rel = adminUsers.get(userId)?.relationships?.find((r) => r.userId === fid);
    if (!u || !u.location) return null;
    return {
      userId: fid,
      userName: adminUser?.name || fid,
      relationship: rel?.type || "family",
      latitude: u.location.latitude,
      longitude: u.location.longitude,
      lastSeen: u.lastSeen || Date.now()
    };
  }).filter(Boolean);
  res.json({ familyMembers: familyIds.length, locations: familyLocations });
});
app.get("/api/family/members", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const adminUser = adminUsers.get(userId);
  if (!adminUser) return res.status(404).json({ error: "User not found" });
  const familyTypes = ["parent", "child", "sibling", "spouse"];
  const members = (adminUser.relationships || []).filter((r) => familyTypes.includes(r.type)).map((r) => {
    const relUser = adminUsers.get(r.userId);
    const isSharing = sharingUsers.has(r.userId);
    const runtimeUser = users.get(r.userId);
    return {
      userId: r.userId,
      name: relUser?.name || "Unknown",
      relationship: r.type,
      isSharing,
      lastSeen: runtimeUser?.lastSeen || null
    };
  });
  res.json(members);
});
app.get("/api/family/perimeters", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const userPerimeters = Array.from(familyPerimeters.values()).filter((p) => p.ownerId === userId).sort((a, b) => b.createdAt - a.createdAt);
  res.json(userPerimeters);
});
app.post("/api/family/perimeters", (req, res) => {
  const { ownerId, targetUserId, center, radiusMeters } = req.body;
  if (!ownerId || !targetUserId || !center?.latitude || !center?.longitude || !radiusMeters) {
    return res.status(400).json({ error: "ownerId, targetUserId, center {latitude, longitude}, and radiusMeters required" });
  }
  const familyIds = getFamilyMemberIds(ownerId);
  if (!familyIds.includes(targetUserId)) {
    return res.status(403).json({ error: "Target user is not a family member" });
  }
  const targetAdmin = adminUsers.get(targetUserId);
  const perimeter = {
    id: (0, import_uuid.v4)(),
    ownerId,
    targetUserId,
    targetUserName: targetAdmin?.name || targetUserId,
    center: { latitude: center.latitude, longitude: center.longitude, address: center.address || void 0 },
    radiusMeters: Number(radiusMeters),
    active: true,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  familyPerimeters.set(perimeter.id, perimeter);
  persistPerimeters();
  console.log(`[Perimeter] Created ${perimeter.id} for ${targetAdmin?.name || targetUserId} by ${ownerId} (${radiusMeters}m)`);
  res.json(perimeter);
});
app.put("/api/family/perimeters/:id", (req, res) => {
  const perimeter = familyPerimeters.get(req.params.id);
  if (!perimeter) return res.status(404).json({ error: "Perimeter not found" });
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
app.delete("/api/family/perimeters/:id", (req, res) => {
  const existed = familyPerimeters.delete(req.params.id);
  if (existed) deleteFamilyPerimeterFromSupabase(req.params.id);
  perimeterState.delete(req.params.id);
  if (existed) persistPerimeters();
  res.json({ success: existed });
});
app.get("/api/family/proximity-alerts", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const userAlerts = proximityAlerts.filter((a) => a.ownerId === userId).slice(0, limit);
  res.json(userAlerts);
});
app.put("/api/family/proximity-alerts/:id/acknowledge", (req, res) => {
  const alert = proximityAlerts.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  alert.acknowledged = true;
  persistProximityAlerts();
  res.json({ success: true });
});
app.get("/api/family/location-history", (req, res) => {
  const userId = req.query.userId;
  const targetUserId = req.query.targetUserId;
  if (!userId || !targetUserId) return res.status(400).json({ error: "userId and targetUserId required" });
  if (userId !== targetUserId) {
    const familyIds = getFamilyMemberIds(userId);
    if (!familyIds.includes(targetUserId)) {
      return res.status(403).json({ error: "Target user is not a family member" });
    }
  }
  const history = locationHistory.get(targetUserId) || [];
  const since = Number(req.query.since) || 0;
  const filtered = since > 0 ? history.filter((h) => h.timestamp >= since) : history;
  res.json(filtered.slice(-100));
});
app.get("/admin/health", (req, res) => {
  res.json({
    status: "ok",
    connectedUsers: userConnections.size,
    totalUsers: adminUsers.size,
    activeAlerts: Array.from(alerts.values()).filter((a) => a.status === "active").length,
    totalAlerts: alerts.size,
    wsClients: wss.clients.size,
    timestamp: Date.now()
  });
});
app.get("/admin/users", (req, res) => {
  const users2 = Array.from(adminUsers.values()).map((u) => {
    const { passwordHash, ...safeUser } = u;
    return { ...safeUser, hasPassword: !!passwordHash };
  });
  res.json(users2);
});
app.put("/admin/users/:id/role", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { role } = req.body;
  if (!["admin", "dispatcher", "responder", "user"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const oldRole = user.role;
  user.role = role;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry("user", "Role Changed", "Admin", `Role changed from ${oldRole} to ${role}`, user.name);
  res.json({ success: true });
});
app.put("/admin/users/:id/status", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { status } = req.body;
  if (!["active", "suspended", "deactivated"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const oldStatus = user.status;
  user.status = status;
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  const actionName = status === "suspended" ? "User Suspended" : status === "deactivated" ? "User Deactivated" : "User Reactivated";
  addAuditEntry("user", actionName, "Admin", `Status changed from ${oldStatus} to ${status}`, user.name);
  res.json({ success: true });
});
app.get("/admin/users/:id", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const enrichedRelationships = (user.relationships || []).map((r) => {
    const relUser = adminUsers.get(r.userId);
    return { ...r, userName: relUser?.name || r.userId, relatedUser: relUser ? { name: relUser.name, role: relUser.role, email: relUser.email } : null };
  });
  const sameAddress = [];
  if (user.address) {
    adminUsers.forEach((u) => {
      if (u.id !== user.id && u.address && u.address === user.address) {
        sameAddress.push({ id: u.id, name: u.name, role: u.role });
      }
    });
  }
  const { passwordHash, ...safeUser } = user;
  res.json({ ...safeUser, hasPassword: !!passwordHash, relationships: enrichedRelationships, sameAddress });
});
app.post("/admin/users", async (req, res) => {
  const { firstName, lastName, email, role, tags, address, addressComponents, phoneLandline, phoneMobile, comments, photoUrl, relationships, password } = req.body;
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: "firstName, lastName, and email are required" });
  }
  if (role && !["admin", "dispatcher", "responder", "user"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const existing = Array.from(adminUsers.values()).find((u) => u.email === email);
  if (existing) {
    return res.status(409).json({ error: "A user with this email already exists" });
  }
  let supabaseUserId = null;
  try {
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password: password || Math.random().toString(36).slice(-12),
      // mot de passe aléatoire si non fourni
      email_confirm: true
    });
    if (authError) {
      console.error("[Admin] Supabase Auth create error:", authError.message, authError.status);
    } else {
      supabaseUserId = authData.user.id;
      console.log("[Admin] Supabase Auth user created:", supabaseUserId);
    }
  } catch (e) {
    console.error("[Admin] Supabase Auth import error:", e);
  }
  const id = supabaseUserId || `usr-${(0, import_uuid.v4)().slice(0, 8)}`;
  const now = Date.now();
  const newUser = {
    id,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    email,
    role: role || "user",
    status: "active",
    lastLogin: 0,
    createdAt: now,
    tags: tags || [],
    address: address || "",
    addressComponents: addressComponents || void 0,
    phoneLandline: phoneLandline || "",
    phoneMobile: phoneMobile || "",
    comments: comments || "",
    photoUrl: photoUrl || "",
    relationships: relationships || [],
    passwordHash: password ? import_bcryptjs.default.hashSync(password, 10) : void 0
  };
  adminUsers.set(id, newUser);
  saveAdminUserToSupabase(newUser);
  (relationships || []).forEach((rel) => {
    const relUser = adminUsers.get(rel.userId);
    if (relUser) {
      const reciprocal = getReciprocalRelType(rel.type);
      if (!relUser.relationships) relUser.relationships = [];
      if (!relUser.relationships.find((r) => r.userId === id)) {
        relUser.relationships.push({ userId: id, type: reciprocal });
        adminUsers.set(relUser.id, relUser);
      }
    }
  });
  addAuditEntry("user", "User Created", "Admin", `New ${role || "user"}: ${firstName} ${lastName} (${email})`, newUser.name);
  const { passwordHash: _pwh, ...safeNewUser } = newUser;
  res.status(201).json({ ...safeNewUser, hasPassword: !!newUser.passwordHash });
});
app.put("/admin/users/:id", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const { firstName, lastName, email, role, tags, address, addressComponents, phoneLandline, phoneMobile, comments, photoUrl, relationships, status, password } = req.body;
  if (email && email !== user.email) {
    const existing = Array.from(adminUsers.values()).find((u) => u.email === email && u.id !== user.id);
    if (existing) return res.status(409).json({ error: "A user with this email already exists" });
  }
  if (role && !["admin", "dispatcher", "responder", "user"].includes(role)) {
    return res.status(400).json({ error: "Invalid role" });
  }
  const changes = [];
  if (firstName !== void 0) {
    user.firstName = firstName;
    changes.push("firstName");
  }
  if (lastName !== void 0) {
    user.lastName = lastName;
    changes.push("lastName");
  }
  if (firstName !== void 0 || lastName !== void 0) {
    user.name = `${user.firstName} ${user.lastName}`;
  }
  if (email !== void 0) {
    user.email = email;
    changes.push("email");
  }
  if (role !== void 0 && role !== user.role) {
    const old = user.role;
    user.role = role;
    changes.push(`role:${old}->${role}`);
  }
  if (status !== void 0 && status !== user.status) {
    const old = user.status;
    user.status = status;
    changes.push(`status:${old}->${status}`);
  }
  if (tags !== void 0) {
    user.tags = tags;
    changes.push("tags");
  }
  if (address !== void 0) {
    user.address = address;
    changes.push("address");
  }
  if (addressComponents !== void 0) {
    user.addressComponents = addressComponents;
  }
  if (phoneLandline !== void 0) {
    user.phoneLandline = phoneLandline;
    changes.push("phoneLandline");
  }
  if (phoneMobile !== void 0) {
    user.phoneMobile = phoneMobile;
    changes.push("phoneMobile");
  }
  if (comments !== void 0) {
    user.comments = comments;
    changes.push("comments");
  }
  if (photoUrl !== void 0) {
    user.photoUrl = photoUrl;
    changes.push("photo");
  }
  if (password) {
    user.passwordHash = import_bcryptjs.default.hashSync(password, 10);
    changes.push("password");
  }
  if (relationships !== void 0) {
    (user.relationships || []).forEach((oldRel) => {
      const relUser = adminUsers.get(oldRel.userId);
      if (relUser && relUser.relationships) {
        relUser.relationships = relUser.relationships.filter((r) => r.userId !== user.id);
        adminUsers.set(relUser.id, relUser);
      }
    });
    user.relationships = relationships;
    relationships.forEach((rel) => {
      const relUser = adminUsers.get(rel.userId);
      if (relUser) {
        const reciprocal = getReciprocalRelType(rel.type);
        if (!relUser.relationships) relUser.relationships = [];
        if (!relUser.relationships.find((r) => r.userId === user.id)) {
          relUser.relationships.push({ userId: user.id, type: reciprocal });
          adminUsers.set(relUser.id, relUser);
          saveAdminUserToSupabase(relUser);
        }
      }
    });
    changes.push("relationships");
  }
  adminUsers.set(user.id, user);
  saveAdminUserToSupabase(user);
  addAuditEntry("user", "User Updated", "Admin", `Updated: ${changes.join(", ")}`, user.name);
  const { passwordHash: _pw, ...safeUpdatedUser } = user;
  res.json({ ...safeUpdatedUser, hasPassword: !!user.passwordHash });
});
app.delete("/admin/users/:id", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  (user.relationships || []).forEach((rel) => {
    const relUser = adminUsers.get(rel.userId);
    if (relUser && relUser.relationships) {
      relUser.relationships = relUser.relationships.filter((r) => r.userId !== user.id);
      adminUsers.set(relUser.id, relUser);
    }
  });
  adminUsers.delete(user.id);
  deleteAdminUserFromSupabase(user.id);
  addAuditEntry("user", "User Deleted", "Admin", `Deleted user: ${user.name} (${user.email})`, user.name);
  res.json({ success: true, deletedUser: user.name });
});
app.get("/admin/users/:id/cohabitants", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  if (!user.address) return res.json([]);
  const cohabitants = [];
  adminUsers.forEach((u) => {
    if (u.id !== user.id && u.address && u.address === user.address) {
      cohabitants.push(u);
    }
  });
  res.json(cohabitants);
});
app.get("/admin/users/:id/relationships", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const enriched = (user.relationships || []).map((r) => {
    const relUser = adminUsers.get(r.userId);
    return { ...r, userName: relUser?.name || "Unknown", userEmail: relUser?.email || "", userRole: relUser?.role || "" };
  });
  res.json(enriched);
});
function getReciprocalRelType(type) {
  const map = {
    "parent": "child",
    "child": "parent",
    "spouse": "spouse",
    "sibling": "sibling",
    "cohabitant": "cohabitant",
    "other": "other"
  };
  return map[type] || "other";
}
app.get("/admin/incidents", (req, res) => {
  const incidents = Array.from(alerts.values()).map((a) => ({
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    reportedBy: a.createdBy,
    address: a.location.address,
    timestamp: a.createdAt,
    resolvedAt: a.status === "resolved" ? a.createdAt + Math.floor(Math.random() * 36e5) : void 0,
    assignedCount: a.respondingUsers.length
  }));
  res.json(incidents);
});
app.get("/admin/audit", (req, res) => {
  res.json(auditLog);
});
app.get("/admin", (req, res) => {
  res.redirect("/admin-console/");
});
app.get("/dispatch", (req, res) => {
  res.redirect("/dispatch-v2/");
});
app.get("/dispatch/responders", (req, res) => {
  const now = Date.now();
  const allResponders = [];
  adminUsers.forEach((user) => {
    if (user.role !== "responder") return;
    if (user.status === "deactivated") return;
    const runtimeUser = users.get(user.id);
    const assignedIncidents = [];
    alerts.forEach((alert) => {
      if (alert.status !== "resolved" && alert.respondingUsers.includes(user.id)) {
        const respStatus = alert.responderStatuses?.[user.id] || "assigned";
        assignedIncidents.push({
          id: alert.id,
          type: alert.type,
          severity: alert.severity,
          status: alert.status,
          address: alert.location?.address || "Unknown",
          latitude: alert.location?.latitude,
          longitude: alert.location?.longitude,
          responderStatus: respStatus
        });
      }
    });
    allResponders.push({
      id: user.id,
      name: user.name,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phoneMobile || "",
      tags: user.tags || [],
      accountStatus: user.status,
      // 'active' | 'suspended'
      // Runtime status from WS connection, then dispatch override, then default
      status: runtimeUser?.status || responderStatusOverrides.get(user.id)?.status || "off_duty",
      location: runtimeUser?.location || null,
      lastSeen: runtimeUser?.lastSeen || user.lastLogin || now - 36e5,
      isConnected: !!runtimeUser,
      assignedIncidents,
      assignedCount: assignedIncidents.length
    });
  });
  const statusOrder = { on_duty: 0, available: 1, responding: 1, off_duty: 2 };
  allResponders.sort((a, b) => {
    if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
    const sa = statusOrder[a.status] ?? 3;
    const sb = statusOrder[b.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });
  res.json(allResponders);
});
app.put("/dispatch/responders/:id/status", (req, res) => {
  const responderId = req.params.id;
  const { status } = req.body;
  const validStatuses = ["available", "on_duty", "off_duty", "responding"];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
  }
  const runtimeUser = users.get(responderId);
  if (runtimeUser) {
    runtimeUser.status = status;
    runtimeUser.lastSeen = Date.now();
    users.set(responderId, runtimeUser);
  }
  responderStatusOverrides.set(responderId, { status, updatedAt: Date.now(), updatedBy: "dispatch" });
  const adminUser = adminUsers.get(responderId);
  const responderName = adminUser?.name || responderId;
  addAuditEntry("responder", "Status Changed", "Dispatch Console", `${responderName} status changed to ${status}`, responderId);
  broadcastToRole("dispatcher", {
    type: "responderStatusUpdate",
    userId: responderId,
    status,
    timestamp: Date.now()
  });
  res.json({ success: true, responderId, status, name: responderName });
});
app.put("/dispatch/incidents/:id/acknowledge", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  alert.status = "acknowledged";
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "Alert Acknowledged", "Dispatch Console", `Acknowledged ${alert.id}`);
  broadcastMessage({ type: "alertAcknowledged", alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});
app.put("/dispatch/incidents/:id/assign", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  const { responderId } = req.body;
  if (responderId && !alert.respondingUsers.includes(responderId)) {
    alert.respondingUsers.push(responderId);
  }
  if (alert.status === "active" || alert.status === "acknowledged") {
    alert.status = "acknowledged";
  }
  alerts.set(alert.id, alert);
  persistAlerts();
  if (!alert.responderStatuses) alert.responderStatuses = {};
  if (!alert.statusHistory) alert.statusHistory = [];
  if (responderId && !alert.responderStatuses[responderId]) {
    alert.responderStatuses[responderId] = "assigned";
  }
  const responderName = adminUsers.get(responderId)?.name || responderId;
  alert.statusHistory.push({
    responderId,
    responderName,
    status: "assigned",
    timestamp: Date.now()
  });
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch((e) => console.error("[Assign] Supabase save error:", e));
  addAuditEntry("incident", "Responder Assigned", "Dispatch Console", `Assigned ${responderName} to ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid)
  };
  broadcastMessage({ type: "alertUpdate", data: enrichedAlert });
  const TYPE_LABELS = {
    sos: "SOS",
    medical: "M\xE9dical",
    fire: "Incendie",
    security: "S\xE9curit\xE9",
    hazard: "Danger",
    accident: "Accident",
    broadcast: "Broadcast",
    home_jacking: "Home-Jacking",
    cambriolage: "Cambriolage",
    animal_perdu: "Animal perdu",
    evenement_climatique: "\xC9v\xE9nement climatique",
    rodage: "Rodage",
    vehicule_suspect: "V\xE9hicule suspect",
    fugue: "Fugue",
    route_bloquee: "Route bloqu\xE9e",
    route_fermee: "Route ferm\xE9e",
    other: "Autre"
  };
  const typeLabel = TYPE_LABELS[alert.type] || alert.type;
  const sevLabel = alert.severity === "critical" ? "CRITIQUE" : alert.severity === "high" ? "\xC9LEV\xC9" : alert.severity === "medium" ? "MOYEN" : "FAIBLE";
  sendPushToUser(
    responderId,
    `\u{1F6A8} Incident assign\xE9 \u2014 ${typeLabel} (${sevLabel})`,
    `Vous avez \xE9t\xE9 assign\xE9 \xE0 l'incident ${alert.id}.
\u{1F4CD} ${alert.location?.address || "Adresse inconnue"}`,
    { type: "assignment", alertId: alert.id, severity: alert.severity, alertType: alert.type }
  ).catch((err) => console.error("[Assign Push] Error:", err));
  if (responderId) {
    startAcceptanceTimer(alert.id, responderId);
  }
  res.json({ success: true, responderName });
});
app.put("/dispatch/incidents/:id/unassign", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  const { responderId } = req.body;
  if (!responderId) return res.status(400).json({ error: "responderId required" });
  const idx = alert.respondingUsers.indexOf(responderId);
  if (idx === -1) return res.status(400).json({ error: "Responder not assigned to this incident" });
  alert.respondingUsers.splice(idx, 1);
  clearAcceptanceTimer(alert.id, responderId);
  if (alert.responderStatuses) delete alert.responderStatuses[responderId];
  alerts.set(alert.id, alert);
  persistAlerts();
  const responderName = adminUsers.get(responderId)?.name || responderId;
  addAuditEntry("incident", "Responder Unassigned", "Dispatch Console", `Unassigned ${responderName} from ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid)
  };
  broadcastMessage({ type: "alertUpdate", data: enrichedAlert });
  res.json({ success: true, responderName });
});
app.get("/dispatch/incidents/:id/responders-nearby", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  const incidentLat = alert.location.latitude;
  const incidentLng = alert.location.longitude;
  const now = Date.now();
  const result = [];
  adminUsers.forEach((user) => {
    if (user.role !== "responder") return;
    if (user.status === "deactivated") return;
    const runtimeUser = users.get(user.id);
    const location = runtimeUser?.location || null;
    let distanceMeters = null;
    let distanceLabel = "Position inconnue";
    if (location && location.latitude && location.longitude) {
      distanceMeters = haversineDistance(location.latitude, location.longitude, incidentLat, incidentLng);
      if (distanceMeters < 1e3) {
        distanceLabel = `${Math.round(distanceMeters)} m`;
      } else {
        distanceLabel = `${(distanceMeters / 1e3).toFixed(1)} km`;
      }
    }
    const isAssigned = alert.respondingUsers.includes(user.id);
    result.push({
      id: user.id,
      name: user.name,
      phone: user.phoneMobile || "",
      tags: user.tags || [],
      status: runtimeUser?.status || responderStatusOverrides.get(user.id)?.status || "off_duty",
      isConnected: !!runtimeUser,
      isAssigned,
      distanceMeters,
      distanceLabel
    });
  });
  result.sort((a, b) => {
    if (a.isAssigned !== b.isAssigned) return a.isAssigned ? -1 : 1;
    if (a.distanceMeters !== null && b.distanceMeters !== null) return a.distanceMeters - b.distanceMeters;
    if (a.distanceMeters !== null) return -1;
    if (b.distanceMeters !== null) return 1;
    return a.name.localeCompare(b.name);
  });
  res.json({ incidentId: alert.id, incidentAddress: alert.location.address, responders: result });
});
app.put("/dispatch/incidents/:id/resolve", (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  alert.status = "resolved";
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("incident", "Incident Resolved", "Dispatch Console", `Resolved ${alert.id}: ${alert.type} at ${alert.location.address}`);
  broadcastMessage({ type: "alertResolved", alertId: alert.id, timestamp: Date.now() });
  res.json({ success: true });
});
app.put("/alerts/:id/respond", (req, res) => {
  let alert = alerts.get(req.params.id);
  if (!alert) {
    try {
      alert = alerts.get(decodeURIComponent(req.params.id));
    } catch (e) {
    }
  }
  if (!alert) {
    for (const [key, val] of alerts) {
      if (key.includes(req.params.id) || req.params.id.includes(key)) {
        alert = val;
        break;
      }
    }
  }
  if (!alert) return res.status(404).json({ error: "Incident not found" });
  const { responderId, status } = req.body;
  if (!responderId) return res.status(400).json({ error: "responderId required" });
  const validStatuses = ["accepted", "en_route", "on_scene"];
  if (!status || !validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
  }
  if (!alert.respondingUsers.includes(responderId)) {
    return res.status(400).json({ error: "Responder not assigned to this incident" });
  }
  if (!alert.responderStatuses) alert.responderStatuses = {};
  if (!alert.statusHistory) alert.statusHistory = [];
  alert.responderStatuses[responderId] = status;
  clearAcceptanceTimer(alert.id, responderId);
  const responderName = adminUsers.get(responderId)?.name || responderId;
  alert.statusHistory.push({
    responderId,
    responderName,
    status,
    timestamp: Date.now()
  });
  alerts.set(alert.id, alert);
  persistAlerts();
  saveAlertToSupabase(alert).catch((e) => console.error("[Respond] Supabase save error:", e));
  const STATUS_LABELS = { accepted: "Accept\xE9", en_route: "En route", on_scene: "Sur place" };
  const statusLabel = STATUS_LABELS[status] || status;
  addAuditEntry("incident", `Responder ${statusLabel}`, responderName, `${responderName} \u2014 ${statusLabel} pour ${alert.id}`, responderId);
  const enrichedAlert = {
    ...alert,
    respondingNames: (alert.respondingUsers || []).map((uid) => adminUsers.get(uid)?.name || uid)
  };
  broadcastMessage({ type: "alertUpdate", data: enrichedAlert });
  for (const [token, entry] of pushTokens) {
    if (entry.userRole === "dispatcher" || entry.userRole === "admin") {
      sendPushToUser(entry.userId, `${responderName} \u2014 ${statusLabel}`, `Incident ${alert.id}: ${responderName} est ${statusLabel.toLowerCase()}`, { type: "responder_status", alertId: alert.id, responderId, status }).catch(() => {
      });
      break;
    }
  }
  res.json({ success: true, responderId, status, statusLabel });
});
app.post("/dispatch/broadcast", async (req, res) => {
  const { message, severity, radiusKm, by, latitude, longitude } = req.body;
  if (!message) return res.status(400).json({ error: "Message required" });
  const sev = severity || "medium";
  const alert = {
    id: await generateIncidentId("broadcast", by || "Dispatch Console", { address: `Zone broadcast (${radiusKm || 5}km radius)` }),
    type: "broadcast",
    severity: sev,
    location: {
      latitude: latitude || 46.195,
      longitude: longitude || 6.158,
      address: `Zone broadcast (${radiusKm || 5}km radius)`
    },
    description: message,
    createdBy: by || "Dispatch Console",
    createdAt: Date.now(),
    status: "active",
    respondingUsers: []
  };
  alerts.set(alert.id, alert);
  persistAlerts();
  addAuditEntry("broadcast", "Zone Broadcast Sent", by || "Dispatch Console", `[${sev.toUpperCase()}] ${message} (${radiusKm || 5}km radius)`);
  broadcastMessage({ type: "newAlert", data: alert });
  broadcastMessage({ type: "zoneBroadcast", data: { message, severity: sev, radiusKm, by, timestamp: Date.now() } });
  sendPushToAllUsers(alert, by || "Dispatch Console").catch((err) => {
    console.error("[Broadcast] Push notification error:", err);
  });
  console.log(`[Broadcast] Alert ${alert.id} created and broadcast to ${wss.clients.size} clients`);
  res.json({ success: true, alertId: alert.id });
});
app.post("/dispatch/geofence/zones", (req, res) => {
  const { center, radiusKm, severity, message, createdBy } = req.body;
  if (!center || !radiusKm) return res.status(400).json({ error: "center and radiusKm required" });
  const normalizedCenter = {
    latitude: center.latitude ?? center.lat,
    longitude: center.longitude ?? center.lng
  };
  const zone = {
    id: "gf-" + Date.now(),
    center: normalizedCenter,
    radiusKm: parseFloat(radiusKm),
    severity: severity || "medium",
    message: message || "",
    createdAt: Date.now(),
    createdBy: createdBy || "Dispatch Console"
  };
  geofenceZones.set(zone.id, zone);
  responderZoneState.set(zone.id, /* @__PURE__ */ new Set());
  const demoResponderLocations = [
    { id: "resp-001", lat: 46.193, lng: 6.154 },
    { id: "resp-002", lat: 46.201, lng: 6.162 },
    { id: "resp-003", lat: 46.196, lng: 6.168 },
    { id: "resp-004", lat: 46.231, lng: 6.205 }
  ];
  const allResponders = Array.from(users.values()).filter((u) => u.role === "responder" && u.location);
  const respondersToCheck = allResponders.length > 0 ? allResponders.map((r) => ({ id: r.id, lat: r.location.latitude, lng: r.location.longitude })) : demoResponderLocations;
  respondersToCheck.forEach((r) => {
    const dist = haversineDistance(r.lat, r.lng, zone.center.latitude, zone.center.longitude);
    if (dist <= zone.radiusKm * 1e3) {
      responderZoneState.get(zone.id).add(r.id);
    }
  });
  addAuditEntry("broadcast", "Geofence Zone Created", zone.createdBy, `Zone ${zone.id}: ${zone.severity} \u2014 ${zone.radiusKm}km radius`);
  broadcastMessage({ type: "geofenceZoneCreated", data: zone });
  res.json({ success: true, zone });
});
app.get("/dispatch/geofence/zones", (req, res) => {
  const zones = Array.from(geofenceZones.values()).map((z) => ({
    ...z,
    respondersInside: responderZoneState.get(z.id)?.size || 0
  }));
  res.json(zones);
});
app.delete("/dispatch/geofence/zones/:id", (req, res) => {
  const zoneId = req.params.id;
  if (!geofenceZones.has(zoneId)) return res.status(404).json({ error: "Zone not found" });
  geofenceZones.delete(zoneId);
  responderZoneState.delete(zoneId);
  addAuditEntry("broadcast", "Geofence Zone Deleted", "Dispatch Console", `Zone ${zoneId} removed`);
  broadcastMessage({ type: "geofenceZoneDeleted", data: { zoneId } });
  res.json({ success: true });
});
app.get("/dispatch/geofence/events", (req, res) => {
  res.json({ success: true, events: geofenceEvents.slice(0, 100) });
});
app.post("/dispatch/geofence/simulate-move", (req, res) => {
  const { responderId, latitude, longitude } = req.body;
  if (!responderId || latitude == null || longitude == null) {
    return res.status(400).json({ error: "responderId, latitude, longitude required" });
  }
  let user = users.get(responderId);
  if (!user) {
    user = { id: responderId, email: `${responderId}@talion.local`, role: "responder", status: "on_duty", lastSeen: Date.now() };
    users.set(responderId, user);
  }
  user.location = { latitude, longitude };
  user.lastSeen = Date.now();
  users.set(responderId, user);
  checkGeofences(responderId, { latitude, longitude });
  broadcastMessage({
    type: "responderLocationUpdate",
    userId: responderId,
    location: { latitude, longitude },
    timestamp: Date.now()
  });
  res.json({ success: true, responderId, location: { latitude, longitude } });
});
app.get("/dispatch/map/users", (req, res) => {
  const now = Date.now();
  const connectedUsersList = Array.from(users.values()).filter((u) => u.location && u.role !== "responder").map((u) => {
    const adminUser = adminUsers.get(u.id);
    const name = adminUser ? `${adminUser.firstName} ${adminUser.lastName}`.trim() : u.id;
    return {
      id: u.id,
      name,
      role: u.role,
      status: u.status || "available",
      location: u.location,
      lastSeen: u.lastSeen || now
    };
  });
  const demoUserLocations = [
    { id: "user-001", name: "Thomas Leroy", role: "user", status: "active", location: { latitude: 46.194, longitude: 6.156 }, lastSeen: now - 3 * 36e5 },
    { id: "user-002", name: "Julie Morel", role: "user", status: "active", location: { latitude: 46.195, longitude: 6.167 }, lastSeen: now - 6 * 36e5 },
    { id: "user-004", name: "Lea Leroy", role: "user", status: "active", location: { latitude: 46.202, longitude: 6.164 }, lastSeen: now - 45 * 6e4 },
    { id: "user-005", name: "Hugo Leroy", role: "user", status: "active", location: { latitude: 46.232, longitude: 6.207 }, lastSeen: now - 2 * 864e5 },
    { id: "disp-001", name: "Jean Moreau", role: "dispatcher", status: "active", location: { latitude: 46.1955, longitude: 6.1675 }, lastSeen: now - 12 * 6e4 },
    { id: "disp-002", name: "Sophie Laurent", role: "dispatcher", status: "active", location: { latitude: 46.2005, longitude: 6.1615 }, lastSeen: now - 2 * 36e5 },
    { id: "admin-001", name: "Marie Dupont", role: "admin", status: "active", location: { latitude: 46.1925, longitude: 6.1535 }, lastSeen: now - 5 * 6e4 }
  ];
  const mergedIds = new Set(connectedUsersList.map((u) => u.id));
  const merged = [
    ...connectedUsersList,
    ...demoUserLocations.filter((d) => !mergedIds.has(d.id))
  ];
  res.json(merged);
});
app.get("/dispatch/map/all", (req, res) => {
  const now = Date.now();
  const allAlerts = Array.from(alerts.values()).map((a) => ({
    entityType: "incident",
    id: a.id,
    type: a.type,
    severity: a.severity,
    status: a.status,
    location: a.location,
    description: a.description,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
    respondingUsers: a.respondingUsers,
    photos: a.photos || []
  }));
  res.json({ incidents: allAlerts, timestamp: now });
});
function resolveGroupParticipants(conv) {
  const ids = new Set(conv.participantIds);
  const activeStatuses = ["active", "available", "on_duty"];
  if (conv.filterRole) {
    adminUsers.forEach((u) => {
      if (u.role === conv.filterRole && activeStatuses.includes(u.status)) ids.add(u.id);
    });
  }
  if (conv.filterTags && conv.filterTags.length > 0) {
    adminUsers.forEach((u) => {
      if (activeStatuses.includes(u.status) && u.tags && conv.filterTags.some((t) => u.tags.includes(t))) ids.add(u.id);
    });
  }
  return Array.from(ids);
}
app.get("/api/users", (req, res) => {
  const allUsers = Array.from(adminUsers.values()).filter((u) => u.status === "active").map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, tags: u.tags || [] }));
  res.json(allUsers);
});
app.get("/api/tags", (req, res) => {
  const tagSet = /* @__PURE__ */ new Set();
  adminUsers.forEach((u) => (u.tags || []).forEach((t) => tagSet.add(t)));
  res.json(Array.from(tagSet).sort());
});
app.put("/api/users/:id/tags", (req, res) => {
  const user = adminUsers.get(req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  user.tags = req.body.tags || [];
  adminUsers.set(user.id, user);
  res.json({ success: true, user: { id: user.id, name: user.name, tags: user.tags } });
});
app.get("/api/conversations", (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const userConvos = [];
  conversations.forEach((conv) => {
    const allParticipants = resolveGroupParticipants(conv);
    if (allParticipants.includes(userId) || conv.createdBy === userId) {
      const convMessages = messages.get(conv.id) || [];
      const lastMsg = convMessages.length > 0 ? convMessages[convMessages.length - 1] : null;
      let displayName = conv.name;
      if (conv.type === "direct") {
        const otherId = conv.participantIds.find((id) => id !== userId);
        const otherUser = otherId ? adminUsers.get(otherId) : null;
        displayName = otherUser ? otherUser.name : conv.name;
      }
      const unreadCounts = conv.unreadCounts || {};
      userConvos.push({
        ...conv,
        displayName,
        participantCount: allParticipants.length,
        lastMessage: lastMsg ? lastMsg.text : conv.lastMessage,
        lastMessageTime: lastMsg ? lastMsg.timestamp : conv.lastMessageTime,
        lastSenderName: lastMsg ? lastMsg.senderName : "",
        unreadCount: unreadCounts[userId] || 0
      });
    }
  });
  userConvos.sort((a, b) => b.lastMessageTime - a.lastMessageTime);
  res.json(userConvos);
});
app.post("/api/conversations", (req, res) => {
  const { type, name, participantIds, filterRole, filterTags, createdBy } = req.body;
  if (!createdBy) return res.status(400).json({ error: "createdBy required" });
  if (!type) return res.status(400).json({ error: "type required (direct or group)" });
  if (type === "direct" && participantIds && participantIds.length === 2) {
    const sorted = [...participantIds].sort();
    const existingId = `dm-${sorted[0]}-${sorted[1]}`;
    const existing = conversations.get(existingId);
    if (existing) return res.json(existing);
    const conv2 = {
      id: existingId,
      type: "direct",
      name: name || "Direct Message",
      participantIds: sorted,
      createdBy,
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
      lastMessage: ""
    };
    conversations.set(conv2.id, conv2);
    messages.set(conv2.id, []);
    return res.json(conv2);
  }
  const convId = `grp-${(0, import_uuid.v4)().slice(0, 8)}`;
  const conv = {
    id: convId,
    type: "group",
    name: name || "Group Chat",
    participantIds: participantIds || [createdBy],
    filterRole: filterRole || void 0,
    filterTags: filterTags || void 0,
    createdBy,
    createdAt: Date.now(),
    lastMessageTime: Date.now(),
    lastMessage: ""
  };
  conversations.set(conv.id, conv);
  messages.set(conv.id, []);
  const creatorUser = adminUsers.get(createdBy);
  const sysMsg = {
    id: (0, import_uuid.v4)(),
    conversationId: convId,
    senderId: "system",
    senderName: "System",
    senderRole: "system",
    text: `Group "${conv.name}" created by ${creatorUser?.name || createdBy}`,
    type: "system",
    timestamp: Date.now()
  };
  messages.get(convId).push(sysMsg);
  res.json(conv);
});
app.post("/api/conversations/:id/media", uploadMedia.single("file"), async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const { senderId, senderName, mediaType } = req.body;
  if (!senderId) return res.status(400).json({ error: "senderId required" });
  const senderUser = adminUsers.get(senderId);
  let mediaUrl = `/uploads/${req.file.filename}`;
  try {
    const fileBuffer = import_fs.default.readFileSync(req.file.path);
    const fileName2 = `${Date.now()}-${req.file.filename}`;
    const mimeType = req.file.mimetype || (mediaType === "audio" ? "audio/m4a" : "image/jpeg");
    const { data: uploadData, error: uploadError } = await supabaseAdmin.storage.from("media").upload(fileName2, fileBuffer, { contentType: mimeType, upsert: false });
    if (!uploadError && uploadData) {
      const { data: { publicUrl } } = supabaseAdmin.storage.from("media").getPublicUrl(fileName2);
      mediaUrl = publicUrl;
      console.log("[Media] Uploaded to Supabase Storage:", mediaUrl);
    } else {
      console.warn("[Media] Supabase Storage upload failed, using local:", uploadError?.message);
    }
  } catch (e) {
    console.warn("[Media] Storage error, using local fallback:", e);
  }
  const msgType = mediaType === "audio" ? "audio" : mediaType === "document" ? "document" : "image";
  const fileName = req.body.fileName || req.file.originalname || "Document";
  const text = mediaType === "audio" ? "\u{1F3A4} Message vocal" : mediaType === "document" ? `\u{1F4CE} ${fileName}` : "\u{1F4F7} Photo";
  const msg = {
    id: (0, import_uuid.v4)(),
    conversationId: conv.id,
    senderId,
    senderName: senderName || senderUser?.name || senderId,
    senderRole: senderUser?.role || "user",
    text,
    type: msgType,
    mediaUrl,
    mediaType: msgType,
    timestamp: Date.now()
  };
  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id).push(msg);
  saveMessageToSupabase(msg).catch(() => {
  });
  conv.lastMessage = text;
  conv.lastMessageTime = msg.timestamp;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {
  });
  const allParticipants = resolveGroupParticipants(conv);
  const wsPayload = JSON.stringify({ type: "newMessage", data: { ...msg, conversationName: conv.name, conversationType: conv.type } });
  allParticipants.forEach((pid) => {
    const conns = userConnections.get(pid);
    if (conns) conns.forEach((ws) => {
      try {
        ws.send(wsPayload);
      } catch {
      }
    });
  });
  for (const pid of allParticipants) {
    if (pid === senderId) continue;
    sendPushToUser(
      pid,
      `${msgType === "audio" ? "\u{1F3A4}" : "\u{1F4F7}"} ${msg.senderName}`,
      msgType === "audio" ? "Message vocal" : msgType === "document" ? "Document partag\xE9" : "Photo",
      { type: "message", conversationId: conv.id, senderId }
    ).catch(() => {
    });
  }
  console.log(`[MSG Media] ${msg.senderName} -> ${conv.name} (${conv.id}): ${msgType}`);
  res.json({ message: { ...msg, content: msg.text } });
});
app.put("/api/conversations/:id/read", async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  const unreadCounts = conv.unreadCounts || {};
  unreadCounts[userId] = 0;
  conv.unreadCounts = unreadCounts;
  conversations.set(conv.id, conv);
  await supabaseAdmin.from("conversations").update({ unread_counts: unreadCounts }).eq("id", conv.id);
  res.json({ success: true });
});
app.get("/api/conversations/:id/messages", async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (!messages.has(conv.id)) {
    try {
      const { data } = await supabaseAdmin.from("messages").select("*").eq("conversation_id", conv.id).order("timestamp", { ascending: true });
      if (data && data.length > 0) {
        const loaded = data.map((m) => ({
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          senderName: m.sender_name,
          senderRole: m.sender_role,
          text: m.text,
          type: m.type,
          timestamp: m.timestamp,
          mediaUrl: m.media_url || void 0,
          mediaType: m.media_type || void 0,
          location: m.location || void 0
        }));
        messages.set(conv.id, loaded);
      }
    } catch (e) {
      console.error("[Messages] Supabase load error:", e);
    }
  }
  const convMessages = messages.get(conv.id) || [];
  const since = req.query.since ? parseInt(req.query.since) : 0;
  const filtered = since > 0 ? convMessages.filter((m) => m.timestamp > since) : convMessages;
  res.json(filtered);
});
app.post("/api/conversations/:id/messages", (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  const { senderId, text, type: msgType } = req.body;
  if (!senderId || !text) return res.status(400).json({ error: "senderId and text required" });
  const senderUser = adminUsers.get(senderId);
  const msg = {
    id: (0, import_uuid.v4)(),
    conversationId: conv.id,
    senderId,
    senderName: senderUser?.name || senderId,
    senderRole: senderUser?.role || "user",
    text,
    type: msgType || "text",
    timestamp: Date.now()
  };
  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id).push(msg);
  saveMessageToSupabase(msg).catch(() => {
  });
  conv.lastMessage = text;
  conv.lastMessageTime = msg.timestamp;
  const allPartsForUnread = resolveGroupParticipants(conv);
  const unreadCounts = conv.unreadCounts || {};
  for (const pid of allPartsForUnread) {
    if (pid !== senderId) {
      unreadCounts[pid] = (unreadCounts[pid] || 0) + 1;
    }
  }
  conv.unreadCounts = unreadCounts;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {
  });
  supabaseAdmin.from("conversations").update({ unread_counts: unreadCounts }).eq("id", conv.id).then(() => {
  }).catch(() => {
  });
  const allParticipants = resolveGroupParticipants(conv);
  const wsPayload = JSON.stringify({
    type: "newMessage",
    data: { ...msg, conversationName: conv.name, conversationType: conv.type }
  });
  allParticipants.forEach((pid) => {
    const conns = userConnections.get(pid);
    if (conns) {
      conns.forEach((ws) => {
        try {
          ws.send(wsPayload);
        } catch (e) {
        }
      });
    }
  });
  userConnections.forEach((conns, uid) => {
    const u = adminUsers.get(uid);
    if (u && (u.role === "dispatcher" || u.role === "admin") && !allParticipants.includes(uid)) {
      conns.forEach((ws) => {
        try {
          ws.send(wsPayload);
        } catch (e) {
        }
      });
    }
  });
  for (const pid of allParticipants) {
    if (pid === senderId) continue;
    sendPushToUser(
      pid,
      `\u{1F4AC} ${msg.senderName}`,
      text.substring(0, 100),
      { type: "message", conversationId: conv.id, senderId, senderName: msg.senderName }
    ).catch(() => {
    });
  }
  console.log(`[MSG] ${msg.senderName} -> ${conv.name} (${conv.id}): ${text.substring(0, 50)}`);
  res.json(msg);
});
app.get("/api/messaging/users", (_req, res) => {
  const users2 = Array.from(adminUsers.values()).map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role,
    tags: u.tags || [],
    status: u.status
  }));
  res.json({ users: users2 });
});
app.get("/api/messaging/conversations", (req, res) => {
  const userId = req.query.userId;
  const allConvs = Array.from(conversations.values());
  const filtered = userId ? allConvs.filter((c) => {
    const participants = resolveGroupParticipants(c);
    return participants.includes(userId);
  }) : allConvs;
  const result = filtered.map((c) => {
    const msgs = messages.get(c.id) || [];
    const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    return {
      ...c,
      participants: resolveGroupParticipants(c),
      lastMessage: lastMsg ? lastMsg.text : c.lastMessage,
      lastMessageAt: lastMsg ? new Date(lastMsg.timestamp).toISOString() : c.lastMessageTime ? new Date(c.lastMessageTime).toISOString() : null
    };
  });
  result.sort((a, b) => new Date(b.lastMessageAt || 0).getTime() - new Date(a.lastMessageAt || 0).getTime());
  res.json({ conversations: result });
});
app.post("/api/messaging/conversations", (req, res) => {
  const { type, name, groupType, createdBy, participants, tags } = req.body;
  if (!type || !createdBy) return res.status(400).json({ error: "type and createdBy required" });
  let finalParticipants = participants || [];
  if (tags && tags.length > 0 && (!participants || participants.length <= 1)) {
    const tagUsers = Array.from(adminUsers.values()).filter((u) => u.tags && u.tags.some((t) => tags.includes(t))).map((u) => u.id);
    finalParticipants = [.../* @__PURE__ */ new Set([createdBy, ...tagUsers])];
  }
  if (type === "direct" && finalParticipants.length === 2) {
    const sorted = [...finalParticipants].sort();
    const existingId = `dm-${sorted[0]}-${sorted[1]}`;
    const existing = conversations.get(existingId);
    if (existing) {
      return res.json({ conversation: { ...existing, participants: existing.participantIds } });
    }
  }
  let filterTags;
  let filterRole;
  if (groupType?.startsWith("role:")) {
    filterRole = groupType.replace("role:", "");
  }
  if (groupType?.startsWith("tags:") || tags && tags.length > 0) {
    filterTags = tags || groupType?.replace("tags:", "").split(",");
  }
  const convId = type === "direct" && finalParticipants.length === 2 ? `dm-${[...finalParticipants].sort().join("-")}` : `grp-${(0, import_uuid.v4)().slice(0, 8)}`;
  const conv = {
    id: convId,
    type: type || "direct",
    name: name || (type === "direct" ? "Direct Message" : "Group"),
    participantIds: finalParticipants,
    filterRole,
    filterTags,
    createdBy,
    createdAt: Date.now(),
    lastMessage: "",
    lastMessageTime: Date.now()
  };
  conversations.set(conv.id, conv);
  messages.set(conv.id, []);
  if (type === "group") {
    const creatorUser = adminUsers.get(createdBy);
    const sysMsg = {
      id: (0, import_uuid.v4)(),
      conversationId: convId,
      senderId: "system",
      senderName: "System",
      senderRole: "system",
      text: `Group "${conv.name}" created by ${creatorUser?.name || createdBy}`,
      type: "system",
      timestamp: Date.now()
    };
    messages.get(convId).push(sysMsg);
  }
  saveConversationToSupabase(conv).catch(() => {
  });
  console.log(`[MSG] Conversation created: ${conv.name || conv.type} (${conv.id}) by ${createdBy}`);
  res.json({ conversation: { ...conv, participants: conv.participantIds } });
});
app.get("/api/messaging/conversations/:id/messages", async (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (!messages.has(conv.id)) {
    try {
      const { data } = await supabaseAdmin.from("messages").select("*").eq("conversation_id", conv.id).order("timestamp", { ascending: true });
      if (data && data.length > 0) {
        const loaded = data.map((m) => ({
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          senderName: m.sender_name,
          senderRole: m.sender_role,
          text: m.text,
          type: m.type,
          timestamp: m.timestamp,
          mediaUrl: m.media_url || void 0,
          mediaType: m.media_type || void 0,
          location: m.location || void 0
        }));
        messages.set(conv.id, loaded);
      }
    } catch (e) {
      console.error("[Messages] Supabase load error:", e);
    }
  }
  const msgs = messages.get(conv.id) || [];
  const mapped = msgs.map((m) => ({
    id: m.id,
    conversationId: m.conversationId,
    senderId: m.senderId,
    senderName: m.senderName,
    senderRole: m.senderRole,
    content: m.text,
    text: m.text,
    type: m.type,
    timestamp: new Date(m.timestamp).toISOString(),
    mediaUrl: m.mediaUrl || void 0,
    mediaType: m.mediaType || void 0,
    location: m.location || void 0
  }));
  res.json({ messages: mapped });
});
app.post("/api/messaging/conversations/:id/messages", (req, res) => {
  const conv = conversations.get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  const { senderId, senderName, content } = req.body;
  if (!senderId || !content) return res.status(400).json({ error: "senderId and content required" });
  const senderUser = adminUsers.get(senderId);
  const msg = {
    id: (0, import_uuid.v4)(),
    conversationId: conv.id,
    senderId,
    senderName: senderName || senderUser?.name || senderId,
    senderRole: senderUser?.role || "dispatcher",
    text: content,
    type: "text",
    timestamp: Date.now()
  };
  if (!messages.has(conv.id)) messages.set(conv.id, []);
  messages.get(conv.id).push(msg);
  saveMessageToSupabase(msg).catch(() => {
  });
  conv.lastMessage = content;
  conv.lastMessageTime = msg.timestamp;
  const unreadCountsMsg = conv.unreadCounts || {};
  const allPartsMsg = resolveGroupParticipants(conv);
  for (const pid of allPartsMsg) {
    if (pid !== senderId) {
      unreadCountsMsg[pid] = (unreadCountsMsg[pid] || 0) + 1;
    }
  }
  conv.unreadCounts = unreadCountsMsg;
  conversations.set(conv.id, conv);
  saveConversationToSupabase(conv).catch(() => {
  });
  supabaseAdmin.from("conversations").update({ unread_counts: unreadCountsMsg }).eq("id", conv.id).then(() => {
  }).catch(() => {
  });
  const allParticipants = resolveGroupParticipants(conv);
  const wsPayload = JSON.stringify({
    type: "newMessage",
    data: { ...msg, content: msg.text, conversationName: conv.name, conversationType: conv.type }
  });
  allParticipants.forEach((pid) => {
    const conns = userConnections.get(pid);
    if (conns) {
      conns.forEach((ws) => {
        try {
          ws.send(wsPayload);
        } catch (e) {
        }
      });
    }
  });
  userConnections.forEach((conns, uid) => {
    const u = adminUsers.get(uid);
    if (u && (u.role === "dispatcher" || u.role === "admin") && !allParticipants.includes(uid)) {
      conns.forEach((ws) => {
        try {
          ws.send(wsPayload);
        } catch (e) {
        }
      });
    }
  });
  const notifiedPids = /* @__PURE__ */ new Set([senderId]);
  for (const pid of allParticipants) {
    if (notifiedPids.has(pid)) continue;
    notifiedPids.add(pid);
    sendPushToUser(
      pid,
      `\u{1F4AC} ${msg.senderName}`,
      content.substring(0, 100),
      { type: "message", conversationId: conv.id, senderId, senderName: msg.senderName }
    ).catch(() => {
    });
  }
  console.log(`[MSG] ${msg.senderName} -> ${conv.name || conv.type} (${conv.id}): ${content.substring(0, 50)}`);
  res.json({ message: { ...msg, content: msg.text } });
});
app.get("/api/messaging/tags", (_req, res) => {
  const tagSet = /* @__PURE__ */ new Set();
  adminUsers.forEach((u) => (u.tags || []).forEach((t) => tagSet.add(t)));
  res.json({ tags: [...tagSet].sort() });
});
var PATROL_SITES = [
  "Champel \u2014 Avenue de Champel 24",
  "Champel \u2014 Chemin des Cr\xEAts-de-Champel 2",
  "Florissant \u2014 Route de Florissant 62",
  "Florissant \u2014 Avenue de Miremont 30",
  "Malagnou \u2014 Route de Malagnou 32",
  "Malagnou \u2014 Chemin du Velours 10",
  "V\xE9senaz \u2014 Route de Thonon 85",
  "V\xE9senaz \u2014 Chemin de la Capite 12"
];
var PATROL_STATUS_CONFIG = {
  habituel: { label: "Habituel", color: "#22C55E", severity: 0 },
  inhabituel: { label: "Inhabituel", color: "#EAB308", severity: 1 },
  identification: { label: "Identification", color: "#F97316", severity: 2 },
  suspect: { label: "Suspect", color: "#EF4444", severity: 3 },
  menace: { label: "Menace", color: "#8B5CF6", severity: 4 },
  attaque: { label: "Attaque", color: "#000000", severity: 5 }
};
app.get("/api/patrol/sites", (_req, res) => {
  res.json({ sites: PATROL_SITES });
});
app.get("/api/patrol/statuses", (_req, res) => {
  res.json({ statuses: PATROL_STATUS_CONFIG });
});
app.post("/api/patrol/reports", (req, res) => {
  const { createdBy, location, status, tasks, notes } = req.body;
  if (!createdBy || !location || !status || !tasks) {
    return res.status(400).json({ error: "createdBy, location, status, and tasks are required" });
  }
  if (!PATROL_STATUS_CONFIG[status]) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${Object.keys(PATROL_STATUS_CONFIG).join(", ")}` });
  }
  const user = adminUsers.get(createdBy);
  if (!user || user.role !== "responder" && user.role !== "dispatcher" && user.role !== "admin") {
    return res.status(403).json({ error: "Only responders, dispatchers, and admins can create patrol reports" });
  }
  const report = {
    id: `PR-${(0, import_uuid.v4)().slice(0, 8)}`,
    createdAt: Date.now(),
    createdBy,
    createdByName: user.name || createdBy,
    location,
    status,
    tasks,
    notes: notes || void 0,
    media: []
  };
  patrolReports.unshift(report);
  persistPatrolReports();
  const statusConf = PATROL_STATUS_CONFIG[report.status];
  auditLog.unshift({
    id: (0, import_uuid.v4)(),
    timestamp: Date.now(),
    category: "patrol",
    action: "Patrol Report Created",
    performedBy: report.createdByName,
    details: `Rapport de ronde: ${report.location} \u2014 Statut: ${statusConf.label}`
  });
  if (report.status !== "habituel") {
    const alertMsg = {
      type: "patrolAlert",
      data: {
        reportId: report.id,
        location: report.location,
        status: report.status,
        statusLabel: statusConf.label,
        statusColor: statusConf.color,
        createdByName: report.createdByName,
        createdAt: report.createdAt,
        tasks: report.tasks,
        notes: report.notes
      }
    };
    broadcastToRole("dispatcher", alertMsg);
    broadcastToRole("admin", alertMsg);
    const pushTitle = `\u26A0\uFE0F Ronde ${statusConf.label}`;
    const pushBody = `${report.createdByName} \u2014 ${report.location}
Statut: ${statusConf.label}${report.notes ? "\n" + report.notes : ""}`;
    const pushTokenEntries = Array.from(pushTokens.entries());
    const dispatchAdminTokens = pushTokenEntries.filter(([_, entry]) => {
      const u = adminUsers.get(entry.userId);
      return u && (u.role === "dispatcher" || u.role === "admin");
    }).map(([token]) => token);
    if (dispatchAdminTokens.length > 0) {
      const pushMessages = dispatchAdminTokens.map((token) => ({
        to: token,
        sound: "default",
        title: pushTitle,
        body: pushBody,
        data: { type: "patrol_alert", reportId: report.id }
      }));
      fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pushMessages)
      }).catch((err) => console.error("[Patrol] Push notification error:", err));
    }
    console.log(`[Patrol] ALERT: ${statusConf.label} report at ${report.location} by ${report.createdByName}`);
  } else {
    console.log(`[Patrol] Report created: ${report.location} by ${report.createdByName} (Habituel)`);
  }
  res.json({ success: true, report });
});
app.get("/api/patrol/reports", (req, res) => {
  const userId = req.query.userId;
  const role = req.query.role;
  const locationFilter = req.query.location;
  const statusFilter = req.query.status;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  if (userId) {
    const user = adminUsers.get(userId);
    if (user && user.role === "user") {
      return res.status(403).json({ error: "Regular users cannot access patrol reports" });
    }
  }
  let filtered = [...patrolReports];
  if (locationFilter) {
    filtered = filtered.filter((r) => r.location === locationFilter);
  }
  if (statusFilter) {
    filtered = filtered.filter((r) => r.status === statusFilter);
  }
  if (role === "responder" && userId) {
    filtered = filtered.filter((r) => r.createdBy === userId);
  }
  res.json({ reports: filtered.slice(0, limit), total: filtered.length });
});
app.get("/api/patrol/reports/:id", (req, res) => {
  const report = patrolReports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: "Patrol report not found" });
  res.json(report);
});
app.post("/api/patrol/reports/:id/media", uploadMedia.single("media"), (req, res) => {
  const report = patrolReports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: "Patrol report not found" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const ext = req.file.originalname.split(".").pop()?.toLowerCase() || "";
  const isVideo = ["mp4", "mov", "avi", "webm", "m4v"].includes(ext);
  const mediaItem = {
    id: (0, import_uuid.v4)().slice(0, 8),
    type: isVideo ? "video" : "photo",
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    uploadedAt: Date.now()
  };
  if (!report.media) report.media = [];
  report.media.push(mediaItem);
  persistPatrolReports();
  console.log(`[Patrol] Media uploaded to report ${report.id}: ${mediaItem.type} ${mediaItem.filename}`);
  res.json({ success: true, media: mediaItem });
});
app.delete("/api/patrol/reports/:id/media/:mediaId", (req, res) => {
  const report = patrolReports.find((r) => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: "Patrol report not found" });
  if (!report.media) return res.status(404).json({ error: "No media found" });
  const idx = report.media.findIndex((m) => m.id === req.params.mediaId);
  if (idx < 0) return res.status(404).json({ error: "Media not found" });
  const removed = report.media.splice(idx, 1)[0];
  persistPatrolReports();
  const filePath = import_path.default.join(uploadsDir, removed.url.replace("/uploads/", ""));
  import_fs.default.unlink(filePath, () => {
  });
  res.json({ success: true });
});
function handlePTTTransmit(ws, senderId, senderRole, data) {
  const { channelId, audioBase64, duration, senderName, mimeType } = data;
  if (!channelId || !audioBase64) {
    console.error(`[PTT] REJECTED: Missing channelId=${channelId ? "yes" : "NO"} or audioBase64=${audioBase64 ? audioBase64.length + " chars" : "EMPTY/MISSING"}. Full data keys: ${Object.keys(data || {}).join(", ")}`);
    ws.send(JSON.stringify({ type: "error", message: `Missing channelId or audioBase64. Got channelId=${!!channelId}, audioBase64=${!!audioBase64}` }));
    return;
  }
  const channel = pttChannels.find((c) => c.id === channelId);
  if (!channel) {
    ws.send(JSON.stringify({ type: "error", message: "Channel not found" }));
    return;
  }
  if (!channel.allowedRoles.includes(senderRole) && senderRole !== "admin") {
    ws.send(JSON.stringify({ type: "error", message: "Not authorized to transmit on this channel" }));
    return;
  }
  if (channel.members && channel.members.length > 0 && senderRole !== "admin") {
    if (!channel.members.includes(senderId)) {
      ws.send(JSON.stringify({ type: "error", message: "Not a member of this channel" }));
      return;
    }
  }
  const pttMsg = {
    id: `ptt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId,
    senderId,
    senderName: senderName || senderId,
    senderRole,
    audioBase64,
    mimeType: mimeType || "audio/webm",
    duration: duration || 0,
    timestamp: Date.now()
  };
  pttMessages.push(pttMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();
  console.log(`[PTT] ${senderName} (${senderRole}) transmitted on ${channel.name} - ${duration?.toFixed(1)}s, audioBase64: ${audioBase64 ? (audioBase64.length / 1024).toFixed(1) + " KB" : "EMPTY"}, mimeType: ${mimeType || "default"}`);
  const broadcastData = JSON.stringify({
    type: "pttMessage",
    data: {
      id: pttMsg.id,
      channelId: pttMsg.channelId,
      senderId: pttMsg.senderId,
      senderName: pttMsg.senderName,
      senderRole: pttMsg.senderRole,
      audioBase64: pttMsg.audioBase64,
      mimeType: pttMsg.mimeType,
      duration: pttMsg.duration,
      timestamp: pttMsg.timestamp
    }
  });
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    const connUserId = wsClientMap.get(client);
    if (!connUserId) return;
    const connUserData = users.get(connUserId);
    if (!connUserData) return;
    const role = connUserData.role || "user";
    if (role === "admin" || role === "dispatcher") {
      client.send(broadcastData);
      return;
    }
    if (channel.allowedRoles.includes(role)) {
      if (channel.members && channel.members.length > 0) {
        if (!channel.members.includes(connUserId)) return;
      }
      client.send(broadcastData);
    }
  });
  ws.send(JSON.stringify({ type: "pttTransmitAck", messageId: pttMsg.id, timestamp: pttMsg.timestamp }));
}
function handlePTTJoinChannel(ws, userId, userRole, data) {
  const { channelId } = data;
  const channel = pttChannels.find((c) => c.id === channelId);
  if (!channel) {
    ws.send(JSON.stringify({ type: "error", message: "Channel not found" }));
    return;
  }
  const channelMsgs = pttMessages.filter((m) => m.channelId === channelId).slice(-50).map((m) => ({
    id: m.id,
    channelId: m.channelId,
    senderId: m.senderId,
    senderName: m.senderName,
    senderRole: m.senderRole,
    audioBase64: m.audioBase64,
    mimeType: m.mimeType || "audio/webm",
    duration: m.duration,
    timestamp: m.timestamp
  }));
  ws.send(JSON.stringify({
    type: "pttChannelHistory",
    channelId,
    data: channelMsgs
  }));
}
function handlePTTTalkingState(ws, userId, userRole, data, isTalking) {
  const { channelId, userName } = data;
  const channel = pttChannels.find((c) => c.id === channelId);
  if (!channel) return;
  const broadcastData = JSON.stringify({
    type: isTalking ? "pttTalkingStart" : "pttTalkingStop",
    data: {
      channelId,
      userId,
      userName: userName || userId,
      userRole
    }
  });
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    const connUserId = wsClientMap.get(client);
    if (!connUserId) return;
    const connUserData = users.get(connUserId);
    if (!connUserData) return;
    const role = connUserData.role || "user";
    if (role === "admin" || role === "dispatcher") {
      client.send(broadcastData);
      return;
    }
    if (channel.allowedRoles.includes(role)) {
      if (channel.members && channel.members.length > 0) {
        if (!channel.members.includes(connUserId)) return;
      }
      client.send(broadcastData);
    }
  });
}
function handlePTTEmergency(ws, userId, userRole, data) {
  if (userRole !== "dispatcher" && userRole !== "admin") {
    ws.send(JSON.stringify({ type: "error", message: "Only dispatchers and admins can trigger emergency PTT" }));
    return;
  }
  const { audioBase64, duration, senderName, mimeType } = data;
  const emergencyMsg = {
    id: `ptt-emergency-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId: "emergency",
    senderId: userId,
    senderName: senderName || userId,
    senderRole: userRole,
    audioBase64: audioBase64 || "",
    mimeType: mimeType || "audio/webm",
    duration: duration || 0,
    timestamp: Date.now()
  };
  pttMessages.push(emergencyMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();
  console.log(`[PTT] EMERGENCY broadcast by ${senderName} (${userRole}) - ${duration?.toFixed(1)}s`);
  const broadcastData = JSON.stringify({
    type: "pttEmergencyMessage",
    data: {
      id: emergencyMsg.id,
      channelId: "emergency",
      senderId: emergencyMsg.senderId,
      senderName: emergencyMsg.senderName,
      senderRole: emergencyMsg.senderRole,
      audioBase64: emergencyMsg.audioBase64,
      mimeType: emergencyMsg.mimeType,
      duration: emergencyMsg.duration,
      timestamp: emergencyMsg.timestamp
    }
  });
  wss.clients.forEach((client) => {
    if (client.readyState !== 1) return;
    if (client === ws) return;
    client.send(broadcastData);
  });
  const allUserIds = Array.from(users.keys());
  allUserIds.forEach((uid) => {
    if (uid === userId) return;
    const tokens = pushTokens.get(uid);
    if (tokens) {
      tokens.forEach((token) => {
        sendPushNotification(token, {
          title: "\u{1F6A8} ALERTE URGENCE PTT",
          body: `Message d'urgence de ${senderName} (${userRole})`,
          data: { type: "pttEmergency", messageId: emergencyMsg.id }
        });
      });
    }
  });
  ws.send(JSON.stringify({ type: "pttEmergencyAck", messageId: emergencyMsg.id }));
}
app.get("/api/ptt/channels", (req, res) => {
  const userRole = req.query.role || "user";
  const userId = req.query.userId;
  const accessible = pttChannels.filter((ch) => {
    if (userRole === "admin") return true;
    if (userRole === "dispatcher") {
      if (!ch.allowedRoles.includes("dispatcher")) return false;
      return true;
    }
    if (!ch.allowedRoles.includes(userRole)) return false;
    if (ch.members && ch.members.length > 0 && !ch.members.includes(userId)) return false;
    return true;
  });
  res.json(accessible);
});
app.post("/api/ptt/channels", (req, res) => {
  const { name, description, allowedRoles, members, createdBy, createdByRole } = req.body;
  if (!name || !createdBy) {
    return res.status(400).json({ error: "name and createdBy are required" });
  }
  if (createdByRole !== "dispatcher" && createdByRole !== "admin") {
    return res.status(403).json({ error: "Only dispatchers and admins can create channels" });
  }
  const channel = {
    id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    name,
    description: description || "",
    allowedRoles: allowedRoles || ["user", "responder", "dispatcher", "admin"],
    isActive: true,
    isDefault: false,
    createdBy,
    createdAt: Date.now(),
    members: members || []
  };
  pttChannels.push(channel);
  persistPTTChannels();
  broadcastMessage({ type: "pttChannelCreated", data: channel });
  console.log(`[PTT] Channel "${name}" created by ${createdBy}`);
  res.json(channel);
});
app.delete("/api/ptt/channels/:id", (req, res) => {
  const { id } = req.params;
  const { userRole } = req.query;
  if (userRole !== "dispatcher" && userRole !== "admin") {
    return res.status(403).json({ error: "Only dispatchers and admins can delete channels" });
  }
  const idx = pttChannels.findIndex((c) => c.id === id);
  if (idx === -1) return res.status(404).json({ error: "Channel not found" });
  if (pttChannels[idx].isDefault) return res.status(400).json({ error: "Cannot delete default channels" });
  const removed = pttChannels.splice(idx, 1)[0];
  deletePTTChannelFromSupabase(id);
  persistPTTChannels();
  pttMessages = pttMessages.filter((m) => m.channelId !== id);
  persistPTTMessages();
  broadcastMessage({ type: "pttChannelDeleted", channelId: id });
  console.log(`[PTT] Channel "${removed.name}" deleted`);
  res.json({ success: true });
});
app.post("/api/ptt/channels/direct", (req, res) => {
  const { userId1, userId2, userName1, userName2 } = req.body;
  if (!userId1 || !userId2) {
    return res.status(400).json({ error: "userId1 and userId2 are required" });
  }
  const existing = pttChannels.find(
    (ch) => ch.members && ch.members.length === 2 && ch.members.includes(userId1) && ch.members.includes(userId2) && ch.id.startsWith("direct-")
  );
  if (existing) {
    return res.json(existing);
  }
  const name1 = userName1 || userId1;
  const name2 = userName2 || userId2;
  const channel = {
    id: `direct-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
    name: `${name1} \u2194 ${name2}`,
    description: `Appel direct entre ${name1} et ${name2}`,
    allowedRoles: ["user", "responder", "dispatcher", "admin"],
    isActive: true,
    isDefault: false,
    createdBy: userId1,
    createdAt: Date.now(),
    members: [userId1, userId2]
  };
  pttChannels.push(channel);
  persistPTTChannels();
  broadcastMessage({ type: "pttChannelCreated", data: channel });
  console.log(`[PTT] Direct channel created: ${name1} \u2194 ${name2}`);
  res.json(channel);
});
app.get("/api/ptt/messages/:channelId", (req, res) => {
  const { channelId } = req.params;
  const limit = parseInt(req.query.limit) || 50;
  const msgs = pttMessages.filter((m) => m.channelId === channelId).slice(-limit);
  res.json(msgs);
});
app.post("/api/ptt/transmit", (req, res) => {
  const { channelId, audioBase64, mimeType, duration, senderId, senderName, senderRole } = req.body;
  if (!channelId || !audioBase64 || !senderId) {
    return res.status(400).json({ error: "Missing required fields" });
  }
  const channel = pttChannels.find((c) => c.id === channelId);
  if (!channel) return res.status(404).json({ error: "Channel not found" });
  if (!channel.allowedRoles.includes(senderRole) && senderRole !== "admin") {
    return res.status(403).json({ error: "Not authorized to transmit on this channel" });
  }
  const pttMsg = {
    id: `ptt-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    channelId,
    senderId,
    senderName: senderName || senderId,
    senderRole: senderRole || "user",
    audioBase64,
    mimeType: mimeType || "audio/webm",
    duration: duration || 0,
    timestamp: Date.now()
  };
  pttMessages.push(pttMsg);
  if (pttMessages.length > 200) pttMessages = pttMessages.slice(-200);
  persistPTTMessages();
  broadcastMessage({
    type: "pttMessage",
    data: {
      id: pttMsg.id,
      channelId: pttMsg.channelId,
      senderId: pttMsg.senderId,
      senderName: pttMsg.senderName,
      senderRole: pttMsg.senderRole,
      audioBase64: pttMsg.audioBase64,
      mimeType: pttMsg.mimeType,
      duration: pttMsg.duration,
      timestamp: pttMsg.timestamp
    }
  });
  res.json({ success: true, messageId: pttMsg.id });
});
var PORT = process.env.PORT || 3e3;
server.keepAliveTimeout = 65e3;
server.headersTimeout = 66e3;
server.listen(Number(PORT), "0.0.0.0", async () => {
  console.log(`Talion Crisis Comm Server running on port ${PORT}`);
  await Promise.all([
    loadAdminUsersFromSupabase(),
    loadAlertsFromSupabase(),
    loadPatrolReportsFromSupabase(),
    loadPTTChannelsFromSupabase(),
    loadFamilyPerimetersFromSupabase(),
    loadPushTokensFromSupabase(),
    loadUserAddressesFromSupabase(),
    loadConversationsFromSupabase(),
    loadMessagesFromSupabase()
  ]);
  console.log("[Startup] All Supabase data loaded \u2014 ready to serve requests");
  console.log(`WebSocket endpoint: ws://localhost:${PORT}`);
  console.log(`Admin Console: http://localhost:${PORT}/admin-console/`);
  console.log(`Dispatch Console: http://localhost:${PORT}/dispatch-console/`);
  console.log(`Console Login: http://localhost:${PORT}/console/`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
async function loadAdminUsersFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("admin_users").select("*");
    if (error) {
      console.error("[Supabase] Failed to load admin_users:", error.message);
      return;
    }
    if (data && data.length > 0) {
      adminUsers.clear();
      data.forEach((u) => {
        adminUsers.set(u.id, {
          id: u.id,
          firstName: u.first_name || "",
          lastName: u.last_name || "",
          name: u.name || `${u.first_name} ${u.last_name}`.trim(),
          email: u.email,
          role: u.role,
          status: u.status || "active",
          lastLogin: u.last_login || 0,
          createdAt: u.created_at || Date.now(),
          tags: u.tags || [],
          address: u.address || "",
          phoneLandline: u.phone_landline || "",
          phoneMobile: u.phone_mobile || "",
          comments: u.comments || "",
          photoUrl: u.photo_url || "",
          relationships: u.relationships || [],
          passwordHash: u.password_hash || void 0
        });
      });
      console.log(`[Supabase] Loaded ${data.length} users from admin_users`);
    }
  } catch (e) {
    console.error("[Supabase] loadAdminUsersFromSupabase error:", e);
  }
}
async function saveAdminUserToSupabase(user) {
  try {
    const { error } = await supabaseAdmin.from("admin_users").upsert({
      id: user.id,
      first_name: user.firstName,
      last_name: user.lastName,
      name: user.name,
      email: user.email,
      role: user.role,
      status: user.status,
      last_login: user.lastLogin,
      created_at: user.createdAt,
      tags: user.tags || [],
      address: user.address || "",
      phone_landline: user.phoneLandline || "",
      phone_mobile: user.phoneMobile || "",
      comments: user.comments || "",
      photo_url: user.photoUrl || "",
      relationships: user.relationships || [],
      password_hash: user.passwordHash || null
    });
    if (error) console.error("[Supabase] saveAdminUserToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveAdminUserToSupabase error:", e);
  }
}
async function deleteAdminUserFromSupabase(userId) {
  try {
    const { error } = await supabaseAdmin.from("admin_users").delete().eq("id", userId);
    if (error) console.error("[Supabase] deleteAdminUserFromSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] deleteAdminUserFromSupabase error:", e);
  }
}
async function loadAlertsFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("alerts").select("*");
    if (error) {
      console.error("[Supabase] Failed to load alerts:", error.message);
      return;
    }
    if (data && data.length > 0) {
      alerts.clear();
      data.forEach((a) => {
        alerts.set(a.id, {
          id: a.id,
          type: a.type,
          severity: a.severity,
          status: a.status,
          description: a.description || "",
          createdBy: a.created_by,
          createdAt: a.created_at,
          location: a.location || { latitude: 0, longitude: 0, address: "Unknown" },
          respondingUsers: a.responding_users || [],
          responderStatuses: a.responder_statuses || {},
          statusHistory: a.status_history || [],
          photos: a.photos || []
        });
      });
      console.log(`[Supabase] Loaded ${data.length} alerts`);
    }
  } catch (e) {
    console.error("[Supabase] loadAlertsFromSupabase error:", e);
  }
}
async function saveAlertToSupabase(alert) {
  try {
    const { error } = await supabaseAdmin.from("alerts").upsert({
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
      photos: alert.photos || []
    });
    if (error) console.error("[Supabase] saveAlertToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveAlertToSupabase error:", e);
  }
}
async function loadPatrolReportsFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("patrol_reports").select("*").order("created_at", { ascending: false });
    if (error) {
      console.error("[Supabase] Failed to load patrol_reports:", error.message);
      return;
    }
    if (data && data.length > 0) {
      patrolReports.length = 0;
      data.forEach((r) => patrolReports.push({
        id: r.id,
        createdAt: r.created_at,
        createdBy: r.created_by,
        createdByName: r.created_by_name,
        location: r.location,
        status: r.status,
        tasks: r.tasks || [],
        notes: r.notes,
        media: r.media || []
      }));
      console.log(`[Supabase] Loaded ${data.length} patrol reports`);
    }
  } catch (e) {
    console.error("[Supabase] loadPatrolReportsFromSupabase error:", e);
  }
}
async function savePatrolReportToSupabase(report) {
  try {
    const { error } = await supabaseAdmin.from("patrol_reports").upsert({
      id: report.id,
      created_at: report.createdAt,
      created_by: report.createdBy,
      created_by_name: report.createdByName,
      location: report.location,
      status: report.status,
      tasks: report.tasks,
      notes: report.notes || null,
      media: report.media || []
    });
    if (error) console.error("[Supabase] savePatrolReportToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] savePatrolReportToSupabase error:", e);
  }
}
async function loadPTTChannelsFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("ptt_channels").select("*");
    if (error) {
      console.error("[Supabase] Failed to load ptt_channels:", error.message);
      return;
    }
    if (data && data.length > 0) {
      pttChannels.length = 0;
      data.forEach((c) => pttChannels.push({
        id: c.id,
        name: c.name,
        description: c.description || "",
        allowedRoles: c.allowed_roles || [],
        isActive: c.is_active,
        isDefault: c.is_default,
        createdBy: c.created_by,
        createdAt: c.created_at,
        members: c.members || []
      }));
      console.log(`[Supabase] Loaded ${data.length} PTT channels`);
    }
  } catch (e) {
    console.error("[Supabase] loadPTTChannelsFromSupabase error:", e);
  }
}
async function savePTTChannelToSupabase(channel) {
  try {
    const { error } = await supabaseAdmin.from("ptt_channels").upsert({
      id: channel.id,
      name: channel.name,
      description: channel.description,
      allowed_roles: channel.allowedRoles,
      is_active: channel.isActive,
      is_default: channel.isDefault,
      created_by: channel.createdBy,
      created_at: channel.createdAt,
      members: channel.members || []
    });
    if (error) console.error("[Supabase] savePTTChannelToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] savePTTChannelToSupabase error:", e);
  }
}
async function deletePTTChannelFromSupabase(channelId) {
  try {
    const { error } = await supabaseAdmin.from("ptt_channels").delete().eq("id", channelId);
    if (error) console.error("[Supabase] deletePTTChannelFromSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] deletePTTChannelFromSupabase error:", e);
  }
}
async function loadFamilyPerimetersFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("family_perimeters").select("*");
    if (error) {
      console.error("[Supabase] Failed to load family_perimeters:", error.message);
      return;
    }
    if (data && data.length > 0) {
      familyPerimeters.clear();
      data.forEach((p) => familyPerimeters.set(p.id, {
        id: p.id,
        ownerId: p.owner_id,
        targetUserId: p.target_user_id,
        targetUserName: p.target_user_name,
        center: p.center,
        radiusMeters: p.radius_meters,
        active: p.active,
        createdAt: p.created_at,
        updatedAt: p.updated_at
      }));
      console.log(`[Supabase] Loaded ${data.length} family perimeters`);
    }
  } catch (e) {
    console.error("[Supabase] loadFamilyPerimetersFromSupabase error:", e);
  }
}
async function saveFamilyPerimeterToSupabase(p) {
  try {
    const { error } = await supabaseAdmin.from("family_perimeters").upsert({
      id: p.id,
      owner_id: p.ownerId,
      target_user_id: p.targetUserId,
      target_user_name: p.targetUserName,
      center: p.center,
      radius_meters: p.radiusMeters,
      active: p.active,
      created_at: p.createdAt,
      updated_at: p.updatedAt
    });
    if (error) console.error("[Supabase] saveFamilyPerimeterToSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveFamilyPerimeterToSupabase error:", e);
  }
}
async function deleteFamilyPerimeterFromSupabase(perimeterId) {
  try {
    const { error } = await supabaseAdmin.from("family_perimeters").delete().eq("id", perimeterId);
    if (error) console.error("[Supabase] deleteFamilyPerimeterFromSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] deleteFamilyPerimeterFromSupabase error:", e);
  }
}
async function loadPushTokensFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("push_tokens").select("*");
    if (error) {
      console.error("[Supabase] Failed to load push_tokens:", error.message);
      return;
    }
    if (data && data.length > 0) {
      pushTokens.clear();
      data.forEach((t) => {
        pushTokens.set(t.token, {
          token: t.token,
          userId: t.user_id,
          userRole: t.user_role,
          registeredAt: t.registered_at
        });
      });
      console.log(`[Supabase] Loaded ${data.length} push tokens`);
    }
  } catch (e) {
    console.error("[Supabase] loadPushTokensFromSupabase error:", e);
  }
}
async function savePushTokenToSupabase(entry) {
  try {
    console.log("[Supabase] Saving push token for", entry.userId, entry.userRole);
    const { error } = await supabaseAdmin.from("push_tokens").upsert({
      token: entry.token,
      user_id: entry.userId,
      user_role: entry.userRole,
      registered_at: entry.registeredAt
    });
    if (error) {
      console.error("[Supabase] savePushTokenToSupabase error:", error.message, "code:", error.code);
    } else {
      console.log("[Supabase] Push token saved OK for", entry.userId);
    }
  } catch (e) {
    console.error("[Supabase] savePushTokenToSupabase error:", e);
  }
}
async function deletePushTokenFromSupabase(token) {
  try {
    const { error } = await supabaseAdmin.from("push_tokens").delete().eq("token", token);
    if (error) console.error("[Supabase] deletePushTokenFromSupabase error:", error.message);
  } catch (e) {
    console.error("[Supabase] deletePushTokenFromSupabase error:", e);
  }
}
async function generateIncidentId(type, createdBy, location) {
  try {
    const { data, error } = await supabaseAdmin.rpc("increment_incident_counter");
    const num = !error && data ? data : Date.now() % 1e4;
    const creator = adminUsers.get(createdBy);
    const creatorName = creator?.name || createdBy;
    const address = location?.address || "";
    let city = "";
    if (address) {
      const parts2 = address.split(",").map((p) => p.trim());
      city = parts2[1] || parts2[0] || "";
      if (city.length > 20) city = city.substring(0, 20);
    }
    const TYPE_LABELS = {
      sos: "SOS",
      medical: "M\xC9DICAL",
      fire: "INCENDIE",
      security: "S\xC9CURIT\xC9",
      accident: "ACCIDENT",
      broadcast: "BROADCAST",
      home_jacking: "HOME-JACKING",
      cambriolage: "CAMBRIOLAGE",
      other: "INCIDENT"
    };
    const typeLabel = TYPE_LABELS[type] || type.toUpperCase();
    const parts = [typeLabel];
    if (creatorName && creatorName !== "system" && creatorName !== "mobile-user") parts.push(creatorName);
    if (city) parts.push(city);
    parts.push(`#${String(num).padStart(4, "0")}`);
    return parts.join(" \u2014 ");
  } catch (e) {
    return `INC-${(0, import_uuid.v4)().slice(0, 8).toUpperCase()}`;
  }
}
async function geocodeAddress(addressText) {
  try {
    const token = process.env.MAPBOX_TOKEN;
    if (!token) {
      console.warn("[Geocode] MAPBOX_TOKEN not set");
      return null;
    }
    const encoded = encodeURIComponent(addressText);
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?access_token=${token}&limit=1`;
    const resp = await fetch(url);
    if (!resp.ok) {
      console.warn("[Geocode] Mapbox error", resp.status);
      return null;
    }
    const data = await resp.json();
    const feature = data.features?.[0];
    if (!feature) {
      console.warn("[Geocode] No results for:", addressText);
      return null;
    }
    const [longitude, latitude] = feature.center;
    return { latitude, longitude };
  } catch (e) {
    console.error("[Geocode] geocodeAddress error:", e);
    return null;
  }
}
async function saveConversationToSupabase(conv) {
  try {
    const { error } = await supabaseAdmin.from("conversations").upsert({
      id: conv.id,
      type: conv.type,
      name: conv.name,
      participant_ids: conv.participantIds,
      filter_role: conv.filterRole || null,
      filter_tags: conv.filterTags || null,
      created_by: conv.createdBy,
      created_at: conv.createdAt,
      last_message: conv.lastMessage || "",
      last_message_time: conv.lastMessageTime || 0
    });
    if (error) console.error("[Supabase] saveConversation error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveConversation error:", e);
  }
}
async function saveMessageToSupabase(msg) {
  try {
    const { error } = await supabaseAdmin.from("messages").upsert({
      id: msg.id,
      conversation_id: msg.conversationId,
      sender_id: msg.senderId,
      sender_name: msg.senderName,
      sender_role: msg.senderRole,
      text: msg.text,
      type: msg.type,
      timestamp: msg.timestamp,
      media_url: msg.mediaUrl || null,
      media_type: msg.mediaType || null,
      location: msg.location || null
    });
    if (error) console.error("[Supabase] saveMessage error:", error.message);
  } catch (e) {
    console.error("[Supabase] saveMessage error:", e);
  }
}
async function loadConversationsFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("conversations").select("*");
    if (error) {
      console.error("[Supabase] loadConversations error:", error.message);
      return;
    }
    if (data && data.length > 0) {
      conversations.clear();
      data.forEach((c) => {
        const conv = {
          id: c.id,
          type: c.type,
          name: c.name,
          participantIds: c.participant_ids || [],
          filterRole: c.filter_role,
          filterTags: c.filter_tags,
          createdBy: c.created_by,
          createdAt: c.created_at,
          lastMessage: c.last_message || "",
          lastMessageTime: c.last_message_time || 0,
          unreadCounts: c.unread_counts || {}
        };
        conversations.set(c.id, conv);
      });
      console.log(`[Supabase] Loaded ${data.length} conversations`);
    }
  } catch (e) {
    console.error("[Supabase] loadConversations error:", e);
  }
}
async function loadMessagesFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("messages").select("*").order("timestamp", { ascending: true });
    if (error) {
      console.error("[Supabase] loadMessages error:", error.message);
      return;
    }
    if (data && data.length > 0) {
      messages.clear();
      data.forEach((m) => {
        const msg = {
          id: m.id,
          conversationId: m.conversation_id,
          senderId: m.sender_id,
          senderName: m.sender_name,
          senderRole: m.sender_role,
          text: m.text,
          type: m.type,
          timestamp: m.timestamp,
          mediaUrl: m.media_url || void 0,
          mediaType: m.media_type || void 0,
          location: m.location || void 0
        };
        if (!messages.has(msg.conversationId)) messages.set(msg.conversationId, []);
        messages.get(msg.conversationId).push(msg);
      });
      console.log(`[Supabase] Loaded ${data.length} messages`);
    }
  } catch (e) {
    console.error("[Supabase] loadMessages error:", e);
  }
}
app.post("/api/livekit/token", async (req, res) => {
  const { userId, userName, roomName } = req.body;
  if (!userId || !roomName) return res.status(400).json({ error: "userId and roomName required" });
  try {
    const { AccessToken } = await import("livekit-server-sdk");
    const apiKey = process.env.LIVEKIT_API_KEY || "talioncd15c681";
    const apiSecret = process.env.LIVEKIT_API_SECRET || "759155227f75206216d399f37e676a010a92658ef655727358dddba0271c9f0f";
    const livekitUrl = process.env.LIVEKIT_URL || "wss://talion-livekit.onrender.com";
    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: userName || userId,
      ttl: "4h"
    });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true
    });
    const token = await at.toJwt();
    res.json({ token, url: livekitUrl, room: roomName });
    console.log(`[LiveKit] Token g\xE9n\xE9r\xE9 pour ${userName} dans room ${roomName}`);
  } catch (e) {
    console.error("[LiveKit] Token error:", e);
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/livekit/rooms", async (req, res) => {
  res.json({
    rooms: [
      { name: "dispatch", label: "Canal Dispatch", type: "group" }
    ],
    livekitUrl: process.env.LIVEKIT_URL || "wss://talion-livekit.onrender.com"
  });
});
var userAddresses = /* @__PURE__ */ new Map();
async function loadUserAddressesFromSupabase() {
  try {
    const { data, error } = await supabaseAdmin.from("user_addresses").select("*");
    if (error) {
      console.error("[Supabase] Failed to load user_addresses:", error.message);
      return;
    }
    if (data && data.length > 0) {
      userAddresses.clear();
      data.forEach((a) => {
        const addr = {
          id: a.id,
          userId: a.user_id,
          label: a.label,
          address: a.address,
          latitude: a.latitude,
          longitude: a.longitude,
          placeId: a.place_id,
          isPrimary: a.is_primary,
          alarmCode: a.alarm_code,
          notes: a.notes,
          createdAt: a.created_at,
          updatedAt: a.updated_at
        };
        if (!userAddresses.has(addr.userId)) userAddresses.set(addr.userId, []);
        userAddresses.get(addr.userId).push(addr);
      });
      console.log(`[Supabase] Loaded ${data.length} user addresses`);
    }
  } catch (e) {
    console.error("[Supabase] loadUserAddressesFromSupabase error:", e);
  }
}
app.get("/api/users/:id/addresses", (req, res) => {
  const addresses = userAddresses.get(req.params.id) || [];
  res.json(addresses);
});
app.post("/api/users/:id/addresses", async (req, res) => {
  const { label, address, latitude, longitude, placeId, isPrimary, alarmCode, notes } = req.body;
  if (!label || !address) return res.status(400).json({ error: "label and address are required" });
  const userId = req.params.id;
  const now = Date.now();
  let lat = latitude || null;
  let lng = longitude || null;
  if (!lat || !lng) {
    const coords = await geocodeAddress(address);
    if (coords) {
      lat = coords.latitude;
      lng = coords.longitude;
    } else console.warn("[Addresses] Could not geocode: " + address);
  }
  const newAddr = {
    id: require("crypto").randomUUID(),
    userId,
    label,
    address,
    latitude: lat,
    longitude: lng,
    placeId: placeId || null,
    isPrimary: isPrimary || false,
    alarmCode: alarmCode || null,
    notes: notes || null,
    createdAt: now,
    updatedAt: now
  };
  if (isPrimary) {
    const existing = userAddresses.get(userId) || [];
    existing.forEach((a) => {
      if (a.isPrimary) a.isPrimary = false;
    });
  }
  if (!userAddresses.has(userId)) userAddresses.set(userId, []);
  userAddresses.get(userId).push(newAddr);
  await supabaseAdmin.from("user_addresses").insert({
    id: newAddr.id,
    user_id: userId,
    label,
    address,
    latitude: newAddr.latitude,
    longitude: newAddr.longitude,
    place_id: newAddr.placeId,
    is_primary: newAddr.isPrimary,
    alarm_code: newAddr.alarmCode,
    notes: newAddr.notes,
    created_at: now,
    updated_at: now
  });
  res.status(201).json(newAddr);
});
app.put("/api/users/:id/addresses/:addressId", async (req, res) => {
  const { label, address, latitude, longitude, placeId, isPrimary, alarmCode, notes } = req.body;
  const userId = req.params.id;
  const addresses = userAddresses.get(userId) || [];
  const idx = addresses.findIndex((a) => a.id === req.params.addressId);
  if (idx === -1) return res.status(404).json({ error: "Address not found" });
  if (isPrimary) addresses.forEach((a) => {
    a.isPrimary = false;
  });
  let finalLat = latitude ?? addresses[idx].latitude;
  let finalLng = longitude ?? addresses[idx].longitude;
  const addressChanged = address && address !== addresses[idx].address;
  if (addressChanged && !latitude && !longitude) {
    const coords = await geocodeAddress(address ?? addresses[idx].address);
    if (coords) {
      finalLat = coords.latitude;
      finalLng = coords.longitude;
    }
  }
  const updated = {
    ...addresses[idx],
    label: label ?? addresses[idx].label,
    address: address ?? addresses[idx].address,
    latitude: finalLat,
    longitude: finalLng,
    isPrimary: isPrimary ?? addresses[idx].isPrimary,
    alarmCode: alarmCode ?? addresses[idx].alarmCode,
    notes: notes ?? addresses[idx].notes,
    updatedAt: Date.now()
  };
  addresses[idx] = updated;
  await supabaseAdmin.from("user_addresses").update({
    label: updated.label,
    address: updated.address,
    latitude: updated.latitude,
    longitude: updated.longitude,
    is_primary: updated.isPrimary,
    alarm_code: updated.alarmCode,
    notes: updated.notes,
    updated_at: updated.updatedAt
  }).eq("id", updated.id);
  res.json(updated);
});
app.delete("/api/users/:id/addresses/:addressId", async (req, res) => {
  const userId = req.params.id;
  const addresses = userAddresses.get(userId) || [];
  const idx = addresses.findIndex((a) => a.id === req.params.addressId);
  if (idx === -1) return res.status(404).json({ error: "Address not found" });
  addresses.splice(idx, 1);
  await supabaseAdmin.from("user_addresses").delete().eq("id", req.params.addressId);
  res.json({ success: true });
});
app.post("/api/admin/geocode-addresses", async (req, res) => {
  let processed = 0, updated = 0, failed = 0;
  for (const [userId, addrs] of userAddresses) {
    for (const addr of addrs) {
      if (addr.latitude && addr.longitude) continue;
      processed++;
      const coords = await geocodeAddress(addr.address);
      if (!coords) {
        failed++;
        console.warn("[BatchGeocode] Failed: " + addr.address);
        continue;
      }
      addr.latitude = coords.latitude;
      addr.longitude = coords.longitude;
      addr.updatedAt = Date.now();
      await supabaseAdmin.from("user_addresses").update({
        latitude: coords.latitude,
        longitude: coords.longitude,
        updated_at: addr.updatedAt
      }).eq("id", addr.id);
      updated++;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  res.json({ processed, updated, failed });
});
app.get("/api/alerts/:id/context", async (req, res) => {
  const alert = alerts.get(req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  const createdBy = alert.createdBy;
  let user = adminUsers.get(createdBy);
  let resolvedUserId = createdBy;
  if (!user) {
    for (const [uid, u] of adminUsers) {
      const fullName = [u.firstName, u.lastName].filter(Boolean).join(" ").trim() || u.name || "";
      if (fullName === createdBy || u.name === createdBy || u.email === createdBy) {
        user = u;
        resolvedUserId = uid;
        break;
      }
    }
  }
  if (!user) return res.json({ alert, user: null, addresses: [], family: [], locationContext: null });
  const addresses = userAddresses.get(resolvedUserId) || [];
  let locationContext = null;
  if (alert.location?.latitude && alert.location?.longitude && addresses.length > 0) {
    let closest = null;
    let minDist = Infinity;
    for (const addr of addresses) {
      if (!addr.latitude || !addr.longitude) continue;
      const dist = haversineDistance(alert.location.latitude, alert.location.longitude, addr.latitude, addr.longitude);
      if (dist < minDist) {
        minDist = dist;
        closest = addr;
      }
    }
    if (closest && minDist < 500) {
      locationContext = {
        type: "known_address",
        label: closest.label,
        address: closest.address,
        distanceMeters: Math.round(minDist),
        alarmCode: closest.alarmCode,
        isHomeJacking: minDist < 100
      };
    }
  }
  const family = (user.relationships || []).map((rel) => {
    let member = adminUsers.get(rel.userId);
    if (!member) {
      for (const [, u] of adminUsers) {
        if (u.id === rel.userId) {
          member = u;
          break;
        }
      }
    }
    if (!member) return null;
    return { id: member.id, name: member.name, role: rel.type, phone: member.phoneMobile, photoUrl: member.photoUrl };
  }).filter(Boolean);
  const { passwordHash, ...safeUser } = user;
  res.json({ user: { ...safeUser, hasPassword: !!user.passwordHash }, addresses, family, locationContext });
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  app,
  server,
  wss
});
