import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, FlatList, Alert,
  TextInput, Modal, ActivityIndicator, Platform, RefreshControl,
  StyleSheet, Keyboard,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/hooks/useAuth';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { useLocation } from '@/lib/location-context';
import NativeMapView, { Marker, Circle, isNativeMap } from '@/components/map-view';
import { websocketService } from '@/services/websocket';
import * as Haptics from 'expo-haptics';

// ─── Types ──────────────────────────────────────────────────────────────────

interface FamilyMember {
  userId: string;
  name: string;
  email: string;
  relationship: string;
  location: { latitude: number; longitude: number } | null;
  isSharing: boolean;
  lastSeen: number | null;
}

interface FamilyPerimeter {
  id: string;
  ownerId: string;
  targetUserId: string;
  targetUserName: string;
  center: { latitude: number; longitude: number; address?: string };
  radiusMeters: number;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ProximityAlert {
  id: string;
  perimeterId: string;
  targetUserId: string;
  targetUserName: string;
  ownerId: string;
  eventType: 'exit' | 'entry' | 'curfew_violation';
  distanceMeters: number;
  location: { latitude: number; longitude: number };
  timestamp: number;
  acknowledged: boolean;
  curfewResult?: 'inside' | 'outside';
}

interface CurfewCheck {
  id: string;
  ownerId: string;
  targetUserId: string;
  targetUserName: string;
  center: { latitude: number; longitude: number; address?: string };
  radiusMeters: number;
  hour: number;
  minute: number;
  recurrence: 'once' | 'daily';
  alertWhen: 'exit' | 'entry' | 'both';
  nextCheckAt: number;
  active: boolean;
  lastFiredAt?: number;
  lastResult?: 'inside' | 'outside';
}

interface LocationHistoryEntry {
  userId: string;
  latitude: number;
  longitude: number;
  timestamp: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function timeAgo(ts: number | null): string {
  if (!ts) return 'Jamais';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'À l\'instant';
  if (diff < 3600000) return `Il y a ${Math.floor(diff / 60000)} min`;
  if (diff < 86400000) return `Il y a ${Math.floor(diff / 3600000)}h`;
  return `Il y a ${Math.floor(diff / 86400000)}j`;
}

type Staleness = 'fresh' | 'aging' | 'stale';

function stalenessLevel(ts: number | null): Staleness {
  if (!ts) return 'stale';
  const diff = Date.now() - ts;
  if (diff < 5 * 60 * 1000) return 'fresh';
  if (diff < 30 * 60 * 1000) return 'aging';
  return 'stale';
}

const STALENESS_COLOR: Record<Staleness, string> = {
  fresh: '#22C55E',
  aging: '#EAB308',
  stale: '#9CA3AF',
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function relationLabel(type: string): string {
  const labels: Record<string, string> = {
    parent: 'Parent',
    child: 'Enfant',
    sibling: 'Frère/Sœur',
    spouse: 'Conjoint(e)',
  };
  return labels[type] || type;
}

// ─── Tabs ───────────────────────────────────────────────────────────────────

type TabKey = 'members' | 'perimeters' | 'alerts';

// ─── Main Component ─────────────────────────────────────────────────────────

export default function FamilyScreen() {
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<TabKey>('members');
  const [members, setMembers] = useState<FamilyMember[]>([]);
  const [resolvedAddresses, setResolvedAddresses] = useState<Record<string, string>>({});
  const [perimeters, setPerimeters] = useState<FamilyPerimeter[]>([]);
  const [proxAlerts, setProxAlerts] = useState<ProximityAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Modals
  const [selectedMember, setSelectedMember] = useState<FamilyMember | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<LocationHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Perimeter creation
  const [showCreatePerimeter, setShowCreatePerimeter] = useState(false);
  const [perimeterTarget, setPerimeterTarget] = useState<FamilyMember | null>(null);
  const [perimeterRadius, setPerimeterRadius] = useState('500');
  const [perimeterAddress, setPerimeterAddress] = useState('');
  const [perimeterSaving, setPerimeterSaving] = useState(false);

  // Curfew check creation — shares the address search/GPS/radius state above with
  // the perimeter modal (the two are never open at the same time).
  const [curfewChecksList, setCurfewChecksList] = useState<CurfewCheck[]>([]);
  const [showCreateCurfew, setShowCreateCurfew] = useState(false);
  const [curfewTarget, setCurfewTarget] = useState<FamilyMember | null>(null);
  const [curfewHour, setCurfewHour] = useState('21');
  const [curfewMinute, setCurfewMinute] = useState('00');
  const [curfewRecurrence, setCurfewRecurrence] = useState<'once' | 'daily'>('once');
  const [curfewAlertWhen, setCurfewAlertWhen] = useState<'exit' | 'entry' | 'both'>('exit');
  const [curfewSaving, setCurfewSaving] = useState(false);

  // Address autocomplete
  const [addressSuggestions, setAddressSuggestions] = useState<Array<{ display_name: string; lat: string; lon: string }>>([]);
  const [addressSearching, setAddressSearching] = useState(false);
  const addressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [perimeterCenter, setPerimeterCenter] = useState<{ latitude: number; longitude: number } | null>(null);
  const [gpsLoading, setGpsLoading] = useState(false);

  const BASE = getApiBaseUrl();
  const userId = user?.id;

  // Location context for "Use my position" button
  const locationCtx = useLocation();

  // ─── Reverse-geocode each member's current position for display ───────
  // Keyed by "userId:lat,lng" (rounded) so a 30s poll that hasn't materially
  // moved the member doesn't trigger a redundant on-device geocode call.
  const resolvedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!locationCtx) return;
    members.forEach(m => {
      if (!m.location) return;
      const key = `${m.userId}:${m.location.latitude.toFixed(4)},${m.location.longitude.toFixed(4)}`;
      if (resolvedKeysRef.current.has(key)) return;
      resolvedKeysRef.current.add(key);
      locationCtx.reverseGeocode(m.location.latitude, m.location.longitude)
        .then(addr => {
          if (addr) setResolvedAddresses(prev => ({ ...prev, [m.userId]: addr }));
        })
        .catch(() => { /* fall back to raw coordinates in the render */ });
    });
  }, [members, locationCtx]);

