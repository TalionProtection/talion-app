import { StyleSheet, View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SOSButton } from '@/components/sos-button';
import { AlertCreationModal } from '@/components/alert-creation-modal';
import { useAuth } from '@/hooks/useAuth';
import { useLocation } from '@/lib/location-context';
import { TalionScreen } from '@/components/talion-banner';
import { useAlerts, type ServerAlert } from '@/hooks/useAlerts';
import { LocationService } from '@/services/location-service';
import { router } from 'expo-router';
import { OfflineBanner } from '@/components/offline-banner';
import { useWebSocketProvider } from '@/lib/websocket-provider';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';

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
  const [incidentFilter, setIncidentFilter] = useState<'all' | 'assigned'>('all');
  const [isSharingLocation, setIsSharingLocation] = useState(false);
  const { sendLocation, isConnected: wsConnected } = useWebSocketProvider();
  const sharingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const locationRef = useRef(location);
  const userRef = useRef(user);
  const sharingUserIdRef = useRef<string>('');

  // Keep refs always up-to-date
  useEffect(() => {
    locationRef.current = location;
  }, [location]);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Fetch real alerts from server with 10s polling
  const { alerts: serverAlerts, isLoading, error: alertsError, refresh: refreshAlerts } = useAlerts({ pollInterval: 10000, userRole: user?.role, userId: user?.id, playSounds: true });

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

  const handleRespondToIncident = (incident: Incident) => {
    const isPrivileged = user?.role === 'responder' || user?.role === 'dispatcher' || user?.role === 'admin';
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, userRole, latitude: lat, longitude: lng }),
        timeout: 10000,
      });
      const data = await res.json();
      // Track the resolved userId from server (may differ from what we sent, e.g. anon-xxx)
      if (data.userId) {
        sharingUserIdRef.current = data.userId;
      }
      console.log(`[ShareLocation] REST OK: ${JSON.stringify(data)}, tracked userId: ${sharingUserIdRef.current}`);
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

  const handleShareLocation = () => {
    if (isSharingLocation) {
      // Stop sharing
      if (sharingIntervalRef.current) {
        clearInterval(sharingIntervalRef.current);
        sharingIntervalRef.current = null;
      }
      setIsSharingLocation(false);
      console.log('[ShareLocation] Stopped sharing location');
      // Notify server to remove location from dispatch map
      // Use the tracked userId from the server response (guaranteed to match)
      const stopUserId = sharingUserIdRef.current;
      console.log(`[ShareLocation] Sending stop for userId: ${stopUserId}`);
      if (stopUserId) {
        const apiBase = getApiBaseUrl();
        fetchWithTimeout(`${apiBase}/api/location/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: stopUserId }),
          timeout: 10000,
        })
          .then(r => r.json())
          .then(data => {
            console.log(`[ShareLocation] Stop REST OK: ${JSON.stringify(data)}`);
            sharingUserIdRef.current = '';
          })
          .catch(err => console.warn(`[ShareLocation] Stop REST failed: ${err?.message || err}`));
      } else {
        console.warn('[ShareLocation] No tracked userId to stop - TTL will clean up automatically');
      }
      Alert.alert('Location Sharing Stopped', 'Your location is no longer being shared.');
      return;
    }
    if (!locationState.hasPermission) {
      Alert.alert('Location Permission Required', 'Please enable location permissions in your device settings.');
      return;
    }
    // Send location immediately using current ref value
    const loc = locationRef.current;
    console.log(`[ShareLocation] Starting share. location: ${loc.latitude.toFixed(6)}, ${loc.longitude.toFixed(6)}, user: ${user?.id || user?.email || 'none'}`);
    sendLocationToServerRef.current(loc.latitude, loc.longitude);
    // Send location every 10 seconds using ref (always fresh data)
    sharingIntervalRef.current = setInterval(() => {
      const freshLoc = locationRef.current;
      console.log(`[ShareLocation] Periodic send: ${freshLoc.latitude.toFixed(6)}, ${freshLoc.longitude.toFixed(6)}`);
      sendLocationToServerRef.current(freshLoc.latitude, freshLoc.longitude);
    }, 10000);
    setIsSharingLocation(true);
    Alert.alert(
      'Location Shared',
      `Your GPS location (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}) is now being shared with dispatch.`
    );
  };

  // Also send location whenever GPS position changes while sharing is active
  useEffect(() => {
    if (isSharingLocation) {
      console.log(`[ShareLocation] Location changed while sharing: ${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`);
      sendLocationToServerRef.current(location.latitude, location.longitude);
    }
  }, [location.latitude, location.longitude, isSharingLocation]);

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
          {(user?.role === 'responder' || user?.role === 'dispatcher' || user?.role === 'admin') && (
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
                {(user?.role === 'responder' || user?.role === 'dispatcher' || user?.role === 'admin') && 
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

        {/* Quick Actions */}
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
              style={[styles.quickActionButton, isSharingLocation && styles.quickActionActive]}
              onPress={handleShareLocation}
            >
              <Text style={styles.quickActionIcon}>{isSharingLocation ? '✅' : '📍'}</Text>
              <Text style={styles.quickActionLabel}>{isSharingLocation ? 'Sharing...' : 'Share Location'}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.quickActionButton} onPress={() => router.push('/(tabs)/messages')}>
              <Text style={styles.quickActionIcon}>💬</Text>
              <Text style={styles.quickActionLabel}>Messages</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.quickActionButton} onPress={() => router.push('/(tabs)/ptt')}>
              <Text style={styles.quickActionIcon}>🎤</Text>
              <Text style={styles.quickActionLabel}>PTT</Text>
            </TouchableOpacity>
            {(user?.role === 'responder' || user?.role === 'dispatcher') && (
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
            )}
            <TouchableOpacity style={styles.quickActionButton} onPress={() => router.push('/(tabs)/explore')}>
              <Text style={styles.quickActionIcon}>🗺️</Text>
              <Text style={styles.quickActionLabel}>Map View</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ height: 100 }} />
      </ScrollView>

      <View style={styles.sosBottomContainer}>
        <SOSButton
          onActivate={handleSOSActivate}
          userName={user?.name || 'Unknown'}
          userRole={user?.role || 'user'}
          userId={user?.id || ''}
        />
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
});
