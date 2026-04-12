/**
 * Offline Banner Component
 * 
 * Shows a banner when the app is offline, with sync status info.
 * Also shows a brief "back online" message when connectivity is restored.
 */

import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, TouchableOpacity } from 'react-native';
import { useOffline } from '@/hooks/use-offline';

interface OfflineBannerProps {
  /** Show detailed sync info when expanded */
  showDetails?: boolean;
}

export function OfflineBanner({ showDetails = false }: OfflineBannerProps) {
  const { isOnline, queuedActions, lastSync } = useOffline();
  const [expanded, setExpanded] = useState(false);
  const [showBackOnline, setShowBackOnline] = useState(false);
  const wasOfflineRef = useRef(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Track online/offline transitions
  useEffect(() => {
    if (!isOnline) {
      wasOfflineRef.current = true;
      fadeAnim.setValue(1);
    } else if (wasOfflineRef.current) {
      // Just came back online
      wasOfflineRef.current = false;
      setShowBackOnline(true);
      fadeAnim.setValue(1);
      // Fade out after 3 seconds
      const timer = setTimeout(() => {
        Animated.timing(fadeAnim, {
          toValue: 0,
          duration: 500,
          useNativeDriver: true,
        }).start(() => setShowBackOnline(false));
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [isOnline, fadeAnim]);

  // Don't render anything if online and no "back online" message
  if (isOnline && !showBackOnline) return null;

  // "Back online" brief message
  if (isOnline && showBackOnline) {
    return (
      <Animated.View style={[styles.banner, styles.bannerOnline, { opacity: fadeAnim }]}>
        <Text style={styles.onlineText}>Back online</Text>
        {queuedActions > 0 && (
          <Text style={styles.queueText}>Syncing {queuedActions} pending action{queuedActions > 1 ? 's' : ''}...</Text>
        )}
      </Animated.View>
    );
  }

  // Offline banner
  return (
    <Animated.View style={[styles.banner, styles.bannerOffline, { opacity: fadeAnim }]}>
      <TouchableOpacity
        style={styles.bannerContent}
        onPress={() => showDetails && setExpanded(!expanded)}
        activeOpacity={showDetails ? 0.7 : 1}
      >
        <View style={styles.mainRow}>
          <View style={styles.offlineDot} />
          <Text style={styles.offlineText}>Offline Mode</Text>
          {queuedActions > 0 && (
            <View style={styles.queueBadge}>
              <Text style={styles.queueBadgeText}>{queuedActions}</Text>
            </View>
          )}
          {showDetails && (
            <Text style={styles.expandIcon}>{expanded ? '▲' : '▼'}</Text>
          )}
        </View>
        <Text style={styles.offlineSubtext}>
          Using cached data{queuedActions > 0 ? ` · ${queuedActions} pending` : ''}
        </Text>
      </TouchableOpacity>

      {expanded && showDetails && (
        <View style={styles.detailsContainer}>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Alerts</Text>
            <Text style={styles.detailValue}>{lastSync.alerts}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Users</Text>
            <Text style={styles.detailValue}>{lastSync.users}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Geofences</Text>
            <Text style={styles.detailValue}>{lastSync.geofences}</Text>
          </View>
          <View style={styles.detailRow}>
            <Text style={styles.detailLabel}>Messages</Text>
            <Text style={styles.detailValue}>{lastSync.messages}</Text>
          </View>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: 1,
  },
  bannerOffline: {
    backgroundColor: '#fef3c7',
    borderBottomColor: '#f59e0b',
  },
  bannerOnline: {
    backgroundColor: '#d1fae5',
    borderBottomColor: '#10b981',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  bannerContent: {},
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  offlineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#f59e0b',
  },
  offlineText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#92400e',
  },
  offlineSubtext: {
    fontSize: 11,
    color: '#a16207',
    marginTop: 2,
    marginLeft: 16,
  },
  onlineText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#065f46',
  },
  queueText: {
    fontSize: 11,
    color: '#047857',
  },
  queueBadge: {
    backgroundColor: '#f59e0b',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 1,
    minWidth: 18,
    alignItems: 'center',
  },
  queueBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ffffff',
  },
  expandIcon: {
    fontSize: 10,
    color: '#92400e',
    marginLeft: 'auto',
  },
  detailsContainer: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#fcd34d',
  },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 3,
  },
  detailLabel: {
    fontSize: 12,
    color: '#92400e',
    fontWeight: '500',
  },
  detailValue: {
    fontSize: 12,
    color: '#a16207',
  },
});

export default OfflineBanner;
