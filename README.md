# WebRTC Peer-to-Peer Video Conferencing

Serverless peer-to-peer video conferencing with no central coordinating or relay server. Peers exchange SDP tokens manually (copy/paste or shareable links) to form a full-mesh network using public STUN servers only.

**Hosted on github pages**: https://jvranish.github.io/webrtc-p2p/

## Features

Video, audio, chat, and screen sharing. Everyone connects directly to everyone else, so your media never passes through a server. Inviting someone requires generating a unique link per person — a little tedious, but it's what makes the whole thing work without a server.


## Quick Start

There are no dynamic server components, the app can be served statically.

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

## Development

### Type Checking

```bash
npx -y --package typescript@7 tsc --noEmit -p ./jsconfig.json
```

### Running Tests

Tests run in the browser and require a server on port 5501:

```bash
# Terminal 1: Start test server
python -m http.server 5501
# or
npx http-server -p 5501

# Terminal 2: Run tests
npx -y --package run-page@1 run-page http://localhost:5501/tests.html
```

## Technology Stack

- **Pure JavaScript**: No transpilation or bundling — static types via JSDoc annotations checked by `tsc`
- **ES Modules**: Native browser module support
- **WebRTC**: Peer-to-peer data channels and media streams
- **scaffold-html**: Lightweight reactive UI via tagged templates
- **Browser-based tests**: Test suite runs directly in the browser (no Node.js test runner)

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
