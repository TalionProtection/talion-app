import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { useAuth } from '@/hooks/useAuth';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader } from '@/lib/auth-fetch';

// Read-only view for the 'enfant' simplified UI — a child can see their own
// medical info (useful to show someone in an emergency) but never edit it,
// same restriction already enforced for the 'ado' profile, here just with
// no edit UI at all rather than disabled fields.

interface MedicalInfo {
  bloodType?: string;
  allergies?: string;
  conditions?: string;
  medications?: string;
  physicianName?: string;
  physicianPhone?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  notes?: string;
}

function Row({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

export default function ChildMedicalInfoScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [info, setInfo] = useState<MedicalInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) { setLoading(false); return; }
    (async () => {
      try {
        const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/family/medical-info?userId=${user.id}`, {
          timeout: 10000, headers: await authHeader(),
        });
        const data = await res.json();
        setInfo(data || null);
      } catch (e) {
        setInfo(null);
      }
      setLoading(false);
    })();
  }, [user?.id]);

  const hasAnyInfo = info && Object.values(info).some(Boolean);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <IconSymbol name="chevron.left" size={22} color="#1e3a5f" />
        </Pressable>
        <Text style={styles.title}>🩺 Fiche médicale</Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <View style={styles.centered}><ActivityIndicator size="large" color="#1e3a5f" /></View>
      ) : !hasAnyInfo ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🩺</Text>
          <Text style={styles.emptyTitle}>Aucune fiche médicale enregistrée</Text>
          <Text style={styles.emptySubtitle}>Demande à un parent de la remplir.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Row label="Groupe sanguin" value={info?.bloodType} />
          <Row label="Allergies" value={info?.allergies} />
          <Row label="Conditions médicales" value={info?.conditions} />
          <Row label="Médicaments" value={info?.medications} />
          <Row label="Médecin traitant" value={info?.physicianName} />
          <Row label="Téléphone médecin" value={info?.physicianPhone} />
          <Row label="Contact d'urgence" value={info?.emergencyContactName} />
          <Row label="Téléphone contact d'urgence" value={info?.emergencyContactPhone} />
          <Row label="Notes" value={info?.notes} />
        </ScrollView>
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
  title: { fontSize: 17, fontWeight: '700', color: '#1e3a5f' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#1f2937', marginBottom: 6, textAlign: 'center' },
  emptySubtitle: { fontSize: 13, color: '#6B7280', textAlign: 'center' },
  row: {
    backgroundColor: '#fff', borderRadius: 12, borderWidth: 1, borderColor: '#E5E7EB',
    padding: 14, marginBottom: 10,
  },
  rowLabel: { fontSize: 11, fontWeight: '700', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  rowValue: { fontSize: 16, color: '#1f2937', fontWeight: '600' },
});
