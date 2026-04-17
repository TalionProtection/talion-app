import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Alert,
  ActivityIndicator, ScrollView, Pressable,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { TalionScreen } from '@/components/talion-banner';
import { useAuth } from '@/hooks/useAuth';
import { Audio } from 'expo-av';
import { getApiBaseUrl } from '@/lib/server-url';
import { websocketService } from '@/services/websocket';

export default function PTTScreen() {
  const { user } = useAuth();
  const [transmitting, setTransmitting] = useState(false);
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [selectedUser, setSelectedUser] = useState<any | null>(null);
  const [channel, setChannel] = useState('dispatch');
  const recordingRef = useRef<Audio.Recording | null>(null);
  const isDispatcher = user?.role === 'dispatcher' || user?.role === 'admin';

  useEffect(() => {
    if (isDispatcher) fetchUsers();
    
    // Écouter les messages PTT entrants
    const handlePTT = (data: any) => {
      if (data.type === 'pttStart') setActiveSpeaker(data.senderName);
      if (data.type === 'pttEnd') setActiveSpeaker(null);
    };
    websocketService.on('ptt', handlePTT);
    return () => websocketService.off('ptt', handlePTT);
  }, [user?.id]);

  const fetchUsers = async () => {
    try {
      const res = await fetch(`${getApiBaseUrl()}/admin/users`);
      const data = await res.json();
      setUsers(data.filter((u: any) => u.id !== user?.id && u.status === 'active'));
    } catch {}
  };

  const startTransmit = async () => {
    try {
      const { status } = await Audio.requestPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Accès au microphone nécessaire pour le PTT');
        return;
      }
      await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      setTransmitting(true);
      
      // Notifier les autres via WebSocket
      websocketService.send({ type: 'pttStart', senderId: user?.id, senderName: user?.name, channel });
    } catch (e: any) {
      Alert.alert('Erreur', e.message);
    }
  };

  const stopTransmit = async () => {
    if (!recordingRef.current) return;
    try {
      await recordingRef.current.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      setTransmitting(false);
      
      // Notifier fin de transmission
      websocketService.send({ type: 'pttEnd', senderId: user?.id, senderName: user?.name, channel });
      
      // Envoyer l'audio via le chat messaging
      if (uri) {
        const targetId = selectedUser ? selectedUser.id : 'b8044334-a903-4661-9f77-59fe469d67b3';
        const convRes = await fetch(`${getApiBaseUrl()}/api/conversations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'direct', participantIds: [user!.id, targetId], createdBy: user!.id }),
        });
        const convData = await convRes.json();
        if (convData.id || convData.conversation?.id) {
          const convId = convData.id || convData.conversation?.id;
          const formData = new FormData();
          formData.append('file', { uri, name: 'ptt.m4a', type: 'audio/m4a' } as any);
          formData.append('senderId', user!.id);
          formData.append('senderName', user!.name || '');
          formData.append('mediaType', 'audio');
          await fetch(`${getApiBaseUrl()}/api/conversations/${encodeURIComponent(convId)}/media`, {
            method: 'POST',
            headers: { 'Accept': 'application/json' },
            body: formData,
          });
        }
      }
    } catch (e: any) {
      setTransmitting(false);
      console.error('[PTT]', e);
    }
  };

  return (
    <TalionScreen>
      <SafeAreaView style={styles.container} edges={['bottom']}>
        <View style={styles.header}>
          <Text style={styles.title}>PTT</Text>
        </View>

        <View style={styles.channelBanner}>
          <Text style={styles.channelLabel}>Canal actif</Text>
          <Text style={styles.channelName}>
            {selectedUser ? `📞 ${selectedUser.name}` : '📡 Dispatch'}
          </Text>
          {selectedUser && (
            <TouchableOpacity onPress={() => setSelectedUser(null)} style={styles.backBtn}>
              <Text style={styles.backBtnText}>← Dispatch</Text>
            </TouchableOpacity>
          )}
        </View>

        {activeSpeaker && (
          <View style={styles.speakerBanner}>
            <Text style={styles.speakerText}>🎙 {activeSpeaker} parle...</Text>
          </View>
        )}

        <View style={styles.pttContainer}>
          <Pressable
            style={[styles.pttButton, transmitting && styles.pttButtonActive]}
            onPressIn={startTransmit}
            onPressOut={stopTransmit}
          >
            <Text style={styles.pttIcon}>{transmitting ? '🔴' : '🎙'}</Text>
            <Text style={styles.pttLabel}>
              {transmitting ? 'EN COURS...' : 'MAINTENIR POUR PARLER'}
            </Text>
          </Pressable>
        </View>

        {isDispatcher && (
          <View style={styles.usersSection}>
            <Text style={styles.sectionTitle}>Appel direct</Text>
            <ScrollView style={styles.usersList}>
              {users.map(u => (
                <TouchableOpacity
                  key={u.id}
                  style={[styles.userItem, selectedUser?.id === u.id && styles.userItemActive]}
                  onPress={() => setSelectedUser(u)}
                >
                  <View style={styles.userAvatar}>
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
  header: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  title: { fontSize: 20, fontWeight: '700', color: '#1e3a5f' },
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
  usersSection: { maxHeight: 250, marginHorizontal: 16, marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#374151', marginBottom: 8 },
  usersList: { flex: 1 },
  userItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#ffffff', borderRadius: 10, padding: 12, marginBottom: 8, gap: 12 },
  userItemActive: { backgroundColor: '#dbeafe', borderWidth: 1, borderColor: '#3b82f6' },
  userAvatar: { width: 36, height: 36, borderRadius: 18, backgroundColor: '#1e3a5f', justifyContent: 'center', alignItems: 'center' },
  userAvatarText: { color: '#ffffff', fontWeight: '700', fontSize: 14 },
  userInfo: { flex: 1 },
  userName: { fontSize: 14, fontWeight: '600', color: '#1f2937' },
  userRole: { fontSize: 12, color: '#6b7280' },
  callIcon: { fontSize: 20 },
});