  // ─── Address Autocomplete ──────────────────────────────────────────────

  const searchAddress = useCallback(async (query: string) => {
    if (query.length < 3) {
      setAddressSuggestions([]);
      return;
    }
    setAddressSearching(true);
    try {
      const res = await fetch(`${BASE}/api/geocode?q=${encodeURIComponent(query)}`);
      if (res.ok) {
        const data = await res.json();
        setAddressSuggestions(Array.isArray(data) ? data.slice(0, 5) : []);
      }
    } catch (e) {
      console.warn('[Family] Geocode error:', e);
    }
    setAddressSearching(false);
  }, [BASE]);

  const handleAddressChange = useCallback((text: string) => {
    setPerimeterAddress(text);
    // Reset manual center when user types a new address
    if (addressTimerRef.current) clearTimeout(addressTimerRef.current);
    addressTimerRef.current = setTimeout(() => {
      searchAddress(text);
    }, 400);
  }, [searchAddress]);

  const selectSuggestion = useCallback((suggestion: { display_name: string; lat: string; lon: string }) => {
    setPerimeterAddress(suggestion.display_name);
    setPerimeterCenter({ latitude: parseFloat(suggestion.lat), longitude: parseFloat(suggestion.lon) });
    setAddressSuggestions([]);
    Keyboard.dismiss();
  }, []);

  // ─── Use My Current Position ───────────────────────────────────────────

  const useMyPosition = useCallback(async () => {
    if (!locationCtx) {
      Alert.alert('Erreur', 'Service de localisation non disponible');
      return;
    }
    setGpsLoading(true);
    try {
      const pos = await locationCtx.getCurrentPosition();
      if (pos.latitude && pos.longitude) {
        setPerimeterCenter({ latitude: pos.latitude, longitude: pos.longitude });
        // Try to reverse geocode for a readable address
        try {
          const addr = await locationCtx.reverseGeocode(pos.latitude, pos.longitude);
          if (addr) setPerimeterAddress(addr);
          else setPerimeterAddress(`${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`);
        } catch {
          setPerimeterAddress(`${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`);
        }
        setAddressSuggestions([]);
        if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        Alert.alert('Erreur', 'Impossible d\'obtenir votre position GPS');
      }
    } catch (e) {
      Alert.alert('Erreur', 'Impossible d\'obtenir votre position GPS');
    }
    setGpsLoading(false);
  }, [locationCtx]);

  // ─── Data Fetching ──────────────────────────────────────────────────────

