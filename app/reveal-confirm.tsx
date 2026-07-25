import React, { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useAuth } from '@/hooks/useAuth';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { supabase } from '@/lib/auth-context';

export default function RevealConfirmScreen() {
  const { alertId } = useLocalSearchParams<{ alertId: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleConfirm = async () => {
    if (!user?.id || !alertId) return;
    setIsSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/alerts/${encodeURIComponent(alertId)}/reveal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({ userId: user.id }),
        timeout: 10000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
    } catch (e) {
      console.error('[RevealConfirm] Failed to reveal:', e);
    }
    setIsSubmitting(false);
  };

  return (
    <View style={styles.container}>
      {done ? (
        <>
          <Text style={styles.icon}>✅</Text>
          <Text style={styles.title}>Position partagée</Text>
          <Text style={styles.body}>
            Les secours peuvent maintenant vous localiser pour cet incident. Vous redeviendrez
            invisible automatiquement une fois l'incident résolu.
          </Text>
          <Pressable style={styles.secondaryBtn} onPress={() => router.back()}>
            <Text style={styles.secondaryBtnText}>Fermer</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.icon}>📍</Text>
          <Text style={styles.title}>Incident à proximité</Text>
          <Text style={styles.body}>
            Vous êtes actuellement en mode Ghost (invisible du dispatch). Un incident a été
            signalé près de vous — confirmez pour partager votre position avec les secours.
          </Text>
          <Pressable
            style={[styles.primaryBtn, isSubmitting && { opacity: 0.6 }]}
            onPress={handleConfirm}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.primaryBtnText}>Devenir visible</Text>
            )}
          </Pressable>
          <Pressable style={styles.secondaryBtn} onPress={() => router.back()} disabled={isSubmitting}>
            <Text style={styles.secondaryBtnText}>Non merci</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#ffffff',
  },
  icon: {
    fontSize: 48,
    marginBottom: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111827',
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    color: '#374151',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  primaryBtn: {
    backgroundColor: '#1e3a5f',
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 10,
    width: '100%',
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryBtn: {
    marginTop: 12,
    paddingVertical: 12,
  },
  secondaryBtnText: {
    color: '#6B7280',
    fontSize: 15,
  },
});
