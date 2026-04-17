import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, ScrollView, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TalionScreen } from '@/components/talion-banner';
import { useAuth } from '@/hooks/useAuth';
import { livekitPTT } from '@/lib/livekit-ptt';
import { getApiBaseUrl } from '@/lib/server-url';

const DISPATCH_ROOM = 'dispatch';

export default function PTTScreen() {
  const { user } = useAuth();
  const [connected, setConnected] = useState(false);
  const [transmitting, setTransmitting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [selectedUser, setSelectedUser] = useState<any | null>(null);
  const [currentRoom, setCurrentRoom] = useState(DISPATCH_ROOM);
  const isDispatcher = user?.role === 'dispatcher' || user?.role === 'admin';

  useEffect(() => {
    livekitPTT.onConnectionChange = (c) => setConnected(c);
    livekitPTT.onSpeakerChange = (id, name, speaking) => {
      if (speaking) setActiveSpeaker(name);
      else setActiveSpeaker(prev => prev === name ? null : prev);
    };
    livekitPTT.onError = (e) => Alert.alert('Erreur PTT', e);

    // Auto-connect au canal dispatch
    if (user?.id) connectToRoom(DISPATCH_ROOM);

    // Charger les users si dispatcher
    if (isDispatcher) fetchUsers();

    return () => { livekitPTT.disconnect(); };
  }, [user?.id]);

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/admin/users`);
      const data = await res.json();
      setUsers(data.filter((u: any) => u.id !== user?.id && u.status === 'active'));
    } catch {}
  };

  const connectToRoom = async (roomName: string) => {
    if (!user?.id) return;
    setConnecting(true);
    try {
      await livekitPTT.connect(user.id, user.name || 'Unknown', roomName);
      setCurrentRoom(roomName);
    } catch (e: any) {
      Alert.alert('Erreur', 'Impossible de se connecter au canal PTT');
    } finally {
      setConnecting(false);
    }
  };

  const handlePTTPress = async () => {
    if (!connected) {
      await connectToRoom(currentRoom);
      return;
    }
    await livekitPTT.startTransmit();
    setTransmitting(true);
  };

  const handlePTTRelease = async () => {
    await livekitPTT.stopTransmit();
    setTransmitting(false);
  };

  const handleSelectUser = async (u: any) => {
    setSelectedUser(u);
    const roomName = `direct-${[user!.id, u.id].sort().join('-')}`;
    await connectToRoom(roomName);
  };

  const handleBackToDispatch = async () => {
    setSelectedUser(null);
    await connectToRoom(DISPATCH_ROOM);
  };

  return (
    <TalionScreen>
      <SafeAreaView style={styles.container} edges={['bottom']}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>PTT</Text>
          <View style={[styles.statusDot, { backgroundColor: connected ? '#22c55e' : '#ef4444' }]} />
          <Text style={styles.statusText}>{connected ? 'Connecté' : 'Déconnecté'}</Text>
        </View>

        {/* Canal actuel */}
        <View style={styles.channelBanner}>
          <Text style={styles.channelLabel}>Canal actif</Text>
          <Text style={styles.channelName}>
            {selectedUser ? `📞 ${selectedUser.name}` : '📡 Dispatch'}
          </Text>
          {selectedUser && (
            <TouchableOpacity onPress={handleBackToDispatch} style={styles.backBtn}>
              <Text style={styles.backBtnText}>← Dispatch</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* Speaker actif */}
        {activeSpeaker && (
          <View style={styles.speakerBanner}>
            <Text style={styles.speakerText}>🎙 {activeSpeaker} parle...</Text>
          </View>
        )}

        {/* Bouton PTT */}
        <View style={styles.pttContainer}>
          {connecting ? (
            <ActivityIndicator size="large" color="#1e3a5f" />
          ) : (
            <Pressable
              style={[styles.pttButton, transmitting && styles.pttButtonActive]}
              onPressIn={handlePTTPress}
              onPressOut={handlePTTRelease}
            >
              <Text style={styles.pttIcon}>{transmitting ? '🔴' : '🎙'}</Text>
              <Text style={styles.pttLabel}>
                {transmitting ? 'EN COURS...' : 'MAINTENIR POUR PARLER'}
              </Text>
            </Pressable>
          )}
        </View>

        {/* Liste users (dispatcher seulement) */}
        {isDispatcher && (
          <View style={styles.usersSection}>
            <Text style={styles.sectionTitle}>Appel direct</Text>
            <ScrollView style={styles.usersList}>
              {users.map(u => (
                <TouchableOpacity
                  key={u.id}
                  style={[styles.userItem, selectedUser?.id === u.id && styles.userItemActive]}
                  onPress={() => handleSelectUser(u)}
                >
                  <View style={[styles.userAvatar, { backgroundColor: '#1e3a5f' }]}>
                    <Text style={styles.userAvatarText}>{u.name?.charAt(0) || '?'}</Text>
                  </View>
                  <View style={styles.userInfo}>
                    <Text style={styles.userName}>{u.name}</Text>
                    <Text style={styles.userRole}>{u.role}</Text>
                  </View>
                  <Text style={styles.callIcon}>📞</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}
      </SafeAreaView>
    </TalionScreen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: { flexDirection: 'row', alignItems: 'center', padding: 16, gap: 8 },
  title: { fontSize: 20, fontWeight: '700', color: '#1e3a5f', flex: 1 },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: 13, color: '#6b7280' },
  channelBanner: { margin: 16, backgroundColor: '#1e3a5f', borderRadius: 12, padding: 16 },
  channelLabel: { fontSize: 11, color: 'rgba(255,255,255,0.6)', marginBottom: 4 },
  channelName: { fontSize: 18, fontWeight: '700', color: '#ffffff' },
  backBtn: { marginTop: 8, alignSelf: 'flex-start', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
  backBtnText: { color: '#ffffff', fontSize: 13 },
  speakerBanner: { marginHorizontal: 16, backgroundColor: '#dcfce7', borderRadius: 8, padding: 10, marginBottom: 8 },
  speakerText: { color: '#166534', fontWeight: '600', textAlign: 'center' },
  pttContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 32 },
  pttButton: { width: 180, height: 180, borderRadius: 90, backgroundColor: '#1e3a5f', justifyContent: 'center', alignItems: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8 },
  pttButtonActive: { backgroundColor: '#dc2626', transform: [{ scale: 1.05 }] },
  pttIcon: { fontSize: 48, marginBottom: 8 },
  pttLabel: { color: '#ffffff', fontSize: 11, fontWeight: '700', textAlign: 'center', letterSpacing: 1 },
  usersSection: { maxHeight: 250, marginHorizontal: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 8 },
  usersList: { flex: 1 },
  userItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 10, padding: 12, marginBottom: 8, gap: 12 },
  userItemActive: { backgroundColor: '#dbeafe', borderWidth: 1, borderColor: '#3b82f6' },
  userAvatar: { width: 36, height: 36, borderRadius: 18, justifyContent: 'center', alignItems: 'center' },
  userAvatarText: { color: '#ffffff', fontWeight: '700', fontSize: 14 },
  userInfo: { flex: 1 },
  userName: { fontSize: 14, fontWeight: '600', color: '#1f2937' },
  userRole: { fontSize: 12, color: '#6b7280' },
  callIcon: { fontSize: 20 },
});
