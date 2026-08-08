import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  Modal,
  ScrollView,
  ActivityIndicator,
  Platform,
  Alert,
  Image,
  Linking,
} from 'react-native';
import { TextInput } from 'react-native';
import { TalionScreen, TalionBanner } from '@/components/talion-banner';
import { useAuth } from '@/hooks/useAuth';
import { isStaffRole } from '@/lib/auth-context';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader, createPatrolReport, uploadMediaToReport as uploadMedia } from '@/services/patrol-api';
import { offlineCache } from '@/services/offline-cache';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import NativeMapView, { Marker, Circle, Polyline } from '@/components/map-view';
import { wsManager } from '@/services/websocket-manager';
import { SOSButton } from '@/components/sos-button';
import locationService from '@/services/location-service';

// Loaded defensively (require + try/catch, not a static import) — matches the
// pattern already established in lib/ptt-context.tsx for these same native
// modules, whose comment there explains why: a plain static import throws at
// module-evaluation time (crashing whichever screen loads this file) if the
// native module isn't available in a given build, instead of failing only
// when the feature that needs it is actually used.
let SharingModule: any = null;
let FileSystemModule: any = null;
try {
  SharingModule = require('expo-sharing');
} catch (e) {
  console.warn('[Patrol] Failed to load expo-sharing:', e);
}
try {
  FileSystemModule = require('expo-file-system/legacy');
} catch (e) {
  console.warn('[Patrol] Failed to load expo-file-system:', e);
}

// ─── Types ──────────────────────────────────────────────────────────────────

type PatrolStatus = 'habituel' | 'inhabituel' | 'identification' | 'suspect' | 'menace' | 'attaque';
type TaskResult = 'ok' | 'pas_ok';

interface PatrolTask {
  name: string;
  label: string;
  result: TaskResult;
  comment?: string;
}

interface PatrolMedia {
  id: string;
  type: 'photo' | 'video';
  url: string;
  filename: string;
  uploadedAt: number;
}

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
  createdBy: string;
  createdByName: string;
  location: string;
  status: PatrolStatus;
  tasks: PatrolTask[];
  notes?: string;
  media?: PatrolMedia[];
  escalatedIncidentId?: string;
  // Present only for reports generated from a GPS-tracked round.
  siteId?: string;
  checkpoints?: PatrolCheckpointResult[];
  trail?: PatrolTrailPoint[];
  roundStatus?: 'completed' | 'interrupted';
  startedAt?: number;
  interruptReason?: string;
}

// Local media item before upload
interface LocalMedia {
  uri: string;
  type: 'photo' | 'video';
  filename: string;
}

// ─── GPS round tracking ──────────────────────────────────────────────────
interface ActiveRoundCheckpoint {
  checkpointId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  minDwellSeconds?: number;
  dwellSeconds: number;
  visited: boolean;
  dwellMet: boolean;
}

interface ActiveRound {
  id: string;
  siteId: string;
  siteName: string;
  responderId: string;
  responderName: string;
  startedAt: number;
  checkpoints: ActiveRoundCheckpoint[];
  trail: PatrolTrailPoint[];
  lastLocation?: PatrolTrailPoint;
}

// ─── Post-round route planning ────────────────────────────────────────────
interface RoutePlan {
  geometry: { latitude: number; longitude: number }[];
  distanceMeters: number;
  durationSeconds: number;
  rationale: string;
  mode: 'driving' | 'walking';
  alternativesConsidered: number;
  toSiteId: string;
  toSiteName: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<PatrolStatus, { label: string; color: string; textColor: string }> = {
  habituel:       { label: 'Habituel',       color: '#22C55E', textColor: '#ffffff' },
  inhabituel:     { label: 'Inhabituel',     color: '#EAB308', textColor: '#000000' },
  identification: { label: 'Identification', color: '#F97316', textColor: '#ffffff' },
  suspect:        { label: 'Suspect',        color: '#EF4444', textColor: '#ffffff' },
  menace:         { label: 'Menace',         color: '#8B5CF6', textColor: '#ffffff' },
  attaque:        { label: 'Attaque',        color: '#000000', textColor: '#ffffff' },
};

const DEFAULT_TASKS = [
  { name: 'ronde_exterieure', label: 'Ronde extérieure' },
  { name: 'ronde_interieure', label: 'Ronde intérieure' },
  { name: 'ronde_maison', label: 'Ronde maison' },
  { name: 'anomalies', label: 'Anomalies' },
  { name: 'autre', label: 'Autre' },
];

// ─── API Helpers ────────────────────────────────────────────────────────────
// Report creation + media upload live in services/patrol-api.ts, shared with the
// offline-queue retry executor (services/offline-queue-processor.ts) so both paths
// authenticate and submit identically.

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${getApiBaseUrl()}${path}`, { timeout: 10000, headers: await authHeader() });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('fr-CH', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' à ' + d.toLocaleTimeString('fr-CH', { hour: '2-digit', minute: '2-digit' });
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "À l'instant";
  if (minutes < 60) return `Il y a ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Il y a ${hours}h`;
  return `Il y a ${Math.floor(hours / 24)}j`;
}

// ─── Main Component ─────────────────────────────────────────────────────────

type ViewState = 'list' | 'create' | 'detail' | 'round' | 'routePreview';

// Samples up to `count` well-spaced intermediate points from a route's
// geometry, used to force native turn-by-turn apps through roughly the
// recommended path via a waypoints= param — without this, the native app
// just computes its own default route and silently discards the variety/
// safety scoring the whole feature exists to provide.
function sampleWaypoints(geometry: { latitude: number; longitude: number }[], count: number): { latitude: number; longitude: number }[] {
  if (geometry.length <= count + 2) return [];
  const points: { latitude: number; longitude: number }[] = [];
  for (let i = 1; i <= count; i++) {
    const idx = Math.floor((geometry.length - 1) * (i / (count + 1)));
    points.push(geometry[idx]);
  }
  return points;
}

function openNativeNavigation(plan: RoutePlan, origin: { latitude: number; longitude: number }) {
  const dest = plan.geometry[plan.geometry.length - 1];
  const travelmode = plan.mode === 'walking' ? 'walking' : 'driving';
  const waypoints = sampleWaypoints(plan.geometry, 3);
  const waypointsParam = waypoints.length > 0 ? waypoints.map(p => `${p.latitude},${p.longitude}`).join('|') : '';

  const googleAppUrl = `comgooglemaps://?saddr=${origin.latitude},${origin.longitude}&daddr=${dest.latitude},${dest.longitude}${waypointsParam ? `&waypoints=${waypointsParam}` : ''}&travelmode=${travelmode}`;
  const googleWebUrl = `https://www.google.com/maps/dir/?api=1&origin=${origin.latitude},${origin.longitude}&destination=${dest.latitude},${dest.longitude}${waypointsParam ? `&waypoints=${waypointsParam}` : ''}&travelmode=${travelmode}`;
  const appleMapsUrl = `maps://app?daddr=${dest.latitude},${dest.longitude}`;

  const fallbackToAppleMaps = () => { if (Platform.OS === 'ios') Linking.openURL(appleMapsUrl).catch(() => {}); };
  const tryWebFallback = () => Linking.openURL(googleWebUrl).catch(fallbackToAppleMaps);

  Linking.canOpenURL(googleAppUrl)
    .then(supported => {
      if (supported) Linking.openURL(googleAppUrl).catch(tryWebFallback);
      else tryWebFallback();
    })
    .catch(tryWebFallback);
}

