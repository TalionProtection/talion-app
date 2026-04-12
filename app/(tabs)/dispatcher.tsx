import React, { useState, useMemo, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  TextInput,
  Modal,
} from 'react-native';
import { useAuth } from '@/hooks/useAuth';
import { TalionScreen } from '@/components/talion-banner';
import { useLocation } from '@/lib/location-context';
import { LocationService } from '@/services/location-service';
import { router } from 'expo-router';
import { useAlerts, type ServerAlert } from '@/hooks/useAlerts';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { formatIncidentId, formatIncidentType, formatStatusFr, formatSeverityFr, formatTimeAgoFr } from '@/lib/format-utils';

interface TimelineEntry {
  id: string;
  action: string;
  by: string;
  timestamp: number;
}

interface Incident {
  id: string;
  type: string;
  userId: string;
  userName: string;
  location: { latitude: number; longitude: number };
  address: string;
  timestamp: number;
  status: 'active' | 'acknowledged' | 'dispatched' | 'resolved';
  description: string;
  severity: string;
  assignedResponders: string[];
  respondingNames?: string[];
  timeline: TimelineEntry[];
}

interface Responder {
  id: string;
  name: string;
  phone?: string;
  tags?: string[];
  status: 'available' | 'on_duty' | 'off_duty' | 'responding';
  location?: { latitude: number; longitude: number };
  lastSeen: number;
  isConnected?: boolean;
  assignedIncidents?: { id: string; type: string; severity: string; status: string; address: string }[];
}

type FilterTab = 'all' | 'active' | 'acknowledged' | 'dispatched';

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f59e0b',
  medium: '#3b82f6',
  low: '#6b7280',
};

const STATUS_COLORS: Record<string, string> = {
  active: '#ef4444',
  acknowledged: '#f59e0b',
  dispatched: '#3b82f6',
  resolved: '#22c55e',
  available: '#22c55e',
  on_duty: '#3b82f6',
  responding: '#f59e0b',
  off_duty: '#9ca3af',
};

const TYPE_ICONS: Record<string, string> = {
  sos: '\u{1F198}',
  medical: '\u{1F3E5}',
  fire: '\u{1F525}',
  security: '\u{1F512}',
  hazard: '\u26A0\uFE0F',
  accident: '\u{1F697}',
  broadcast: '\u{1F4E2}',
  home_jacking: '\u{1F3E0}',
  cambriolage: '\u{1F513}',
  animal_perdu: '\u{1F43E}',
  evenement_climatique: '\u{1F32A}\uFE0F',
  rodage: '\u{1F3CD}\uFE0F',
  vehicule_suspect: '\u{1F699}',
  fugue: '\u{1F3C3}',
  route_bloquee: '\u{1F6A7}',
  route_fermee: '\u26D4',
  other: '\u26A0\uFE0F',
};

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function serverAlertToIncident(alert: ServerAlert): Incident {
  return {
    id: alert.id,
    type: alert.type,
    userId: alert.createdBy,
    userName: alert.createdBy || 'Unknown',
    location: {
      latitude: alert.location?.latitude ?? 0,
      longitude: alert.location?.longitude ?? 0,
    },
    address: alert.location?.address || 'Unknown location',
    timestamp: alert.createdAt,
    status: alert.status === 'resolved' ? 'resolved' : alert.status === 'acknowledged' ? 'acknowledged' : 'active',
    description: alert.description || '',
    severity: alert.severity || 'medium',
    assignedResponders: alert.respondingUsers || [],
    respondingNames: alert.respondingNames || [],
    timeline: [
      {
        id: '1',
        action: `${alert.type.toUpperCase()} reported`,
        by: alert.createdBy || 'System',
        timestamp: alert.createdAt,
      },
    ],
  };
}

