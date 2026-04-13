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

const CANCEL_WINDOW = 5; // seconds to cancel after confirmation

export function SOSButton({ onActivate, onDeactivate, userName = 'Unknown', userRole = 'user', userId = '' }: SOSButtonProps) {
  const [isActive, setIsActive] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [showCancelWindow, setShowCancelWindow] = useState(false);
  const [countdown, setCountdown] = useState(CANCEL_WINDOW);
  const [pulseAnim] = useState(new Animated.Value(1));
  const cancelledRef = useRef(false);
  const alertIdRef = useRef<string | null>(null);

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
    }
  }, [isActive, pulseAnim]);

  useEffect(() => {
    if (showCancelWindow && countdown > 0) {
      const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
      return () => clearTimeout(timer);
    }
    if (showCancelWindow && countdown === 0) {
      setShowCancelWindow(false);
    }
  }, [showCancelWindow, countdown]);

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

  const cancelSOSOnServer = async (alertId: string) => {
    try {
      const baseUrl = getApiBaseUrl();
      await fetch(`${baseUrl}/alerts/${alertId}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, reason: 'cancelled_by_user' }),
      });
      console.log(`[SOSButton] SOS ${alertId} cancelled`);
    } catch (e) {
      console.error('[SOSButton] Failed to cancel SOS:', e);
    }
  };

  const handleConfirmSOS = async () => {
    setShowConfirmation(false);
    cancelledRef.current = false;
    alertIdRef.current = null;

    // ─── 1. Show cancel window immediately ───────────────────────────
    setCountdown(CANCEL_WINDOW);
    setShowCancelWindow(true);
    setIsActive(true);

    // Haptic feedback
    if (Platform.OS !== 'web') {
      try {
        const Haptics = await import('expo-haptics');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } catch {}
    }

    // Play SOS sound immediately
    alertSoundService.playSOSAlert();

    // ─── 2. Get quick location (don't wait for precise GPS) ───────────
    let quickLocation = { latitude: 0, longitude: 0, address: 'Localisation en cours...' };
    try {
      const fallback = locationService.getCurrentLocation();
      if (fallback.latitude !== 0) {
        quickLocation = { latitude: fallback.latitude, longitude: fallback.longitude, address: 'Position approximative' };
      }
    } catch {}

    onActivate?.(quickLocation);

    // ─── 3. Send SOS immediately with quick location ──────────────────
    const alertData = {
      type: 'sos',
      severity: 'critical',
      location: quickLocation,
      description: `SOS Alert from ${userName}. Assistance immédiate requise.`,
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

    // ─── 4. Update location with precise GPS in background ───────────
    try {
      const pos = await locationService.getCurrentPosition();
      const addr = await locationService.reverseGeocode(pos.latitude, pos.longitude);
      const preciseLocation = {
        latitude: pos.latitude,
        longitude: pos.longitude,
        address: addr || 'Position GPS',
      };
      // Update alert on server with precise location if not cancelled
      if (!cancelledRef.current && alertIdRef.current) {
        const baseUrl = getApiBaseUrl();
        await fetch(`${baseUrl}/alerts/${alertIdRef.current}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location: preciseLocation }),
        }).catch(() => {});
      }
    } catch {}

    // Send local notification
    const sosPayload: SOSNotificationPayload = {
      alertId: alertIdRef.current || `sos-${Date.now()}`,
      senderName: userName,
      senderRole: userRole,
      alertType: 'sos',
      severity: 'critical',
      location: quickLocation,
      description: `${userName} a déclenché une alerte SOS. Assistance immédiate requise.`,
      timestamp: Date.now(),
    };
    await notificationService.sendSOSAlert(sosPayload);
  };

  const handleCancelSOS = async () => {
    cancelledRef.current = true;
    setShowCancelWindow(false);
    setIsActive(false);
    setCountdown(CANCEL_WINDOW);

    // Cancel on server if we have an alertId
    if (alertIdRef.current) {
      await cancelSOSOnServer(alertIdRef.current);
      alertIdRef.current = null;
    }

    onDeactivate?.();
    Alert.alert('SOS Annulé', 'Votre alerte SOS a été annulée.');
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

      {/* Cancel Window Modal — shown after confirmation, before SOS is processed */}
      <Modal visible={showCancelWindow} transparent animationType="fade" onRequestClose={handleCancelSOS}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, styles.cancelWindowContent]}>
            <Text style={styles.cancelWindowTitle}>🆘 SOS Envoyé</Text>
            <Text style={styles.cancelWindowSubtitle}>Les secours ont été alertés</Text>
            <View style={styles.countdownCircle}>
              <Text style={styles.countdownNumber}>{countdown}</Text>
            </View>
            <Text style={styles.cancelWindowHint}>Appuyez pour annuler</Text>
            <TouchableOpacity style={styles.cancelWindowButton} onPress={handleCancelSOS}>
              <Text style={styles.cancelWindowButtonText}>ANNULER L'ALERTE</Text>
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
  // Cancel window styles
  cancelWindowContent: {
    alignItems: 'center',
    backgroundColor: '#1a1a2e',
  },
  cancelWindowTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#ef4444',
    marginBottom: 4,
  },
  cancelWindowSubtitle: {
    fontSize: 14,
    color: '#9ca3af',
    marginBottom: 24,
  },
  countdownCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#ef4444',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  countdownNumber: {
    fontSize: 36,
    fontWeight: '800',
    color: '#ffffff',
  },
  cancelWindowHint: {
    fontSize: 12,
    color: '#6b7280',
    marginBottom: 20,
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
