import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  Pressable,
  Alert,
  ActivityIndicator,
  StyleSheet,
  Platform,
  Image,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '@/hooks/useAuth';
import { useActiveSOSAlert } from '@/hooks/useActiveSOSAlert';
import { usePTT } from '@/lib/ptt-context';
import { IconSymbol } from '@/components/ui/icon-symbol';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';

const ROLE_LABELS: Record<string, string> = {
  user: 'Utilisateur',
  responder: 'Intervenant',
  dispatcher: 'Dispatcher',
  admin: 'Administrateur',
};

export default function ProfileScreen() {
  const { user, logout, updateProfile } = useAuth();
  const router = useRouter();
  const { activeAlert } = useActiveSOSAlert(user?.id);
  const { selectChannel, state: pttState } = usePTT();

  const [firstName, setFirstName] = useState(user?.firstName || '');
  const [lastName, setLastName] = useState(user?.lastName || '');
  const [phoneMobile, setPhoneMobile] = useState(user?.phoneMobile || user?.phone || '');
  const [photoUri, setPhotoUri] = useState(user?.avatar || '');
  const [isSaving, setIsSaving] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const markChanged = useCallback(() => setHasChanges(true), []);

  const handlePickPhoto = async () => {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission requise', 'Veuillez autoriser l\'accès à la galerie photo.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.7,
      });
      if (!result.canceled && result.assets[0]) {
        setPhotoUri(result.assets[0].uri);
        markChanged();
      }
    } catch (error) {
      console.error('Image picker error:', error);
    }
  };

  const handleSave = async () => {
    if (!user) return;
    if (!firstName.trim() || !lastName.trim()) {
      Alert.alert('Erreur', 'Le prénom et le nom sont obligatoires.');
      return;
    }

    setIsSaving(true);
    try {
      await updateProfile({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        phoneMobile: phoneMobile.trim(),
        ...(photoUri && !photoUri.startsWith('file://') && !photoUri.startsWith('ph://') ? { photoUrl: photoUri } : {}),
      });

      if (Platform.OS !== 'web') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setIsEditing(false);
      setHasChanges(false);
      Alert.alert('Succès', 'Votre profil a été mis à jour.');
    } catch (error) {
      Alert.alert('Erreur', 'Impossible de mettre à jour le profil. Veuillez réessayer.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setFirstName(user?.firstName || '');
    setLastName(user?.lastName || '');
    setPhoneMobile(user?.phoneMobile || user?.phone || '');
    setPhotoUri(user?.avatar || '');
    setIsEditing(false);
    setHasChanges(false);
  };

  const handleLogout = () => {
    Alert.alert(
      'Déconnexion',
      'Voulez-vous vraiment vous déconnecter ?',
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Déconnexion',
          style: 'destructive',
          onPress: async () => {
            if (Platform.OS !== 'web') {
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
            }
            await logout();
          },
        },
      ]
    );
  };

  const handleGoToPTT = useCallback(() => {
    // Navigate to the PTT tab and auto-select the emergency channel
    const emergencyChannel = pttState.channels.find(ch => ch.id === 'emergency');
    if (emergencyChannel) {
      selectChannel(emergencyChannel);
    }
    if (Platform.OS !== 'web') {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    router.push('/(tabs)/ptt');
  }, [pttState.channels, selectChannel, router]);

  if (!user) {
    return (
      <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color="#1e3a5f" />
        </View>
      </SafeAreaView>
    );
  }

  const initials = `${(user.firstName || user.name || '?')[0]}${(user.lastName || '')[0] || ''}`.toUpperCase();

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.headerTitle}>Mon Profil</Text>
          {!isEditing ? (
            <Pressable
              onPress={() => setIsEditing(true)}
              style={({ pressed }) => [styles.editButton, pressed && { opacity: 0.7 }]}
            >
              <IconSymbol name="pencil" size={18} color="#1e3a5f" />
              <Text style={styles.editButtonText}>Modifier</Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={handleCancel}
              style={({ pressed }) => [styles.cancelButton, pressed && { opacity: 0.7 }]}
            >
              <Text style={styles.cancelButtonText}>Annuler</Text>
            </Pressable>
          )}
        </View>

        {/* SOS Active Alert Banner + PTT Button */}
        {activeAlert && (
          <View style={styles.sosAlertBanner}>
            <View style={styles.sosAlertHeader}>
              <View style={styles.sosAlertPulse} />
              <MaterialIcons name="warning" size={22} color="#ffffff" />
              <View style={styles.sosAlertInfo}>
                <Text style={styles.sosAlertTitle}>ALERTE SOS ACTIVE</Text>
                <Text style={styles.sosAlertDesc} numberOfLines={1}>
                  {activeAlert.description || 'Alerte en cours...'}
                </Text>
                <Text style={styles.sosAlertLocation} numberOfLines={1}>
                  {activeAlert.location?.address || 'Position inconnue'}
                </Text>
              </View>
            </View>

            <View style={styles.sosAlertActions}>
              <Pressable
                onPress={handleGoToPTT}
                style={({ pressed }) => [
                  styles.sosPTTButton,
                  pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] },
                ]}
              >
                <MaterialIcons name="mic" size={20} color="#ffffff" />
                <Text style={styles.sosPTTButtonText}>Communication PTT</Text>
                <MaterialIcons name="chevron-right" size={18} color="rgba(255,255,255,0.7)" />
              </Pressable>
              <Text style={styles.sosPTTHint}>
                Appuyez pour communiquer avec les intervenants via le canal d'urgence
              </Text>
            </View>
          </View>
        )}

        {/* Avatar Section */}
        <View style={styles.avatarSection}>
          <Pressable
            onPress={isEditing ? handlePickPhoto : undefined}
            style={({ pressed }) => [
              styles.avatarContainer,
              isEditing && pressed && { opacity: 0.7 },
            ]}
          >
            {photoUri ? (
              <Image source={{ uri: photoUri }} style={styles.avatar} />
            ) : (
              <View style={styles.avatarPlaceholder}>
                <Text style={styles.avatarInitials}>{initials}</Text>
              </View>
            )}
            {isEditing && (
              <View style={styles.cameraOverlay}>
                <IconSymbol name="camera.fill" size={20} color="#ffffff" />
              </View>
            )}
          </Pressable>
          {!isEditing && (
            <>
              <Text style={styles.displayName}>{user.name}</Text>
              <View style={styles.roleBadge}>
                <Text style={styles.roleBadgeText}>{ROLE_LABELS[user.role] || user.role}</Text>
              </View>
            </>
          )}
        </View>

        {/* Form Fields */}
        <View style={styles.formSection}>
          <Text style={styles.sectionTitle}>Informations personnelles</Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Prénom</Text>
            {isEditing ? (
              <TextInput
                style={styles.input}
                value={firstName}
                onChangeText={(t) => { setFirstName(t); markChanged(); }}
                placeholder="Votre prénom"
                placeholderTextColor="#9ca3af"
                returnKeyType="next"
              />
            ) : (
              <Text style={styles.fieldValue}>{user.firstName || '-'}</Text>
            )}
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Nom</Text>
            {isEditing ? (
              <TextInput
                style={styles.input}
                value={lastName}
                onChangeText={(t) => { setLastName(t); markChanged(); }}
                placeholder="Votre nom"
                placeholderTextColor="#9ca3af"
                returnKeyType="next"
              />
            ) : (
              <Text style={styles.fieldValue}>{user.lastName || '-'}</Text>
            )}
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Téléphone mobile</Text>
            {isEditing ? (
              <TextInput
                style={styles.input}
                value={phoneMobile}
                onChangeText={(t) => { setPhoneMobile(t); markChanged(); }}
                placeholder="+33 6 12 34 56 78"
                placeholderTextColor="#9ca3af"
                keyboardType="phone-pad"
                returnKeyType="done"
              />
            ) : (
              <Text style={styles.fieldValue}>{user.phoneMobile || user.phone || '-'}</Text>
            )}
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Email</Text>
            <Text style={[styles.fieldValue, styles.fieldValueMuted]}>{user.email}</Text>
            {isEditing && (
              <Text style={styles.fieldHint}>L'email ne peut pas être modifié ici.</Text>
            )}
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Rôle</Text>
            <View style={[styles.roleBadgeInline, { backgroundColor: getRoleColor(user.role) + '20' }]}>
              <Text style={[styles.roleBadgeInlineText, { color: getRoleColor(user.role) }]}>
                {ROLE_LABELS[user.role] || user.role}
              </Text>
            </View>
          </View>

          {user.tags && user.tags.length > 0 && (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Tags</Text>
              <View style={styles.tagsRow}>
                {user.tags.map((tag, i) => (
                  <View key={i} style={styles.tag}>
                    <Text style={styles.tagText}>{tag}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}
        </View>

        {/* Save Button */}
        {isEditing && (
          <Pressable
            onPress={handleSave}
            disabled={isSaving || !hasChanges}
            style={({ pressed }) => [
              styles.saveButton,
              pressed && { opacity: 0.9, transform: [{ scale: 0.97 }] },
              (isSaving || !hasChanges) && styles.saveButtonDisabled,
            ]}
          >
            {isSaving ? (
              <ActivityIndicator size="small" color="#ffffff" />
            ) : (
              <Text style={styles.saveButtonText}>Enregistrer les modifications</Text>
            )}
          </Pressable>
        )}

        {/* Logout Button */}
        <Pressable
          onPress={handleLogout}
          style={({ pressed }) => [
            styles.logoutButton,
            pressed && { opacity: 0.9, transform: [{ scale: 0.97 }] },
          ]}
        >
          <IconSymbol name="xmark.circle.fill" size={20} color="#ef4444" />
          <Text style={styles.logoutButtonText}>Déconnexion</Text>
        </Pressable>

        {/* App Info */}
        <View style={styles.appInfo}>
          <Text style={styles.appInfoText}>Talion Crisis Comm v1.0.0</Text>
          <Text style={styles.appInfoText}>ID: {user.id}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function getRoleColor(role: string): string {
  switch (role) {
    case 'admin': return '#7c3aed';
    case 'dispatcher': return '#2563eb';
    case 'responder': return '#059669';
    default: return '#6b7280';
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f8fafc',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scrollContent: {
    paddingBottom: 100,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1e3a5f',
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#e8f4f8',
  },
  editButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1e3a5f',
  },
  cancelButton: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: '#fee2e2',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ef4444',
  },
  // ─── SOS Alert Banner ─────────────────────────────────────────────
  sosAlertBanner: {
    marginHorizontal: 20,
    marginTop: 12,
    borderRadius: 16,
    backgroundColor: '#dc2626',
    overflow: 'hidden',
    shadowColor: '#dc2626',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  sosAlertHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    paddingBottom: 12,
    gap: 10,
  },
  sosAlertPulse: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#fca5a5',
    marginTop: 6,
  },
  sosAlertInfo: {
    flex: 1,
  },
  sosAlertTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: 1,
  },
  sosAlertDesc: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.9)',
    marginTop: 3,
  },
  sosAlertLocation: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.7)',
    marginTop: 2,
  },
  sosAlertActions: {
    backgroundColor: 'rgba(0,0,0,0.15)',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sosPTTButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  sosPTTButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
    flex: 1,
  },
  sosPTTHint: {
    fontSize: 11,
    color: 'rgba(255,255,255,0.6)',
    marginTop: 8,
    textAlign: 'center',
  },
  // ─── Avatar ───────────────────────────────────────────────────────
  avatarSection: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  avatarContainer: {
    width: 100,
    height: 100,
    borderRadius: 50,
    overflow: 'hidden',
    position: 'relative',
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#1e3a5f',
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarInitials: {
    fontSize: 36,
    fontWeight: '700',
    color: '#ffffff',
  },
  cameraOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 36,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  displayName: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1e293b',
    marginTop: 12,
  },
  roleBadge: {
    marginTop: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#e8f4f8',
  },
  roleBadgeText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1e3a5f',
  },
  // ─── Form ─────────────────────────────────────────────────────────
  formSection: {
    marginHorizontal: 20,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 4,
    elevation: 1,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1e3a5f',
    marginBottom: 16,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 6,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    fontSize: 16,
    color: '#1e293b',
    fontWeight: '500',
  },
  fieldValueMuted: {
    color: '#94a3b8',
  },
  fieldHint: {
    fontSize: 12,
    color: '#94a3b8',
    marginTop: 4,
    fontStyle: 'italic',
  },
  input: {
    fontSize: 16,
    color: '#1e293b',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: '#f8fafc',
    fontWeight: '500',
  },
  roleBadgeInline: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  roleBadgeInlineText: {
    fontSize: 14,
    fontWeight: '600',
  },
  tagsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tag: {
    backgroundColor: '#f1f5f9',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  tagText: {
    fontSize: 13,
    color: '#475569',
    fontWeight: '500',
  },
  // ─── Buttons ──────────────────────────────────────────────────────
  saveButton: {
    marginHorizontal: 20,
    marginTop: 20,
    backgroundColor: '#1e3a5f',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  saveButtonDisabled: {
    opacity: 0.5,
  },
  saveButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 20,
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#fff1f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  logoutButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ef4444',
  },
  appInfo: {
    alignItems: 'center',
    paddingVertical: 24,
    gap: 4,
  },
  appInfoText: {
    fontSize: 12,
    color: '#94a3b8',
  },
});
