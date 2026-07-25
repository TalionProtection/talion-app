/**
 * Patrol API — shared between the immediate-submit path (app/(tabs)/patrol.tsx) and
 * the offline-queue retry executor (services/offline-queue-processor.ts), so both
 * go through the same authenticated request logic instead of duplicating it.
 */
import { getApiBaseUrl } from '@/lib/server-url';
import { fetchWithTimeout } from '@/lib/fetch-with-timeout';
import { supabase } from '@/lib/auth-context';

export type PatrolStatus = 'habituel' | 'inhabituel' | 'identification' | 'suspect' | 'menace' | 'attaque';
export type TaskResult = 'ok' | 'pas_ok';

export interface PatrolTask {
  name: string;
  label: string;
  result: TaskResult;
  comment?: string;
}

export interface PatrolMedia {
  id: string;
  type: 'photo' | 'video';
  url: string;
  filename: string;
  uploadedAt: number;
}

export interface PatrolReport {
  id: string;
  createdAt: number;
  createdBy: string;
  createdByName: string;
  location: string;
  status: PatrolStatus;
  tasks: PatrolTask[];
  notes?: string;
  media?: PatrolMedia[];
  escalatedIncidentId?: string;
}

export interface PatrolReportDraft {
  createdBy: string;
  location: string;
  status: PatrolStatus;
  tasks: PatrolTask[];
  notes?: string;
}

export interface LocalMedia {
  uri: string;
  type: 'photo' | 'video';
  filename: string;
}

// /api/patrol/* requires a valid Supabase bearer token — fetch a fresh one on every
// call rather than caching it, since a queued/retried request may run much later,
// after the token has expired.
export async function authHeader(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

export async function createPatrolReport(draft: PatrolReportDraft): Promise<PatrolReport> {
  const res = await fetchWithTimeout(`${getApiBaseUrl()}/api/patrol/reports`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify(draft),
    timeout: 10000,
  });
  if (!res.ok) throw new Error(`POST /api/patrol/reports failed: ${res.status}`);
  const data = await res.json();
  return data.report;
}

export async function uploadMediaToReport(reportId: string, media: LocalMedia): Promise<PatrolMedia | null> {
  try {
    const formData = new FormData();
    const ext = media.filename.split('.').pop()?.toLowerCase() || 'jpg';
    const mimeType = media.type === 'video'
      ? `video/${ext === 'mov' ? 'quicktime' : ext}`
      : `image/${ext === 'jpg' ? 'jpeg' : ext}`;

    // React Native FormData expects this shape
    formData.append('media', {
      uri: media.uri,
      name: media.filename,
      type: mimeType,
    } as any);

    const res = await fetch(`${getApiBaseUrl()}/api/patrol/reports/${reportId}/media`, {
      method: 'POST',
      body: formData,
      // Don't set Content-Type header; fetch will set it with boundary for multipart
      headers: await authHeader(),
    });
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    const data = await res.json();
    return data.media || null;
  } catch (err) {
    console.error('[Patrol] Media upload error:', err);
    return null;
  }
}
