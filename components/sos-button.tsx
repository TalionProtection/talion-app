import React, { useState, useEffect, useCallback } from 'react';
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

export function SOSButton({ onActivate, onDeactivate, userName = 'Unknown', userRole = 'user', userId = '' }: SOSButtonProps) {
  const [isActive, setIsActive] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [pulseAnim] = useState(new Animated.Value(1));
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (isActive) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.1,
            duration: 600,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: true,
          }),
        ])
      ).start();
    }
  }, [isActive, pulseAnim]);

  useEffect(() => {
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    }
  }, [countdown]);

  const handlePress = () => {
    if (isActive) {
      setIsActive(false);
      onDeactivate?.();

      notificationService.sendStatusUpdate(
        'SOS Deactivated',
        `${userName} has deactivated their SOS alert.`,
      );

      Alert.alert('SOS Deactivated', 'Live location sharing has been stopped.');
    } else {
      setShowConfirmation(true);
    }
  };

  /**
   * Send SOS alert to server via HTTP POST (most reliable method).
   * This bypasses WebSocket entirely — HTTP works on all devices/networks.
   */
  const sendSOSViaREST = async (alertData: {
    type: string;
    severity: string;
    location: { latitude: number; longitude: number; address: string };
    description: string;
  }): Promise<boolean> => {
    try {
      const baseUrl = getApiBaseUrl();
      const url = `${baseUrl}/api/sos`;
      console.log(`[SOSButton] Sending SOS via REST to: ${url}`);

      const response = await fetch(url, {
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
        console.log(`[SOSButton] SOS sent successfully via REST. Alert ID: ${result.alertId}, broadcast: ${result.broadcast}`);
        return true;
      } else {
        console.error(`[SOSButton] REST SOS failed with status: ${response.status}`);
        return false;
      }
    } catch (error) {
      console.error('[SOSButton] REST SOS request failed:', error);
      return false;
    }
  };

  const handleConfirmSOS = async () => {
    setShowConfirmation(false);
    setIsActive(true);
    setCountdown(5);

    // Haptic feedback
    if (Platform.OS !== 'web') {
      try {
        const Haptics = await import('expo-haptics');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      } catch {}
    }

    // Get real GPS location
    let realLocation = { latitude: 0, longitude: 0, address: 'Unknown location' };
    try {
      const pos = await locationService.getCurrentPosition();
      realLocation = {
        latitude: pos.latitude,
        longitude: pos.longitude,
        address: 'Current Location',
      };
      const addr = await locationService.reverseGeocode(pos.latitude, pos.longitude);
      if (addr) realLocation.address = addr;
    } catch (e) {
      console.warn('[SOSButton] Failed to get GPS location, using fallback:', e);
      const fallback = locationService.getCurrentLocation();
      realLocation = {
        latitude: fallback.latitude,
        longitude: fallback.longitude,
        address: 'Approximate location',
      };
    }

    onActivate?.(realLocation);

    // Play SOS alert sound
    alertSoundService.playSOSAlert();

    // Send local notification
    const sosPayload: SOSNotificationPayload = {
      alertId: `sos-${Date.now()}`,
      senderName: userName,
      senderRole: userRole,
      alertType: 'sos',
      severity: 'critical',
      location: realLocation,
      description: `${userName} has triggered an SOS alert at ${realLocation.address}. Immediate assistance required.`,
      timestamp: Date.now(),
    };
    await notificationService.sendSOSAlert(sosPayload);

    // ─── Send SOS to server via HTTP POST (RELIABLE) ──────────────────
    const alertData = {
      type: 'sos',
      severity: 'critical',
      location: {
        latitude: realLocation.latitude,
        longitude: realLocation.longitude,
        address: realLocation.address || 'Unknown',
      },
      description: `SOS Alert from ${userName}: ${realLocation.address || 'Unknown location'}. Immediate assistance required.`,
    };

    const sent = await sendSOSViaREST(alertData);

    if (sent) {
      Alert.alert(
        'SOS Activated',
        'Your SOS alert has been sent to the dispatch center.\nAll responders and dispatchers have been notified.\n\nPress the SOS button to stop sharing.',
        [{ text: 'OK' }]
      );
    } else {
      // Queue for later sending when back online
      await offlineCache.enqueueAction('sos', {
        ...alertData,
        userId: userId || `user-${Date.now()}`,
        userName,
        userRole,
      });
      Alert.alert(
        'SOS Activated (Offline)',
        'Your SOS alert was saved and will be sent automatically when connection is restored.\n\nPress the SOS button to stop sharing.',
        [{ text: 'OK' }]
      );
    }
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
      <Modal
        visible={showConfirmation}
        transparent
        animationType="fade"
        onRequestClose={() => setShowConfirmation(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Confirm SOS Alert</Text>
            <Text style={styles.modalText}>
              This will immediately alert all dispatchers and nearby responders.
              {'\n\n'}Your live location will be shared until you deactivate.
            </Text>
            <View style={styles.modalButtons}>
              <TouchableOpacity
                style={styles.cancelButton}
                onPress={() => setShowConfirmation(false)}
              >
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.confirmButton}
                onPress={handleConfirmSOS}
              >
                <Text style={styles.confirmButtonText}>SEND SOS</Text>
              </TouchableOpacity>
            </View>
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
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#EF4444',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#EF4444',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 8,
  },
  buttonActive: {
    backgroundColor: '#DC2626',
    shadowOpacity: 0.6,
  },
  buttonIcon: {
    fontSize: 28,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '800',
    fontSize: 14,
    marginTop: 2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 340,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#EF4444',
    textAlign: 'center',
    marginBottom: 12,
  },
  modalText: {
    fontSize: 15,
    color: '#374151',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 24,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  cancelButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#F3F4F6',
    alignItems: 'center',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#6B7280',
  },
  confirmButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#EF4444',
    alignItems: 'center',
  },
  confirmButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#fff',
  },
});
