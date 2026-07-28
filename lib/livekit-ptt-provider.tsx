import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { Alert } from 'react-native';
import { livekitPTT } from './livekit-ptt';

interface ActiveSpeaker { identity: string; name: string; }

interface LiveKitPTTContextValue {
  connected: boolean;
  connecting: boolean;
  activeChannelId: string | null;
  activeChannelName: string | null;
  activeSpeakers: ActiveSpeaker[];
  transmitting: boolean;
  connect: (channelId: string, channelName: string) => Promise<void>;
  disconnect: () => Promise<void>;
  startTransmit: () => Promise<void>;
  stopTransmit: () => Promise<void>;
}

const LiveKitPTTContext = createContext<LiveKitPTTContextValue | null>(null);

// Mounted once at the app root (see app/_layout.tsx) rather than inside the
// PTT screen itself, so the LiveKit room stays connected while the user
// navigates to other tabs - the previous per-screen useEffect disconnected on
// unmount, meaning you only heard PTT audio while the PTT tab itself was on
// screen.
export function LiveKitPTTProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [activeChannelId, setActiveChannelId] = useState<string | null>(null);
  const [activeChannelName, setActiveChannelName] = useState<string | null>(null);
  const [activeSpeakers, setActiveSpeakers] = useState<ActiveSpeaker[]>([]);
  const [transmitting, setTransmitting] = useState(false);

  useEffect(() => {
    livekitPTT.onConnectionChange = (isConnected) => setConnected(isConnected);
    livekitPTT.onActiveSpeakersChanged = (speakers) => setActiveSpeakers(speakers);
    livekitPTT.onError = (message) => Alert.alert('Erreur PTT', message);
  }, []);

  const connect = useCallback(async (channelId: string, channelName: string) => {
    setConnecting(true);
    try {
      await livekitPTT.connect(channelId);
      setActiveChannelId(channelId);
      setActiveChannelName(channelName);
    } finally {
      setConnecting(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    await livekitPTT.disconnect();
    setActiveChannelId(null);
    setActiveChannelName(null);
    setActiveSpeakers([]);
    setTransmitting(false);
  }, []);

  const startTransmit = useCallback(async () => {
    await livekitPTT.startTransmit();
    setTransmitting(true);
  }, []);

  const stopTransmit = useCallback(async () => {
    await livekitPTT.stopTransmit();
    setTransmitting(false);
  }, []);

  return (
    <LiveKitPTTContext.Provider
      value={{
        connected, connecting, activeChannelId, activeChannelName, activeSpeakers, transmitting,
        connect, disconnect, startTransmit, stopTransmit,
      }}
    >
      {children}
    </LiveKitPTTContext.Provider>
  );
}

export function useLiveKitPTT() {
  const ctx = useContext(LiveKitPTTContext);
  if (!ctx) throw new Error('useLiveKitPTT must be used within a LiveKitPTTProvider');
  return ctx;
}
