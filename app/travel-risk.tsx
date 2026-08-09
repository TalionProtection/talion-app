import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ActivityIndicator, StyleSheet, Linking } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { authHeader } from '@/lib/auth-fetch';

interface TravelAdvisory {
  countrySlug: string;
  title: string;
  alertStatus: string[];
  summary: string;
  changeHistory: { note?: string; public_timestamp?: string }[];
  updatedAt: string | null;
  sourceUrl: string;
}

// Best-effort destination label -> UK GOV.UK slug (e.g. "Royaume-Uni" -> "royaume-uni").
// The FCDO site's own slugs are just lowercase-hyphenated English/French country
// names, so this covers the common case without a lookup table; anything it
// gets wrong the user can just retype in the search box below.
function slugify(input: string): string {
  return input
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents (é -> e, etc.)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const ALERT_COLORS: Record<string, string> = {
  avoid_all_travel: '#dc2626',
  avoid_all_but_essential_travel: '#f59e0b',
};

function alertLabel(status: string): string {
  const labels: Record<string, string> = {
    avoid_all_travel: '⛔ Déconseillé (tout voyage)',
    avoid_all_but_essential_travel: '⚠️ Déconseillé sauf raison impérieuse',
  };
  return labels[status] || status;
}

export default function TravelRiskScreen() {
  const router = useRouter();
  const { countrySlug: initialSlug, label } = useLocalSearchParams<{ countrySlug?: string; label?: string }>();

  const [query, setQuery] = useState(label || '');
  const [slug, setSlug] = useState(initialSlug || (label ? slugify(label) : ''));
  const [advisory, setAdvisory] = useState<TravelAdvisory | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

  const fetchAdvisory = useCallback(async (targetSlug: string) => {
    if (!targetSlug) return;
    setLoading(true);
    setNotFound(false);
    setAdvisory(null);
    try {
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/travel-advisory/${encodeURIComponent(targetSlug)}`, {
        headers: { Accept: 'application/json', ...(await authHeader()) },
        timeout: 10000,
      });
      if (res.status === 404) {
        setNotFound(true);
      } else if (res.ok) {
        const data = await res.json();
        setAdvisory(data);
      } else {
        setNotFound(true);
      }
    } catch (e) {
      setNotFound(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (slug) fetchAdvisory(slug);
  }, [slug, fetchAdvisory]);

  const handleSearch = () => {
    const s = slugify(query);
    if (!s) return;
    setSlug(s);
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <IconSymbol name="chevron.left" size={22} color="#1e3a5f" />
        </Pressable>
        <Text style={styles.title}>Zones à éviter</Text>
        <View style={{ width: 22 }} />
      </View>

      <View style={styles.searchRow}>
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Pays (ex: Espagne, Maroc...)"
          placeholderTextColor="#9CA3AF"
          returnKeyType="search"
          onSubmitEditing={handleSearch}
        />
        <Pressable style={styles.searchBtn} onPress={handleSearch}>
          <IconSymbol name="chevron.right" size={18} color="#fff" />
        </Pressable>
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#1e3a5f" />
        </View>
      ) : notFound ? (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🌍</Text>
          <Text style={styles.emptyTitle}>Aucune information trouvée</Text>
          <Text style={styles.emptySubtitle}>
            Vérifiez l&apos;orthographe du pays, ou consultez directement le site du gouvernement britannique.
          </Text>
        </View>
      ) : advisory ? (
        <ScrollView style={{ padding: 16 }} contentContainerStyle={{ paddingBottom: 40 }}>
          <Text style={styles.advisoryTitle}>{advisory.title}</Text>

          {advisory.alertStatus.length > 0 ? (
            advisory.alertStatus.map((status, i) => (
              <View key={i} style={[styles.alertBanner, { backgroundColor: (ALERT_COLORS[status] || '#f59e0b') + '20', borderColor: ALERT_COLORS[status] || '#f59e0b' }]}>
                <Text style={[styles.alertBannerText, { color: ALERT_COLORS[status] || '#f59e0b' }]}>{alertLabel(status)}</Text>
              </View>
            ))
          ) : (
            <View style={[styles.alertBanner, { backgroundColor: '#f0fdf4', borderColor: '#22C55E' }]}>
              <Text style={[styles.alertBannerText, { color: '#166534' }]}>✅ Aucune alerte majeure signalée</Text>
            </View>
          )}

          {!!advisory.summary && (
            <>
              <Text style={styles.sectionLabel}>Résumé</Text>
              <Text style={styles.summaryText}>{advisory.summary}</Text>
            </>
          )}

          {advisory.changeHistory.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Derniers changements</Text>
              {advisory.changeHistory.map((c, i) => (
                <View key={i} style={styles.changeRow}>
                  {!!c.public_timestamp && (
                    <Text style={styles.changeDate}>{new Date(c.public_timestamp).toLocaleDateString('fr-FR')}</Text>
                  )}
                  {!!c.note && <Text style={styles.changeNote}>{c.note}</Text>}
                </View>
              ))}
            </>
          )}

          <Pressable style={styles.sourceLink} onPress={() => Linking.openURL(advisory.sourceUrl)}>
            <Text style={styles.sourceLinkText}>Voir la source complète (GOV.UK) ↗</Text>
          </Pressable>
          <Text style={styles.disclaimerText}>
            Source : conseils aux voyageurs du gouvernement britannique (FCDO), fournis à titre informatif.
          </Text>
        </ScrollView>
      ) : (
        <View style={styles.centered}>
          <Text style={styles.emptyIcon}>🌍</Text>
          <Text style={styles.emptyTitle}>Recherchez un pays</Text>
          <Text style={styles.emptySubtitle}>Consultez les conseils de sécurité avant un voyage.</Text>
        </View>
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
  searchRow: { flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginBottom: 8 },
  searchInput: {
    flex: 1, backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E5E7EB',
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, color: '#1f2937',
  },
  searchBtn: {
    width: 42, height: 42, borderRadius: 10, backgroundColor: '#1e3a5f',
    alignItems: 'center', justifyContent: 'center',
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: '#1f2937', marginBottom: 6 },
  emptySubtitle: { fontSize: 13, color: '#6B7280', textAlign: 'center', lineHeight: 18 },
  advisoryTitle: { fontSize: 20, fontWeight: '700', color: '#1e3a5f', marginBottom: 12 },
  alertBanner: { borderRadius: 10, borderWidth: 1, padding: 12, marginBottom: 16 },
  alertBannerText: { fontSize: 14, fontWeight: '700' },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6, marginTop: 8 },
  summaryText: { fontSize: 14, color: '#374151', lineHeight: 20, marginBottom: 8 },
  changeRow: { marginBottom: 10 },
  changeDate: { fontSize: 11, color: '#9CA3AF', fontWeight: '600' },
  changeNote: { fontSize: 13, color: '#374151', marginTop: 2 },
  sourceLink: { marginTop: 16, alignSelf: 'flex-start' },
  sourceLinkText: { fontSize: 13, color: '#1e3a5f', fontWeight: '600' },
  disclaimerText: { fontSize: 11, color: '#9CA3AF', marginTop: 16, lineHeight: 16 },
});
