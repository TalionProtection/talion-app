import React, { useState, useEffect, useMemo, useCallback } from 'react';
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
  Platform,
  Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { formatIncidentId, formatIncidentType, formatStatusFr, formatSeverityFr } from '@/lib/format-utils';
import { useAuth } from '@/hooks/useAuth';
import { TalionScreen } from '@/components/talion-banner';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import type { UserRole } from '@/lib/auth-context';
import { offlineCache } from '@/services/offline-cache';

// Types matching server AdminUser (without passwordHash)
interface ServerUser {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  role: UserRole;
  status: 'active' | 'suspended' | 'deactivated';
  lastLogin: number;
  createdAt: number;
  phoneMobile?: string;
  phoneLandline?: string;
  address?: string;
  tags?: string[];
  comments?: string;
  photoUrl?: string;
  hasPassword?: boolean;
  relationships?: { userId: string; type: string; userName?: string }[];
}

interface AdminIncident {
  id: string;
  type: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  status: 'active' | 'acknowledged' | 'dispatched' | 'resolved';
  reportedBy: string;
  address: string;
  timestamp: number;
  resolvedAt?: number;
  assignedCount: number;
}

interface AuditEntry {
  id: string;
  action: string;
  performedBy: string;
  targetUser?: string;
  details: string;
  timestamp: number;
  category: 'auth' | 'incident' | 'user' | 'system' | 'broadcast';
}

type AdminTab = 'users' | 'incidents' | 'analytics' | 'audit';

const ROLE_COLORS: Record<UserRole, string> = {
  admin: '#7c3aed',
  dispatcher: '#1e3a5f',
  responder: '#059669',
  user: '#6b7280',
};

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Admin',
  dispatcher: 'Dispatcher',
  responder: 'Intervenant',
  user: 'Utilisateur',
};

const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  suspended: '#f59e0b',
  deactivated: '#ef4444',
  acknowledged: '#f59e0b',
  dispatched: '#3b82f6',
  resolved: '#22c55e',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f59e0b',
  medium: '#3b82f6',
  low: '#6b7280',
};

const AUDIT_ICONS: Record<string, string> = {
  auth: '🔐',
  incident: '🚨',
  user: '👤',
  system: '⚙️',
  broadcast: '📢',
};

const TYPE_ICONS: Record<string, string> = {
  sos: '🆘',
  medical: '🏥',
  fire: '🔥',
  security: '🔒',
  hazard: '⚠️',
};

