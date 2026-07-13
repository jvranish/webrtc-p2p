# Architecture Document

Serverless peer-to-peer video conferencing. Full-mesh topology with manual token exchange for initial connection. Public STUN servers only; no central signaling server.

## State Management

### AppState Structure
- **Identity**: `myId` (UUID), `myName` (string)
- **Peers**: Map of connected peers with current names and media streams
- **Modals**: `invitePhase` (idle/offering/waiting-answer), `joinPhase` (idle/processing/showing-answer), `settingsOpen`, `chatOpen`
- **Media**: `localStream`, `audioEnabled`, `videoEnabled`, `screenShareActive`, device lists, selected devices
- **UI State**: `pinnedPeerId`, chat messages, error messages

### State Updates
- Components dispatch actions via global `dispatch(method, ...args)` function
- State methods update AppState directly and call `scheduleRender()`
- Render scheduled via microtask to batch updates
- UI components re-render by calling `App(state)` with current state

---

## Peer Connection State Machine

### Initial Connection (Offer/Answer Handshake)

```mermaid
sequenceDiagram
    participant Offerer
    participant Channel as Manual Channel<br/>(copy/paste)
    participant Answerer

    Offerer->>Offerer: startOffer()
    Offerer->>Offerer: Create RTCPeerConnection
    Offerer->>Offerer: Create data channel
    Offerer->>Offerer: Create & set local offer SDP
    Offerer->>Offerer: Wait ICE gathering complete
    Offerer->>Channel: Share offer token (link)

    Channel->>Answerer: User opens link/pastes token
    Answerer->>Answerer: answerOffer(offerSdp)
    Answerer->>Answerer: Create RTCPeerConnection
    Answerer->>Answerer: Set remote offer SDP
    Answerer->>Answerer: Create & set local answer SDP
    Answerer->>Answerer: Wait ICE gathering complete
    Answerer->>Channel: Share answer token

    Channel->>Offerer: User pastes answer token
    Offerer->>Offerer: acceptAnswer(answerSdp)
    Offerer->>Offerer: Set remote answer SDP

    par Data Channel Opens
        Offerer->>Offerer: onopen event fires
        Answerer->>Answerer: onopen event fires
    end

    Offerer->>Answerer: Connection ready
```

### Data Channel Lifecycle
- **Offerer**: Creates data channel during `pc.createOffer()`
- **Answerer**: Receives data channel via `pc.ondatachannel` event
- **Open**: Connection ready when `readyState === 'open'`
- **Close**: Triggered by peer disconnect; fires `onDisconnected` callback

### Renegotiation (Track Changes)

When media tracks are added or replaced after connection is established, perfect negotiation pattern prevents collision:

```mermaid
flowchart TD
    A["negotiationneeded event fires"] --> B["makingOffer = true"]
    B --> C["Create local offer SDP"]
    C --> D["Send RENEGOTIATE_OFFER over data channel"]
    D --> E["makingOffer = false"]

    F["Receive RENEGOTIATE_OFFER"] --> G{"Collision check:<br/>makingOffer ||<br/>signalingState ≠ stable"}
    G -->|No collision| H["Set remote offer"]
    G -->|Collision &<br/>impolite peer| I["Ignore offer<br/>Let our offer win"]

    H --> J{"I am<br/>polite?"}
    J -->|Yes| K["Create answer SDP"]
    J -->|No| L["Ignore - wait<br/>for answer to our offer"]

    K --> M["Send RENEGOTIATE_ANSWER"]

    N["Receive RENEGOTIATE_ANSWER"] --> O["Set remote answer"]
    O --> P["Connection renegotiated"]
    M --> P

    style I fill:#fff4e6
    style L fill:#fff4e6
```

Key insight: By assigning "polite" role (answerer initiates connection), simultaneous offers are resolved deterministically — the impolite peer backs down and waits for an answer to its offer.

---

## Mesh Formation (Gossip Protocol)

### Topology Model
Each peer maintains a distributed replica of the mesh topology:
- **Topology**: Map of peer ID → `TopologyEntry`
- **TopologyEntry**: `{id, name, version, neighbors: [peerIds]}`
- **Version**: Incremented each time a peer's neighbor set changes
- **Authority**: Each peer is authoritative for its own entry; remote entries accepted if version > local version (last-write-wins)

### Bootstrap: Invite/Join Flow

**High-level flow:**

