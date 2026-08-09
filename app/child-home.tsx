import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet, Alert, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { SOSButton } from '@/components/sos-button';
import { useAuth } from '@/hooks/useAuth';
import { useLocation } from '@/lib/location-context';
import NativeMapView, { Marker, isNativeMap } from '@/components/map-view';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader } from '@/lib/auth-fetch';

// The entire screen for a parent-activated 'enfant' UI profile — see
// PUT /api/users/:id/ui-profile. No tabs, no settings: call for help, say
// "I don't feel well", call someone (112, a parent, or a parent-added extra
// like a nanny/school), or view a read-only medical info card.
// app/_layout.tsx locks the child into this screen and blocks swipe-back
// navigation away from it (gestureEnabled: false on its Stack.Screen).

interface CallContact {
  id: string;
  name: string;
  phone: string;
  urgent?: boolean; // 112 — styled distinctly, always first, never removable
}

interface HomeAddress {
  latitude: number;
  longitude: number;
}

interface DestinationLocation {
  latitude: number;
  longitude: number;
  label: string;
}

const EMERGENCY_CONTACT: CallContact = { id: 'sos-112', name: 'Secours (112)', phone: '112', urgent: true };

export default function ChildHomeScreen() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const { location } = useLocation();
  const [malaiseSending, setMalaiseSending] = useState(false);
  const [callContacts, setCallContacts] = useState<CallContact[]>([EMERGENCY_CONTACT]);
  const [homeAddress, setHomeAddress] = useState<HomeAddress | null>(null);
  const [destination, setDestination] = useState<DestinationLocation | null>(null);

  const BASE = getApiBaseUrl();

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const [parentsRes, extrasRes] = await Promise.all([
          fetchWithTimeout(`${BASE}/api/family/parent-contacts?userId=${user.id}`, { timeout: 10000, headers: await authHeader() }),
          fetchWithTimeout(`${BASE}/api/family/call-contacts?targetUserId=${user.id}`, { timeout: 10000, headers: await authHeader() }),
        ]);
        const parents = await parentsRes.json();
        const extras = await extrasRes.json();
        setCallContacts([
          EMERGENCY_CONTACT,
          ...(Array.isArray(parents) ? parents.map((p: any) => ({ id: p.userId, name: p.name, phone: p.phone })) : []),
          ...(Array.isArray(extras) ? extras.map((c: any) => ({ id: c.id, name: c.name, phone: c.phone })) : []),
        ]);
      } catch (e) {
        console.warn('[ChildHome] Failed to fetch call contacts:', e);
      }
    })();
    (async () => {
      try {
        const res = await fetchWithTimeout(`${BASE}/api/users/${user.id}/addresses`, { timeout: 10000, headers: await authHeader() });
        const data = await res.json();
        const addrs = Array.isArray(data) ? data : [];
        const primary = addrs.find((a: any) => a.isPrimary) || addrs[0];
        if (primary?.latitude != null && primary?.longitude != null) {
          setHomeAddress({ latitude: primary.latitude, longitude: primary.longitude });
        }
      } catch (e) {
        console.warn('[ChildHome] Failed to fetch home address:', e);
      }
    })();
    (async () => {
      try {
        const res = await fetchWithTimeout(`${BASE}/api/family/daily-routes?targetUserId=${user.id}`, { timeout: 10000, headers: await authHeader() });
        const data = await res.json();
        const routes = Array.isArray(data) ? data : [];
        const active = routes.find((r: any) => r.active) || routes[0];
        const waypoints = Array.isArray(active?.waypoints) ? active.waypoints.slice().sort((a: any, b: any) => a.order - b.order) : [];
        const lastWaypoint = waypoints[waypoints.length - 1];
        if (lastWaypoint?.latitude != null && lastWaypoint?.longitude != null) {
          setDestination({ latitude: lastWaypoint.latitude, longitude: lastWaypoint.longitude, label: active.label || 'Destination' });
        }
      } catch (e) {
        console.warn('[ChildHome] Failed to fetch daily route:', e);
      }
    })();
  }, [BASE, user?.id]);

  const handleMalaise = () => {
    Alert.alert('Je ne me sens pas bien', 'Confirmer ? Tes parents et l\'équipe sécurité vont être prévenus.', [
      { text: 'Annuler', style: 'cancel' },
      {
        text: 'Confirmer', onPress: async () => {
          setMalaiseSending(true);
          try {
            const res = await fetchWithTimeout(`${BASE}/api/family/quick-alert`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
              body: JSON.stringify({ type: 'malaise' }),
              timeout: 10000,
            });
            if (res.ok) {
              Alert.alert('Envoyé', 'Tes parents ont été prévenus.');
            } else {
              Alert.alert('Erreur', 'Réessaie dans un instant.');
            }
          } catch (e) {
            Alert.alert('Erreur', 'Réessaie dans un instant.');
          }
          setMalaiseSending(false);
        },
      },
    ]);
  };

  const handleCall = (contact: CallContact) => {
    Linking.openURL(`tel:${contact.phone}`).catch(() => {
      Alert.alert('Erreur', "Impossible de lancer l'appel");
    });
  };

  const handleLogout = () => {
    Alert.alert('Se déconnecter', 'Confirmer la déconnexion de ce compte ?', [
      { text: 'Annuler', style: 'cancel' },
      { text: 'Se déconnecter', style: 'destructive', onPress: () => { logout(); } },
    ]);
  };

  const mapPoints = [
    location?.latitude != null ? { key: 'me', label: 'Toi', color: '#3B82F6', coords: { latitude: location.latitude, longitude: location.longitude } } : null,
    homeAddress ? { key: 'home', label: 'Maison', color: '#22C55E', coords: homeAddress } : null,
    destination ? { key: 'destination', label: destination.label, color: '#F59E0B', coords: { latitude: destination.latitude, longitude: destination.longitude } } : null,
  ].filter((p): p is { key: string; label: string; color: string; coords: { latitude: number; longitude: number } } => p !== null);

  const region = mapPoints.length > 0 ? (() => {
    const lats = mapPoints.map(p => p.coords.latitude);
    const lngs = mapPoints.map(p => p.coords.longitude);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    return {
      latitude: (minLat + maxLat) / 2,
      longitude: (minLng + maxLng) / 2,
      latitudeDelta: Math.max(0.02, (maxLat - minLat) * 1.6),
      longitudeDelta: Math.max(0.02, (maxLng - minLng) * 1.6),
    };
  })() : null;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <Text style={styles.greeting}>Salut {user?.firstName || user?.name || ''} 👋</Text>

        <View style={styles.sosSection}>
          <SOSButton userName={user?.name || 'Unknown'} userRole={user?.role || 'user'} userId={user?.id || ''} variant="kid" />
        </View>

        <TouchableOpacity onPress={handleMalaise} style={styles.malaiseBtn} disabled={malaiseSending}>
          {malaiseSending ? (
            <ActivityIndicator color="#B45309" />
          ) : (
            <Text style={styles.malaiseBtnText}>⚕️ Je ne me sens pas bien</Text>
          )}
        </TouchableOpacity>

        {isNativeMap && region && (
          <View style={styles.mapContainer}>
            <NativeMapView initialRegion={region} showsUserLocation={false} showsMyLocationButton={false} showsCompass={false} style={styles.map}>
              {mapPoints.map(p => (
                <Marker key={p.key} coordinate={p.coords} title={p.label} pinColor={p.color} />
              ))}
            </NativeMapView>
          </View>
        )}

        <TouchableOpacity onPress={() => router.push('/child-medical-info')} style={styles.medicalBtn}>
          <Text style={styles.medicalBtnText}>🩺 Fiche médicale</Text>
        </TouchableOpacity>

        <Text style={styles.sectionTitle}>Appeler</Text>
        {callContacts.map(c => (
          <TouchableOpacity
            key={c.id}
            onPress={() => handleCall(c)}
            style={[styles.callBtn, c.urgent && styles.callBtnUrgent]}
          >
            <Text style={styles.callBtnIcon}>{c.urgent ? '🚑' : '📞'}</Text>
            <Text style={styles.callBtnText}>{c.urgent ? c.name : `Appeler ${c.name}`}</Text>
          </TouchableOpacity>
        ))}

        <TouchableOpacity onPress={handleLogout} style={styles.logoutLink} hitSlop={8}>
          <Text style={styles.logoutLinkText}>Se déconnecter</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#EFF6FF' },
  scrollContent: { padding: 20, paddingBottom: 40, alignItems: 'center' },
  greeting: { fontSize: 26, fontWeight: '800', color: '#1e3a5f', marginBottom: 16 },
  sosSection: { alignItems: 'center', marginBottom: 16 },
  malaiseBtn: {
    width: '100%', paddingVertical: 18, borderRadius: 16, alignItems: 'center',
    backgroundColor: '#FEF3C7', borderWidth: 2, borderColor: '#FDE68A', marginBottom: 20,
  },
  malaiseBtnText: { fontSize: 18, fontWeight: '800', color: '#B45309' },
  mapContainer: { width: '100%', height: 220, borderRadius: 16, overflow: 'hidden', marginBottom: 20 },
  map: { flex: 1 },
  medicalBtn: {
    width: '100%', paddingVertical: 16, borderRadius: 16, alignItems: 'center',
    backgroundColor: '#fff', borderWidth: 2, borderColor: '#1e3a5f', marginBottom: 20,
  },
  medicalBtnText: { fontSize: 18, fontWeight: '800', color: '#1e3a5f' },
  sectionTitle: { fontSize: 18, fontWeight: '800', color: '#1e3a5f', alignSelf: 'flex-start', marginBottom: 10 },
  callBtn: {
    width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 16, borderRadius: 16, backgroundColor: '#1e3a5f', marginBottom: 12,
  },
  callBtnUrgent: { backgroundColor: '#DC2626' },
  callBtnIcon: { fontSize: 22 },
  callBtnText: { fontSize: 18, fontWeight: '800', color: '#fff' },
  logoutLink: { marginTop: 24, padding: 8 },
  logoutLinkText: { fontSize: 12, color: '#9CA3AF', fontWeight: '600' },
});
