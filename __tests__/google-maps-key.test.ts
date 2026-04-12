import { describe, it, expect } from 'vitest';

describe('Address Autocomplete API Validation', () => {
  it('should be able to call Nominatim (OpenStreetMap) geocoding API', async () => {
    const url = `https://nominatim.openstreetmap.org/search?q=Paris&format=json&addressdetails=1&limit=3`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'TalionCrisisComm-DispatchConsole/1.0' },
    });
    expect(response.ok).toBe(true);

    const data = await response.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('display_name');
    expect(data[0]).toHaveProperty('lat');
    expect(data[0]).toHaveProperty('lon');
  });
});
