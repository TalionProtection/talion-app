import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { View, Text, ActivityIndicator } from 'react-native';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { AuthProvider } from '@/lib/auth-context';
import { PTTProvider } from '@/lib/ptt-context';
import { NotificationProvider } from '@/lib/notification-context';
import { LocationProvider } from '@/lib/location-context';
import { MessagingProvider } from '@/lib/messaging-context';
import { WebSocketProvider } from '@/lib/websocket-provider';
import { useAuth } from '@/hooks/useAuth';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import React, { useEffect } from 'react';

function RootLayoutContent() {
  const colorScheme = useColorScheme();
  const { isSignedIn, isLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;

    const inAuthGroup = segments[0] === 'login';

    if (!isSignedIn && !inAuthGroup) {
      // Not signed in and not on login screen → redirect to login
      router.replace('/login');
    } else if (isSignedIn && inAuthGroup) {
      // Signed in but still on login screen → redirect to tabs
      router.replace('/(tabs)');
    }
  }, [isSignedIn, isLoading, segments]);

  if (isLoading) {
    // Show loading screen instead of blank screen
    return (
      <View style={{ flex: 1, backgroundColor: '#1e3a5f', alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator size="large" color="#ffffff" />
        <Text style={{ color: '#ffffff', marginTop: 16, fontSize: 16 }}>Connexion...</Text>
      </View>
    );
  }

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerShown: false,
        }}
      >
        <Stack.Screen name="login" />
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
      </Stack>
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}

/**
 * Inner wrapper that has access to auth context to pass role/duty to LocationProvider.
 */
function AuthAwareProviders({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const userRole = user?.role;

  // Register push token for ALL users to receive broadcast + SOS notifications
  usePushNotifications();
  // Responders are "on duty" when their status is 'available' or 'on_mission'
  const isOnDuty = userRole === 'responder'
    ? (user?.status === 'available' || user?.status === 'on_mission')
    : userRole === 'dispatcher'; // dispatchers are always tracked

  return (
    <WebSocketProvider>
      <LocationProvider userRole={userRole} isOnDuty={isOnDuty}>
        <NotificationProvider>
          <MessagingProvider>
            <PTTProvider>
              {children}
            </PTTProvider>
          </MessagingProvider>
        </NotificationProvider>
      </LocationProvider>
    </WebSocketProvider>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AuthAwareProviders>
        <RootLayoutContent />
      </AuthAwareProviders>
    </AuthProvider>
  );
}
