import { useState, useEffect, useCallback } from 'react';
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
} from 'react-native';
import { TextInput } from 'react-native';
import { TalionScreen, TalionBanner } from '@/components/talion-banner';
import { useAuth } from '@/hooks/useAuth';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';

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
}

// Local media item before upload
interface LocalMedia {
  uri: string;
  type: 'photo' | 'video';
  filename: string;
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

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetchWithTimeout(`${getApiBaseUrl()}${path}`, { timeout: 10000 });
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function apiPost<T>(path: string, body: any): Promise<T> {
  const res = await fetchWithTimeout(`${getApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

async function uploadMediaToReport(reportId: string, media: LocalMedia): Promise<PatrolMedia | null> {
  try {
    const formData = new FormData();
    const ext = media.filename.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeType = media.type === 'video'
      ? `video/${ext === 'mov' ? 'quicktime' : ext}`
      : `image/${ext === 'jpg' ? 'jpeg' : ext}`;

    // React Native FormData expects this shape
    formData.append('media', {
      uri: media.uri,
      name: media.filename,
      type: mimeType,
    } as any);

    const res = await fetch(`${getApiBaseUrl()}/api/patrol/reports/${reportId}/media`, {
      method: 'POST',
      body: formData,
      // Don't set Content-Type header; fetch will set it with boundary for multipart
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    return data.media || null;
  } catch (err) {
    console.error('[Patrol] Media upload error:', err);
    return null;
  }
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

type ViewState = 'list' | 'create' | 'detail';

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
  const [autreComment, setAutreComment] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSitePicker, setShowSitePicker] = useState(false);

  // Media attachment state
  const [localMedia, setLocalMedia] = useState<LocalMedia[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [showMediaPreview, setShowMediaPreview] = useState<string | null>(null);

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
      const data = await apiGet<{ sites: string[] }>('/api/patrol/sites');
      setSites(data.sites || []);
    } catch (err) {
      console.error('[Patrol] Failed to fetch sites:', err);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setIsLoading(true);
      await Promise.all([fetchReports(), fetchSites()]);
      setIsLoading(false);
    };
    load();
  }, [fetchReports, fetchSites]);

  // Poll for new reports every 15s
  useEffect(() => {
    const interval = setInterval(fetchReports, 15000);
    return () => clearInterval(interval);
  }, [fetchReports]);

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
    setAutreComment('');
    setNotes('');
    setLocalMedia([]);
  };

  const handleCreate = () => {
    resetForm();
    // Pre-fill task results as 'ok'
    const defaults: Record<string, TaskResult> = {};
    DEFAULT_TASKS.forEach(t => { defaults[t.name] = 'ok'; });
    setTaskResults(defaults);
    setView('create');
  };

  const handleSubmit = async () => {
    if (!selectedSite) return;
    if (!user?.id) return;

    setIsSubmitting(true);
    try {
      const tasks: PatrolTask[] = DEFAULT_TASKS.map(t => ({
        name: t.name,
        label: t.label,
        result: taskResults[t.name] || 'ok',
        ...(t.name === 'autre' && autreComment ? { comment: autreComment } : {}),
      }));

      const data = await apiPost<{ success: boolean; report: PatrolReport }>('/api/patrol/reports', {
        createdBy: user.id,
        location: selectedSite,
        status: selectedStatus,
        tasks,
        notes: notes || undefined,
      });

      // Upload media attachments if any
      if (data.report && localMedia.length > 0) {
        setIsUploading(true);
        for (const media of localMedia) {
          await uploadMediaToReport(data.report.id, media);
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
      console.error('[Patrol] Failed to submit report:', err);
      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
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

  const renderListView = () => (
    <View style={styles.container}>
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
            {user?.role === 'responder' || user?.role === 'dispatcher' || user?.role === 'admin'
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

      {/* FAB: Create new report (responders, dispatchers, admins only) */}
      {(user?.role === 'responder' || user?.role === 'dispatcher' || user?.role === 'admin') && (
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
        <TouchableOpacity onPress={() => setView('list')} style={styles.backButton}>
          <Text style={styles.backButtonText}>← Retour</Text>
        </TouchableOpacity>
        <Text style={styles.formTitle}>Nouveau rapport de ronde</Text>
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

        {/* Site Selection */}
        <View style={styles.formSection}>
          <Text style={styles.formLabel}>Lieu de la ronde</Text>
          <TouchableOpacity
            style={[styles.dropdownButton, !selectedSite && styles.dropdownButtonEmpty]}
            onPress={() => setShowSitePicker(true)}
          >
            <Text style={[styles.dropdownText, !selectedSite && styles.dropdownPlaceholder]}>
              {selectedSite || 'Sélectionner un lieu...'}
            </Text>
            <Text style={styles.dropdownArrow}>▼</Text>
          </TouchableOpacity>
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
              {/* Comment field for 'autre' task */}
              {task.name === 'autre' && (
                <TextInput
                  style={styles.autreInput}
                  placeholder="Précisez..."
                  placeholderTextColor="#9ca3af"
                  value={autreComment}
                  onChangeText={setAutreComment}
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
          onPress={handleSubmit}
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
            <Text style={styles.submitButtonText}>Soumettre le rapport</Text>
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

          {/* Tasks */}
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

  // ─── Access Control ───────────────────────────────────────────────────

  const canAccess = user?.role === 'responder' || user?.role === 'dispatcher' || user?.role === 'admin';

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
    </TalionScreen>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
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
  fabText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '700',
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
