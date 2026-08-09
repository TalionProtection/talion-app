import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader } from '@/lib/auth-fetch';
import NativeMapView, { Marker, Circle, Polyline, isNativeMap } from '@/components/map-view';

interface RouteWaypoint {
  id: string;
  order: number;
  label?: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

interface DailyRoute {
  id: string;
  targetUserName: string;
  label: string;
  waypoints: RouteWaypoint[];
  corridorMeters: number;
  commuteWindows: { hour: number; minute: number; durationMinutes: number; daysOfWeek: number[] }[];
  alertAllParents: boolean;
  alertParentIds: string[];
  alertDispatch: boolean;
  active: boolean;
}

const DAY_LABELS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

export default function DailyRouteMapScreen() {
  const router = useRouter();
  const { routeId, targetUserId } = useLocalSearchParams<{ routeId: string; targetUserId: string }>();
  const [route, setRoute] = useState<DailyRoute | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!targetUserId || !routeId) { setLoading(false); setError(true); return; }
    (async () => {
      try {
        const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/family/daily-routes?targetUserId=${targetUserId}`, {
          timeout: 10000, headers: await authHeader(),
        });
        const data: DailyRoute[] = await res.json();
        const found = Array.isArray(data) ? data.find(r => r.id === routeId) : null;
        if (found) setRoute(found); else setError(true);
      } catch (e) {
        setError(true);
      }
      setLoading(false);
    })();
  }, [routeId, targetUserId]);

  const orderedWaypoints = useMemo(() => route ? route.waypoints.slice().sort((a, b) => a.order - b.order) : [], [route]);

  const region = useMemo(() => {
    if (orderedWaypoints.length === 0) return null;
    const lats = orderedWaypoints.map(p => p.latitude);
    const lngs = orderedWaypoints.map(p => p.longitude);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max(0.01, (maxLat - minLat) * 1.6),
      longitudeDelta: Math.max(0.01, (maxLng - minLng) * 1.6),
    };
  }, [orderedWaypoints]);

  const commuteSummary = route?.commuteWindows[0]
    ? `${route.commuteWindows[0].daysOfWeek.slice().sort().map(d => DAY_LABELS[d]).join(', ')} · ${String(route.commuteWindows[0].hour).padStart(2, '0')}:${String(route.commuteWindows[0].minute).padStart(2, '0')} (${route.commuteWindows[0].durationMinutes}min)`
    : null;

  const alertSummary = route
    ? `${route.alertAllParents ? 'Tous les parents' : `${route.alertParentIds.length} parent(s) choisi(s)`}${route.alertDispatch ? ' + dispatch' : ''}`
    : '';

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <IconSymbol name="chevron.left" size={22} color="#1e3a5f" />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>{route ? `Trajet — ${route.label}` : 'Trajet'}</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator size="large" color="#1e3a5f" /></View>
      ) : error || !route || !region ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🗺️</Text>
          <Text style={styles.emptyTitle}>Trajet introuvable</Text>
        </View>
      ) : !isNativeMap ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🗺️</Text>
          <Text style={styles.emptyTitle}>Carte disponible uniquement sur l&apos;app mobile</Text>
        </View>
      ) : (
        <>
          <NativeMapView initialRegion={region} showsUserLocation={false} showsMyLocationButton={false} showsCompass={false} style={styles.map}>
            <Polyline coordinates={orderedWaypoints} strokeColor="#1e3a5f" strokeWidth={4} />
            {orderedWaypoints.map((wp, i) => (
              <Circle
                key={`corridor-${wp.id}`}
                center={wp}
                radius={route.corridorMeters}
                fillColor="rgba(30, 58, 95, 0.08)"
                strokeColor="rgba(30, 58, 95, 0.2)"
                strokeWidth={1}
              />
            ))}
            {orderedWaypoints.map((wp, i) => (
              <Circle
                key={`wp-${wp.id}`}
                center={wp}
                radius={wp.radiusMeters}
                fillColor="rgba(34, 197, 94, 0.18)"
                strokeColor="#22C55E"
                strokeWidth={1}
              />
            ))}
            {orderedWaypoints.map((wp, i) => (
              <Marker
                key={wp.id}
                coordinate={wp}
                title={wp.label || `Point ${i + 1}`}
                pinColor={i === 0 ? '#22C55E' : i === orderedWaypoints.length - 1 ? '#F59E0B' : '#1e3a5f'}
              />
            ))}
          </NativeMapView>

          <View style={styles.infoCard}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Membre</Text>
              <Text style={styles.infoValue}>{route.targetUserName}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Points</Text>
              <Text style={styles.infoValue}>{orderedWaypoints.length} (tolérance {route.corridorMeters}m entre eux)</Text>
            </View>
            {commuteSummary && (
              <View style={styles.infoRow}>
                <Text style={styles.infoLabel}>Fenêtre</Text>
                <Text style={styles.infoValue}>{commuteSummary}</Text>
              </View>
            )}
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Alerte</Text>
              <Text style={styles.infoValue}>{alertSummary}</Text>
            </View>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>Statut</Text>
              <Text style={[styles.infoValue, { color: route.active ? '#22C55E' : '#9CA3AF', fontWeight: '700' }]}>
                {route.active ? 'Actif' : 'Inactif'}
              </Text>
            </View>
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#f8fafc' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  title: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700', color: '#1e3a5f', marginHorizontal: 8 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyIcon: { fontSize: 40, marginBottom: 10 },
  emptyTitle: { fontSize: 15, fontWeight: '600', color: '#6B7280', textAlign: 'center' },
  map: { flex: 1 },
  infoCard: {
    backgroundColor: '#fff', borderTopWidth: 1, borderTopColor: '#E5E7EB',
    padding: 16, gap: 8,
  },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  infoLabel: { fontSize: 12, fontWeight: '700', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5 },
  infoValue: { fontSize: 13, color: '#374151', flexShrink: 1, textAlign: 'right', marginLeft: 12 },
});
