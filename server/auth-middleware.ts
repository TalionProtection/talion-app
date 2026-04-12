import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

let _supabaseAdmin: ReturnType<typeof createClient> | null = null;

function getSupabaseAdmin() {
  if (!_supabaseAdmin) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    _supabaseAdmin = createClient(url, key, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }
  return _supabaseAdmin;
}

export type UserRole = 'user' | 'responder' | 'dispatcher' | 'admin';

declare global {
  namespace Express {
    interface Request {
      supabaseUser?: { id: string; email: string; role: UserRole; };
    }
  }
}

const ROLE_HIERARCHY: Record<UserRole, number> = { user: 0, responder: 1, dispatcher: 2, admin: 3 };

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  const token = authHeader.split(' ')[1];
  try {
    const supabase = getSupabaseAdmin();
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });
    const { data: adminUser } = await supabase.from('admin_users').select('role').eq('id', user.id).single();
    const role: UserRole = adminUser?.role ?? 'user';
    req.supabaseUser = { id: user.id, email: user.email!, role };
    next();
  } catch (err) {
    console.error('[requireAuth] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userRole = req.supabaseUser?.role;
    if (!userRole) return res.status(401).json({ error: 'Not authenticated' });
    const userLevel = ROLE_HIERARCHY[userRole] ?? -1;
    const requiredLevel = Math.min(...roles.map((r) => ROLE_HIERARCHY[r] ?? 99));
    if (userLevel < requiredLevel) return res.status(403).json({ error: `Insufficient permissions. Required: ${roles.join(' or ')}, got: ${userRole}` });
    next();
  };
}

export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();
  const token = authHeader.split(' ')[1];
  try {
    const supabase = getSupabaseAdmin();
    const { data: { user } } = await supabase.auth.getUser(token);
    if (user) {
      const { data: adminUser } = await supabase.from('admin_users').select('role').eq('id', user.id).single();
      const role: UserRole = adminUser?.role ?? 'user';
      req.supabaseUser = { id: user.id, email: user.email!, role };
    }
  } catch { }
  next();
}
