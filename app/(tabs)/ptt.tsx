import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  Modal,
  Alert,
  Platform,
  StyleSheet,
  ScrollView,
} from 'react-native';
import { TalionScreen } from '@/components/talion-banner';
import { useAuth } from '@/hooks/useAuth';
import { usePTT } from '@/lib/ptt-context';
import {
  type PTTChannel,
  type PTTMessage,
  canTransmitOnChannel,
  createDirectChannel,
  formatDuration,
  formatTimestamp,
  getRoleColor,
  getChannelColor,
} from '@/services/ptt-service';
import { getApiBaseUrl } from '@/lib/server-url';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';

// ─── Role badge labels ────────────────────────────────────────────────────
const ROLE_LABELS: Record<string, string> = {
  admin: 'ADMIN',
  dispatcher: 'DISPATCH',
  responder: 'INTERVENANT',
  user: 'UTILISATEUR',
};

// ─── Available roles for group creation ───────────────────────────────────
const ROLE_OPTIONS = [
  { id: 'user', label: 'Utilisateurs' },
  { id: 'responder', label: 'Intervenants' },
  { id: 'dispatcher', label: 'Dispatchers' },
  { id: 'admin', label: 'Admins' },
];

export default function PTTScreen() {
  const { user } = useAuth();
  const {
    state,
    selectChannel,
    startRecording,
    stopRecording,
    playMessage,
    stopPlayback,
    getChannelMessages,
    canTransmit,
    createGroup,
    deleteGroup,
    refreshChannels,
    triggerEmergency,
    stopEmergency,
    dismissEmergency,
  } = usePTT();

  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupDesc, setGroupDesc] = useState('');
  const [groupRoles, setGroupRoles] = useState<string[]>(['responder', 'dispatcher', 'admin']);
  const [isCreating, setIsCreating] = useState(false);
  const [showDirectCall, setShowDirectCall] = useState(false);
  const [directCallUsers, setDirectCallUsers] = useState<any[]>([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(false);

  const userRole = user?.role || 'user';
  const userId = user?.id || '';
  const userName = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.name : 'Inconnu';
  const canCreateGroup = userRole === 'dispatcher' || userRole === 'admin';
  const canDirectCall = true; // All users can initiate a direct call with dispatch
  const canEmergency = userRole === 'dispatcher' || userRole === 'admin';
  const [isEmergencyRecording, setIsEmergencyRecording] = useState(false);

  // Talking users on current channel
  const talkingOnChannel = useMemo(() => {
    if (!state.currentChannel) return [];
    return state.talkingUsers.filter(t => t.channelId === state.currentChannel!.id && t.userId !== userId);
  }, [state.talkingUsers, state.currentChannel, userId]);

  // Filter channels the user can see
  const visibleChannels = useMemo(() => {
    return state.channels.filter(ch => {
      if (userRole === 'admin') return true;
      return ch.allowedRoles.includes(userRole as any);
    });
  }, [state.channels, userRole]);

  // Messages for current channel
  const currentMessages = useMemo(() => {
    if (!state.currentChannel) return [];
    return getChannelMessages(state.currentChannel.id);
  }, [state.currentChannel, getChannelMessages]);

  // ─── Handlers ─────────────────────────────────────────────────────────
  const handlePTTPress = useCallback(async () => {
    if (state.isRecording) {
      await stopRecording();
    } else {
      await startRecording(userId, userName, userRole);
    }
  }, [state.isRecording, userId, userName, userRole, startRecording, stopRecording]);

  const handleEmergencyPress = useCallback(async () => {
    if (isEmergencyRecording) {
      setIsEmergencyRecording(false);
      await stopEmergency();
    } else {
      setIsEmergencyRecording(true);
      await triggerEmergency(userId, userName, userRole);
    }
  }, [isEmergencyRecording, userId, userName, userRole, triggerEmergency, stopEmergency]);

  const handleDismissEmergency = useCallback(() => {
    dismissEmergency();
  }, [dismissEmergency]);

  const handlePlayMessage = useCallback(async (msg: PTTMessage) => {
    if (state.currentPlayingMessageId === msg.id) {
      stopPlayback();
    } else {
      await playMessage(msg);
    }
  }, [state.currentPlayingMessageId, playMessage, stopPlayback]);

  const handleCreateGroup = useCallback(async () => {
    if (!groupName.trim()) {
      Alert.alert('Erreur', 'Veuillez entrer un nom de groupe');
      return;
    }
    setIsCreating(true);
    const channel = await createGroup(groupName.trim(), groupDesc.trim() || `Groupe ${groupName.trim()}`, groupRoles);
    setIsCreating(false);
    if (channel) {
      setShowCreateGroup(false);
      setGroupName('');
      setGroupDesc('');
      setGroupRoles(['responder', 'dispatcher', 'admin']);
      await refreshChannels();
    } else {
      Alert.alert('Erreur', 'Impossible de créer le groupe');
    }
  }, [groupName, groupDesc, groupRoles, createGroup, refreshChannels]);

  const handleDeleteGroup = useCallback(async (channelId: string, channelName: string) => {
    Alert.alert(
      'Supprimer le groupe',
      `Voulez-vous supprimer le groupe "${channelName}" ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Supprimer',
          style: 'destructive',
          onPress: async () => {
            await deleteGroup(channelId);
            await refreshChannels();
          },
        },
      ]
    );
  }, [deleteGroup, refreshChannels]);

  const toggleRole = useCallback((roleId: string) => {
    setGroupRoles(prev =>
      prev.includes(roleId) ? prev.filter(r => r !== roleId) : [...prev, roleId]
    );
  }, []);

  const handleShowDirectCall = useCallback(async () => {
    setShowDirectCall(true);
    setIsLoadingUsers(true);
    try {
      const base = getApiBaseUrl();
      const res = await fetch(`${base}/admin/users`);
      if (!res.ok) throw new Error('Failed');
      const allUsers = await res.json();
      // For regular users: only show dispatch-console as target
      // For dispatchers/admins: show all users
      if (userRole === 'dispatcher' || userRole === 'admin') {
        setDirectCallUsers(allUsers.filter((u: any) => u.id !== userId && u.status !== 'deactivated'));
      } else {
        // Regular users can call dispatch
        setDirectCallUsers([{ id: 'dispatch-console', name: 'Dispatch', role: 'dispatcher' }]);
      }
    } catch (e) {
      console.error('[PTT] Failed to load users for direct call:', e);
      // Fallback: always allow calling dispatch
      setDirectCallUsers([{ id: 'dispatch-console', name: 'Dispatch', role: 'dispatcher' }]);
    }
    setIsLoadingUsers(false);
  }, [userId, userRole]);

  const handleDirectCall = useCallback(async (targetId: string, targetName: string) => {
    setShowDirectCall(false);
    const channel = await createDirectChannel({
      userId1: userId,
      userId2: targetId,
      userName1: userName,
      userName2: targetName,
    });
    if (channel) {
      await refreshChannels();
      selectChannel(channel);
    } else {
      Alert.alert('Erreur', 'Impossible de cr\u00e9er le canal direct');
    }
  }, [userId, userName, refreshChannels, selectChannel]);

  // ─── Render helpers ───────────────────────────────────────────────────
  const renderChannelItem = useCallback(({ item }: { item: PTTChannel }) => {
    const isSelected = state.currentChannel?.id === item.id;
    const color = getChannelColor(item.id);
    const channelMsgCount = getChannelMessages(item.id).filter(m => !m.played && m.senderId !== userId).length;
    const isCustom = !item.isDefault;

    return (
      <Pressable
        onPress={() => selectChannel(item)}
        onLongPress={isCustom && canCreateGroup ? () => handleDeleteGroup(item.id, item.name) : undefined}
        style={({ pressed }) => [
          styles.channelItem,
          isSelected && { borderColor: color, backgroundColor: `${color}15` },
          pressed && { opacity: 0.7 },
        ]}
      >
        <View style={[styles.channelDot, { backgroundColor: color }]} />
        <View style={styles.channelInfo}>
          <Text style={[styles.channelName, isSelected && { color, fontWeight: '700' }]} numberOfLines={1}>
            {item.name}
          </Text>
          <Text style={styles.channelDesc} numberOfLines={1}>{item.description}</Text>
        </View>
        {channelMsgCount > 0 && (
          <View style={[styles.channelBadge, { backgroundColor: color }]}>
            <Text style={styles.channelBadgeText}>{channelMsgCount}</Text>
          </View>
        )}
        {item.id.startsWith('direct-') ? (
          <MaterialIcons name="phone" size={14} color="#8b5cf6" style={{ marginLeft: 4 }} />
        ) : isCustom ? (
          <MaterialIcons name="group" size={14} color="#9ca3af" style={{ marginLeft: 4 }} />
        ) : null}
      </Pressable>
    );
  }, [state.currentChannel, userId, canCreateGroup, selectChannel, getChannelMessages, handleDeleteGroup]);

  const renderMessageItem = useCallback(({ item }: { item: PTTMessage }) => {
    const isMine = item.senderId === userId;
    const isPlaying = state.currentPlayingMessageId === item.id;
    const roleColor = getRoleColor(item.senderRole);

    return (
      <Pressable
        onPress={() => handlePlayMessage(item)}
        style={({ pressed }) => [
          styles.messageItem,
          isMine && styles.messageItemMine,
          pressed && { opacity: 0.7 },
        ]}
      >
        <View style={styles.messageHeader}>
          <View style={[styles.messageRoleBadge, { backgroundColor: roleColor }]}>
            <Text style={styles.messageRoleText}>{ROLE_LABELS[item.senderRole] || item.senderRole}</Text>
          </View>
          <Text style={styles.messageSender} numberOfLines={1}>{item.senderName}</Text>
          <Text style={styles.messageTime}>{formatTimestamp(item.timestamp)}</Text>
        </View>
        <View style={styles.messageBody}>
          <MaterialIcons
            name={isPlaying ? 'pause-circle-filled' : 'play-circle-filled'}
            size={32}
            color={isPlaying ? '#ef4444' : '#3b82f6'}
          />
          <View style={styles.messageWaveform}>
            {Array.from({ length: 20 }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.waveformBar,
                  {
                    height: 4 + Math.random() * 16,
                    backgroundColor: isPlaying ? '#3b82f6' : '#d1d5db',
                  },
                ]}
              />
            ))}
          </View>
          <Text style={styles.messageDuration}>{formatDuration(item.duration)}</Text>
        </View>
        {!item.played && !isMine && <View style={styles.unplayedDot} />}
      </Pressable>
    );
  }, [userId, state.currentPlayingMessageId, handlePlayMessage]);

  const canTransmitCurrent = canTransmit(userRole);

  return (
    <TalionScreen>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerLeft}>
            <MaterialIcons name="settings-voice" size={24} color="#1e3a5f" />
            <Text style={styles.headerTitle}>Push-to-Talk</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable
              onPress={handleShowDirectCall}
              style={({ pressed }) => [styles.directCallBtn, pressed && { opacity: 0.7 }]}
            >
              <MaterialIcons name="phone" size={18} color="#ffffff" />
              <Text style={styles.addGroupText}>Direct</Text>
            </Pressable>
            {canCreateGroup && (
              <Pressable
                onPress={() => setShowCreateGroup(true)}
                style={({ pressed }) => [styles.addGroupBtn, pressed && { opacity: 0.7 }]}
              >
                <MaterialIcons name="group-add" size={20} color="#ffffff" />
                <Text style={styles.addGroupText}>Groupe</Text>
              </Pressable>
            )}
          </View>
        </View>

        {/* Channel selector */}
        <View style={styles.channelSection}>
          <Text style={styles.sectionLabel}>CANAUX</Text>
          <FlatList
            data={visibleChannels}
            renderItem={renderChannelItem}
            keyExtractor={(item) => item.id}
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.channelList}
          />
        </View>

        {/* Current channel info + talking indicator */}
        {state.currentChannel && (
          <View style={[styles.currentChannelBar, { backgroundColor: `${getChannelColor(state.currentChannel.id)}15` }]}>
            <View style={[styles.channelDotSmall, { backgroundColor: getChannelColor(state.currentChannel.id) }]} />
            <Text style={[styles.currentChannelName, { color: getChannelColor(state.currentChannel.id) }]}>
              {state.currentChannel.name}
            </Text>
            {!canTransmitCurrent && (
              <Text style={styles.listenOnlyBadge}>Écoute seule</Text>
            )}
          </View>
        )}

        {/* Talking indicator */}
        {talkingOnChannel.length > 0 && (
          <View style={styles.talkingBar}>
            <View style={styles.talkingPulse} />
            <MaterialIcons name="mic" size={16} color="#ef4444" />
            <Text style={styles.talkingText}>
              {talkingOnChannel.map(t => t.userName).join(', ')} parle...
            </Text>
            <Text style={styles.talkingRole}>
              {talkingOnChannel.length === 1 ? (ROLE_LABELS[talkingOnChannel[0].userRole] || '') : ''}
            </Text>
          </View>
        )}

        {/* Messages */}
        <FlatList
          data={currentMessages}
          renderItem={renderMessageItem}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messageList}
          inverted={false}
          ListEmptyComponent={
            <View style={styles.emptyMessages}>
              <MaterialIcons name="mic-none" size={48} color="#d1d5db" />
              <Text style={styles.emptyText}>Aucun message</Text>
              <Text style={styles.emptySubtext}>
                {canTransmitCurrent
                  ? 'Maintenez le bouton pour parler'
                  : 'En attente de messages...'}
              </Text>
            </View>
          }
        />

        {/* Emergency Overlay */}
        {state.emergencyActive && !isEmergencyRecording && state.lastEmergencyMessage && (
          <View style={styles.emergencyOverlay}>
            <View style={styles.emergencyContent}>
              <MaterialIcons name="warning" size={40} color="#ffffff" />
              <Text style={styles.emergencyTitle}>MESSAGE D'URGENCE</Text>
              <Text style={styles.emergencySender}>
                {state.lastEmergencyMessage.senderName} ({ROLE_LABELS[state.lastEmergencyMessage.senderRole] || state.lastEmergencyMessage.senderRole})
              </Text>
              <Pressable
                onPress={() => playMessage(state.lastEmergencyMessage!)}
                style={({ pressed }) => [styles.emergencyPlayBtn, pressed && { opacity: 0.8 }]}
              >
                <MaterialIcons
                  name={state.currentPlayingMessageId === state.lastEmergencyMessage.id ? 'pause-circle-filled' : 'play-circle-filled'}
                  size={48}
                  color="#ffffff"
                />
                <Text style={styles.emergencyPlayText}>
                  {state.currentPlayingMessageId === state.lastEmergencyMessage.id ? 'Écoute en cours...' : 'Écouter le message'}
                </Text>
              </Pressable>
              <Pressable
                onPress={handleDismissEmergency}
                style={({ pressed }) => [styles.emergencyDismissBtn, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.emergencyDismissText}>Fermer</Text>
              </Pressable>
            </View>
          </View>
        )}

        {/* PTT Button */}
        <View style={styles.pttSection}>
          {!canTransmitCurrent && (
            <Text style={styles.noAccessText}>Vous ne pouvez pas transmettre sur ce canal</Text>
          )}
          <View style={styles.pttButtonRow}>
            <Pressable
              onPress={canTransmitCurrent && !isEmergencyRecording ? handlePTTPress : undefined}
              style={({ pressed }) => [
                styles.pttButtonOuter,
                state.isRecording && !isEmergencyRecording && styles.pttButtonOuterRecording,
                pressed && canTransmitCurrent && { opacity: 0.85 },
              ]}
            >
              <View style={[
                styles.pttButton,
                state.isRecording && !isEmergencyRecording && styles.pttButtonRecording,
                !canTransmitCurrent && styles.pttButtonDisabled,
              ]}>
                <MaterialIcons
                  name={state.isRecording && !isEmergencyRecording ? 'mic' : 'mic-none'}
                  size={36}
                  color={state.isRecording && !isEmergencyRecording ? '#ffffff' : (!canTransmitCurrent ? '#9ca3af' : '#1e3a5f')}
                />
                <Text style={[
                  styles.pttButtonText,
                  state.isRecording && !isEmergencyRecording && styles.pttButtonTextRecording,
                  !canTransmitCurrent && styles.pttButtonTextDisabled,
                ]}>
                  {state.isRecording && !isEmergencyRecording ? 'ARRÊTER' : 'PARLER'}
                </Text>
              </View>
            </Pressable>

            {/* Emergency PTT Button */}
            {canEmergency && (
              <Pressable
                onPress={handleEmergencyPress}
                style={({ pressed }) => [
                  styles.emergencyButtonOuter,
                  isEmergencyRecording && styles.emergencyButtonOuterActive,
                  pressed && { opacity: 0.8 },
                ]}
              >
                <View style={[
                  styles.emergencyButton,
                  isEmergencyRecording && styles.emergencyButtonActive,
                ]}>
                  <MaterialIcons
                    name="warning"
                    size={24}
                    color={isEmergencyRecording ? '#ffffff' : '#ef4444'}
                  />
                  <Text style={[
                    styles.emergencyButtonText,
                    isEmergencyRecording && { color: '#ffffff' },
                  ]}>
                    {isEmergencyRecording ? 'STOP' : 'URGENCE'}
                  </Text>
                </View>
              </Pressable>
            )}
          </View>
        </View>

        {/* Direct Call Modal */}
        <Modal visible={showDirectCall} animationType="slide" transparent>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>📞 Appel direct</Text>
                <Pressable onPress={() => setShowDirectCall(false)} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
                  <MaterialIcons name="close" size={24} color="#6b7280" />
                </Pressable>
              </View>
              <ScrollView style={styles.modalBody}>
                {isLoadingUsers ? (
                  <Text style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Chargement...</Text>
                ) : directCallUsers.length === 0 ? (
                  <Text style={{ textAlign: 'center', color: '#9ca3af', padding: 20 }}>Aucun utilisateur disponible</Text>
                ) : (
                  directCallUsers.map((u: any) => {
                    const roleIcon = u.role === 'admin' ? '👑' : u.role === 'dispatcher' ? '📡' : u.role === 'responder' ? '🛡️' : '👤';
                    const displayName = u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.id;
                    return (
                      <Pressable
                        key={u.id}
                        onPress={() => handleDirectCall(u.id, displayName)}
                        style={({ pressed }) => [
                          styles.directUserItem,
                          pressed && { opacity: 0.7, backgroundColor: '#f3f4f6' },
                        ]}
                      >
                        <Text style={{ fontSize: 22 }}>{roleIcon}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.directUserName}>{displayName}</Text>
                          <Text style={styles.directUserRole}>{ROLE_LABELS[u.role] || u.role}</Text>
                        </View>
                        <MaterialIcons name="phone" size={20} color="#8b5cf6" />
                      </Pressable>
                    );
                  })
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* Create Group Modal */}
        <Modal visible={showCreateGroup} animationType="slide" transparent>
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <View style={styles.modalHeader}>
                <Text style={styles.modalTitle}>Créer un groupe</Text>
                <Pressable onPress={() => setShowCreateGroup(false)} style={({ pressed }) => [pressed && { opacity: 0.6 }]}>
                  <MaterialIcons name="close" size={24} color="#6b7280" />
                </Pressable>
              </View>

              <ScrollView style={styles.modalBody}>
                <Text style={styles.fieldLabel}>Nom du groupe *</Text>
                <TextInput
                  style={styles.textInput}
                  value={groupName}
                  onChangeText={setGroupName}
                  placeholder="Ex: Équipe Champel"
                  placeholderTextColor="#9ca3af"
                  returnKeyType="done"
                />

                <Text style={styles.fieldLabel}>Description</Text>
                <TextInput
                  style={[styles.textInput, { height: 60 }]}
                  value={groupDesc}
                  onChangeText={setGroupDesc}
                  placeholder="Description optionnelle"
                  placeholderTextColor="#9ca3af"
                  multiline
                />

                <Text style={styles.fieldLabel}>Rôles autorisés</Text>
                <View style={styles.rolesGrid}>
                  {ROLE_OPTIONS.map(role => {
                    const isSelected = groupRoles.includes(role.id);
                    return (
                      <Pressable
                        key={role.id}
                        onPress={() => toggleRole(role.id)}
                        style={({ pressed }) => [
                          styles.roleChip,
                          isSelected && { backgroundColor: getRoleColor(role.id), borderColor: getRoleColor(role.id) },
                          pressed && { opacity: 0.7 },
                        ]}
                      >
                        <MaterialIcons
                          name={isSelected ? 'check-box' : 'check-box-outline-blank'}
                          size={16}
                          color={isSelected ? '#ffffff' : '#6b7280'}
                        />
                        <Text style={[styles.roleChipText, isSelected && { color: '#ffffff' }]}>
                          {role.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>

              <View style={styles.modalFooter}>
                <Pressable
                  onPress={() => setShowCreateGroup(false)}
                  style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.cancelBtnText}>Annuler</Text>
                </Pressable>
                <Pressable
                  onPress={handleCreateGroup}
                  disabled={isCreating || !groupName.trim()}
                  style={({ pressed }) => [
                    styles.createBtn,
                    (isCreating || !groupName.trim()) && { opacity: 0.5 },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text style={styles.createBtnText}>{isCreating ? 'Création...' : 'Créer'}</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    </TalionScreen>
  );
}

// ─── Styles ─────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1 },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerTitle: { fontSize: 20, fontWeight: '700', color: '#1e3a5f' },
  addGroupBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#1e3a5f',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  addGroupText: { fontSize: 12, fontWeight: '600', color: '#ffffff' },
  directCallBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#8b5cf6',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  directUserItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    marginBottom: 8,
  },
  directUserName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1e293b',
  },
  directUserRole: {
    fontSize: 12,
    color: '#9ca3af',
  },
  // Channel section
  channelSection: {
    backgroundColor: '#ffffff',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: '800',
    color: '#9ca3af',
    letterSpacing: 1,
    paddingHorizontal: 16,
    marginBottom: 6,
  },
  channelList: { paddingHorizontal: 12 },
  channelItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginHorizontal: 4,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    backgroundColor: '#f9fafb',
    minWidth: 120,
  },
  channelDot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  channelInfo: { flex: 1 },
  channelName: { fontSize: 13, fontWeight: '600', color: '#374151' },
  channelDesc: { fontSize: 10, color: '#9ca3af', marginTop: 1 },
  channelBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 6,
  },
  channelBadgeText: { fontSize: 10, fontWeight: '700', color: '#ffffff' },
  // Current channel bar
  currentChannelBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 8,
  },
  channelDotSmall: { width: 6, height: 6, borderRadius: 3 },
  currentChannelName: { fontSize: 13, fontWeight: '700', flex: 1 },
  listenOnlyBadge: {
    fontSize: 10,
    fontWeight: '600',
    color: '#f59e0b',
    backgroundColor: '#fef3c7',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  // Messages
  messageList: { padding: 12, paddingBottom: 8 },
  emptyMessages: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
    paddingBottom: 40,
  },
  emptyText: { fontSize: 16, fontWeight: '600', color: '#9ca3af', marginTop: 12 },
  emptySubtext: { fontSize: 13, color: '#d1d5db', marginTop: 4 },
  messageItem: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  messageItemMine: { backgroundColor: '#f0f7ff', borderColor: '#bfdbfe' },
  messageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
    gap: 8,
  },
  messageRoleBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4 },
  messageRoleText: { fontSize: 9, fontWeight: '800', color: '#ffffff', letterSpacing: 0.5 },
  messageSender: { fontSize: 13, fontWeight: '600', color: '#374151', flex: 1 },
  messageTime: { fontSize: 11, color: '#9ca3af' },
  messageBody: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  messageWaveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 24,
  },
  waveformBar: { width: 3, borderRadius: 1.5 },
  messageDuration: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6b7280',
    minWidth: 36,
    textAlign: 'right',
  },
  unplayedDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3b82f6',
  },
  // PTT Button
  pttSection: {
    alignItems: 'center',
    paddingVertical: 16,
    paddingBottom: 24,
    backgroundColor: '#ffffff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  noAccessText: {
    fontSize: 12,
    color: '#ef4444',
    marginBottom: 8,
    textAlign: 'center',
  },
  pttButtonOuter: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(30, 58, 95, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pttButtonOuterRecording: { backgroundColor: 'rgba(239, 68, 68, 0.15)' },
  pttButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#f0f2f5',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#1e3a5f',
  },
  pttButtonRecording: { backgroundColor: '#ef4444', borderColor: '#dc2626' },
  pttButtonDisabled: { borderColor: '#d1d5db', backgroundColor: '#f9fafb' },
  pttButtonText: {
    fontSize: 10,
    fontWeight: '800',
    color: '#1e3a5f',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  pttButtonTextRecording: { color: '#ffffff' },
  pttButtonTextDisabled: { color: '#9ca3af' },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1e3a5f' },
  modalBody: { padding: 20 },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
    marginTop: 12,
  },
  textInput: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111827',
    backgroundColor: '#f9fafb',
  },
  rolesGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 4,
  },
  roleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#d1d5db',
    backgroundColor: '#f9fafb',
  },
  roleChipText: { fontSize: 13, fontWeight: '500', color: '#374151' },
  modalFooter: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  cancelBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#f3f4f6',
  },
  cancelBtnText: { fontSize: 15, fontWeight: '600', color: '#6b7280' },
  createBtn: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#1e3a5f',
  },
  createBtnText: { fontSize: 15, fontWeight: '600', color: '#ffffff' },
  // Talking indicator
  talkingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 6,
    backgroundColor: '#fef2f2',
    borderBottomWidth: 1,
    borderBottomColor: '#fecaca',
    gap: 6,
  },
  talkingPulse: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ef4444',
  },
  talkingText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#dc2626',
    flex: 1,
  },
  talkingRole: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ef4444',
    backgroundColor: '#fee2e2',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  // PTT button row
  pttButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 20,
  },
  // Emergency button
  emergencyButtonOuter: {
    width: 70,
    height: 70,
    borderRadius: 35,
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emergencyButtonOuterActive: { backgroundColor: 'rgba(239, 68, 68, 0.2)' },
  emergencyButton: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#ef4444',
  },
  emergencyButtonActive: { backgroundColor: '#ef4444', borderColor: '#dc2626' },
  emergencyButtonText: {
    fontSize: 8,
    fontWeight: '800',
    color: '#ef4444',
    letterSpacing: 0.5,
    marginTop: 1,
  },
  // Emergency overlay
  emergencyOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(220, 38, 38, 0.95)',
    zIndex: 100,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  emergencyContent: {
    alignItems: 'center',
    gap: 16,
  },
  emergencyTitle: {
    fontSize: 24,
    fontWeight: '900',
    color: '#ffffff',
    letterSpacing: 2,
  },
  emergencySender: {
    fontSize: 16,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.9)',
  },
  emergencyPlayBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  emergencyPlayText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  emergencyDismissBtn: {
    marginTop: 24,
    paddingHorizontal: 32,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  emergencyDismissText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
});
