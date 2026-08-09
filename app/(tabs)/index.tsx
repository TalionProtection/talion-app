import { StyleSheet, View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOSButton } from '@/components/sos-button';
import { AlertCreationModal } from '@/components/alert-creation-modal';
import { useAuth } from '@/hooks/useAuth';
import { isStaffRole } from '@/lib/auth-context';
import { useLocation } from '@/lib/location-context';
import { TalionScreen } from '@/components/talion-banner';
import { useAlerts, type ServerAlert } from '@/hooks/useAlerts';
import { LocationService } from '@/services/location-service';
import { router } from 'expo-router';
import { OfflineBanner } from '@/components/offline-banner';
import { useWebSocketProvider } from '@/lib/websocket-provider';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader } from '@/lib/auth-fetch';

const STATUS_STORAGE_KEY = '@talion_user_status';

interface Incident {
  id: string;
  title: string;
  type: string;
  severity: string;
  latitude: number;
  longitude: number;
  address: string;
  description: string;
  timestamp: number;
  reportedBy: string;
  status: 'active' | 'acknowledged' | 'resolved';
  assignedResponders: string[];
  respondingNames?: string[];
  responderStatuses?: Record<string, 'assigned' | 'accepted' | 'en_route' | 'on_scene'>;
  distanceMeters?: number;
}

type UserStatus = 'available' | 'on_duty' | 'off_duty';

const STATUS_LABELS: Record<UserStatus, string> = {
  available: 'Available',
  on_duty: 'On Duty',
  off_duty: 'Off Duty',
};

const STATUS_COLORS: Record<UserStatus, string> = {
  available: '#22c55e',
  on_duty: '#f59e0b',
  off_duty: '#ef4444',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f59e0b',
  medium: '#3b82f6',
  low: '#6b7280',
};

const TYPE_ICONS: Record<string, string> = {
  sos: '🆘',
  medical: '🏥',
  fire: '🔥',
  security: '🔒',
  hazard: '⚠️',
  accident: '🚗',
  broadcast: '📢',
  home_jacking: '🏠',
  cambriolage: '🔓',
  animal_perdu: '🐾',
  evenement_climatique: '🌪️',
  rodage: '🏍️',
  vehicule_suspect: '🚙',
  fugue: '🏃',
  route_bloquee: '🚧',
  route_fermee: '⛔',
  other: '⚠️',
};

const TYPE_LABELS: Record<string, string> = {
  sos: 'SOS',
  medical: 'Médical',
  fire: 'Feu',
  security: 'Sécurité',
  hazard: 'Danger',
  accident: 'Accident',
  broadcast: 'Broadcast',
  home_jacking: 'Home-Jacking',
  cambriolage: 'Cambriolage',
  animal_perdu: 'Animal perdu',
  evenement_climatique: 'Événement climatique',
  rodage: 'Rodage',
  vehicule_suspect: 'Véhicule suspect',
  fugue: 'Fugue',
  route_bloquee: 'Route bloquée',
  route_fermee: 'Route fermée',
  other: 'Autre',
};

function formatAlertTitle(type: string): string {
  return TYPE_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Alert';
}

function formatDistance(meters: number): string {
  if (meters < 1000) {
    return `${Math.round(meters)}m`;
  }
  return `${(meters / 1000).toFixed(1)}km`;
}

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Convert a ServerAlert from the API to the local Incident format */
function serverAlertToIncident(alert: ServerAlert): Incident {
  return {
    id: alert.id,
    title: formatAlertTitle(alert.type),
    type: alert.type,
    severity: alert.severity,
    latitude: alert.location?.latitude ?? 0,
    longitude: alert.location?.longitude ?? 0,
    address: alert.location?.address ?? 'Unknown location',
    description: alert.description || '',
    timestamp: alert.createdAt,
    reportedBy: alert.createdBy || 'unknown',
    status: alert.status,
    assignedResponders: alert.respondingUsers || [],
    respondingNames: alert.respondingNames || [],
    responderStatuses: alert.responderStatuses || {},
  };
}

