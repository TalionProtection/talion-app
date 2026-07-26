import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, FlatList, RefreshControl, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader } from '@/lib/auth-fetch';

interface ArchivedAlert {
  id: string;
  type: string;
  severity: string;
  status: string;
  address: string;
  description: string;
  timestamp: number;
  archivedAt: number;
  photos?: string[];
}

const TYPE_ICONS: Record<string, string> = {
  sos: '🆘', medical: '🏥', fire: '🔥', security: '🔒', hazard: '⚠️', accident: '💥', broadcast: '📢',
  home_jacking: '🏠', cambriolage: '🔓', animal_perdu: '🐾', evenement_climatique: '🌪️',
  rodage: '🏍️', vehicule_suspect: '🚙', fugue: '🏃', route_bloquee: '🚧', route_fermee: '⛔', other: '🚨',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#dc2626', high: '#f59e0b', medium: '#3b82f6', low: '#6b7280',
};

function formatDate(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function AlertsArchiveScreen() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<ArchivedAlert[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const fetchArchive = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/my-alerts/archive`, {
        headers: { Accept: 'application/json', ...(await authHeader()) },
        timeout: 10000,
      });
      if (res.ok) {
        const data = await res.json();
        setAlerts(Array.isArray(data) ? data : []);
      }
    } catch (e) {
      console.error('[AlertsArchive] Fetch error:', e);
    }
    setIsLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    fetchArchive();
  }, [fetchArchive]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchArchive();
  }, [fetchArchive]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <IconSymbol name="chevron.left" size={22} color="#1e3a5f" />
        </Pressable>
        <Text style={styles.title}>Alertes archivées</Text>
        <View style={{ width: 22 }} />
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#1e3a5f" />
        </View>
      ) : (
        <FlatList
          data={alerts}
          keyExtractor={(item) => item.id}
          contentContainerStyle={alerts.length === 0 ? styles.emptyContainer : styles.listContainer}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#1e3a5f" />}
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyIcon}>🗄️</Text>
              <Text style={styles.emptyTitle}>Aucune alerte archivée</Text>
              <Text style={styles.emptySubtitle}>
                Les alertes que le Dispatch archive apparaîtront ici, consultables à tout moment.
              </Text>
            </View>
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardIcon}>{TYPE_ICONS[item.type] || '🚨'}</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.cardAddress} numberOfLines={2}>{item.address || 'Adresse inconnue'}</Text>
                  <Text style={styles.cardMeta}>Signalée le {formatDate(item.timestamp)}</Text>
                </View>
                <View style={[styles.severityDot, { backgroundColor: SEVERITY_COLORS[item.severity] || '#6b7280' }]} />
              </View>
              {item.description ? <Text style={styles.cardDesc} numberOfLines={3}>{item.description}</Text> : null}
              <Text style={styles.cardArchivedAt}>Archivée le {formatDate(item.archivedAt)}</Text>
            </View>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12, backgroundColor: '#ffffff',
    borderBottomWidth: 1, borderBottomColor: '#e5e7eb',
  },
  title: { fontSize: 17, fontWeight: '700', color: '#111827' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, paddingHorizontal: 32 },
  emptyContainer: { flexGrow: 1 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#374151', marginBottom: 6 },
  emptySubtitle: { fontSize: 13, color: '#9CA3AF', textAlign: 'center', lineHeight: 19 },
  listContainer: { padding: 16, gap: 12 },
  card: {
    backgroundColor: '#ffffff', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#e5e7eb', marginBottom: 12,
    ...(Platform.OS === 'ios' ? { shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } } : { elevation: 1 }),
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  cardIcon: { fontSize: 22 },
  cardAddress: { fontSize: 14, fontWeight: '600', color: '#111827' },
  cardMeta: { fontSize: 12, color: '#9CA3AF', marginTop: 2 },
  severityDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  cardDesc: { fontSize: 13, color: '#4B5563', marginTop: 8, lineHeight: 18 },
  cardArchivedAt: { fontSize: 11, color: '#9CA3AF', marginTop: 8, fontStyle: 'italic' },
});
