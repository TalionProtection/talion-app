import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Animated,
  Alert,
  Modal,
  Platform,
} from 'react-native';
import { notificationService, type SOSNotificationPayload } from '@/services/notification-service';
import locationService from '@/services/location-service';
import { alertSoundService } from '@/services/alert-sound-service';
import { getApiBaseUrl } from '@/lib/server-url';
import { offlineCache } from '@/services/offline-cache';

interface SOSButtonProps {
  onActivate?: (location: { latitude: number; longitude: number }) => void;
  onDeactivate?: () => void;
  userName?: string;
  userRole?: string;
  userId?: string;
}

const CANCEL_WINDOW = 5; // seconds before SOS is sent

export function SOSButton({ onActivate, onDeactivate, userName = 'Unknown', userRole = 'user', userId = '' }: SOSButtonProps) {
  const [isActive, setIsActive] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showCountdown, setShowCountdown] = useState(false);
  const [countdown, setCountdown] = useState(CANCEL_WINDOW);
  const [pulseAnim] = useState(new Animated.Value(1));
  const cancelledRef = useRef(false);
  const locationRef = useRef<{ latitude: number; longitude: number; address: string } | null>(null);
  const alertIdRef = useRef<string | null>(null);
  const liveTrackingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isActive) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.1, duration: 600, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
        ])
      ).start();
    } else {
      pulseAnim.setValue(1);
      // Stop live tracking when deactivated
      if (liveTrackingRef.current) {
        clearInterval(liveTrackingRef.current);
        liveTrackingRef.current = null;
      }
    }
  }, [isActive, pulseAnim]);

  // Countdown tick
  useEffect(() => {
    if (!showCountdown) return;
    if (countdown <= 0) {
      setShowCountdown(false);
      if (!cancelledRef.current) {
        executeSOS();
      }
      return;
    }
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [showCountdown, countdown]);

  const handlePress = () => {
    if (isActive) {
      setIsActive(false);
      onDeactivate?.();
      Alert.alert('SOS Désactivé', 'Le partage de position a été arrêté.');
    } else {
      setShowConfirmation(true);
    }
  };

  const sendSOSViaREST = async (alertData: {
    type: string;
    severity: string;
    location: { latitude: number; longitude: number; address: string };
    description: string;
  }): Promise<{ success: boolean; alertId?: string }> => {
    try {
      const baseUrl = getApiBaseUrl();
      const response = await fetch(`${baseUrl}/api/sos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...alertData,
          userId: userId || `user-${Date.now()}`,
          userName,
          userRole,
        }),
      });
      if (response.ok) {
        const result = await response.json();
        return { success: true, alertId: result.alertId };
      }
      return { success: false };
    } catch (error) {
      console.error('[SOSButton] REST SOS failed:', error);
      return { success: false };
    }
  };

  const updateAlertLocation = async (alertId: string, location: { latitude: number; longitude: number; address: string }) => {
    try {
      const baseUrl = getApiBaseUrl();
      await fetch(`${baseUrl}/alerts/${encodeURIComponent(alertId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location }),
      });
      console.log(`[SOSButton] Location updated for ${alertId}: ${location.address}`);
    } catch (e) {
      console.error('[SOSButton] Failed to update location:', e);
    }
  };

  const executeSOS = async () => {
    const location = locationRef.current || { latitude: 0, longitude: 0, address: '⚠️ Position en cours d\'acquisition...' };

    setIsActive(true);
    onActivate?.(location);
    alertSoundService.playSOSAlert();

    const alertData = {
      type: 'sos',
      severity: 'critical',
      location,
      description: `SOS Alert from ${userName} — ${location.address}. Assistance immédiate requise.`,
    };

    const { success, alertId } = await sendSOSViaREST(alertData);
    if (alertId) alertIdRef.current = alertId;

    if (!success) {
      await offlineCache.enqueueAction('sos', {
        ...alertData,
        userId: userId || `user-${Date.now()}`,
        userName,
        userRole,
      });
    }

    // Send local notification
    const sosPayload: SOSNotificationPayload = {
      alertId: alertId || `sos-${Date.now()}`,
      senderName: userName,
      senderRole: userRole,
      alertType: 'sos',
      severity: 'critical',
      location,
      description: alertData.description,
      timestamp: Date.now(),
    };
    await notificationService.sendSOSAlert(sosPayload);

    // Start live GPS tracking — update every 30s
    if (alertId) {
      liveTrackingRef.current = setInterval(async () => {
        try {
          const pos = await locationService.getCurrentPosition();
          const addr = await locationService.reverseGeocode(pos.latitude, pos.longitude);
          const preciseLocation = {
            latitude: pos.latitude,
            longitude: pos.longitude,
            address: `✅ GPS: ${addr || `${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`}`,
          };
          await updateAlertLocation(alertId, preciseLocation);
        } catch {}
      }, 30000);
    }

    if (success) {
      Alert.alert(
        'SOS Activé',
        'Votre alerte SOS a été envoyée au centre de dispatch.\nTous les intervenants ont été notifiés.',
        [{ text: 'OK' }]
      );
    }
  };

  const handleConfirmSOS = async () => {
    setShowConfirmation(false);
    cancelledRef.current = false;
    locationRef.current = null;
    alertIdRef.current = null;

    // Haptic feedback
    if (Platform.OS !== 'web') {
      try {
        const Haptics = await import('expo-haptics');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } catch {}
    }

    // Start countdown
    setCountdown(CANCEL_WINDOW);
    setShowCountdown(true);

    // ─── Step 1: Use last known location immediately (with address) ───
    try {
      const fallback = locationService.getCurrentLocation();
      if (fallback.latitude !== 0) {
        // Reverse geocode the approximate position
        try {
          const addr = await locationService.reverseGeocode(fallback.latitude, fallback.longitude);
          if (addr) {
            locationRef.current = {
              latitude: fallback.latitude,
              longitude: fallback.longitude,
              address: `⚠️ Approx: ${addr}`,
            };
            console.log(`[SOSButton] Approximate location: ${addr}`);
          }
        } catch {}
      }
    } catch {}

    // ─── Step 2: Try to get precise GPS in parallel ───────────────────
    try {
      const pos = await locationService.getCurrentPosition();
      const addr = await locationService.reverseGeocode(pos.latitude, pos.longitude);
      if (addr) {
        locationRef.current = {
          latitude: pos.latitude,
          longitude: pos.longitude,
          address: `✅ GPS: ${addr}`,
        };
        console.log(`[SOSButton] Precise GPS: ${addr}`);
      }
    } catch (e) {
      console.warn('[SOSButton] GPS not available in time:', e);
    }
  };

  const handleCancelSOS = () => {
    cancelledRef.current = true;
    setShowCountdown(false);
    setCountdown(CANCEL_WINDOW);
    locationRef.current = null;
    alertIdRef.current = null;
    Alert.alert('SOS Annulé', "L'alerte SOS a été annulée.");
  };

  return (
    <>
      <Animated.View style={[styles.container, { transform: [{ scale: pulseAnim }] }]}>
        <TouchableOpacity
          style={[styles.button, isActive && styles.buttonActive]}
          onPress={handlePress}
          activeOpacity={0.8}
        >
          <Text style={styles.buttonIcon}>🆘</Text>
          <Text style={styles.buttonText}>SOS</Text>
        </TouchableOpacity>
      </Animated.View>

      {/* Confirmation Modal */}
      <Modal visible={showConfirmation} transparent animationType="fade" onRequestClose={() => setShowConfirmation(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Confirmer l'alerte SOS</Text>
            <Text style={styles.modalText}>
              Ceci alertera immédiatement tous les dispatchers et intervenants.{'\n\n'}
              Votre position sera partagée jusqu'à désactivation.
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity style={styles.cancelButton} onPress={() => setShowConfirmation(false)}>
                <Text style={styles.cancelButtonText}>Annuler</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.confirmButton} onPress={handleConfirmSOS}>
                <Text style={styles.confirmButtonText}>ENVOYER SOS</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Countdown Modal */}
      <Modal visible={showCountdown} transparent animationType="fade" onRequestClose={handleCancelSOS}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, styles.countdownContent]}>
            <Text style={styles.countdownTitle}>🆘 SOS en cours d'envoi</Text>
            <Text style={styles.countdownSubtitle}>Acquisition de votre position GPS...</Text>
            <View style={styles.countdownCircle}>
              <Text style={styles.countdownNumber}>{countdown}</Text>
            </View>
            <Text style={styles.countdownHint}>
              L'alerte sera envoyée dans {countdown} seconde{countdown > 1 ? 's' : ''}
            </Text>
            <TouchableOpacity style={styles.cancelWindowButton} onPress={handleCancelSOS}>
              <Text style={styles.cancelWindowButtonText}>ANNULER</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  button: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  buttonActive: {
    backgroundColor: '#991b1b',
    shadowColor: '#991b1b',
  },
  buttonIcon: {
    fontSize: 28,
  },
  buttonText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 13,
    letterSpacing: 1,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 340,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1f2937',
    marginBottom: 12,
    textAlign: 'center',
  },
  modalText: {
    fontSize: 14,
    color: '#6b7280',
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 24,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#f3f4f6',
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#374151',
    fontWeight: '600',
    fontSize: 15,
  },
  confirmButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#ef4444',
    alignItems: 'center',
  },
  confirmButtonText: {
    color: '#ffffff',
    fontWeight: '800',
    fontSize: 15,
  },
  countdownContent: {
    backgroundColor: '#1a1a2e',
    alignItems: 'center',
  },
  countdownTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#ef4444',
    marginBottom: 4,
    textAlign: 'center',
  },
  countdownSubtitle: {
    fontSize: 13,
    color: '#9ca3af',
    marginBottom: 24,
    textAlign: 'center',
  },
  countdownCircle: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  countdownNumber: {
    fontSize: 42,
    fontWeight: '800',
    color: '#ffffff',
  },
  countdownHint: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 24,
    textAlign: 'center',
  },
  cancelWindowButton: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#374151',
    alignItems: 'center',
  },
  cancelWindowButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 15,
  },
});
