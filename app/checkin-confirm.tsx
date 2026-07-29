import React, { useState } from 'react';
import { View, Text, Pressable, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { supabase } from '@/lib/auth-context';

export default function CheckInConfirmScreen() {
  const { checkInId } = useLocalSearchParams<{ checkInId: string }>();
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const handleConfirm = async () => {
    if (!checkInId) return;
    setIsSubmitting(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/family/checkins/${encodeURIComponent(checkInId)}/confirm`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        timeout: 10000,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone(true);
    } catch (e) {
      console.error('[CheckInConfirm] Failed to confirm:', e);
    }
    setIsSubmitting(false);
  };

  return (
    <View style={styles.container}>
      {done ? (
        <>
          <Text style={styles.icon}>✅</Text>
          <Text style={styles.title}>Confirmé</Text>
          <Text style={styles.body}>
            Merci, on a bien noté que tu vas bien.
          </Text>
          <Pressable style={styles.secondaryBtn} onPress={() => router.back()}>
            <Text style={styles.secondaryBtnText}>Fermer</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.icon}>⏰</Text>
          <Text style={styles.title}>Confirmation de sécurité</Text>
          <Text style={styles.body}>
            Confirme que tu vas bien — sans confirmation, le dispatch sera alerté.
          </Text>
          <Pressable
            style={[styles.primaryBtn, isSubmitting && { opacity: 0.6 }]}
            onPress={handleConfirm}
            disabled={isSubmitting}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.primaryBtnText}>Je suis en sécurité</Text>
            )}
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
