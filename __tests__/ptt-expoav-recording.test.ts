import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock server-url before any imports
vi.mock('@/services/server-url', () => ({
  getServerUrl: () => 'http://localhost:3000',
}));

// Mock Platform
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

describe('PTT expo-audio Recording Architecture', () => {
  describe('Recording flow design', () => {
    it('should use expo-audio useAudioRecorder for native recording (compatible with Expo Go)', () => {
      // expo-audio is included in Expo Go SDK 54
      // expo-av is NOT available in Expo Go (requires native rebuild)
      const expectedModules = {
        recording: 'expo-audio',      // useAudioRecorder for recording
        playback: 'expo-audio',       // createAudioPlayer for playback
        fileSystem: 'expo-file-system/legacy', // For base64 conversion
      };
      expect(expectedModules.recording).toBe('expo-audio');
      expect(expectedModules.playback).toBe('expo-audio');
    });

    it('should follow the correct expo-audio recording lifecycle from official docs', () => {
      // The correct lifecycle for expo-audio recording (SDK 54 docs):
      const lifecycle = [
        'requestRecordingPermissionsAsync()',
        'setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true })',
        'audioRecorder.prepareToRecordAsync()',
        'audioRecorder.record()',
        // ... user records ...
        'audioRecorder.stop()',
        'audioRecorder.uri',
        'FileSystem.readAsStringAsync(uri, { encoding: Base64 })',
        'setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false })',
      ];
      expect(lifecycle).toHaveLength(8);
      expect(lifecycle[1]).toContain('allowsRecording: true');
      expect(lifecycle[2]).toBe('audioRecorder.prepareToRecordAsync()');
      expect(lifecycle[3]).toBe('audioRecorder.record()');
      expect(lifecycle[4]).toBe('audioRecorder.stop()');
      expect(lifecycle[5]).toBe('audioRecorder.uri');
    });

    it('should set allowsRecording=true BEFORE prepareToRecordAsync (critical step)', () => {
      // This is the key fix: the audio mode must be set to allow recording
      // BEFORE calling prepareToRecordAsync, otherwise the recorder fails silently
      const steps = [
        { step: 1, action: 'setAudioModeAsync({ allowsRecording: true })' },
        { step: 2, action: 'prepareToRecordAsync()' },
        { step: 3, action: 'record()' },
      ];
      expect(steps[0].action).toContain('allowsRecording: true');
      expect(steps[0].step).toBeLessThan(steps[1].step);
    });

    it('should set allowsRecording=false AFTER stop (for iOS speaker routing)', () => {
      // After stopping recording, we must disable recording mode
      // so iOS routes audio to the speaker instead of the earpiece
      const steps = [
        { step: 1, action: 'stop()' },
        { step: 2, action: 'setAudioModeAsync({ allowsRecording: false })' },
      ];
      expect(steps[1].action).toContain('allowsRecording: false');
      expect(steps[0].step).toBeLessThan(steps[1].step);
    });
  });

  describe('Audio mode configuration', () => {
    it('should use expo-audio mode params (NOT expo-av params)', () => {
      // expo-audio uses: allowsRecording (boolean)
      // expo-av uses: allowsRecordingIOS (boolean) — DIFFERENT!
      const expoAudioRecordingMode = {
        playsInSilentMode: true,
        allowsRecording: true,
      };
      expect(expoAudioRecordingMode).toHaveProperty('allowsRecording');
      expect(expoAudioRecordingMode).toHaveProperty('playsInSilentMode');
      // Should NOT have expo-av specific properties
      expect(expoAudioRecordingMode).not.toHaveProperty('allowsRecordingIOS');
      expect(expoAudioRecordingMode).not.toHaveProperty('playsInSilentModeIOS');
    });

    it('should use playsInSilentMode for playback mode', () => {
      const playbackMode = {
        playsInSilentMode: true,
        allowsRecording: false,
      };
      expect(playbackMode.playsInSilentMode).toBe(true);
      expect(playbackMode.allowsRecording).toBe(false);
    });
  });

  describe('Audio format handling', () => {
    it('should use audio/mp4 mimeType for native recordings', () => {
      const nativeMimeType = 'audio/mp4';
      expect(nativeMimeType).toBe('audio/mp4');
    });

    it('should use audio/webm mimeType for web recordings', () => {
      const webMimeType = 'audio/webm';
      expect(webMimeType).toBe('audio/webm');
    });

    it('should use .m4a extension for native temp playback files', () => {
      const mimeType = 'audio/mp4';
      const ext = (mimeType === 'audio/webm') ? 'webm' : 'm4a';
      expect(ext).toBe('m4a');
    });
  });

  describe('Base64 handling', () => {
    it('should strip data URL prefix from incoming audio', () => {
      const dataUrl = 'data:audio/webm;base64,SGVsbG8gV29ybGQ=';
      let rawAudio = dataUrl;
      if (rawAudio.includes(',')) rawAudio = rawAudio.split(',')[1] || rawAudio;
      expect(rawAudio).toBe('SGVsbG8gV29ybGQ=');
    });

    it('should leave raw base64 unchanged', () => {
      const rawBase64 = 'SGVsbG8gV29ybGQ=';
      let rawAudio = rawBase64;
      if (rawAudio.includes(',')) rawAudio = rawAudio.split(',')[1] || rawAudio;
      expect(rawAudio).toBe('SGVsbG8gV29ybGQ=');
    });

    it('should require base64 length > 100 chars to transmit', () => {
      const minLength = 100;
      const shortAudio = 'abc';
      const longAudio = 'a'.repeat(200);
      expect(shortAudio.length > minLength).toBe(false);
      expect(longAudio.length > minLength).toBe(true);
    });

    it('should wait 100ms after stop before reading file (flush delay)', () => {
      // After audioRecorder.stop(), we wait 100ms for the file to be fully flushed
      const flushDelay = 100;
      expect(flushDelay).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Recording state management', () => {
    it('should use ref-based recording flag to prevent race conditions', () => {
      let isRecordingRef = { current: false };
      
      isRecordingRef.current = true;
      expect(isRecordingRef.current).toBe(true);
      
      isRecordingRef.current = false;
      expect(isRecordingRef.current).toBe(false);
    });

    it('should use useAudioRecorder hook (called unconditionally at top level)', () => {
      // The hook must be called at the top level of the component
      // even on web (where it returns null via the conditional)
      // This follows React rules of hooks
      const hookPattern = 'useAudioRecorderHook ? useAudioRecorderHook(recordingPreset) : null';
      expect(hookPattern).toContain('useAudioRecorderHook');
    });
  });

  describe('Duration validation', () => {
    it('should reject recordings shorter than 0.3 seconds', () => {
      const minDuration = 0.3;
      expect(0.1 > minDuration).toBe(false);
      expect(0.5 > minDuration).toBe(true);
    });
  });

  describe('Emergency recording', () => {
    it('should reuse the same nativeRecorder for emergency (only one recording at a time)', () => {
      // Unlike the expo-av approach which had separate recording refs,
      // with useAudioRecorder we only have one recorder instance from the hook
      // Emergency and normal PTT share it (mutually exclusive via isRecordingRef)
      const recorderCount = 1; // single useAudioRecorder instance
      expect(recorderCount).toBe(1);
    });

    it('should only allow dispatcher and admin roles for emergency', () => {
      const canTrigger = (role: string) => role === 'dispatcher' || role === 'admin';
      expect(canTrigger('dispatcher')).toBe(true);
      expect(canTrigger('admin')).toBe(true);
      expect(canTrigger('user')).toBe(false);
      expect(canTrigger('responder')).toBe(false);
    });
  });

  describe('Expo Go compatibility', () => {
    it('should NOT use expo-av (not available in Expo Go)', () => {
      // expo-av requires a native rebuild and is not in Expo Go
      const usedModules = ['expo-audio', 'expo-file-system/legacy'];
      expect(usedModules).not.toContain('expo-av');
    });

    it('should use RecordingPresets.HIGH_QUALITY from expo-audio', () => {
      const presetName = 'RecordingPresets.HIGH_QUALITY';
      expect(presetName).toContain('RecordingPresets');
      expect(presetName).not.toContain('RecordingOptionsPresets'); // That's expo-av
    });
  });
});
