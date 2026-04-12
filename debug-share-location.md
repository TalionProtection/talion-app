# Share Location Bug Analysis

## Problem
When a user taps "Share Location" on the mobile app, their location does NOT appear on the Dispatch console map.

## Root Causes Found

### 1. Mobile app: handleShareLocation does NOT send location via WebSocket
In `app/(tabs)/index.tsx` line 205-220:
- `handleShareLocation` only sets `isSharingLocation` state and shows an Alert
- It NEVER calls `websocketService.sendLocation()` or `websocketManager.updateLocation()`
- No periodic location sending is set up

### 2. Server: handleLocationUpdate only updates existing users in the `users` Map
In `server/index.ts` line 528-546:
- `handleLocationUpdate` looks up `users.get(userId)` 
- If the user is not in the Map (not connected via WebSocket), the location is silently dropped
- The broadcast only goes to 'dispatcher' role via `broadcastToRole`

### 3. Server: `/dispatch/map/users` filters out responders
In `server/index.ts` line 1452-1484:
- The endpoint filters `.filter(u => u.role !== 'responder')` - only shows non-responder users
- But the user must be in the `users` Map with a location set

### 4. Dispatch web: responderLocationUpdate only updates existing responders array
In `server/dispatch-web/app.js` line 195-202:
- Only updates responders already in the `responders` array
- Regular users sending location updates are not handled

## Fix Plan
1. Mobile: Make handleShareLocation actually send location via WebSocket periodically
2. Server: Ensure location updates from all roles are stored and broadcast
3. Dispatch web: Handle location updates for all user types, not just responders