export default function HomeScreen() {
  const { user, logout } = useAuth();
  const { location, state: locationState, startBackgroundTracking, stopBackgroundTracking } = useLocation();
  const [userStatus, setUserStatus] = useState<UserStatus>('available');
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [kidSosMode, setKidSosMode] = useState(false); // family accounts can switch the SOS button to the simplified kid variant before handing the phone over
  const [malaiseSending, setMalaiseSending] = useState(false);
  const [teamChatOpening, setTeamChatOpening] = useState(false);
  const [incidentFilter, setIncidentFilter] = useState<'all' | 'assigned'>('all');
  const { sendLocation, isConnected: wsConnected } = useWebSocketProvider();
  const sharingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationRef = useRef(location);
  const userRef = useRef(user);
  const hasStartedSharingRef = useRef(false);

  // Keep refs always up-to-date
  useEffect(() => {
    locationRef.current = location;
  }, [location]);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Fetch real alerts from server with 10s polling
  const { alerts: serverAlerts, isLoading, error: alertsError, refresh: refreshAlerts } = useAlerts({ pollInterval: 10000, userRole: user?.role, userId: user?.id, playSounds: true });

  // Family presence, at a glance — replaces the old "Quick Actions" shortcuts
  // for family accounts (Messages/PTT/Map View just duplicated the tab bar;
  // this actually shows something you can't already see at a glance).
  interface FamilyPresenceItem {
    userId: string;
    name: string;
    presenceStatus?: 'inside' | 'outside' | 'unknown';
    presenceLabel?: string;
  }
  const [familyPresence, setFamilyPresence] = useState<FamilyPresenceItem[]>([]);
  const [familyPresenceLoading, setFamilyPresenceLoading] = useState(false);

  useEffect(() => {
    if (user?.role !== 'user' || !user?.id) return;
    let cancelled = false;
    const fetchPresence = async () => {
      setFamilyPresenceLoading(true);
      try {
        const apiBase = getApiBaseUrl();
        const res = await fetchWithTimeout(`${apiBase}/api/family/members?userId=${user.id}`, { timeout: 10000, headers: await authHeader() });
        const data = await res.json();
        if (!cancelled) setFamilyPresence(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelled) setFamilyPresence([]);
      }
      if (!cancelled) setFamilyPresenceLoading(false);
    };
    fetchPresence();
    const interval = setInterval(fetchPresence, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [user?.role, user?.id]);

  // Convert server alerts to local Incident format
  const incidents = useMemo(() => {
    return serverAlerts.map(serverAlertToIncident);
  }, [serverAlerts]);

  // Restore persisted status
  useEffect(() => {
    AsyncStorage.getItem(STATUS_STORAGE_KEY).then((saved) => {
      if (saved && ['available', 'on_duty', 'off_duty'].includes(saved)) {
        setUserStatus(saved as UserStatus);
      }
    });
  }, []);

  // Compute distances from user location
  const sortedIncidents = useMemo(() => {
    let filtered = incidents.filter((inc) => inc.status !== 'resolved');

    // Apply "assigned to me" filter for responders
    if (incidentFilter === 'assigned' && user?.id) {
      filtered = filtered.filter((inc) =>
        inc.assignedResponders.includes(user.id!) ||
        (inc.respondingNames && inc.respondingNames.includes(user.name || ''))
      );
    }

    return filtered
      .map((inc) => ({
        ...inc,
        distanceMeters: LocationService.distanceBetween(
          location.latitude,
          location.longitude,
          inc.latitude,
          inc.longitude
        ),
      }))
      .sort((a, b) => {
        const severityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        const aSev = severityOrder[a.severity] ?? 3;
        const bSev = severityOrder[b.severity] ?? 3;
        if (aSev !== bSev) return aSev - bSev;
        return (a.distanceMeters ?? Infinity) - (b.distanceMeters ?? Infinity);
      });
  }, [incidents, location.latitude, location.longitude, incidentFilter, user?.id, user?.name]);

  const activeCount = sortedIncidents.filter((i) => i.status === 'active').length;

  // Status change with persistence
  const changeStatus = useCallback(
    async (newStatus: UserStatus) => {
      setUserStatus(newStatus);
      await AsyncStorage.setItem(STATUS_STORAGE_KEY, newStatus);
    },
    []
  );

  const cycleStatus = useCallback(() => {
    const statuses: UserStatus[] = ['available', 'on_duty', 'off_duty'];
    const nextIndex = (statuses.indexOf(userStatus) + 1) % statuses.length;
    changeStatus(statuses[nextIndex]);
  }, [userStatus, changeStatus]);

  const handleSOSActivate = () => {
    // Refresh alerts after SOS to show the new alert immediately
    setTimeout(() => refreshAlerts(), 2000);
    Alert.alert('SOS Activated', 'Emergency services have been notified of your location');
  };

  const handleMalaiseAlert = () => {
    Alert.alert(
      'Je ne me sens pas bien',
      'Confirmer : signaler que vous ne vous sentez pas bien ? Votre équipe sécurité et vos proches seront alertés immédiatement.',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Confirmer', style: 'destructive', onPress: async () => {
            setMalaiseSending(true);
            try {
              const apiBase = getApiBaseUrl();
              const res = await fetchWithTimeout(`${apiBase}/api/family/quick-alert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
                body: JSON.stringify({ type: 'malaise' }),
                timeout: 10000,
              });
              if (res.ok) {
                setTimeout(() => refreshAlerts(), 2000);
                Alert.alert('Envoyé', 'Votre signalement a été transmis.');
              } else {
                Alert.alert('Erreur', 'Impossible d\'envoyer le signalement');
              }
            } catch (e) {
              Alert.alert('Erreur', 'Erreur réseau');
            }
            setMalaiseSending(false);
          },
        },
      ]
    );
  };

  const handleOpenTeamChat = async () => {
    setTeamChatOpening(true);
    try {
      const apiBase = getApiBaseUrl();
      const res = await fetchWithTimeout(`${apiBase}/api/family/team-conversation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        timeout: 10000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const conv = await res.json();
      router.push(`/(tabs)/messages?conversationId=${encodeURIComponent(conv.id)}`);
    } catch (e) {
      Alert.alert('Erreur', 'Impossible d\'ouvrir la discussion avec votre équipe');
    }
    setTeamChatOpening(false);
  };

  const handleRespondToIncident = (incident: Incident) => {
    const isPrivileged = isStaffRole(user?.role);
    const isBroadcast = incident.type === 'broadcast';

    // Regular users can only view alerts (no respond option)
    if (user?.role === 'user' || (isBroadcast && !isPrivileged)) {
      Alert.alert(
        incident.title,
        `${TYPE_ICONS[incident.type] || '\u26a0\ufe0f'} ${incident.description}\n\n\ud83d\udccd ${incident.address}\n\u23f1 ${formatTimeAgo(incident.timestamp)}\n\ud83d\udccf ${formatDistance(incident.distanceMeters ?? 0)}\n\nStatut: ${incident.status.toUpperCase()}\nAssign\u00e9s: ${incident.respondingNames && incident.respondingNames.length > 0 ? incident.respondingNames.join(', ') : incident.assignedResponders.length > 0 ? `${incident.assignedResponders.length} intervenant(s)` : 'Aucun'}`,
        [{ text: 'Fermer' }]
      );
      return;
    }

    Alert.alert(
      incident.title,
      `${incident.description}\n\n\ud83d\udccd ${incident.address}\n\ud83d\udccf ${formatDistance(incident.distanceMeters ?? 0)}`,
      [{ text: 'Fermer' }]
    );
  };

  const handleUpdateResponderStatus = async (incidentId: string, newStatus: 'accepted' | 'en_route' | 'on_scene') => {
    if (!user?.id) return;
    try {
      const apiBase = getApiBaseUrl();
      const res = await fetchWithTimeout(`${apiBase}/alerts/${encodeURIComponent(incidentId)}/respond`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ responderId: user.id, status: newStatus }),
        timeout: 10000,
      });
      const data = await res.json();
      if (data.success) {
        const LABELS: Record<string, string> = { accepted: 'Accept\u00e9', en_route: 'En route', on_scene: 'Sur place' };
        Alert.alert('Statut mis \u00e0 jour', `Vous \u00eates maintenant : ${LABELS[newStatus] || newStatus}`);
        refreshAlerts();
      } else {
        Alert.alert('Erreur', data.error || 'Impossible de mettre \u00e0 jour le statut');
      }
    } catch (err: any) {
      Alert.alert('Erreur', 'Impossible de contacter le serveur');
    }
  };

  // Send location via REST (reliable) - uses refs to always have fresh data
  const sendLocationToServerRef = useRef(async (lat: number, lng: number) => {});
  sendLocationToServerRef.current = async (lat: number, lng: number) => {
    const currentUser = userRef.current;
    const userId = currentUser?.id || currentUser?.email || 'anonymous';
    const userRole = currentUser?.role || 'user';
    const apiBase = getApiBaseUrl();
    const url = `${apiBase}/api/location`;
    console.log(`[ShareLocation] Sending to ${url}: lat=${lat.toFixed(6)}, lng=${lng.toFixed(6)}, userId=${userId}, role=${userRole}`);
    
    // REST call (most reliable, works even if WS is not connected)
    try {
      const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ userId, userRole, latitude: lat, longitude: lng }),
        timeout: 10000,
      });
      const data = await res.json();
      console.log(`[ShareLocation] REST OK: ${JSON.stringify(data)}`);
    } catch (err: any) {
      console.warn(`[ShareLocation] REST FAILED (${url}): ${err?.message || err}`);
    }
    
    // Also send via WS for real-time updates if connected
    try {
      sendLocation({ latitude: lat, longitude: lng });
    } catch (e) {
      // WS send is best-effort
    }
  };

  // Location sharing is on by default — no user toggle. Privacy is controlled solely
  // via Ghost mode (profile screen), which hides the user from dispatch's live view
  // without stopping the underlying location feed (still needed so a Ghost user can
  // be revealed during an incident, and so family visibility — unaffected by Ghost
  // mode — keeps working).
  useEffect(() => {
    if (!locationState.hasPermission || hasStartedSharingRef.current) return;
    hasStartedSharingRef.current = true;

    const loc = locationRef.current;
    console.log(`[ShareLocation] Auto-starting. location: ${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}, user: ${user?.id || user?.email || 'none'}`);
    sendLocationToServerRef.current(loc.latitude, loc.longitude);
    sharingIntervalRef.current = setInterval(() => {
      const freshLoc = locationRef.current;
      sendLocationToServerRef.current(freshLoc.latitude, freshLoc.longitude);
    }, 10000);
  }, [locationState.hasPermission]);

  // Also send location whenever GPS position changes
  useEffect(() => {
    if (hasStartedSharingRef.current) {
      sendLocationToServerRef.current(location.latitude, location.longitude);
    }
  }, [location.latitude, location.longitude]);

  // Clean up sharing interval on unmount
  useEffect(() => {
    return () => {
      if (sharingIntervalRef.current) {
        clearInterval(sharingIntervalRef.current);
      }
    };
  }, []);

  return (
    <TalionScreen statusText={STATUS_LABELS[userStatus]} statusColor={STATUS_COLORS[userStatus]}>
      <OfflineBanner showDetails />
      <ScrollView style={styles.container} contentContainerStyle={styles.scrollContent}>
        {/* Status Card */}
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <View style={styles.statusInfo}>
              <View style={styles.userHeaderRow}>
                <Text style={styles.userName}>{user?.name || 'Utilisateur'}</Text>
                <TouchableOpacity
                  style={styles.logoutButton}
                  onPress={() => {
                    Alert.alert(
                      'Déconnexion',
                      'Voulez-vous vous déconnecter ?',
                      [
                        { text: 'Annuler', style: 'cancel' },
                        { text: 'Déconnexion', style: 'destructive', onPress: () => logout() },
                      ]
                    );
                  }}
                >
                  <Text style={styles.logoutButtonText}>Déconnexion</Text>
                </TouchableOpacity>
              </View>
              <Text style={styles.roleLabel}>
                {user?.role === 'dispatcher' ? 'Dispatcher' : user?.role === 'responder' ? 'Responder' : 'User'}
              </Text>
              <View style={styles.statusContainer}>
                <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[userStatus] }]} />
                <Text style={styles.statusText}>{STATUS_LABELS[userStatus]}</Text>
              </View>
              {locationState.hasPermission && (
                <Text style={styles.locationText}>
                  📍 {location.latitude.toFixed(4)}, {location.longitude.toFixed(4)}
                  {location.accuracy ? ` (±${Math.round(location.accuracy)}m)` : ''}
                </Text>
              )}
              <View style={styles.connectionRow}>
                <View style={[styles.connectionDot, { backgroundColor: alertsError ? '#ef4444' : '#22c55e' }]} />
                <Text style={[styles.connectionText, { color: alertsError ? '#ef4444' : '#22c55e' }]}>
                  {alertsError ? 'Server offline' : 'Connected'}
                </Text>
              </View>
            </View>
            {user?.role === 'responder' && (
              <TouchableOpacity style={styles.statusButton} onPress={cycleStatus}>
                <Text style={styles.statusButtonText}>Change Status</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Nearby Incidents */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Incidents</Text>
            {activeCount > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{activeCount}</Text>
              </View>
            )}
          </View>

          {/* Filter chips for responders */}
          {isStaffRole(user?.role) && (
            <View style={styles.filterRow}>
              <TouchableOpacity
                style={[styles.filterChip, incidentFilter === 'all' && styles.filterChipActive]}
                onPress={() => setIncidentFilter('all')}
              >
                <Text style={[styles.filterChipText, incidentFilter === 'all' && styles.filterChipTextActive]}>Tous</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.filterChip, incidentFilter === 'assigned' && styles.filterChipActive]}
                onPress={() => setIncidentFilter('assigned')}
              >
                <Text style={[styles.filterChipText, incidentFilter === 'assigned' && styles.filterChipTextActive]}>Mes assignations</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Error banner */}
          {alertsError && (
            <TouchableOpacity style={styles.errorBanner} onPress={refreshAlerts}>
              <Text style={styles.errorBannerText}>Unable to reach server. Tap to retry.</Text>
            </TouchableOpacity>
          )}

          {isLoading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator size="large" color="#1e3a5f" />
              <Text style={styles.loadingText}>Loading incidents...</Text>
            </View>
          ) : sortedIncidents.length > 0 ? (
            sortedIncidents.map((incident) => (
              <TouchableOpacity
                key={incident.id}
                style={[
                  styles.incidentCard,
                  { borderLeftColor: SEVERITY_COLORS[incident.severity] || '#6b7280' },
                  incident.status === 'acknowledged' && styles.incidentAcknowledged,
                ]}
                onPress={() => handleRespondToIncident(incident)}
              >
                <View style={styles.incidentContent}>
                  <View style={styles.incidentTitleRow}>
                    <Text style={styles.incidentIcon}>{TYPE_ICONS[incident.type] || '⚠️'}</Text>
                    <Text style={styles.incidentTitle} numberOfLines={1}>
                      {incident.title}
                    </Text>
                    <View style={[styles.severityBadge, { backgroundColor: SEVERITY_COLORS[incident.severity] || '#6b7280' }]}>
                      <Text style={styles.severityText}>{incident.severity.toUpperCase()}</Text>
                    </View>
                  </View>
                  <Text style={styles.incidentAddress} numberOfLines={1}>
                    📍 {incident.address}
                  </Text>
                  <Text style={styles.incidentDescription} numberOfLines={1}>
                    {incident.description}
                  </Text>
                  <View style={styles.incidentMeta}>
                    <Text style={styles.incidentDistance}>
                      📏 {formatDistance(incident.distanceMeters ?? 0)}
                    </Text>
                    <Text style={styles.incidentTime}>⏱ {formatTimeAgo(incident.timestamp)}</Text>
                    {(incident.respondingNames && incident.respondingNames.length > 0) ? (
                       <Text style={styles.incidentResponders}>
                         👤 {incident.respondingNames.join(', ')}
                       </Text>
                     ) : incident.assignedResponders.length > 0 ? (
                       <Text style={styles.incidentResponders}>
                         👤 {incident.assignedResponders.length} responder(s)
                       </Text>
                     ) : null}
                    {incident.status === 'acknowledged' && (
                      <View style={styles.ackBadge}>
                        <Text style={styles.ackBadgeText}>ACK</Text>
                      </View>
                    )}
                  </View>
                </View>
                {/* Responder action buttons — only for assigned responders */}
                {user?.id && incident.assignedResponders.includes(user.id) && incident.status !== 'resolved' && (() => {
                  const myStatus = incident.responderStatuses?.[user.id!] || 'assigned';
                  const RESP_STATUS_LABELS: Record<string, string> = {
                    assigned: 'Assigné',
                    accepted: 'Accepté',
                    en_route: 'En route',
                    on_scene: 'Sur place',
                  };
                  const RESP_STATUS_COLORS: Record<string, string> = {
                    assigned: '#6b7280',
                    accepted: '#3b82f6',
                    en_route: '#f59e0b',
                    on_scene: '#22c55e',
                  };
                  return (
                    <View style={styles.responderActions}>
                      <View style={[styles.myStatusBadge, { backgroundColor: RESP_STATUS_COLORS[myStatus] || '#6b7280' }]}>
                        <Text style={styles.myStatusText}>{RESP_STATUS_LABELS[myStatus] || myStatus}</Text>
                      </View>
                      {myStatus === 'assigned' && (
                        <TouchableOpacity
                          style={[styles.actionBtn, { backgroundColor: '#3b82f6' }]}
                          onPress={() => handleUpdateResponderStatus(incident.id, 'accepted')}
                        >
                          <Text style={styles.actionBtnText}>Accepter</Text>
                        </TouchableOpacity>
                      )}
                      {myStatus === 'accepted' && (
                        <TouchableOpacity
                          style={[styles.actionBtn, { backgroundColor: '#f59e0b' }]}
                          onPress={() => handleUpdateResponderStatus(incident.id, 'en_route')}
                        >
                          <Text style={styles.actionBtnText}>En route</Text>
                        </TouchableOpacity>
                      )}
                      {myStatus === 'en_route' && (
                        <TouchableOpacity
                          style={[styles.actionBtn, { backgroundColor: '#22c55e' }]}
                          onPress={() => handleUpdateResponderStatus(incident.id, 'on_scene')}
                        >
                          <Text style={styles.actionBtnText}>Sur place</Text>
                        </TouchableOpacity>
                      )}
                      {myStatus === 'on_scene' && (
                        <Text style={styles.onSceneLabel}>\u2705 Sur place</Text>
                      )}
                    </View>
                  );
                })()}
                {/* Generic respond button for non-assigned privileged users */}
                {isStaffRole(user?.role) &&
                  incident.status === 'active' &&
                  !(user?.id && incident.assignedResponders.includes(user.id)) && (
                  <TouchableOpacity
                    style={styles.respondButton}
                    onPress={() => handleRespondToIncident(incident)}
                  >
                    <Text style={styles.respondButtonText}>Détails</Text>
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            ))
          ) : (
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyIcon}>{incidentFilter === 'assigned' ? '📋' : '✅'}</Text>
              <Text style={styles.emptyText}>
                {incidentFilter === 'assigned' ? 'Aucun incident assign\u00e9' : 'Aucun incident actif'}
              </Text>
              <Text style={styles.emptySubtext}>
                {incidentFilter === 'assigned' ? 'Aucun incident ne vous est actuellement assign\u00e9' : 'Tout est calme dans votre zone'}
              </Text>
            </View>
          )}
        </View>

        {/* Quick Actions — staff-only now; Messages/PTT/Map View used to be here
            too but they just duplicated the tab bar with zero added value. */}
        {(user?.role === 'dispatcher' || user?.role === 'responder') && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Quick Actions</Text>
            <View style={styles.quickActionsGrid}>
              {(user?.role === 'dispatcher' || user?.role === 'responder') && (
                <TouchableOpacity style={styles.quickActionButton} onPress={() => setShowAlertModal(true)}>
                  <Text style={styles.quickActionIcon}>🆘</Text>
                  <Text style={styles.quickActionLabel}>Create Alert</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.quickActionButton, locationState.isBackgroundTracking && styles.quickActionActive]}
                onPress={async () => {
                  if (locationState.isBackgroundTracking) {
                    await stopBackgroundTracking();
                    Alert.alert('Background Tracking Off', 'Your location will no longer be tracked in the background.');
                  } else {
                    const started = await startBackgroundTracking();
                    if (started) {
                      Alert.alert('Background Tracking On', 'Your location will continue to be tracked even when the app is in the background.');
                    } else {
                      Alert.alert('Permission Required', 'Please grant "Always" location permission to enable background tracking.');
                    }
                  }
                }}
              >
                <Text style={styles.quickActionIcon}>{locationState.isBackgroundTracking ? '🟢' : '📡'}</Text>
                <Text style={styles.quickActionLabel}>{locationState.isBackgroundTracking ? 'BG Tracking On' : 'BG Tracking'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Family presence, at a glance — family accounts only */}
        {user?.role === 'user' && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Présence famille</Text>
              <TouchableOpacity onPress={() => router.push('/(tabs)/family')}>
                <Text style={styles.familyPresenceSeeAll}>Voir tout</Text>
              </TouchableOpacity>
            </View>
            {familyPresenceLoading && familyPresence.length === 0 ? (
              <ActivityIndicator size="small" color="#1e3a5f" style={{ marginTop: 8 }} />
            ) : familyPresence.length === 0 ? (
              <Text style={styles.familyPresenceEmpty}>Aucun membre de famille enregistré.</Text>
            ) : (
              <View style={styles.familyPresenceCard}>
                {familyPresence.map((m, idx) => (
                  <TouchableOpacity
                    key={m.userId}
                    style={[styles.familyPresenceRow, idx < familyPresence.length - 1 && styles.familyPresenceRowBorder]}
                    onPress={() => router.push('/(tabs)/family')}
                  >
                    <Text style={styles.familyPresenceName}>{m.name}</Text>
                    <Text style={[
                      styles.familyPresenceStatus,
                      { color: m.presenceStatus === 'inside' ? '#22C55E' : m.presenceStatus === 'outside' ? '#F59E0B' : '#9CA3AF' },
                    ]}>
                      {m.presenceStatus === 'inside'
                        ? `🏠 Présent${m.presenceLabel ? ` — ${m.presenceLabel}` : ''}`
                        : m.presenceStatus === 'outside'
                          ? '🚶 Sorti'
                          : '❓ Inconnu'}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </View>
        )}

        <View style={{ height: 100 }} />
      </ScrollView>

      <View style={styles.sosBottomContainer}>
        <SOSButton
          onActivate={handleSOSActivate}
          userName={user?.name || 'Unknown'}
          userRole={user?.role || 'user'}
          userId={user?.id || ''}
          variant={kidSosMode ? 'kid' : 'standard'}
        />
        {user?.role === 'user' && (
          <TouchableOpacity onPress={() => setKidSosMode(v => !v)} style={styles.kidSosToggle}>
            <Text style={styles.kidSosToggleText}>{kidSosMode ? '← Revenir au mode standard' : 'Mode enfant 🖐️'}</Text>
          </TouchableOpacity>
        )}
        {user?.role === 'user' && !kidSosMode && (
          <TouchableOpacity onPress={handleMalaiseAlert} style={styles.malaiseBtn} disabled={malaiseSending}>
            {malaiseSending ? (
              <ActivityIndicator size="small" color="#B45309" />
            ) : (
              <Text style={styles.malaiseBtnText}>⚕️ Je ne me sens pas bien</Text>
            )}
          </TouchableOpacity>
        )}
        {user?.role === 'user' && !kidSosMode && (
          <TouchableOpacity onPress={handleOpenTeamChat} style={styles.teamChatBtn} disabled={teamChatOpening}>
            {teamChatOpening ? (
              <ActivityIndicator size="small" color="#1e3a5f" />
            ) : (
              <Text style={styles.teamChatBtnText}>💬 Parler à mon équipe</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      <AlertCreationModal
        visible={showAlertModal}
        onClose={() => setShowAlertModal(false)}
        onAlertCreated={() => {
          // Refresh alerts after creating one
          setTimeout(() => refreshAlerts(), 2000);
        }}
        userId={user?.id || ''}
        userName={user?.name || 'Unknown'}
      />
    </TalionScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 16,
  },
  statusCard: {
    backgroundColor: '#ffffff',
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statusInfo: {
    flex: 1,
  },
  userHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  userName: {
    fontSize: 18,
    fontWeight: '800',
    color: '#1e3a5f',
  },
  logoutButton: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  logoutButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ef4444',
  },
  roleLabel: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1e3a5f',
    marginBottom: 4,
  },
  statusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#6b7280',
  },
  locationText: {
    fontSize: 11,
    color: '#9ca3af',
    marginTop: 4,
  },
  connectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  connectionDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    marginRight: 5,
  },
  connectionText: {
    fontSize: 11,
    fontWeight: '500',
  },
  statusButton: {
    backgroundColor: '#1e3a5f',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
  },
  statusButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 13,
  },
  section: {
    marginHorizontal: 16,
    marginTop: 16,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#1e3a5f',
    marginBottom: 12,
  },
  badge: {
    backgroundColor: '#ef4444',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    minWidth: 24,
    alignItems: 'center',
    marginBottom: 12,
  },
  badgeText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  familyPresenceSeeAll: {
    color: '#1e3a5f',
    fontWeight: '600',
    fontSize: 13,
  },
  familyPresenceEmpty: {
    color: '#9CA3AF',
    fontSize: 13,
  },
  familyPresenceCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E5E7EB',
  },
  familyPresenceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  familyPresenceRowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  familyPresenceName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1F2937',
  },
  familyPresenceStatus: {
    fontSize: 13,
    fontWeight: '500',
  },
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 12,
  },
  filterChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#f1f5f9',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  filterChipActive: {
    backgroundColor: '#1e3a5f',
    borderColor: '#1e3a5f',
  },
  filterChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
  },
  filterChipTextActive: {
    color: '#ffffff',
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#ef4444',
  },
  errorBannerText: {
    color: '#991b1b',
    fontSize: 13,
    fontWeight: '500',
  },
  loadingContainer: {
    padding: 24,
    alignItems: 'center',
  },
  loadingText: {
    marginTop: 8,
    color: '#6b7280',
    fontSize: 13,
  },
  incidentCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderLeftWidth: 4,
    flexDirection: 'row',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  incidentAcknowledged: {
    opacity: 0.7,
    backgroundColor: '#f9fafb',
  },
  incidentContent: {
    flex: 1,
  },
  incidentTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  incidentIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  incidentTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1f2937',
    flex: 1,
  },
  severityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginLeft: 8,
  },
  severityText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 10,
  },
  incidentAddress: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 2,
  },
  incidentDescription: {
    fontSize: 12,
    color: '#9ca3af',
    marginBottom: 6,
  },
  incidentMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  incidentDistance: {
    fontSize: 11,
    fontWeight: '600',
    color: '#1e3a5f',
  },
  incidentTime: {
    fontSize: 11,
    color: '#9ca3af',
  },
  incidentResponders: {
    fontSize: 11,
    color: '#6b7280',
  },
  ackBadge: {
    backgroundColor: '#dbeafe',
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
  },
  ackBadgeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#2563eb',
  },
  respondButton: {
    backgroundColor: '#1e3a5f',
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    marginLeft: 10,
  },
  respondButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  responderActions: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 10,
    gap: 6,
  },
  myStatusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  myStatusText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 10,
  },
  actionBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
    minWidth: 90,
    alignItems: 'center',
  },
  actionBtnText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 12,
  },
  onSceneLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#22c55e',
    marginTop: 4,
  },
  emptyContainer: {
    padding: 32,
    alignItems: 'center',
    backgroundColor: '#ffffff',
    borderRadius: 12,
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: 8,
  },
  emptyText: {
    color: '#374151',
    fontSize: 15,
    fontWeight: '600',
  },
  emptySubtext: {
    color: '#9ca3af',
    fontSize: 13,
    marginTop: 4,
  },
  quickActionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  quickActionButton: {
    width: '48%',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    marginBottom: 10,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  quickActionActive: {
    backgroundColor: '#ecfdf5',
    borderWidth: 1,
    borderColor: '#22c55e',
  },
  quickActionIcon: {
    fontSize: 28,
    marginBottom: 6,
  },
  quickActionLabel: {
    fontSize: 12,
    fontWeight: '600',
    textAlign: 'center',
    color: '#374151',
  },
  sosBottomContainer: {
    alignItems: 'center',
    paddingVertical: 12,
    paddingBottom: 20,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  kidSosToggle: {
    marginTop: 8,
  },
  kidSosToggleText: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '600',
  },
  malaiseBtn: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: '#FEF3C7',
    borderWidth: 1,
    borderColor: '#FDE68A',
  },
  malaiseBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#B45309',
  },
  teamChatBtn: {
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 20,
    borderRadius: 10,
    backgroundColor: '#EFF6FF',
    borderWidth: 1,
    borderColor: '#BFDBFE',
  },
  teamChatBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#1e3a5f',
  },
});