```mermaid
flowchart TD
    A["Initiator: Click 'Invite'"] --> B["mesh.createInvite()"]
    B --> C["Generate offer token"]
    C --> D["Share link<br/>#offer=TOKEN"]
    D --> E["Joiner opens link"]

    E --> F["Parse #offer=TOKEN"]
    F --> G["mesh.acceptInvite()"]
    G --> H["Generate answer token"]
    H --> I["Show answer to user"]
    I --> J["Initiator pastes answer"]

    J --> K["mesh.acceptAnswer()"]
    K --> L["A ↔ J connection opens"]
    L --> M["A sends TOPOLOGY to J"]
    M --> N["J learns all peers A knows"]
    N --> O["J initiates relay connections<br/>to A, C, D, ..."]
    O --> P["Mesh fully connected"]
```

**Detailed flow:**

**Initiator (creates invite link):**
1. Call `mesh.createInvite(myId, myName)`
   - Create RTCPeerConnection + offer
   - Return shareable link with base64-encoded offer token
   - Return `acceptAnswer(answerToken)` callback

2. User copies link to joiner

**Joiner (accepts invite link):**
1. Parse `#offer=BASE64` from URL
2. Call `mesh.acceptInvite(offerInput, myId, myName)`
   - Create RTCPeerConnection from offer SDP
   - Generate answer SDP
   - Begin connection asynchronously (fires `onPeerConnected` when data channel opens)
   - Return answer token to user

3. User copies answer token back to initiator

**Initiator continues:**
1. User pastes answer token
2. Call `acceptAnswer(answerToken)`
   - Set remote description (answer)
   - Connection completes immediately (data channel already created on offerer side)

**First connection established:**
1. Initiator's mesh sends new peer its full topology via `TOPOLOGY` message
2. New peer merges topology entries
3. New peer initiates relay connections to all peers it learned about

### Mesh Formation: Relay Connections

Once peers learn about each other via gossip:

```mermaid
sequenceDiagram
    participant A as Peer A<br/>(Initiator)
    participant B as Peer B<br/>(Relay)
    participant D as Peer D<br/>(Relay)
    participant C as Peer C<br/>(Target)

    A->>A: Check topology, find C
    A->>A: Create RELAY_OFFER (from:A, to:C, sdp)
    A->>B: Send RELAY_OFFER
    A->>D: Send RELAY_OFFER

    B->>B: Check msgId not seen
    B->>B: to ≠ my ID, not target
    B->>D: Relay to other peers
    B->>C: Relay to other peers

    D->>D: Check msgId not seen
    D->>B: Relay to other peers
    D->>C: Relay to other peers

    C->>C: Receive RELAY_OFFER (from:A, to:C)
    C->>C: to === my ID, I'm target
    C->>C: Create answer + RELAY_ANSWER (from:C, to:A, sdp)
    C->>B: Send RELAY_ANSWER
    C->>D: Send RELAY_ANSWER

    par Flooding Back
        B->>A: Relay RELAY_ANSWER
        D->>A: Relay RELAY_ANSWER
    end

    A->>A: Receive RELAY_ANSWER from C
    A->>A: Set remote description
    A->>C: A↔C connection opens
```

**Flow details:**
- A creates offer and floods to all neighbors (B, D)
- Each relay peer (B, D) forwards to others (except sender) — this spreads the message through the mesh
- C receives the offer (via B or D), recognizes `to === myId`, and processes it
- C sends answer back via same flooding mechanism
- A receives the answer and completes the connection

**Deduplication:** Each relay message has a `msgId` (UUID). Seen-set (bounded to 500 entries) prevents re-processing messages that loop back.

**Offer Collision Prevention:** Peer with lexicographically lower ID initiates the relay offer. This ensures only one side sends an offer, preventing simultaneous offer situations.

### Topology Gossip

**When a peer connects or disconnects:**

```mermaid
flowchart TD
    A["Peer D connects to Peer A"] --> B["A increments myVersion"]
    B --> C["A creates TOPOLOGY_UPDATE:<br/>id:A, version:X, neighbors:[D, ...]"]
    C --> D["A broadcasts to all neighbors<br/>D, E, F, ..."]

    D --> E["Neighbor E receives update"]
    E --> F{"E already knows<br/>A's version Y?<br/>X > Y?"}
    F -->|Yes, newer| G["E updates topology entry"]
    F -->|No, older/same| H["E ignores"]

    G --> I["E checks: any peers<br/>in topology not yet connected?"]
    I -->|Yes| J["E initiates relay connection<br/>to new peer"]

    G --> K["E re-gossips to all<br/>neighbors except sender A"]
    K --> L["Message propagates<br/>through mesh"]
```

