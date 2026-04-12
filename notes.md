# Current State Notes

App is running. All services operational.
- Dev server on port 8081
- API server on port 3000
- Proxy on port 4000

## Pending work:
1. Photo picker in mobile admin form (admin.tsx) - need to add Image import, expo-image-picker, photo state, and upload logic
2. Relations management in mobile admin form - currently only in web admin console
3. Geofence polish on mobile map (explore.tsx)

## Key observations from admin.tsx:
- UserFormData interface does NOT have photoUrl field - needs to be added
- openEditForm does NOT populate photo from existing user
- handleSaveUser does NOT include photo in payload
- User list avatar shows initials only, not photos
- EMPTY_FORM has no photo field
- Image component not imported