const RELATIONSHIP_TYPES = [
  { value: 'spouse', label: 'Conjoint(e)' },
  { value: 'parent', label: 'Parent' },
  { value: 'child', label: 'Enfant' },
  { value: 'sibling', label: 'Frère/Sœur' },
  { value: 'cohabitant', label: 'Cohabitant' },
  { value: 'other', label: 'Autre' },
];

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getDate().toString().padStart(2, '0')}/${(d.getMonth() + 1).toString().padStart(2, '0')}/${d.getFullYear()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

// ─── Empty form state ────────────────────────────────────────────────
interface UserFormData {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  role: UserRole;
  status: 'active' | 'suspended' | 'deactivated';
  phoneMobile: string;
  phoneLandline: string;
  address: string;
  tags: string;
  comments: string;
  photoUri: string;
  relationships: { userId: string; type: string; userName?: string }[];
}

const EMPTY_FORM: UserFormData = {
  firstName: '',
  lastName: '',
  email: '',
  password: '',
  role: 'user',
  status: 'active',
  phoneMobile: '',
  phoneLandline: '',
  address: '',
  tags: '',
  comments: '',
  photoUri: '',
  relationships: [],
};

// ─── Main Component ──────────────────────────────────────────────────
export default function AdminScreen() {
  const { user } = useAuth();
  const BASE = getApiBaseUrl();

  const [activeTab, setActiveTab] = useState<AdminTab>('users');
  const [isLoading, setIsLoading] = useState(true);
  const [users, setUsers] = useState<ServerUser[]>([]);
  const [incidents, setIncidents] = useState<AdminIncident[]>([]);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<ServerUser | null>(null);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [showUserForm, setShowUserForm] = useState(false);
  const [editingUser, setEditingUser] = useState<ServerUser | null>(null);
  const [formData, setFormData] = useState<UserFormData>(EMPTY_FORM);
  const [formLoading, setFormLoading] = useState(false);
  const [incidentFilter, setIncidentFilter] = useState<'all' | 'active' | 'resolved'>('all');
  const [auditFilter, setAuditFilter] = useState<string>('all');

  // ─── Data Loading (from real server) ──────────────────────────────
  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${BASE}/admin/users`, { timeout: 10000 });
      if (res.ok) {
        const data = await res.json();
        setUsers(data);
        offlineCache.cacheUsers(data);
      }
    } catch (e) {
      console.warn('Failed to fetch users, trying cache:', e);
      const cached = await offlineCache.getCachedUsers();
      if (cached) setUsers(cached as any);
    }
  }, [BASE]);

  const fetchIncidents = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${BASE}/alerts`, { timeout: 10000 });
      if (res.ok) {
        // Also cache alerts from admin view
        const data = await res.json();
        setIncidents(data.map((a: any) => ({
          id: a.id,
          type: a.type || 'sos',
          severity: a.severity || 'high',
          status: a.status || 'active',
          reportedBy: a.reportedBy || a.userName || 'Unknown',
          address: a.address || a.location?.address || 'Unknown',
          timestamp: a.timestamp || Date.now(),
          resolvedAt: a.resolvedAt,
          assignedCount: a.assignedResponders?.length || 0,
        })));
      }
    } catch (e) {
      console.warn('Failed to fetch incidents:', e);
    }
  }, [BASE]);

  const fetchAudit = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${BASE}/admin/audit`, { timeout: 10000 });
      if (res.ok) {
        const data = await res.json();
        setAuditLog(data);
      }
    } catch (e) {
      console.warn('Failed to fetch audit:', e);
    }
  }, [BASE]);

  const loadAllData = useCallback(async () => {
    setIsLoading(true);
    await Promise.all([fetchUsers(), fetchIncidents(), fetchAudit()]);
    setIsLoading(false);
  }, [fetchUsers, fetchIncidents, fetchAudit]);

  useEffect(() => {
    loadAllData();
  }, []);

  // ─── User CRUD Handlers ───────────────────────────────────────────
  const openCreateForm = useCallback(() => {
    setEditingUser(null);
    setFormData(EMPTY_FORM);
    setShowUserForm(true);
  }, []);

  const openEditForm = useCallback((u: ServerUser) => {
    setEditingUser(u);
    setFormData({
      firstName: u.firstName || '',
      lastName: u.lastName || '',
      email: u.email || '',
      password: '',
      role: u.role,
      status: u.status,
      phoneMobile: u.phoneMobile || '',
      phoneLandline: u.phoneLandline || '',
      address: u.address || '',
      tags: (u.tags || []).join(', '),
      comments: u.comments || '',
      photoUri: u.photoUrl || '',
      relationships: u.relationships || [],
    });
    setShowUserForm(true);
  }, []);

  const handleSaveUser = useCallback(async () => {
    if (!formData.firstName.trim() || !formData.lastName.trim() || !formData.email.trim()) {
      Alert.alert('Erreur', 'Prénom, nom et email sont obligatoires.');
      return;
    }
    if (!editingUser && !formData.password.trim()) {
      Alert.alert('Erreur', 'Le mot de passe est obligatoire pour un nouvel utilisateur.');
      return;
    }

    setFormLoading(true);
    try {
      const tags = formData.tags.split(',').map(t => t.trim()).filter(Boolean);
      const payload: any = {
        firstName: formData.firstName.trim(),
        lastName: formData.lastName.trim(),
        email: formData.email.trim(),
        role: formData.role,
        status: formData.status,
        phoneMobile: formData.phoneMobile.trim() || undefined,
        phoneLandline: formData.phoneLandline.trim() || undefined,
        address: formData.address.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        comments: formData.comments.trim() || undefined,
        relationships: formData.relationships.map(r => ({ userId: r.userId, type: r.type })),
      };
      if (formData.password.trim()) {
        payload.password = formData.password.trim();
      }

      const url = editingUser ? `${BASE}/admin/users/${editingUser.id}` : `${BASE}/admin/users`;
      const method = editingUser ? 'PUT' : 'POST';

      const res = await fetchWithTimeout(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 10000,
      });

      if (res.ok) {
        const savedUser = await res.json();
        const userId = editingUser?.id || savedUser.id;

        // Upload photo if a new local photo was selected (starts with file:// or content://)
        if (formData.photoUri && (formData.photoUri.startsWith('file://') || formData.photoUri.startsWith('content://') || formData.photoUri.startsWith('data:'))) {
          try {
            const photoForm = new FormData();
            const filename = formData.photoUri.split('/').pop() || 'photo.jpg';
            const match = /\.([\w]+)$/.exec(filename);
            const type = match ? `image/${match[1]}` : 'image/jpeg';
            photoForm.append('photo', {
              uri: formData.photoUri,
              name: filename,
              type,
            } as any);
            await fetchWithTimeout(`${BASE}/admin/users/${userId}/photo`, {
              method: 'POST',
              body: photoForm,
              timeout: 15000,
            });
          } catch (photoErr) {
            console.warn('Photo upload failed:', photoErr);
          }
        }

        setShowUserForm(false);
        setEditingUser(null);
        setFormData(EMPTY_FORM);
        await fetchUsers();
        Alert.alert(
          editingUser ? 'Utilisateur modifié' : 'Utilisateur créé',
          `${formData.firstName} ${formData.lastName} a été ${editingUser ? 'modifié' : 'créé'} avec succès.`
        );
      } else {
        const err = await res.json().catch(() => ({}));
        Alert.alert('Erreur', err.error || `Échec (${res.status})`);
      }
    } catch (e: any) {
      Alert.alert('Erreur', e.message || 'Impossible de contacter le serveur.');
    } finally {
      setFormLoading(false);
    }
  }, [formData, editingUser, BASE, fetchUsers]);

  // ─── Photo Picker ─────────────────────────────────────────────────
  const pickPhoto = useCallback(async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        quality: 0.7,
        aspect: [1, 1],
      });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        setFormData(p => ({ ...p, photoUri: result.assets[0].uri }));
      }
    } catch (e) {
      console.warn('Image picker error:', e);
    }
  }, []);

  const takePhoto = useCallback(async () => {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'L\'accès à la caméra est nécessaire.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        quality: 0.7,
        aspect: [1, 1],
      });
      if (!result.canceled && result.assets && result.assets.length > 0) {
        setFormData(p => ({ ...p, photoUri: result.assets[0].uri }));
      }
    } catch (e) {
      console.warn('Camera error:', e);
    }
  }, []);

  // ─── Relationship Management ──────────────────────────────────────
  const [showRelationModal, setShowRelationModal] = useState(false);
  const [relSearchQuery, setRelSearchQuery] = useState('');
  const [selectedRelType, setSelectedRelType] = useState('spouse');

  const availableUsersForRelation = useMemo(() => {
    const currentRelIds = new Set(formData.relationships.map(r => r.userId));
    const editId = editingUser?.id;
    return users.filter(u => {
      if (u.id === editId) return false;
      if (currentRelIds.has(u.id)) return false;
      if (!relSearchQuery.trim()) return true;
      const q = relSearchQuery.toLowerCase();
      return u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q);
    });
  }, [users, formData.relationships, editingUser, relSearchQuery]);

  const addRelationship = useCallback((targetUser: ServerUser, type: string) => {
    setFormData(p => ({
      ...p,
      relationships: [...p.relationships, { userId: targetUser.id, type, userName: targetUser.name }],
    }));
    setShowRelationModal(false);
    setRelSearchQuery('');
  }, []);

  const removeRelationship = useCallback((index: number) => {
    setFormData(p => ({
      ...p,
      relationships: p.relationships.filter((_, i) => i !== index),
    }));
  }, []);

  const handleDeleteUser = useCallback(async (targetUser: ServerUser) => {
    if (targetUser.id === user?.id) {
      Alert.alert('Erreur', 'Vous ne pouvez pas supprimer votre propre compte.');
      return;
    }
    Alert.alert(
      'Supprimer l\'utilisateur',
      `Êtes-vous sûr de vouloir supprimer ${targetUser.firstName} ${targetUser.lastName} ? Cette action est irréversible.`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await fetchWithTimeout(`${BASE}/admin/users/${targetUser.id}`, { method: 'DELETE', timeout: 10000 });
              if (res.ok) {
                await fetchUsers();
                Alert.alert('Supprimé', `${targetUser.firstName} ${targetUser.lastName} a été supprimé.`);
              } else {
                Alert.alert('Erreur', 'Impossible de supprimer cet utilisateur.');
              }
            } catch {
              Alert.alert('Erreur', 'Impossible de contacter le serveur.');
            }
          },
        },
      ]
    );
  }, [user, BASE, fetchUsers]);

  const handleChangeRole = useCallback(async (targetUser: ServerUser, newRole: UserRole) => {
    if (targetUser.id === user?.id) {
      Alert.alert('Erreur', 'Vous ne pouvez pas changer votre propre rôle.');
      return;
    }
    try {
      const res = await fetchWithTimeout(`${BASE}/admin/users/${targetUser.id}/role`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
        timeout: 10000,
      });
      if (res.ok) {
        await fetchUsers();
        setShowRoleModal(false);
        setSelectedUser(null);
        Alert.alert('Rôle mis à jour', `${targetUser.firstName} ${targetUser.lastName} est maintenant ${ROLE_LABELS[newRole]}.`);
      }
    } catch {
      Alert.alert('Erreur', 'Impossible de contacter le serveur.');
    }
  }, [user, BASE, fetchUsers]);

  const handleToggleStatus = useCallback(async (targetUser: ServerUser) => {
    if (targetUser.id === user?.id) {
      Alert.alert('Erreur', 'Vous ne pouvez pas changer votre propre statut.');
      return;
    }
    const newStatus = targetUser.status === 'active' ? 'suspended' : 'active';
    const label = newStatus === 'suspended' ? 'Suspendre' : 'Réactiver';

    Alert.alert(
      `${label} l'utilisateur`,
      `Êtes-vous sûr de vouloir ${label.toLowerCase()} ${targetUser.firstName} ${targetUser.lastName} ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: label,
          style: newStatus === 'suspended' ? 'destructive' : 'default',
          onPress: async () => {
            try {
              const res = await fetchWithTimeout(`${BASE}/admin/users/${targetUser.id}/status`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: newStatus }),
                timeout: 10000,
              });
              if (res.ok) await fetchUsers();
            } catch {
              Alert.alert('Erreur', 'Impossible de contacter le serveur.');
            }
          },
        },
      ]
    );
  }, [user, BASE, fetchUsers]);

  // ─── Filtered Data ─────────────────────────────────────────────────
  const filteredUsers = useMemo(() => {
    let result = users;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(u =>
        (u.firstName || '').toLowerCase().includes(q) ||
        (u.lastName || '').toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q) ||
        (u.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    return result.sort((a, b) => {
      const roleOrder: Record<UserRole, number> = { admin: 0, dispatcher: 1, responder: 2, user: 3 };
      return roleOrder[a.role] - roleOrder[b.role];
    });
  }, [users, searchQuery]);

  const filteredIncidents = useMemo(() => {
    let result = incidents;
    if (incidentFilter === 'active') result = result.filter(i => i.status !== 'resolved');
    if (incidentFilter === 'resolved') result = result.filter(i => i.status === 'resolved');
    return result.sort((a, b) => b.timestamp - a.timestamp);
  }, [incidents, incidentFilter]);

  const filteredAudit = useMemo(() => {
    let result = auditLog;
    if (auditFilter !== 'all') result = result.filter(e => e.category === auditFilter);
    return result.sort((a, b) => b.timestamp - a.timestamp);
  }, [auditLog, auditFilter]);

  // ─── Analytics ─────────────────────────────────────────────────────
  const analytics = useMemo(() => {
    const totalUsers = users.length;
    const activeUsers = users.filter(u => u.status === 'active').length;
    const suspendedUsers = users.filter(u => u.status === 'suspended').length;
    const deactivatedUsers = users.filter(u => u.status === 'deactivated').length;
    const byRole = {
      admin: users.filter(u => u.role === 'admin').length,
      dispatcher: users.filter(u => u.role === 'dispatcher').length,
      responder: users.filter(u => u.role === 'responder').length,
      user: users.filter(u => u.role === 'user').length,
    };
    const totalIncidents = incidents.length;
    const activeIncidents = incidents.filter(i => i.status !== 'resolved').length;
    const resolvedIncidents = incidents.filter(i => i.status === 'resolved').length;
    const criticalIncidents = incidents.filter(i => i.severity === 'critical').length;
    const bySeverity = {
      critical: incidents.filter(i => i.severity === 'critical').length,
      high: incidents.filter(i => i.severity === 'high').length,
      medium: incidents.filter(i => i.severity === 'medium').length,
      low: incidents.filter(i => i.severity === 'low').length,
    };
    const avgResponseTime = resolvedIncidents > 0
      ? incidents
          .filter(i => i.resolvedAt)
          .reduce((sum, i) => sum + ((i.resolvedAt! - i.timestamp) / 60000), 0) / resolvedIncidents
      : 0;

    return {
      totalUsers, activeUsers, suspendedUsers, deactivatedUsers, byRole,
      totalIncidents, activeIncidents, resolvedIncidents, criticalIncidents,
      bySeverity, avgResponseTime,
    };
  }, [users, incidents]);

  // ─── Tab Navigation ────────────────────────────────────────────────
  const TABS: { key: AdminTab; label: string; icon: string }[] = [
    { key: 'users', label: 'Users', icon: '👥' },
    { key: 'incidents', label: 'Incidents', icon: '🚨' },
    { key: 'analytics', label: 'Analytics', icon: '📊' },
    { key: 'audit', label: 'Audit', icon: '📋' },
  ];

  if (isLoading) {
    return (
      <TalionScreen statusText="Admin" statusColor="#7c3aed">
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#7c3aed" />
          <Text style={styles.loadingText}>Chargement...</Text>
        </View>
      </TalionScreen>
    );
  }

  return (
    <TalionScreen statusText="Admin" statusColor="#7c3aed">
      {/* Sub-tab Navigation */}
      <View style={styles.tabBar}>
        {TABS.map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={styles.tabIcon}>{tab.icon}</Text>
            <Text style={[styles.tabLabel, activeTab === tab.key && styles.tabLabelActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {activeTab === 'users' && renderUsersTab()}
        {activeTab === 'incidents' && renderIncidentsTab()}
        {activeTab === 'analytics' && renderAnalyticsTab()}
        {activeTab === 'audit' && renderAuditTab()}
      </ScrollView>

      {/* Role Change Modal */}
      <Modal visible={showRoleModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Changer le rôle</Text>
            {selectedUser && (
              <Text style={styles.modalSubtitle}>
                {selectedUser.firstName} {selectedUser.lastName} - Actuel : {ROLE_LABELS[selectedUser.role]}
              </Text>
            )}
            <View style={styles.roleGrid}>
              {(['admin', 'dispatcher', 'responder', 'user'] as UserRole[]).map(role => (
                <TouchableOpacity
                  key={role}
                  style={[
                    styles.roleOption,
                    { borderColor: ROLE_COLORS[role] },
                    selectedUser?.role === role && styles.roleOptionDisabled,
                  ]}
                  onPress={() => selectedUser && handleChangeRole(selectedUser, role)}
                  disabled={selectedUser?.role === role}
                >
                  <View style={[styles.roleColorDot, { backgroundColor: ROLE_COLORS[role] }]} />
                  <Text style={[
                    styles.roleOptionText,
                    selectedUser?.role === role && { color: '#9ca3af' },
                  ]}>
                    {ROLE_LABELS[role]}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.modalCancel} onPress={() => { setShowRoleModal(false); setSelectedUser(null); }}>
              <Text style={styles.modalCancelText}>Annuler</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* User Create/Edit Modal */}
      <Modal visible={showUserForm} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '90%' }]}>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={styles.modalTitle}>
                {editingUser ? 'Modifier l\'utilisateur' : 'Nouvel utilisateur'}
              </Text>

              {/* Photo section */}
              <View style={styles.photoSection}>
                <Text style={styles.formLabel}>Photo de profil</Text>
                <View style={styles.photoRow}>
                  {formData.photoUri ? (
                    <View style={styles.photoPreviewContainer}>
                      <Image
                        source={{ uri: formData.photoUri.startsWith('/') ? `${BASE}${formData.photoUri}` : formData.photoUri }}
                        style={styles.photoPreview}
                      />
                      <TouchableOpacity
                        style={styles.photoRemoveBtn}
                        onPress={() => setFormData(p => ({ ...p, photoUri: '' }))}
                      >
                        <Text style={styles.photoRemoveText}>✕</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <View style={styles.photoPlaceholder}>
                      <Text style={styles.photoPlaceholderText}>📷</Text>
                    </View>
                  )}
                  <View style={styles.photoActions}>
                    <TouchableOpacity style={styles.photoBtn} onPress={pickPhoto}>
                      <Text style={styles.photoBtnText}>🖼️ Galerie</Text>
                    </TouchableOpacity>
                    {Platform.OS !== 'web' && (
                      <TouchableOpacity style={styles.photoBtn} onPress={takePhoto}>
                        <Text style={styles.photoBtnText}>📷 Caméra</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </View>

              {/* Name row */}
              <View style={styles.formRow}>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>Prénom *</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formData.firstName}
                    onChangeText={v => setFormData(p => ({ ...p, firstName: v }))}
                    placeholder="Prénom"
                    placeholderTextColor="#9ca3af"
                    returnKeyType="next"
                  />
                </View>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>Nom *</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formData.lastName}
                    onChangeText={v => setFormData(p => ({ ...p, lastName: v }))}
                    placeholder="Nom"
                    placeholderTextColor="#9ca3af"
                    returnKeyType="next"
                  />
                </View>
              </View>

              {/* Email */}
              <Text style={styles.formLabel}>Email *</Text>
              <TextInput
                style={styles.formInput}
                value={formData.email}
                onChangeText={v => setFormData(p => ({ ...p, email: v }))}
                placeholder="email@exemple.com"
                placeholderTextColor="#9ca3af"
                keyboardType="email-address"
                autoCapitalize="none"
                returnKeyType="next"
              />

              {/* Password */}
              <Text style={styles.formLabel}>
                Mot de passe {editingUser ? '(laisser vide pour ne pas changer)' : '*'}
              </Text>
              <TextInput
                style={styles.formInput}
                value={formData.password}
                onChangeText={v => setFormData(p => ({ ...p, password: v }))}
                placeholder={editingUser ? '••••••••' : 'Mot de passe'}
                placeholderTextColor="#9ca3af"
                secureTextEntry
                returnKeyType="next"
              />

              {/* Role selector */}
              <Text style={styles.formLabel}>Rôle</Text>
              <View style={styles.roleSelector}>
                {(['user', 'responder', 'dispatcher', 'admin'] as UserRole[]).map(r => (
                  <TouchableOpacity
                    key={r}
                    style={[
                      styles.roleSelectorBtn,
                      formData.role === r && { backgroundColor: ROLE_COLORS[r], borderColor: ROLE_COLORS[r] },
                    ]}
                    onPress={() => setFormData(p => ({ ...p, role: r }))}
                  >
                    <Text style={[
                      styles.roleSelectorText,
                      formData.role === r && { color: '#fff' },
                    ]}>
                      {ROLE_LABELS[r]}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Status selector (edit only) */}
              {editingUser && (
                <>
                  <Text style={styles.formLabel}>Statut</Text>
                  <View style={styles.roleSelector}>
                    {(['active', 'suspended', 'deactivated'] as const).map(s => (
                      <TouchableOpacity
                        key={s}
                        style={[
                          styles.roleSelectorBtn,
                          formData.status === s && { backgroundColor: STATUS_COLORS[s], borderColor: STATUS_COLORS[s] },
                        ]}
                        onPress={() => setFormData(p => ({ ...p, status: s }))}
                      >
                        <Text style={[
                          styles.roleSelectorText,
                          formData.status === s && { color: '#fff' },
                        ]}>
                          {s === 'active' ? 'Actif' : s === 'suspended' ? 'Suspendu' : 'Désactivé'}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </>
              )}

              {/* Phone row */}
              <View style={styles.formRow}>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>Tél. mobile</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formData.phoneMobile}
                    onChangeText={v => setFormData(p => ({ ...p, phoneMobile: v }))}
                    placeholder="+33 6 12 34 56 78"
                    placeholderTextColor="#9ca3af"
                    keyboardType="phone-pad"
                    returnKeyType="next"
                  />
                </View>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>Tél. fixe</Text>
                  <TextInput
                    style={styles.formInput}
                    value={formData.phoneLandline}
                    onChangeText={v => setFormData(p => ({ ...p, phoneLandline: v }))}
                    placeholder="+33 1 23 45 67 89"
                    placeholderTextColor="#9ca3af"
                    keyboardType="phone-pad"
                    returnKeyType="next"
                  />
                </View>
              </View>

              {/* Address */}
              <Text style={styles.formLabel}>Adresse</Text>
              <TextInput
                style={styles.formInput}
                value={formData.address}
                onChangeText={v => setFormData(p => ({ ...p, address: v }))}
                placeholder="Adresse complète"
                placeholderTextColor="#9ca3af"
                returnKeyType="next"
              />

              {/* Tags */}
              <Text style={styles.formLabel}>Tags (séparés par des virgules)</Text>
              <TextInput
                style={styles.formInput}
                value={formData.tags}
                onChangeText={v => setFormData(p => ({ ...p, tags: v }))}
                placeholder="zone-nord, equipe-alpha"
                placeholderTextColor="#9ca3af"
                returnKeyType="next"
              />

              {/* Comments */}
              <Text style={styles.formLabel}>Commentaires</Text>
              <TextInput
                style={[styles.formInput, { height: 80, textAlignVertical: 'top' }]}
                value={formData.comments}
                onChangeText={v => setFormData(p => ({ ...p, comments: v }))}
                placeholder="Notes ou commentaires..."
                placeholderTextColor="#9ca3af"
                multiline
                numberOfLines={3}
              />

              {/* Relations */}
              <Text style={styles.formLabel}>Relations familiales</Text>
              {formData.relationships.length > 0 && (
                <View style={styles.relList}>
                  {formData.relationships.map((rel, idx) => {
                    const relLabel = RELATIONSHIP_TYPES.find(r => r.value === rel.type)?.label || rel.type;
                    const relName = rel.userName || users.find(u => u.id === rel.userId)?.name || rel.userId;
                    return (
                      <View key={`${rel.userId}-${idx}`} style={styles.relItem}>
                        <View style={styles.relInfo}>
                          <Text style={styles.relName}>{relName}</Text>
                          <Text style={styles.relType}>{relLabel}</Text>
                        </View>
                        <TouchableOpacity onPress={() => removeRelationship(idx)} style={styles.relRemoveBtn}>
                          <Text style={styles.relRemoveText}>✕</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  })}
                </View>
              )}
              <TouchableOpacity
                style={styles.addRelBtn}
                onPress={() => setShowRelationModal(true)}
              >
                <Text style={styles.addRelBtnText}>+ Ajouter une relation</Text>
              </TouchableOpacity>

              {/* Actions */}
              <View style={styles.formActions}>
                <TouchableOpacity
                  style={[styles.formBtn, styles.formBtnPrimary]}
                  onPress={handleSaveUser}
                  disabled={formLoading}
                >
                  {formLoading ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={styles.formBtnPrimaryText}>
                      {editingUser ? 'Enregistrer' : 'Créer'}
                    </Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.formBtn, styles.formBtnCancel]}
                  onPress={() => { setShowUserForm(false); setEditingUser(null); setFormData(EMPTY_FORM); }}
                >
                  <Text style={styles.formBtnCancelText}>Annuler</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Relation Selection Modal */}
      <Modal visible={showRelationModal} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { maxHeight: '80%' }]}>
            <Text style={styles.modalTitle}>Ajouter une relation</Text>

            {/* Relation type selector */}
            <Text style={styles.formLabel}>Type de relation</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.relTypeScroll}>
              {RELATIONSHIP_TYPES.map(rt => (
                <TouchableOpacity
                  key={rt.value}
                  style={[
                    styles.relTypeChip,
                    selectedRelType === rt.value && styles.relTypeChipActive,
                  ]}
                  onPress={() => setSelectedRelType(rt.value)}
                >
                  <Text style={[
                    styles.relTypeChipText,
                    selectedRelType === rt.value && styles.relTypeChipTextActive,
                  ]}>
                    {rt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Search user */}
            <Text style={styles.formLabel}>Rechercher un utilisateur</Text>
            <TextInput
              style={styles.formInput}
              value={relSearchQuery}
              onChangeText={setRelSearchQuery}
              placeholder="Nom ou email..."
              placeholderTextColor="#9ca3af"
              returnKeyType="done"
            />

            {/* User list */}
            <ScrollView style={styles.relUserList}>
              {availableUsersForRelation.slice(0, 20).map(u => (
                <TouchableOpacity
                  key={u.id}
                  style={styles.relUserItem}
                  onPress={() => addRelationship(u, selectedRelType)}
                >
                  <View style={[styles.relUserAvatar, { backgroundColor: ROLE_COLORS[u.role] }]}>
                    <Text style={styles.relUserAvatarText}>{(u.firstName || u.name || '?').charAt(0)}</Text>
                  </View>
                  <View style={styles.relUserInfo}>
                    <Text style={styles.relUserName}>{u.firstName} {u.lastName}</Text>
                    <Text style={styles.relUserEmail}>{u.email}</Text>
                  </View>
                  <View style={[styles.relUserRoleBadge, { backgroundColor: ROLE_COLORS[u.role] + '20' }]}>
                    <Text style={[styles.relUserRoleText, { color: ROLE_COLORS[u.role] }]}>{ROLE_LABELS[u.role]}</Text>
                  </View>
                </TouchableOpacity>
              ))}
              {availableUsersForRelation.length === 0 && (
                <Text style={styles.relNoResults}>Aucun utilisateur disponible</Text>
              )}
            </ScrollView>

            <TouchableOpacity
              style={styles.modalCancel}
              onPress={() => { setShowRelationModal(false); setRelSearchQuery(''); }}
            >
              <Text style={styles.modalCancelText}>Annuler</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </TalionScreen>
  );

  // ─── Users Tab ─────────────────────────────────────────────────────
  function renderUsersTab() {
    return (
      <View>
        {/* Search + Add button */}
        <View style={styles.searchRow}>
          <TextInput
            style={[styles.searchInput, { flex: 1 }]}
            placeholder="Rechercher par nom, email, rôle, tag..."
            placeholderTextColor="#9ca3af"
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="done"
          />
          <TouchableOpacity style={styles.addBtn} onPress={openCreateForm}>
            <Text style={styles.addBtnText}>+ Ajouter</Text>
          </TouchableOpacity>
        </View>

        {/* User Stats */}
        <View style={styles.miniStatsRow}>
          <View style={[styles.miniStat, { backgroundColor: '#f0fdf4' }]}>
            <Text style={[styles.miniStatNumber, { color: '#22c55e' }]}>{analytics.activeUsers}</Text>
            <Text style={styles.miniStatLabel}>Actifs</Text>
          </View>
          <View style={[styles.miniStat, { backgroundColor: '#fffbeb' }]}>
            <Text style={[styles.miniStatNumber, { color: '#f59e0b' }]}>{analytics.suspendedUsers}</Text>
            <Text style={styles.miniStatLabel}>Suspendus</Text>
          </View>
          <View style={[styles.miniStat, { backgroundColor: '#fef2f2' }]}>
            <Text style={[styles.miniStatNumber, { color: '#ef4444' }]}>{analytics.deactivatedUsers}</Text>
            <Text style={styles.miniStatLabel}>Désactivés</Text>
          </View>
          <View style={[styles.miniStat, { backgroundColor: '#f5f3ff' }]}>
            <Text style={[styles.miniStatNumber, { color: '#7c3aed' }]}>{analytics.totalUsers}</Text>
            <Text style={styles.miniStatLabel}>Total</Text>
          </View>
        </View>

        {/* User List */}
        <Text style={styles.sectionTitle}>Utilisateurs ({filteredUsers.length})</Text>
        {filteredUsers.map(u => (
          <View key={u.id} style={[styles.userCard, { borderLeftColor: ROLE_COLORS[u.role] }]}>
            <View style={styles.userCardHeader}>
              <View style={styles.userCardLeft}>
                {u.photoUrl ? (
                  <Image source={{ uri: u.photoUrl.startsWith('/') ? `${BASE}${u.photoUrl}` : u.photoUrl }} style={styles.avatarPhoto} />
                ) : (
                  <View style={[styles.avatar, { backgroundColor: ROLE_COLORS[u.role] }]}>
                    <Text style={styles.avatarText}>{(u.firstName || u.name || '?').charAt(0)}</Text>
                  </View>
                )}
                <View style={styles.userInfo}>
                  <Text style={styles.userName}>{u.firstName} {u.lastName}</Text>
                  <Text style={styles.userEmail}>{u.email}</Text>
                  <View style={styles.userMeta}>
                    <View style={[styles.roleBadge, { backgroundColor: ROLE_COLORS[u.role] + '20', borderColor: ROLE_COLORS[u.role] }]}>
                      <Text style={[styles.roleBadgeText, { color: ROLE_COLORS[u.role] }]}>{ROLE_LABELS[u.role]}</Text>
                    </View>
                    <View style={[styles.statusDot, { backgroundColor: STATUS_COLORS[u.status] || '#6b7280' }]} />
                    <Text style={styles.userMetaText}>{u.status}</Text>
                    {u.hasPassword && <Text style={styles.passwordIndicator}>🔒</Text>}
                  </View>
                  {u.tags && u.tags.length > 0 && (
                    <View style={styles.tagRow}>
                      {u.tags.map(t => (
                        <View key={t} style={styles.tagBadge}>
                          <Text style={styles.tagText}>{t}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                  {u.phoneMobile && <Text style={styles.userPhone}>📱 {u.phoneMobile}</Text>}
                  {u.address && <Text style={styles.userAddress} numberOfLines={1}>📍 {u.address}</Text>}
                </View>
              </View>
              <Text style={styles.userLastSeen}>{formatTimeAgo(u.lastLogin)}</Text>
            </View>

            {/* Action Buttons */}
            {u.id !== user?.id && (
              <View style={styles.userActions}>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#3b82f615' }]}
                  onPress={() => openEditForm(u)}
                >
                  <Text style={[styles.actionBtnText, { color: '#3b82f6' }]}>✏️ Modifier</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#7c3aed15' }]}
                  onPress={() => { setSelectedUser(u); setShowRoleModal(true); }}
                >
                  <Text style={[styles.actionBtnText, { color: '#7c3aed' }]}>Rôle</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: u.status === 'active' ? '#f59e0b15' : '#22c55e15' }]}
                  onPress={() => handleToggleStatus(u)}
                >
                  <Text style={[styles.actionBtnText, { color: u.status === 'active' ? '#f59e0b' : '#22c55e' }]}>
                    {u.status === 'active' ? 'Suspendre' : 'Réactiver'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { backgroundColor: '#ef444415' }]}
                  onPress={() => handleDeleteUser(u)}
                >
                  <Text style={[styles.actionBtnText, { color: '#ef4444' }]}>Supprimer</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ))}
      </View>
    );
  }

  // ─── Incidents Tab ─────────────────────────────────────────────────
  function renderIncidentsTab() {
    return (
      <View>
        <View style={styles.filterRow}>
          {(['all', 'active', 'resolved'] as const).map(f => (
            <TouchableOpacity
              key={f}
              style={[styles.filterChip, incidentFilter === f && styles.filterChipActive]}
              onPress={() => setIncidentFilter(f)}
            >
              <Text style={[styles.filterChipText, incidentFilter === f && styles.filterChipTextActive]}>
                {f === 'all' ? 'Tous' : f === 'active' ? 'Actifs' : 'Résolus'}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.miniStatsRow}>
          <View style={[styles.miniStat, { backgroundColor: '#fef2f2' }]}>
            <Text style={[styles.miniStatNumber, { color: '#ef4444' }]}>{analytics.activeIncidents}</Text>
            <Text style={styles.miniStatLabel}>Actifs</Text>
          </View>
          <View style={[styles.miniStat, { backgroundColor: '#f0fdf4' }]}>
            <Text style={[styles.miniStatNumber, { color: '#22c55e' }]}>{analytics.resolvedIncidents}</Text>
            <Text style={styles.miniStatLabel}>Résolus</Text>
          </View>
          <View style={[styles.miniStat, { backgroundColor: '#fef2f2' }]}>
            <Text style={[styles.miniStatNumber, { color: '#ef4444' }]}>{analytics.criticalIncidents}</Text>
            <Text style={styles.miniStatLabel}>Critiques</Text>
          </View>
          <View style={[styles.miniStat, { backgroundColor: '#eff6ff' }]}>
            <Text style={[styles.miniStatNumber, { color: '#3b82f6' }]}>{analytics.totalIncidents}</Text>
            <Text style={styles.miniStatLabel}>Total</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Incidents ({filteredIncidents.length})</Text>
        {filteredIncidents.map(inc => (
          <View key={inc.id} style={[styles.incidentCard, { borderLeftColor: SEVERITY_COLORS[inc.severity] }]}>
            <View style={styles.incidentHeader}>
              <View style={styles.incidentHeaderLeft}>
                <Text style={styles.incidentIcon}>{TYPE_ICONS[inc.type] || '🚨'}</Text>
                <View>
                  <Text style={styles.incidentId}>{formatIncidentId(inc.id)}</Text>
                  <Text style={styles.incidentType}>{formatIncidentType(inc.type)}</Text>
                </View>
              </View>
              <View style={styles.incidentBadges}>
                <View style={[styles.severityBadge, { backgroundColor: SEVERITY_COLORS[inc.severity] }]}>
                  <Text style={styles.severityBadgeText}>{formatSeverityFr(inc.severity)}</Text>
                </View>
                <View style={[styles.statusBadge, { backgroundColor: STATUS_COLORS[inc.status] || '#6b7280' }]}>
                  <Text style={styles.statusBadgeText}>{formatStatusFr(inc.status)}</Text>
                </View>
              </View>
            </View>
            <View style={styles.incidentDetails}>
              <Text style={styles.incidentDetailText}>📍 {inc.address}</Text>
              <Text style={styles.incidentDetailText}>👤 {inc.reportedBy}</Text>
              <Text style={styles.incidentDetailText}>🕒 {formatDate(inc.timestamp)}</Text>
              {inc.assignedCount > 0 && (
                <Text style={styles.incidentDetailText}>🚑 {inc.assignedCount} intervenant(s)</Text>
              )}
            </View>
          </View>
        ))}
      </View>
    );
  }

  // ─── Analytics Tab ─────────────────────────────────────────────────
  function renderAnalyticsTab() {
    return (
      <View>
        <View style={styles.analyticsGrid}>
          <View style={[styles.analyticsCard, { borderTopColor: '#7c3aed' }]}>
            <Text style={styles.analyticsCardIcon}>👥</Text>
            <Text style={[styles.analyticsCardNumber, { color: '#7c3aed' }]}>{analytics.totalUsers}</Text>
            <Text style={styles.analyticsCardLabel}>Utilisateurs</Text>
          </View>
          <View style={[styles.analyticsCard, { borderTopColor: '#ef4444' }]}>
            <Text style={styles.analyticsCardIcon}>🚨</Text>
            <Text style={[styles.analyticsCardNumber, { color: '#ef4444' }]}>{analytics.activeIncidents}</Text>
            <Text style={styles.analyticsCardLabel}>Incidents actifs</Text>
          </View>
          <View style={[styles.analyticsCard, { borderTopColor: '#22c55e' }]}>
            <Text style={styles.analyticsCardIcon}>✅</Text>
            <Text style={[styles.analyticsCardNumber, { color: '#22c55e' }]}>{analytics.resolvedIncidents}</Text>
            <Text style={styles.analyticsCardLabel}>Résolus</Text>
          </View>
          <View style={[styles.analyticsCard, { borderTopColor: '#3b82f6' }]}>
            <Text style={styles.analyticsCardIcon}>⏱️</Text>
            <Text style={[styles.analyticsCardNumber, { color: '#3b82f6' }]}>{Math.round(analytics.avgResponseTime)}</Text>
            <Text style={styles.analyticsCardLabel}>Temps rép. moy. (min)</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Répartition par rôle</Text>
        <View style={styles.barChartContainer}>
          {Object.entries(analytics.byRole).map(([role, count]) => (
            <View key={role} style={styles.barRow}>
              <Text style={styles.barLabel}>{ROLE_LABELS[role as UserRole]}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, {
                  width: `${analytics.totalUsers > 0 ? (count / analytics.totalUsers) * 100 : 0}%`,
                  backgroundColor: ROLE_COLORS[role as UserRole],
                }]} />
              </View>
              <Text style={styles.barValue}>{count}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Répartition par sévérité</Text>
        <View style={styles.barChartContainer}>
          {Object.entries(analytics.bySeverity).map(([sev, count]) => (
            <View key={sev} style={styles.barRow}>
              <Text style={styles.barLabel}>{sev.charAt(0).toUpperCase() + sev.slice(1)}</Text>
              <View style={styles.barTrack}>
                <View style={[styles.barFill, {
                  width: `${analytics.totalIncidents > 0 ? (count / analytics.totalIncidents) * 100 : 0}%`,
                  backgroundColor: SEVERITY_COLORS[sev],
                }]} />
              </View>
              <Text style={styles.barValue}>{count}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Santé système</Text>
        <View style={styles.healthGrid}>
          <View style={styles.healthCard}>
            <View style={[styles.healthDot, { backgroundColor: '#22c55e' }]} />
            <Text style={styles.healthLabel}>Serveur API</Text>
            <Text style={[styles.healthStatus, { color: '#22c55e' }]}>En ligne</Text>
          </View>
          <View style={styles.healthCard}>
            <View style={[styles.healthDot, { backgroundColor: '#22c55e' }]} />
            <Text style={styles.healthLabel}>WebSocket</Text>
            <Text style={[styles.healthStatus, { color: '#22c55e' }]}>Connecté</Text>
          </View>
          <View style={styles.healthCard}>
            <View style={[styles.healthDot, { backgroundColor: '#22c55e' }]} />
            <Text style={styles.healthLabel}>Localisation</Text>
            <Text style={[styles.healthStatus, { color: '#22c55e' }]}>Actif</Text>
          </View>
          <View style={styles.healthCard}>
            <View style={[styles.healthDot, { backgroundColor: analytics.activeIncidents > 0 ? '#f59e0b' : '#22c55e' }]} />
            <Text style={styles.healthLabel}>Incidents actifs</Text>
            <Text style={[styles.healthStatus, { color: analytics.activeIncidents > 0 ? '#f59e0b' : '#22c55e' }]}>
              {analytics.activeIncidents > 0 ? `${analytics.activeIncidents} Actif(s)` : 'Aucun'}
            </Text>
          </View>
        </View>
      </View>
    );
  }

  // ─── Audit Log Tab ─────────────────────────────────────────────────
  function renderAuditTab() {
    const categories = ['all', 'auth', 'user', 'incident', 'system', 'broadcast'];
    return (
      <View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll}>
          <View style={styles.filterRow}>
            {categories.map(cat => (
              <TouchableOpacity
                key={cat}
                style={[styles.filterChip, auditFilter === cat && styles.filterChipActive]}
                onPress={() => setAuditFilter(cat)}
              >
                <Text style={[styles.filterChipText, auditFilter === cat && styles.filterChipTextActive]}>
                  {cat === 'all' ? 'Tous' : (AUDIT_ICONS[cat] || '') + ' ' + cat.charAt(0).toUpperCase() + cat.slice(1)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.sectionTitle}>Journal d'audit ({filteredAudit.length})</Text>
        {filteredAudit.map(entry => (
          <View key={entry.id} style={styles.auditCard}>
            <View style={styles.auditHeader}>
              <Text style={styles.auditIcon}>{AUDIT_ICONS[entry.category] || '📋'}</Text>
              <View style={styles.auditInfo}>
                <Text style={styles.auditAction}>{entry.action}</Text>
                <Text style={styles.auditPerformer}>par {entry.performedBy}</Text>
              </View>
              <Text style={styles.auditTime}>{formatTimeAgo(entry.timestamp)}</Text>
            </View>
            <Text style={styles.auditDetails}>{entry.details}</Text>
            {entry.targetUser && (
              <Text style={styles.auditTarget}>Cible : {entry.targetUser}</Text>
            )}
            <View style={[styles.auditCategoryBadge, { backgroundColor: getCategoryColor(entry.category) + '20' }]}>
              <Text style={[styles.auditCategoryText, { color: getCategoryColor(entry.category) }]}>
                {entry.category.toUpperCase()}
              </Text>
            </View>
          </View>
        ))}
      </View>
    );
  }
}

function getCategoryColor(category: string): string {
  switch (category) {
    case 'auth': return '#7c3aed';
    case 'user': return '#059669';
    case 'incident': return '#ef4444';
    case 'system': return '#6b7280';
    case 'broadcast': return '#f59e0b';
    default: return '#6b7280';
  }
}


const styles = StyleSheet.create({
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  loadingText: { fontSize: 14, color: '#6b7280' },
  scrollView: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },

  // Tab Bar
  tabBar: { flexDirection: 'row', backgroundColor: '#ffffff', borderBottomWidth: 1, borderBottomColor: '#e5e7eb', paddingHorizontal: 4 },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: '#7c3aed' },
  tabIcon: { fontSize: 18, marginBottom: 2 },
  tabLabel: { fontSize: 11, color: '#6b7280', fontWeight: '500' },
  tabLabelActive: { color: '#7c3aed', fontWeight: '700' },

  // Search
  searchRow: { flexDirection: 'row', gap: 8, marginBottom: 12, alignItems: 'center' },
  searchInput: { backgroundColor: '#f3f4f6', borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10, fontSize: 14, color: '#1f2937', borderWidth: 1, borderColor: '#e5e7eb' },
  addBtn: { backgroundColor: '#7c3aed', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 10 },
  addBtnText: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Mini Stats
  miniStatsRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  miniStat: { flex: 1, borderRadius: 10, padding: 10, alignItems: 'center' },
  miniStatNumber: { fontSize: 20, fontWeight: '800' },
  miniStatLabel: { fontSize: 10, color: '#6b7280', fontWeight: '600', marginTop: 2 },

  // Section
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#1f2937', marginBottom: 10, marginTop: 4 },

  // User Card
  userCard: { backgroundColor: '#ffffff', borderRadius: 12, padding: 14, marginBottom: 10, borderLeftWidth: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 1 },
  userCardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  userCardLeft: { flexDirection: 'row', alignItems: 'flex-start', flex: 1, gap: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  avatarText: { color: '#ffffff', fontSize: 16, fontWeight: '700' },
  userInfo: { flex: 1 },
  userName: { fontSize: 15, fontWeight: '700', color: '#1f2937' },
  userEmail: { fontSize: 12, color: '#6b7280', marginTop: 1 },
  userMeta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  roleBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6, borderWidth: 1 },
  roleBadgeText: { fontSize: 10, fontWeight: '700' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  userMetaText: { fontSize: 11, color: '#6b7280' },
  passwordIndicator: { fontSize: 12 },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  tagBadge: { backgroundColor: '#eff6ff', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  tagText: { fontSize: 10, color: '#3b82f6', fontWeight: '600' },
  userPhone: { fontSize: 11, color: '#4b5563', marginTop: 3 },
  userAddress: { fontSize: 11, color: '#4b5563', marginTop: 1 },
  userLastSeen: { fontSize: 11, color: '#9ca3af' },
  userActions: { flexDirection: 'row', gap: 8, marginTop: 10, flexWrap: 'wrap' },
  actionBtn: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  actionBtnText: { fontSize: 12, fontWeight: '700' },

  // Filter
  filterRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  filterScroll: { marginBottom: 4 },
  filterChip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 20, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb' },
  filterChipActive: { backgroundColor: '#7c3aed', borderColor: '#7c3aed' },
  filterChipText: { fontSize: 12, fontWeight: '600', color: '#6b7280' },
  filterChipTextActive: { color: '#ffffff' },

  // Incident Card
  incidentCard: { backgroundColor: '#ffffff', borderRadius: 12, padding: 14, marginBottom: 10, borderLeftWidth: 4, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 1 },
  incidentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  incidentHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  incidentIcon: { fontSize: 24 },
  incidentId: { fontSize: 14, fontWeight: '800', color: '#1f2937' },
  incidentType: { fontSize: 12, color: '#6b7280' },
  incidentBadges: { flexDirection: 'row', gap: 4 },
  severityBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  severityBadgeText: { fontSize: 9, fontWeight: '800', color: '#ffffff' },
  statusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  statusBadgeText: { fontSize: 9, fontWeight: '800', color: '#ffffff' },
  incidentDetails: { gap: 3 },
  incidentDetailText: { fontSize: 12, color: '#4b5563' },

  // Analytics
  analyticsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 20 },
  analyticsCard: { width: '47%' as any, backgroundColor: '#ffffff', borderRadius: 12, padding: 16, alignItems: 'center', borderTopWidth: 3, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 1 },
  analyticsCardIcon: { fontSize: 28, marginBottom: 4 },
  analyticsCardNumber: { fontSize: 28, fontWeight: '900' },
  analyticsCardLabel: { fontSize: 11, color: '#6b7280', fontWeight: '600', marginTop: 2, textAlign: 'center' },

  // Bar Chart
  barChartContainer: { backgroundColor: '#ffffff', borderRadius: 12, padding: 14, marginBottom: 16, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 1 },
  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 },
  barLabel: { width: 80, fontSize: 12, fontWeight: '600', color: '#4b5563' },
  barTrack: { flex: 1, height: 20, backgroundColor: '#f3f4f6', borderRadius: 10, overflow: 'hidden' },
  barFill: { height: '100%' as any, borderRadius: 10, minWidth: 4 },
  barValue: { width: 24, fontSize: 13, fontWeight: '800', color: '#1f2937', textAlign: 'right' },

  // Health Grid
  healthGrid: { gap: 8, marginBottom: 16 },
  healthCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 10, padding: 12, gap: 10, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 1 },
  healthDot: { width: 10, height: 10, borderRadius: 5 },
  healthLabel: { flex: 1, fontSize: 13, fontWeight: '600', color: '#4b5563' },
  healthStatus: { fontSize: 12, fontWeight: '700' },

  // Audit Card
  auditCard: { backgroundColor: '#ffffff', borderRadius: 12, padding: 14, marginBottom: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.05, shadowRadius: 3, elevation: 1 },
  auditHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  auditIcon: { fontSize: 20 },
  auditInfo: { flex: 1 },
  auditAction: { fontSize: 14, fontWeight: '700', color: '#1f2937' },
  auditPerformer: { fontSize: 11, color: '#6b7280' },
  auditTime: { fontSize: 11, color: '#9ca3af' },
  auditDetails: { fontSize: 12, color: '#4b5563', marginBottom: 4 },
  auditTarget: { fontSize: 11, color: '#7c3aed', fontWeight: '600', marginBottom: 4 },
  auditCategoryBadge: { alignSelf: 'flex-start', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 },
  auditCategoryText: { fontSize: 9, fontWeight: '800' },

  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#ffffff', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 24, paddingBottom: 40 },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#1f2937', marginBottom: 4 },
  modalSubtitle: { fontSize: 14, color: '#6b7280', marginBottom: 20 },
  roleGrid: { gap: 10 },
  roleOption: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 12, borderWidth: 2, backgroundColor: '#fafafa' },
  roleOptionDisabled: { opacity: 0.4 },
  roleColorDot: { width: 14, height: 14, borderRadius: 7 },
  roleOptionText: { fontSize: 16, fontWeight: '700', color: '#1f2937' },
  modalCancel: { marginTop: 16, alignItems: 'center', padding: 14 },
  modalCancelText: { fontSize: 16, fontWeight: '600', color: '#6b7280' },

  // Photo
  photoSection: { marginBottom: 4 },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 4 },
  photoPreviewContainer: { position: 'relative' },
  photoPreview: { width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: '#e5e7eb' },
  photoRemoveBtn: { position: 'absolute', top: -4, right: -4, backgroundColor: '#ef4444', width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center' },
  photoRemoveText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  photoPlaceholder: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#f3f4f6', borderWidth: 2, borderColor: '#e5e7eb', borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center' },
  photoPlaceholderText: { fontSize: 28 },
  photoActions: { gap: 8 },
  photoBtn: { backgroundColor: '#f3f4f6', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: '#e5e7eb' },
  photoBtnText: { fontSize: 13, fontWeight: '600', color: '#4b5563' },
  avatarPhoto: { width: 40, height: 40, borderRadius: 20 },

  // Relations
  relList: { gap: 6, marginBottom: 8 },
  relItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#f9fafb', borderRadius: 10, padding: 10, borderWidth: 1, borderColor: '#e5e7eb' },
  relInfo: { flex: 1 },
  relName: { fontSize: 14, fontWeight: '600', color: '#1f2937' },
  relType: { fontSize: 11, color: '#7c3aed', fontWeight: '600' },
  relRemoveBtn: { width: 28, height: 28, borderRadius: 14, backgroundColor: '#fef2f2', justifyContent: 'center', alignItems: 'center' },
  relRemoveText: { color: '#ef4444', fontSize: 14, fontWeight: '700' },
  addRelBtn: { backgroundColor: '#f5f3ff', paddingVertical: 10, borderRadius: 10, alignItems: 'center', borderWidth: 1, borderColor: '#7c3aed30', marginBottom: 4 },
  addRelBtnText: { color: '#7c3aed', fontSize: 14, fontWeight: '700' },
  relTypeScroll: { marginBottom: 8 },
  relTypeChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: '#f3f4f6', borderWidth: 1, borderColor: '#e5e7eb', marginRight: 8 },
  relTypeChipActive: { backgroundColor: '#7c3aed', borderColor: '#7c3aed' },
  relTypeChipText: { fontSize: 13, fontWeight: '600', color: '#6b7280' },
  relTypeChipTextActive: { color: '#ffffff' },
  relUserList: { maxHeight: 250, marginTop: 8 },
  relUserItem: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#f3f4f6' },
  relUserAvatar: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  relUserAvatarText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  relUserInfo: { flex: 1 },
  relUserName: { fontSize: 14, fontWeight: '600', color: '#1f2937' },
  relUserEmail: { fontSize: 11, color: '#6b7280' },
  relUserRoleBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  relUserRoleText: { fontSize: 10, fontWeight: '700' },
  relNoResults: { textAlign: 'center', color: '#9ca3af', fontSize: 14, paddingVertical: 20 },

  // Form
  formRow: { flexDirection: 'row', gap: 10 },
  formHalf: { flex: 1 },
  formLabel: { fontSize: 13, fontWeight: '600', color: '#374151', marginTop: 12, marginBottom: 4 },
  formInput: { backgroundColor: '#f9fafb', borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, paddingHorizontal: 12, paddingVertical: Platform.OS === 'ios' ? 12 : 8, fontSize: 14, color: '#1f2937' },
  roleSelector: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  roleSelectorBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1.5, borderColor: '#e5e7eb', backgroundColor: '#f9fafb' },
  roleSelectorText: { fontSize: 13, fontWeight: '600', color: '#6b7280' },
  formActions: { marginTop: 20, gap: 10 },
  formBtn: { paddingVertical: 14, borderRadius: 12, alignItems: 'center' },
  formBtnPrimary: { backgroundColor: '#7c3aed' },
  formBtnPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  formBtnCancel: { backgroundColor: '#f3f4f6' },
  formBtnCancelText: { color: '#6b7280', fontSize: 16, fontWeight: '600' },
});