**Anti-Entropy (Healing):**
- Automatic re-gossip every 30 seconds (starts after first peer connects)
- Sends full `TOPOLOGY_UPDATE` of this peer's entry to all neighbors
- Recovers from message loss that may have silently dropped topology updates

**State Tracking:**
- Maintaining full topology allows decision-making about who should initiate relay connections
- Prevents duplicate connection attempts between same two peers (lexicographic tie-breaking: lower ID initiates)

---

## Message Types

All messages are JSON strings sent over data channels.

**Topology Management:**
- `TOPOLOGY`: Full mesh state sync (sent once to new peer)
- `TOPOLOGY_UPDATE`: Single entry update (gossiped through mesh)

**Relay Signaling:**
- `RELAY_OFFER`: Offer for new connection, flooded to destination
- `RELAY_ANSWER`: Answer response, flooded to sender

**Renegotiation (during existing connection):**
- `RENEGOTIATE_OFFER`: SDP offer for track changes
- `RENEGOTIATE_ANSWER`: SDP answer for track changes

**Application Messages:**
- `PEER_META`: Name change broadcast
- `CHAT`: Chat message with text and timestamp
- `SCREEN_SHARE`: Screen share active/inactive notification
- `PEER_LEFT`: Graceful disconnect signal

---

## UI ↔ State ↔ Mesh Data Flow

**Architecture overview:**

```mermaid
flowchart TB
    UI["UI Components<br/>scaffold-html"]
    State["AppState<br/>dispatch/select"]
    Mesh["PeerMesh<br/>RTCPeerConnection"]
    RemotePeers["Remote Peers<br/>(network)"]

    UI -->|User clicks| Handler["Event Handler<br/>calls actions.js"]
    Handler -->|dispatch<br/>method, args| State
    State -->|state.method()<br/>scheduleRender| UI
    Handler -->|mesh.operation| Mesh

    Mesh -->|data channel<br/>message| RemotePeers
    RemotePeers -->|data channel<br/>message| Mesh
    Mesh -->|callback:<br/>onPeerConnected| Handler
    Handler -->|dispatch| State
    State -->|scheduleRender| UI

    style UI fill:#e1f5ff
    style State fill:#f3e5f5
    style Mesh fill:#e8f5e9
    style RemotePeers fill:#fff3e0
```

### Unidirectional Flow: UI → State → Mesh

**User Action → State Change → Mesh Action:**

```mermaid
sequenceDiagram
    participant UI
    participant Action as actions.js
    participant State
    participant Mesh

    UI->>Action: User clicks "Send Chat"
    Action->>State: dispatch('addChatMessage', ...)
    State->>State: Add message to messages array
    State->>UI: scheduleRender()
    UI->>UI: Re-render with new message
    Action->>Mesh: mesh.broadcast(CHAT message)
    Mesh->>Mesh: Send to all peers
```

**Pattern:** Actions in `actions.js` coordinate state dispatch + mesh operations. State updates always happen first; mesh broadcasts are side effects. This ensures optimistic UI updates.

### Unidirectional Flow: Mesh → State → UI

**Mesh Event → State Change → UI Re-render:**

```mermaid
sequenceDiagram
    participant RemotePeer as Remote Peer
    participant Mesh
    participant Action as Callback Handler
    participant State
    participant UI

    RemotePeer->>Mesh: RELAY_OFFER via data channel
    Mesh->>Mesh: Accept offer, create connection
    Mesh->>Mesh: Data channel opens
    Mesh->>Action: onPeerConnected(peer)
    Action->>State: dispatch('peerConnected', peer)
    State->>State: Add peer to peers map
    State->>UI: scheduleRender()
    UI->>UI: Render new peer video element
```

**Pattern:** Mesh callbacks always trigger `dispatch()`. UI automatically reflects state via re-render loop. No imperative DOM manipulation.

### Media Track Lifecycle

**Adding Tracks (starts camera):**