export default function PatrolScreen() {
  const { user } = useAuth();
  const [view, setView] = useState<ViewState>('list');
  const [reports, setReports] = useState<PatrolReport[]>([]);
  const [sites, setSites] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedReport, setSelectedReport] = useState<PatrolReport | null>(null);
  const [filterStatus, setFilterStatus] = useState<PatrolStatus | 'all'>('all');

  // Creation form state
  const [selectedSite, setSelectedSite] = useState('');
  const [selectedStatus, setSelectedStatus] = useState<PatrolStatus>('habituel');
  const [taskResults, setTaskResults] = useState<Record<string, TaskResult>>({});
  const [taskComments, setTaskComments] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSitePicker, setShowSitePicker] = useState(false);

  // ─── GPS round state ────────────────────────────────────────────────────
  const [siteObjects, setSiteObjects] = useState<{ id: string; name: string }[]>([]);
  const [myActiveRound, setMyActiveRound] = useState<ActiveRound | null>(null);
  const [showRoundSitePicker, setShowRoundSitePicker] = useState(false);
  // 'round-finish' reuses the same questionnaire form (renderCreateView) as a
  // manual report, but submits to the round-finish endpoint instead and skips
  // the site picker (the round's site is already fixed).
  const [createFormMode, setCreateFormMode] = useState<'report' | 'round-finish'>('report');
  const [roundStarting, setRoundStarting] = useState(false);
  const [roundFinishing, setRoundFinishing] = useState(false);
  const [showInterruptConfirm, setShowInterruptConfirm] = useState(false);
  const [interruptReason, setInterruptReason] = useState('');
  const activeRoundIdRef = useRef<string | null>(null);

  // "Next location" route-planning state (after a round finishes)
  const [showNextLocationPicker, setShowNextLocationPicker] = useState(false);
  const [finishedSiteId, setFinishedSiteId] = useState<string | null>(null);
  const [routeOrigin, setRouteOrigin] = useState<{ latitude: number; longitude: number } | null>(null);
  const [routePlan, setRoutePlan] = useState<RoutePlan | null>(null);
  const [routePlanning, setRoutePlanning] = useState(false);
  const [routeConfirming, setRouteConfirming] = useState(false);
  const [routeMode, setRouteMode] = useState<'driving' | 'walking'>('driving');
  const [selectedNextSite, setSelectedNextSite] = useState<{ id: string; name: string } | null>(null);

  // Media attachment state
  const [localMedia, setLocalMedia] = useState<LocalMedia[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [showMediaPreview, setShowMediaPreview] = useState<string | null>(null);

  // ─── Blackbook (suspicious persons registry) ───────────────────────────
  // Reachable from patrol.tsx because this is the one screen shared by all
  // three roles that need it (responder/dispatcher/admin) — dispatcher.tsx
  // isn't visible to responders.
  const [showBlackbookModal, setShowBlackbookModal] = useState(false);
  const [blackbookView, setBlackbookView] = useState<'list' | 'form'>('list');
  const [blackbookLoading, setBlackbookLoading] = useState(false);
  const [blackbookData, setBlackbookData] = useState<any[]>([]);
  const [blackbookSearch, setBlackbookSearch] = useState('');
  const [blackbookRiskFilter, setBlackbookRiskFilter] = useState('');
  const [currentBlackbookEntry, setCurrentBlackbookEntry] = useState<any>(null); // null = creating new
  const [relatedBlackbook, setRelatedBlackbook] = useState<any[]>([]); // deterministic plate/name matches, see findRelatedBlackbookEntries server-side
  const [entityCandidates, setEntityCandidates] = useState<{ type: 'name' | 'plate' | 'location'; value: string; context: string }[]>([]);
  const [entityAnalyzing, setEntityAnalyzing] = useState(false);
  const [bbFirstName, setBbFirstName] = useState('');
  const [bbLastName, setBbLastName] = useState('');
  const [bbAliases, setBbAliases] = useState('');
  const [bbDateOfBirth, setBbDateOfBirth] = useState('');
  const [bbRiskLevel, setBbRiskLevel] = useState<'low' | 'medium' | 'high' | 'critical'>('medium');
  const [bbStatus, setBbStatus] = useState<'active' | 'resolved' | 'archived'>('active');
  const [bbPhysicalDescription, setBbPhysicalDescription] = useState('');
  const [bbTags, setBbTags] = useState('');
  const [bbVehiclePlate, setBbVehiclePlate] = useState('');
  const [bbVehicleDescription, setBbVehicleDescription] = useState('');
  const [bbNotes, setBbNotes] = useState('');
  const [bbSaving, setBbSaving] = useState(false);
  const [showAddSightingForm, setShowAddSightingForm] = useState(false);
  const [sightingCategory, setSightingCategory] = useState('autre');
  const [sightingLocation, setSightingLocation] = useState('');
  const [sightingNotes, setSightingNotes] = useState('');
  const [sightingSaving, setSightingSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [plateAnalysisNote, setPlateAnalysisNote] = useState<string | null>(null); // last ANPR result, shown near the photo gallery so it's clear analysis ran even when it finds nothing
  // Link to a specific family/user and, per-sighting, to a registered residence —
  // makes "where they were seen" point at real data instead of free text alone.
  const [allUsersCache, setAllUsersCache] = useState<any[] | null>(null);
  const [allResidencesCache, setAllResidencesCache] = useState<any[] | null>(null);
  const [bbLinkedUserId, setBbLinkedUserId] = useState<string | null>(null);
  const [bbUserSearch, setBbUserSearch] = useState('');
  const [sightingResidenceId, setSightingResidenceId] = useState<string | null>(null);
  const [sightingResidenceSearch, setSightingResidenceSearch] = useState('');

  // ─── Data Fetching ──────────────────────────────────────────────────────

  const fetchReports = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (user?.id) params.append('userId', user.id);
      if (user?.role) params.append('role', user.role);
      const data = await apiGet<{ reports: PatrolReport[] }>(`/api/patrol/reports?${params}`);
      setReports(data.reports || []);
    } catch (err) {
      console.error('[Patrol] Failed to fetch reports:', err);
    }
  }, [user?.id, user?.role]);

  const fetchSites = useCallback(async () => {
    try {
      const data = await apiGet<{ sites: string[]; siteObjects: { id: string; name: string }[] }>('/api/patrol/sites');
      setSites(data.sites || []);
      setSiteObjects(data.siteObjects || []);
    } catch (err) {
      console.error('[Patrol] Failed to fetch sites:', err);
    }
  }, []);

  // Resume an in-progress round on mount (e.g. app was reloaded/backgrounded
  // mid-round) — round state lives server-side, not just in local React state.
  const fetchMyActiveRound = useCallback(async () => {
    if (!user?.id) return;
    try {
      const rounds = await apiGet<ActiveRound[]>('/api/patrol/rounds/active');
      const mine = (rounds || []).find(r => r.responderId === user.id);
      setMyActiveRound(mine || null);
      if (mine) setView('round');
    } catch (err) {
      console.error('[Patrol] Failed to fetch active round:', err);
    }
  }, [user?.id]);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await Promise.all([fetchReports(), fetchSites(), fetchMyActiveRound()]);
      setIsLoading(false);
    };
    load();
  }, [fetchReports, fetchSites, fetchMyActiveRound]);

  // Poll for new reports every 15s
  useEffect(() => {
    const interval = setInterval(fetchReports, 15000);
    return () => clearInterval(interval);
  }, [fetchReports]);

  useEffect(() => {
    activeRoundIdRef.current = myActiveRound?.id || null;
  }, [myActiveRound?.id]);

  // Live checkpoint feedback pushed straight to this responder's device
  // (see broadcastToUsers alongside the dispatcher/admin broadcast, server-side).
  useEffect(() => {
    const unsubVisited = wsManager.on('patrolCheckpointVisited', (msg: any) => {
      const data = msg.data || msg;
      if (data.roundId !== activeRoundIdRef.current) return;
      setMyActiveRound(prev => prev ? {
        ...prev,
        checkpoints: prev.checkpoints.map(cp =>
          cp.checkpointId === data.checkpointId ? { ...cp, visited: true, dwellMet: true } : cp
        ),
      } : prev);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    });
    return () => unsubVisited();
  }, []);

  // Server only broadcasts this to dispatcher/admin/superadmin sockets (see
  // notifyResponderBlackbookProximity), so no client-side role check needed
  // here. IMPORTANT: this means one of OUR responders entered a zone with
  // PAST Blackbook activity — never treat as live suspect detection (the
  // message body from the server already states this explicitly).
  useEffect(() => {
    const unsubProximity = wsManager.on('responderBlackbookProximityAlert', (msg: any) => {
      const data = msg.data || msg;
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(data.title || 'Zone à activité Blackbook connue', data.body || '');
    });
    return () => unsubProximity();
  }, []);

  // ─── Media Handlers ─────────────────────────────────────────────────────

  const pickFromLibrary = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        allowsMultipleSelection: true,
        quality: 0.8,
        videoMaxDuration: 60,
      });

      if (!result.canceled && result.assets) {
        const newMedia: LocalMedia[] = result.assets.map((asset, idx) => {
          const isVideo = asset.type === 'video';
          const ext = isVideo ? 'mp4' : 'jpg';
          const filename = asset.fileName || `media_${Date.now()}_${idx}.${ext}`;
          return {
            uri: asset.uri,
            type: isVideo ? 'video' as const : 'photo' as const,
            filename,
          };
        });
        setLocalMedia(prev => [...prev, ...newMedia]);
        if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch (err) {
      console.error('[Patrol] Image picker error:', err);
    }
  };

  const takePhoto = async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Veuillez autoriser l\'accès à la caméra pour prendre une photo.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.8,
        videoMaxDuration: 60,
      });

      if (!result.canceled && result.assets?.[0]) {
        const asset = result.assets[0];
        const isVideo = asset.type === 'video';
        const ext = isVideo ? 'mp4' : 'jpg';
        const filename = asset.fileName || `camera_${Date.now()}.${ext}`;
        setLocalMedia(prev => [...prev, {
          uri: asset.uri,
          type: isVideo ? 'video' : 'photo',
          filename,
        }]);
        if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }
    } catch (err) {
      console.error('[Patrol] Camera error:', err);
    }
  };

  const removeLocalMedia = (index: number) => {
    setLocalMedia(prev => prev.filter((_, i) => i !== index));
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  // ─── Form Handlers ──────────────────────────────────────────────────────

  const resetForm = () => {
    setSelectedSite('');
    setSelectedStatus('habituel');
    setTaskResults({});
    setTaskComments({});
    setNotes('');
    setLocalMedia([]);
  };

  const handleCreate = async () => {
    resetForm();
    setCreateFormMode('report');
    // Pre-fill task results as 'ok'
    const defaults: Record<string, TaskResult> = {};
    DEFAULT_TASKS.forEach(t => { defaults[t.name] = 'ok'; });
    setTaskResults(defaults);
    setView('create');

    // Pre-select the agent's last-used site, if it's still a valid site
    if (user?.id) {
      try {
        const lastSite = await AsyncStorage.getItem(`patrol_last_site_${user.id}`);
        if (lastSite && sites.includes(lastSite)) {
          setSelectedSite(lastSite);
        }
      } catch { /* ignore */ }
    }
  };

  // ─── GPS round handlers ─────────────────────────────────────────────────
  const handleStartRound = useCallback(async (site: { id: string; name: string }) => {
    if (!user?.id) return;
    setRoundStarting(true);
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/patrol/rounds/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ siteId: site.id }),
        timeout: 10000,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Erreur', err.error || 'Impossible de démarrer la ronde.');
        return;
      }
      const round = await res.json();
      setMyActiveRound(round);
      setShowRoundSitePicker(false);
      setView('round');
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e: any) {
      Alert.alert('Erreur', e.message || 'Impossible de contacter le serveur.');
    }
    setRoundStarting(false);
  }, [user?.id]);

  // "Terminer la ronde" doesn't submit directly — it opens the same
  // questionnaire (status/tasks/notes/photos) a manual report uses, pre-filled
  // with the round's site and defaults, via renderCreateView in 'round-finish'
  // mode. Submission itself is handleSubmitRoundFinish, below.
  const openRoundFinishForm = useCallback(() => {
    if (!myActiveRound) return;
    resetForm();
    const defaults: Record<string, TaskResult> = {};
    DEFAULT_TASKS.forEach(t => { defaults[t.name] = 'ok'; });
    setTaskResults(defaults);
    setSelectedSite(myActiveRound.siteName);
    setCreateFormMode('round-finish');
    setView('create');
  }, [myActiveRound]);

  const handleSubmitRoundFinish = useCallback(async () => {
    if (!myActiveRound) return;
    const tasks: PatrolTask[] = DEFAULT_TASKS.map(t => ({
      name: t.name,
      label: t.label,
      result: taskResults[t.name] || 'ok',
      ...(taskComments[t.name] ? { comment: taskComments[t.name] } : {}),
    }));
    const media = [...localMedia];

    setIsSubmitting(true);
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/patrol/rounds/${myActiveRound.id}/finish`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ status: selectedStatus, tasks, notes: notes || undefined }),
        timeout: 10000,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Erreur', err.error || 'Impossible de terminer la ronde.');
        return;
      }
      const data = await res.json();

      if (media.length > 0) {
        setIsUploading(true);
        for (const m of media) {
          await uploadMedia(data.report.id, m);
        }
        setIsUploading(false);
      }

      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setFinishedSiteId(myActiveRound.siteId);
      setRouteOrigin(myActiveRound.lastLocation
        ? { latitude: myActiveRound.lastLocation.latitude, longitude: myActiveRound.lastLocation.longitude }
        : null);
      setMyActiveRound(null);
      setSelectedReport(data.report);
      setView('detail');
      resetForm();
      await fetchReports();
      // Offer to plan a varied route to the next stop — reuses the same
      // site list as starting a round. "Terminer sans naviguer" in the
      // modal just dismisses it, leaving today's detail view as-is.
      setShowNextLocationPicker(true);
    } catch (e: any) {
      // Unlike a manual report, this is NOT queued offline — the round stays
      // active server-side until a finish call actually succeeds, so it's
      // safe (and clearer to the responder) to just let them retry.
      Alert.alert('Erreur', e.message || "Impossible de terminer la ronde. Vérifiez votre connexion et réessayez.");
    } finally {
      setIsSubmitting(false);
      setIsUploading(false);
    }
  }, [myActiveRound, taskResults, taskComments, localMedia, selectedStatus, notes, fetchReports]);

  const handleInterruptRound = useCallback(async () => {
    if (!myActiveRound) return;
    setRoundFinishing(true);
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/patrol/rounds/${myActiveRound.id}/interrupt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ reason: interruptReason.trim() || undefined }),
        timeout: 10000,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Erreur', err.error || "Impossible d'interrompre la ronde.");
        return;
      }
      const data = await res.json();
      setMyActiveRound(null);
      setShowInterruptConfirm(false);
      setInterruptReason('');
      setSelectedReport(data.report);
      setView('detail');
      await fetchReports();
    } catch (e: any) {
      Alert.alert('Erreur', e.message || 'Impossible de contacter le serveur.');
    }
    setRoundFinishing(false);
  }, [myActiveRound, interruptReason, fetchReports]);

  // Scores Mapbox Directions alternatives to `site` against recent
  // patrol_route_history + Blackbook proximity (server-side) and shows the
  // result as a preview. Called both from the "next location" picker and
  // from the driving/walking toggle on the preview screen itself.
  const planRoute = useCallback(async (site: { id: string; name: string }, mode: 'driving' | 'walking') => {
    setRoutePlanning(true);
    setSelectedNextSite(site);
    try {
      let origin = routeOrigin;
      if (!origin) {
        const pos = await locationService.getCurrentPosition();
        origin = { latitude: pos.latitude, longitude: pos.longitude };
        setRouteOrigin(origin);
      }
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/patrol/routes/plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ fromLatitude: origin.latitude, fromLongitude: origin.longitude, toSiteId: site.id, mode }),
        timeout: 15000,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Erreur', err.error || "Impossible de calculer un itinéraire.");
        return;
      }
      const plan: RoutePlan = await res.json();
      setRouteMode(mode);
      setRoutePlan(plan);
      setShowNextLocationPicker(false);
      setView('routePreview');
    } catch (e: any) {
      Alert.alert('Erreur', e.message || 'Impossible de contacter le serveur.');
    } finally {
      setRoutePlanning(false);
    }
  }, [routeOrigin]);

  // Persists the taken route to patrol_route_history and mirrors it live to
  // the console (best-effort — a failure here shouldn't block the
  // responder from actually navigating), then hands off to native
  // turn-by-turn nav.
  const handleConfirmAndNavigate = useCallback(async () => {
    if (!routePlan || !routeOrigin) return;
    setRouteConfirming(true);
    try {
      await fetchWithTimeout(`${getApiBaseUrl()}/api/patrol/routes/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({
          toSiteId: routePlan.toSiteId,
          geometry: routePlan.geometry,
          distanceMeters: routePlan.distanceMeters,
          durationSeconds: routePlan.durationSeconds,
          rationale: routePlan.rationale,
          mode: routePlan.mode,
          fromLatitude: routeOrigin.latitude,
          fromLongitude: routeOrigin.longitude,
        }),
        timeout: 10000,
      }).catch(() => {});
      openNativeNavigation(routePlan, routeOrigin);
      setView('detail');
      setRoutePlan(null);
    } finally {
      setRouteConfirming(false);
    }
  }, [routePlan, routeOrigin]);

  const handleSubmit = async () => {
    if (!selectedSite) return;
    if (!user?.id) return;

    const tasks: PatrolTask[] = DEFAULT_TASKS.map(t => ({
      name: t.name,
      label: t.label,
      result: taskResults[t.name] || 'ok',
      ...(taskComments[t.name] ? { comment: taskComments[t.name] } : {}),
    }));

    const reportDraft = {
      createdBy: user.id,
      location: selectedSite,
      status: selectedStatus,
      tasks,
      notes: notes || undefined,
    };
    const media = [...localMedia];

    setIsSubmitting(true);
    try {
      const report = await createPatrolReport(reportDraft);
      AsyncStorage.setItem(`patrol_last_site_${user.id}`, selectedSite).catch(() => {});

      if (media.length > 0) {
        setIsUploading(true);
        for (const m of media) {
          await uploadMedia(report.id, m);
        }
        setIsUploading(false);
      }

      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }

      await fetchReports();
      setView('list');
      resetForm();
    } catch (err) {
      console.error('[Patrol] Failed to submit report, queuing for retry:', err);
      // Network/server failure — queue the whole submission (report + pending media)
      // instead of dropping it. services/offline-queue-processor.ts drains this once
      // connectivity returns, without re-creating the report if it already succeeded.
      await offlineCache.enqueueAction('patrol_report', {
        reportDraft,
        media,
        uploadedUris: [],
      });
      Alert.alert(
        'Hors ligne',
        'Le rapport a été mis en file d\'attente et sera envoyé automatiquement dès que la connexion revient.',
      );
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      setView('list');
      resetForm();
    } finally {
      setIsSubmitting(false);
      setIsUploading(false);
    }
  };

  const toggleTaskResult = (taskName: string) => {
    setTaskResults(prev => ({
      ...prev,
      [taskName]: prev[taskName] === 'ok' ? 'pas_ok' : 'ok',
    }));
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  // ─── Filtered Reports ─────────────────────────────────────────────────

  const filteredReports = filterStatus === 'all'
    ? reports
    : reports.filter(r => r.status === filterStatus);

  // ─── Render: Report List ──────────────────────────────────────────────

  const renderReportCard = ({ item }: { item: PatrolReport }) => {
    const statusConf = STATUS_CONFIG[item.status];
    const hasPasOk = item.tasks.some(t => t.result === 'pas_ok');
    const mediaCount = item.media?.length || 0;

    return (
      <TouchableOpacity
        style={styles.reportCard}
        onPress={() => { setSelectedReport(item); setView('detail'); }}
        activeOpacity={0.7}
      >
        <View style={styles.reportCardHeader}>
          <View style={[styles.statusBadge, { backgroundColor: statusConf.color }]}>
            <Text style={[styles.statusBadgeText, { color: statusConf.textColor }]}>
              {statusConf.label}
            </Text>
          </View>
          <Text style={styles.reportTime}>{formatRelativeTime(item.createdAt)}</Text>
        </View>
        <Text style={styles.reportLocation} numberOfLines={1}>{item.location}</Text>
        <View style={styles.reportCardFooter}>
          <Text style={styles.reportAuthor}>{item.createdByName}</Text>
          <View style={styles.reportCardBadges}>
            {mediaCount > 0 && (
              <View style={styles.mediaBadge}>
                <Text style={styles.mediaBadgeText}>{mediaCount} 📎</Text>
              </View>
            )}
            {hasPasOk && (
              <View style={styles.warningBadge}>
                <Text style={styles.warningBadgeText}>PAS OK</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  // ─── Blackbook logic ────────────────────────────────────────────────────

  const BLACKBOOK_CATEGORY_LABELS: Record<string, string> = {
    prise_info: "Prise d'info", intrusion: 'Intrusion', menaces: 'Menaces',
    envoi_courrier: 'Envoi de courrier', reperage: 'Repérage', autre: 'Autre',
  };
  const BLACKBOOK_RISK_LABELS: Record<string, string> = { low: '🟢 Faible', medium: '🟡 Moyen', high: '🟠 Élevé', critical: '🔴 Critique' };
  const BLACKBOOK_STATUS_LABELS: Record<string, string> = { active: 'Surveillance active', resolved: 'Résolu', archived: 'Archivé' };

  const blackbookLastSighting = (entry: any) => {
    if (!entry.sightings || entry.sightings.length === 0) return null;
    return entry.sightings.reduce((latest: any, s: any) => (!latest || s.timestamp > latest.timestamp ? s : latest), null);
  };

  const loadBlackbook = useCallback(async () => {
    setBlackbookLoading(true);
    try {
      const data = await apiGet<any[]>('/api/blackbook');
      setBlackbookData(data);
    } catch (e) {
      setBlackbookData([]);
    }
    setBlackbookLoading(false);
  }, []);

  const openBlackbookModal = useCallback(() => {
    setShowBlackbookModal(true);
    setBlackbookView('list');
    setBlackbookSearch('');
    loadBlackbook();
  }, [loadBlackbook]);

  const filteredBlackbook = useMemo(() => {
    const query = blackbookSearch.trim().toLowerCase();
    return blackbookData.filter((e: any) => {
      if (blackbookRiskFilter && e.riskLevel !== blackbookRiskFilter) return false;
      if (!query) return true;
      const last = blackbookLastSighting(e);
      const haystack = [
        e.firstName, e.lastName, ...(e.aliases || []), e.notes, last?.location?.address,
        ...(e.vehicles || []).map((v: any) => `${v.plate || ''} ${v.description || ''}`),
        ...(e.tags || []),
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(query);
    });
  }, [blackbookData, blackbookSearch, blackbookRiskFilter]);

  const resetBlackbookForm = () => {
    setBbFirstName(''); setBbLastName(''); setBbAliases(''); setBbDateOfBirth('');
    setBbRiskLevel('medium'); setBbStatus('active'); setBbPhysicalDescription('');
    setBbTags(''); setBbVehiclePlate(''); setBbVehicleDescription(''); setBbNotes('');
    setBbLinkedUserId(null); setBbUserSearch('');
    setEntityCandidates([]);
  };

  const ensureAllUsersLoaded = useCallback(async () => {
    if (allUsersCache) return;
    try {
      const data = await apiGet<any[]>('/api/users');
      setAllUsersCache(data);
    } catch (e) {
      setAllUsersCache([]);
    }
  }, [allUsersCache]);

  const ensureAllResidencesLoaded = useCallback(async () => {
    if (allResidencesCache) return;
    try {
      const data = await apiGet<any[]>('/api/all-residences');
      setAllResidencesCache(data);
    } catch (e) {
      setAllResidencesCache([]);
    }
  }, [allResidencesCache]);

  const openBlackbookForm = useCallback((entry: any | null) => {
    setCurrentBlackbookEntry(entry);
    setShowAddSightingForm(false);
    ensureAllUsersLoaded();
    ensureAllResidencesLoaded();
    setPlateAnalysisNote(null);
    if (!entry) {
      resetBlackbookForm();
      setRelatedBlackbook([]);
    } else {
      setBbFirstName(entry.firstName || ''); setBbLastName(entry.lastName || '');
      setBbAliases((entry.aliases || []).join(', ')); setBbDateOfBirth(entry.dateOfBirth || '');
      setBbRiskLevel(entry.riskLevel || 'medium'); setBbStatus(entry.status || 'active');
      setBbPhysicalDescription(entry.physicalDescription || ''); setBbTags((entry.tags || []).join(', '));
      const v0 = (entry.vehicles || [])[0];
      setBbVehiclePlate(v0?.plate || ''); setBbVehicleDescription(v0?.description || '');
      setBbNotes(entry.notes || '');
      setBbLinkedUserId(entry.linkedUserId || null); setBbUserSearch('');
      setRelatedBlackbook([]);
      setEntityCandidates([]);
      apiGet<any[]>(`/api/blackbook/${entry.id}/related`).then(setRelatedBlackbook).catch(() => setRelatedBlackbook([]));
    }
    setSightingResidenceId(null); setSightingResidenceSearch('');
    setBlackbookView('form');
  }, [ensureAllUsersLoaded, ensureAllResidencesLoaded]);

  const openRelatedBlackbookEntry = useCallback(async (entryId: string) => {
    const existing = blackbookData.find((e: any) => e.id === entryId);
    if (existing) { openBlackbookForm(existing); return; }
    try {
      const entry = await apiGet<any>(`/api/blackbook/${entryId}`);
      openBlackbookForm(entry);
    } catch {
      Alert.alert('Erreur', 'Impossible de charger cette fiche.');
    }
  }, [blackbookData, openBlackbookForm]);

  // Entity extraction from free-text notes — explicit "Analyser" trigger
  // only, never automatic on keystroke/save.
  const analyzeNotes = useCallback(async (text: string) => {
    if (!text.trim()) { setEntityCandidates([]); return; }
    setEntityAnalyzing(true);
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/notes/extract-entities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ text }),
        timeout: 15000,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Erreur', err.error || 'Analyse indisponible.');
        setEntityCandidates([]);
        return;
      }
      const data = await res.json();
      setEntityCandidates(data.candidates || []);
    } catch (e: any) {
      Alert.alert('Erreur', e.message || 'Impossible de contacter le serveur.');
      setEntityCandidates([]);
    }
    setEntityAnalyzing(false);
  }, []);

  const applyEntityCandidate = useCallback((c: { type: string; value: string }) => {
    if (c.type === 'plate') {
      if (!bbVehiclePlate.trim()) { setBbVehiclePlate(c.value); return; }
      Alert.alert('Plaque détectée', `${c.value} (véhicule actuel : ${bbVehiclePlate})`);
    } else if (c.type === 'name') {
      const current = bbAliases.split(',').map(s => s.trim()).filter(Boolean);
      if (!current.includes(c.value)) setBbAliases([...current, c.value].join(', '));
    } else if (c.type === 'location') {
      setSightingLocation(c.value);
    }
  }, [bbVehiclePlate, bbAliases]);

  const saveBlackbookEntry = useCallback(async () => {
    if (!bbFirstName.trim() && !bbLastName.trim()) { Alert.alert('Erreur', 'Nom ou prénom requis'); return; }
    setBbSaving(true);
    try {
      const baseUrl = getApiBaseUrl();
      const body: any = {
        firstName: bbFirstName.trim(), lastName: bbLastName.trim(),
        aliases: bbAliases.split(',').map(s => s.trim()).filter(Boolean),
        dateOfBirth: bbDateOfBirth || undefined, riskLevel: bbRiskLevel,
        physicalDescription: bbPhysicalDescription.trim() || undefined,
        tags: bbTags.split(',').map(s => s.trim()).filter(Boolean),
        vehicles: (bbVehiclePlate.trim() || bbVehicleDescription.trim()) ? [{ plate: bbVehiclePlate.trim() || undefined, description: bbVehicleDescription.trim() || undefined }] : [],
        notes: bbNotes.trim() || undefined,
        // Sent as '' rather than undefined when cleared, so clearing the link
        // actually clears it server-side (PUT only updates fields it receives).
        linkedUserId: bbLinkedUserId || '',
      };
      if (currentBlackbookEntry) {
        body.status = bbStatus;
        const res = await fetchWithTimeout(`${baseUrl}/api/blackbook/${currentBlackbookEntry.id}`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(body), timeout: 10000,
        });
        if (!res.ok) throw new Error('failed');
        await loadBlackbook();
        setBlackbookView('list');
      } else {
        const res = await fetchWithTimeout(`${baseUrl}/api/blackbook`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify(body), timeout: 10000,
        });
        if (!res.ok) throw new Error('failed');
        const created = await res.json();
        await loadBlackbook();
        setCurrentBlackbookEntry(created);
        Alert.alert('Fiche créée', 'Vous pouvez maintenant ajouter des photos et des signalements.');
      }
    } catch (e) {
      Alert.alert('Erreur', 'Impossible d\'enregistrer la fiche');
    }
    setBbSaving(false);
  }, [bbFirstName, bbLastName, bbAliases, bbDateOfBirth, bbRiskLevel, bbStatus, bbPhysicalDescription, bbTags, bbVehiclePlate, bbVehicleDescription, bbNotes, bbLinkedUserId, currentBlackbookEntry, loadBlackbook]);

  const deleteBlackbookEntry = useCallback(() => {
    if (!currentBlackbookEntry) return;
    Alert.alert('Supprimer', `Supprimer définitivement la fiche de ${currentBlackbookEntry.firstName} ${currentBlackbookEntry.lastName} ?`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer', style: 'destructive', onPress: async () => {
          try {
            const baseUrl = getApiBaseUrl();
            await fetchWithTimeout(`${baseUrl}/api/blackbook/${currentBlackbookEntry.id}`, { method: 'DELETE', headers: await authHeader(), timeout: 10000 });
            await loadBlackbook();
            setBlackbookView('list');
          } catch (e) {
            Alert.alert('Erreur', 'Suppression impossible');
          }
        },
      },
    ]);
  }, [currentBlackbookEntry, loadBlackbook]);

  const saveSighting = useCallback(async () => {
    if (!currentBlackbookEntry) return;
    setSightingSaving(true);
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetchWithTimeout(`${baseUrl}/api/blackbook/${currentBlackbookEntry.id}/sightings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({
          timestamp: Date.now(), category: sightingCategory,
          location: sightingLocation.trim() ? { address: sightingLocation.trim() } : undefined,
          residenceId: sightingResidenceId || undefined,
          notes: sightingNotes.trim() || undefined,
        }),
        timeout: 10000,
      });
      if (!res.ok) throw new Error('failed');
      const sighting = await res.json();
      setCurrentBlackbookEntry({ ...currentBlackbookEntry, sightings: [...(currentBlackbookEntry.sightings || []), sighting] });
      setSightingLocation(''); setSightingNotes(''); setShowAddSightingForm(false);
      setSightingResidenceId(null); setSightingResidenceSearch('');
      loadBlackbook();
    } catch (e) {
      Alert.alert('Erreur', 'Impossible d\'ajouter le signalement');
    }
    setSightingSaving(false);
  }, [currentBlackbookEntry, sightingCategory, sightingLocation, sightingResidenceId, sightingNotes, loadBlackbook]);

  const deleteSighting = useCallback((sightingId: string) => {
    if (!currentBlackbookEntry) return;
    Alert.alert('Supprimer', 'Supprimer ce signalement ?', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer', style: 'destructive', onPress: async () => {
          try {
            const baseUrl = getApiBaseUrl();
            await fetchWithTimeout(`${baseUrl}/api/blackbook/${currentBlackbookEntry.id}/sightings/${sightingId}`, { method: 'DELETE', headers: await authHeader(), timeout: 10000 });
            setCurrentBlackbookEntry({ ...currentBlackbookEntry, sightings: (currentBlackbookEntry.sightings || []).filter((s: any) => s.id !== sightingId) });
            loadBlackbook();
          } catch (e) {
            Alert.alert('Erreur', 'Suppression impossible');
          }
        },
      },
    ]);
  }, [currentBlackbookEntry, loadBlackbook]);

  const pickAndUploadBlackbookPhoto = useCallback(async () => {
    if (!currentBlackbookEntry) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { Alert.alert('Permission requise', 'Autorisez l\'accès aux photos pour continuer.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    if (result.canceled || !result.assets?.[0]) return;
    setPhotoUploading(true);
    try {
      const baseUrl = getApiBaseUrl();
      const asset = result.assets[0];
      const formData = new FormData();
      formData.append('photos', { uri: asset.uri, name: 'photo.jpg', type: 'image/jpeg' } as any);
      const res = await fetchWithTimeout(`${baseUrl}/api/blackbook/${currentBlackbookEntry.id}/photos`, {
        method: 'POST', headers: await authHeader(), body: formData, timeout: 20000,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setCurrentBlackbookEntry({ ...currentBlackbookEntry, photos: data.photos });
      // Vehicle/plate recognition (ANPR) suggestion — never auto-written.
      // Mobile only has a single scalar plate field (unlike the console's
      // vehicle list), so only offer to fill it if empty; if a different
      // plate is already set, just surface a heads-up rather than silently
      // overwriting it.
      if (data.plateSuggestion?.ok) {
        const detectedPlate = data.plateSuggestion.plate;
        setPlateAnalysisNote(`🚗 Plaque détectée : ${detectedPlate}`);
        if (!bbVehiclePlate.trim()) {
          Alert.alert('Plaque détectée', `Plaque détectée sur la photo : ${detectedPlate}. Utiliser ?`, [
            { text: 'Ignorer', style: 'cancel' },
            { text: 'Utiliser', onPress: () => setBbVehiclePlate(detectedPlate) },
          ]);
        } else if (bbVehiclePlate.trim().toUpperCase() !== detectedPlate) {
          Alert.alert('Plaque détectée', `Une plaque différente a été détectée sur la photo : ${detectedPlate} (véhicule actuel : ${bbVehiclePlate}).`);
        }
      } else if (data.plateSuggestion) {
        // "No plate on this photo" is the normal case for most Blackbook
        // photos (portraits) — show it quietly inline rather than an
        // intrusive Alert, but a real service/config error still needs to
        // be visible so it gets noticed and fixed.
        setPlateAnalysisNote(data.plateSuggestion.reason === 'Aucune plaque détectée sur la photo'
          ? '🔍 Aucune plaque détectée sur cette photo'
          : `⚠️ Analyse de plaque indisponible : ${data.plateSuggestion.reason}`);
      } else {
        setPlateAnalysisNote(null);
      }
    } catch (e: any) {
      Alert.alert('Erreur', e.message && e.message !== 'failed' ? e.message : 'Envoi de la photo impossible');
    }
    setPhotoUploading(false);
  }, [currentBlackbookEntry, bbVehiclePlate]);

  const deleteBlackbookPhoto = useCallback((url: string) => {
    if (!currentBlackbookEntry) return;
    Alert.alert('Supprimer', 'Supprimer cette photo ?', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Supprimer', style: 'destructive', onPress: async () => {
          try {
            const baseUrl = getApiBaseUrl();
            const res = await fetchWithTimeout(`${baseUrl}/api/blackbook/${currentBlackbookEntry.id}/photos`, {
              method: 'DELETE', headers: { 'Content-Type': 'application/json', ...(await authHeader()) }, body: JSON.stringify({ url }), timeout: 10000,
            });
            if (!res.ok) throw new Error('failed');
            const data = await res.json();
            setCurrentBlackbookEntry({ ...currentBlackbookEntry, photos: data.photos });
          } catch (e) {
            Alert.alert('Erreur', 'Suppression impossible');
          }
        },
      },
    ]);
  }, [currentBlackbookEntry]);

  const exportBlackbookPdf = useCallback(async () => {
    if (!currentBlackbookEntry) return;
    if (!FileSystemModule) { Alert.alert('Indisponible', 'Export PDF non disponible sur cette version de l\'app.'); return; }
    try {
      const baseUrl = getApiBaseUrl();
      const hdr = await authHeader();
      const fileName = `blackbook-${(currentBlackbookEntry.lastName || 'dossier').replace(/[^a-zA-Z0-9-]/g, '_')}.pdf`;
      const fileUri = `${FileSystemModule.cacheDirectory}${fileName}`;
      const result = await FileSystemModule.downloadAsync(`${baseUrl}/api/blackbook/${currentBlackbookEntry.id}/pdf`, fileUri, { headers: hdr });
      if (result.status !== 200) throw new Error('download failed');
      if (SharingModule && await SharingModule.isAvailableAsync()) {
        await SharingModule.shareAsync(result.uri, { mimeType: 'application/pdf' });
      } else {
        Alert.alert('PDF téléchargé', fileUri);
      }
    } catch (e) {
      Alert.alert('Erreur', 'Export PDF impossible');
    }
  }, [currentBlackbookEntry]);

  const renderListView = () => (
    <View style={styles.container}>
      {/* Blackbook access */}
      <TouchableOpacity style={styles.blackbookBar} onPress={openBlackbookModal}>
        <Text style={styles.blackbookBarText}>{'\u{1F575}\u{FE0F}'} Blackbook — personnes suspectes</Text>
      </TouchableOpacity>

      {/* Filter chips */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterRow} contentContainerStyle={styles.filterRowContent}>
        <TouchableOpacity
          style={[styles.filterChip, filterStatus === 'all' && styles.filterChipActive]}
          onPress={() => setFilterStatus('all')}
        >
          <Text style={[styles.filterChipText, filterStatus === 'all' && styles.filterChipTextActive]}>Tous</Text>
        </TouchableOpacity>
        {(Object.entries(STATUS_CONFIG) as [PatrolStatus, typeof STATUS_CONFIG[PatrolStatus]][]).map(([key, conf]) => (
          <TouchableOpacity
            key={key}
            style={[styles.filterChip, filterStatus === key && { backgroundColor: conf.color }]}
            onPress={() => setFilterStatus(key)}
          >
            <View style={[styles.filterDot, { backgroundColor: conf.color }]} />
            <Text style={[styles.filterChipText, filterStatus === key && { color: conf.textColor }]}>
              {conf.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Reports list */}
      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#1e3a5f" />
        </View>
      ) : filteredReports.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>📋</Text>
          <Text style={styles.emptyText}>Aucun rapport de ronde</Text>
          <Text style={styles.emptySubtext}>
            {isStaffRole(user?.role)
              ? 'Créez votre premier rapport'
              : 'Vous n\'avez pas accès aux rapports'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredReports}
          keyExtractor={item => item.id}
          renderItem={renderReportCard}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
        />
      )}

      {/* FAB: Start a GPS-tracked round — responders do this in the field,
          but admin/superadmin can also run one (e.g. spot-checking a site
          themselves); dispatcher is excluded since they're deskbound. The
          server side already permits this via requireRole('responder')'s
          role hierarchy (admin/superadmin sit above responder) — this is
          purely the matching client-side visibility gate. */}
      {(user?.role === 'responder' || user?.role === 'admin' || user?.role === 'superadmin') && (
        <TouchableOpacity
          style={styles.roundFab}
          onPress={() => setShowRoundSitePicker(true)}
          activeOpacity={0.8}
        >
          <Text style={styles.fabText}>📍 Démarrer une ronde</Text>
        </TouchableOpacity>
      )}

      {/* FAB: Create new report (staff only) */}
      {isStaffRole(user?.role) && (
        <TouchableOpacity style={styles.fab} onPress={handleCreate} activeOpacity={0.8}>
          <Text style={styles.fabText}>+ Nouveau rapport</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  // ─── Render: Create Form ──────────────────────────────────────────────

  const renderCreateView = () => (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.formHeader}>
        <TouchableOpacity
          onPress={() => setView(createFormMode === 'round-finish' ? 'round' : 'list')}
          style={styles.backButton}
        >
          <Text style={styles.backButtonText}>← Retour</Text>
        </TouchableOpacity>
        <Text style={styles.formTitle}>
          {createFormMode === 'round-finish' ? 'Terminer la ronde' : 'Nouveau rapport de ronde'}
        </Text>
      </View>

      <ScrollView style={styles.formScroll} contentContainerStyle={styles.formContent} keyboardShouldPersistTaps="handled">
        {/* Date/Time (auto) */}
        <View style={styles.formSection}>
          <Text style={styles.formLabel}>Date et heure</Text>
          <View style={styles.autoField}>
            <Text style={styles.autoFieldText}>{formatDateTime(Date.now())}</Text>
            <Text style={styles.autoFieldHint}>Automatique</Text>
          </View>
        </View>

        {/* Site Selection — fixed (read-only) when finishing a GPS round */}
        <View style={styles.formSection}>
          <Text style={styles.formLabel}>Lieu de la ronde</Text>
          {createFormMode === 'round-finish' ? (
            <View style={styles.autoField}>
              <Text style={styles.autoFieldText}>{selectedSite}</Text>
              <Text style={styles.autoFieldHint}>Ronde GPS</Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.dropdownButton, !selectedSite && styles.dropdownButtonEmpty]}
              onPress={() => setShowSitePicker(true)}
            >
              <Text style={[styles.dropdownText, !selectedSite && styles.dropdownPlaceholder]}>
                {selectedSite || 'Sélectionner un lieu...'}
              </Text>
              <Text style={styles.dropdownArrow}>▼</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Status Selection */}
        <View style={styles.formSection}>
          <Text style={styles.formLabel}>Statut de la ronde</Text>
          <View style={styles.statusGrid}>
            {(Object.entries(STATUS_CONFIG) as [PatrolStatus, typeof STATUS_CONFIG[PatrolStatus]][]).map(([key, conf]) => (
              <TouchableOpacity
                key={key}
                style={[
                  styles.statusOption,
                  { borderColor: conf.color },
                  selectedStatus === key && { backgroundColor: conf.color },
                ]}
                onPress={() => {
                  setSelectedStatus(key);
                  if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                }}
              >
                <Text style={[
                  styles.statusOptionText,
                  selectedStatus === key ? { color: conf.textColor } : { color: conf.color },
                ]}>
                  {conf.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Tasks */}
        <View style={styles.formSection}>
          <Text style={styles.formLabel}>Tâches</Text>
          {DEFAULT_TASKS.map(task => (
            <View key={task.name} style={styles.taskRow}>
              <Text style={styles.taskLabel}>{task.label}</Text>
              <View style={styles.taskToggle}>
                <TouchableOpacity
                  style={[
                    styles.taskButton,
                    styles.taskButtonOk,
                    taskResults[task.name] === 'ok' && styles.taskButtonOkActive,
                  ]}
                  onPress={() => {
                    setTaskResults(prev => ({ ...prev, [task.name]: 'ok' }));
                    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                >
                  <Text style={[
                    styles.taskButtonText,
                    taskResults[task.name] === 'ok' && styles.taskButtonTextActive,
                  ]}>OK</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.taskButton,
                    styles.taskButtonPasOk,
                    taskResults[task.name] === 'pas_ok' && styles.taskButtonPasOkActive,
                  ]}
                  onPress={() => {
                    setTaskResults(prev => ({ ...prev, [task.name]: 'pas_ok' }));
                    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                >
                  <Text style={[
                    styles.taskButtonText,
                    taskResults[task.name] === 'pas_ok' && styles.taskButtonPasOkTextActive,
                  ]}>PAS OK</Text>
                </TouchableOpacity>
              </View>
              {/* Comment field: always for 'autre', and for 'anomalies' once flagged PAS OK
                  so the detail goes into a structured field instead of the general notes. */}
              {(task.name === 'autre' || (task.name === 'anomalies' && taskResults[task.name] === 'pas_ok')) && (
                <TextInput
                  style={styles.autreInput}
                  placeholder="Précisez..."
                  placeholderTextColor="#9ca3af"
                  value={taskComments[task.name] || ''}
                  onChangeText={(text) => setTaskComments(prev => ({ ...prev, [task.name]: text }))}
                  multiline
                  returnKeyType="done"
                />
              )}
            </View>
          ))}
        </View>

        {/* Media Attachments */}
        <View style={styles.formSection}>
          <Text style={styles.formLabel}>Photos / Vidéos</Text>
          <View style={styles.mediaButtonRow}>
            <TouchableOpacity style={styles.mediaButton} onPress={takePhoto} activeOpacity={0.7}>
              <Text style={styles.mediaButtonIcon}>📷</Text>
              <Text style={styles.mediaButtonLabel}>Prendre une photo</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.mediaButton} onPress={pickFromLibrary} activeOpacity={0.7}>
              <Text style={styles.mediaButtonIcon}>🖼️</Text>
              <Text style={styles.mediaButtonLabel}>Galerie</Text>
            </TouchableOpacity>
          </View>

          {/* Media preview grid */}
          {localMedia.length > 0 && (
            <View style={styles.mediaGrid}>
              {localMedia.map((media, idx) => (
                <View key={`${media.uri}-${idx}`} style={styles.mediaThumb}>
                  {media.type === 'photo' ? (
                    <TouchableOpacity onPress={() => setShowMediaPreview(media.uri)} activeOpacity={0.8}>
                      <Image source={{ uri: media.uri }} style={styles.mediaThumbImage} />
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.mediaThumbVideo}>
                      <Text style={styles.mediaThumbVideoIcon}>🎬</Text>
                      <Text style={styles.mediaThumbVideoLabel} numberOfLines={1}>{media.filename}</Text>
                    </View>
                  )}
                  <TouchableOpacity
                    style={styles.mediaRemoveButton}
                    onPress={() => removeLocalMedia(idx)}
                  >
                    <Text style={styles.mediaRemoveText}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Notes */}
        <View style={styles.formSection}>
          <Text style={styles.formLabel}>Notes additionnelles</Text>

          <TextInput
            style={styles.notesInput}
            placeholder="Observations, commentaires..."
            placeholderTextColor="#9ca3af"
            value={notes}
            onChangeText={setNotes}
            multiline
            numberOfLines={3}
            returnKeyType="done"
          />
        </View>

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitButton, (!selectedSite || isSubmitting || isUploading) && styles.submitButtonDisabled]}
          onPress={createFormMode === 'round-finish' ? handleSubmitRoundFinish : handleSubmit}
          disabled={!selectedSite || isSubmitting || isUploading}
          activeOpacity={0.8}
        >
          {isSubmitting || isUploading ? (
            <View style={styles.submitLoadingRow}>
              <ActivityIndicator color="#fff" />
              <Text style={styles.submitButtonText}>
                {isUploading ? 'Envoi des médias...' : 'Envoi du rapport...'}
              </Text>
            </View>
          ) : (
            <Text style={styles.submitButtonText}>
              {createFormMode === 'round-finish' ? 'Terminer et envoyer le rapport' : 'Soumettre le rapport'}
            </Text>
          )}
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* Site Picker Modal */}
      <Modal visible={showSitePicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Sélectionner un lieu</Text>
              <TouchableOpacity onPress={() => setShowSitePicker(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <FlatList
              data={sites}
              keyExtractor={item => item}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.siteOption, selectedSite === item && styles.siteOptionActive]}
                  onPress={() => {
                    setSelectedSite(item);
                    setShowSitePicker(false);
                    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  }}
                >
                  <Text style={[styles.siteOptionText, selectedSite === item && styles.siteOptionTextActive]}>
                    {item}
                  </Text>
                  {selectedSite === item && <Text style={styles.siteCheck}>✓</Text>}
                </TouchableOpacity>
              )}
              contentContainerStyle={styles.siteList}
            />
          </View>
        </View>
      </Modal>

      {/* Media Preview Modal */}
      <Modal visible={!!showMediaPreview} transparent animationType="fade">
        <TouchableOpacity
          style={styles.previewOverlay}
          activeOpacity={1}
          onPress={() => setShowMediaPreview(null)}
        >
          {showMediaPreview && (
            <Image
              source={{ uri: showMediaPreview }}
              style={styles.previewImage}
              resizeMode="contain"
            />
          )}
          <TouchableOpacity
            style={styles.previewCloseButton}
            onPress={() => setShowMediaPreview(null)}
          >
            <Text style={styles.previewCloseText}>✕ Fermer</Text>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </View>
  );

  // ─── Render: Detail View ──────────────────────────────────────────────

  const renderDetailView = () => {
    if (!selectedReport) return null;
    const statusConf = STATUS_CONFIG[selectedReport.status];

    return (
      <View style={styles.container}>
        <View style={styles.formHeader}>
          <TouchableOpacity onPress={() => { setView('list'); setSelectedReport(null); }} style={styles.backButton}>
            <Text style={styles.backButtonText}>← Retour</Text>
          </TouchableOpacity>
          <Text style={styles.formTitle}>Détail du rapport</Text>
        </View>

        <ScrollView style={styles.formScroll} contentContainerStyle={styles.formContent}>
          {/* Status badge */}
          <View style={styles.detailStatusRow}>
            <View style={[styles.detailStatusBadge, { backgroundColor: statusConf.color }]}>
              <Text style={[styles.detailStatusText, { color: statusConf.textColor }]}>
                {statusConf.label}
              </Text>
            </View>
            <Text style={styles.detailId}>{selectedReport.id}</Text>
          </View>

          {/* Info cards */}
          <View style={styles.detailCard}>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Date et heure</Text>
              <Text style={styles.detailValue}>{formatDateTime(selectedReport.createdAt)}</Text>
            </View>
            <View style={styles.detailDivider} />
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Lieu</Text>
              <Text style={styles.detailValue}>{selectedReport.location}</Text>
            </View>
            <View style={styles.detailDivider} />
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>Créé par</Text>
              <Text style={styles.detailValue}>{selectedReport.createdByName}</Text>
            </View>
          </View>

          {/* GPS round map + checkpoints */}
          {selectedReport.checkpoints && selectedReport.checkpoints.length > 0 && (
            <>
              <Text style={styles.detailSectionTitle}>
                Ronde GPS {selectedReport.roundStatus === 'interrupted' ? '(interrompue)' : ''}
              </Text>
              {selectedReport.interruptReason && (
                <View style={[styles.detailCard, { marginBottom: 10 }]}>
                  <Text style={styles.detailLabel}>Motif de l&apos;interruption</Text>
                  <Text style={styles.detailNotes}>{selectedReport.interruptReason}</Text>
                </View>
              )}
              {selectedReport.trail && selectedReport.trail.length > 0 && (
                <View style={styles.roundMapContainer}>
                  <NativeMapView
                    style={{ flex: 1 }}
                    initialRegion={{
                      latitude: selectedReport.trail[0].latitude,
                      longitude: selectedReport.trail[0].longitude,
                      latitudeDelta: 0.01,
                      longitudeDelta: 0.01,
                    }}
                  >
                    <Polyline
                      coordinates={selectedReport.trail.map(p => ({ latitude: p.latitude, longitude: p.longitude }))}
                      strokeColor="#1e3a5f"
                      strokeWidth={3}
                    />
                    {(selectedReport.checkpoints || []).map(cp => (
                      <Circle
                        key={`cp-circle-${cp.checkpointId}`}
                        center={{ latitude: cp.latitude, longitude: cp.longitude }}
                        radius={cp.radiusMeters}
                        strokeColor={cp.dwellMet ? '#22c55e' : '#ef4444'}
                        fillColor={cp.dwellMet ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.15)'}
                        strokeWidth={2}
                      />
                    ))}
                    {(selectedReport.checkpoints || []).map(cp => (
                      <Marker key={`cp-marker-${cp.checkpointId}`} coordinate={{ latitude: cp.latitude, longitude: cp.longitude }}>
                        <View style={[styles.roundMapPin, cp.dwellMet ? styles.roundMapPinDone : styles.roundMapPinMissed]}>
                          <Text style={{ fontSize: 11 }}>{cp.dwellMet ? '✓' : '✕'}</Text>
                        </View>
                      </Marker>
                    ))}
                  </NativeMapView>
                </View>
              )}
              <View style={styles.detailCard}>
                {selectedReport.checkpoints.map((cp, idx) => (
                  <View key={cp.checkpointId}>
                    {idx > 0 && <View style={styles.detailDivider} />}
                    <View style={styles.detailRow}>
                      <Text style={styles.detailLabel}>{cp.name}</Text>
                      <View style={[
                        styles.taskResultBadge,
                        cp.dwellMet ? styles.taskResultOk : styles.taskResultPasOk,
                      ]}>
                        <Text style={[
                          styles.taskResultText,
                          cp.dwellMet ? styles.taskResultTextOk : styles.taskResultTextPasOk,
                        ]}>
                          {cp.dwellMet ? '✓ Validé' : cp.visited ? 'Temps insuffisant' : 'Manqué'}
                        </Text>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}

          {/* Tasks */}
          {selectedReport.tasks.length > 0 && (
          <>
          <Text style={styles.detailSectionTitle}>Tâches</Text>
          <View style={styles.detailCard}>
            {selectedReport.tasks.map((task, idx) => (
              <View key={task.name}>
                {idx > 0 && <View style={styles.detailDivider} />}
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>{task.label}</Text>
                  <View style={[
                    styles.taskResultBadge,
                    task.result === 'ok' ? styles.taskResultOk : styles.taskResultPasOk,
                  ]}>
                    <Text style={[
                      styles.taskResultText,
                      task.result === 'ok' ? styles.taskResultTextOk : styles.taskResultTextPasOk,
                    ]}>
                      {task.result === 'ok' ? 'OK' : 'PAS OK'}
                    </Text>
                  </View>
                </View>
                {task.comment && (
                  <Text style={styles.taskComment}>{task.comment}</Text>
                )}
              </View>
            ))}
          </View>
          </>
          )}

          {/* Media Attachments */}
          {selectedReport.media && selectedReport.media.length > 0 && (
            <>
              <Text style={styles.detailSectionTitle}>Pièces jointes ({selectedReport.media.length})</Text>
              <View style={styles.detailMediaGrid}>
                {selectedReport.media.map((media) => (
                  <View key={media.id} style={styles.detailMediaItem}>
                    {media.type === 'photo' ? (
                      <TouchableOpacity
                        onPress={() => setShowMediaPreview(`${getApiBaseUrl()}${media.url}`)}
                        activeOpacity={0.8}
                      >
                        <Image
                          source={{ uri: `${getApiBaseUrl()}${media.url}` }}
                          style={styles.detailMediaImage}
                        />
                      </TouchableOpacity>
                    ) : (
                      <View style={styles.detailMediaVideo}>
                        <Text style={styles.detailMediaVideoIcon}>🎬</Text>
                        <Text style={styles.detailMediaVideoLabel} numberOfLines={1}>{media.filename}</Text>
                      </View>
                    )}
                    <Text style={styles.detailMediaTime}>
                      {formatDateTime(media.uploadedAt)}
                    </Text>
                  </View>
                ))}
              </View>
            </>
          )}

          {/* Notes */}
          {selectedReport.notes && (
            <>
              <Text style={styles.detailSectionTitle}>Notes</Text>
              <View style={styles.detailCard}>
                <Text style={styles.detailNotes}>{selectedReport.notes}</Text>
              </View>
            </>
          )}

          <View style={{ height: 40 }} />
        </ScrollView>

        {/* Media Preview Modal */}
        <Modal visible={!!showMediaPreview} transparent animationType="fade">
          <TouchableOpacity
            style={styles.previewOverlay}
            activeOpacity={1}
            onPress={() => setShowMediaPreview(null)}
          >
            {showMediaPreview && (
              <Image
                source={{ uri: showMediaPreview }}
                style={styles.previewImage}
                resizeMode="contain"
              />
            )}
            <TouchableOpacity
              style={styles.previewCloseButton}
              onPress={() => setShowMediaPreview(null)}
            >
              <Text style={styles.previewCloseText}>✕ Fermer</Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </Modal>
      </View>
    );
  };

  // ─── Render: Active GPS Round ──────────────────────────────────────────

  const renderRoundView = () => {
    if (!myActiveRound) return null;
    const visitedCount = myActiveRound.checkpoints.filter(cp => cp.dwellMet).length;
    const totalCount = myActiveRound.checkpoints.length;
    const firstCp = myActiveRound.checkpoints[0];

    return (
      <View style={styles.container}>
        <View style={styles.formHeader}>
          <Text style={styles.formTitle} numberOfLines={1}>📍 {myActiveRound.siteName}</Text>
        </View>
        <Text style={styles.roundProgressText}>
          {totalCount > 0 ? `${visitedCount} / ${totalCount} checkpoints validés` : 'Aucun checkpoint configuré pour ce site'}
        </Text>

        <View style={styles.roundMapContainer}>
          <NativeMapView
            style={{ flex: 1 }}
            showsUserLocation
            initialRegion={{
              latitude: firstCp?.latitude ?? myActiveRound.lastLocation?.latitude ?? 46.2125,
              longitude: firstCp?.longitude ?? myActiveRound.lastLocation?.longitude ?? 6.1795,
              latitudeDelta: 0.01,
              longitudeDelta: 0.01,
            }}
          >
            {myActiveRound.checkpoints.map(cp => (
              <Circle
                key={`cp-circle-${cp.checkpointId}`}
                center={{ latitude: cp.latitude, longitude: cp.longitude }}
                radius={cp.radiusMeters}
                strokeColor={cp.dwellMet ? '#22c55e' : '#3b82f6'}
                fillColor={cp.dwellMet ? 'rgba(34,197,94,0.2)' : 'rgba(59,130,246,0.15)'}
                strokeWidth={2}
              />
            ))}
            {myActiveRound.checkpoints.map(cp => (
              <Marker key={`cp-marker-${cp.checkpointId}`} coordinate={{ latitude: cp.latitude, longitude: cp.longitude }}>
                <View style={[styles.roundMapPin, cp.dwellMet && styles.roundMapPinDone]}>
                  <Text style={{ fontSize: 11 }}>{cp.dwellMet ? '✓' : '📍'}</Text>
                </View>
              </Marker>
            ))}
            {myActiveRound.trail.length > 1 && (
              <Polyline
                coordinates={myActiveRound.trail.map(p => ({ latitude: p.latitude, longitude: p.longitude }))}
                strokeColor="#1e3a5f"
                strokeWidth={3}
              />
            )}
          </NativeMapView>
        </View>

        <ScrollView style={styles.roundChecklistScroll} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8 }}>
          {myActiveRound.checkpoints.map(cp => (
            <View key={cp.checkpointId} style={styles.roundChecklistItem}>
              <Text style={styles.roundChecklistIcon}>{cp.dwellMet ? '✅' : cp.visited ? '🟡' : '⚪'}</Text>
              <Text style={styles.roundChecklistName}>{cp.name}</Text>
            </View>
          ))}
        </ScrollView>

        <View style={styles.roundActionsRow}>
          <TouchableOpacity
            style={styles.roundInterruptBtn}
            onPress={() => setShowInterruptConfirm(true)}
            disabled={roundFinishing}
          >
            <Text style={styles.roundInterruptBtnText}>🚨 Interrompre</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.roundFinishBtn}
            onPress={openRoundFinishForm}
          >
            <Text style={styles.roundFinishBtnText}>Terminer la ronde</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.roundSosContainer}>
          <SOSButton userName={user?.name || 'Unknown'} userRole={user?.role || 'user'} userId={user?.id || ''} />
        </View>

        {/* Interrupt confirmation modal */}
        <Modal visible={showInterruptConfirm} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={[styles.modalContent, { padding: 20 }]}>
              <Text style={styles.modalTitle}>Interrompre la ronde ?</Text>
              <Text style={[styles.detailNotes, { marginTop: 8, marginBottom: 12 }]}>
                La ronde sera terminée immédiatement et un rapport partiel sera généré et transmis au dispatch.
              </Text>
              <TextInput
                style={styles.notesInput}
                placeholder="Motif (optionnel)"
                placeholderTextColor="#9ca3af"
                value={interruptReason}
                onChangeText={setInterruptReason}
                multiline
              />
              <View style={styles.roundActionsRow}>
                <TouchableOpacity
                  style={styles.roundModalCancelBtn}
                  onPress={() => setShowInterruptConfirm(false)}
                  disabled={roundFinishing}
                >
                  <Text style={styles.roundModalCancelBtnText}>Annuler</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.roundInterruptBtn, roundFinishing && styles.submitButtonDisabled]}
                  onPress={handleInterruptRound}
                  disabled={roundFinishing}
                >
                  {roundFinishing ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.roundInterruptBtnText}>Confirmer</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  };

  const renderRoutePreview = () => {
    if (!routePlan) return null;
    const dest = routePlan.geometry[routePlan.geometry.length - 1];
    const km = (routePlan.distanceMeters / 1000).toFixed(1);
    const mins = Math.round(routePlan.durationSeconds / 60);

    return (
      <View style={styles.container}>
        <View style={styles.formHeader}>
          <TouchableOpacity style={styles.backButton} onPress={() => { setRoutePlan(null); setView('detail'); }}>
            <Text style={styles.backButtonText}>← Retour</Text>
          </TouchableOpacity>
          <Text style={styles.formTitle} numberOfLines={1}>🧭 Vers {routePlan.toSiteName}</Text>
        </View>

        <View style={styles.roundMapContainer}>
          <NativeMapView
            style={{ flex: 1 }}
            initialRegion={{
              latitude: routeOrigin?.latitude ?? dest.latitude,
              longitude: routeOrigin?.longitude ?? dest.longitude,
              latitudeDelta: 0.03,
              longitudeDelta: 0.03,
            }}
          >
            <Polyline coordinates={routePlan.geometry} strokeColor="#2563eb" strokeWidth={4} />
            {routeOrigin && (
              <Marker coordinate={routeOrigin}>
                <View style={styles.roundMapPin}><Text style={{ fontSize: 11 }}>🚩</Text></View>
              </Marker>
            )}
            <Marker coordinate={dest}>
              <View style={[styles.roundMapPin, styles.roundMapPinDone]}><Text style={{ fontSize: 11 }}>🏁</Text></View>
            </Marker>
          </NativeMapView>
        </View>

        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <Text style={styles.routeEtaText}>
            {km} km · ~{mins} min · {routePlan.mode === 'walking' ? 'à pied' : 'en véhicule'}
          </Text>
          <Text style={styles.routeRationaleText}>{routePlan.rationale}</Text>

          <View style={styles.routeModeToggleRow}>
            <TouchableOpacity
              style={[styles.routeModeBtn, routePlan.mode === 'driving' && styles.routeModeBtnActive]}
              onPress={() => selectedNextSite && planRoute(selectedNextSite, 'driving')}
              disabled={routePlanning}
            >
              <Text style={[styles.routeModeBtnText, routePlan.mode === 'driving' && styles.routeModeBtnTextActive]}>🚗 En véhicule</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.routeModeBtn, routePlan.mode === 'walking' && styles.routeModeBtnActive]}
              onPress={() => selectedNextSite && planRoute(selectedNextSite, 'walking')}
              disabled={routePlanning}
            >
              <Text style={[styles.routeModeBtnText, routePlan.mode === 'walking' && styles.routeModeBtnTextActive]}>🚶 À pied</Text>
            </TouchableOpacity>
          </View>
        </View>

        {routePlanning && <ActivityIndicator size="large" color="#1e3a5f" style={{ padding: 20 }} />}

        {/* roundFinishBtn has flex:1, designed to share a flexDirection:'row'
            container with a sibling button (see renderRoundView) — without
            that row wrapper it stretches to fill the remaining column
            height instead of sizing to its content, pushing the label off
            screen. */}
        <View style={[styles.roundActionsRow, { paddingBottom: 16 }]}>
          <TouchableOpacity
            style={[styles.roundFinishBtn, (routeConfirming || routePlanning) && styles.submitButtonDisabled]}
            onPress={handleConfirmAndNavigate}
            disabled={routeConfirming || routePlanning}
          >
            {routeConfirming ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.roundFinishBtnText}>Démarrer la navigation</Text>}
          </TouchableOpacity>
        </View>
      </View>
    );
  };

  // ─── Access Control ───────────────────────────────────────────────────

  const canAccess = isStaffRole(user?.role);

  if (!canAccess) {
    return (
      <TalionScreen>
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🔒</Text>
          <Text style={styles.emptyText}>Accès restreint</Text>
          <Text style={styles.emptySubtext}>Les rapports de ronde sont réservés aux intervenants, dispatchers et admins.</Text>
        </View>
      </TalionScreen>
    );
  }

  // ─── Main Render ──────────────────────────────────────────────────────

  return (
    <TalionScreen>
      {view === 'list' && renderListView()}
      {view === 'create' && renderCreateView()}
      {view === 'detail' && renderDetailView()}
      {view === 'round' && renderRoundView()}
      {view === 'routePreview' && renderRoutePreview()}

      {/* Next Location Picker Modal — after finishing a round, offer a
          variety/safety-scored route to wherever the responder heads next */}
      <Modal visible={showNextLocationPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Prochain lieu ?</Text>
              <TouchableOpacity onPress={() => setShowNextLocationPicker(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {routePlanning ? (
              <ActivityIndicator size="large" color="#1e3a5f" style={{ padding: 40 }} />
            ) : (
              <FlatList
                data={siteObjects.filter(s => s.id !== finishedSiteId)}
                keyExtractor={item => item.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.siteOption}
                    onPress={() => planRoute(item, routeMode)}
                  >
                    <Text style={styles.siteOptionText}>{item.name}</Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <Text style={[styles.emptySubtext, { padding: 20, textAlign: 'center' }]}>
                    Aucun autre site disponible.
                  </Text>
                }
                contentContainerStyle={styles.siteList}
              />
            )}
            <View style={{ paddingHorizontal: 16, paddingBottom: 16 }}>
              <TouchableOpacity style={styles.roundModalCancelBtn} onPress={() => setShowNextLocationPicker(false)}>
                <Text style={styles.roundModalCancelBtnText}>Terminer sans naviguer</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Round Site Picker Modal — pick a site to start a GPS-tracked round */}
      <Modal visible={showRoundSitePicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Démarrer une ronde</Text>
              <TouchableOpacity onPress={() => setShowRoundSitePicker(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {roundStarting ? (
              <ActivityIndicator size="large" color="#1e3a5f" style={{ padding: 40 }} />
            ) : (
              <FlatList
                data={siteObjects}
                keyExtractor={item => item.id}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.siteOption}
                    onPress={() => handleStartRound(item)}
                  >
                    <Text style={styles.siteOptionText}>{item.name}</Text>
                  </TouchableOpacity>
                )}
                ListEmptyComponent={
                  <Text style={[styles.emptySubtext, { padding: 20, textAlign: 'center' }]}>
                    Aucun site de patrouille configuré.
                  </Text>
                }
                contentContainerStyle={styles.siteList}
              />
            )}
          </View>
        </View>
      </Modal>

      {/* Blackbook Modal — suspicious persons registry */}
      <Modal visible={showBlackbookModal} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowBlackbookModal(false)}>
        <View style={styles.bbModalContainer}>
          <View style={styles.bbModalHeader}>
            {blackbookView === 'form' ? (
              <TouchableOpacity onPress={() => setBlackbookView('list')}><Text style={styles.bbBackText}>← Retour</Text></TouchableOpacity>
            ) : (
              <Text style={styles.bbModalTitle}>🕵️ Blackbook</Text>
            )}
            <TouchableOpacity onPress={() => setShowBlackbookModal(false)}><Text style={styles.bbCloseText}>Fermer</Text></TouchableOpacity>
          </View>

          {blackbookView === 'list' ? (
            <View style={{ flex: 1 }}>
              <TextInput
                style={styles.bbSearchInput}
                placeholder="🔍 Nom, alias, plaque, lieu, notes..."
                placeholderTextColor="#9ca3af"
                value={blackbookSearch}
                onChangeText={setBlackbookSearch}
              />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 44, marginBottom: 8 }}>
                {[{ key: '', label: 'Tous' }, { key: 'critical', label: '🔴 Critique' }, { key: 'high', label: '🟠 Élevé' }, { key: 'medium', label: '🟡 Moyen' }, { key: 'low', label: '🟢 Faible' }].map(r => (
                  <TouchableOpacity
                    key={r.key}
                    style={[styles.bbFilterChip, blackbookRiskFilter === r.key && styles.bbFilterChipActive]}
                    onPress={() => setBlackbookRiskFilter(r.key)}
                  >
                    <Text style={[styles.bbFilterChipText, blackbookRiskFilter === r.key && styles.bbFilterChipTextActive]}>{r.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {blackbookLoading ? (
                <ActivityIndicator size="large" color="#1e3a5f" style={{ marginTop: 24 }} />
              ) : (
                <ScrollView showsVerticalScrollIndicator={false}>
                  {filteredBlackbook.length === 0 ? (
                    <Text style={{ textAlign: 'center', color: '#9ca3af', marginTop: 24 }}>Aucune fiche trouvée</Text>
                  ) : (
                    filteredBlackbook.map((e: any) => {
                      const last = blackbookLastSighting(e);
                      return (
                        <TouchableOpacity key={e.id} style={styles.bbCard} onPress={() => openBlackbookForm(e)}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                            <Text style={styles.bbCardName}>{e.firstName} {e.lastName}</Text>
                            <Text style={{ fontSize: 12 }}>{BLACKBOOK_RISK_LABELS[e.riskLevel] || e.riskLevel}</Text>
                          </View>
                          {(e.aliases || []).length > 0 && <Text style={styles.bbCardDetail}>Alias: {e.aliases.join(', ')}</Text>}
                          {last && (
                            <Text style={styles.bbCardDetail}>
                              Dernier signalement: {new Date(last.timestamp).toLocaleDateString('fr-FR')} — {BLACKBOOK_CATEGORY_LABELS[last.category] || last.category}
                              {last.location?.address ? ` · ${last.location.address}` : ''}
                            </Text>
                          )}
                          <Text style={styles.bbCardMeta}>{BLACKBOOK_STATUS_LABELS[e.status] || e.status}</Text>
                        </TouchableOpacity>
                      );
                    })
                  )}
                </ScrollView>
              )}

              <TouchableOpacity style={styles.bbFab} onPress={() => openBlackbookForm(null)}>
                <Text style={styles.bbFabText}>+ Nouvelle fiche</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
              <View style={styles.bbLinkBox}>
                <Text style={styles.bbLinkBoxLabel}>🔗 Associé à (famille / utilisateur)</Text>
                {bbLinkedUserId ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: '#92400e' }}>
                      {(allUsersCache || []).find((u: any) => u.id === bbLinkedUserId)?.name || bbLinkedUserId}
                    </Text>
                    <TouchableOpacity onPress={() => setBbLinkedUserId(null)}><Text style={{ color: '#92400e' }}>✕ Retirer</Text></TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <TextInput
                      style={[styles.bbInput, { backgroundColor: '#fff' }]}
                      placeholder="Rechercher un nom..."
                      placeholderTextColor="#9ca3af"
                      value={bbUserSearch}
                      onChangeText={setBbUserSearch}
                    />
                    {bbUserSearch.trim().length > 0 && (
                      <View style={{ maxHeight: 150, marginTop: 6 }}>
                        <ScrollView nestedScrollEnabled>
                          {(allUsersCache || [])
                            .filter((u: any) => u.name.toLowerCase().includes(bbUserSearch.trim().toLowerCase()))
                            .slice(0, 8)
                            .map((u: any) => (
                              <TouchableOpacity key={u.id} style={styles.bbPickerRow} onPress={() => { setBbLinkedUserId(u.id); setBbUserSearch(''); }}>
                                <Text style={{ fontSize: 13, color: '#1f2937' }}>{u.name}</Text>
                              </TouchableOpacity>
                            ))}
                        </ScrollView>
                      </View>
                    )}
                  </>
                )}
              </View>

              <View style={{ flexDirection: 'row', gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bbLabel}>Prénom</Text>
                  <TextInput style={styles.bbInput} value={bbFirstName} onChangeText={setBbFirstName} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.bbLabel}>Nom</Text>
                  <TextInput style={styles.bbInput} value={bbLastName} onChangeText={setBbLastName} />
                </View>
              </View>
              <Text style={styles.bbLabel}>Alias (séparés par des virgules)</Text>
              <TextInput style={styles.bbInput} value={bbAliases} onChangeText={setBbAliases} />
              <Text style={styles.bbLabel}>Date de naissance (JJ/MM/AAAA)</Text>
              <TextInput style={styles.bbInput} value={bbDateOfBirth} onChangeText={setBbDateOfBirth} placeholder="JJ/MM/AAAA" placeholderTextColor="#9ca3af" />

              <Text style={styles.bbLabel}>Niveau de risque</Text>
              <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                {(['low', 'medium', 'high', 'critical'] as const).map(r => (
                  <TouchableOpacity key={r} style={[styles.bbFilterChip, bbRiskLevel === r && styles.bbFilterChipActive]} onPress={() => setBbRiskLevel(r)}>
                    <Text style={[styles.bbFilterChipText, bbRiskLevel === r && styles.bbFilterChipTextActive]}>{BLACKBOOK_RISK_LABELS[r]}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {currentBlackbookEntry && (
                <>
                  <Text style={styles.bbLabel}>Statut</Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginBottom: 8 }}>
                    {(['active', 'resolved', 'archived'] as const).map(s => (
                      <TouchableOpacity key={s} style={[styles.bbFilterChip, bbStatus === s && styles.bbFilterChipActive]} onPress={() => setBbStatus(s)}>
                        <Text style={[styles.bbFilterChipText, bbStatus === s && styles.bbFilterChipTextActive]}>{BLACKBOOK_STATUS_LABELS[s]}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}

              <Text style={styles.bbLabel}>Description physique</Text>
              <TextInput style={[styles.bbInput, { minHeight: 60 }]} value={bbPhysicalDescription} onChangeText={setBbPhysicalDescription} multiline placeholder="Taille, corpulence, signes distinctifs, tenue..." placeholderTextColor="#9ca3af" />
              <Text style={styles.bbLabel}>Tags (séparés par des virgules)</Text>
              <TextInput style={styles.bbInput} value={bbTags} onChangeText={setBbTags} placeholder="Ex: véhicule volé, vu près école" placeholderTextColor="#9ca3af" />

              <Text style={styles.bbLabel}>Véhicule — plaque</Text>
              <TextInput style={styles.bbInput} value={bbVehiclePlate} onChangeText={setBbVehiclePlate} />
              <Text style={styles.bbLabel}>Véhicule — description</Text>
              <TextInput style={styles.bbInput} value={bbVehicleDescription} onChangeText={setBbVehicleDescription} placeholder="Marque, modèle, couleur" placeholderTextColor="#9ca3af" />

              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <Text style={styles.bbLabel}>Notes libres</Text>
                <TouchableOpacity style={styles.analyzeBtn} onPress={() => analyzeNotes(bbNotes)} disabled={entityAnalyzing}>
                  {entityAnalyzing ? <ActivityIndicator size="small" color="#1e3a5f" /> : <Text style={styles.analyzeBtnText}>🔎 Analyser</Text>}
                </TouchableOpacity>
              </View>
              <TextInput style={[styles.bbInput, { minHeight: 70 }]} value={bbNotes} onChangeText={setBbNotes} multiline />
              {entityCandidates.length > 0 && (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6, marginBottom: 8 }}>
                  {entityCandidates.map((c, i) => (
                    <TouchableOpacity key={i} style={styles.entityChip} onPress={() => applyEntityCandidate(c)}>
                      <Text style={styles.entityChipText}>{c.type === 'plate' ? '🚗' : c.type === 'name' ? '🧑' : '📍'} {c.value}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <TouchableOpacity style={[styles.bbSaveBtn, bbSaving && { opacity: 0.6 }]} onPress={saveBlackbookEntry} disabled={bbSaving}>
                {bbSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.bbSaveBtnText}>💾 Enregistrer</Text>}
              </TouchableOpacity>

              {currentBlackbookEntry && (
                <>
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                    <TouchableOpacity style={[styles.bbSecondaryBtn, { flex: 1 }]} onPress={exportBlackbookPdf}>
                      <Text style={styles.bbSecondaryBtnText}>📄 Export PDF</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={[styles.bbSecondaryBtn, { flex: 1, backgroundColor: '#fef2f2' }]} onPress={deleteBlackbookEntry}>
                      <Text style={[styles.bbSecondaryBtnText, { color: '#dc2626' }]}>🗑️ Supprimer</Text>
                    </TouchableOpacity>
                  </View>

                  <Text style={[styles.bbSectionTitle, { marginTop: 20 }]}>Photos</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                    {(currentBlackbookEntry.photos || []).map((url: string) => (
                      <TouchableOpacity key={url} onLongPress={() => deleteBlackbookPhoto(url)} style={{ marginRight: 8 }}>
                        <Image source={{ uri: `${getApiBaseUrl()}${url}` }} style={{ width: 80, height: 80, borderRadius: 8 }} />
                      </TouchableOpacity>
                    ))}
                    <TouchableOpacity style={styles.bbAddPhotoBtn} onPress={pickAndUploadBlackbookPhoto} disabled={photoUploading}>
                      {photoUploading ? <ActivityIndicator color="#1e3a5f" /> : <Text style={{ fontSize: 24 }}>📷</Text>}
                    </TouchableOpacity>
                  </ScrollView>
                  {(currentBlackbookEntry.photos || []).length > 0 && <Text style={styles.bbHint}>Appui long pour supprimer une photo</Text>}
                  {!!plateAnalysisNote && <Text style={[styles.bbHint, { marginTop: 2 }]}>{plateAnalysisNote}</Text>}

                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, marginBottom: 8 }}>
                    <Text style={styles.bbSectionTitle}>Signalements</Text>
                    <TouchableOpacity onPress={() => setShowAddSightingForm(v => !v)}>
                      <Text style={{ color: '#1e3a5f', fontWeight: '600' }}>{showAddSightingForm ? 'Annuler' : '+ Ajouter'}</Text>
                    </TouchableOpacity>
                  </View>

                  {showAddSightingForm && (
                    <View style={styles.bbFormCard}>
                      <Text style={styles.bbLabel}>Type de problème</Text>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
                        {(['prise_info', 'intrusion', 'menaces', 'envoi_courrier', 'reperage', 'autre'] as const).map(c => (
                          <TouchableOpacity key={c} style={[styles.bbFilterChip, sightingCategory === c && styles.bbFilterChipActive]} onPress={() => setSightingCategory(c)}>
                            <Text style={[styles.bbFilterChipText, sightingCategory === c && styles.bbFilterChipTextActive]}>{BLACKBOOK_CATEGORY_LABELS[c]}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                      <Text style={styles.bbLabel}>🏠 Résidence enregistrée (recommandé)</Text>
                      {sightingResidenceId ? (
                        <View style={[styles.bbLinkBox, { marginTop: 0 }]}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                            <Text style={{ fontSize: 13, fontWeight: '700', color: '#92400e', flex: 1 }}>
                              {(() => {
                                const r = (allResidencesCache || []).find((x: any) => x.id === sightingResidenceId);
                                return r ? `${r.userName} — ${r.label}` : sightingResidenceId;
                              })()}
                            </Text>
                            <TouchableOpacity onPress={() => setSightingResidenceId(null)}><Text style={{ color: '#92400e' }}>✕</Text></TouchableOpacity>
                          </View>
                        </View>
                      ) : (
                        <>
                          <TextInput
                            style={styles.bbInput}
                            placeholder="Rechercher une résidence (nom ou famille)..."
                            placeholderTextColor="#9ca3af"
                            value={sightingResidenceSearch}
                            onChangeText={setSightingResidenceSearch}
                          />
                          {sightingResidenceSearch.trim().length > 0 && (
                            <View style={{ maxHeight: 150, marginTop: 6 }}>
                              <ScrollView nestedScrollEnabled>
                                {(allResidencesCache || [])
                                  .filter((r: any) => `${r.userName} ${r.label} ${r.address}`.toLowerCase().includes(sightingResidenceSearch.trim().toLowerCase()))
                                  .slice(0, 8)
                                  .map((r: any) => (
                                    <TouchableOpacity
                                      key={r.id}
                                      style={styles.bbPickerRow}
                                      onPress={() => { setSightingResidenceId(r.id); setSightingResidenceSearch(''); setSightingLocation(r.address); }}
                                    >
                                      <Text style={{ fontSize: 13, color: '#1f2937' }}>{r.userName} — {r.label}</Text>
                                    </TouchableOpacity>
                                  ))}
                              </ScrollView>
                            </View>
                          )}
                        </>
                      )}
                      <Text style={styles.bbLabel}>Lieu {sightingResidenceId ? '(auto-rempli)' : '(libre)'}</Text>
                      <TextInput style={styles.bbInput} value={sightingLocation} onChangeText={setSightingLocation} placeholder="Adresse ou description du lieu" placeholderTextColor="#9ca3af" editable={!sightingResidenceId} />
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Text style={styles.bbLabel}>Notes</Text>
                        <TouchableOpacity style={styles.analyzeBtn} onPress={() => analyzeNotes(sightingNotes)} disabled={entityAnalyzing}>
                          {entityAnalyzing ? <ActivityIndicator size="small" color="#1e3a5f" /> : <Text style={styles.analyzeBtnText}>🔎 Analyser</Text>}
                        </TouchableOpacity>
                      </View>
                      <TextInput style={[styles.bbInput, { minHeight: 50 }]} value={sightingNotes} onChangeText={setSightingNotes} multiline />
                      {entityCandidates.length > 0 && (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6, marginBottom: 8 }}>
                          {entityCandidates.map((c, i) => (
                            <TouchableOpacity key={i} style={styles.entityChip} onPress={() => applyEntityCandidate(c)}>
                              <Text style={styles.entityChipText}>{c.type === 'plate' ? '🚗' : c.type === 'name' ? '🧑' : '📍'} {c.value}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      )}
                      <TouchableOpacity style={[styles.bbSaveBtn, sightingSaving && { opacity: 0.6 }]} onPress={saveSighting} disabled={sightingSaving}>
                        {sightingSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.bbSaveBtnText}>Enregistrer le signalement</Text>}
                      </TouchableOpacity>
                    </View>
                  )}

                  {(currentBlackbookEntry.sightings || []).length === 0 ? (
                    <Text style={{ color: '#9ca3af', fontSize: 12 }}>Aucun signalement enregistré</Text>
                  ) : (
                    [...currentBlackbookEntry.sightings].sort((a: any, b: any) => b.timestamp - a.timestamp).map((s: any) => (
                      <View key={s.id} style={styles.bbSightingRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.bbCardName}>{new Date(s.timestamp).toLocaleString('fr-FR')} — {BLACKBOOK_CATEGORY_LABELS[s.category] || s.category}</Text>
                          {s.residenceId ? (
                            <Text style={[styles.bbCardDetail, { fontWeight: '700', color: '#92400e' }]}>🏠 {s.residenceLabel} — Famille : {s.residenceOwnerName}</Text>
                          ) : (
                            !!s.location?.address && <Text style={styles.bbCardDetail}>📍 {s.location.address}</Text>
                          )}
                          {!!s.notes && <Text style={styles.bbCardDetail}>{s.notes}</Text>}
                          <Text style={styles.bbCardMeta}>Signalé par {s.reportedByName}</Text>
                        </View>
                        <TouchableOpacity onPress={() => deleteSighting(s.id)}><Text style={{ color: '#dc2626' }}>🗑️</Text></TouchableOpacity>
                      </View>
                    ))
                  )}

                  {relatedBlackbook.length > 0 && (
                    <>
                      <Text style={[styles.bbSectionTitle, { marginTop: 16 }]}>Fiches liées (plaque/nom communs)</Text>
                      {relatedBlackbook.map((r: any) => (
                        <TouchableOpacity
                          key={r.entryId}
                          style={styles.bbSightingRow}
                          onPress={() => openRelatedBlackbookEntry(r.entryId)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.bbCardName}>{BLACKBOOK_RISK_LABELS[r.riskLevel] || r.riskLevel} {r.name}</Text>
                            <Text style={styles.bbCardMeta}>Correspondance : {r.matchType} — {r.matchValue}</Text>
                          </View>
                        </TouchableOpacity>
                      ))}
                    </>
                  )}
                </>
              )}
            </ScrollView>
          )}
        </View>
      </Modal>
    </TalionScreen>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  blackbookBar: {
    backgroundColor: '#374151', marginHorizontal: 16, marginTop: 12, marginBottom: 4,
    borderRadius: 10, paddingVertical: 12, alignItems: 'center',
  },
  blackbookBarText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  bbModalContainer: { flex: 1, backgroundColor: '#fff' },
  bbModalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  bbModalTitle: { fontSize: 17, fontWeight: '700', color: '#1f2937' },
  bbBackText: { fontSize: 15, color: '#1e3a5f', fontWeight: '600' },
  bbCloseText: { fontSize: 15, color: '#6b7280' },
  bbSearchInput: {
    backgroundColor: '#f3f4f6', borderRadius: 8, marginHorizontal: 16, marginTop: 12, marginBottom: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
  },
  bbFilterChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#f3f4f6', marginLeft: 16, marginRight: 0 },
  bbFilterChipActive: { backgroundColor: '#1e3a5f' },
  bbFilterChipText: { fontSize: 12, fontWeight: '600', color: '#374151' },
  bbFilterChipTextActive: { color: '#fff' },
  bbCard: {
    backgroundColor: '#f9fafb', borderRadius: 10, padding: 12, marginHorizontal: 16, marginBottom: 8,
    borderWidth: 1, borderColor: '#e5e7eb',
  },
  bbCardName: { fontSize: 14, fontWeight: '700', color: '#1f2937' },
  bbCardDetail: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  bbCardMeta: { fontSize: 11, color: '#9ca3af', marginTop: 2, fontStyle: 'italic' },
  bbFab: {
    position: 'absolute', bottom: 16, left: 16, right: 16, backgroundColor: '#1e3a5f',
    borderRadius: 14, paddingVertical: 16, alignItems: 'center',
  },
  bbFabText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  bbLabel: { fontSize: 12, fontWeight: '600', color: '#374151', marginBottom: 4, marginTop: 8 },
  bbInput: {
    backgroundColor: '#f9fafb', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, color: '#1f2937',
  },
  bbSaveBtn: { backgroundColor: '#1e3a5f', borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  bbSaveBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  bbSecondaryBtn: { backgroundColor: '#f3f4f6', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  bbSecondaryBtnText: { color: '#374151', fontWeight: '600', fontSize: 13 },
  analyzeBtn: { backgroundColor: '#eff6ff', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  analyzeBtnText: { color: '#1e3a5f', fontWeight: '600', fontSize: 12 },
  entityChip: { backgroundColor: '#f3f4f6', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6 },
  entityChipText: { color: '#374151', fontSize: 12, fontWeight: '600' },
  bbSectionTitle: { fontSize: 13, fontWeight: '700', color: '#374151', textTransform: 'uppercase' },
  bbAddPhotoBtn: {
    width: 80, height: 80, borderRadius: 8, backgroundColor: '#f3f4f6', alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: '#e5e7eb', borderStyle: 'dashed',
  },
  bbHint: { fontSize: 11, color: '#9ca3af', marginBottom: 8 },
  bbFormCard: { backgroundColor: '#f9fafb', borderRadius: 10, padding: 12, marginBottom: 12 },
  bbSightingRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start',
    backgroundColor: '#f9fafb', borderRadius: 10, padding: 12, marginBottom: 8,
  },
  bbLinkBox: { backgroundColor: '#fef3c7', borderWidth: 1, borderColor: '#fcd34d', borderRadius: 8, padding: 10, marginBottom: 12, marginTop: 8 },
  bbLinkBoxLabel: { fontSize: 12, fontWeight: '700', color: '#92400e', marginBottom: 6 },
  bbPickerRow: { paddingVertical: 8, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', backgroundColor: '#fff' },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  emptyIcon: {
    fontSize: 48,
    marginBottom: 12,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#1e3a5f',
    marginBottom: 4,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
  },

  // ─── Filter Row ─────────────────────────────────────────────────────
  filterRow: {
    maxHeight: 52,
    paddingVertical: 8,
  },
  filterRowContent: {
    paddingHorizontal: 16,
    gap: 8,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: '#f3f4f6',
    gap: 6,
  },
  filterChipActive: {
    backgroundColor: '#1e3a5f',
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#374151',
  },
  filterChipTextActive: {
    color: '#ffffff',
  },
  filterDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },

  // ─── Report Card ────────────────────────────────────────────────────
  listContent: {
    padding: 16,
    gap: 12,
  },
  reportCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  reportCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  reportTime: {
    fontSize: 12,
    color: '#9ca3af',
  },
  reportLocation: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 8,
  },
  reportCardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  reportCardBadges: {
    flexDirection: 'row',
    gap: 6,
  },
  reportAuthor: {
    fontSize: 13,
    color: '#6b7280',
  },
  mediaBadge: {
    backgroundColor: '#eff6ff',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  mediaBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#2563eb',
  },
  warningBadge: {
    backgroundColor: '#fef2f2',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  warningBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ef4444',
  },

  // ─── FAB ────────────────────────────────────────────────────────────
  fab: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    backgroundColor: '#1e3a5f',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  roundFab: {
    position: 'absolute',
    bottom: 88,
    left: 16,
    right: 16,
    backgroundColor: '#059669',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 6,
  },
  fabText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },

  // ─── GPS Round ──────────────────────────────────────────────────────
  roundProgressText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4b5563',
    textAlign: 'center',
    paddingVertical: 8,
    backgroundColor: '#f9fafb',
  },
  roundMapContainer: {
    height: 280,
    marginHorizontal: 16,
    marginTop: 8,
    borderRadius: 12,
    overflow: 'hidden',
  },
  roundChecklistScroll: {
    flex: 1,
    marginTop: 8,
  },
  roundChecklistItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  roundChecklistIcon: {
    fontSize: 18,
  },
  roundChecklistName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    flex: 1,
  },
  roundActionsRow: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  roundInterruptBtn: {
    flex: 1,
    backgroundColor: '#ef4444',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  roundInterruptBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  roundFinishBtn: {
    flex: 1,
    backgroundColor: '#059669',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  roundFinishBtnText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '700',
  },
  roundModalCancelBtn: {
    flex: 1,
    backgroundColor: '#f3f4f6',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  roundModalCancelBtnText: {
    color: '#4b5563',
    fontSize: 14,
    fontWeight: '700',
  },
  roundSosContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: 'center',
  },
  roundMapPin: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#ffffff',
    borderWidth: 2,
    borderColor: '#3b82f6',
    justifyContent: 'center',
    alignItems: 'center',
  },
  roundMapPinDone: {
    borderColor: '#22c55e',
  },
  roundMapPinMissed: {
    borderColor: '#ef4444',
  },
  routeEtaText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f2937',
  },
  routeRationaleText: {
    fontSize: 13,
    color: '#4b5563',
    marginTop: 4,
    marginBottom: 12,
  },
  routeModeToggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 4,
  },
  routeModeBtn: {
    flex: 1,
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  routeModeBtnActive: {
    backgroundColor: '#1e3a5f',
  },
  routeModeBtnText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#4b5563',
  },
  routeModeBtnTextActive: {
    color: '#ffffff',
  },

  // ─── Form ──────────────────────────────────────────────────────────
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  backButton: {
    marginRight: 12,
  },
  backButtonText: {
    fontSize: 16,
    color: '#1e3a5f',
    fontWeight: '600',
  },
  formTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
  },
  formScroll: {
    flex: 1,
  },
  formContent: {
    padding: 16,
    gap: 20,
  },
  formSection: {
    gap: 8,
  },
  formLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  autoField: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  autoFieldText: {
    fontSize: 15,
    color: '#1f2937',
    fontWeight: '500',
  },
  autoFieldHint: {
    fontSize: 12,
    color: '#9ca3af',
    fontStyle: 'italic',
  },

  // ─── Dropdown ──────────────────────────────────────────────────────
  dropdownButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  dropdownButtonEmpty: {
    borderColor: '#e5e7eb',
  },
  dropdownText: {
    fontSize: 15,
    color: '#1f2937',
    flex: 1,
  },
  dropdownPlaceholder: {
    color: '#9ca3af',
  },
  dropdownArrow: {
    fontSize: 12,
    color: '#9ca3af',
    marginLeft: 8,
  },

  // ─── Status Grid ──────────────────────────────────────────────────
  statusGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  statusOption: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 2,
    minWidth: '30%',
    alignItems: 'center',
  },
  statusOptionText: {
    fontSize: 13,
    fontWeight: '700',
  },

  // ─── Tasks ────────────────────────────────────────────────────────
  taskRow: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 8,
  },
  taskLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1f2937',
  },
  taskToggle: {
    flexDirection: 'row',
    gap: 8,
  },
  taskButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 2,
  },
  taskButtonOk: {
    borderColor: '#22c55e',
    backgroundColor: '#f0fdf4',
  },
  taskButtonOkActive: {
    backgroundColor: '#22c55e',
  },
  taskButtonPasOk: {
    borderColor: '#ef4444',
    backgroundColor: '#fef2f2',
  },
  taskButtonPasOkActive: {
    backgroundColor: '#ef4444',
  },
  taskButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#6b7280',
  },
  taskButtonTextActive: {
    color: '#ffffff',
  },
  taskButtonPasOkTextActive: {
    color: '#ffffff',
  },
  autreInput: {
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    color: '#1f2937',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    minHeight: 60,
    textAlignVertical: 'top',
  },

  // ─── Media ────────────────────────────────────────────────────────
  mediaButtonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  mediaButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#f0f9ff',
    borderRadius: 10,
    paddingVertical: 14,
    borderWidth: 1.5,
    borderColor: '#bae6fd',
    borderStyle: 'dashed',
  },
  mediaButtonIcon: {
    fontSize: 20,
  },
  mediaButtonLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0369a1',
  },
  mediaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  mediaThumb: {
    width: 100,
    height: 100,
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  mediaThumbImage: {
    width: 100,
    height: 100,
  },
  mediaThumbVideo: {
    width: 100,
    height: 100,
    backgroundColor: '#1e293b',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
  },
  mediaThumbVideoIcon: {
    fontSize: 28,
    marginBottom: 4,
  },
  mediaThumbVideoLabel: {
    fontSize: 10,
    color: '#94a3b8',
    textAlign: 'center',
  },
  mediaRemoveButton: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.6)',
    width: 22,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    alignItems: 'center',
  },
  mediaRemoveText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: '700',
  },

  // ─── Notes ────────────────────────────────────────────────────────
  notesInput: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 14,
    fontSize: 14,
    color: '#1f2937',
    borderWidth: 1,
    borderColor: '#d1d5db',
    minHeight: 80,
    textAlignVertical: 'top',
  },

  // ─── Submit ───────────────────────────────────────────────────────
  submitButton: {
    backgroundColor: '#1e3a5f',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  submitButtonDisabled: {
    opacity: 0.5,
  },
  submitButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
  },
  submitLoadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },

  // ─── Site Picker Modal ────────────────────────────────────────────
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
  },
  modalClose: {
    fontSize: 20,
    color: '#9ca3af',
    padding: 4,
  },
  siteList: {
    padding: 8,
  },
  siteOption: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  siteOptionActive: {
    backgroundColor: '#eff6ff',
  },
  siteOptionText: {
    fontSize: 15,
    color: '#1f2937',
    flex: 1,
  },
  siteOptionTextActive: {
    color: '#1e3a5f',
    fontWeight: '600',
  },
  siteCheck: {
    fontSize: 18,
    color: '#1e3a5f',
    fontWeight: '700',
  },

  // ─── Media Preview Modal ──────────────────────────────────────────
  previewOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  previewImage: {
    width: '90%',
    height: '80%',
  },
  previewCloseButton: {
    position: 'absolute',
    top: 60,
    right: 20,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  previewCloseText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },

  // ─── Detail View ──────────────────────────────────────────────────
  detailStatusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  detailStatusBadge: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 16,
  },
  detailStatusText: {
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  detailId: {
    fontSize: 13,
    color: '#9ca3af',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  detailCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  detailLabel: {
    fontSize: 14,
    color: '#6b7280',
    flex: 1,
  },
  detailValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    flex: 2,
    textAlign: 'right',
  },
  detailDivider: {
    height: 1,
    backgroundColor: '#f3f4f6',
    marginVertical: 8,
  },
  detailSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 8,
    marginBottom: 4,
  },
  taskResultBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 8,
  },
  taskResultOk: {
    backgroundColor: '#f0fdf4',
  },
  taskResultPasOk: {
    backgroundColor: '#fef2f2',
  },
  taskResultText: {
    fontSize: 12,
    fontWeight: '700',
  },
  taskResultTextOk: {
    color: '#22c55e',
  },
  taskResultTextPasOk: {
    color: '#ef4444',
  },
  taskComment: {
    fontSize: 13,
    color: '#6b7280',
    fontStyle: 'italic',
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  detailNotes: {
    fontSize: 14,
    color: '#374151',
    lineHeight: 20,
  },

  // ─── Detail Media ─────────────────────────────────────────────────
  detailMediaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  detailMediaItem: {
    width: 110,
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  detailMediaImage: {
    width: 110,
    height: 110,
  },
  detailMediaVideo: {
    width: 110,
    height: 110,
    backgroundColor: '#1e293b',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 8,
  },
  detailMediaVideoIcon: {
    fontSize: 28,
    marginBottom: 4,
  },
  detailMediaVideoLabel: {
    fontSize: 10,
    color: '#94a3b8',
    textAlign: 'center',
  },
  detailMediaTime: {
    fontSize: 10,
    color: '#9ca3af',
    textAlign: 'center',
    paddingVertical: 4,
  },
});