export default function DispatcherScreen() {
  const { user } = useAuth();
  const { location } = useLocation();

  // Fetch real alerts from server - dispatchers see ALL alerts including SOS
  const { alerts: serverAlerts, isLoading, error, refresh } = useAlerts({
    pollInterval: 5000,
    userRole: 'dispatcher',
    playSounds: true,
  });

  const [responders, setResponders] = useState<Responder[]>([]);
  const [broadcastSeverity, setBroadcastSeverity] = useState('medium');
  const [showUserProfile, setShowUserProfile] = useState(false);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  const [profileUser, setProfileUser] = useState<any>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  // Fetch responders from server
  const fetchResponders = useCallback(async () => {
    try {
      const baseUrl = getApiBaseUrl();
      // Use /dispatch/responders which has fallback demo data
      const res = await fetchWithTimeout(`${baseUrl}/dispatch/responders`, { timeout: 10000 });
      if (res.ok) {
        const data = await res.json();
        // Also fetch admin user details for enrichment
        let adminUsers: any[] = [];
        try {
          const adminRes = await fetchWithTimeout(`${baseUrl}/admin/users`, { timeout: 10000 });
          if (adminRes.ok) adminUsers = await adminRes.json();
        } catch {}
        setResponders(data.map((r: any) => {
          return {
            id: r.id,
            name: r.name || r.id,
            phone: r.phone || '',
            tags: r.tags || [],
            status: r.status || 'off_duty',
            location: r.location || undefined,
            lastSeen: r.lastSeen || Date.now(),
            isConnected: r.isConnected || false,
            assignedIncidents: r.assignedIncidents || [],
          };
        }));
      }
    } catch (e) {
      // Keep existing responders on error
    }
  }, []);

  useEffect(() => {
    fetchResponders();
    const interval = setInterval(fetchResponders, 10000);
    return () => clearInterval(interval);
  }, [fetchResponders]);

  const [filter, setFilter] = useState<FilterTab>('active');
  const [selectedIncident, setSelectedIncident] = useState<Incident | null>(null);
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [showBroadcastModal, setShowBroadcastModal] = useState(false);
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastRadius, setBroadcastRadius] = useState('5');
  const [localStatusOverrides, setLocalStatusOverrides] = useState<Record<string, string>>({});

  // Convert server alerts to local Incident format with local status overrides
  const incidents = useMemo(() => {
    return serverAlerts.map((a) => {
      const incident = serverAlertToIncident(a);
      if (localStatusOverrides[a.id]) {
        incident.status = localStatusOverrides[a.id] as Incident['status'];
      }
      return incident;
    });
  }, [serverAlerts, localStatusOverrides]);

  const handleAcknowledge = (incident: Incident) => {
    setLocalStatusOverrides((prev) => ({ ...prev, [incident.id]: 'acknowledged' }));
    // Also update on server
    const baseUrl = getApiBaseUrl();
    fetchWithTimeout(`${baseUrl}/alerts/${incident.id}/acknowledge`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: user?.id }),
      timeout: 10000,
    }).then(() => refresh()).catch(() => {});
  };

  const handleAssignResponder = async (incident: Incident, responder: Responder) => {
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetchWithTimeout(`${baseUrl}/dispatch/incidents/${incident.id}/assign`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ responderId: responder.id }),
        timeout: 10000,
      });
      const data = await res.json();
      if (data.success) {
        setLocalStatusOverrides((prev) => ({ ...prev, [incident.id]: 'dispatched' }));
        setResponders((prev) => prev.map((r) => (r.id === responder.id ? { ...r, status: 'on_duty' as const } : r)));
        setShowAssignModal(false);
        refresh();
        Alert.alert('Assign\u00e9', `${responder.name} a \u00e9t\u00e9 assign\u00e9 \u00e0 l'incident ${incident.type}.`);
      }
    } catch (e) {
      setShowAssignModal(false);
      Alert.alert('Erreur', 'Impossible d\'assigner le responder.');
    }
  };

  const handleUnassignResponder = async (incident: Incident, responderId: string) => {
    const responderName = responders.find((r) => r.id === responderId)?.name || responderId;
    Alert.alert('D\u00e9sassigner', `Retirer ${responderName} de cet incident ?`, [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'D\u00e9sassigner',
        style: 'destructive',
        onPress: async () => {
          try {
            const baseUrl = getApiBaseUrl();
            const res = await fetchWithTimeout(`${baseUrl}/dispatch/incidents/${incident.id}/unassign`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ responderId }),
              timeout: 10000,
            });
            const data = await res.json();
            if (data.success) {
              refresh();
            }
          } catch (e) {
            Alert.alert('Erreur', 'Impossible de d\u00e9sassigner le responder.');
          }
        },
      },
    ]);
  };

  const handleResolve = (incident: Incident) => {
    Alert.alert('Resolve Incident', `Are you sure you want to close this ${incident.type} incident?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Resolve',
        onPress: () => {
          setLocalStatusOverrides((prev) => ({ ...prev, [incident.id]: 'resolved' }));
          setResponders((prev) =>
            prev.map((r) => (incident.assignedResponders.includes(r.id) ? { ...r, status: 'available' as const } : r))
          );
          // Also update on server
          const baseUrl = getApiBaseUrl();
          fetchWithTimeout(`${baseUrl}/alerts/${incident.id}/resolve`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: user?.id }),
            timeout: 10000,
          }).then(() => refresh()).catch(() => {});
        },
      },
    ]);
  };

  const handleBroadcast = async () => {
    if (!broadcastMessage.trim()) {
      Alert.alert('Error', 'Please enter a broadcast message.');
      return;
    }
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetchWithTimeout(`${baseUrl}/dispatch/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: broadcastMessage.trim(),
          severity: broadcastSeverity,
          radiusKm: parseInt(broadcastRadius),
          by: user?.name || 'Dispatcher',
        }),
      });
      if (res.ok) {
        Alert.alert('Broadcast Sent', `Alert sent to all units within ${broadcastRadius}km radius.`);
        refresh(); // Refresh alerts to show the new broadcast
      } else {
        Alert.alert('Error', 'Failed to send broadcast.');
      }
    } catch (e) {
      Alert.alert('Error', 'Network error. Broadcast not sent.');
    }
    setBroadcastMessage('');
    setShowBroadcastModal(false);
  };

  // Open user profile
  const openUserProfile = async (userId: string) => {
    setProfileUserId(userId);
    setShowUserProfile(true);
    setProfileLoading(true);
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetchWithTimeout(`${baseUrl}/admin/users/${userId}`, { timeout: 10000 });
      if (res.ok) {
        const data = await res.json();
        setProfileUser(data);
      }
    } catch (e) {
      setProfileUser(null);
    }
    setProfileLoading(false);
  };

  const filteredIncidents = useMemo(() => {
    return incidents
      .filter((i) => {
        if (filter === 'all') return i.status !== 'resolved';
        return i.status === filter;
      })
      .sort((a, b) => {
        const sev: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
        const aSev = sev[a.severity] ?? 3;
        const bSev = sev[b.severity] ?? 3;
        if (aSev !== bSev) return aSev - bSev;
        return b.timestamp - a.timestamp;
      });
  }, [incidents, filter]);

  const stats = useMemo(() => ({
    active: incidents.filter((i) => i.status === 'active').length,
    acknowledged: incidents.filter((i) => i.status === 'acknowledged').length,
    dispatched: incidents.filter((i) => i.status === 'dispatched').length,
    available: responders.filter((r) => r.status === 'available').length,
    onDuty: responders.filter((r) => r.status === 'on_duty').length,
    total: responders.length,
  }), [incidents, responders]);

  const availableResponders = responders.filter((r) => r.status === 'available' || r.status === 'on_duty');

  if (isLoading) {
    return (
      <TalionScreen statusText="Dispatch" statusColor="#1e3a5f">
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1e3a5f" />
          <Text style={styles.loadingText}>Loading dispatch data...</Text>
        </View>
      </TalionScreen>
    );
  }

  return (
    <TalionScreen statusText="Dispatch" statusColor="#1e3a5f">
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Error Banner */}
        {error && (
          <TouchableOpacity style={styles.errorBanner} onPress={refresh}>
            <Text style={styles.errorBannerText}>Server connection issue. Tap to retry.</Text>
          </TouchableOpacity>
        )}

        {/* Stats Row */}
        <View style={styles.statsRow}>
          <View style={[styles.statCard, { borderLeftColor: '#ef4444' }]}>
            <Text style={[styles.statNumber, { color: '#ef4444' }]}>{stats.active}</Text>
            <Text style={styles.statLabel}>Actifs</Text>
          </View>
          <View style={[styles.statCard, { borderLeftColor: '#f59e0b' }]}>
            <Text style={[styles.statNumber, { color: '#f59e0b' }]}>{stats.acknowledged}</Text>
            <Text style={styles.statLabel}>En attente</Text>
          </View>
          <View style={[styles.statCard, { borderLeftColor: '#3b82f6' }]}>
            <Text style={[styles.statNumber, { color: '#3b82f6' }]}>{stats.dispatched}</Text>
            <Text style={styles.statLabel}>Dispatchés</Text>
          </View>
          <View style={[styles.statCard, { borderLeftColor: '#22c55e' }]}>
            <Text style={[styles.statNumber, { color: '#22c55e' }]}>{stats.available}</Text>
            <Text style={styles.statLabel}>Disponibles</Text>
          </View>
        </View>

        {/* Broadcast Button */}
        <TouchableOpacity style={styles.broadcastButton} onPress={() => setShowBroadcastModal(true)}>
          <Text style={styles.broadcastButtonIcon}>{'\u{1F4E2}'}</Text>
          <Text style={styles.broadcastButtonText}>Zone Broadcast</Text>
        </TouchableOpacity>

        {/* Refresh Button */}
        <TouchableOpacity style={styles.refreshRow} onPress={refresh}>
          <Text style={styles.refreshText}>{'\u{1F504}'} Rafraîchir les alertes</Text>
        </TouchableOpacity>

        {/* Filter Tabs */}
        <View style={styles.filterTabs}>
          {(['all', 'active', 'acknowledged', 'dispatched'] as FilterTab[]).map((tab) => (
            <TouchableOpacity
              key={tab}
              style={[styles.filterTab, filter === tab && styles.filterTabActive]}
              onPress={() => setFilter(tab)}
            >
              <Text style={[styles.filterTabText, filter === tab && styles.filterTabTextActive]}>
                {tab === 'all' ? 'Tous' : formatStatusFr(tab)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Incidents */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Incidents ({filteredIncidents.length})</Text>
          {filteredIncidents.length > 0 ? (
            filteredIncidents.map((incident) => (
              <View key={incident.id} style={[styles.incidentCard, { borderLeftColor: SEVERITY_COLORS[incident.severity] || '#ef4444' }]}>
                <View style={styles.incidentHeader}>
                  <View style={styles.incidentHeaderLeft}>
                    <Text style={styles.incidentTypeIcon}>{TYPE_ICONS[incident.type] || '\u{1F6A8}'}</Text>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={styles.incidentUserName}>{incident.userName}</Text>
                        <View style={{ backgroundColor: '#f3f4f6', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4 }}>
                          <Text style={{ fontSize: 9, fontWeight: '700', color: '#6b7280', fontFamily: 'monospace' }}>{formatIncidentId(incident.id)}</Text>
                        </View>
                      </View>
                      <Text style={styles.incidentAddress} numberOfLines={1}>{'\u{1F4CD}'} {incident.address}</Text>
                    </View>
                  </View>
                  <View style={styles.incidentHeaderRight}>
                    <View style={[styles.severityBadge, { backgroundColor: SEVERITY_COLORS[incident.severity] || '#ef4444' }]}>
                      <Text style={styles.severityText}>{formatSeverityFr(incident.severity)}</Text>
                    </View>
                    <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[incident.status] || '#6b7280' }]}>
                      <Text style={styles.statusBadgeText}>{formatStatusFr(incident.status)}</Text>
                    </View>
                  </View>
                </View>

                <Text style={styles.incidentDescription}>{incident.description}</Text>
                <Text style={styles.incidentTime}>{'\u23F1'} {formatTimeAgo(incident.timestamp)}</Text>

                {/* Assigned Responders - show real names + unassign */}
                {(incident.respondingNames && incident.respondingNames.length > 0) ? (
                  <View style={styles.assignedRow}>
                    <Text style={styles.assignedLabel}>Assign\u00e9s:</Text>
                    {incident.respondingNames.map((name, idx) => (
                      <TouchableOpacity
                        key={idx}
                        style={styles.assignedChip}
                        onLongPress={() => {
                          const rid = incident.assignedResponders[idx];
                          if (rid && incident.status !== 'resolved') handleUnassignResponder(incident, rid);
                        }}
                      >
                        <Text style={styles.assignedChipText}>{name}</Text>
                        {incident.status !== 'resolved' && <Text style={{ fontSize: 8, color: '#ef4444', marginLeft: 4 }}>\u00D7</Text>}
                      </TouchableOpacity>
                    ))}
                  </View>
                ) : incident.assignedResponders.length > 0 ? (
                  <View style={styles.assignedRow}>
                    <Text style={styles.assignedLabel}>Assign\u00e9s:</Text>
                    {incident.assignedResponders.map((rid) => {
                      const r = responders.find((rr) => rr.id === rid);
                      return (
                        <TouchableOpacity
                          key={rid}
                          style={styles.assignedChip}
                          onLongPress={() => {
                            if (incident.status !== 'resolved') handleUnassignResponder(incident, rid);
                          }}
                        >
                          <Text style={styles.assignedChipText}>{r?.name || rid}</Text>
                          {incident.status !== 'resolved' && <Text style={{ fontSize: 8, color: '#ef4444', marginLeft: 4 }}>\u00D7</Text>}
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ) : null}

                {/* Timeline */}
                <View style={styles.timelineContainer}>
                  {incident.timeline.slice(-3).map((entry) => (
                    <View key={entry.id} style={styles.timelineEntry}>
                      <View style={styles.timelineDot} />
                      <Text style={styles.timelineText}>
                        {entry.action} <Text style={styles.timelineBy}>— {entry.by}</Text>
                      </Text>
                      <Text style={styles.timelineTime}>{formatTimeAgo(entry.timestamp)}</Text>
                    </View>
                  ))}
                </View>

                {/* Actions */}
                <View style={styles.actionsRow}>
                  {incident.status === 'active' && (
                    <TouchableOpacity
                      style={[styles.actionBtn, { backgroundColor: '#f59e0b' }]}
                      onPress={() => handleAcknowledge(incident)}
                    >
                      <Text style={styles.actionBtnText}>Acquitter</Text>
                    </TouchableOpacity>
                  )}
                  {(incident.status === 'active' || incident.status === 'acknowledged') && (
                    <TouchableOpacity
                      style={[styles.actionBtn, { backgroundColor: '#3b82f6' }]}
                      onPress={() => {
                        setSelectedIncident(incident);
                        setShowAssignModal(true);
                      }}
                    >
                      <Text style={styles.actionBtnText}>Assigner</Text>
                    </TouchableOpacity>
                  )}
                  {incident.status !== 'resolved' && (
                    <TouchableOpacity
                      style={[styles.actionBtn, { backgroundColor: '#22c55e' }]}
                      onPress={() => handleResolve(incident)}
                    >
                      <Text style={styles.actionBtnText}>Résoudre</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#1e3a5f' }]}
                    onPress={() => router.push('/(tabs)/explore')}
                  >
                    <Text style={styles.actionBtnText}>Carte</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ))
          ) : (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>{'\u2705'}</Text>
              <Text style={styles.emptyText}>Aucun incident {filter === 'all' ? 'en cours' : formatStatusFr(filter).toLowerCase()}</Text>
            </View>
          )}
        </View>

        {/* Responders */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Responders ({responders.length})</Text>
          {responders.map((responder) => (
            <TouchableOpacity key={responder.id} style={styles.responderCard} onPress={() => openUserProfile(responder.id)}>
              <View style={styles.responderLeft}>
                <View style={[styles.responderDot, { backgroundColor: STATUS_COLORS[responder.status] || '#9ca3af' }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.responderName}>
                    {responder.isConnected ? '\ud83d\udfe2' : '\u26aa'} {responder.name}
                  </Text>
                  <Text style={styles.responderMeta}>
                    {responder.status === 'available' ? '\u2713 Disponible' : responder.status === 'on_duty' ? '\u26a1 En service' : responder.status === 'responding' ? '\ud83d\udea8 En intervention' : '\u2717 Hors service'}
                    {' \u00b7 '}Vu {formatTimeAgo(responder.lastSeen)}
                    {responder.phone ? ` \u00b7 \ud83d\udcf1 ${responder.phone}` : ''}
                  </Text>
                  {/* Tags */}
                  {responder.tags && responder.tags.length > 0 && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 3, marginTop: 3 }}>
                      {responder.tags.slice(0, 3).map((tag) => (
                        <View key={tag} style={{ backgroundColor: '#e0e7ff', paddingHorizontal: 6, paddingVertical: 1, borderRadius: 8 }}>
                          <Text style={{ fontSize: 10, color: '#4338ca', fontWeight: '600' }}>{tag}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {/* Assigned Incidents */}
                  {responder.assignedIncidents && responder.assignedIncidents.length > 0 && (
                    <View style={{ marginTop: 4 }}>
                      <Text style={{ fontSize: 10, fontWeight: '600', color: '#6b7280', marginBottom: 2 }}>
                        \ud83d\udccc Incidents assign\u00e9s ({responder.assignedIncidents.length}):
                      </Text>
                      {responder.assignedIncidents.map((inc) => (
                        <View key={inc.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                          <Text style={{ fontSize: 10 }}>{TYPE_ICONS[inc.type] || '\ud83d\udea8'}</Text>
                          <Text style={{ fontSize: 10, fontWeight: '600', color: '#374151' }}>{formatIncidentId(inc.id)}</Text>
                          <Text style={{ fontSize: 9, color: '#6b7280' }}>{formatIncidentType(inc.type)}</Text>
                          <View style={[styles.severityBadge, { backgroundColor: SEVERITY_COLORS[inc.severity] || '#6b7280', paddingHorizontal: 4, paddingVertical: 0 }]}>
                            <Text style={[styles.severityText, { fontSize: 8 }]}>{formatSeverityFr(inc.severity)}</Text>
                          </View>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <TouchableOpacity
                  style={styles.locateBtn}
                  onPress={(e) => { e.stopPropagation(); router.push('/(tabs)/messages'); }}
                >
                  <Text style={styles.locateBtnText}>{'\u{1F4AC}'}</Text>
                </TouchableOpacity>
                {responder.location && (
                  <TouchableOpacity
                    style={styles.locateBtn}
                    onPress={(e) => { e.stopPropagation(); router.push('/(tabs)/explore'); }}
                  >
                    <Text style={styles.locateBtnText}>{'\u{1F4CD}'}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </TouchableOpacity>
          ))}
        </View>

        <View style={{ height: 20 }} />
      </ScrollView>

      {/* Assign Responder Modal */}
      <Modal visible={showAssignModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Assigner un intervenant</Text>
            {selectedIncident && (
              <Text style={styles.modalSubtitle}>
                {TYPE_ICONS[selectedIncident.type] || '\u{1F6A8}'} {formatIncidentId(selectedIncident.id)} — {selectedIncident.description.substring(0, 50)}...
              </Text>
            )}
            <ScrollView style={styles.modalList}>
              {/* Already assigned section with unassign */}
              {selectedIncident && selectedIncident.assignedResponders.length > 0 && (
                <>
                  <Text style={styles.modalSectionLabel}>D\u00e9j\u00e0 assign\u00e9s</Text>
                  {selectedIncident.assignedResponders.map((rid) => {
                    const r = responders.find((rr) => rr.id === rid);
                    const name = r?.name || (selectedIncident.respondingNames?.[selectedIncident.assignedResponders.indexOf(rid)]) || rid;
                    const dist = r?.location && selectedIncident
                      ? LocationService.formatDistance(LocationService.distanceBetween(
                          r.location.latitude, r.location.longitude,
                          selectedIncident.location.latitude, selectedIncident.location.longitude
                        ))
                      : null;
                    return (
                      <View key={rid} style={[styles.modalItem, { backgroundColor: 'rgba(34,197,94,0.08)', borderColor: 'rgba(34,197,94,0.3)' }]}>
                        <View style={[styles.responderDot, { backgroundColor: '#f59e0b' }]} />
                        <View style={styles.modalItemInfo}>
                          <Text style={styles.modalItemName}>{name}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text style={[styles.modalItemStatus, { color: '#22c55e' }]}>Assign\u00e9</Text>
                            {dist && <Text style={{ fontSize: 11, fontWeight: '600', color: '#0ea5e9' }}>\uD83D\uDCCD {dist}</Text>}
                          </View>
                        </View>
                        <TouchableOpacity
                          onPress={() => selectedIncident && handleUnassignResponder(selectedIncident, rid)}
                          style={{ paddingHorizontal: 10, paddingVertical: 6, backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: 6 }}
                        >
                          <Text style={{ fontSize: 11, fontWeight: '700', color: '#ef4444' }}>\u274C</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </>
              )}
              {/* Available responders with distance */}
              {(() => {
                const notAssigned = availableResponders
                  .filter((r) => !selectedIncident?.assignedResponders.includes(r.id))
                  .map((r) => {
                    const dist = r.location && selectedIncident
                      ? LocationService.distanceBetween(
                          r.location.latitude, r.location.longitude,
                          selectedIncident.location.latitude, selectedIncident.location.longitude
                        )
                      : null;
                    return { ...r, _distMeters: dist };
                  })
                  .sort((a, b) => {
                    if (a._distMeters !== null && b._distMeters !== null) return a._distMeters - b._distMeters;
                    if (a._distMeters !== null) return -1;
                    if (b._distMeters !== null) return 1;
                    return a.name.localeCompare(b.name);
                  });
                if (notAssigned.length === 0 && (!selectedIncident || selectedIncident.assignedResponders.length === 0)) {
                  return <Text style={styles.modalEmpty}>Aucun responder disponible</Text>;
                }
                return (
                  <>
                    {notAssigned.length > 0 && <Text style={styles.modalSectionLabel}>Disponibles</Text>}
                    {notAssigned.map((responder) => (
                      <TouchableOpacity
                        key={responder.id}
                        style={styles.modalItem}
                        onPress={() => selectedIncident && handleAssignResponder(selectedIncident, responder)}
                      >
                        <View style={[styles.responderDot, { backgroundColor: STATUS_COLORS[responder.status] }]} />
                        <View style={styles.modalItemInfo}>
                          <Text style={styles.modalItemName}>{responder.name}</Text>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            <Text style={styles.modalItemStatus}>
                              {responder.status === 'available' ? 'Disponible' : responder.status === 'on_duty' ? 'En service' : 'En intervention'}
                            </Text>
                            {responder._distMeters !== null && (
                              <Text style={{ fontSize: 11, fontWeight: '600', color: '#0ea5e9' }}>\uD83D\uDCCD {LocationService.formatDistance(responder._distMeters)}</Text>
                            )}
                          </View>
                        </View>
                        <Text style={{ fontSize: 12, fontWeight: '600', color: '#3b82f6' }}>Assigner \u2192</Text>
                      </TouchableOpacity>
                    ))}
                  </>
                );
              })()}
            </ScrollView>
            <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setShowAssignModal(false)}>
              <Text style={styles.modalCloseBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Zone Broadcast Modal */}
      <Modal visible={showBroadcastModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>{'\u{1F4E2}'} Zone Broadcast</Text>
            <Text style={styles.modalSubtitle}>Send an alert to all units within a radius</Text>
            <View style={styles.radiusRow}>
              <Text style={styles.radiusLabel}>Severity:</Text>
              <View style={styles.radiusOptions}>
                {['low', 'medium', 'high', 'critical'].map((s) => (
                  <TouchableOpacity
                    key={s}
                    style={[styles.radiusChip, broadcastSeverity === s && { backgroundColor: s === 'critical' ? '#ef4444' : s === 'high' ? '#f59e0b' : s === 'medium' ? '#3b82f6' : '#6b7280' }]}
                    onPress={() => setBroadcastSeverity(s)}
                  >
                    <Text style={[styles.radiusChipText, broadcastSeverity === s && styles.radiusChipTextActive]}>{s.charAt(0).toUpperCase() + s.slice(1)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <TextInput
              style={styles.broadcastInput}
              placeholder="Enter broadcast message..."
              placeholderTextColor="#9ca3af"
              multiline
              numberOfLines={3}
              value={broadcastMessage}
              onChangeText={setBroadcastMessage}
            />
            <View style={styles.radiusRow}>
              <Text style={styles.radiusLabel}>Radius (km):</Text>
              <View style={styles.radiusOptions}>
                {['1', '5', '10', '25'].map((r) => (
                  <TouchableOpacity
                    key={r}
                    style={[styles.radiusChip, broadcastRadius === r && styles.radiusChipActive]}
                    onPress={() => setBroadcastRadius(r)}
                  >
                    <Text style={[styles.radiusChipText, broadcastRadius === r && styles.radiusChipTextActive]}>{r}km</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
            <TouchableOpacity style={styles.sendBroadcastBtn} onPress={handleBroadcast}>
              <Text style={styles.sendBroadcastBtnText}>Send Broadcast</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setShowBroadcastModal(false)}>
              <Text style={styles.modalCloseBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* User Profile Modal */}
      <Modal visible={showUserProfile} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '85%' }]}>
            {profileLoading ? (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <ActivityIndicator size="large" color="#1e3a5f" />
                <Text style={{ marginTop: 12, color: '#6b7280' }}>Loading profile...</Text>
              </View>
            ) : profileUser ? (
              <ScrollView showsVerticalScrollIndicator={false}>
                {/* Profile Header */}
                <View style={{ alignItems: 'center', marginBottom: 16 }}>
                  <View style={{
                    width: 64, height: 64, borderRadius: 32, backgroundColor: '#1e3a5f',
                    alignItems: 'center', justifyContent: 'center', marginBottom: 8,
                  }}>
                    <Text style={{ color: '#fff', fontSize: 24, fontWeight: '700' }}>
                      {(profileUser.firstName || profileUser.name || '?')[0].toUpperCase()}
                    </Text>
                  </View>
                  <Text style={{ fontSize: 18, fontWeight: '700', color: '#1f2937' }}>
                    {profileUser.firstName && profileUser.lastName
                      ? `${profileUser.firstName} ${profileUser.lastName}`
                      : profileUser.name}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}>
                    <View style={[styles.severityBadge, { backgroundColor: SEVERITY_COLORS[profileUser.role] || '#6b7280' }]}>
                      <Text style={styles.severityText}>{(profileUser.role || 'user').toUpperCase()}</Text>
                    </View>
                    <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[profileUser.status] || '#6b7280' }]}>
                      <Text style={styles.statusBadgeText}>{(profileUser.status || 'unknown').toUpperCase()}</Text>
                    </View>
                  </View>
                </View>

                {/* Tags */}
                {profileUser.tags && profileUser.tags.length > 0 && (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 12, justifyContent: 'center' }}>
                    {profileUser.tags.map((tag: string) => (
                      <View key={tag} style={{ backgroundColor: '#e0e7ff', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 }}>
                        <Text style={{ fontSize: 11, color: '#4338ca', fontWeight: '600' }}>{tag}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* Contact Info */}
                <View style={{ backgroundColor: '#f9fafb', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 8 }}>Contact</Text>
                  {profileUser.email && (
                    <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{'\u2709\uFE0F'} {profileUser.email}</Text>
                  )}
                  {profileUser.phoneMobile && (
                    <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{'\u{1F4F1}'} {profileUser.phoneMobile}</Text>
                  )}
                  {profileUser.phoneFixed && (
                    <Text style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>{'\u{1F4DE}'} {profileUser.phoneFixed}</Text>
                  )}
                  {profileUser.address && (
                    <Text style={{ fontSize: 12, color: '#6b7280' }}>{'\u{1F4CD}'} {profileUser.address}</Text>
                  )}
                </View>

                {/* Relations */}
                {profileUser.relationships && profileUser.relationships.length > 0 && (
                  <View style={{ backgroundColor: '#f9fafb', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 8 }}>Relations</Text>
                    {profileUser.relationships.map((rel: any, idx: number) => (
                      <TouchableOpacity
                        key={idx}
                        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}
                        onPress={() => openUserProfile(rel.userId)}
                      >
                        <Text style={{ fontSize: 12, color: '#3b82f6' }}>
                          {rel.userName || rel.userId} — {rel.type}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Same Address */}
                {profileUser.sameAddress && profileUser.sameAddress.length > 0 && (
                  <View style={{ backgroundColor: '#f9fafb', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 8 }}>Same Address</Text>
                    {profileUser.sameAddress.map((sa: any, idx: number) => (
                      <TouchableOpacity
                        key={idx}
                        style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4 }}
                        onPress={() => openUserProfile(sa.id)}
                      >
                        <Text style={{ fontSize: 12, color: '#3b82f6' }}>
                          {sa.firstName && sa.lastName ? `${sa.firstName} ${sa.lastName}` : sa.name} — {sa.role}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {/* Comments */}
                {profileUser.comments && (
                  <View style={{ backgroundColor: '#f9fafb', borderRadius: 10, padding: 12, marginBottom: 12 }}>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 4 }}>Comments</Text>
                    <Text style={{ fontSize: 12, color: '#6b7280' }}>{profileUser.comments}</Text>
                  </View>
                )}

                {/* Action Buttons */}
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#1e3a5f', flex: 1 }]}
                    onPress={() => { setShowUserProfile(false); router.push('/(tabs)/messages'); }}
                  >
                    <Text style={styles.actionBtnText}>{'\u{1F4AC}'} Message</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionBtn, { backgroundColor: '#059669', flex: 1 }]}
                    onPress={() => { setShowUserProfile(false); router.push('/(tabs)/explore'); }}
                  >
                    <Text style={styles.actionBtnText}>{'\u{1F4CD}'} Locate</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            ) : (
              <View style={{ padding: 40, alignItems: 'center' }}>
                <Text style={{ color: '#ef4444', fontSize: 14 }}>Failed to load profile</Text>
              </View>
            )}
            <TouchableOpacity style={styles.modalCloseBtn} onPress={() => setShowUserProfile(false)}>
              <Text style={styles.modalCloseBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </TalionScreen>
  );
}

const styles = StyleSheet.create({
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, color: '#6b7280', fontSize: 14 },
  scrollView: { flex: 1 },
  scrollContent: { paddingBottom: 16 },
  errorBanner: {
    backgroundColor: '#fef2f2', padding: 12, marginHorizontal: 16, marginTop: 12,
    borderRadius: 8, borderLeftWidth: 3, borderLeftColor: '#ef4444',
  },
  errorBannerText: { color: '#991b1b', fontSize: 13, fontWeight: '500' },
  statsRow: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12, gap: 6 },
  statCard: {
    flex: 1, backgroundColor: '#ffffff', borderRadius: 10, padding: 10, alignItems: 'center',
    borderLeftWidth: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
  },
  statNumber: { fontSize: 20, fontWeight: '800' },
  statLabel: { fontSize: 10, color: '#6b7280', marginTop: 2, fontWeight: '500' },
  broadcastButton: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginHorizontal: 16, marginTop: 12,
    backgroundColor: '#1e3a5f', borderRadius: 10, paddingVertical: 12, gap: 8,
  },
  broadcastButtonIcon: { fontSize: 18 },
  broadcastButtonText: { color: '#ffffff', fontWeight: '700', fontSize: 14 },
  refreshRow: {
    paddingHorizontal: 16, paddingTop: 8, alignItems: 'center',
  },
  refreshText: { fontSize: 13, color: '#3b82f6', fontWeight: '500' },
  filterTabs: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12, gap: 6 },
  filterTab: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, backgroundColor: '#f3f4f6' },
  filterTabActive: { backgroundColor: '#1e3a5f' },
  filterTabText: { fontSize: 12, fontWeight: '600', color: '#6b7280' },
  filterTabTextActive: { color: '#ffffff' },
  section: { paddingHorizontal: 16, paddingTop: 16 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#1e3a5f', marginBottom: 10 },
  incidentCard: {
    backgroundColor: '#ffffff', borderRadius: 12, padding: 14, marginBottom: 10, borderLeftWidth: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
  },
  incidentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  incidentHeaderLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 8 },
  incidentTypeIcon: { fontSize: 24 },
  incidentUserName: { fontSize: 14, fontWeight: '600', color: '#1f2937' },
  incidentAddress: { fontSize: 11, color: '#6b7280', maxWidth: 180 },
  incidentHeaderRight: { alignItems: 'flex-end', gap: 4 },
  severityBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  severityText: { color: '#ffffff', fontWeight: '700', fontSize: 10 },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4 },
  statusBadgeText: { color: '#ffffff', fontWeight: '700', fontSize: 9 },
  incidentDescription: { fontSize: 12, color: '#6b7280', marginBottom: 4 },
  incidentTime: { fontSize: 11, color: '#9ca3af', marginBottom: 8 },
  assignedRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  assignedLabel: { fontSize: 11, fontWeight: '600', color: '#374151' },
  assignedChip: { backgroundColor: '#dbeafe', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10 },
  assignedChipText: { fontSize: 10, fontWeight: '600', color: '#2563eb' },
  timelineContainer: { marginBottom: 10, paddingLeft: 4 },
  timelineEntry: { flexDirection: 'row', alignItems: 'center', marginBottom: 4, gap: 6 },
  timelineDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#1e3a5f' },
  timelineText: { fontSize: 11, color: '#374151', flex: 1 },
  timelineBy: { color: '#9ca3af' },
  timelineTime: { fontSize: 10, color: '#9ca3af' },
  actionsRow: { flexDirection: 'row', gap: 6 },
  actionBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  actionBtnText: { color: '#ffffff', fontWeight: '600', fontSize: 11 },
  responderCard: {
    backgroundColor: '#ffffff', borderRadius: 10, padding: 12, marginBottom: 8, flexDirection: 'row',
    justifyContent: 'space-between', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 2, elevation: 1,
  },
  responderLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  responderDot: { width: 10, height: 10, borderRadius: 5 },
  responderName: { fontSize: 13, fontWeight: '600', color: '#1f2937' },
  responderMeta: { fontSize: 11, color: '#6b7280' },
  locateBtn: { padding: 6 },
  locateBtnText: { fontSize: 18 },
  emptyState: { padding: 32, alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 12 },
  emptyIcon: { fontSize: 32, marginBottom: 8 },
  emptyText: { color: '#9ca3af', fontSize: 14 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#ffffff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '70%' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1e3a5f', marginBottom: 4 },
  modalSubtitle: { fontSize: 13, color: '#6b7280', marginBottom: 16 },
  modalList: { maxHeight: 300 },
  modalItem: { flexDirection: 'row', alignItems: 'center', padding: 14, borderBottomWidth: 1, borderBottomColor: '#f3f4f6', gap: 12 },
  modalItemInfo: { flex: 1 },
  modalItemName: { fontSize: 14, fontWeight: '600', color: '#1f2937' },
  modalItemStatus: { fontSize: 12, color: '#6b7280' },
  modalEmpty: { padding: 24, textAlign: 'center', color: '#9ca3af' },
  modalSectionLabel: { fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, color: '#6b7280', paddingVertical: 8, paddingHorizontal: 4 },
  modalCloseBtn: { marginTop: 12, paddingVertical: 12, alignItems: 'center', borderRadius: 10, backgroundColor: '#f3f4f6' },
  modalCloseBtnText: { fontWeight: '600', color: '#6b7280' },
  broadcastInput: {
    borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, padding: 12, fontSize: 14, color: '#1f2937',
    minHeight: 80, textAlignVertical: 'top', marginBottom: 12,
  },
  radiusRow: { marginBottom: 16 },
  radiusLabel: { fontSize: 13, fontWeight: '600', color: '#374151', marginBottom: 8 },
  radiusOptions: { flexDirection: 'row', gap: 8 },
  radiusChip: { paddingVertical: 6, paddingHorizontal: 14, borderRadius: 16, backgroundColor: '#f3f4f6' },
  radiusChipActive: { backgroundColor: '#1e3a5f' },
  radiusChipText: { fontSize: 12, fontWeight: '600', color: '#6b7280' },
  radiusChipTextActive: { color: '#ffffff' },
  sendBroadcastBtn: { backgroundColor: '#1e3a5f', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  sendBroadcastBtnText: { color: '#ffffff', fontWeight: '700', fontSize: 15 },
});
