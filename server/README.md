# Talion Crisis Comm - WebSocket Server

Real-time communication server for alert streaming and responder location tracking.

## Features

- **Real-Time Alert Streaming**: Dispatchers and responders receive live alerts
- **Location Tracking**: Track responder positions in real-time
- **Status Management**: Responders can update their availability status
- **Alert Acknowledgment**: Track which responders are responding to alerts
- **Role-Based Broadcasting**: Messages are routed based on user roles
- **Automatic Reconnection**: Built-in support for connection recovery

## Architecture

```
server/
├── index.ts           # Main WebSocket server
├── websocket/         # WebSocket handlers
├── handlers/          # Message handlers
└── models/            # Data models
```

## WebSocket Message Types

### Authentication

**Send:**
```json
{
  "type": "auth",
  "userId": "user123",
  "userRole": "dispatcher"
}
```

**Receive:**
```json
{
  "type": "authSuccess",
  "userId": "user123",
  "userRole": "dispatcher",
  "timestamp": 1234567890
}
```

### Create Alert

**Send (Dispatcher/Responder only):**
```json
{
  "type": "sendAlert",
  "userId": "dispatcher123",
  "userRole": "dispatcher",
  "data": {
    "type": "medical",
    "severity": "critical",
    "location": {
      "latitude": 40.7128,
      "longitude": -74.0060,
      "address": "123 Main St, New York"
    },
    "description": "Person collapsed at shopping center"
  }
}
```

**Receive (All users):**
```json
{
  "type": "newAlert",
  "data": {
    "id": "alert-uuid",
    "type": "medical",
    "severity": "critical",
    "location": { ... },
    "description": "...",
    "createdBy": "dispatcher123",
    "createdAt": 1234567890,
    "status": "active",
    "respondingUsers": []
  }
}
```

### Update Location

**Send (All users):**
```json
{
  "type": "updateLocation",
  "userId": "responder123",
  "userRole": "responder",
  "data": {
    "latitude": 40.7128,
    "longitude": -74.0060
  }
}
```

**Receive (Dispatchers only):**
```json
{
  "type": "responderLocationUpdate",
  "userId": "responder123",
  "location": {
    "latitude": 40.7128,
    "longitude": -74.0060
  },
  "timestamp": 1234567890
}
```

### Update Status

**Send (Responders only):**
```json
{
  "type": "updateStatus",
  "userId": "responder123",
  "userRole": "responder",
  "data": {
    "status": "on_duty"
  }
}
```

**Receive (Dispatchers only):**
```json
{
  "type": "responderStatusUpdate",
  "userId": "responder123",
  "status": "on_duty",
  "timestamp": 1234567890
}
```

### Acknowledge Alert

**Send:**
```json
{
  "type": "acknowledgeAlert",
  "userId": "responder123",
  "data": {
    "alertId": "alert-uuid"
  }
}
```

**Receive (All users):**
```json
{
  "type": "alertAcknowledged",
  "alertId": "alert-uuid",
  "userId": "responder123",
  "timestamp": 1234567890
}
```

### Get Alerts

**Send:**
```json
{
  "type": "getAlerts",
  "userId": "user123",
  "userRole": "dispatcher"
}
```

**Receive:**
```json
{
  "type": "alertsList",
  "data": [ ... ],
  "timestamp": 1234567890
}
```

### Get Responders

**Send (Dispatchers only):**
```json
{
  "type": "getResponders",
  "userId": "dispatcher123",
  "userRole": "dispatcher"
}
```

**Receive:**
```json
{
  "type": "respondersList",
  "data": [ ... ],
  "timestamp": 1234567890
}
```

### Ping/Pong

**Send:**
```json
{
  "type": "ping"
}
```

**Receive:**
```json
{
  "type": "pong",
  "timestamp": 1234567890
}
```

## REST API Endpoints

### Health Check
```
GET /health
```

Response:
```json
{
  "status": "ok",
  "connectedUsers": 5,
  "activeAlerts": 2,
  "timestamp": 1234567890
}
```

### Get Active Alerts
```
GET /alerts
```

### Get Responders
```
GET /responders
```

### Create Alert (REST)
```
POST /alerts
Content-Type: application/json

{
  "type": "medical",
  "severity": "critical",
  "location": { "latitude": 40.7128, "longitude": -74.0060, "address": "..." },
  "description": "...",
  "createdBy": "dispatcher123"
}
```

## Running the Server

### Development
```bash
npm run dev:server
```

### Production
```bash
npm run build
npm start
```

### Environment Variables
```
PORT=3000              # Server port (default: 3000)
NODE_ENV=production    # Environment (development/production)
```

## Connection Flow

1. **Client connects** to WebSocket server
2. **Client sends auth** message with userId and userRole
3. **Server authenticates** and registers user
4. **Server sends alertsSnapshot** with current active alerts
5. **Client receives real-time messages** based on role:
   - **Users**: Can receive alerts, send SOS
   - **Responders**: Can create alerts, update location/status, acknowledge alerts
   - **Dispatchers**: Can create alerts, see all responders, see all alerts

## Error Handling

All errors are sent as:
```json
{
  "type": "error",
  "message": "Error description"
}
```

Common errors:
- `Invalid message format` - Malformed JSON
- `Missing userId or userRole` - Auth failed
- `Unauthorized to create alerts` - User role cannot create alerts
- `Unknown message type` - Invalid message type

## Performance Considerations

- **In-memory storage**: Alerts and users are stored in memory (use database for production)
- **Broadcasting**: Messages are sent to all connected clients or specific roles
- **Connection pooling**: Multiple connections per user are supported
- **Automatic cleanup**: Disconnected users are removed from tracking

## Future Enhancements

- [ ] Database persistence for alerts and users
- [ ] Alert history and archiving
- [ ] User authentication with JWT
- [ ] Rate limiting
- [ ] Message compression
- [ ] Clustering support
- [ ] Metrics and monitoring
