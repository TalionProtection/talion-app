import { describe, it, expect } from 'vitest';
import { formatIncidentId, formatIncidentType, formatStatusFr, formatSeverityFr, formatTimeAgoFr } from '../lib/format-utils';

describe('formatIncidentId', () => {
  it('converts a UUID to a short INC-XXXX code', () => {
    const result = formatIncidentId('a3f8b2c1-1234-5678-9abc-def012345678');
    expect(result).toBe('INC-A3F8');
  });

  it('handles alert- prefixed IDs', () => {
    const result = formatIncidentId('alert-1711234567890-abc123');
    expect(result).toBe('INC-1711');
  });

  it('handles short IDs', () => {
    const result = formatIncidentId('abc');
    expect(result).toBe('INC-ABC');
  });

  it('handles empty string', () => {
    const result = formatIncidentId('');
    expect(result).toBe('INC-????');
  });

  it('handles IDs with only special characters', () => {
    const result = formatIncidentId('----');
    expect(result).toBe('INC-????');
  });

  it('strips incident- prefix', () => {
    const result = formatIncidentId('incident-xyz789');
    expect(result).toBe('INC-XYZ7');
  });

  it('strips inc- prefix', () => {
    const result = formatIncidentId('inc-5678abcd');
    expect(result).toBe('INC-5678');
  });

  it('produces consistent output for same input', () => {
    const id = 'test-id-12345';
    expect(formatIncidentId(id)).toBe(formatIncidentId(id));
  });
});

describe('formatIncidentType', () => {
  it('returns SOS for sos type', () => {
    expect(formatIncidentType('sos')).toBe('SOS');
  });

  it('returns Médical for medical type', () => {
    expect(formatIncidentType('medical')).toBe('Médical');
  });

  it('returns Incendie for fire type', () => {
    expect(formatIncidentType('fire')).toBe('Incendie');
  });

  it('returns Sécurité for security type', () => {
    expect(formatIncidentType('security')).toBe('Sécurité');
  });

  it('returns Accident for accident type', () => {
    expect(formatIncidentType('accident')).toBe('Accident');
  });

  it('capitalizes unknown types', () => {
    expect(formatIncidentType('custom')).toBe('Custom');
  });
});

describe('formatStatusFr', () => {
  it('returns Actif for active', () => {
    expect(formatStatusFr('active')).toBe('Actif');
  });

  it('returns Acquitté for acknowledged', () => {
    expect(formatStatusFr('acknowledged')).toBe('Acquitté');
  });

  it('returns Dispatché for dispatched', () => {
    expect(formatStatusFr('dispatched')).toBe('Dispatché');
  });

  it('returns Résolu for resolved', () => {
    expect(formatStatusFr('resolved')).toBe('Résolu');
  });

  it('capitalizes unknown statuses', () => {
    expect(formatStatusFr('unknown')).toBe('Unknown');
  });
});

describe('formatSeverityFr', () => {
  it('returns Critique for critical', () => {
    expect(formatSeverityFr('critical')).toBe('Critique');
  });

  it('returns Élevé for high', () => {
    expect(formatSeverityFr('high')).toBe('Élevé');
  });

  it('returns Moyen for medium', () => {
    expect(formatSeverityFr('medium')).toBe('Moyen');
  });

  it('returns Faible for low', () => {
    expect(formatSeverityFr('low')).toBe('Faible');
  });
});

describe('formatTimeAgoFr', () => {
  it('returns seconds for recent timestamps', () => {
    const result = formatTimeAgoFr(Date.now() - 30000);
    expect(result).toMatch(/Il y a \d+s/);
  });

  it('returns minutes for timestamps a few minutes ago', () => {
    const result = formatTimeAgoFr(Date.now() - 300000);
    expect(result).toMatch(/Il y a \d+min/);
  });

  it('returns hours for timestamps a few hours ago', () => {
    const result = formatTimeAgoFr(Date.now() - 7200000);
    expect(result).toMatch(/Il y a \d+h/);
  });

  it('returns days for timestamps more than 24h ago', () => {
    const result = formatTimeAgoFr(Date.now() - 172800000);
    expect(result).toMatch(/Il y a \d+j/);
  });
});