```mermaid
sequenceDiagram
    participant UI
    participant State
    participant Mesh
    participant LocalPCs as Peer Connections
    participant RemotePeers as Remote Peers

    UI->>UI: Click "Start Camera"
    UI->>UI: getUserMedia()
    UI->>State: dispatch('setLocalStream', stream)
    State->>State: Update localStream
    State->>UI: scheduleRender() → UI re-renders

    UI->>Mesh: mesh.addLocalTracks(tracks)
    Mesh->>LocalPCs: addTrack() on each connection
    LocalPCs->>LocalPCs: negotiationneeded event
    LocalPCs->>LocalPCs: Send RENEGOTIATE_OFFER

    LocalPCs->>RemotePeers: Offer via data channel
    RemotePeers->>RemotePeers: Receive RENEGOTIATE_OFFER
    RemotePeers->>RemotePeers: Send RENEGOTIATE_ANSWER
    RemotePeers->>RemotePeers: ontrack event: new stream
    RemotePeers->>Mesh: onRemoteStream callback
    Mesh->>State: dispatch('setPeerStream', peerId, stream)
    State->>UI: scheduleRender() → video elements update
```

**Replacing Tracks (switch device or screen share):**

```mermaid
flowchart TD
    A["User clicks 'Screen Share' or switches device"] --> B["Action: mesh.replaceVideoTrack(newTrack)<br/>or mesh.replaceAudioTrack(newTrack)"]
    B --> C["For each peer connection:<br/>sender.replaceTrack(newTrack)"]
    C --> D["negotiationneeded event fires"]
    D --> E["Renegotiation messages exchanged<br/>RENEGOTIATE_OFFER → RENEGOTIATE_ANSWER"]
    E --> F["Remote peers receive ontrack<br/>with same stream ID, new track"]
    F --> G["Video element auto-updates<br/>MediaStream object unchanged,<br/>track inside it is new"]
```

Key insight: Track replacement reuses the same MediaStream and stream ID, so video elements automatically display the new track without needing to re-bind.

---

## State Machines by Feature

### Invite Flow (Initiator)

```mermaid
stateDiagram-v2
    [*] --> idle

    idle -->|startInvite()| offering
    offering -->|error| idle: setInviteError()
    offering -->|offer created| waiting-answer: setOfferReady(link)
    waiting-answer -->|acceptAnswer()| idle: connection established
    waiting-answer -->|cancelInvite()| idle
    waiting-answer -->|error| idle: setInviteError()

    idle --> [*]
```

### Join Flow (Joiner)

```mermaid
stateDiagram-v2
    [*] --> idle

    idle -->|handleOffer(token)| processing
    processing -->|error| idle: setJoinError()
    processing -->|answer created| showing-answer: setAnswerToken()
    showing-answer -->|user confirms| idle: answer sent, awaiting connection
    showing-answer -->|error| idle: setJoinError()
    showing-answer -->|peerConnected callback| idle: auto-close when mesh ready

    idle --> [*]
```

### Media State
```
localStream: null → getUserMedia() → MediaStream with tracks
  → addLocalTracks() to mesh → renegotiation → remote peers receive

screenShareActive: false → startScreenShare() → true
  → replaceVideoTrack(screenTrack) → renegotiation
  → stopScreenShare() → false
  → replaceVideoTrack(cameraTrack) → renegotiation
```

---

## Key Design Decisions

1. **No Central Server:** Topology is gossiped peer-to-peer. Each peer maintains full replica.

2. **Manual Token Exchange:** Initial connection uses copy/paste tokens instead of server. Scalable to any number of peers without central bottleneck.

3. **Last-Write-Wins Topology:** Version number ensures eventual consistency without coordination.

4. **Perfect Negotiation Pattern:** Prevents both sides from sending offers simultaneously during renegotiation.

5. **Deduplication by msgId:** Flooded relay messages are deduplicated with bounded O(1) seen-set.

6. **Bounded Anti-Entropy:** 30-second re-gossip recovers from message loss without continuous overhead.

7. **Lexicographic Tie-Breaking:** Lower peer ID initiates relay offer to prevent duplicate offers.

8. **Unidirectional Data Flow:** UI → State → Mesh (actions dispatch state changes, state changes trigger mesh operations). Mesh → State → UI (mesh callbacks dispatch state changes, UI re-renders).

9. **Render Scheduling:** Microtask-based batching prevents excessive re-renders during async operations.

10. **Renegotiation via Data Channel:** Uses out-of-band SDP messages over existing data channel instead of ICE candidates for simplicity.
