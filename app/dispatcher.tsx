import React, { useState, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useAlerts, type ServerAlert } from '@/hooks/useAlerts';
import { SOSAlertModal } from '@/components/sos-alert-modal';

interface DisplayAlert {
  id: string;
  responderName: string;
  responderPhone: string;
  type: string;
  severity: string;
  location: { latitude: number; longitude: number; address?: string };
  description: string;
  timestamp: Date;
  acknowledged: boolean;
}

function serverAlertToDisplay(alert: ServerAlert): DisplayAlert {
  return {
    id: alert.id,
    responderName: alert.createdBy || 'Unknown',
    responderPhone: '',
    type: alert.type,
    severity: alert.severity,
    location: {
      latitude: alert.location?.latitude ?? 0,
      longitude: alert.location?.longitude ?? 0,
      address: alert.location?.address,
    },
    description: alert.description || '',
    timestamp: new Date(alert.createdAt),
    acknowledged: alert.status === 'acknowledged' || alert.status === 'resolved',
  };
}

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#ef4444',
  high: '#f59e0b',
  medium: '#3b82f6',
  low: '#6b7280',
};

const TYPE_ICONS: Record<string, string> = {
  sos: '🆘',
  medical: '🏥',
  fire: '🔥',
  security: '🔒',
  hazard: '⚠️',
  accident: '🚗',
  other: '⚠️',
};

