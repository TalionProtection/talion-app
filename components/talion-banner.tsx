import { StyleSheet, View, Text, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

interface TalionBannerProps {
  /** Optional status indicator text (e.g., "Online", "On Duty") */
  statusText?: string;
  /** Color for the status dot */
  statusColor?: string;
  /** Whether to show the status indicator */
  showStatus?: boolean;
  /** Optional right-side content (replaces status indicator) */
  rightContent?: React.ReactNode;
}

/**
 * Reusable Talion branded banner component.
 * Displays the Talion logo, app name, and optional status indicator.
 * Wraps content in SafeAreaView for proper notch handling.
 */
export function TalionBanner({
  statusText = 'Online',
  statusColor = '#22c55e',
  showStatus = true,
  rightContent,
}: TalionBannerProps) {
  return (
    <View style={styles.banner}>
      <Image
        source={require('@/assets/images/icon.png')}
        style={styles.bannerLogo}
        resizeMode="contain"
      />
      <View style={styles.bannerTextContainer}>
        <Text style={styles.bannerTitle}>TALION</Text>
        <Text style={styles.bannerSubtitle}>CRISIS COMM</Text>
      </View>
      {rightContent ? (
        rightContent
      ) : showStatus ? (
        <View style={styles.bannerStatusContainer}>
          <View style={[styles.bannerStatusDot, { backgroundColor: statusColor }]} />
          <Text style={styles.bannerStatusText}>{statusText}</Text>
        </View>
      ) : null}
    </View>
  );
}

/**
 * Screen wrapper that includes the Talion banner with SafeAreaView.
 * Use this to wrap screen content for consistent branding.
 */
export function TalionScreen({
  children,
  statusText,
  statusColor,
  showStatus = true,
  rightContent,
}: TalionBannerProps & { children: React.ReactNode }) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right']}>
      <TalionBanner
        statusText={statusText}
        statusColor={statusColor}
        showStatus={showStatus}
        rightContent={rightContent}
      />
      <View style={styles.content}>{children}</View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#1e3a5f',
  },
  banner: {
    backgroundColor: '#1e3a5f',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  bannerLogo: {
    width: 40,
    height: 40,
    borderRadius: 8,
  },
  bannerTextContainer: {
    marginLeft: 12,
    flex: 1,
  },
  bannerTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 2,
    lineHeight: 22,
  },
  bannerSubtitle: {
    color: '#94b8d4',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.5,
    lineHeight: 14,
  },
  bannerStatusContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  bannerStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 6,
  },
  bannerStatusText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  content: {
    flex: 1,
    backgroundColor: '#f0f2f5',
  },
});
