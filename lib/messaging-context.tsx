/**
 * Messaging Context
 * Manages conversations, message history, and direct messaging between users.
 * Persists conversations to AsyncStorage and integrates with WebSocket for real-time delivery.
 */

import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@/hooks/useAuth';
import { websocketService } from '@/services/websocket';
import { alertSoundService } from '@/services/alert-sound-service';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageType = 'text' | 'location' | 'alert' | 'image' | 'system';

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  text: string;
  type: MessageType;
  timestamp: number;
  status: 'sending' | 'sent' | 'delivered' | 'read';
  /** Optional location data for location messages */
  location?: { latitude: number; longitude: number; address?: string };
  /** Optional image URI for image messages */
  imageUri?: string;
}

export interface Conversation {
  id: string;
  /** Participant IDs (excluding current user) */
  participantIds: string[];
  /** Participant names for display */
  participantNames: string[];
  /** Participant roles */
  participantRoles: string[];
  /** Display name for the conversation */
  displayName: string;
  /** Last message preview */
  lastMessage: string;
  /** Timestamp of last message */
  lastMessageTime: number;
  /** Number of unread messages */
  unreadCount: number;
  /** Whether the conversation is active (at least one participant online) */
  isActive: boolean;
  /** Avatar initial or emoji */
  avatar: string;
  /** Conversation type */
  type: 'direct' | 'group' | 'incident';
  /** Related incident ID (for incident conversations) */
  incidentId?: string;
}

/** Known contacts in the system (simulated directory) */
export interface Contact {
  id: string;
  name: string;
  role: string;
  status: 'online' | 'offline' | 'busy';
  avatar: string;
}

// ─── Default Contacts (simulated team directory) ────────────────────────────

const SYSTEM_CONTACTS: Contact[] = [
  { id: 'dispatch-001', name: 'Dispatch Center', role: 'dispatcher', status: 'online', avatar: 'D' },
  { id: 'dispatch-002', name: 'Emergency Coordinator', role: 'dispatcher', status: 'online', avatar: 'E' },
  { id: 'resp-001', name: 'Unit Alpha', role: 'responder', status: 'online', avatar: 'A' },
  { id: 'resp-002', name: 'Unit Bravo', role: 'responder', status: 'online', avatar: 'B' },
  { id: 'resp-003', name: 'Unit Charlie', role: 'responder', status: 'offline', avatar: 'C' },
  { id: 'resp-004', name: 'Medical Team 1', role: 'responder', status: 'online', avatar: 'M' },
  { id: 'user-001', name: 'Field Observer', role: 'user', status: 'online', avatar: 'F' },
  { id: 'user-002', name: 'Site Manager', role: 'user', status: 'online', avatar: 'S' },
];

// ─── Storage Keys ───────────────────────────────────────────────────────────

const CONVERSATIONS_KEY = '@talion_conversations';
const MESSAGES_KEY = '@talion_messages';

// ─── Context ────────────────────────────────────────────────────────────────

interface MessagingContextType {
  conversations: Conversation[];
  contacts: Contact[];
  totalUnread: number;
  getMessages: (conversationId: string) => ChatMessage[];
  sendMessage: (conversationId: string, text: string, type?: MessageType, extra?: any) => void;
  createConversation: (contact: Contact) => Conversation;
  getOrCreateConversation: (contactId: string) => Conversation;
  markConversationRead: (conversationId: string) => void;
  getContactsForRole: (currentRole: string) => Contact[];
  deleteConversation: (conversationId: string) => void;
}

const MessagingContext = createContext<MessagingContextType | null>(null);

// ─── Provider ───────────────────────────────────────────────────────────────