export default function DispatcherScreen() {
  const { alerts: serverAlerts, isLoading, error, refresh } = useAlerts({ pollInterval: 5000, userRole: 'dispatcher', playSounds: true });
  const [selectedAlert, setSelectedAlert] = useState<DisplayAlert | null>(null);
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [localAcknowledged, setLocalAcknowledged] = useState<Set<string>>(new Set());

  const displayAlerts = useMemo(() => {
    return serverAlerts.map((a) => {
      const display = serverAlertToDisplay(a);
      if (localAcknowledged.has(a.id)) {
        display.acknowledged = true;
      }
      return display;
    });
  }, [serverAlerts, localAcknowledged]);

  const unacknowledgedAlerts = displayAlerts.filter((a) => !a.acknowledged);
  const acknowledgedAlerts = displayAlerts.filter((a) => a.acknowledged);

  const handleAcknowledge = () => {
    if (selectedAlert) {
      setLocalAcknowledged((prev) => new Set(prev).add(selectedAlert.id));
      setShowAlertModal(false);
      setSelectedAlert(null);
    }
  };

  const handleDismiss = () => {
    setShowAlertModal(false);
  };

  const renderAlertCard = (alert: DisplayAlert, isAcknowledged: boolean) => (
    <TouchableOpacity
      key={alert.id}
      style={[
        styles.alertCard,
        { borderLeftColor: isAcknowledged ? '#10b981' : (SEVERITY_COLORS[alert.severity] || '#ef4444') },
        isAcknowledged && styles.alertCardAcknowledged,
      ]}
      onPress={() => {
        setSelectedAlert(alert);
        setShowAlertModal(true);
      }}
    >
      <View style={styles.alertCardHeader}>
        <Text style={styles.alertCardIcon}>
          {isAcknowledged ? '✓' : (TYPE_ICONS[alert.type] || '🚨')}
        </Text>
        <View style={styles.alertCardTitle}>
          <Text style={styles.alertCardName}>
            {alert.type.toUpperCase()} — {alert.responderName}
          </Text>
          <Text style={styles.alertCardTime}>
            {alert.timestamp.toLocaleTimeString('fr-FR', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </View>
        {!isAcknowledged && (
          <View style={[styles.severityBadge, { backgroundColor: SEVERITY_COLORS[alert.severity] || '#ef4444' }]}>
            <Text style={styles.severityText}>{alert.severity.toUpperCase()}</Text>
          </View>
        )}
      </View>

      <View style={styles.alertCardDetails}>
        {alert.description ? (
          <Text style={styles.detailLabel} numberOfLines={2}>📝 {alert.description}</Text>
        ) : null}
        {alert.location.address ? (
          <Text style={styles.detailLabel}>📍 {alert.location.address}</Text>
        ) : (
          <Text style={styles.detailLabel}>
            📍 {alert.location.latitude.toFixed(4)}, {alert.location.longitude.toFixed(4)}
          </Text>
        )}
      </View>

      {!isAcknowledged && (
        <View style={styles.alertCardFooter}>
          <Text style={styles.alertCardStatus}>En attente de quittance</Text>
        </View>
      )}
      {isAcknowledged && (
        <View style={styles.alertCardFooterAcknowledged}>
          <Text style={styles.alertCardStatusAcknowledged}>Quittancée</Text>
        </View>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Centre de Répartition</Text>
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.refreshButton} onPress={refresh}>
            <Text style={styles.refreshButtonText}>🔄</Text>
          </TouchableOpacity>
          <View style={styles.alertCounter}>
            <Text style={styles.alertCounterText}>
              {unacknowledgedAlerts.length} SOS actif
              {unacknowledgedAlerts.length > 1 ? 's' : ''}
            </Text>
          </View>
        </View>
      </View>

      {error && (
        <TouchableOpacity style={styles.errorBanner} onPress={refresh}>
          <Text style={styles.errorBannerText}>Impossible de contacter le serveur. Appuyez pour réessayer.</Text>
        </TouchableOpacity>
      )}

      {isLoading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#1e3a5f" />
          <Text style={styles.loadingText}>Chargement des alertes...</Text>
        </View>
      ) : (
        <ScrollView style={styles.content}>
          {unacknowledgedAlerts.length > 0 && (
            <View>
              <Text style={styles.sectionTitle}>Alertes en attente</Text>
              {unacknowledgedAlerts.map((alert) =>
                renderAlertCard(alert, false)
              )}
            </View>
          )}

          {acknowledgedAlerts.length > 0 && (
            <View style={styles.acknowledgedSection}>
              <Text style={styles.sectionTitle}>Alertes quittancées</Text>
              {acknowledgedAlerts.map((alert) =>
                renderAlertCard(alert, true)
              )}
            </View>
          )}

          {displayAlerts.length === 0 && (
            <View style={styles.emptyState}>
              <Text style={styles.emptyStateIcon}>✓</Text>
              <Text style={styles.emptyStateTitle}>Aucune alerte</Text>
              <Text style={styles.emptyStateText}>
                Tous les intervenants sont en sécurité
              </Text>
            </View>
          )}
        </ScrollView>
      )}

      {selectedAlert && (
        <SOSAlertModal
          visible={showAlertModal}
          responderName={selectedAlert.responderName}
          responderLocation={selectedAlert.location}
          responderPhone={selectedAlert.responderPhone}
          timestamp={selectedAlert.timestamp}
          onAcknowledge={handleAcknowledge}
          onDismiss={handleDismiss}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f9fafb',
  },
  header: {
    backgroundColor: '#ffffff',
    paddingHorizontal: 16,
    paddingVertical: 16,
    paddingTop: Platform.OS === 'android' ? 40 : 56,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1f2937',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  refreshButton: {
    padding: 6,
  },
  refreshButtonText: {
    fontSize: 20,
  },
  alertCounter: {
    backgroundColor: '#fee2e2',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
  },
  alertCounterText: {
    color: '#dc2626',
    fontWeight: '600',
    fontSize: 13,
  },
  errorBanner: {
    backgroundColor: '#fef2f2',
    padding: 12,
    marginHorizontal: 16,
    marginTop: 12,
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#ef4444',
  },
  errorBannerText: {
    color: '#991b1b',
    fontSize: 13,
    fontWeight: '500',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  loadingText: {
    marginTop: 12,
    color: '#6b7280',
    fontSize: 14,
  },
  content: {
    flex: 1,
    padding: 16,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 12,
    marginTop: 16,
  },
  alertCard: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderLeftWidth: 4,
    borderLeftColor: '#ef4444',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  alertCardAcknowledged: {
    borderLeftColor: '#10b981',
    opacity: 0.7,
  },
  alertCardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  alertCardIcon: {
    fontSize: 24,
    marginRight: 12,
  },
  alertCardTitle: {
    flex: 1,
  },
  alertCardName: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1f2937',
  },
  alertCardTime: {
    fontSize: 12,
    color: '#9ca3af',
    marginTop: 2,
  },
  severityBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  severityText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 10,
  },
  alertCardDetails: {
    backgroundColor: '#f9fafb',
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  detailLabel: {
    fontSize: 13,
    color: '#6b7280',
    marginBottom: 6,
    fontWeight: '500',
  },
  alertCardFooter: {
    backgroundColor: '#fef3c7',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#f59e0b',
  },
  alertCardStatus: {
    fontSize: 12,
    fontWeight: '600',
    color: '#92400e',
  },
  alertCardFooterAcknowledged: {
    backgroundColor: '#f0fdf4',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#10b981',
  },
  alertCardStatusAcknowledged: {
    fontSize: 12,
    fontWeight: '600',
    color: '#166534',
  },
  acknowledgedSection: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
  },
  emptyStateIcon: {
    fontSize: 48,
    marginBottom: 16,
  },
  emptyStateTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1f2937',
    marginBottom: 8,
  },
  emptyStateText: {
    fontSize: 14,
    color: '#9ca3af',
  },
});
