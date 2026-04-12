# Location Visibility Audit

## Current State

### Server (server/index.ts)

1. **handleLocationUpdate()** (line 593):
   - ALL users (responder or regular) can send location updates
   - Responder locations → broadcast to `dispatcher` role only (`responderLocationUpdate`)
   - Regular user locations → broadcast to `dispatcher` role only (`userLocationUpdate`)
   - **Problem**: Only dispatchers receive location updates. Regular users on the map screen don't receive ANY other user locations.

2. **broadcastToRole()** (line 689):
   - Only sends to users with matching role
   - No concept of "family" broadcasting

3. **REST /api/location** (line 1184):
   - Accepts location from any user
   - Calls handleLocationUpdate which only broadcasts to dispatchers

4. **No family location endpoint exists** - there's no API to get family members' locations

### Client (app/(tabs)/explore.tsx)

1. **MOCK_RESPONDERS** (line 53): Hardcoded mock responders shown to ALL users regardless of role
2. **WebSocket listener** (line 430): Listens on `websocketService.on('location', ...)` which only receives `responderLocationUpdate` events forwarded by WebSocketProvider
3. **No role-based filtering**: The map shows mock responders to everyone including regular users
4. **No family location display**: No concept of family members on the map

### Data Model (server/index.ts)

1. **AdminUser.relationships** (line 115): Already has family relationship types: 'parent', 'child', 'spouse', 'sibling', 'cohabitant', 'other'
2. **Existing relationships in seed data**:
   - user-001 (Thomas) ↔ user-002 (Julie): spouse
   - user-004 (Lea) ↔ user-005 (Hugo): sibling

## Required Changes

### Server
1. Add new API endpoint: `GET /api/family/locations` - returns locations of family members only
2. Add new WebSocket event: `familyLocationUpdate` - sent to family members when one updates location
3. Modify `handleLocationUpdate()` to also broadcast to family members
4. Ensure `broadcastToRole('dispatcher', ...)` stays for dispatchers/responders

### Client
1. **explore.tsx**: 
   - Regular users: REMOVE mock responders, only show family member locations + incidents
   - Responders/dispatchers: Keep showing responder locations
   - Add family member markers on map
2. **Add family location fetching**: New hook or context for family locations
