import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, ScrollView, Pressable, Modal, TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TalionScreen } from '@/components/talion-banner';
import { useAuth } from '@/hooks/useAuth';
import { isDispatchRole, isStaffRole } from '@/lib/auth-context';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader } from '@/lib/auth-fetch';
import { isLiveKitAvailable, getLiveKitLoadError } from '@/lib/livekit-ptt';
import { useLiveKitPTT } from '@/lib/livekit-ptt-provider';

interface PTTChannel {
  id: string;
  name: string;
  description: string;
  allowedRoles: string[];
  isDefault: boolean;
  members?: string[];
}

export default function PTTScreen() {
  const { user } = useAuth();
  const isStaff = isStaffRole(user?.role);
  const isDispatchStaff = isDispatchRole(user?.role);

  const {
    connected, connecting, activeChannelId, activeChannelName, activeSpeakers, transmitting,
    connect, disconnect, startTransmit: startTransmitCtx, stopTransmit: stopTransmitCtx,
  } = useLiveKitPTT();

  const [channels, setChannels] = useState<PTTChannel[]>([]);
  const [channelsLoading, setChannelsLoading] = useState(true);

  // Group creation (dispatcher/admin only)
  const [showGroupModal, setShowGroupModal] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  const [groupSaving, setGroupSaving] = useState(false);

  // The connection itself lives in LiveKitPTTProvider (mounted at the app
  // root) so it survives navigating away from this tab - this screen just
  // looks up the full channel object (for name/description/icon) from the
  // id the provider is currently connected to.
  const activeChannel = channels.find(ch => ch.id === activeChannelId) || (activeChannelId ? { id: activeChannelId, name: activeChannelName || activeChannelId, description: '', allowedRoles: [], isDefault: false } as PTTChannel : null);

  const loadChannels = useCallback(async () => {
    setChannelsLoading(true);
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetchWithTimeout(`${baseUrl}/api/ptt/channels`, { timeout: 10000, headers: await authHeader() });
      if (res.ok) setChannels(await res.json());
    } catch (e) {
      console.warn('[PTT] Failed to load channels:', e);
    }
    setChannelsLoading(false);
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const joinChannel = useCallback(async (channel: PTTChannel) => {
    if (!isLiveKitAvailable()) {
      Alert.alert('Indisponible', 'Le PTT en direct n\'est pas disponible sur cette version de l\'app.');
      return;
    }
    try {
      await connect(channel.id, channel.name);
    } catch (e) {
      // onError already surfaces an alert
    }
  }, [connect]);

  const leaveChannel = useCallback(async () => {
    await disconnect();
  }, [disconnect]);

  const startTransmit = useCallback(async () => {
    // No beep here: expo-audio playback during an active LiveKit session is a
    // confirmed unresolved upstream conflict on iOS (livekit/client-sdk-react-native#286)
    // - it silently breaks the mic for the rest of the session. Not worth the
    // walkie-talkie chirp losing core PTT audio.
    await startTransmitCtx();
  }, [startTransmitCtx]);

  const stopTransmit = useCallback(async () => {
    await stopTransmitCtx();
  }, [stopTransmitCtx]);

  const triggerEmergency = useCallback(() => {
    Alert.alert('Confirmer', 'Déclencher l\'alerte d\'urgence PTT pour tout le monde ?', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Déclencher', style: 'destructive', onPress: async () => {
          try {
            const baseUrl = getApiBaseUrl();
            const res = await fetchWithTimeout(`${baseUrl}/api/ptt/emergency`, {
              method: 'POST', headers: await authHeader(), timeout: 10000,
            });
            if (!res.ok) throw new Error('failed');
          } catch (e) {
            Alert.alert('Erreur', 'Impossible de déclencher l\'alerte');
          }
        },
      },
    ]);
  }, []);

  const openGroupModal = useCallback(async () => {
    setGroupName('');
    setSelectedMemberIds([]);
    setShowGroupModal(true);
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetchWithTimeout(`${baseUrl}/api/users`, { timeout: 10000 });
      if (res.ok) setAllUsers((await res.json()).filter((u: any) => u.id !== user?.id));
    } catch (e) {
      setAllUsers([]);
    }
  }, [user?.id]);

  const toggleMember = (id: string) => {
    setSelectedMemberIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const saveGroup = useCallback(async () => {
    if (!groupName.trim()) { Alert.alert('Erreur', 'Nom du groupe requis'); return; }
    setGroupSaving(true);
    try {
      const baseUrl = getApiBaseUrl();
      const res = await fetchWithTimeout(`${baseUrl}/api/ptt/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
        body: JSON.stringify({ name: groupName.trim(), members: selectedMemberIds }),
        timeout: 10000,
      });
      if (!res.ok) throw new Error('failed');
      setShowGroupModal(false);
      loadChannels();
    } catch (e) {
      Alert.alert('Erreur', 'Impossible de créer le groupe');
    }
    setGroupSaving(false);
  }, [groupName, selectedMemberIds, loadChannels]);

  const CHANNEL_ICONS: Record<string, string> = { emergency: '🚨', dispatch: '📡', responders: '🚒', general: '💬' };
  const channelIcon = (ch: PTTChannel) => {
    if (CHANNEL_ICONS[ch.id]) return CHANNEL_ICONS[ch.id];
    if (ch.id.startsWith('family-')) return '🏠';
    if (ch.id.startsWith('direct-')) return '📞';
    if (ch.id.startsWith('custom-')) return '👥';
    return '📻';
  };

  // ─── Active channel view (connected, floor control) ───────────────────
  if (activeChannel) {
    return (
      <TalionScreen>
        <SafeAreaView style={styles.container} edges={['bottom']}>
          <View style={styles.channelBanner}>
            <Text style={styles.channelLabel}>Canal actif</Text>
            <Text style={styles.channelName}>{channelIcon(activeChannel)} {activeChannel.name}</Text>
            <TouchableOpacity onPress={leaveChannel} style={styles.backBtn}>
              <Text style={styles.backBtnText}>← Quitter le canal</Text>
            </TouchableOpacity>
          </View>

          {!connected ? (
            <View style={styles.centered}>
              <ActivityIndicator size="large" color="#1e3a5f" />
              <Text style={{ marginTop: 12, color: '#6b7280' }}>Connexion...</Text>
            </View>
          ) : (
            <>
              {activeSpeakers.length > 0 && (
                <View style={styles.speakerBanner}>
                  <Text style={styles.speakerText}>
                    🎙 {activeSpeakers.map(s => s.name).join(', ')} {activeSpeakers.length > 1 ? 'parlent' : 'parle'}...
                  </Text>
                </View>
              )}

              <View style={styles.pttContainer}>
                <Pressable
                  style={[styles.pttButton, transmitting && styles.pttButtonActive]}
                  onPressIn={startTransmit}
                  onPressOut={stopTransmit}
                >
                  <Text style={styles.pttIcon}>{transmitting ? '🔴' : '🎙'}</Text>
                  <Text style={styles.pttLabel}>{transmitting ? 'EN COURS...' : 'MAINTENIR POUR PARLER'}</Text>
                </Pressable>
              </View>
            </>
          )}
        </SafeAreaView>
      </TalionScreen>
    );
  }

  // ─── Channel list view ──────────────────────────────────────────────────
  return (
    <TalionScreen>
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>PTT</Text>
          <TouchableOpacity onPress={loadChannels} style={styles.refreshBtn}>
            <Text style={styles.refreshBtnText}>↻</Text>
          </TouchableOpacity>
        </View>

        {isDispatchStaff && (
          <View style={{ flexDirection: 'row', gap: 8, marginHorizontal: 16, marginBottom: 8 }}>
            <TouchableOpacity style={styles.emergencyBtn} onPress={triggerEmergency}>
              <Text style={styles.emergencyBtnText}>🚨 Urgence</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.groupBtn} onPress={openGroupModal}>
              <Text style={styles.groupBtnText}>+ Nouveau groupe</Text>
            </TouchableOpacity>
          </View>
        )}

        {!isLiveKitAvailable() && (
          <View style={styles.warningBanner}>
            <Text style={styles.warningBannerText}>⚠️ PTT en direct non disponible sur cette version de l'app.</Text>
            {getLiveKitLoadError() && (
              <Text style={styles.warningBannerText}>{getLiveKitLoadError()}</Text>
            )}
          </View>
        )}

        {channelsLoading ? (
          <View style={styles.centered}><ActivityIndicator size="large" color="#1e3a5f" /></View>
        ) : channels.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>Aucun canal disponible</Text>
          </View>
        ) : (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingTop: 4 }}>
            {channels.map(ch => (
              <TouchableOpacity
                key={ch.id}
                style={styles.channelRow}
                onPress={() => joinChannel(ch)}
                disabled={connecting}
              >
                <Text style={styles.channelRowIcon}>{channelIcon(ch)}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.channelRowName}>{ch.name}</Text>
                  {!!ch.description && <Text style={styles.channelRowDesc}>{ch.description}</Text>}
                </View>
                {connecting ? <ActivityIndicator size="small" color="#1e3a5f" /> : <Text style={styles.channelRowArrow}>›</Text>}
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Group creation modal (dispatcher/admin) */}
        <Modal visible={showGroupModal} transparent animationType="slide">
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Nouveau groupe PTT</Text>
              <TextInput
                style={styles.groupNameInput}
                placeholder="Nom du groupe"
                placeholderTextColor="#9ca3af"
                value={groupName}
                onChangeText={setGroupName}
              />
              <Text style={styles.modalLabel}>Membres</Text>
              <ScrollView style={{ maxHeight: 280 }}>
                {allUsers.map(u => (
                  <TouchableOpacity key={u.id} style={styles.memberRow} onPress={() => toggleMember(u.id)}>
                    <Text style={{ fontSize: 16 }}>{selectedMemberIds.includes(u.id) ? '☑' : '☐'}</Text>
                    <Text style={styles.memberRowText}>{u.name} <Text style={{ color: '#9ca3af' }}>({u.role})</Text></Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
                <TouchableOpacity style={styles.modalCancelBtn} onPress={() => setShowGroupModal(false)}>
                  <Text style={styles.modalCancelBtnText}>Annuler</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[styles.modalSaveBtn, groupSaving && { opacity: 0.6 }]} onPress={saveGroup} disabled={groupSaving}>
                  {groupSaving ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalSaveBtnText}>Créer</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </SafeAreaView>
    </TalionScreen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#1e3a5f' },
  refreshBtn: { padding: 6 },
  refreshBtnText: { fontSize: 20, color: '#1e3a5f' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyText: { color: '#9ca3af', fontSize: 14 },
  warningBanner: { marginHorizontal: 16, marginBottom: 8, backgroundColor: '#fef3c7', borderRadius: 8, padding: 10 },
  warningBannerText: { color: '#92400e', fontSize: 12, textAlign: 'center' },
  emergencyBtn: { flex: 1, backgroundColor: '#dc2626', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  emergencyBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  groupBtn: { flex: 1, backgroundColor: '#1e3a5f', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  groupBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  channelRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 12,
    padding: 14, marginBottom: 8, gap: 12, borderWidth: 1, borderColor: '#e5e7eb',
  },
  channelRowIcon: { fontSize: 24 },
  channelRowName: { fontSize: 15, fontWeight: '700', color: '#1f2937' },
  channelRowDesc: { fontSize: 12, color: '#6b7280', marginTop: 2 },
  channelRowArrow: { fontSize: 22, color: '#9ca3af' },
  channelBanner: { margin: 16, backgroundColor: '#1e3a5f', borderRadius: 12, padding: 16 },
  channelLabel: { fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 4 },
  channelName: { fontSize: 18, fontWeight: '700', color: '#ffffff' },
  backBtn: { marginTop: 8, alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  backBtnText: { color: '#ffffff', fontSize: 13 },
  speakerBanner: { marginHorizontal: 16, backgroundColor: '#dcfce7', borderRadius: 8, padding: 10, marginBottom: 8 },
  speakerText: { color: '#166534', fontWeight: '600', textAlign: 'center' },
  pttContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  pttButton: { width: 180, height: 180, borderRadius: 90, backgroundColor: '#1e3a5f', justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8 },
  pttButtonActive: { backgroundColor: '#dc2626' },
  pttIcon: { fontSize: 48, marginBottom: 8 },
  pttLabel: { color: '#ffffff', fontSize: 11, fontWeight: '700', textAlign: 'center', letterSpacing: 1 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 20 },
  modalContent: { backgroundColor: '#fff', borderRadius: 16, padding: 20, maxHeight: '80%' },
  modalTitle: { fontSize: 17, fontWeight: '700', color: '#1f2937', marginBottom: 12 },
  modalLabel: { fontSize: 12, fontWeight: '600', color: '#374151', marginBottom: 6, marginTop: 4 },
  groupNameInput: { backgroundColor: '#f3f4f6', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, marginBottom: 8, color: '#1f2937' },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  memberRowText: { fontSize: 14, color: '#1f2937' },
  modalCancelBtn: { flex: 1, backgroundColor: '#f3f4f6', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  modalCancelBtnText: { color: '#374151', fontWeight: '600' },
  modalSaveBtn: { flex: 1, backgroundColor: '#1e3a5f', borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  modalSaveBtnText: { color: '#fff', fontWeight: '700' },
});
