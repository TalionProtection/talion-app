import { StyleSheet, View, Text, TouchableOpacity, TextInput, Platform, Modal, ScrollView, Alert as RNAlert } from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { TalionScreen } from '@/components/talion-banner';
import { useAuth } from '@/hooks/useAuth';
import { useLocation } from '@/lib/location-context';
import NativeMapView, { Marker, Circle, Callout, isNativeMap } from '@/components/map-view';
import { websocketService, type LocationUpdate, type Alert as WSAlert } from '@/services/websocket';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import locationService from '@/services/location-service';
import { offlineCache } from '@/services/offline-cache';
import { OfflineBanner } from '@/components/offline-banner';
import { wsManager } from '@/services/websocket-manager';
import { Linking } from 'react-native';
import * as Haptics from 'expo-haptics';
import { formatIncidentId, formatIncidentType, formatSeverityFr } from '@/lib/format-utils';

// ─── Types ──────────────────────────────────────────────────────────────────
interface ResponderLocation {
  id: string;
  name: string;
  role: 'responder' | 'dispatcher';
  status: 'available' | 'on_duty' | 'off_duty';
  interventionStatus?: 'assigned' | 'accepted' | 'en_route' | 'on_scene';
  assignedIncidents?: { id: string; type: string; latitude?: number; longitude?: number; responderStatus?: string }[];
  latitude: number;
  longitude: number;
  lastUpdated: number;
}

interface FamilyMemberLocation {
  userId: string;
  userName: string;
  relationship: string;
  latitude: number;
  longitude: number;
  lastSeen: number;
}

interface IncidentZone {
  id: string;
  title: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  latitude: number;
  longitude: number;
  radius: number;
  description: string;
  timestamp: number;
  respondersAssigned: number;
  respondingNames?: string[];
}

type MapFilter = 'all' | 'alerts' | 'responders' | 'geofences' | 'family';
type IncidentTypeFilter = 'all' | 'sos' | 'medical' | 'fire' | 'security' | 'accident' | 'other';

const INCIDENT_TYPE_FILTERS: { key: IncidentTypeFilter; label: string; emoji: string }[] = [
  { key: 'all', label: 'Tous', emoji: '📋' },
  { key: 'sos', label: 'SOS', emoji: '🆘' },
  { key: 'medical', label: 'Médical', emoji: '🏥' },
  { key: 'fire', label: 'Incendie', emoji: '🔥' },
  { key: 'security', label: 'Sécurité', emoji: '🔒' },
  { key: 'accident', label: 'Accident', emoji: '🚗' },
  { key: 'other', label: 'Autre', emoji: '⚠️' },
];

interface GeofenceZone {
  id: string;
  center: { latitude: number; longitude: number };
  radiusKm: number;
  severity: string;
  message: string;
  createdBy: string;
  createdAt: number;
  respondersInside?: number;
}

// ─── Mock Data (used as fallback when no WebSocket data) ───────────────────
// Only shown to privileged roles (dispatcher, responder, admin)
const MOCK_RESPONDERS: ResponderLocation[] = [
  { id: 'r1', name: 'Unit Alpha', role: 'responder', status: 'available', latitude: 48.8566, longitude: 2.3522, lastUpdated: Date.now() },
  { id: 'r2', name: 'Unit Bravo', role: 'responder', status: 'on_duty', latitude: 48.8606, longitude: 2.3376, lastUpdated: Date.now() },
  { id: 'r3', name: 'Unit Charlie', role: 'responder', status: 'available', latitude: 48.8530, longitude: 2.3499, lastUpdated: Date.now() },
  { id: 'r4', name: 'Unit Delta', role: 'responder', status: 'off_duty', latitude: 48.8490, longitude: 2.3600, lastUpdated: Date.now() },
  { id: 'd1', name: 'Dispatch Central', role: 'dispatcher', status: 'on_duty', latitude: 48.8584, longitude: 2.2945, lastUpdated: Date.now() },
];

function getRelationshipEmoji(type: string): string {
  switch (type) {
    case 'spouse': return '💑';
    case 'parent': return '👨‍👧';
    case 'child': return '👶';
    case 'sibling': return '👫';
    default: return '👤';
  }
}

function getRelationshipLabel(type: string): string {
  switch (type) {
    case 'spouse': return 'Conjoint(e)';
    case 'parent': return 'Enfant';
    case 'child': return 'Parent';
    case 'sibling': return 'Frère/Sœur';
    default: return 'Famille';
  }
}

