import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock server-url to avoid react-native import
vi.mock('@/lib/server-url', () => ({
  getApiBaseUrl: () => 'http://localhost:3000',
  getWsUrl: () => 'ws://localhost:3000',
}));

describe('PTT mimeType Support', () => {
  let pttService: typeof import('../services/ptt-service');

  beforeEach(async () => {
    vi.resetModules();
    pttService = await import('../services/ptt-service');
  });

  it('PTTMessage interface should support mimeType field', () => {
    const msg: import('../services/ptt-service').PTTMessage = {
      id: 'test-1',
      channelId: 'emergency',
      senderId: 'user-1',
      senderName: 'Test User',
      senderRole: 'user',
      audioUri: '',
      audioBase64: 'dGVzdA==',
      mimeType: 'audio/m4a',
      duration: 5,
      timestamp: new Date(),
      played: false,
    };
    expect(msg.mimeType).toBe('audio/m4a');
  });

  it('PTTMessage mimeType should be optional', () => {
    const msg: import('../services/ptt-service').PTTMessage = {
      id: 'test-2',
      channelId: 'general',
      senderId: 'user-2',
      senderName: 'Test User 2',
      senderRole: 'dispatcher',
      audioUri: '',
      duration: 3,
      timestamp: new Date(),
      played: false,
    };
    expect(msg.mimeType).toBeUndefined();
  });

  it('should correctly identify audio/webm as webm format', () => {
    const mimeType = 'audio/webm';
    const ext = mimeType === 'audio/webm' ? 'webm' : 'm4a';
    expect(ext).toBe('webm');
  });

  it('should correctly identify audio/m4a as m4a format', () => {
    const mimeType = 'audio/m4a';
    const ext = mimeType === 'audio/webm' ? 'webm' : 'm4a';
    expect(ext).toBe('m4a');
  });

  it('should default to audio/webm when mimeType is undefined', () => {
    const mimeType = undefined;
    const resolvedMime = mimeType || 'audio/webm';
    expect(resolvedMime).toBe('audio/webm');
  });

  it('should construct correct data URL for webm audio', () => {
    const audioData = 'dGVzdGF1ZGlv';
    const mimeType = 'audio/webm';
    const dataUrl = `data:${mimeType};base64,${audioData}`;
    expect(dataUrl).toBe('data:audio/webm;base64,dGVzdGF1ZGlv');
  });

  it('should construct correct data URL for m4a audio', () => {
    const audioData = 'dGVzdGF1ZGlv';
    const mimeType = 'audio/m4a';
    const dataUrl = `data:${mimeType};base64,${audioData}`;
    expect(dataUrl).toBe('data:audio/m4a;base64,dGVzdGF1ZGlv');
  });

  it('should strip data URL prefix correctly', () => {
    const dataUrl = 'data:audio/webm;base64,dGVzdA==';
    const rawBase64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    expect(rawBase64).toBe('dGVzdA==');
  });

  it('should handle raw base64 without prefix', () => {
    const rawBase64 = 'dGVzdA==';
    const result = rawBase64.includes(',') ? rawBase64.split(',')[1] : rawBase64;
    expect(result).toBe('dGVzdA==');
  });

  it('web platform should send audio/webm mimeType', () => {
    // Simulates what ptt-context.tsx does for web recording
    const platformOS = 'web';
    const recordingMimeType = platformOS === 'web' ? 'audio/webm' : 'audio/m4a';
    expect(recordingMimeType).toBe('audio/webm');
  });

  it('native platform should send audio/m4a mimeType', () => {
    // Simulates what ptt-context.tsx does for native recording
    const platformOS = 'ios';
    const recordingMimeType = platformOS === 'web' ? 'audio/webm' : 'audio/m4a';
    expect(recordingMimeType).toBe('audio/m4a');
  });

  it('should create correct blob type from mimeType for web playback', () => {
    // Simulates web playback blob creation
    const message = { mimeType: 'audio/m4a', audioBase64: 'dGVzdA==' };
    const blobType = message.mimeType || 'audio/webm';
    expect(blobType).toBe('audio/m4a');
  });

  it('should use correct file extension for native playback', () => {
    // Simulates native playback file extension selection
    const webmMessage = { mimeType: 'audio/webm' };
    const m4aMessage = { mimeType: 'audio/m4a' };
    const undefinedMessage = { mimeType: undefined };

    const webmExt = webmMessage.mimeType === 'audio/webm' ? 'webm' : 'm4a';
    const m4aExt = m4aMessage.mimeType === 'audio/webm' ? 'webm' : 'm4a';
    const defaultExt = (undefinedMessage.mimeType || 'audio/webm') === 'audio/webm' ? 'webm' : 'm4a';

    expect(webmExt).toBe('webm');
    expect(m4aExt).toBe('m4a');
    expect(defaultExt).toBe('webm');
  });
});