export function MessagingProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [allMessages, setAllMessages] = useState<Map<string, ChatMessage[]>>(new Map());
  const initialized = useRef(false);

  // Load persisted data
  useEffect(() => {
    if (initialized.current || !user) return;
    initialized.current = true;

    const load = async () => {
      try {
        const storedConvos = await AsyncStorage.getItem(`${CONVERSATIONS_KEY}_${user.id}`);
        const storedMsgs = await AsyncStorage.getItem(`${MESSAGES_KEY}_${user.id}`);

        if (storedConvos) {
          setConversations(JSON.parse(storedConvos));
        } else {
          // Initialize with default conversations based on role
          const defaultConvos = createDefaultConversations(user.id, user.name, user.role);
          setConversations(defaultConvos);
        }

        if (storedMsgs) {
          const parsed: Record<string, ChatMessage[]> = JSON.parse(storedMsgs);
          const map = new Map<string, ChatMessage[]>();
          for (const [key, msgs] of Object.entries(parsed)) {
            map.set(key, msgs);
          }
          setAllMessages(map);
        } else {
          // Initialize with sample messages
          const defaultMsgs = createDefaultMessages(user.role);
          setAllMessages(defaultMsgs);
        }
      } catch (error) {
        console.warn('Failed to load messaging data:', error);
      }
    };

    load();
  }, [user]);

  // Persist conversations when they change
  useEffect(() => {
    if (!user || !initialized.current) return;
    AsyncStorage.setItem(`${CONVERSATIONS_KEY}_${user.id}`, JSON.stringify(conversations)).catch(() => {});
  }, [conversations, user]);

  // Persist messages when they change
  useEffect(() => {
    if (!user || !initialized.current) return;
    const obj: Record<string, ChatMessage[]> = {};
    allMessages.forEach((msgs, key) => {
      obj[key] = msgs;
    });
    AsyncStorage.setItem(`${MESSAGES_KEY}_${user.id}`, JSON.stringify(obj)).catch(() => {});
  }, [allMessages, user]);

  // Listen for incoming WebSocket messages
  useEffect(() => {
    const handleIncomingMessage = (data: any) => {
      if (!data || !user) return;

      const { senderId, senderName, senderRole, content, conversationId, type: msgType } = data;
      if (senderId === user.id) return; // Ignore own messages

      const convId = conversationId || `conv-${[user.id, senderId].sort().join('-')}`;

      const newMessage: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        conversationId: convId,
        senderId,
        senderName: senderName || 'Unknown',
        senderRole: senderRole || 'user',
        text: content || '',
        type: msgType || 'text',
        timestamp: Date.now(),
        status: 'delivered',
      };

      setAllMessages((prev) => {
        const updated = new Map(prev);
        const existing = updated.get(convId) || [];
        updated.set(convId, [...existing, newMessage]);
        return updated;
      });

      setConversations((prev) => {
        const existing = prev.find((c) => c.id === convId);
        if (existing) {
          return prev.map((c) =>
            c.id === convId
              ? {
                  ...c,
                  lastMessage: content || '',
                  lastMessageTime: Date.now(),
                  unreadCount: c.unreadCount + 1,
                }
              : c
          );
        }
        // Create new conversation for unknown sender
        const newConvo: Conversation = {
          id: convId,
          participantIds: [senderId],
          participantNames: [senderName || 'Unknown'],
          participantRoles: [senderRole || 'user'],
          displayName: senderName || 'Unknown',
          lastMessage: content || '',
          lastMessageTime: Date.now(),
          unreadCount: 0,
          isActive: true,
          avatar: (senderName || 'U').charAt(0).toUpperCase(),
          type: 'direct',
        };
        return [newConvo, ...prev];
      });

      // Play notification sound for incoming messages
      alertSoundService.playNotification();
    };

    websocketService.on('message', handleIncomingMessage);
    return () => {
      websocketService.off('message', handleIncomingMessage);
    };
  }, [user]);

  // Get messages for a conversation
  const getMessages = useCallback(
    (conversationId: string): ChatMessage[] => {
      return allMessages.get(conversationId) || [];
    },
    [allMessages]
  );

  // Send a message
  const sendMessage = useCallback(
    (conversationId: string, text: string, type: MessageType = 'text', extra?: any) => {
      if (!user || !text.trim()) return;

      const newMessage: ChatMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
        conversationId,
        senderId: user.id,
        senderName: user.name,
        senderRole: user.role,
        text: text.trim(),
        type,
        timestamp: Date.now(),
        status: 'sent',
        ...(extra?.location && { location: extra.location }),
        ...(extra?.imageUri && { imageUri: extra.imageUri }),
      };

      // Add to local state
      setAllMessages((prev) => {
        const updated = new Map(prev);
        const existing = updated.get(conversationId) || [];
        updated.set(conversationId, [...existing, newMessage]);
        return updated;
      });

      // Update conversation
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, lastMessage: text.trim(), lastMessageTime: Date.now() }
            : c
        )
      );

      // Send via WebSocket
      const convo = conversations.find((c) => c.id === conversationId);
      if (convo && convo.participantIds.length > 0) {
        const recipientId = convo.participantIds[0];
        websocketService.sendMessage(recipientId, text.trim());
      }
    },
    [user, conversations]
  );

  // Create a new conversation with a contact
  const createConversation = useCallback(
    (contact: Contact): Conversation => {
      if (!user) {
        throw new Error('User not authenticated');
      }

      const convId = `conv-${[user.id, contact.id].sort().join('-')}`;

      // Check if conversation already exists
      const existing = conversations.find((c) => c.id === convId);
      if (existing) return existing;

      const newConvo: Conversation = {
        id: convId,
        participantIds: [contact.id],
        participantNames: [contact.name],
        participantRoles: [contact.role],
        displayName: contact.name,
        lastMessage: '',
        lastMessageTime: Date.now(),
        unreadCount: 0,
        isActive: contact.status === 'online',
        avatar: contact.avatar,
        type: 'direct',
      };

      setConversations((prev) => [newConvo, ...prev]);
      return newConvo;
    },
    [user, conversations]
  );

  // Get or create a conversation with a contact
  const getOrCreateConversation = useCallback(
    (contactId: string): Conversation => {
      if (!user) {
        throw new Error('User not authenticated');
      }

      const convId = `conv-${[user.id, contactId].sort().join('-')}`;
      const existing = conversations.find((c) => c.id === convId);
      if (existing) return existing;

      const contact = SYSTEM_CONTACTS.find((c) => c.id === contactId);
      if (contact) {
        return createConversation(contact);
      }

      // Fallback: create conversation with unknown contact
      const newConvo: Conversation = {
        id: convId,
        participantIds: [contactId],
        participantNames: ['Unknown'],
        participantRoles: ['user'],
        displayName: 'Unknown Contact',
        lastMessage: '',
        lastMessageTime: Date.now(),
        unreadCount: 0,
        isActive: false,
        avatar: '?',
        type: 'direct',
      };

      setConversations((prev) => [newConvo, ...prev]);
      return newConvo;
    },
    [user, conversations, createConversation]
  );

  // Mark conversation as read
  const markConversationRead = useCallback((conversationId: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === conversationId ? { ...c, unreadCount: 0 } : c))
    );
  }, []);

  // Get contacts filtered by current user's role
  const getContactsForRole = useCallback(
    (currentRole: string): Contact[] => {
      if (!user) return [];

      // Filter out self and return contacts relevant to the user's role
      return SYSTEM_CONTACTS.filter((c) => {
        if (c.id === user.id) return false;

        switch (currentRole) {
          case 'dispatcher':
          case 'admin':
            // Dispatchers can message everyone
            return true;
          case 'responder':
            // Responders can message dispatchers and other responders
            return c.role === 'dispatcher' || c.role === 'responder' || c.role === 'admin';
          case 'user':
            // Users can message dispatchers and responders
            return c.role === 'dispatcher' || c.role === 'responder';
          default:
            return false;
        }
      });
    },
    [user]
  );

  // Delete a conversation
  const deleteConversation = useCallback((conversationId: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== conversationId));
    setAllMessages((prev) => {
      const updated = new Map(prev);
      updated.delete(conversationId);
      return updated;
    });
  }, []);

  // Total unread count
  const totalUnread = conversations.reduce((sum, c) => sum + c.unreadCount, 0);

  return (
    <MessagingContext.Provider
      value={{
        conversations,
        contacts: SYSTEM_CONTACTS,
        totalUnread,
        getMessages,
        sendMessage,
        createConversation,
        getOrCreateConversation,
        markConversationRead,
        getContactsForRole,
        deleteConversation,
      }}
    >
      {children}
    </MessagingContext.Provider>
  );
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useMessaging(): MessagingContextType {
  const context = useContext(MessagingContext);
  if (!context) {
    throw new Error('useMessaging must be used within a MessagingProvider');
  }
  return context;
}

