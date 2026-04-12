import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Modal,
  Animated,
  Alert,
} from 'react-native';

interface SOSAlertModalProps {
  visible: boolean;
  responderName: string;
  responderLocation: { latitude: number; longitude: number };
  responderPhone: string;
  timestamp: Date;
  onAcknowledge: () => void;
  onDismiss: () => void;
}

export function SOSAlertModal({
  visible,
  responderName,
  responderLocation,
  responderPhone,
  timestamp,
  onAcknowledge,
  onDismiss,
}: SOSAlertModalProps) {
  const [pulseAnim] = useState(new Animated.Value(1));
  const [countdownSeconds, setCountdownSeconds] = useState(0);

  useEffect(() => {
    if (visible) {
      // Pulse animation
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.05,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      ).start();

      // Start countdown
      setCountdownSeconds(0);
      const interval = setInterval(() => {
        setCountdownSeconds((prev) => prev + 1);
      }, 1000);

      return () => clearInterval(interval);
    }
  }, [visible, pulseAnim]);

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const formatLocation = (lat: number, lon: number) => {
    return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onDismiss}
    >
      <View style={styles.overlay}>
        <Animated.View
          style={[
            styles.alertContainer,
            {
              transform: [{ scale: pulseAnim }],
            },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerIcon}>🚨</Text>
            <Text style={styles.headerTitle}>ALERTE SOS</Text>
            <Text style={styles.countdownBadge}>{countdownSeconds}s</Text>
          </View>

          {/* Responder Info */}
          <View style={styles.responderInfo}>
            <View style={styles.responderRow}>
              <Text style={styles.label}>Intervenant:</Text>
              <Text style={styles.value}>{responderName}</Text>
            </View>

            <View style={styles.responderRow}>
              <Text style={styles.label}>Téléphone:</Text>
              <TouchableOpacity>
                <Text style={[styles.value, styles.phoneLink]}>{responderPhone}</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.responderRow}>
              <Text style={styles.label}>Position:</Text>
              <TouchableOpacity>
                <Text style={[styles.value, styles.locationLink]}>
                  📍 {formatLocation(responderLocation.latitude, responderLocation.longitude)}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.responderRow}>
              <Text style={styles.label}>Heure:</Text>
              <Text style={styles.value}>{formatTime(timestamp)}</Text>
            </View>
          </View>

          {/* Live Location Indicator */}
          <View style={styles.liveLocationBox}>
            <View style={styles.liveDot} />
            <Text style={styles.liveLocationText}>
              Localisation en direct activée
            </Text>
          </View>

          {/* Action Buttons */}
          <View style={styles.buttonContainer}>
            <TouchableOpacity
              style={styles.dismissButton}
              onPress={onDismiss}
            >
              <Text style={styles.dismissButtonText}>Garder l'alerte</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.acknowledgeButton}
              onPress={onAcknowledge}
            >
              <Text style={styles.acknowledgeButtonText}>Quittancer</Text>
            </TouchableOpacity>
          </View>

          {/* Instructions */}
          <View style={styles.instructions}>
            <Text style={styles.instructionsTitle}>Actions recommandées:</Text>
            <Text style={styles.instructionItem}>
              • Mobiliser les ressources d'urgence
            </Text>
            <Text style={styles.instructionItem}>
              • Contacter l'intervenant au numéro fourni
            </Text>
            <Text style={styles.instructionItem}>
              • Envoyer une ambulance/pompiers si nécessaire
            </Text>
            <Text style={styles.instructionItem}>
              • Suivre la localisation en temps réel
            </Text>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  alertContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    width: '100%',
    maxWidth: 500,
    borderWidth: 2,
    borderColor: '#ef4444',
    shadowColor: '#ef4444',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    paddingBottom: 16,
    borderBottomWidth: 2,
    borderBottomColor: '#fee2e2',
  },
  headerIcon: {
    fontSize: 32,
    marginRight: 12,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#dc2626',
    flex: 1,
  },
  countdownBadge: {
    backgroundColor: '#fbbf24',
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  responderInfo: {
    backgroundColor: '#f9fafb',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#ef4444',
  },
  responderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#6b7280',
    flex: 0.4,
  },
  value: {
    fontSize: 13,
    fontWeight: '500',
    color: '#1f2937',
    flex: 0.6,
    textAlign: 'right',
  },
  phoneLink: {
    color: '#3b82f6',
    textDecorationLine: 'underline',
  },
  locationLink: {
    color: '#3b82f6',
    textDecorationLine: 'underline',
  },
  liveLocationBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fef3c7',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#f59e0b',
  },
  liveDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#ef4444',
    marginRight: 8,
  },
  liveLocationText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#92400e',
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  dismissButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#e5e7eb',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d1d5db',
  },
  dismissButtonText: {
    color: '#374151',
    fontWeight: '600',
    fontSize: 14,
  },
  acknowledgeButton: {
    flex: 1,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#10b981',
    alignItems: 'center',
  },
  acknowledgeButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 14,
  },
  instructions: {
    backgroundColor: '#f0fdf4',
    borderRadius: 12,
    padding: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#10b981',
  },
  instructionsTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#15803d',
    marginBottom: 8,
  },
  instructionItem: {
    fontSize: 12,
    color: '#166534',
    marginBottom: 4,
    lineHeight: 16,
  },
});
