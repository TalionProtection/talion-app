import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert as RNAlert,
  Platform,
  Image,
} from 'react-native';
import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import { getApiBaseUrl } from '@/lib/server-url';

type AlertType = 'sos' | 'medical' | 'fire' | 'accident' | 'other';

interface AlertCreationModalProps {
  visible: boolean;
  onClose: () => void;
  onAlertCreated?: () => void;
  userId?: string;
  userName?: string;
}

const ALERT_TYPES: { label: string; value: AlertType; icon: string; color: string }[] = [
  { label: 'SOS', value: 'sos', icon: '🆘', color: '#ef4444' },
  { label: 'Medical', value: 'medical', icon: '🏥', color: '#f97316' },
  { label: 'Fire', value: 'fire', icon: '🔥', color: '#dc2626' },
  { label: 'Accident', value: 'accident', icon: '🚗', color: '#ea580c' },
  { label: 'Other', value: 'other', icon: '⚠️', color: '#eab308' },
];

const PRIORITY_LEVELS: { label: string; value: 'low' | 'medium' | 'high' | 'critical' }[] = [
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Critical', value: 'critical' },
];

const MAX_PHOTOS = 4;

export function AlertCreationModal({ visible, onClose, onAlertCreated, userId = '', userName = '' }: AlertCreationModalProps) {
  const [alertType, setAlertType] = useState<AlertType>('sos');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'critical'>('high');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState<{ latitude: number; longitude: number; address?: string } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [locationLoading, setLocationLoading] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [serverReachable, setServerReachable] = useState(true);

  useEffect(() => {
    if (visible) {
      requestLocationPermission();
      checkServerHealth();
    }
  }, [visible]);

  const checkServerHealth = async () => {
    try {
      const baseUrl = getApiBaseUrl();
      const response = await fetch(`${baseUrl}/health`, { method: 'GET' });
      setServerReachable(response.ok);
    } catch {
      setServerReachable(false);
    }
  };

  const requestLocationPermission = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setLocationError('Location permission denied');
        return;
      }
      await getCurrentLocation();
    } catch (error) {
      console.error('Permission error:', error);
      setLocationError('Failed to request location permission');
    }
  };

  const getCurrentLocation = async () => {
    try {
      setLocationLoading(true);
      setLocationError(null);
      const currentLocation = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });

      let address: string | undefined;
      try {
        const reverseGeocode = await Location.reverseGeocodeAsync({
          latitude: currentLocation.coords.latitude,
          longitude: currentLocation.coords.longitude,
        });
        if (reverseGeocode.length > 0) {
          const { street, city, region } = reverseGeocode[0];
          address = [street, city, region].filter(Boolean).join(', ');
        }
      } catch (error) {
        console.warn('Failed to reverse geocode:', error);
      }

      setLocation({
        latitude: currentLocation.coords.latitude,
        longitude: currentLocation.coords.longitude,
        address,
      });
    } catch (error) {
      console.error('Location error:', error);
      setLocationError('Failed to get current location');
    } finally {
      setLocationLoading(false);
    }
  };

  const pickImageFromLibrary = async () => {
    if (photos.length >= MAX_PHOTOS) {
      RNAlert.alert('Limit Reached', `Maximum ${MAX_PHOTOS} photos allowed per alert.`);
      return;
    }

    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: false,
        quality: 0.7,
        allowsMultipleSelection: true,
        selectionLimit: MAX_PHOTOS - photos.length,
      });

      if (!result.canceled && result.assets) {
        const newPhotos = result.assets.map((asset) => asset.uri);
        setPhotos((prev) => [...prev, ...newPhotos].slice(0, MAX_PHOTOS));
      }
    } catch (error) {
      console.error('Image picker error:', error);
      RNAlert.alert('Error', 'Failed to pick image from library.');
    }
  };

  const takePhoto = async () => {
    if (photos.length >= MAX_PHOTOS) {
      RNAlert.alert('Limit Reached', `Maximum ${MAX_PHOTOS} photos allowed per alert.`);
      return;
    }

    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        RNAlert.alert('Permission Required', 'Camera permission is needed to take photos.');
        return;
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 0.7,
      });

      if (!result.canceled && result.assets) {
        setPhotos((prev) => [...prev, result.assets[0].uri].slice(0, MAX_PHOTOS));
      }
    } catch (error) {
      console.error('Camera error:', error);
      RNAlert.alert('Error', 'Failed to take photo.');
    }
  };

  const removePhoto = (index: number) => {
    setPhotos((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmitAlert = async () => {
    if (!location) {
      RNAlert.alert('Error', 'Location is required to create an alert');
      return;
    }

    if (!description.trim() && alertType !== 'sos') {
      RNAlert.alert('Error', 'Please provide a description for your alert');
      return;
    }

    try {
      setIsLoading(true);

      const baseUrl = getApiBaseUrl();
      const url = `${baseUrl}/api/sos`;
      console.log(`[AlertCreationModal] Sending alert via REST to: ${url}`);

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: alertType,
          severity: priority,
          location: {
            latitude: location.latitude,
            longitude: location.longitude,
            address: location.address || 'Unknown',
          },
          description: description.trim() || `${alertType.toUpperCase()} Alert`,
          userId: userId || `user-${Date.now()}`,
          userName: userName || 'Unknown',
          userRole: 'user',
        }),
      });

      if (response.ok) {
        const result = await response.json();
        console.log(`[AlertCreationModal] Alert sent successfully. ID: ${result.alertId}`);

        // Upload photos if any were attached
        if (photos.length > 0 && result.alertId) {
          try {
            console.log(`[AlertCreationModal] Uploading ${photos.length} photo(s) to alert ${result.alertId}`);
            const photoFormData = new FormData();
            for (const photoUri of photos) {
              const filename = photoUri.split('/').pop() || `photo-${Date.now()}.jpg`;
              const ext = filename.split('.').pop()?.toLowerCase() || 'jpg';
              const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
              photoFormData.append('photos', {
                uri: photoUri,
                name: filename,
                type: mimeType,
              } as any);
            }
            const photoResponse = await fetch(`${baseUrl}/api/alerts/${result.alertId}/photos`, {
              method: 'POST',
              body: photoFormData,
            });
            if (photoResponse.ok) {
              console.log(`[AlertCreationModal] Photos uploaded successfully`);
            } else {
              console.warn(`[AlertCreationModal] Photo upload failed: ${photoResponse.status}`);
            }
          } catch (photoErr) {
            console.warn('[AlertCreationModal] Photo upload error:', photoErr);
          }
        }

        RNAlert.alert('Succès', 'Alerte créée et envoyée aux dispatchers');
        setDescription('');
        setPhotos([]);
        onAlertCreated?.();
        onClose();
      } else {
        console.error(`[AlertCreationModal] Server returned status: ${response.status}`);
        RNAlert.alert('Erreur', 'Le serveur a rejeté l\'alerte. Veuillez réessayer.');
      }
    } catch (error) {
      console.error('[AlertCreationModal] Failed to send alert:', error);
      RNAlert.alert('Error', 'Failed to reach the server. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setDescription('');
    setPhotos([]);
    setAlertType('sos');
    setPriority('high');
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false}>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={handleClose} disabled={isLoading}>
            <Text style={styles.closeButton}>✕</Text>
          </TouchableOpacity>
          <Text style={styles.title}>Create Alert</Text>
          <View style={styles.placeholder} />
        </View>

        <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
          {/* Alert Type Selection */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Alert Type</Text>
            <View style={styles.typeGrid}>
              {ALERT_TYPES.map((type) => (
                <TouchableOpacity
                  key={type.value}
                  style={[
                    styles.typeButton,
                    alertType === type.value && styles.typeButtonActive,
                    { borderColor: alertType === type.value ? type.color : '#e5e7eb' },
                  ]}
                  onPress={() => setAlertType(type.value)}
                  disabled={isLoading}
                >
                  <Text style={styles.typeIcon}>{type.icon}</Text>
                  <Text style={[styles.typeLabel, alertType === type.value && styles.typeLabelActive]}>
                    {type.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Priority Selection */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Priority Level</Text>
            <View style={styles.priorityGrid}>
              {PRIORITY_LEVELS.map((level) => (
                <TouchableOpacity
                  key={level.value}
                  style={[
                    styles.priorityButton,
                    priority === level.value && styles.priorityButtonActive,
                  ]}
                  onPress={() => setPriority(level.value)}
                  disabled={isLoading}
                >
                  <Text
                    style={[
                      styles.priorityLabel,
                      priority === level.value && styles.priorityLabelActive,
                    ]}
                  >
                    {level.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* Location */}
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionTitle}>Location</Text>
              <TouchableOpacity onPress={getCurrentLocation} disabled={isLoading || locationLoading}>
                <Text style={styles.refreshButton}>🔄 Refresh</Text>
              </TouchableOpacity>
            </View>

            {locationLoading ? (
              <View style={styles.locationLoading}>
                <ActivityIndicator size="large" color="#1e3a5f" />
                <Text style={styles.locationLoadingText}>Getting your location...</Text>
              </View>
            ) : locationError ? (
              <View style={styles.locationError}>
                <Text style={styles.locationErrorText}>{locationError}</Text>
              </View>
            ) : location ? (
              <View style={styles.locationBox}>
                <Text style={styles.locationLabel}>Latitude: {location.latitude.toFixed(6)}</Text>
                <Text style={styles.locationLabel}>Longitude: {location.longitude.toFixed(6)}</Text>
                {location.address && <Text style={styles.locationAddress}>{location.address}</Text>}
              </View>
            ) : null}
          </View>

          {/* Photos / Attachments */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Photos ({photos.length}/{MAX_PHOTOS})</Text>

            {/* Photo Preview Grid */}
            {photos.length > 0 && (
              <View style={styles.photoGrid}>
                {photos.map((uri, index) => (
                  <View key={`photo-${index}`} style={styles.photoContainer}>
                    <Image source={{ uri }} style={styles.photoPreview} />
                    <TouchableOpacity
                      style={styles.removePhotoButton}
                      onPress={() => removePhoto(index)}
                      disabled={isLoading}
                    >
                      <Text style={styles.removePhotoText}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {/* Photo Action Buttons */}
            {photos.length < MAX_PHOTOS && (
              <View style={styles.photoActions}>
                <TouchableOpacity
                  style={styles.photoActionButton}
                  onPress={takePhoto}
                  disabled={isLoading}
                >
                  <Text style={styles.photoActionIcon}>📷</Text>
                  <Text style={styles.photoActionLabel}>Take Photo</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.photoActionButton}
                  onPress={pickImageFromLibrary}
                  disabled={isLoading}
                >
                  <Text style={styles.photoActionIcon}>🖼️</Text>
                  <Text style={styles.photoActionLabel}>From Library</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {/* Description */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Description</Text>
            <TextInput
              style={styles.descriptionInput}
              placeholder="Describe the emergency situation..."
              placeholderTextColor="#9ca3af"
              value={description}
              onChangeText={setDescription}
              multiline
              numberOfLines={4}
              editable={!isLoading}
              textAlignVertical="top"
              returnKeyType="done"
            />
          </View>

          {/* Connection Status */}
          <View style={styles.section}>
            <View style={styles.statusBox}>
              <View
                style={[
                  styles.statusIndicator,
                  { backgroundColor: serverReachable ? '#22c55e' : '#ef4444' },
                ]}
              />
              <Text style={styles.statusText}>
                {serverReachable ? 'Server reachable' : 'Server unreachable — alert will be retried'}
              </Text>
            </View>
          </View>
        </ScrollView>

        {/* Submit Button */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.submitButton, isLoading && styles.submitButtonDisabled]}
            onPress={handleSubmitAlert}
            disabled={isLoading}
          >
            {isLoading ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text style={styles.submitButtonText}>
                Send Alert {photos.length > 0 ? `(${photos.length} photo${photos.length > 1 ? 's' : ''})` : ''}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    paddingTop: Platform.OS === 'android' ? 40 : 50,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e7eb',
  },
  closeButton: {
    fontSize: 24,
    color: '#6b7280',
    fontWeight: 'bold',
  },
  title: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1f2937',
  },
  placeholder: {
    width: 24,
  },
  content: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 100,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1f2937',
    marginBottom: 12,
  },
  refreshButton: {
    fontSize: 14,
    color: '#1e3a5f',
    fontWeight: '600',
  },
  typeGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  typeButton: {
    flex: 1,
    minWidth: '28%',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
  },
  typeButtonActive: {
    backgroundColor: '#f0f4f8',
  },
  typeIcon: {
    fontSize: 28,
    marginBottom: 4,
  },
  typeLabel: {
    fontSize: 12,
    color: '#6b7280',
    fontWeight: '500',
  },
  typeLabelActive: {
    color: '#1e3a5f',
    fontWeight: '600',
  },
  priorityGrid: {
    flexDirection: 'row',
    gap: 8,
  },
  priorityButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    alignItems: 'center',
    backgroundColor: '#f9fafb',
  },
  priorityButtonActive: {
    backgroundColor: '#1e3a5f',
    borderColor: '#1e3a5f',
  },
  priorityLabel: {
    fontSize: 13,
    color: '#6b7280',
    fontWeight: '500',
  },
  priorityLabelActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  locationLoading: {
    alignItems: 'center',
    paddingVertical: 24,
  },
  locationLoadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#6b7280',
  },
  locationError: {
    backgroundColor: '#fee2e2',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  locationErrorText: {
    color: '#991b1b',
    fontSize: 13,
  },
  locationBox: {
    backgroundColor: '#f0f4f8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderLeftWidth: 3,
    borderLeftColor: '#1e3a5f',
  },
  locationLabel: {
    fontSize: 13,
    color: '#1f2937',
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    marginBottom: 4,
  },
  locationAddress: {
    fontSize: 13,
    color: '#6b7280',
    marginTop: 8,
    fontStyle: 'italic',
  },
  photoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  photoContainer: {
    width: '48%',
    aspectRatio: 4 / 3,
    borderRadius: 8,
    overflow: 'hidden',
    position: 'relative',
  },
  photoPreview: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
  },
  removePhotoButton: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  removePhotoText: {
    color: '#ffffff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  photoActions: {
    flexDirection: 'row',
    gap: 12,
  },
  photoActionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: '#1e3a5f',
    borderStyle: 'dashed',
    backgroundColor: '#f8fafc',
    gap: 8,
  },
  photoActionIcon: {
    fontSize: 20,
  },
  photoActionLabel: {
    fontSize: 13,
    color: '#1e3a5f',
    fontWeight: '600',
  },
  descriptionInput: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#1f2937',
    minHeight: 100,
  },
  statusBox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#f9fafb',
    borderRadius: 8,
  },
  statusIndicator: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusText: {
    fontSize: 13,
    color: '#6b7280',
  },
  footer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    backgroundColor: '#ffffff',
  },
  submitButton: {
    backgroundColor: '#ef4444',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  submitButtonDisabled: {
    backgroundColor: '#d1d5db',
  },
  submitButtonText: {
    color: '#ffffff',
    fontWeight: '700',
    fontSize: 16,
  },
});