// ─── Default Data Generators ────────────────────────────────────────────────

function createDefaultConversations(userId: string, userName: string, userRole: string): Conversation[] {
  const convos: Conversation[] = [];

  if (userRole === 'user') {
    convos.push({
      id: `conv-${[userId, 'dispatch-001'].sort().join('-')}`,
      participantIds: ['dispatch-001'],
      participantNames: ['Dispatch Center'],
      participantRoles: ['dispatcher'],
      displayName: 'Dispatch Center',
      lastMessage: 'All units stand by for updates.',
      lastMessageTime: Date.now() - 300000,
      unreadCount: 0,
      isActive: true,
      avatar: 'D',
      type: 'direct',
    });
  } else if (userRole === 'responder') {
    convos.push(
      {
        id: `conv-${[userId, 'dispatch-001'].sort().join('-')}`,
        participantIds: ['dispatch-001'],
        participantNames: ['Dispatch Center'],
        participantRoles: ['dispatcher'],
        displayName: 'Dispatch Center',
        lastMessage: 'Unit 5 responding to incident at Main St.',
        lastMessageTime: Date.now() - 120000,
        unreadCount: 0,
        isActive: true,
        avatar: 'D',
        type: 'direct',
      },
      {
        id: `conv-${[userId, 'resp-001'].sort().join('-')}`,
        participantIds: ['resp-001'],
        participantNames: ['Unit Alpha'],
        participantRoles: ['responder'],
        displayName: 'Unit Alpha',
        lastMessage: 'On scene, situation under control.',
        lastMessageTime: Date.now() - 600000,
        unreadCount: 0,
        isActive: true,
        avatar: 'A',
        type: 'direct',
      }
    );
  } else if (userRole === 'dispatcher' || userRole === 'admin') {
    convos.push(
      {
        id: `conv-${[userId, 'resp-001'].sort().join('-')}`,
        participantIds: ['resp-001'],
        participantNames: ['Unit Alpha'],
        participantRoles: ['responder'],
        displayName: 'Unit Alpha',
        lastMessage: 'En route to incident INC-042.',
        lastMessageTime: Date.now() - 60000,
        unreadCount: 0,
        isActive: true,
        avatar: 'A',
        type: 'direct',
      },
      {
        id: `conv-${[userId, 'resp-002'].sort().join('-')}`,
        participantIds: ['resp-002'],
        participantNames: ['Unit Bravo'],
        participantRoles: ['responder'],
        displayName: 'Unit Bravo',
        lastMessage: 'Standing by at staging area.',
        lastMessageTime: Date.now() - 300000,
        unreadCount: 0,
        isActive: true,
        avatar: 'B',
        type: 'direct',
      },
      {
        id: `conv-${[userId, 'resp-004'].sort().join('-')}`,
        participantIds: ['resp-004'],
        participantNames: ['Medical Team 1'],
        participantRoles: ['responder'],
        displayName: 'Medical Team 1',
        lastMessage: 'Patient stabilized, awaiting transport.',
        lastMessageTime: Date.now() - 900000,
        unreadCount: 0,
        isActive: true,
        avatar: 'M',
        type: 'direct',
      },
      {
        id: `conv-${[userId, 'user-001'].sort().join('-')}`,
        participantIds: ['user-001'],
        participantNames: ['Field Observer'],
        participantRoles: ['user'],
        displayName: 'Field Observer',
        lastMessage: 'Reporting situation at sector 7.',
        lastMessageTime: Date.now() - 1200000,
        unreadCount: 0,
        isActive: true,
        avatar: 'F',
        type: 'direct',
      }
    );
  }

  return convos;
}

function createDefaultMessages(userRole: string): Map<string, ChatMessage[]> {
  const map = new Map<string, ChatMessage[]>();

  // Create sample message threads based on role
  // These are just initial samples to show the UI is working
  // Real messages will be added through user interaction

  return map;
}
