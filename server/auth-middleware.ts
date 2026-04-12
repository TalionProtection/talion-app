/**
 * Middleware d'authentification Supabase pour Express.
 *
 * Usage :
 *   import { requireAuth, requireRole } from './auth-middleware';
 *
 *   app.get('/api/alerts', requireAuth, (req, res) => { ... });
 *   app.delete('/api/users/:id', requireAuth, requireRole('admin'), (req, res) => { ... });
 *
 * Le middleware vérifie le JWT Supabase dans le header Authorization,
 * puis attache l'utilisateur à req.supabaseUser.
 */

import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL!;
// Utilise la SERVICE_ROLE_KEY côté serveur (jamais exposée au client)
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export type UserRole = 'user' | 'responder' | 'dispatcher' | 'admin';

// Étend le type Request Express pour inclure l'utilisateur Supabase
declare global {
  namespace Express {
    interface Request {
      supabaseUser?: {
        id: string;
        email: string;
        role: UserRole;
      };
    }
  }
}

/**
 * Vérifie le Bearer token et attache req.supabaseUser.
 * Répond 401 si absent ou invalide.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Récupère le rôle depuis admin_users ou users
    const { data: adminUser } = await supabaseAdmin
      .from('admin_users')
      .select('role')
      .eq('id', user.id)
      .single();

    const role: UserRole = adminUser?.role ?? 'user';

    req.supabaseUser = { id: user.id, email: user.email!, role };
    next();
  } catch (err) {
    console.error('[requireAuth] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * Vérifie que l'utilisateur a le rôle requis (ou supérieur).
 * Doit être utilisé après requireAuth.
 *
 * Hiérarchie : admin > dispatcher > responder > user
 */
const ROLE_HIERARCHY: Record<UserRole, number> = {
  user: 0,
  responder: 1,
  dispatcher: 2,
  admin: 3,
};

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const userRole = req.supabaseUser?.role;
    if (!userRole) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userLevel = ROLE_HIERARCHY[userRole] ?? -1;
    const requiredLevel = Math.min(...roles.map((r) => ROLE_HIERARCHY[r] ?? 99));

    if (userLevel < requiredLevel) {
      return res.status(403).json({
        error: `Insufficient permissions. Required: ${roles.join(' or ')}, got: ${userRole}`,
      });
    }

    next();
  };
}

/**
 * Middleware optionnel — n'échoue pas si pas de token,
 * mais attache req.supabaseUser si présent.
 * Utile pour les routes publiques qui ont un comportement différent si authentifié.
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.split(' ')[1];
  try {
    const { data: { user } } = await supabaseAdmin.auth.getUser(token);
    if (user) {
      const { data: adminUser } = await supabaseAdmin
        .from('admin_users')
        .select('role')
        .eq('id', user.id)
        .single();
      const role: UserRole = adminUser?.role ?? 'user';
      req.supabaseUser = { id: user.id, email: user.email!, role };
    }
  } catch {
    // Silently ignore errors for optional auth
  }
  next();
}
