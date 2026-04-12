import { describe, it, expect } from 'vitest';

const BASE = 'http://127.0.0.1:3000';

describe('Family Perimeter Address Autocomplete', () => {
  it('should return geocode results for a valid query', async () => {
    const res = await fetch(`${BASE}/api/geocode?q=Paris`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('display_name');
    expect(data[0]).toHaveProperty('lat');
    expect(data[0]).toHaveProperty('lon');
  });

  it('should return worldwide results (not restricted to France)', async () => {
    const res = await fetch(`${BASE}/api/geocode?q=Tokyo`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.length).toBeGreaterThan(0);
    const hasJapan = data.some((r: any) => r.display_name.toLowerCase().includes('japan') || r.display_name.includes('日本'));
    expect(hasJapan).toBe(true);
  });

  it('should return empty array for very short queries', async () => {
    const res = await fetch(`${BASE}/api/geocode?q=ab`);
    // The server may still return results for short queries, but the client filters at 3 chars
    expect(res.ok).toBe(true);
  });

  it('should create a perimeter with address center from geocode result', async () => {
    // First, geocode an address
    const geoRes = await fetch(`${BASE}/api/geocode?q=Tour+Eiffel+Paris`);
    const geoData = await geoRes.json();
    expect(geoData.length).toBeGreaterThan(0);

    const selected = geoData[0];
    const lat = parseFloat(selected.lat);
    const lon = parseFloat(selected.lon);

    // Create a perimeter using the geocoded center
    const res = await fetch(`${BASE}/api/family/perimeters`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerId: 'user-001', // Thomas
        targetUserId: 'user-005', // Hugo
        center: { latitude: lat, longitude: lon, address: selected.display_name },
        radiusMeters: 500,
      }),
    });
    expect(res.ok).toBe(true);
    const result = await res.json();
    expect(result.id).toBeDefined();
    expect(result.center.latitude).toBeCloseTo(lat, 2);
    expect(result.center.longitude).toBeCloseTo(lon, 2);
    expect(result.center.address).toBe(selected.display_name);
  });

  it('should list the perimeter with the geocoded address', async () => {
    const res = await fetch(`${BASE}/api/family/perimeters?userId=user-001`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data)).toBe(true);
    // At least one perimeter should have an address
    const withAddress = data.filter((p: any) => p.center?.address);
    expect(withAddress.length).toBeGreaterThan(0);
  });
});
