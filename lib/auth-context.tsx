import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { createClient, SupabaseClient, Session } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

// ─── Supabase client ────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    // Use AsyncStorage for native, localStorage for web
    storage: Platform.OS === 'web' ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});

// ─── Types ───────────────────────────────────────────────────────────────────
export type UserRole = 'user' | 'responder' | 'dispatcher' | 'admin';

export interface User {
  id: string;
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  role: UserRole;
  status?: 'available' | 'on_duty' | 'off_duty';
  phone?: string;
  phoneMobile?: string;
  avatar?: string;
  tags?: string[];
}

export interface AuthContextType {
  user: User | null;
  session: Session | null;
  isLoading: boolean;
  isSignedIn: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  signup: (email: string, password: string, name: string, role: UserRole) => Promise<void>;
  updateUserStatus: (status: 'available' | 'on_duty' | 'off_duty') => Promise<void>;
  updateProfile: (updates: {
    firstName?: string;
    lastName?: string;
    phoneMobile?: string;
    photoUrl?: string;
  }) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// ─── Helper: fetch profile from the correct table ────────────────────────────
// Staff (responder, dispatcher, admin) live in admin_users
// Clients live in users
async function fetchUserProfile(userId: string): Promise<User | null> {
  // Try admin_users first (staff)
  const { data: adminUser } = await supabase
    .from('admin_users')
    .select('*')
    .eq('id', userId)
    .single();

  if (adminUser) {
    return {
      id: adminUser.id,
      email: adminUser.email,
      name: `${adminUser.first_name ?? ''} ${adminUser.last_name ?? ''}`.trim() || adminUser.email,
      firstName: adminUser.first_name,
      lastName: adminUser.last_name,
      role: adminUser.role as UserRole,
      status: adminUser.status ?? 'available',
      phone: adminUser.phone_mobile ?? adminUser.phone_landline ?? '',
      phoneMobile: adminUser.phone_mobile ?? '',
      tags: adminUser.tags ?? [],
      avatar: adminUser.photo_url ?? undefined,
    };
  }

  // Try users table (clients)
  const { data: clientUser } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .single();

  if (clientUser) {
    return {
      id: clientUser.id,
      email: clientUser.email,
      name: `${clientUser.first_name ?? ''} ${clientUser.last_name ?? ''}`.trim() || clientUser.email,
      firstName: clientUser.first_name,
      lastName: clientUser.last_name,
      role: 'user' as UserRole,
      phone: clientUser.phone_mobile ?? '',
      phoneMobile: clientUser.phone_mobile ?? '',
      avatar: clientUser.photo_url ?? undefined,
    };
  }

  return null;
}

// ─── Provider ────────────────────────────────────────────────────────────────
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Get initial session
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      if (session?.user) {
        const profile = await fetchUserProfile(session.user.id);
        setUser(profile);
      }
      setIsLoading(false);
    });

    // Listen for auth changes (token refresh, sign out, etc.)
    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      if (session?.user) {
        const profile = await fetchUserProfile(session.user.id);
        setUser(profile);
      } else {
        setUser(null);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const login = async (email: string, password: string) => {
  setIsLoading(true);
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);

    const profile = await fetchUserProfile(data.user.id);
    if (!profile) throw new Error('Profil introuvable. Contactez un administrateur.');
    setUser(profile);
    setSession(data.session);
  } finally {
    setIsLoading(false);
  }
};

  const logout = async () => {
    setIsLoading(true);
    try {
      await supabase.auth.signOut();
      setUser(null);
      setSession(null);
    } finally {
      setIsLoading(false);
    }
  };

  const signup = async (email: string, password: string, name: string, role: UserRole) => {
    setIsLoading(true);
    try {
      const [firstName, ...lastParts] = name.split(' ');
      const lastName = lastParts.join(' ') || '';

      // Create auth user
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw new Error(error.message);
      if (!data.user) throw new Error('Création du compte échouée');

      // Insert profile in correct table based on role
      const table = role === 'user' ? 'users' : 'admin_users';
      const { error: profileError } = await supabase.from(table).insert({
        id: data.user.id,
        email,
        first_name: firstName,
        last_name: lastName,
        role,
      });
      if (profileError) throw new Error(profileError.message);

      // Login immediately
      await login(email, password);
    } finally {
      setIsLoading(false);
    }
  };

  const updateProfile = async (updates: {
    firstName?: string;
    lastName?: string;
    phoneMobile?: string;
    photoUrl?: string;
  }) => {
    if (!user || !session) return;

    const table = user.role === 'user' ? 'users' : 'admin_users';
    const dbUpdates: Record<string, any> = {};
    if (updates.firstName !== undefined) dbUpdates.first_name = updates.firstName;
    if (updates.lastName !== undefined) dbUpdates.last_name = updates.lastName;
    if (updates.phoneMobile !== undefined) dbUpdates.phone_mobile = updates.phoneMobile;
    if (updates.photoUrl !== undefined) dbUpdates.photo_url = updates.photoUrl;

    const { error } = await supabase.from(table).update(dbUpdates).eq('id', user.id);
    if (error) throw new Error(error.message);

    setUser((prev) =>
      prev
        ? {
            ...prev,
            firstName: updates.firstName ?? prev.firstName,
            lastName: updates.lastName ?? prev.lastName,
            name:
              `${updates.firstName ?? prev.firstName ?? ''} ${updates.lastName ?? prev.lastName ?? ''}`.trim() ||
              prev.name,
            phoneMobile: updates.phoneMobile ?? prev.phoneMobile,
            phone: updates.phoneMobile ?? prev.phone,
            avatar: updates.photoUrl ?? prev.avatar,
          }
        : prev
    );
  };

  const updateUserStatus = async (status: 'available' | 'on_duty' | 'off_duty') => {
    if (!user || user.role === 'user') return;

    const { error } = await supabase
      .from('admin_users')
      .update({ status })
      .eq('id', user.id);

    if (!error) {
      setUser((prev) => (prev ? { ...prev, status } : prev));
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        isLoading,
        isSignedIn: user !== null,
        login,
        logout,
        signup,
        updateUserStatus,
        updateProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