const MOCK_INCIDENTS: IncidentZone[] = [
  {
    id: 'i1', title: 'Medical Emergency', type: 'medical', severity: 'critical',
    latitude: 48.8588, longitude: 2.3470, radius: 150,
    description: 'Person collapsed near Louvre area', timestamp: Date.now() - 120000, respondersAssigned: 2,
  },
  {
    id: 'i2', title: 'Fire Alert', type: 'fire', severity: 'high',
    latitude: 48.8530, longitude: 2.3200, radius: 200,
    description: 'Smoke detected in residential building', timestamp: Date.now() - 300000, respondersAssigned: 1,
  },
  {
    id: 'i3', title: 'Security Concern', type: 'security', severity: 'medium',
    latitude: 48.8650, longitude: 2.3550, radius: 100,
    description: 'Suspicious activity reported', timestamp: Date.now() - 600000, respondersAssigned: 0,
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────
function getSeverityColor(severity: string): string {
  switch (severity) {
    case 'critical': return '#ef4444';
    case 'high': return '#f97316';
    case 'medium': return '#eab308';
    case 'low': return '#3b82f6';
    default: return '#6b7280';
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'available': return '#22c55e';
    case 'on_duty': return '#f59e0b';
    case 'off_duty': return '#9ca3af';
    default: return '#6b7280';
  }
}

function getIncidentEmoji(type: string): string {
  switch (type) {
    case 'medical': return '🏥';
    case 'fire': return '🔥';
    case 'security': return '🔒';
    case 'accident': return '🚗';
    case 'sos': return '🆘';
    default: return '⚠️';
  }
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'available': return '🟢';
    case 'on_duty': return '🟡';
    case 'off_duty': return '⚫';
    default: return '⚪';
  }
}

function getInterventionEmoji(status?: string): string {
  switch (status) {
    case 'accepted': return '✅';
    case 'en_route': return '🚗';
    case 'on_scene': return '📍';
    case 'assigned': return '🔔';
    default: return '';
  }
}

function getInterventionLabel(status?: string): string {
  switch (status) {
    case 'accepted': return 'Accepté';
    case 'en_route': return 'En route';
    case 'on_scene': return 'Sur place';
    case 'assigned': return 'Assigné';
    default: return '';
  }
}

function getInterventionColor(status?: string): string {
  switch (status) {
    case 'accepted': return '#22c55e';
    case 'en_route': return '#3b82f6';
    case 'on_scene': return '#ef4444';
    case 'assigned': return '#f59e0b';
    default: return '#6b7280';
  }
}

// Haversine distance in meters
function haversineDistanceMobile(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

function formatDistanceMobile(m: number): string {
  return m < 1000 ? `${Math.round(m)} m` : `${(m/1000).toFixed(1)} km`;
}

function estimateETAMobile(distMeters: number): string {
  const speedMs = 40 * 1000 / 3600; // 40 km/h average
  const seconds = distMeters / speedMs;
  if (seconds < 60) return '< 1 min';
  if (seconds < 3600) return `~${Math.round(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} h`;
}

function timeAgo(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ─── Web Map Fallback ───────────────────────────────────────────────────────
function WebMapView({ responders, incidents, familyMembers, filter, selectedIncident, onSelectIncident, userLat, userLng, gpsAccuracy }: {
  responders: ResponderLocation[];
  incidents: IncidentZone[];
  familyMembers: FamilyMemberLocation[];
  filter: MapFilter;
  selectedIncident: IncidentZone | null;
  onSelectIncident: (incident: IncidentZone | null) => void;
  userLat: number;
  userLng: number;
  gpsAccuracy: number | null;
}) {
  const showResponders = filter === 'all' || filter === 'responders';
  const showIncidents = filter === 'all' || filter === 'alerts';
  const showFamily = filter === 'all' || filter === 'family';

  // Convert lat/lng to percentage position on the web map
  const toMapPos = (lat: number, lng: number) => ({
    top: `${50 + (48.8566 - lat) * 2000}%`,
    left: `${50 + (lng - 2.3522) * 800}%`,
  });

  const userPos = toMapPos(userLat, userLng);

  return (
    <View style={webStyles.container}>
      <View style={webStyles.mapArea}>
        {/* Grid lines for visual effect */}
        <View style={webStyles.gridOverlay}>
          {Array.from({ length: 8 }).map((_, i) => (
            <View key={`h${i}`} style={[webStyles.gridLine, { top: `${(i + 1) * 12}%` } as any]} />
          ))}
          {Array.from({ length: 6 }).map((_, i) => (
            <View key={`v${i}`} style={[webStyles.gridLineV, { left: `${(i + 1) * 16}%` } as any]} />
          ))}
        </View>

        {/* Incident zones */}
        {showIncidents && incidents.map((incident) => {
          const pos = toMapPos(incident.latitude, incident.longitude);
          return (
            <TouchableOpacity
              key={incident.id}
              style={[
                webStyles.incidentMarker,
                { top: pos.top, left: pos.left } as any,
                selectedIncident?.id === incident.id && webStyles.selectedMarker,
              ]}
              onPress={() => onSelectIncident(selectedIncident?.id === incident.id ? null : incident)}
            >
              <View style={[webStyles.incidentPulse, { backgroundColor: getSeverityColor(incident.severity) + '30' }]} />
              <View style={[webStyles.incidentDot, { backgroundColor: getSeverityColor(incident.severity) }]}>
                <Text style={webStyles.markerEmoji}>{getIncidentEmoji(incident.type)}</Text>
              </View>
              <Text style={webStyles.markerLabel}>{incident.title}</Text>
            </TouchableOpacity>
          );
        })}

        {/* Responder markers */}
        {showResponders && responders.map((resp) => {
          const pos = toMapPos(resp.latitude, resp.longitude);
          const intStatus = resp.interventionStatus;
          const dotColor = intStatus ? getInterventionColor(intStatus) : getStatusColor(resp.status);
          const emoji = resp.role === 'dispatcher' ? '📡' : (intStatus ? getInterventionEmoji(intStatus) || '🛡️' : '🛡️');
          const statusLabel = intStatus ? getInterventionLabel(intStatus) : '';
          // Calculate ETA for first assigned incident
          let etaText = '';
          if (resp.assignedIncidents && resp.assignedIncidents.length > 0 && intStatus !== 'on_scene') {
            const firstInc = resp.assignedIncidents[0];
            if (firstInc.latitude && firstInc.longitude) {
              const dist = haversineDistanceMobile(resp.latitude, resp.longitude, firstInc.latitude, firstInc.longitude);
              etaText = `ETA: ${estimateETAMobile(dist)}`;
            }
          }
          return (
            <View
              key={resp.id}
              style={[
                webStyles.responderMarker,
                { top: pos.top, left: pos.left } as any,
              ]}
            >
              <View style={[webStyles.responderDot, { backgroundColor: dotColor, borderColor: resp.role === 'dispatcher' ? '#1e3a5f' : '#ffffff' }]}>
                <Text style={webStyles.responderEmoji}>{emoji}</Text>
              </View>
              <Text style={webStyles.responderLabel}>{resp.name}{statusLabel ? ` (${statusLabel})` : ''}</Text>
              {etaText ? <Text style={{ fontSize: 8, color: '#60a5fa', fontWeight: '600', textAlign: 'center' }}>{etaText}</Text> : null}
            </View>
          );
        })}

        {/* Family member markers */}
        {showFamily && familyMembers.map((fam) => {
          const pos = toMapPos(fam.latitude, fam.longitude);
          return (
            <View
              key={fam.userId}
              style={[
                webStyles.responderMarker,
                { top: pos.top, left: pos.left } as any,
              ]}
            >
              <View style={[webStyles.responderDot, { backgroundColor: '#3b82f6', borderColor: '#1e40af' }]}>
                <Text style={webStyles.responderEmoji}>{getRelationshipEmoji(fam.relationship)}</Text>
              </View>
              <Text style={webStyles.responderLabel}>{fam.userName}</Text>
            </View>
          );
        })}

        {/* User location (real GPS) */}
        <View style={[webStyles.userMarker, { top: userPos.top, left: userPos.left } as any]}>
          {gpsAccuracy && (
            <View style={[webStyles.accuracyCircle, { width: Math.max(40, gpsAccuracy / 5), height: Math.max(40, gpsAccuracy / 5), borderRadius: Math.max(20, gpsAccuracy / 10) }]} />
          )}
          <View style={webStyles.userPulse} />
          <View style={webStyles.userDot} />
        </View>
      </View>

      {/* Selected incident detail */}
      {selectedIncident && (
        <View style={webStyles.incidentDetail}>
          <View style={webStyles.detailHeader}>
            <Text style={webStyles.detailEmoji}>{getIncidentEmoji(selectedIncident.type)}</Text>
            <View style={webStyles.detailInfo}>
              <Text style={webStyles.detailTitle}>{selectedIncident.title}</Text>
              <View style={{ backgroundColor: '#f3f4f6', paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, marginRight: 4 }}>
                <Text style={{ fontSize: 9, fontWeight: '700', color: '#6b7280' }}>{formatIncidentId(selectedIncident.id)}</Text>
              </View>
              <View style={[webStyles.severityBadge, { backgroundColor: getSeverityColor(selectedIncident.severity) }]}>
                <Text style={webStyles.severityText}>{formatSeverityFr(selectedIncident.severity)}</Text>
              </View>
            </View>
            <TouchableOpacity onPress={() => onSelectIncident(null)} style={webStyles.closeButton}>
              <Text style={webStyles.closeText}>✕</Text>
            </TouchableOpacity>
          </View>
          <Text style={webStyles.detailDescription}>{selectedIncident.description}</Text>
          <View style={webStyles.detailMeta}>
            <Text style={webStyles.detailMetaText}>📍 Rayon: {selectedIncident.radius}m</Text>
            <Text style={webStyles.detailMetaText}>👥 Assignés: {selectedIncident.respondingNames && selectedIncident.respondingNames.length > 0 ? selectedIncident.respondingNames.join(', ') : `${selectedIncident.respondersAssigned}`}</Text>
            <Text style={webStyles.detailMetaText}>🕐 {timeAgo(selectedIncident.timestamp)}</Text>
          </View>
        </View>
      )}
    </View>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────
export default function MapScreen() {
  const { user } = useAuth();
  const { location, state: locationState } = useLocation();
  const isPrivileged = user?.role === 'responder' || user?.role === 'dispatcher' || user?.role === 'admin';
  const [mapFilter, setMapFilter] = useState<MapFilter>('all');
  // Regular users do NOT see responder locations - only privileged roles do
  const [responders, setResponders] = useState<ResponderLocation[]>(isPrivileged ? MOCK_RESPONDERS : []);
  const [incidents, setIncidents] = useState<IncidentZone[]>([]);
  const [incidentsLoaded, setIncidentsLoaded] = useState(false);
  const [familyLocations, setFamilyLocations] = useState<FamilyMemberLocation[]>([]);
  const [selectedIncident, setSelectedIncident] = useState<IncidentZone | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{id: string; name: string; type: string; latitude: number; longitude: number}>>([]);
  const [showSearch, setShowSearch] = useState(false);
  const [geofences, setGeofences] = useState<GeofenceZone[]>([]);
  const [showGeofenceModal, setShowGeofenceModal] = useState(false);
  const [gfName, setGfName] = useState('');
  const [gfRadius, setGfRadius] = useState('0.5');
  const [gfSeverity, setGfSeverity] = useState<'critical' | 'high' | 'medium' | 'low'>('medium');
  const [gfMessage, setGfMessage] = useState('');
  const [selectedGeofence, setSelectedGeofence] = useState<GeofenceZone | null>(null);
  const [gfCreating, setGfCreating] = useState(false);
  const [editingGeofence, setEditingGeofence] = useState<GeofenceZone | null>(null);
  const [showGeofenceList, setShowGeofenceList] = useState(false);
  const [incidentTypeFilter, setIncidentTypeFilter] = useState<IncidentTypeFilter>('all');
  const [showIncidentDetail, setShowIncidentDetail] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const mapRef = useRef<any>(null);

  // Use real GPS location for initial map region
  const initialRegion = {
    latitude: location.latitude,
    longitude: location.longitude,
    latitudeDelta: 0.03,
    longitudeDelta: 0.03,
  };

  // Fetch geofences from server
  const fetchGeofences = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/dispatch/geofence/zones`, { timeout: 10000 });
      const data = await res.json();
      // API may return plain array or { success, zones }
      const zones = Array.isArray(data) ? data : (data.zones || []);
      setGeofences(zones);
      offlineCache.cacheGeofences(zones);
    } catch (e) {
      // Try offline cache
      const cached = await offlineCache.getCachedGeofences();
      if (cached) setGeofences(cached);
    }
  }, []);

  useEffect(() => {
    fetchGeofences();
    const interval = setInterval(fetchGeofences, 15000);
    return () => clearInterval(interval);
  }, [fetchGeofences]);

  const handleCreateGeofence = useCallback(async () => {
    if (!gfMessage.trim()) {
      RNAlert.alert('Error', 'Please enter a zone description.');
      return;
    }
    setGfCreating(true);
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/dispatch/geofence/zones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          center: { latitude: location.latitude, longitude: location.longitude },
          radiusKm: parseFloat(gfRadius) || 0.5,
          severity: gfSeverity,
          message: gfMessage,
          createdBy: user?.name || 'Mobile User',
        }),
        timeout: 10000,
      });
      const data = await res.json();
      if (data.success) {
        setShowGeofenceModal(false);
        setGfName(''); setGfRadius('0.5'); setGfSeverity('medium'); setGfMessage('');
        fetchGeofences();
        RNAlert.alert('Success', 'Geofence zone created.');
      }
    } catch (e) {
      RNAlert.alert('Error', 'Failed to create geofence zone.');
    } finally {
      setGfCreating(false);
    }
  }, [location, gfRadius, gfSeverity, gfMessage, user, fetchGeofences]);

  const handleDeleteGeofence = useCallback(async (zoneId: string) => {
    RNAlert.alert('Delete Zone', 'Are you sure you want to delete this geofence zone?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            await fetchWithTimeout(`${getApiBaseUrl()}/dispatch/geofence/zones/${zoneId}`, { method: 'DELETE', timeout: 10000 });
            setSelectedGeofence(null);
            fetchGeofences();
          } catch (e) { RNAlert.alert('Error', 'Failed to delete zone.'); }
        },
      },
    ]);
  }, [fetchGeofences]);

  const openEditGeofence = useCallback((gf: GeofenceZone) => {
    setEditingGeofence(gf);
    setGfMessage(gf.message);
    setGfRadius(gf.radiusKm.toString());
    setGfSeverity(gf.severity as any);
    setSelectedGeofence(null);
    setShowGeofenceModal(true);
  }, []);

  const handleSaveGeofence = useCallback(async () => {
    if (!gfMessage.trim()) {
      RNAlert.alert('Error', 'Please enter a zone description.');
      return;
    }
    setGfCreating(true);
    try {
      if (editingGeofence) {
        // Delete old and create new with updated params
        await fetchWithTimeout(`${getApiBaseUrl()}/dispatch/geofence/zones/${editingGeofence.id}`, { method: 'DELETE', timeout: 10000 });
      }
      const center = editingGeofence ? editingGeofence.center : { latitude: location.latitude, longitude: location.longitude };
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/dispatch/geofence/zones`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          center,
          radiusKm: parseFloat(gfRadius) || 0.5,
          severity: gfSeverity,
          message: gfMessage,
          createdBy: user?.name || 'Mobile User',
        }),
        timeout: 10000,
      });
      const data = await res.json();
      if (data.success) {
        setShowGeofenceModal(false);
        setEditingGeofence(null);
        setGfName(''); setGfRadius('0.5'); setGfSeverity('medium'); setGfMessage('');
        fetchGeofences();
        RNAlert.alert('Success', editingGeofence ? 'Geofence zone updated.' : 'Geofence zone created.');
      }
    } catch (e) {
      RNAlert.alert('Error', 'Failed to save geofence zone.');
    } finally {
      setGfCreating(false);
    }
  }, [location, gfRadius, gfSeverity, gfMessage, user, fetchGeofences, editingGeofence]);

  const handleCenterOnGeofence = useCallback((gf: GeofenceZone) => {
    setShowGeofenceList(false);
    if (mapRef.current && isNativeMap) {
      const delta = gf.radiusKm * 0.02;
      mapRef.current.animateToRegion({
        latitude: gf.center.latitude,
        longitude: gf.center.longitude,
        latitudeDelta: Math.max(delta, 0.005),
        longitudeDelta: Math.max(delta, 0.005),
      }, 500);
    }
  }, []);

  // Reverse geocode user location for display
  useEffect(() => {
    let cancelled = false;
    const geocode = async () => {
      try {
        const addr = await locationService.reverseGeocode(location.latitude, location.longitude);
        if (!cancelled && addr) setAddress(addr);
      } catch {
        // ignore
      }
    };
    geocode();
    return () => { cancelled = true; };
  }, [location.latitude, location.longitude]);

  // ─── Fetch real incidents from server on mount + polling ───────────────
  const fetchIncidents = useCallback(async () => {
    try {
      const baseUrl = getApiBaseUrl();
      const response = await fetchWithTimeout(`${baseUrl}/alerts`, {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        timeout: 10000,
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const data = await response.json();
      const serverAlerts: IncidentZone[] = (Array.isArray(data) ? data : []).map((a: any) => ({
        id: a.id,
        title: `${(a.type || 'other').charAt(0).toUpperCase() + (a.type || 'other').slice(1)} Alert`,
        type: a.type || 'other',
        severity: a.severity || 'medium',
        latitude: a.location?.latitude || 0,
        longitude: a.location?.longitude || 0,
        radius: a.severity === 'critical' ? 200 : a.severity === 'high' ? 150 : 100,
        description: a.description || '',
        timestamp: a.createdAt || Date.now(),
        respondersAssigned: a.respondingUsers?.length || 0,
        respondingNames: a.respondingNames || [],
      }));
      setIncidents(serverAlerts);
      setIncidentsLoaded(true);
    } catch (e) {
      console.warn('[Map] Failed to fetch incidents:', e);
      // If no incidents loaded yet, show mock data as fallback
      if (!incidentsLoaded) {
        setIncidents(MOCK_INCIDENTS);
        setIncidentsLoaded(true);
      }
    }
  }, [incidentsLoaded]);

  useEffect(() => {
    fetchIncidents();
    const interval = setInterval(fetchIncidents, 15000);
    return () => clearInterval(interval);
  }, [fetchIncidents]);

  // Send user location via WebSocket for other users to see
  useEffect(() => {
    if (user && websocketService.isConnected()) {
      websocketService.sendLocation(
        location.latitude,
        location.longitude,
        location.accuracy ?? undefined,
      );
    }
  }, [location.latitude, location.longitude, user]);

  // Fetch family member locations (for regular users)
  useEffect(() => {
    if (!user?.id) return;
    const fetchFamilyLocations = async () => {
      try {
        const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/family/locations?userId=${user.id}`, { timeout: 10000 });
        const data = await res.json();
        if (data.locations) {
          setFamilyLocations(data.locations);
        }
      } catch (e) {
        // silently fail
      }
    };
    fetchFamilyLocations();
    const interval = setInterval(fetchFamilyLocations, 15000);
    return () => clearInterval(interval);
  }, [user?.id]);

  // WebSocket real-time location updates
  useEffect(() => {
    // Only privileged users receive responder location updates
    const handleLocationUpdate = (data: LocationUpdate) => {
      if (!isPrivileged) return; // Regular users ignore responder locations
      setResponders((prev) => {
        const existing = prev.find((r) => r.id === data.userId);
        if (existing) {
          return prev.map((r) =>
            r.id === data.userId
              ? { ...r, latitude: data.latitude, longitude: data.longitude, lastUpdated: data.timestamp }
              : r
          );
        }
        return prev;
      });
    };

    const handleAlert = (data: WSAlert) => {
      setIncidents((prev) => {
        const existing = prev.find((i) => i.id === data.id);
        if (existing) {
          return prev.map((i) =>
            i.id === data.id
              ? {
                  ...i,
                  title: `${data.type.charAt(0).toUpperCase() + data.type.slice(1)} Alert`,
                  severity: data.priority,
                  description: data.description,
                  latitude: data.location.latitude,
                  longitude: data.location.longitude,
                  timestamp: data.updatedAt,
                }
              : i
          );
        }
        return [
          ...prev,
          {
            id: data.id,
            title: `${data.type.charAt(0).toUpperCase() + data.type.slice(1)} Alert`,
            type: data.type,
            severity: data.priority,
            latitude: data.location.latitude,
            longitude: data.location.longitude,
            radius: data.priority === 'critical' ? 200 : data.priority === 'high' ? 150 : 100,
            description: data.description,
            timestamp: data.createdAt,
            respondersAssigned: data.respondersAssigned?.length ?? data.respondingUsers?.length ?? 0,
            respondingNames: data.respondingNames || [],
          },
        ];
      });
    };

    // Listen for family location updates via WebSocket
    const handleFamilyLocation = (data: any) => {
      const loc = data.data || data;
      if (loc.userId && loc.location) {
        setFamilyLocations((prev) => {
          const existing = prev.find((f) => f.userId === loc.userId);
          if (existing) {
            return prev.map((f) =>
              f.userId === loc.userId
                ? { ...f, latitude: loc.location.latitude, longitude: loc.location.longitude, lastSeen: loc.timestamp || Date.now() }
                : f
            );
          }
          return [...prev, {
            userId: loc.userId,
            userName: loc.userName || loc.userId,
            relationship: loc.relationship || 'family',
            latitude: loc.location.latitude,
            longitude: loc.location.longitude,
            lastSeen: loc.timestamp || Date.now(),
          }];
        });
      }
    };

    websocketService.on('location', handleLocationUpdate);
    websocketService.on('alert', handleAlert);
    websocketService.on('familyLocation', handleFamilyLocation);

    // Also listen for alertResolved to remove resolved incidents from map
    const handleAlertResolved = (data: any) => {
      const alertId = data?.alertId || data?.data?.alertId;
      if (alertId) {
        setIncidents((prev) => prev.filter((i) => i.id !== alertId));
      }
    };
    websocketService.on('alertResolved', handleAlertResolved);

    // Also listen via wsManager for newAlert (in case old service misses it)
    const unsubNewAlert = wsManager.on('newAlert', (msg: any) => {
      const alertData = msg.data || msg;
      if (!alertData?.id || !alertData?.location) return;
      setIncidents((prev) => {
        const existing = prev.find((i) => i.id === alertData.id);
        if (existing) return prev; // Already have it
        return [
          ...prev,
          {
            id: alertData.id,
            title: `${(alertData.type || 'other').charAt(0).toUpperCase() + (alertData.type || 'other').slice(1)} Alert`,
            type: alertData.type || 'other',
            severity: alertData.severity || 'medium',
            latitude: alertData.location.latitude,
            longitude: alertData.location.longitude,
            radius: alertData.severity === 'critical' ? 200 : alertData.severity === 'high' ? 150 : 100,
            description: alertData.description || '',
            timestamp: alertData.createdAt || Date.now(),
            respondersAssigned: alertData.respondingUsers?.length || 0,
            respondingNames: alertData.respondingNames || [],
          },
        ];
      });
    });

    const unsubAlertResolved = wsManager.on('alertResolved', (msg: any) => {
      const alertId = msg?.alertId || msg?.data?.alertId;
      if (alertId) {
        setIncidents((prev) => prev.filter((i) => i.id !== alertId));
      }
    });

    // Fallback: simulate movement if not connected (only for privileged users)
    const interval = setInterval(() => {
      if (!websocketService.isConnected() && isPrivileged) {
        setResponders((prev) =>
          prev.map((r) => ({
            ...r,
            latitude: r.latitude + (Math.random() - 0.5) * 0.0005,
            longitude: r.longitude + (Math.random() - 0.5) * 0.0005,
            lastUpdated: Date.now(),
          }))
        );
      }
    }, 5000);

    return () => {
      websocketService.off('location', handleLocationUpdate);
      websocketService.off('alert', handleAlert);
      websocketService.off('familyLocation', handleFamilyLocation);
      websocketService.off('alertResolved', handleAlertResolved);
      unsubNewAlert();
      unsubAlertResolved();
      clearInterval(interval);
    };
  }, [isPrivileged]);

  const filteredResponders = (!isPrivileged || mapFilter === 'alerts' || mapFilter === 'geofences' || mapFilter === 'family') ? [] : responders;
  const typeFilteredIncidents = (mapFilter === 'responders' || mapFilter === 'geofences' || mapFilter === 'family') ? [] : incidents;
  const filteredIncidents = incidentTypeFilter === 'all'
    ? typeFilteredIncidents
    : typeFilteredIncidents.filter((i) => i.type === incidentTypeFilter);
  const filteredFamily = (mapFilter === 'all' || mapFilter === 'family') ? familyLocations : [];
  const showGeofences = isPrivileged && (mapFilter === 'all' || mapFilter === 'geofences');

  // --- Incident actions ---
  const handleAcknowledgeIncident = useCallback(async (incidentId: string) => {
    setActionLoading('ack');
    try {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/alerts/${incidentId}/acknowledge`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user?.id, userName: user?.name }),
        timeout: 10000,
      });
      if (res.ok) {
        RNAlert.alert('Confirmé', 'Incident acquitté avec succès.');
        fetchIncidents();
      } else {
        RNAlert.alert('Erreur', 'Impossible d\'acquitter cet incident.');
      }
    } catch (e) {
      RNAlert.alert('Erreur', 'Erreur de connexion au serveur.');
    } finally {
      setActionLoading(null);
    }
  }, [user, fetchIncidents]);

  const handleNavigateToIncident = useCallback((incident: IncidentZone) => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const url = Platform.select({
      ios: `maps://app?daddr=${incident.latitude},${incident.longitude}`,
      android: `google.navigation:q=${incident.latitude},${incident.longitude}`,
      default: `https://www.google.com/maps/dir/?api=1&destination=${incident.latitude},${incident.longitude}`,
    });
    Linking.openURL(url!).catch(() => {
      Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${incident.latitude},${incident.longitude}`);
    });
  }, []);

  const handleContactDispatch = useCallback(() => {
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // Navigate to PTT emergency channel
    const { router } = require('expo-router');
    router.push('/(tabs)/ptt');
  }, []);

  const handleResolveIncident = useCallback(async (incidentId: string) => {
    RNAlert.alert('Résoudre l\'incident', 'Êtes-vous sûr de vouloir marquer cet incident comme résolu ?', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Résoudre', style: 'destructive', onPress: async () => {
          setActionLoading('resolve');
          try {
            const res = await fetchWithTimeout(`${getApiBaseUrl()}/alerts/${incidentId}/resolve`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ userId: user?.id, userName: user?.name }),
              timeout: 10000,
            });
            if (res.ok) {
              setShowIncidentDetail(false);
              setSelectedIncident(null);
              fetchIncidents();
              RNAlert.alert('Résolu', 'Incident marqué comme résolu.');
            }
          } catch (e) {
            RNAlert.alert('Erreur', 'Impossible de résoudre cet incident.');
          } finally {
            setActionLoading(null);
          }
        },
      },
    ]);
  }, [user, fetchIncidents]);

  const openIncidentDetail = useCallback((incident: IncidentZone) => {
    setSelectedIncident(incident);
    setShowIncidentDetail(true);
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, []);

  // Build filters based on role
  const filters: { key: MapFilter; label: string; count: number }[] = isPrivileged
    ? [
        { key: 'all', label: 'All', count: responders.length + incidents.length },
        { key: 'alerts', label: 'Incidents', count: incidents.length },
        { key: 'responders', label: 'Units', count: responders.length },
        { key: 'geofences', label: 'Zones', count: geofences.length },
        ...(familyLocations.length > 0 ? [{ key: 'family' as MapFilter, label: 'Famille', count: familyLocations.length }] : []),
      ]
    : [
        { key: 'all', label: 'Tout', count: incidents.length + familyLocations.length },
        { key: 'alerts', label: 'Incidents', count: incidents.length },
        ...(familyLocations.length > 0 ? [{ key: 'family' as MapFilter, label: 'Famille', count: familyLocations.length }] : []),
      ];

  const handleCenterOnUser = useCallback(() => {
    if (mapRef.current && isNativeMap) {
      mapRef.current.animateToRegion({
        latitude: location.latitude,
        longitude: location.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      }, 500);
    }
  }, [location]);

  const handleCenterOnIncidents = useCallback(() => {
    if (mapRef.current && incidents.length > 0 && isNativeMap) {
      const coords = incidents.map((i) => ({ latitude: i.latitude, longitude: i.longitude }));
      mapRef.current.fitToCoordinates(coords, {
        edgePadding: { top: 80, right: 40, bottom: 80, left: 40 },
        animated: true,
      });
    }
  }, [incidents]);

  const activeCount = incidents.filter((i) => i.severity === 'critical' || i.severity === 'high').length;
  const availableUnits = responders.filter((r) => r.status === 'available').length;
  const familyOnline = familyLocations.length;

  // Search functionality
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const q = searchQuery.toLowerCase();
    const results: Array<{id: string; name: string; type: string; latitude: number; longitude: number}> = [];
    // Only privileged users can search responders
    if (isPrivileged) {
      responders.forEach((r) => {
        if (r.name.toLowerCase().includes(q)) {
          results.push({ id: r.id, name: r.name, type: r.role, latitude: r.latitude, longitude: r.longitude });
        }
      });
    }
    incidents.forEach((i) => {
      if (i.title.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) {
        results.push({ id: i.id, name: i.title, type: 'incident', latitude: i.latitude, longitude: i.longitude });
      }
    });
    // All users can search family members
    familyLocations.forEach((f) => {
      if (f.userName.toLowerCase().includes(q)) {
        results.push({ id: f.userId, name: `${getRelationshipEmoji(f.relationship)} ${f.userName}`, type: 'family', latitude: f.latitude, longitude: f.longitude });
      }
    });
    setSearchResults(results.slice(0, 8));
  }, [searchQuery, responders, incidents, familyLocations, isPrivileged]);

  const handleSearchSelect = useCallback((item: {latitude: number; longitude: number}) => {
    setShowSearch(false);
    setSearchQuery('');
    if (mapRef.current && isNativeMap) {
      mapRef.current.animateToRegion({
        latitude: item.latitude,
        longitude: item.longitude,
        latitudeDelta: 0.005,
        longitudeDelta: 0.005,
      }, 500);
    }
  }, []);

  // Calculate distances from user to nearest incident
  const nearestIncident = incidents.reduce<{ incident: IncidentZone; distance: number } | null>((nearest, inc) => {
    const dist = locationService.constructor.prototype.constructor === Object
      ? 0
      : Math.sqrt(
          Math.pow((inc.latitude - location.latitude) * 111000, 2) +
          Math.pow((inc.longitude - location.longitude) * 111000 * Math.cos(location.latitude * Math.PI / 180), 2)
        );
    if (!nearest || dist < nearest.distance) return { incident: inc, distance: dist };
    return nearest;
  }, null);

  return (
    <TalionScreen showStatus={false}>
      <OfflineBanner />
      {/* GPS Status & Location Bar */}
      <View style={styles.gpsBar}>
        <View style={styles.gpsStatus}>
          <View style={[styles.gpsDot, { backgroundColor: locationState.hasPermission ? (locationState.isTracking ? '#22c55e' : '#f59e0b') : '#ef4444' }]} />
          <Text style={styles.gpsText}>
            {locationState.isTracking ? 'GPS Active' : locationState.hasPermission ? 'GPS Ready' : 'No GPS'}
          </Text>
          {location.accuracy && (
            <Text style={styles.gpsAccuracy}>±{Math.round(location.accuracy)}m</Text>
          )}
        </View>
        {address && (
          <Text style={styles.gpsAddress} numberOfLines={1}>{address}</Text>
        )}
      </View>

      {/* Stats Bar */}
      <View style={styles.statsBar}>
        <View style={styles.statItem}>
          <View style={[styles.statDot, { backgroundColor: '#ef4444' }]} />
          <Text style={styles.statText}>{activeCount} Active</Text>
        </View>
        {isPrivileged ? (
          <>
            <View style={styles.statItem}>
              <View style={[styles.statDot, { backgroundColor: '#22c55e' }]} />
              <Text style={styles.statText}>{availableUnits} Available</Text>
            </View>
            <View style={styles.statItem}>
              <View style={[styles.statDot, { backgroundColor: '#f59e0b' }]} />
              <Text style={styles.statText}>{responders.filter((r) => r.status === 'on_duty').length} On Duty</Text>
            </View>
          </>
        ) : (
          <View style={styles.statItem}>
            <View style={[styles.statDot, { backgroundColor: '#3b82f6' }]} />
            <Text style={styles.statText}>{familyOnline} Famille</Text>
          </View>
        )}
      </View>

      {/* Search Bar */}
      <View style={styles.searchBarContainer}>
        <View style={styles.searchInputRow}>
          <Text style={{ fontSize: 14, marginRight: 6 }}>{"\u{1F50D}"}</Text>
          <TextInput
            style={styles.searchInput}
            placeholder="Search user, unit, incident..."
            placeholderTextColor="#9ca3af"
            value={searchQuery}
            onChangeText={(t) => { setSearchQuery(t); setShowSearch(true); }}
            onFocus={() => setShowSearch(true)}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => { setSearchQuery(''); setShowSearch(false); }}>
              <Text style={{ fontSize: 16, color: '#6b7280' }}>{"\u2715"}</Text>
            </TouchableOpacity>
          )}
        </View>
        {showSearch && searchResults.length > 0 && (
          <View style={styles.searchDropdown}>
            {searchResults.map((r) => (
              <TouchableOpacity key={r.id} style={styles.searchResultItem} onPress={() => handleSearchSelect(r)}>
                <Text style={styles.searchResultIcon}>
                  {r.type === 'incident' ? '\u26A0\uFE0F' : r.type === 'dispatcher' ? '\u{1F4E1}' : '\u{1F6E1}\uFE0F'}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.searchResultName}>{r.name}</Text>
                  <Text style={styles.searchResultType}>{r.type}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Filter Bar */}
      <View style={styles.filterBar}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {filters.map((filter) => (
            <TouchableOpacity
              key={filter.key}
              style={[styles.filterButton, mapFilter === filter.key && styles.filterButtonActive]}
              onPress={() => setMapFilter(filter.key)}
            >
              <Text style={[styles.filterText, mapFilter === filter.key && styles.filterTextActive]}>
                {filter.label}
              </Text>
              <View style={[styles.filterBadge, mapFilter === filter.key && styles.filterBadgeActive]}>
                <Text style={[styles.filterBadgeText, mapFilter === filter.key && styles.filterBadgeTextActive]}>
                  {filter.count}
                </Text>
              </View>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Incident Type Filter (shown when Incidents filter is active or All) */}
      {(mapFilter === 'all' || mapFilter === 'alerts') && incidents.length > 0 && (
        <View style={styles.typeFilterBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: 16 }}>
            {INCIDENT_TYPE_FILTERS.map((tf) => {
              const count = tf.key === 'all' ? incidents.length : incidents.filter((i) => i.type === tf.key).length;
              if (tf.key !== 'all' && count === 0) return null;
              return (
                <TouchableOpacity
                  key={tf.key}
                  style={[styles.typeChip, incidentTypeFilter === tf.key && styles.typeChipActive]}
                  onPress={() => setIncidentTypeFilter(tf.key)}
                >
                  <Text style={styles.typeChipEmoji}>{tf.emoji}</Text>
                  <Text style={[styles.typeChipText, incidentTypeFilter === tf.key && styles.typeChipTextActive]}>
                    {tf.label}
                  </Text>
                  <Text style={[styles.typeChipCount, incidentTypeFilter === tf.key && styles.typeChipCountActive]}>
                    {count}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
      )}

      {/* Map */}
      <View style={styles.mapContainer}>
        {isNativeMap ? (
          <NativeMapView
            ref={mapRef}
            style={StyleSheet.absoluteFillObject}
            initialRegion={initialRegion}
            showsUserLocation
            showsMyLocationButton={false}
            showsCompass
            followsUserLocation={false}
          >
            {filteredIncidents.map((incident) => (
              <Circle
                key={`circle-${incident.id}`}
                center={{ latitude: incident.latitude, longitude: incident.longitude }}
                radius={incident.radius}
                fillColor={getSeverityColor(incident.severity) + '25'}
                strokeColor={getSeverityColor(incident.severity)}
                strokeWidth={2}
              />
            ))}
            {filteredIncidents.map((incident) => (
              <Marker
                key={`marker-${incident.id}`}
                coordinate={{ latitude: incident.latitude, longitude: incident.longitude }}
                title={incident.title}
                description={`${incident.severity.toUpperCase()} - ${incident.description}`}
                pinColor={getSeverityColor(incident.severity)}
                onPress={() => openIncidentDetail(incident)}
              >
                <Callout>
                  <View style={styles.callout}>
                    <Text style={styles.calloutTitle}>{getIncidentEmoji(incident.type)} {incident.title}</Text>
                    <View style={[styles.calloutSeverity, { backgroundColor: getSeverityColor(incident.severity) }]}>
                      <Text style={styles.calloutSeverityText}>{incident.severity.toUpperCase()}</Text>
                    </View>
                    <Text style={styles.calloutDesc}>{incident.description}</Text>
                    <Text style={styles.calloutMeta}>👥 {incident.respondingNames && incident.respondingNames.length > 0 ? incident.respondingNames.join(', ') : `${incident.respondersAssigned} assigné(s)`} · {timeAgo(incident.timestamp)}</Text>
                  </View>
                </Callout>
              </Marker>
            ))}
            {filteredResponders.map((resp) => (
              <Marker
                key={`resp-${resp.id}`}
                coordinate={{ latitude: resp.latitude, longitude: resp.longitude }}
                title={resp.name}
                description={`${resp.role} - ${resp.status}`}
              >
                <View style={styles.markerWithLabel}>
                  <View style={[styles.responderPin, { borderColor: getStatusColor(resp.status) }]}>
                    <Text style={{ fontSize: 16 }}>{resp.role === 'dispatcher' ? '📡' : '🛡️'}</Text>
                  </View>
                  <View style={styles.markerNameBadge}>
                    <Text style={styles.markerNameText} numberOfLines={1}>{resp.name}</Text>
                  </View>
                </View>
                <Callout>
                  <View style={styles.callout}>
                    <Text style={styles.calloutTitle}>{resp.name}</Text>
                    <Text style={styles.calloutDesc}>{getStatusEmoji(resp.status)} {resp.status.replace('_', ' ')}</Text>
                    <Text style={styles.calloutMeta}>Updated {timeAgo(resp.lastUpdated)}</Text>
                  </View>
                </Callout>
              </Marker>
            ))}
            {filteredFamily.map((fam) => (
              <Marker
                key={`fam-${fam.userId}`}
                coordinate={{ latitude: fam.latitude, longitude: fam.longitude }}
                title={fam.userName}
                description={getRelationshipLabel(fam.relationship)}
              >
                <View style={styles.markerWithLabel}>
                  <View style={[styles.responderPin, { borderColor: '#3b82f6', backgroundColor: '#eff6ff' }]}>
                    <Text style={{ fontSize: 16 }}>{getRelationshipEmoji(fam.relationship)}</Text>
                  </View>
                  <View style={[styles.markerNameBadge, { backgroundColor: '#3b82f6' }]}>
                    <Text style={styles.markerNameText} numberOfLines={1}>{fam.userName}</Text>
                  </View>
                </View>
                <Callout>
                  <View style={styles.callout}>
                    <Text style={styles.calloutTitle}>{getRelationshipEmoji(fam.relationship)} {fam.userName}</Text>
                    <Text style={styles.calloutDesc}>{getRelationshipLabel(fam.relationship)}</Text>
                    <Text style={styles.calloutMeta}>Vu {timeAgo(fam.lastSeen)}</Text>
                  </View>
                </Callout>
              </Marker>
            ))}
            {showGeofences && geofences.map((gf) => (
              <Circle
                key={`gf-circle-${gf.id}`}
                center={gf.center}
                radius={gf.radiusKm * 1000}
                fillColor={gf.severity === 'critical' ? 'rgba(239,68,68,0.15)' : gf.severity === 'high' ? 'rgba(249,115,22,0.15)' : gf.severity === 'medium' ? 'rgba(234,179,8,0.15)' : 'rgba(34,197,94,0.15)'}
                strokeColor={gf.severity === 'critical' ? '#ef4444' : gf.severity === 'high' ? '#f97316' : gf.severity === 'medium' ? '#eab308' : '#22c55e'}
                strokeWidth={2}
                strokeDashPattern={[10, 5]}
              />
            ))}
            {showGeofences && geofences.map((gf) => (
              <Marker
                key={`gf-marker-${gf.id}`}
                coordinate={gf.center}
                onPress={() => setSelectedGeofence(gf)}
              >
                <View style={styles.markerWithLabel}>
                  <View style={[styles.geofencePin, { borderColor: gf.severity === 'critical' ? '#ef4444' : gf.severity === 'high' ? '#f97316' : '#eab308' }]}>
                    <Text style={{ fontSize: 14 }}>🛡️</Text>
                  </View>
                  <View style={styles.markerNameBadge}>
                    <Text style={styles.markerNameText} numberOfLines={1}>{gf.message.substring(0, 20)}</Text>
                  </View>
                </View>
              </Marker>
            ))}
          </NativeMapView>
        ) : (
          <WebMapView
            responders={filteredResponders}
            incidents={filteredIncidents}
            familyMembers={filteredFamily}
            filter={mapFilter}
            selectedIncident={selectedIncident}
            onSelectIncident={setSelectedIncident}
            userLat={location.latitude}
            userLng={location.longitude}
            gpsAccuracy={location.accuracy}
          />
        )}

        {/* Floating action buttons */}
        <View style={styles.fabContainer}>
          <TouchableOpacity style={styles.fab} onPress={handleCenterOnUser}>
            <Text style={styles.fabText}>📍</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.fab} onPress={handleCenterOnIncidents}>
            <Text style={styles.fabText}>🎯</Text>
          </TouchableOpacity>
          {isPrivileged && (
            <>
              <TouchableOpacity style={[styles.fab, { backgroundColor: '#1e3a5f' }]} onPress={() => setShowGeofenceList(true)}>
                <Text style={styles.fabText}>🛡️</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.fab, { backgroundColor: '#22c55e' }]} onPress={() => { setEditingGeofence(null); setGfMessage(''); setGfRadius('0.5'); setGfSeverity('medium'); setShowGeofenceModal(true); }}>
                <Text style={styles.fabText}>+</Text>
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      {/* Incident Detail Modal */}
      <Modal visible={showIncidentDetail && !!selectedIncident} transparent animationType="slide">
        <View style={idStyles.overlay}>
          <View style={idStyles.card}>
            {selectedIncident && (
              <>
                <View style={idStyles.header}>
                  <View style={idStyles.headerLeft}>
                    <Text style={idStyles.emoji}>{getIncidentEmoji(selectedIncident.type)}</Text>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={idStyles.title}>{selectedIncident.title}</Text>
                        <View style={{ backgroundColor: '#f3f4f6', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 }}>
                          <Text style={{ fontSize: 10, fontWeight: '700', color: '#6b7280', fontFamily: 'monospace' }}>{formatIncidentId(selectedIncident.id)}</Text>
                        </View>
                      </View>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 }}>
                        <View style={[idStyles.severityBadge, { backgroundColor: getSeverityColor(selectedIncident.severity) }]}>
                          <Text style={idStyles.severityText}>{formatSeverityFr(selectedIncident.severity)}</Text>
                        </View>
                        <Text style={idStyles.typeLabel}>{formatIncidentType(selectedIncident.type)}</Text>
                      </View>
                    </View>
                  </View>
                  <TouchableOpacity onPress={() => { setShowIncidentDetail(false); }} style={idStyles.closeBtn}>
                    <Text style={idStyles.closeBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>

                <Text style={idStyles.description}>{selectedIncident.description || 'Aucune description disponible.'}</Text>

                <View style={idStyles.metaRow}>
                  <View style={idStyles.metaItem}>
                    <Text style={idStyles.metaIcon}>📍</Text>
                    <Text style={idStyles.metaText}>Rayon: {selectedIncident.radius}m</Text>
                  </View>
                  <View style={idStyles.metaItem}>
                    <Text style={idStyles.metaIcon}>👥</Text>
                    <Text style={idStyles.metaText}>{selectedIncident.respondingNames && selectedIncident.respondingNames.length > 0 ? selectedIncident.respondingNames.join(', ') : `${selectedIncident.respondersAssigned} assigné(s)`}</Text>
                  </View>
                  <View style={idStyles.metaItem}>
                    <Text style={idStyles.metaIcon}>🕐</Text>
                    <Text style={idStyles.metaText}>{timeAgo(selectedIncident.timestamp)}</Text>
                  </View>
                </View>

                <View style={idStyles.coordRow}>
                  <Text style={idStyles.coordText}>📌 {selectedIncident.latitude.toFixed(5)}, {selectedIncident.longitude.toFixed(5)}</Text>
                </View>

                {/* Action Buttons */}
                <View style={idStyles.actionsContainer}>
                  {isPrivileged && (
                    <TouchableOpacity
                      style={[idStyles.actionBtn, idStyles.ackBtn, actionLoading === 'ack' && { opacity: 0.6 }]}
                      onPress={() => handleAcknowledgeIncident(selectedIncident.id)}
                      disabled={actionLoading === 'ack'}
                    >
                      <Text style={idStyles.actionBtnEmoji}>✅</Text>
                      <Text style={idStyles.ackBtnText}>{actionLoading === 'ack' ? 'En cours...' : 'Acquitter'}</Text>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity
                    style={[idStyles.actionBtn, idStyles.navBtn]}
                    onPress={() => handleNavigateToIncident(selectedIncident)}
                  >
                    <Text style={idStyles.actionBtnEmoji}>🧭</Text>
                    <Text style={idStyles.navBtnText}>Naviguer</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[idStyles.actionBtn, idStyles.contactBtn]}
                    onPress={handleContactDispatch}
                  >
                    <Text style={idStyles.actionBtnEmoji}>📡</Text>
                    <Text style={idStyles.contactBtnText}>Contacter</Text>
                  </TouchableOpacity>
                </View>

                {isPrivileged && (
                  <TouchableOpacity
                    style={[idStyles.resolveBtn, actionLoading === 'resolve' && { opacity: 0.6 }]}
                    onPress={() => handleResolveIncident(selectedIncident.id)}
                    disabled={actionLoading === 'resolve'}
                  >
                    <Text style={idStyles.resolveBtnText}>{actionLoading === 'resolve' ? 'En cours...' : '🏁 Marquer comme résolu'}</Text>
                  </TouchableOpacity>
                )}
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Bottom Legend */}
      <View style={styles.legendContainer}>
        <View style={styles.legendItems}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#ef4444' }]} />
            <Text style={styles.legendText}>Critical</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#f97316' }]} />
            <Text style={styles.legendText}>High</Text>
          </View>
          {isPrivileged ? (
            <>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: '#22c55e' }]} />
                <Text style={styles.legendText}>Available</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: '#f59e0b' }]} />
                <Text style={styles.legendText}>On Duty</Text>
              </View>
            </>
          ) : null}
          {familyLocations.length > 0 && (
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, { backgroundColor: '#3b82f6' }]} />
              <Text style={styles.legendText}>Famille</Text>
            </View>
          )}
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: '#3b82f6' }]} />
            <Text style={styles.legendText}>Vous</Text>
          </View>
        </View>
      </View>
      {/* Geofence Detail Modal */}
      <Modal visible={!!selectedGeofence} transparent animationType="slide">
        <View style={gfStyles.overlay}>
          <View style={gfStyles.card}>
            <View style={gfStyles.header}>
              <Text style={gfStyles.title}>🛡️ Geofence Zone</Text>
              <TouchableOpacity onPress={() => setSelectedGeofence(null)}>
                <Text style={gfStyles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            {selectedGeofence && (
              <>
                <View style={gfStyles.row}>
                  <View style={[gfStyles.severityBadge, { backgroundColor: selectedGeofence.severity === 'critical' ? '#ef4444' : selectedGeofence.severity === 'high' ? '#f97316' : '#eab308' }]}>
                    <Text style={gfStyles.severityText}>{selectedGeofence.severity.toUpperCase()}</Text>
                  </View>
                  <Text style={gfStyles.radius}>{selectedGeofence.radiusKm} km radius</Text>
                </View>
                <Text style={gfStyles.message}>{selectedGeofence.message}</Text>
                <Text style={gfStyles.meta}>Created by {selectedGeofence.createdBy} · {timeAgo(selectedGeofence.createdAt)}</Text>
                <View style={{ flexDirection: 'row', gap: 10 }}>
                  <TouchableOpacity style={[gfStyles.editBtn, { flex: 1 }]} onPress={() => openEditGeofence(selectedGeofence)}>
                    <Text style={gfStyles.editBtnText}>✏️ Edit Zone</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[gfStyles.deleteBtn, { flex: 1 }]} onPress={() => handleDeleteGeofence(selectedGeofence.id)}>
                    <Text style={gfStyles.deleteBtnText}>🗑️ Delete</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Geofence List Modal */}
      <Modal visible={showGeofenceList} transparent animationType="slide">
        <View style={gfStyles.overlay}>
          <View style={gfStyles.card}>
            <View style={gfStyles.header}>
              <Text style={gfStyles.title}>🛡️ Active Zones ({geofences.length})</Text>
              <TouchableOpacity onPress={() => setShowGeofenceList(false)}>
                <Text style={gfStyles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              {geofences.length === 0 ? (
                <Text style={gfStyles.emptyText}>No active geofence zones</Text>
              ) : (
                geofences.map(gf => (
                  <TouchableOpacity key={gf.id} style={gfStyles.listItem} onPress={() => handleCenterOnGeofence(gf)}>
                    <View style={[gfStyles.listSeverityDot, { backgroundColor: gf.severity === 'critical' ? '#ef4444' : gf.severity === 'high' ? '#f97316' : gf.severity === 'medium' ? '#eab308' : '#22c55e' }]} />
                    <View style={gfStyles.listItemInfo}>
                      <Text style={gfStyles.listItemTitle} numberOfLines={1}>{gf.message}</Text>
                      <Text style={gfStyles.listItemMeta}>{gf.severity.toUpperCase()} · {gf.radiusKm}km · by {gf.createdBy}</Text>
                    </View>
                    <View style={gfStyles.listItemActions}>
                      <TouchableOpacity onPress={() => { setShowGeofenceList(false); openEditGeofence(gf); }} style={gfStyles.listActionBtn}>
                        <Text style={{ fontSize: 14 }}>✏️</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => { setShowGeofenceList(false); handleDeleteGeofence(gf.id); }} style={gfStyles.listActionBtn}>
                        <Text style={{ fontSize: 14 }}>🗑️</Text>
                      </TouchableOpacity>
                    </View>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
            <TouchableOpacity
              style={gfStyles.createBtn}
              onPress={() => { setShowGeofenceList(false); setEditingGeofence(null); setGfMessage(''); setGfRadius('0.5'); setGfSeverity('medium'); setShowGeofenceModal(true); }}
            >
              <Text style={gfStyles.createBtnText}>+ New Zone</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Create/Edit Geofence Modal */}
      <Modal visible={showGeofenceModal} transparent animationType="slide">
        <View style={gfStyles.overlay}>
          <View style={gfStyles.card}>
            <View style={gfStyles.header}>
              <Text style={gfStyles.title}>{editingGeofence ? '✏️ Edit Geofence' : '🛡️ New Geofence Zone'}</Text>
              <TouchableOpacity onPress={() => { setShowGeofenceModal(false); setEditingGeofence(null); }}>
                <Text style={gfStyles.closeBtn}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 400 }}>
              <Text style={gfStyles.label}>Description *</Text>
              <TextInput
                style={gfStyles.input}
                value={gfMessage}
                onChangeText={setGfMessage}
                placeholder="e.g. Flood risk zone - avoid area"
                multiline
              />
              <Text style={gfStyles.label}>Radius (km)</Text>
              <View style={gfStyles.radiusRow}>
                {['0.25', '0.5', '1', '2', '5'].map((r) => (
                  <TouchableOpacity
                    key={r}
                    style={[gfStyles.radiusChip, gfRadius === r && gfStyles.radiusChipActive]}
                    onPress={() => setGfRadius(r)}
                  >
                    <Text style={[gfStyles.radiusChipText, gfRadius === r && gfStyles.radiusChipTextActive]}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={gfStyles.label}>Severity</Text>
              <View style={gfStyles.radiusRow}>
                {(['low', 'medium', 'high', 'critical'] as const).map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={[gfStyles.radiusChip, gfSeverity === s && { backgroundColor: s === 'critical' ? '#ef4444' : s === 'high' ? '#f97316' : s === 'medium' ? '#eab308' : '#22c55e' }]}
                    onPress={() => setGfSeverity(s)}
                  >
                    <Text style={[gfStyles.radiusChipText, gfSeverity === s && { color: '#fff' }]}>{s.charAt(0).toUpperCase() + s.slice(1)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={gfStyles.hint}>
                {editingGeofence
                  ? `Zone center: ${editingGeofence.center.latitude.toFixed(4)}, ${editingGeofence.center.longitude.toFixed(4)}`
                  : `Zone will be centered on your current location (${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)})`}
              </Text>
            </ScrollView>
            <TouchableOpacity
              style={[gfStyles.createBtn, gfCreating && { opacity: 0.6 }]}
              onPress={handleSaveGeofence}
              disabled={gfCreating}
            >
              <Text style={gfStyles.createBtnText}>{gfCreating ? 'Saving...' : editingGeofence ? '✏️ Update Zone' : '🛡️ Create Zone'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </TalionScreen>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  gpsBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#f0f9ff',
    borderBottomWidth: 1,
    borderBottomColor: '#bfdbfe',
  },
  gpsStatus: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gpsDot: { width: 8, height: 8, borderRadius: 4 },
  gpsText: { fontSize: 12, fontWeight: '600', color: '#1e3a5f' },
  gpsAccuracy: { fontSize: 10, color: '#6b7280', marginLeft: 4 },
  gpsAddress: { fontSize: 11, color: '#6b7280', flex: 1, textAlign: 'right', marginLeft: 8 },
  statsBar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: '#f8fafc',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  statItem: { flexDirection: 'row', alignItems: 'center' },
  statDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  statText: { fontSize: 12, fontWeight: '600', color: '#374151' },
  filterBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#ffffff',
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    gap: 8,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: '#f3f4f6',
    gap: 6,
  },
  filterButtonActive: { backgroundColor: '#1e3a5f' },
  filterText: { fontSize: 13, fontWeight: '600', color: '#6b7280' },
  filterTextActive: { color: '#ffffff' },
  filterBadge: {
    backgroundColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 20,
    alignItems: 'center',
  },
  filterBadgeActive: { backgroundColor: 'rgba(255,255,255,0.25)' },
  filterBadgeText: { fontSize: 11, fontWeight: '700', color: '#6b7280' },
  filterBadgeTextActive: { color: '#ffffff' },
  searchBarContainer: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    zIndex: 10,
  },
  searchInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#1f2937',
    paddingVertical: 2,
  },
  searchDropdown: {
    position: 'absolute',
    top: 46,
    left: 12,
    right: 12,
    backgroundColor: '#ffffff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 8,
    elevation: 8,
    zIndex: 20,
    maxHeight: 240,
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
    gap: 10,
  },
  searchResultIcon: { fontSize: 16 },
  searchResultName: { fontSize: 13, fontWeight: '600', color: '#1f2937' },
  searchResultType: { fontSize: 11, color: '#6b7280', textTransform: 'capitalize' },
  mapContainer: { flex: 1, position: 'relative' },
  responderPin: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#ffffff',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 3,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 4,
  },
  markerWithLabel: { alignItems: 'center' },
  markerNameBadge: {
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    marginTop: 2,
    maxWidth: 100,
  },
  markerNameText: {
    color: '#ffffff',
    fontSize: 9,
    fontWeight: '600',
    textAlign: 'center',
  },
  callout: { padding: 8, minWidth: 180, maxWidth: 250 },
  calloutTitle: { fontSize: 14, fontWeight: '700', color: '#1f2937', marginBottom: 4 },
  calloutSeverity: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, marginBottom: 4 },
  calloutSeverityText: { color: '#ffffff', fontSize: 10, fontWeight: '700' },
  calloutDesc: { fontSize: 12, color: '#6b7280', marginBottom: 4 },
  calloutMeta: { fontSize: 11, color: '#9ca3af' },
  fabContainer: { position: 'absolute', right: 16, bottom: 16, gap: 10 },
  fab: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#ffffff',
    justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 4, elevation: 4,
  },
  fabText: { fontSize: 20 },
  typeFilterBar: {
    backgroundColor: '#ffffff',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  typeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    gap: 4,
  },
  typeChipActive: {
    backgroundColor: '#1e3a5f',
    borderColor: '#1e3a5f',
  },
  typeChipEmoji: { fontSize: 12 },
  typeChipText: { fontSize: 11, fontWeight: '600', color: '#6b7280' },
  typeChipTextActive: { color: '#ffffff' },
  typeChipCount: { fontSize: 10, fontWeight: '700', color: '#9ca3af', marginLeft: 2 },
  typeChipCountActive: { color: 'rgba(255,255,255,0.7)' },
  legendContainer: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  legendItems: { flexDirection: 'row', justifyContent: 'space-around' },
  legendItem: { flexDirection: 'row', alignItems: 'center' },
  legendDot: { width: 8, height: 8, borderRadius: 4, marginRight: 4 },
  legendText: { fontSize: 11, color: '#6b7280' },
  geofencePin: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#ffffff',
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 3,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 4,
  },
});

// ─── Incident Detail Modal Styles ────────────────────────────────────────────────────────
const idStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  card: { backgroundColor: '#ffffff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '75%' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 },
  emoji: { fontSize: 36 },
  title: { fontSize: 18, fontWeight: '700', color: '#1f2937' },
  severityBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 6 },
  severityText: { color: '#ffffff', fontSize: 11, fontWeight: '700' },
  typeLabel: { fontSize: 13, color: '#6b7280', fontWeight: '500' },
  closeBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#f3f4f6', justifyContent: 'center', alignItems: 'center' },
  closeBtnText: { fontSize: 16, color: '#6b7280', fontWeight: '700' },
  description: { fontSize: 14, color: '#4b5563', lineHeight: 20, marginBottom: 12 },
  metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginBottom: 8 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaIcon: { fontSize: 14 },
  metaText: { fontSize: 12, color: '#6b7280' },
  coordRow: { marginBottom: 16, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: '#f9fafb', borderRadius: 8 },
  coordText: { fontSize: 12, color: '#9ca3af', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  actionsContainer: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  actionBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12, borderRadius: 12, gap: 6 },
  actionBtnEmoji: { fontSize: 16 },
  ackBtn: { backgroundColor: '#f0fdf4', borderWidth: 1, borderColor: '#bbf7d0' },
  ackBtnText: { fontSize: 13, fontWeight: '600', color: '#16a34a' },
  navBtn: { backgroundColor: '#eff6ff', borderWidth: 1, borderColor: '#bfdbfe' },
  navBtnText: { fontSize: 13, fontWeight: '600', color: '#2563eb' },
  contactBtn: { backgroundColor: '#fef3c7', borderWidth: 1, borderColor: '#fde68a' },
  contactBtnText: { fontSize: 13, fontWeight: '600', color: '#d97706' },
  resolveBtn: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  resolveBtnText: { fontSize: 15, fontWeight: '600', color: '#dc2626' },
});

// ─── Geofence Modal Styles ─────────────────────────────────────────────────────────────
const gfStyles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  card: { backgroundColor: '#ffffff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '70%' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '700', color: '#1f2937' },
  closeBtn: { fontSize: 20, color: '#6b7280', padding: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
  severityBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  severityText: { color: '#ffffff', fontSize: 12, fontWeight: '700' },
  radius: { fontSize: 14, color: '#6b7280' },
  message: { fontSize: 15, color: '#1f2937', marginBottom: 8, lineHeight: 22 },
  meta: { fontSize: 12, color: '#9ca3af', marginBottom: 16 },
  deleteBtn: { backgroundColor: '#fef2f2', borderWidth: 1, borderColor: '#fecaca', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  deleteBtnText: { fontSize: 15, fontWeight: '600', color: '#ef4444' },
  editBtn: { backgroundColor: '#f0f9ff', borderWidth: 1, borderColor: '#bfdbfe', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  editBtnText: { fontSize: 15, fontWeight: '600', color: '#2563eb' },
  emptyText: { textAlign: 'center', color: '#9ca3af', fontSize: 14, paddingVertical: 30 },
  listItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 10 },
  listSeverityDot: { width: 12, height: 12, borderRadius: 6 },
  listItemInfo: { flex: 1 },
  listItemTitle: { fontSize: 14, fontWeight: '600', color: '#1f2937' },
  listItemMeta: { fontSize: 11, color: '#6b7280', marginTop: 2 },
  listItemActions: { flexDirection: 'row', gap: 8 },
  listActionBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#f3f4f6', justifyContent: 'center', alignItems: 'center' },
  label: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 6, marginTop: 12 },
  input: { backgroundColor: '#f3f4f6', borderRadius: 10, padding: 12, fontSize: 14, color: '#1f2937', minHeight: 60, textAlignVertical: 'top' },
  radiusRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  radiusChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, backgroundColor: '#f3f4f6' },
  radiusChipActive: { backgroundColor: '#1e3a5f' },
  radiusChipText: { fontSize: 13, fontWeight: '600', color: '#6b7280' },
  radiusChipTextActive: { color: '#ffffff' },
  hint: { fontSize: 11, color: '#9ca3af', marginTop: 12, textAlign: 'center' },
  createBtn: { backgroundColor: '#1e3a5f', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16 },
  createBtnText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
});

// ─── Web Fallback Styles ────────────────────────────────────────────────────
const webStyles = StyleSheet.create({
  container: { flex: 1, position: 'relative' },
  mapArea: { flex: 1, backgroundColor: '#dce8f0', position: 'relative', overflow: 'hidden' },
  gridOverlay: { ...StyleSheet.absoluteFillObject },
  gridLine: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: '#c8d6e0' },
  gridLineV: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: '#c8d6e0' },
  incidentMarker: { position: 'absolute', alignItems: 'center', zIndex: 10 },
  selectedMarker: { zIndex: 20 },
  incidentPulse: { position: 'absolute', width: 60, height: 60, borderRadius: 30, top: -18 },
  incidentDot: {
    width: 32, height: 32, borderRadius: 16,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2, borderColor: '#ffffff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 3, elevation: 4,
  },
  markerEmoji: { fontSize: 14 },
  markerLabel: {
    fontSize: 9, fontWeight: '700', color: '#1f2937',
    backgroundColor: 'rgba(255,255,255,0.9)',
    paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3, marginTop: 2, textAlign: 'center',
  },
  responderMarker: { position: 'absolute', alignItems: 'center', zIndex: 5 },
  responderDot: {
    width: 28, height: 28, borderRadius: 14,
    justifyContent: 'center', alignItems: 'center',
    borderWidth: 2,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.2, shadowRadius: 2, elevation: 3,
  },
  responderEmoji: { fontSize: 12 },
  responderLabel: {
    fontSize: 8, fontWeight: '600', color: '#374151',
    backgroundColor: 'rgba(255,255,255,0.85)',
    paddingHorizontal: 3, paddingVertical: 1, borderRadius: 2, marginTop: 1,
  },
  userMarker: { position: 'absolute', alignItems: 'center', justifyContent: 'center', zIndex: 15 },
  accuracyCircle: { position: 'absolute', backgroundColor: 'rgba(59, 130, 246, 0.1)', borderWidth: 1, borderColor: 'rgba(59, 130, 246, 0.3)' },
  userPulse: { position: 'absolute', width: 32, height: 32, borderRadius: 16, backgroundColor: 'rgba(59, 130, 246, 0.2)' },
  userDot: {
    width: 14, height: 14, borderRadius: 7,
    backgroundColor: '#3b82f6', borderWidth: 2, borderColor: '#ffffff',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 2, elevation: 3,
  },
  incidentDetail: {
    position: 'absolute', bottom: 12, left: 12, right: 12,
    backgroundColor: '#ffffff', borderRadius: 12, padding: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6,
  },
  detailHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  detailEmoji: { fontSize: 28, marginRight: 10 },
  detailInfo: { flex: 1 },
  detailTitle: { fontSize: 15, fontWeight: '700', color: '#1f2937', marginBottom: 3 },
  severityBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  severityText: { color: '#ffffff', fontSize: 10, fontWeight: '700' },
  closeButton: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: '#f3f4f6', justifyContent: 'center', alignItems: 'center',
  },
  closeText: { fontSize: 14, color: '#6b7280', fontWeight: '700' },
  detailDescription: { fontSize: 13, color: '#6b7280', marginBottom: 8, lineHeight: 18 },
  detailMeta: { flexDirection: 'row', gap: 12 },
  detailMetaText: { fontSize: 11, color: '#9ca3af' },
});
