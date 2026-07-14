# WebRTC Peer-to-Peer Video Conferencing

Serverless peer-to-peer video conferencing with no build step and no central server. Peers exchange SDP tokens manually (copy/paste or shareable links) to form a full-mesh network using public STUN servers only.

**Hosted on github pages**: https://jvranish.github.io/webrtc-p2p/

## Features

- **True peer-to-peer**: No central server required for signaling or media
- **Manual token exchange**: Copy/paste or shareable links for initial connection
- **Automatic mesh formation**: After first connection, new peers automatically connect to all existing peers
- **No build step**: Pure ES modules served directly to the browser
- **Chat messaging**: Real-time chat between all connected peers
- **Screen sharing**: Share your screen with other participants

## Quick Start

1. **Start a local server** from the repository root:
   ```bash
   python -m http.server 5501
   # or
   npx http-server -p 5501
   ```

2. **Open the app** at `http://localhost:5501`

3. **Connect peers**:
   - First peer creates an offer and shares the link
   - Second peer opens the link and copies the answer token
   - First peer pastes the answer token
   - All subsequent peers automatically connect to the full mesh

## How It Works

### Join Flow (No Server Required)

1. **Existing peer (A)** generates an offer → shareable link with `#offer=BASE64`
2. **New peer (C)** opens the link, creates an answer → displays answer token
3. **Peer A** pastes answer token → A↔C data channel opens
4. **On connect**, each side sends the other a full `TOPOLOGY` snapshot; entries are gossiped onward via `TOPOLOGY_UPDATE` (versioned, last-write-wins)
5. **For each known-but-unconnected pair**, the lexicographically lower ID floods a `RELAY_OFFER` through the mesh (deduped by `msgId`); the target floods back a `RELAY_ANSWER`
6. **Full mesh formed** — manual copy-paste only needed once. A 30s anti-entropy interval re-gossips, prunes departed peers, and retries missing connections.

### Architecture

- **No build step**: Pure ES modules with import maps
- **Reactive UI**: Uses `scaffold-html` for efficient template-based rendering
- **WebRTC mesh**: Custom `PeerMesh` class manages all peer connections
- **Relay signaling**: Data channels relay connection offers/answers for mesh formation

## Development

### Type Checking

```bash
npx --package typescript@7 tsc --noEmit -p ./jsconfig.json
```

### Running Tests

Tests run in the browser and require a server on port 5501:

```bash
# Terminal 1: Start test server
python -m http.server 5501
# or
npx http-server -p 5501

# Terminal 2: Run tests
npx run-page http://localhost:5501/tests.html
```

### Project Structure

```
src/
├── app/
│   ├── main.js           # Entry point
│   ├── state.js          # Application state management
│   ├── actions.js        # Mesh→dispatch wiring, message/media handling
│   ├── mesh.js           # PeerMesh class (WebRTC mesh logic)
│   ├── peer-connection.js# Low-level WebRTC connection wrapper
│   ├── icons.js          # Inline SVG icon set
│   ├── components/       # UI components
│   └── app.css           # App-specific styles
├── deps/
│   └── scaffold-html/    # Reactive UI library
tests/
├── tests.html            # Test runner page
├── test-runner.js        # Test execution
├── test-helpers.js       # Test framework
├── mesh-tests.js         # Real WebRTC mesh tests
├── fake-network.js       # Deterministic in-memory transport + virtual clock
├── sim-tests.js          # Protocol race-condition simulation tests
└── utils/queue.js        # Async queue for test coordination
```

## Technology Stack

- **Pure JavaScript**: No transpilation or bundling required
- **ES Modules**: Native browser module support
- **WebRTC**: Peer-to-peer data channels and media streams
- **scaffold-html**: Lightweight reactive UI via tagged templates

## Browser Support

Requires a modern browser with WebRTC support (Chrome, Firefox, Safari, Edge).

## Known Network Limitations

This application may not work on certain networks due to its reliance on direct peer-to-peer UDP connections:

- **Corporate networks**: Often use symmetric NAT and restrictive firewalls that block UDP traffic, preventing WebRTC connections
- **pfSense routers**: By default, pfSense randomizes UDP source ports for security, which breaks WebRTC's ICE connection establishment. If you use pfSense and experience connection issues, see the [Static Port documentation](https://docs.netgate.com/pfsense/en/latest/nat/outbound.html#static-port) for instructions on disabling source port randomization for WebRTC traffic.
- **Restrictive ISPs**: Some ISPs (particularly in certain regions) block UDP traffic or STUN server ports (3478, 5349)

This app uses public STUN servers only and has no TURN server fallback, so direct UDP connectivity is required for peer-to-peer connections to work.

## License

MIT License - see [LICENSE](LICENSE) for details
