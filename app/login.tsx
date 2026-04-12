import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  ActivityIndicator,
  ScrollView,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '@/hooks/useAuth';

export default function LoginScreen() {
  const router = useRouter();
  const { login, isLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  const handleLogin = async () => {
    setLoginError('');
    if (!email.trim() || !password.trim()) {
      setLoginError('Veuillez remplir tous les champs');
      return;
    }
    try {
      await login(email.trim(), password);
      router.replace('/(tabs)');
    } catch (error: any) {
      const msg = error?.message || 'Identifiants incorrects';
      setLoginError(msg);
    }
  };

  const handleQuickLogin = async (role: 'user' | 'responder' | 'dispatcher' | 'admin') => {
    setLoginError('');
    const credentials: Record<string, { email: string; password: string }> = {
      user: { email: 'thomas@example.com', password: 'talion2026' },
      responder: { email: 'responder@talion.io', password: 'talion2026' },
      dispatcher: { email: 'dispatch@talion.io', password: 'talion2026' },
      admin: { email: 'admin@talion.io', password: 'talion2026' },
    };
    const cred = credentials[role];
    try {
      await login(cred.email, cred.password);
      router.replace('/(tabs)');
    } catch (error: any) {
      setLoginError(error?.message || 'Connexion échouée');
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
        {/* Talion Header */}
        <View style={styles.header}>
          <Image
            source={require('@/assets/images/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>TALION</Text>
          <Text style={styles.subtitle}>CRISIS COMM</Text>
          <Text style={styles.tagline}>Système d'Alerte et de Réponse d'Urgence</Text>
        </View>

        {/* Login Form */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connexion</Text>

          {loginError ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{loginError}</Text>
            </View>
          ) : null}

          <View style={styles.formGroup}>
            <Text style={styles.label}>Email</Text>
            <TextInput
              style={styles.input}
              placeholder="Entrez votre email"
              placeholderTextColor="#9ca3af"
              value={email}
              onChangeText={(t) => { setEmail(t); setLoginError(''); }}
              editable={!isLoading}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="next"
            />
          </View>

          <View style={styles.formGroup}>
            <Text style={styles.label}>Mot de passe</Text>
            <TextInput
              style={styles.input}
              placeholder="Entrez votre mot de passe"
              placeholderTextColor="#9ca3af"
              value={password}
              onChangeText={(t) => { setPassword(t); setLoginError(''); }}
              editable={!isLoading}
              secureTextEntry
              returnKeyType="done"
              onSubmitEditing={handleLogin}
            />
          </View>

          <TouchableOpacity
            style={[styles.loginButton, isLoading && styles.loginButtonDisabled]}
            onPress={handleLogin}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.loginButtonText}>Se connecter</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.forgotPasswordButton}
            onPress={() => router.push('/forgot-password')}
            disabled={isLoading}
          >
            <Text style={styles.forgotPasswordText}>Mot de passe oublié ?</Text>
          </TouchableOpacity>
        </View>

        {/* Divider */}
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>DEMO</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Quick Login Buttons */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Connexion rapide (Démo)</Text>
          <TouchableOpacity
            style={[styles.quickLoginButton, styles.userButton]}
            onPress={() => handleQuickLogin('user')}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <>
                <Text style={styles.quickLoginIcon}>👤</Text>
                <View>
                  <Text style={styles.quickLoginText}>Thomas Leroy</Text>
                  <Text style={styles.quickLoginSub}>Utilisateur</Text>
                </View>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickLoginButton, styles.responderButton]}
            onPress={() => handleQuickLogin('responder')}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <>
                <Text style={styles.quickLoginIcon}>🚒</Text>
                <View>
                  <Text style={styles.quickLoginText}>Pierre Martin</Text>
                  <Text style={styles.quickLoginSub}>Intervenant</Text>
                </View>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickLoginButton, styles.dispatcherButton]}
            onPress={() => handleQuickLogin('dispatcher')}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <>
                <Text style={styles.quickLoginIcon}>📡</Text>
                <View>
                  <Text style={styles.quickLoginText}>Jean Moreau</Text>
                  <Text style={styles.quickLoginSub}>Dispatcher</Text>
                </View>
              </>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.quickLoginButton, styles.adminButton]}
            onPress={() => handleQuickLogin('admin')}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <>
                <Text style={styles.quickLoginIcon}>🔑</Text>
                <View>
                  <Text style={styles.quickLoginText}>Marie Dupont</Text>
                  <Text style={styles.quickLoginSub}>Administratrice</Text>
                </View>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Demo Credentials */}
        <View style={[styles.section, { marginBottom: 30 }]}>
          <Text style={styles.sectionTitle}>Identifiants de démo</Text>
          <View style={styles.credentialsBox}>
            <View style={styles.credentialItem}>
              <Text style={styles.credentialLabel}>Mot de passe :</Text>
              <Text style={styles.credentialValue}>talion2026 (pour tous)</Text>
            </View>
            <View style={styles.credentialDivider} />
            <View style={styles.credentialItem}>
              <Text style={styles.credentialLabel}>Admin :</Text>
              <Text style={styles.credentialValue}>admin@talion.io</Text>
            </View>
            <View style={styles.credentialDivider} />
            <View style={styles.credentialItem}>
              <Text style={styles.credentialLabel}>Dispatcher :</Text>
              <Text style={styles.credentialValue}>dispatch@talion.io</Text>
            </View>
            <View style={styles.credentialDivider} />
            <View style={styles.credentialItem}>
              <Text style={styles.credentialLabel}>Intervenant :</Text>
              <Text style={styles.credentialValue}>responder@talion.io</Text>
            </View>
            <View style={styles.credentialDivider} />
            <View style={styles.credentialItem}>
              <Text style={styles.credentialLabel}>Utilisateur :</Text>
              <Text style={styles.credentialValue}>thomas@example.com</Text>
            </View>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#1e3a5f',
  },
  scrollView: {
    flex: 1,
    backgroundColor: '#f0f2f5',
  },
  scrollContent: {
    paddingBottom: 40,
  },
  header: {
    alignItems: 'center',
    backgroundColor: '#1e3a5f',
    paddingVertical: 32,
    paddingHorizontal: 20,
  },
  logo: {
    width: 80,
    height: 80,
    borderRadius: 16,
    marginBottom: 16,
  },
  title: {
    fontSize: 32,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 4,
    lineHeight: 38,
  },
  subtitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#94b8d4',
    letterSpacing: 3,
    marginTop: 2,
    lineHeight: 18,
  },
  tagline: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.6)',
    marginTop: 12,
  },
  section: {
    paddingHorizontal: 20,
    marginTop: 20,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1e3a5f',
    marginBottom: 12,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 10,
    padding: 12,
    marginBottom: 14,
  },
  errorText: {
    color: '#dc2626',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  quickLoginButton: {
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 10,
    flexDirection: 'row',
    gap: 12,
  },
  userButton: {
    backgroundColor: '#8b5cf6',
  },
  responderButton: {
    backgroundColor: '#22c55e',
  },
  dispatcherButton: {
    backgroundColor: '#1e3a5f',
  },
  adminButton: {
    backgroundColor: '#d97706',
  },
  quickLoginIcon: {
    fontSize: 22,
  },
  quickLoginText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 15,
  },
  quickLoginSub: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontWeight: '400',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 20,
    paddingHorizontal: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#d1d5db',
  },
  dividerText: {
    marginHorizontal: 12,
    color: '#9ca3af',
    fontWeight: '600',
    fontSize: 12,
  },
  formGroup: {
    marginBottom: 14,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 6,
  },
  input: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 14,
    color: '#1f2937',
  },
  loginButton: {
    backgroundColor: '#1e3a5f',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  loginButtonDisabled: {
    backgroundColor: '#94b8d4',
  },
  loginButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
  forgotPasswordButton: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  forgotPasswordText: {
    color: '#1e3a5f',
    fontSize: 14,
    fontWeight: '500',
  },
  credentialsBox: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  credentialItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  credentialDivider: {
    height: 1,
    backgroundColor: '#f3f4f6',
    marginVertical: 8,
  },
  credentialLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1e3a5f',
    width: 90,
  },
  credentialValue: {
    fontSize: 12,
    color: '#6b7280',
    flex: 1,
  },
});
