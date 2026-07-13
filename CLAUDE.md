# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Serverless peer-to-peer video conferencing. No build step, no central server. Peers exchange SDP tokens manually (copy/paste or shareable links) to form a full-mesh network. Uses public STUN servers only.

## Commands

```bash

# Use lsof to check if server is already running (it might be a vscode server live-server)
lsof -i :5501 | grep LISTEN

# Serve locally (any static server from repo root)
python -m http.server 5501
# or
npx http-server -p 5501

# Type check (pinned: TS 7.x flags errors in vendored src/deps)
npx --package typescript@5.9 tsc --noEmit -p ./jsconfig.json

# Run tests (requires server running on port 5501)
npx run-page http://localhost:5501/tests.html
```

Open `http://localhost:5501` for the app.

## Testing

Tests are in `tests/` directory and run in the browser via `tests.html`. The test infrastructure includes:
- `test-helpers.js` - Test framework (`describe`, `it`, assertions, barriers)
- `test-runner.js` - Runs tests and displays results
- `utils/queue.js` - Async queue for coordinating test messages
- `tests.js` - Mesh connection tests covering full join flow and message exchange (real WebRTC)
- `fake-network.js` - Deterministic in-memory transport + virtual clock (drop/hold/sever fault injection, seeded interleaving, delivery trace)
- `sim-tests.js` - Protocol race-condition tests running PeerMesh on the FakeNetwork; every schedule is reproducible, failures log the delivery trace

The sim tests are DOM-free and can also run in Node for quick iteration
(shim `globalThis.location`, import `tests/sim-tests.js`, run `tests` from
test-helpers).

Please run the tests after every major change.

## Architecture

### No Build Step
Pure ES modules served directly. Import aliases are configured in two places that must stay in sync:
- `jsconfig.json` → `compilerOptions.paths` (for type checking)
- `index.html` → `<script type="importmap">` (for the browser)

### Key Libraries (vendored in `src/deps/`)
- **`scaffold-html`** — reactive UI via tagged template literals. Import as `"scaffold-html"`. See `src/deps/scaffold-html/README.md` and `COMPONENTS.md`.
- **`oat`** — CSS component library. Include `src/deps/oat/css/oat.css` and `src/deps/oat/js/index.js`. See CSS variables in `src/deps/oat/css/01-theme.css`.

### App Structure (`src/app/`)
- **`mesh.js`** — `PeerMesh` class: manages all RTCPeerConnections, handles relay signaling for mesh formation
- **`state.js`** — `AppState` class with all app state + `dispatch()` function + `scheduleRender()`
- **`main.js`** — entry point: sets up render loop, handles `#offer=` URL fragment on load
- **`components/`** — UI components (functions returning `html` templates or `asComponent` instances)
- **`app.css`** — app-specific styles on top of oat

### Join Flow (No Server)
1. Existing peer (A) generates an offer → shareable link `#offer=BASE64`
2. New peer (C) opens link, creates answer → shows answer token
3. A pastes answer token → A↔C data channel opens
4. On connect, each side sends the other a full `TOPOLOGY` snapshot; entries are gossiped onward via `TOPOLOGY_UPDATE` (versioned, last-write-wins)
5. For each known-but-unconnected peer pair, the lexicographically lower ID initiates a `RELAY_OFFER`, flooded through the mesh (deduped by `msgId`); the target floods back a `RELAY_ANSWER`
6. Full mesh formed (manual copy-paste only needed once). A 30s anti-entropy interval re-gossips, prunes departed peers, and retries missing connections.

See ARCHITECTURE.md for the full gossip/relay protocol.

### Data Channel Message Types
```
TOPOLOGY        — {entries: TopologyEntry[]}     full sync, sent on connect
TOPOLOGY_UPDATE — {entry: TopologyEntry}         gossip, version LWW
RELAY_OFFER     — {msgId, from, to, name, sdp}   flooded, deduped by msgId
RELAY_ANSWER    — {msgId, from, to, sdp}         flooded, deduped by msgId
PEER_META       — {name}                         name change broadcast
CHAT            — {text, timestamp}              chat message
SCREEN_SHARE    — {active}                       track swap notification (sent; receivers currently ignore)
RENEGOTIATE_OFFER / RENEGOTIATE_ANSWER — {sdp}   per-connection, intercepted in Connection
```

## TypeScript/JSDoc Standards

### Use `cast()` instead of type assertions
```javascript
// ✅ Good - runtime checked
const input = cast(HTMLInputElement, e.target);

// ❌ Avoid
const input = /** @type {HTMLInputElement} */ (e.target);
```
`cast()` is in `src/app/utils.js`.

### No `any` — ask before using it
Use `unknown` with narrowing instead. Double-cast via `unknown` is acceptable when needed:
```javascript
const fn = /** @type {(...args: unknown[]) => unknown} */ (/** @type {unknown} */ (value));
```

### Type definition files
For complex types, use `.ts` files alongside `.js`:
```javascript
// ✅ Good
/** @import {MyType} from "./types.ts" */
```

## UI Patterns

### Global dispatch — do NOT pass dispatch as props
```javascript
// ✅ Good
<input oninput=${(e) => {
  const input = cast(HTMLInputElement, e.target);
  dispatch('setName', input.value);
}}>
```

### State methods
- Parse in handlers, process in state methods
- Async state methods call `scheduleRender()` themselves for intermediate updates
- Direct `this.state` mutation in `render()` is OK for caching (see COMPONENTS.md)

### scaffold-html notes
- Templates must be the **same reference** to update in-place (define outside render, use as a function)
- Use `{ key, value }` objects in arrays for keyed lists
- `#refName` attribute syntax creates DOM refs; refs are **unavailable on first render**
- `asComponent` for stateful components; plain functions for stateless ones
