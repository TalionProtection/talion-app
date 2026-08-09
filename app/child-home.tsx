import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet, Alert, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { SOSButton } from '@/components/sos-button';
import { useAuth } from '@/hooks/useAuth';
import { useLocation } from '@/lib/location-context';
import NativeMapView, { Marker, isNativeMap } from '@/components/map-view';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader } from '@/lib/auth-fetch';

// The entire screen for a parent-activated 'enfant' UI profile — see
// PUT /api/users/:id/ui-profile. No tabs, no settings, three actions only:
// call for help, say "I don't feel well", or call a parent. app/_layout.tsx
// locks the child into this screen and blocks swipe-back navigation away
// from it (gestureEnabled: false on its Stack.Screen).

interface ParentContact {
  userId: string;
  name: string;
  phone: string;
}

interface HomeAddress {
  latitude: number;
  longitude: number;
}

interface SchoolLocation {
  latitude: number;
  longitude: number;
}

export default function ChildHomeScreen() {
  const { user } = useAuth();
  const { location } = useLocation();
  const [malaiseSending, setMalaiseSending] = useState(false);
  const [parentContacts, setParentContacts] = useState<ParentContact[]>([]);
  const [homeAddress, setHomeAddress] = useState<HomeAddress | null>(null);
  const [schoolLocation, setSchoolLocation] = useState<SchoolLocation | null>(null);

  const BASE = getApiBaseUrl();

  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const res = await fetchWithTimeout(`${BASE}/api/family/parent-contacts?userId=${user.id}`, { timeout: 10000, headers: await authHeader() });
        const data = await res.json();
        setParentContacts(Array.isArray(data) ? data : []);
      } catch (e) {
        console.warn('[ChildHome] Failed to fetch parent contacts:', e);
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
        const res = await fetchWithTimeout(`${BASE}/api/family/school-routes?targetUserId=${user.id}`, { timeout: 10000, headers: await authHeader() });
        const data = await res.json();
        const routes = Array.isArray(data) ? data : [];
        const active = routes.find((r: any) => r.active) || routes[0];
        if (active?.schoolLocation?.latitude != null && active?.schoolLocation?.longitude != null) {
          setSchoolLocation({ latitude: active.schoolLocation.latitude, longitude: active.schoolLocation.longitude });
        }
      } catch (e) {
        console.warn('[ChildHome] Failed to fetch school route:', e);
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

  const handleCallParent = (contact: ParentContact) => {
    Linking.openURL(`tel:${contact.phone}`).catch(() => {
      Alert.alert('Erreur', "Impossible de lancer l'appel");
    });
  };

  const mapPoints = [
    location?.latitude != null ? { key: 'me', label: 'Toi', color: '#3B82F6', coords: { latitude: location.latitude, longitude: location.longitude } } : null,
    homeAddress ? { key: 'home', label: 'Maison', color: '#22C55E', coords: homeAddress } : null,
    schoolLocation ? { key: 'school', label: 'École', color: '#F59E0B', coords: schoolLocation } : null,
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

        <Text style={styles.sectionTitle}>Parler à mes parents</Text>
        {parentContacts.length === 0 ? (
          <ActivityIndicator color="#1e3a5f" style={{ marginTop: 12 }} />
        ) : (
          parentContacts.map(c => (
            <TouchableOpacity key={c.userId} onPress={() => handleCallParent(c)} style={styles.callBtn}>
              <Text style={styles.callBtnIcon}>📞</Text>
              <Text style={styles.callBtnText}>Appeler {c.name}</Text>
            </TouchableOpacity>
          ))
        )}
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
  sectionTitle: { fontSize: 18, fontWeight: '800', color: '#1e3a5f', alignSelf: 'flex-start', marginBottom: 10 },
  callBtn: {
    width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 16, borderRadius: 16, backgroundColor: '#1e3a5f', marginBottom: 12,
  },
  callBtnIcon: { fontSize: 22 },
  callBtnText: { fontSize: 18, fontWeight: '800', color: '#fff' },
});
