import React, { useState, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { getApiBaseUrl } from '@/lib/server-url';

type Step = 'email' | 'code';

export default function ForgotPasswordScreen() {
  const router = useRouter();
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const codeRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);

  const handleRequestReset = async () => {
    setError('');
    if (!email.trim()) {
      setError('Veuillez entrer votre adresse email');
      return;
    }
    try {
      setIsLoading(true);
      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/auth/request-password-reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erreur lors de la demande');
      }
      setSuccessMessage('Un code de réinitialisation a été envoyé. Contactez votre administrateur ou dispatcher pour obtenir le code.');
      setStep('code');
    } catch (err: any) {
      setError(err.message || 'Erreur de connexion au serveur');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async () => {
    setError('');
    if (!code.trim()) {
      setError('Veuillez entrer le code de réinitialisation');
      return;
    }
    if (!newPassword.trim()) {
      setError('Veuillez entrer un nouveau mot de passe');
      return;
    }
    if (newPassword.length < 6) {
      setError('Le mot de passe doit contenir au moins 6 caractères');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Les mots de passe ne correspondent pas');
      return;
    }
    try {
      setIsLoading(true);
      const apiBase = getApiBaseUrl();
      const response = await fetch(`${apiBase}/auth/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim(), newPassword }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Erreur lors de la réinitialisation');
      }
      setSuccessMessage('Mot de passe réinitialisé avec succès !');
      // Navigate back to login after a short delay
      setTimeout(() => {
        router.replace('/login');
      }, 2000);
    } catch (err: any) {
      setError(err.message || 'Erreur de connexion au serveur');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView style={styles.scrollView} contentContainerStyle={styles.scrollContent}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.headerTitle}>TALION</Text>
            <Text style={styles.headerSubtitle}>CRISIS COMM</Text>
          </View>

          <View style={styles.content}>
            <Text style={styles.title}>
              {step === 'email' ? 'Mot de passe oublié' : 'Réinitialisation'}
            </Text>
            <Text style={styles.description}>
              {step === 'email'
                ? 'Entrez votre adresse email. Un code de réinitialisation sera généré et transmis à votre administrateur ou dispatcher.'
                : 'Entrez le code à 6 chiffres reçu de votre administrateur et votre nouveau mot de passe.'}
            </Text>

            {/* Success message */}
            {successMessage ? (
              <View style={styles.successBox}>
                <Text style={styles.successText}>{successMessage}</Text>
              </View>
            ) : null}

            {/* Error message */}
            {error ? (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {step === 'email' ? (
              /* Step 1: Enter email */
              <>
                <View style={styles.formGroup}>
                  <Text style={styles.label}>Adresse email</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="votre@email.com"
                    placeholderTextColor="#9ca3af"
                    value={email}
                    onChangeText={(t) => { setEmail(t); setError(''); }}
                    editable={!isLoading}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="done"
                    onSubmitEditing={handleRequestReset}
                  />
                </View>

                <TouchableOpacity
                  style={[styles.primaryButton, isLoading && styles.buttonDisabled]}
                  onPress={handleRequestReset}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Demander un code</Text>
                  )}
                </TouchableOpacity>
              </>
            ) : (
              /* Step 2: Enter code + new password */
              <>
                <View style={styles.formGroup}>
                  <Text style={styles.label}>Code de réinitialisation</Text>
                  <TextInput
                    ref={codeRef}
                    style={[styles.input, styles.codeInput]}
                    placeholder="000000"
                    placeholderTextColor="#9ca3af"
                    value={code}
                    onChangeText={(t) => {
                      // Only allow digits, max 6
                      const cleaned = t.replace(/\D/g, '').slice(0, 6);
                      setCode(cleaned);
                      setError('');
                    }}
                    editable={!isLoading}
                    keyboardType="number-pad"
                    maxLength={6}
                    returnKeyType="next"
                    onSubmitEditing={() => passwordRef.current?.focus()}
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.label}>Nouveau mot de passe</Text>
                  <TextInput
                    ref={passwordRef}
                    style={styles.input}
                    placeholder="Minimum 6 caractères"
                    placeholderTextColor="#9ca3af"
                    value={newPassword}
                    onChangeText={(t) => { setNewPassword(t); setError(''); }}
                    editable={!isLoading}
                    secureTextEntry
                    returnKeyType="next"
                    onSubmitEditing={() => confirmRef.current?.focus()}
                  />
                </View>

                <View style={styles.formGroup}>
                  <Text style={styles.label}>Confirmer le mot de passe</Text>
                  <TextInput
                    ref={confirmRef}
                    style={styles.input}
                    placeholder="Retapez le mot de passe"
                    placeholderTextColor="#9ca3af"
                    value={confirmPassword}
                    onChangeText={(t) => { setConfirmPassword(t); setError(''); }}
                    editable={!isLoading}
                    secureTextEntry
                    returnKeyType="done"
                    onSubmitEditing={handleResetPassword}
                  />
                </View>

                <TouchableOpacity
                  style={[styles.primaryButton, isLoading && styles.buttonDisabled]}
                  onPress={handleResetPassword}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <ActivityIndicator color="#ffffff" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Réinitialiser le mot de passe</Text>
                  )}
                </TouchableOpacity>

                {/* Back to email step */}
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={() => { setStep('email'); setError(''); setSuccessMessage(''); }}
                  disabled={isLoading}
                >
                  <Text style={styles.secondaryButtonText}>Renvoyer un code</Text>
                </TouchableOpacity>
              </>
            )}

            {/* Back to login */}
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => router.replace('/login')}
              disabled={isLoading}
            >
              <Text style={styles.backButtonText}>← Retour à la connexion</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
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
    paddingVertical: 28,
    paddingHorizontal: 20,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 4,
    lineHeight: 34,
  },
  headerSubtitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#94b8d4',
    letterSpacing: 3,
    marginTop: 2,
    lineHeight: 16,
  },
  content: {
    paddingHorizontal: 20,
    marginTop: 24,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1e3a5f',
    marginBottom: 8,
  },
  description: {
    fontSize: 14,
    color: '#6b7280',
    lineHeight: 20,
    marginBottom: 20,
  },
  successBox: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  successText: {
    color: '#16a34a',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 18,
  },
  errorBox: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  errorText: {
    color: '#dc2626',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
    lineHeight: 18,
  },
  formGroup: {
    marginBottom: 16,
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
  codeInput: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: 8,
    textAlign: 'center',
    paddingVertical: 16,
  },
  primaryButton: {
    backgroundColor: '#1e3a5f',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: {
    backgroundColor: '#94b8d4',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
  secondaryButton: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  secondaryButtonText: {
    color: '#1e3a5f',
    fontWeight: '600',
    fontSize: 14,
  },
  backButton: {
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  backButtonText: {
    color: '#6b7280',
    fontSize: 14,
    fontWeight: '500',
  },
});