  const fetchMembers = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetchWithTimeout(`${BASE}/api/family/members?userId=${userId}`, { timeout: 10000 });
      const data = await res.json();
      setMembers(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('[Family] Error fetching members:', e);
    }
  }, [BASE, userId]);

  const fetchPerimeters = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetchWithTimeout(`${BASE}/api/family/perimeters?userId=${userId}`, { timeout: 10000 });
      const data = await res.json();
      setPerimeters(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('[Family] Error fetching perimeters:', e);
    }
  }, [BASE, userId]);

  const fetchProxAlerts = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetchWithTimeout(`${BASE}/api/family/proximity-alerts?userId=${userId}&limit=50`, { timeout: 10000 });
      const data = await res.json();
      setProxAlerts(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('[Family] Error fetching proximity alerts:', e);
    }
  }, [BASE, userId]);

  const fetchCurfewChecks = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetchWithTimeout(`${BASE}/api/family/curfew-checks?userId=${userId}`, { timeout: 10000 });
      const data = await res.json();
      setCurfewChecksList(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('[Family] Error fetching curfew checks:', e);
    }
  }, [BASE, userId]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([fetchMembers(), fetchPerimeters(), fetchProxAlerts(), fetchCurfewChecks()]);
    setLoading(false);
  }, [fetchMembers, fetchPerimeters, fetchProxAlerts, fetchCurfewChecks]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([fetchMembers(), fetchPerimeters(), fetchProxAlerts(), fetchCurfewChecks()]);
    setRefreshing(false);
  }, [fetchMembers, fetchPerimeters, fetchProxAlerts, fetchCurfewChecks]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Auto-refresh every 30s (fallback/initial-load — live updates arrive via WS below)
  useEffect(() => {
    const interval = setInterval(() => {
      fetchMembers();
      fetchProxAlerts();
      fetchCurfewChecks();
    }, 30000);
    return () => clearInterval(interval);
  }, [fetchMembers, fetchProxAlerts, fetchCurfewChecks]);

  // Live position updates: the server already broadcasts `familyLocationUpdate` to
  // every family member on each location ping (server/index.ts handleLocationUpdate) —
  // this app just wasn't listening for it yet, relying only on the 30s poll above.
  useEffect(() => {
    const handleFamilyLocation = (data: any) => {
      const loc = data?.data || data;
      if (!loc?.userId || !loc?.location) return;
      setMembers(prev => prev.map(m =>
        m.userId === loc.userId
          ? { ...m, location: { latitude: loc.location.latitude, longitude: loc.location.longitude }, lastSeen: loc.timestamp || Date.now() }
          : m
      ));
    };
    websocketService.on('familyLocation', handleFamilyLocation);
    return () => websocketService.off('familyLocation', handleFamilyLocation);
  }, []);

  // ─── Location History ───────────────────────────────────────────────────

  const openHistory = useCallback(async (member: FamilyMember) => {
    setSelectedMember(member);
    setShowHistory(true);
    setHistoryLoading(true);
    try {
      const since = Date.now() - 24 * 60 * 60 * 1000; // last 24h
      const res = await fetchWithTimeout(
        `${BASE}/api/family/location-history?userId=${userId}&targetUserId=${member.userId}&since=${since}`,
        { timeout: 10000 }
      );
      const data = await res.json();
      setHistory(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('[Family] Error fetching history:', e);
      setHistory([]);
    }
    setHistoryLoading(false);
  }, [BASE, userId]);

  // ─── Perimeter CRUD ─────────────────────────────────────────────────────

  const createPerimeter = useCallback(async () => {
    if (!perimeterTarget || !userId) return;
    const radius = parseInt(perimeterRadius, 10);
    if (isNaN(radius) || radius < 50 || radius > 50000) {
      Alert.alert('Erreur', 'Le rayon doit être entre 50m et 50km');
      return;
    }
    // Use selected address center, member's current location, or Geneva/Champel default
    const center = perimeterCenter || perimeterTarget.location || { latitude: 46.1950, longitude: 6.1580 };
    setPerimeterSaving(true);
    try {
      const res = await fetchWithTimeout(`${BASE}/api/family/perimeters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerId: userId,
          targetUserId: perimeterTarget.userId,
          center: { ...center, address: perimeterAddress || undefined },
          radiusMeters: radius,
        }),
        timeout: 10000,
      });
      if (res.ok) {
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setShowCreatePerimeter(false);
        setPerimeterTarget(null);
        setPerimeterRadius('500');
        setPerimeterAddress('');
        setPerimeterCenter(null);
        setAddressSuggestions([]);
        fetchPerimeters();
      } else {
        const err = await res.json();
        Alert.alert('Erreur', err.error || 'Impossible de créer le périmètre');
      }
    } catch (e) {
      Alert.alert('Erreur', 'Erreur réseau');
    }
    setPerimeterSaving(false);
  }, [BASE, userId, perimeterTarget, perimeterRadius, perimeterAddress, fetchPerimeters]);

  const togglePerimeter = useCallback(async (perimeter: FamilyPerimeter) => {
    try {
      await fetchWithTimeout(`${BASE}/api/family/perimeters/${perimeter.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !perimeter.active }),
        timeout: 10000,
      });
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      fetchPerimeters();
    } catch (e) {
      console.error('[Family] Error toggling perimeter:', e);
    }
  }, [BASE, fetchPerimeters]);

  const deletePerimeter = useCallback(async (perimeter: FamilyPerimeter) => {
    Alert.alert(
      'Supprimer le périmètre',
      `Supprimer le périmètre pour ${perimeter.targetUserName} ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer', style: 'destructive', onPress: async () => {
            try {
              await fetchWithTimeout(`${BASE}/api/family/perimeters/${perimeter.id}`, {
                method: 'DELETE', timeout: 10000,
              });
              if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              fetchPerimeters();
            } catch (e) {
              console.error('[Family] Error deleting perimeter:', e);
            }
          }
        },
      ]
    );
  }, [BASE, fetchPerimeters]);

  // ─── Curfew Check CRUD ──────────────────────────────────────────────────

  const createCurfewCheck = useCallback(async () => {
    if (!curfewTarget || !userId) return;
    const radius = parseInt(perimeterRadius, 10);
    if (isNaN(radius) || radius < 50 || radius > 50000) {
      Alert.alert('Erreur', 'Le rayon doit être entre 50m et 50km');
      return;
    }
    const hour = parseInt(curfewHour, 10);
    const minute = parseInt(curfewMinute, 10);
    if (isNaN(hour) || hour < 0 || hour > 23 || isNaN(minute) || minute < 0 || minute > 59) {
      Alert.alert('Erreur', 'Heure invalide');
      return;
    }
    const center = perimeterCenter || curfewTarget.location || { latitude: 46.1950, longitude: 6.1580 };
    setCurfewSaving(true);
    try {
      const res = await fetchWithTimeout(`${BASE}/api/family/curfew-checks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ownerId: userId,
          targetUserId: curfewTarget.userId,
          center: { ...center, address: perimeterAddress || undefined },
          radiusMeters: radius,
          hour, minute,
          recurrence: curfewRecurrence,
          alertWhen: curfewAlertWhen,
        }),
        timeout: 10000,
      });
      if (res.ok) {
        if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        setShowCreateCurfew(false);
        setCurfewTarget(null);
        setPerimeterCenter(null);
        setPerimeterAddress('');
        setAddressSuggestions([]);
        fetchCurfewChecks();
      } else {
        const err = await res.json();
        Alert.alert('Erreur', err.error || 'Impossible de créer l\'alerte');
      }
    } catch (e) {
      Alert.alert('Erreur', 'Erreur réseau');
    }
    setCurfewSaving(false);
  }, [BASE, userId, curfewTarget, perimeterRadius, perimeterCenter, perimeterAddress, curfewHour, curfewMinute, curfewRecurrence, curfewAlertWhen, fetchCurfewChecks]);

  const cancelCurfewCheck = useCallback(async (check: CurfewCheck) => {
    try {
      await fetchWithTimeout(`${BASE}/api/family/curfew-checks/${check.id}`, { method: 'DELETE', timeout: 10000 });
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      fetchCurfewChecks();
    } catch (e) {
      console.error('[Family] Error cancelling curfew check:', e);
    }
  }, [BASE, fetchCurfewChecks]);

  // ─── Acknowledge Alert ──────────────────────────────────────────────────

  const acknowledgeAlert = useCallback(async (alertId: string) => {
    try {
      await fetchWithTimeout(`${BASE}/api/family/proximity-alerts/${alertId}/acknowledge`, {
        method: 'PUT', timeout: 10000,
      });
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      fetchProxAlerts();
    } catch (e) {
      console.error('[Family] Error acknowledging alert:', e);
    }
  }, [BASE, fetchProxAlerts]);

  // ─── Render Helpers ─────────────────────────────────────────────────────

  // Persistent map above the members list — native only; on web the member cards
  // below already show a resolved address + freshness, so a redundant fallback
  // map isn't worth the complexity (family.tsx keeps its web fallbacks simple).
  const renderFamilyMap = () => {
    if (!isNativeMap) return null;
    const withLocation = members.filter(m => m.location);
    if (withLocation.length === 0) return null;

    const lats = withLocation.map(m => m.location!.latitude);
    const lngs = withLocation.map(m => m.location!.longitude);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);

    return (
      <View style={styles.familyMapContainer}>
        <NativeMapView
          initialRegion={{
            latitude: (minLat + maxLat) / 2,
            longitude: (minLng + maxLng) / 2,
            latitudeDelta: Math.max(0.01, (maxLat - minLat) * 1.5),
            longitudeDelta: Math.max(0.01, (maxLng - minLng) * 1.5),
          }}
          showsUserLocation={false}
          showsMyLocationButton={false}
          showsCompass={false}
          style={styles.familyMap}
        >
          {withLocation.map(m => (
            <Marker
              key={m.userId}
              coordinate={m.location!}
              title={m.name}
              pinColor={STALENESS_COLOR[stalenessLevel(m.lastSeen)]}
            />
          ))}
          {perimeters.filter(p => p.active).map(p => (
            <Circle
              key={p.id}
              center={p.center}
              radius={p.radiusMeters}
              fillColor="rgba(30, 58, 95, 0.15)"
              strokeColor="#1e3a5f"
              strokeWidth={2}
            />
          ))}
        </NativeMapView>
      </View>
    );
  };

  const renderMemberCard = ({ item }: { item: FamilyMember }) => {
    const staleness = stalenessLevel(item.lastSeen);
    const stalenessColor = STALENESS_COLOR[staleness];
    return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.avatarCircle}>
          <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardTitle}>{item.name}</Text>
          <Text style={styles.cardSubtitle}>{relationLabel(item.relationship)}</Text>
        </View>
        <View style={styles.statusBadge}>
          <View style={[styles.statusDot, { backgroundColor: item.isSharing ? '#22C55E' : '#9CA3AF' }]} />
          <Text style={[styles.statusText, { color: item.isSharing ? '#22C55E' : '#9CA3AF' }]}>
            {item.isSharing ? 'En ligne' : 'Hors ligne'}
          </Text>
        </View>
      </View>

      {item.location && (
        <View style={styles.locationRow}>
          <IconSymbol name="location.fill" size={14} color={stalenessColor} />
          <Text style={styles.locationText}>
            {resolvedAddresses[item.userId] || `${item.location.latitude.toFixed(4)}, ${item.location.longitude.toFixed(4)}`}
          </Text>
          <Text style={[styles.timeText, { color: stalenessColor }]}>{timeAgo(item.lastSeen)}</Text>
        </View>
      )}

      <View style={styles.cardActions}>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => openHistory(item)}
        >
          <IconSymbol name="clock.fill" size={16} color="#1e3a5f" />
          <Text style={styles.actionBtnText}>Historique</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => {
            setPerimeterTarget(item);
            setShowCreatePerimeter(true);
          }}
        >
          <IconSymbol name="plus.circle.fill" size={16} color="#1e3a5f" />
          <Text style={styles.actionBtnText}>Périmètre</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => {
            const existing = perimeters.find(p => p.targetUserId === item.userId && p.active);
            setCurfewTarget(item);
            setPerimeterAddress(existing?.center.address || '');
            setPerimeterCenter(existing ? { latitude: existing.center.latitude, longitude: existing.center.longitude } : null);
            setPerimeterRadius(existing ? String(existing.radiusMeters) : '500');
            setCurfewHour('21');
            setCurfewMinute('00');
            setCurfewRecurrence('once');
            setCurfewAlertWhen('exit');
            setShowCreateCurfew(true);
          }}
        >
          <IconSymbol name="bell.fill" size={16} color="#1e3a5f" />
          <Text style={styles.actionBtnText}>Couvre-feu</Text>
        </TouchableOpacity>
      </View>
    </View>
    );
  };

  const renderPerimeterCard = ({ item }: { item: FamilyPerimeter }) => (
    <View style={[styles.card, !item.active && styles.cardInactive]}>
      <View style={styles.cardHeader}>
        <View style={[styles.avatarCircle, { backgroundColor: item.active ? '#1e3a5f' : '#9CA3AF' }]}>
          <IconSymbol name="location.fill" size={18} color="#fff" />
        </View>
        <View style={styles.cardInfo}>
          <Text style={styles.cardTitle}>{item.targetUserName}</Text>
          <Text style={styles.cardSubtitle}>
            Rayon: {item.radiusMeters >= 1000 ? `${(item.radiusMeters / 1000).toFixed(1)}km` : `${item.radiusMeters}m`}
            {item.center.address ? ` • ${item.center.address}` : ''}
          </Text>
        </View>
      </View>

      <View style={styles.cardActions}>
        <TouchableOpacity
          style={[styles.actionBtn, item.active ? styles.actionBtnActive : styles.actionBtnInactive]}
          onPress={() => togglePerimeter(item)}
        >
          <IconSymbol name={item.active ? 'checkmark.circle.fill' : 'xmark.circle.fill'} size={16} color={item.active ? '#22C55E' : '#9CA3AF'} />
          <Text style={[styles.actionBtnText, { color: item.active ? '#22C55E' : '#9CA3AF' }]}>
            {item.active ? 'Actif' : 'Inactif'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionBtn}
          onPress={() => deletePerimeter(item)}
        >
          <IconSymbol name="trash.fill" size={16} color="#EF4444" />
          <Text style={[styles.actionBtnText, { color: '#EF4444' }]}>Supprimer</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.timestampText}>Créé le {formatDate(item.createdAt)}</Text>
    </View>
  );

  const renderAlertCard = ({ item }: { item: ProximityAlert }) => {
    const isExit = item.eventType === 'exit';
    const isCurfew = item.eventType === 'curfew_violation';
    const needsAck = isExit || isCurfew;
    const title = isCurfew
      ? `${item.targetUserName} ${item.curfewResult === 'inside' ? 'était' : 'n\'était pas'} dans la zone surveillée à l'heure du couvre-feu`
      : `${item.targetUserName} ${isExit ? 'a quitté' : 'est revenu(e) dans'} le périmètre`;
    return (
      <View style={[styles.card, needsAck && !item.acknowledged && styles.cardAlert]}>
        <View style={styles.cardHeader}>
          <View style={[styles.avatarCircle, { backgroundColor: needsAck ? '#EF4444' : '#22C55E' }]}>
            <IconSymbol name={needsAck ? 'exclamationmark.triangle.fill' : 'checkmark.circle.fill'} size={18} color="#fff" />
          </View>
          <View style={styles.cardInfo}>
            <Text style={styles.cardTitle}>{title}</Text>
            <Text style={styles.cardSubtitle}>
              {item.distanceMeters >= 0 ? `Distance: ${item.distanceMeters}m • ` : ''}{formatDate(item.timestamp)}
            </Text>
          </View>
        </View>

        {needsAck && !item.acknowledged && (
          <TouchableOpacity
            style={styles.ackBtn}
            onPress={() => acknowledgeAlert(item.id)}
          >
            <Text style={styles.ackBtnText}>Accusé de réception</Text>
          </TouchableOpacity>
        )}
        {item.acknowledged && (
          <Text style={styles.ackedText}>Accusé de réception envoyé</Text>
        )}
      </View>
    );
  };

  const alertWhenLabel = (alertWhen: CurfewCheck['alertWhen'] | undefined): string => {
    if (alertWhen === 'entry') return 'Alerte si présent(e) dans la zone';
    if (alertWhen === 'both') return 'Alerte dans tous les cas';
    return 'Alerte si absent(e) de la zone';
  };

  const renderActiveCurfewChecks = () => {
    const active = curfewChecksList.filter(c => c.active);
    if (active.length === 0) return null;
    return (
      <View style={styles.curfewListSection}>
        <Text style={styles.curfewListTitle}>Alertes de couvre-feu actives</Text>
        {active.map(c => (
          <View key={c.id} style={styles.curfewListItem}>
            <View style={{ flex: 1 }}>
              <Text style={styles.curfewListName}>{c.targetUserName}</Text>
              <Text style={styles.curfewListDetail}>
                {c.recurrence === 'daily' ? 'Tous les jours' : 'Aujourd\'hui'} à {String(c.hour).padStart(2, '0')}:{String(c.minute).padStart(2, '0')}
                {'  •  '}Prochain contrôle: {formatDate(c.nextCheckAt)}
              </Text>
              <Text style={styles.curfewListDetail}>{alertWhenLabel(c.alertWhen)}</Text>
            </View>
            <TouchableOpacity onPress={() => cancelCurfewCheck(c)}>
              <IconSymbol name="trash.fill" size={18} color="#EF4444" />
            </TouchableOpacity>
          </View>
        ))}
      </View>
    );
  };

  // ─── Empty States ───────────────────────────────────────────────────────

  const EmptyMembers = () => (
    <View style={styles.emptyState}>
      <IconSymbol name="heart.fill" size={48} color="#D1D5DB" />
      <Text style={styles.emptyTitle}>Aucun membre de famille</Text>
      <Text style={styles.emptySubtitle}>
        Les liens familiaux sont configurés par l'administrateur du système.
        Contactez votre administrateur pour ajouter des membres.
      </Text>
    </View>
  );

  const EmptyPerimeters = () => (
    <View style={styles.emptyState}>
      <IconSymbol name="location.fill" size={48} color="#D1D5DB" />
      <Text style={styles.emptyTitle}>Aucun périmètre</Text>
      <Text style={styles.emptySubtitle}>
        Créez un périmètre de sécurité autour d'un membre de votre famille pour recevoir des alertes quand il/elle s'en éloigne.
      </Text>
      {members.length > 0 && (
        <TouchableOpacity
          style={styles.emptyBtn}
          onPress={() => {
            setPerimeterTarget(members[0]);
            setShowCreatePerimeter(true);
          }}
        >
          <Text style={styles.emptyBtnText}>Créer un périmètre</Text>
        </TouchableOpacity>
      )}
    </View>
  );

  const EmptyAlerts = () => (
    <View style={styles.emptyState}>
      <IconSymbol name="bell.fill" size={48} color="#D1D5DB" />
      <Text style={styles.emptyTitle}>Aucune alerte</Text>
      <Text style={styles.emptySubtitle}>
        Les alertes de proximité apparaîtront ici quand un membre de votre famille quittera ou reviendra dans un périmètre défini.
      </Text>
    </View>
  );

  // ─── Unread alerts count ────────────────────────────────────────────────

  const unreadAlerts = proxAlerts.filter(a => a.eventType === 'exit' && !a.acknowledged).length;

  // ─── Main Render ────────────────────────────────────────────────────────

  if (!user) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: '#F9FAFB' }} edges={['top', 'left', 'right']}>
        <View style={styles.emptyState}>
          <Text style={styles.emptyTitle}>Connexion requise</Text>
          <Text style={styles.emptySubtitle}>Connectez-vous pour accéder à votre espace famille.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: '#F9FAFB' }} edges={['top', 'left', 'right']}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Ma Famille</Text>
        <Text style={styles.headerSubtitle}>
          {members.length} membre{members.length !== 1 ? 's' : ''}
        </Text>
      </View>

      {/* Tab Bar */}
      <View style={styles.tabBar}>
        {([
          { key: 'members' as TabKey, label: 'Membres', icon: 'heart.fill' as const },
          { key: 'perimeters' as TabKey, label: 'Périmètres', icon: 'location.fill' as const },
          { key: 'alerts' as TabKey, label: 'Alertes', icon: 'bell.fill' as const },
        ]).map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => {
              setActiveTab(tab.key);
              if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            }}
          >
            <IconSymbol
              name={tab.icon}
              size={18}
              color={activeTab === tab.key ? '#1e3a5f' : '#9CA3AF'}
            />
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
            {tab.key === 'alerts' && unreadAlerts > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{unreadAlerts}</Text>
              </View>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1e3a5f" />
        </View>
      ) : (
        <>
          {activeTab === 'members' && (
            <FlatList
              data={members}
              keyExtractor={item => item.userId}
              renderItem={renderMemberCard}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={EmptyMembers}
              ListHeaderComponent={renderFamilyMap}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1e3a5f" />}
            />
          )}
          {activeTab === 'perimeters' && (
            <FlatList
              data={perimeters}
              keyExtractor={item => item.id}
              renderItem={renderPerimeterCard}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={EmptyPerimeters}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1e3a5f" />}
            />
          )}
          {activeTab === 'alerts' && (
            <FlatList
              data={proxAlerts}
              keyExtractor={item => item.id}
              renderItem={renderAlertCard}
              contentContainerStyle={styles.listContent}
              ListEmptyComponent={EmptyAlerts}
              ListHeaderComponent={renderActiveCurfewChecks}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1e3a5f" />}
            />
          )}
        </>
      )}

      {/* Location History Modal */}
      <Modal visible={showHistory} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>
              Historique - {selectedMember?.name}
            </Text>
            <TouchableOpacity onPress={() => setShowHistory(false)}>
              <IconSymbol name="xmark.circle.fill" size={28} color="#6B7280" />
            </TouchableOpacity>
          </View>
          <Text style={styles.modalSubtitle}>Dernières 24 heures</Text>

          {historyLoading ? (
            <ActivityIndicator size="large" color="#1e3a5f" style={{ marginTop: 40 }} />
          ) : history.length === 0 ? (
            <View style={styles.emptyState}>
              <IconSymbol name="clock.fill" size={48} color="#D1D5DB" />
              <Text style={styles.emptyTitle}>Aucun historique</Text>
              <Text style={styles.emptySubtitle}>
                Aucune donnée de localisation enregistrée pour les dernières 24h.
              </Text>
            </View>
          ) : (
            <FlatList
              data={history.slice().reverse()}
              keyExtractor={(item, idx) => `${item.timestamp}-${idx}`}
              contentContainerStyle={{ padding: 16 }}
              renderItem={({ item }) => (
                <View style={styles.historyRow}>
                  <View style={styles.historyDot} />
                  <View style={styles.historyInfo}>
                    <Text style={styles.historyTime}>{formatDate(item.timestamp)}</Text>
                    <Text style={styles.historyCoords}>
                      {item.latitude.toFixed(5)}, {item.longitude.toFixed(5)}
                    </Text>
                  </View>
                </View>
              )}
            />
          )}
        </View>
      </Modal>

      {/* Create Perimeter Modal */}
      <Modal visible={showCreatePerimeter} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Nouveau périmètre</Text>
            <TouchableOpacity onPress={() => { setShowCreatePerimeter(false); setPerimeterTarget(null); }}>
              <IconSymbol name="xmark.circle.fill" size={28} color="#6B7280" />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ padding: 16 }}>
            {/* Target member selection */}
            <Text style={styles.formLabel}>Membre surveillé</Text>
            <View style={styles.memberSelector}>
              {members.map(m => (
                <TouchableOpacity
                  key={m.userId}
                  style={[styles.memberChip, perimeterTarget?.userId === m.userId && styles.memberChipActive]}
                  onPress={() => setPerimeterTarget(m)}
                >
                  <Text style={[styles.memberChipText, perimeterTarget?.userId === m.userId && styles.memberChipTextActive]}>
                    {m.name}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {perimeterTarget && (
              <>
                <Text style={styles.formLabel}>Centre du périmètre</Text>
                <Text style={styles.formHint}>
                  {perimeterCenter
                    ? `Adresse sélectionnée: ${perimeterCenter.latitude.toFixed(4)}, ${perimeterCenter.longitude.toFixed(4)}`
                    : perimeterTarget.location
                      ? `Position actuelle du membre: ${perimeterTarget.location.latitude.toFixed(4)}, ${perimeterTarget.location.longitude.toFixed(4)}`
                      : 'Aucune position disponible — recherchez une adresse ci-dessous ou Genève par défaut'}  
                </Text>

                {/* GPS Button */}
                <TouchableOpacity
                  style={styles.gpsBtn}
                  onPress={useMyPosition}
                  disabled={gpsLoading}
                >
                  {gpsLoading ? (
                    <ActivityIndicator size="small" color="#1e3a5f" />
                  ) : (
                    <IconSymbol name="location.fill" size={18} color="#1e3a5f" />
                  )}
                  <Text style={styles.gpsBtnText}>
                    {gpsLoading ? 'Localisation en cours...' : 'Utiliser ma position actuelle'}
                  </Text>
                </TouchableOpacity>

                <Text style={styles.formLabel}>Adresse du centre</Text>
                <View style={{ zIndex: 10 }}>
                  <View style={styles.addressInputRow}>
                    <TextInput
                      style={[styles.textInput, { flex: 1 }]}
                      value={perimeterAddress}
                      onChangeText={handleAddressChange}
                      placeholder="Rechercher une adresse..."
                      placeholderTextColor="#9CA3AF"
                      returnKeyType="search"
                    />
                    {addressSearching && (
                      <ActivityIndicator size="small" color="#1e3a5f" style={{ position: 'absolute', right: 12 }} />
                    )}
                  </View>
                  {addressSuggestions.length > 0 && (
                    <View style={styles.suggestionsContainer}>
                      {addressSuggestions.map((s, idx) => (
                        <TouchableOpacity
                          key={`${s.lat}-${s.lon}-${idx}`}
                          style={[styles.suggestionItem, idx < addressSuggestions.length - 1 && styles.suggestionBorder]}
                          onPress={() => selectSuggestion(s)}
                        >
                          <Text style={styles.suggestionIcon}>📍</Text>
                          <Text style={styles.suggestionText} numberOfLines={2}>{s.display_name}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {perimeterCenter && (
                    <Text style={styles.formHint}>
                      ✅ Centre: {perimeterCenter.latitude.toFixed(4)}, {perimeterCenter.longitude.toFixed(4)}
                    </Text>
                  )}
                </View>

                <Text style={styles.formLabel}>Rayon (mètres)</Text>
                <TextInput
                  style={styles.textInput}
                  value={perimeterRadius}
                  onChangeText={setPerimeterRadius}
                  placeholder="500"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="numeric"
                  returnKeyType="done"
                />
                <Text style={styles.formHint}>
                  Entre 50m et 50km. Recommandé: 200-500m pour une école, 1000-2000m pour un quartier.
                </Text>

                {/* Mini-map preview */}
                {perimeterCenter && (
                  <View style={styles.miniMapSection}>
                    <Text style={styles.formLabel}>Aperçu du périmètre</Text>
                    {isNativeMap ? (
                      <View style={styles.miniMapContainer}>
                        <NativeMapView
                          initialRegion={{
                            latitude: perimeterCenter.latitude,
                            longitude: perimeterCenter.longitude,
                            latitudeDelta: Math.max(0.005, (parseInt(perimeterRadius, 10) || 500) / 50000),
                            longitudeDelta: Math.max(0.005, (parseInt(perimeterRadius, 10) || 500) / 50000),
                          }}
                          showsUserLocation={false}
                          showsMyLocationButton={false}
                          showsCompass={false}
                          style={styles.miniMap}
                        >
                          <Marker
                            coordinate={perimeterCenter}
                            title="Centre du périmètre"
                            pinColor="#1e3a5f"
                          />
                          <Circle
                            center={perimeterCenter}
                            radius={parseInt(perimeterRadius, 10) || 500}
                            fillColor="rgba(30, 58, 95, 0.15)"
                            strokeColor="#1e3a5f"
                            strokeWidth={2}
                          />
                        </NativeMapView>
                      </View>
                    ) : (
                      <View style={styles.miniMapFallback}>
                        <Text style={styles.miniMapFallbackIcon}>🗺️</Text>
                        <Text style={styles.miniMapFallbackText}>
                          {perimeterCenter.latitude.toFixed(4)}, {perimeterCenter.longitude.toFixed(4)}
                        </Text>
                        <Text style={styles.miniMapFallbackRadius}>
                          Rayon: {parseInt(perimeterRadius, 10) || 500}m
                        </Text>
                      </View>
                    )}
                  </View>
                )}

                <TouchableOpacity
                  style={[styles.createBtn, perimeterSaving && { opacity: 0.6 }]}
                  onPress={createPerimeter}
                  disabled={perimeterSaving}
                >
                  {perimeterSaving ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.createBtnText}>Créer le périmètre</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Curfew check creation modal */}
      <Modal visible={showCreateCurfew} animationType="slide" presentationStyle="pageSheet">
        <View style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Alerte de couvre-feu</Text>
            <TouchableOpacity onPress={() => { setShowCreateCurfew(false); setCurfewTarget(null); }}>
              <IconSymbol name="xmark.circle.fill" size={28} color="#6B7280" />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ padding: 16 }}>
            {curfewTarget && (
              <>
                <Text style={styles.formHint}>
                  {curfewAlertWhen === 'entry'
                    ? `Sois alerté si ${curfewTarget.name} est dans la zone surveillée à l'heure choisie.`
                    : curfewAlertWhen === 'both'
                      ? `Sois notifié de la position de ${curfewTarget.name} (dans ou hors zone) à l'heure choisie.`
                      : `Sois alerté si ${curfewTarget.name} n'est pas dans la zone attendue à l'heure choisie.`}
                </Text>

                <Text style={styles.formLabel}>Zone {curfewAlertWhen === 'entry' ? 'surveillée' : 'attendue'}</Text>
                <TouchableOpacity
                  style={styles.gpsBtn}
                  onPress={useMyPosition}
                  disabled={gpsLoading}
                >
                  {gpsLoading ? (
                    <ActivityIndicator size="small" color="#1e3a5f" />
                  ) : (
                    <IconSymbol name="location.fill" size={18} color="#1e3a5f" />
                  )}
                  <Text style={styles.gpsBtnText}>
                    {gpsLoading ? 'Localisation en cours...' : 'Utiliser ma position actuelle'}
                  </Text>
                </TouchableOpacity>

                <Text style={styles.formLabel}>Adresse</Text>
                <View style={{ zIndex: 10 }}>
                  <View style={styles.addressInputRow}>
                    <TextInput
                      style={[styles.textInput, { flex: 1 }]}
                      value={perimeterAddress}
                      onChangeText={handleAddressChange}
                      placeholder="Rechercher une adresse..."
                      placeholderTextColor="#9CA3AF"
                      returnKeyType="search"
                    />
                    {addressSearching && (
                      <ActivityIndicator size="small" color="#1e3a5f" style={{ position: 'absolute', right: 12 }} />
                    )}
                  </View>
                  {addressSuggestions.length > 0 && (
                    <View style={styles.suggestionsContainer}>
                      {addressSuggestions.map((s, idx) => (
                        <TouchableOpacity
                          key={`${s.lat}-${s.lon}-${idx}`}
                          style={[styles.suggestionItem, idx < addressSuggestions.length - 1 && styles.suggestionBorder]}
                          onPress={() => selectSuggestion(s)}
                        >
                          <Text style={styles.suggestionIcon}>📍</Text>
                          <Text style={styles.suggestionText} numberOfLines={2}>{s.display_name}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                  {perimeterCenter && (
                    <Text style={styles.formHint}>
                      ✅ Centre: {perimeterCenter.latitude.toFixed(4)}, {perimeterCenter.longitude.toFixed(4)}
                    </Text>
                  )}
                </View>

                <Text style={styles.formLabel}>Rayon (mètres)</Text>
                <TextInput
                  style={styles.textInput}
                  value={perimeterRadius}
                  onChangeText={setPerimeterRadius}
                  placeholder="500"
                  placeholderTextColor="#9CA3AF"
                  keyboardType="numeric"
                  returnKeyType="done"
                />

                <Text style={styles.formLabel}>Heure limite</Text>
                <View style={styles.timeStepperRow}>
                  <TextInput
                    style={[styles.textInput, styles.timeStepperInput]}
                    value={curfewHour}
                    onChangeText={setCurfewHour}
                    placeholder="21"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="numeric"
                    maxLength={2}
                  />
                  <Text style={styles.timeStepperSeparator}>:</Text>
                  <TextInput
                    style={[styles.textInput, styles.timeStepperInput]}
                    value={curfewMinute}
                    onChangeText={setCurfewMinute}
                    placeholder="00"
                    placeholderTextColor="#9CA3AF"
                    keyboardType="numeric"
                    maxLength={2}
                  />
                </View>

                <Text style={styles.formLabel}>Récurrence</Text>
                <View style={styles.memberSelector}>
                  <TouchableOpacity
                    style={[styles.memberChip, curfewRecurrence === 'once' && styles.memberChipActive]}
                    onPress={() => setCurfewRecurrence('once')}
                  >
                    <Text style={[styles.memberChipText, curfewRecurrence === 'once' && styles.memberChipTextActive]}>Ponctuel (aujourd'hui)</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.memberChip, curfewRecurrence === 'daily' && styles.memberChipActive]}
                    onPress={() => setCurfewRecurrence('daily')}
                  >
                    <Text style={[styles.memberChipText, curfewRecurrence === 'daily' && styles.memberChipTextActive]}>Tous les jours</Text>
                  </TouchableOpacity>
                </View>

                <Text style={styles.formLabel}>Type d'alerte</Text>
                <View style={styles.memberSelector}>
                  <TouchableOpacity
                    style={[styles.memberChip, curfewAlertWhen === 'exit' && styles.memberChipActive]}
                    onPress={() => setCurfewAlertWhen('exit')}
                  >
                    <Text style={[styles.memberChipText, curfewAlertWhen === 'exit' && styles.memberChipTextActive]}>Sortie de la zone</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.memberChip, curfewAlertWhen === 'entry' && styles.memberChipActive]}
                    onPress={() => setCurfewAlertWhen('entry')}
                  >
                    <Text style={[styles.memberChipText, curfewAlertWhen === 'entry' && styles.memberChipTextActive]}>Entrée dans la zone</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.memberChip, curfewAlertWhen === 'both' && styles.memberChipActive]}
                    onPress={() => setCurfewAlertWhen('both')}
                  >
                    <Text style={[styles.memberChipText, curfewAlertWhen === 'both' && styles.memberChipTextActive]}>Les deux</Text>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={[styles.createBtn, curfewSaving && { opacity: 0.6 }]}
                  onPress={createCurfewCheck}
                  disabled={curfewSaving}
                >
                  {curfewSaving ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.createBtnText}>Créer l'alerte</Text>
                  )}
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1e3a5f',
  },
  headerSubtitle: {
    fontSize: 14,
    color: '#6B7280',
    marginTop: 2,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    gap: 6,
  },
  tabActive: {
    backgroundColor: '#E0EAF5',
  },
  tabText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#9CA3AF',
  },
  tabTextActive: {
    color: '#1e3a5f',
    fontWeight: '600',
  },
  badge: {
    backgroundColor: '#EF4444',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  listContent: {
    padding: 16,
    paddingBottom: 100,
    gap: 12,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  cardInactive: {
    opacity: 0.6,
  },
  cardAlert: {
    borderColor: '#EF4444',
    borderWidth: 1.5,
    backgroundColor: '#FEF2F2',
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  avatarCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#1e3a5f',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
  },
  cardInfo: {
    flex: 1,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
  cardSubtitle: {
    fontSize: 13,
    color: '#6B7280',
    marginTop: 2,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#F3F4F6',
  },
  locationText: {
    fontSize: 12,
    color: '#6B7280',
    flex: 1,
  },
  timeText: {
    fontSize: 12,
    color: '#9CA3AF',
  },
  cardActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  actionBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
  },
  actionBtnActive: {},
  actionBtnInactive: {},
  actionBtnText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#1e3a5f',
  },
  timestampText: {
    fontSize: 11,
    color: '#9CA3AF',
    marginTop: 8,
  },
  ackBtn: {
    marginTop: 12,
    backgroundColor: '#1e3a5f',
    paddingVertical: 10,
    borderRadius: 8,
    alignItems: 'center',
  },
  ackBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  ackedText: {
    marginTop: 8,
    fontSize: 12,
    color: '#22C55E',
    fontWeight: '500',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 14,
    color: '#6B7280',
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyBtn: {
    marginTop: 12,
    backgroundColor: '#1e3a5f',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderRadius: 8,
  },
  emptyBtnText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 14,
  },
  // Modal
  modalContainer: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#111827',
  },
  modalSubtitle: {
    fontSize: 13,
    color: '#6B7280',
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  // History
  historyRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#E5E7EB',
    paddingLeft: 16,
    marginLeft: 4,
  },
  historyDot: {
    position: 'absolute',
    left: -5,
    top: 12,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#1e3a5f',
  },
  historyInfo: {},
  historyTime: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
  },
  historyCoords: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  // Form
  formLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
    marginTop: 20,
    marginBottom: 8,
  },
  formHint: {
    fontSize: 12,
    color: '#9CA3AF',
    marginTop: 4,
    lineHeight: 16,
  },
  textInput: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: '#111827',
  },
  memberSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  memberChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  memberChipActive: {
    backgroundColor: '#1e3a5f',
    borderColor: '#1e3a5f',
  },
  memberChipText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#374151',
  },
  memberChipTextActive: {
    color: '#fff',
  },
  timeStepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  timeStepperInput: {
    width: 64,
    textAlign: 'center',
  },
  timeStepperSeparator: {
    fontSize: 20,
    fontWeight: '700',
    color: '#374151',
  },
  curfewListSection: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  curfewListTitle: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: '#6B7280',
    marginBottom: 8,
  },
  curfewListItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F9FAFB',
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  curfewListName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#111827',
  },
  curfewListDetail: {
    fontSize: 12,
    color: '#6B7280',
    marginTop: 2,
  },
  createBtn: {
    marginTop: 24,
    backgroundColor: '#1e3a5f',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  createBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 16,
  },
  // GPS button
  gpsBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#E8F4FD',
    borderWidth: 1,
    borderColor: '#B3D9F2',
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  gpsBtnText: {
    color: '#1e3a5f',
    fontWeight: '600',
    fontSize: 14,
  },
  // Mini-map
  miniMapSection: {
    marginTop: 16,
    marginBottom: 8,
  },
  familyMapContainer: {
    height: 220,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    marginHorizontal: 16,
    marginBottom: 12,
  },
  familyMap: {
    width: '100%',
    height: '100%',
  },
  miniMapContainer: {
    height: 200,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  miniMap: {
    width: '100%',
    height: '100%',
  },
  miniMapFallback: {
    height: 160,
    borderRadius: 12,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  miniMapFallbackIcon: {
    fontSize: 32,
  },
  miniMapFallbackText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#374151',
  },
  miniMapFallbackRadius: {
    fontSize: 12,
    color: '#6B7280',
  },
  // Address autocomplete
  addressInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
  },
  suggestionsContainer: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    borderTopWidth: 0,
    borderBottomLeftRadius: 10,
    borderBottomRightRadius: 10,
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  suggestionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 10,
  },
  suggestionBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  suggestionIcon: {
    fontSize: 16,
  },
  suggestionText: {
    flex: 1,
    fontSize: 13,
    color: '#374151',
    lineHeight: 18,
  },
});
