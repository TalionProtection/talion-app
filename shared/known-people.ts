/**
 * Pure logic shared between the dispatch console and the mobile app for
 * KnownPerson.verificationStatus - see shared/visits.ts for why this must
 * stay dependency-free.
 */

export type VerificationStatus = 'verified' | 'pending' | 'flagged';

export const VERIFICATION_STATUS_LABEL: Record<VerificationStatus, string> = {
  verified: '✅ Vérifié',
  pending: '⏳ En cours',
  flagged: '🚩 Signalé',
};

// Console-specific badge color class names (stat-green/stat-yellow/stat-red).
export const VERIFICATION_STATUS_BADGE: Record<VerificationStatus, string> = {
  verified: 'stat-green',
  pending: 'stat-yellow',
  flagged: 'stat-red',
};

// pending -> verified -> flagged -> pending, for the tap-to-cycle pill.
export const VERIFICATION_STATUS_NEXT: Record<VerificationStatus, VerificationStatus> = {
  pending: 'verified',
  verified: 'flagged',
  flagged: 'pending',
};

export function verificationStatusLabel(status: string | undefined): string {
  return VERIFICATION_STATUS_LABEL[(status as VerificationStatus) || 'pending'] || VERIFICATION_STATUS_LABEL.pending;
}
