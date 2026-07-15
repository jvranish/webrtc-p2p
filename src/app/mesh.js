// @ts-check

import { startOffer, answerOffer } from './peer-connection.js';
import { encodeToken, decodeToken } from './utils.js';

/**
 * The connection surface PeerMesh needs. The real implementation is
 * `Connection` from peer-connection.js; tests inject in-memory fakes.
 * @typedef {Object} MeshConnection
 * @property {(data: string) => boolean} sendData
 * @property {(tracks: MediaStreamTrack[]) => void} addLocalTracks
 * @property {(newTrack: MediaStreamTrack) => Promise<void>} replaceTrack
 * @property {(kind: 'video' | 'audio') => Promise<void>} removeTrack
 * @property {() => void} close
 */

/**
 * Factory for outgoing/incoming connections (the WebRTC seam).
 * Defaults to the real startOffer/answerOffer; tests inject a FakeNetwork
 * transport to get deterministic, schedulable message delivery.
 * @typedef {Object} MeshTransport
 * @property {(callbacks?: import('./peer-connection.js').ConnectionCallbacks, rtcConfig?: RTCConfiguration, tracks?: MediaStreamTrack[]) => Promise<{offerSdp: string, acceptAnswer: (answerSdp: string) => Promise<MeshConnection>, cancel: () => void}>} startOffer
 * @property {(offerSdp: string, callbacks?: import('./peer-connection.js').ConnectionCallbacks, rtcConfig?: RTCConfiguration, tracks?: MediaStreamTrack[]) => Promise<{answerSdp: string, waitForConnect: () => Promise<MeshConnection>}>} answerOffer
 */

/**
 * Time source (the timer seam). Defaults to real timers; tests inject a
 * virtual clock so timeouts and anti-entropy can be advanced deterministically.
 * @typedef {Object} MeshClock
 * @property {(fn: () => void, ms: number) => number} setTimeout
 * @property {(id: number) => void} clearTimeout
 * @property {(fn: () => void, ms: number) => number} setInterval
 * @property {(id: number) => void} clearInterval
 * @property {() => number} now
 */

/**
 * @typedef {Object} MeshOptions
 * @property {number} [relayTimeoutMs]
 * @property {number} [antiEntropyMs]
 * @property {number} [unreachableGraceMs]
 * @property {MeshClock} [clock]
 */

/**
 * @typedef {Object} TokenData
 * @property {string} peerId
 * @property {string} name
 * @property {string} sdp
 * @property {RTCSdpType} type
 */

/**
 * @typedef {Object} ConnectedPeer
 * @property {string} id
 * @property {string} name
 * @property {MeshConnection} connection
 */

/**
 * Each peer owns and maintains its own entry. Merge rule: max(version) wins.
 * @typedef {Object} TopologyEntry
 * @property {string} id
 * @property {string} name
 * @property {number} version
 * @property {string[]} neighbors  - IDs this peer is directly connected to
 */

/**
 * @typedef {{ type: 'TOPOLOGY', entries: TopologyEntry[] }} TopologyMessage
 * @typedef {{ type: 'TOPOLOGY_UPDATE', entry: TopologyEntry }} TopologyUpdateMessage
 * @typedef {{ type: 'RELAY_OFFER', msgId: string, from: string, to: string, name: string, sdp: string }} RelayOfferMessage
 * @typedef {{ type: 'RELAY_ANSWER', msgId: string, replyTo: string, from: string, to: string, sdp: string }} RelayAnswerMessage
 * @typedef {{ type: 'PEER_META', name: string }} PeerMetaMessage
 * @typedef {{ type: 'CHAT', text: string, timestamp: number }} ChatMessage
 * @typedef {{ type: 'SCREEN_SHARE', active: boolean }} ScreenShareMessage
 * @typedef {TopologyMessage | TopologyUpdateMessage | RelayOfferMessage | RelayAnswerMessage | PeerMetaMessage | ChatMessage | ScreenShareMessage} MeshMessage
 */

/**
 * Mutable ref shared between a connection attempt and its callbacks.
 * `peerId` may be updated once the remote identity is learned (offerer side);
 * `discarded` is set when the attempt lost a duplicate-connection race, so its
 * late events must not affect the winning connection.
 * `connection` is set once this attempt's connection is registered in #peers;
 * onDisconnected only tears down the peer if it is still the registered one.
 * @typedef {{ peerId: string, discarded?: boolean, connection?: MeshConnection }} PeerIdRef
 */

/** @type {MeshClock} */
const defaultClock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  now: () => Date.now(),
};

/**
 * @typedef {Object} MeshCallbacks
 * @property {(peer: ConnectedPeer) => void} onPeerConnected
 * @property {(peerId: string) => void} onPeerDisconnected
 * @property {(fromId: string, message: MeshMessage) => void} onMessage
 * @property {(peerId: string, stream: MediaStream) => void} onRemoteStream
 */

const RELAY_TIMEOUT_MS = 20_000;
const RELAY_MAX_ATTEMPTS = 3;
const UNREACHABLE_GRACE_MS = 90_000;
const ANTI_ENTROPY_MS = 30_000;

export class PeerMesh {
  /** @type {string} */
  #myId = '';

  /** @type {string} */
  #myName = '';

  /** @type {Map<string, ConnectedPeer>} */
  #peers = new Map();

  /**
   * Outgoing relay connections waiting for a RELAY_ANSWER.
   * Each entry has a timeout; on expiry the attempt is cancelled and retried
   * (up to RELAY_MAX_ATTEMPTS), so a lost relay message can't permanently
   * block this peer pair from ever connecting. `msgId` is the offer's id;
   * answers must echo it (replyTo) so a stale answer can't complete a newer attempt.
   * @type {Map<string, {name: string, msgId: string, acceptAnswer: (answerSdp: string) => Promise<MeshConnection>, cancel: () => void, timer: number, peerIdRef: PeerIdRef}>}
   */
  #pendingOut = new Map();

  /**
   * Failed relay attempts per target peer. Reset when the target gossips a
   * newer topology entry (proof it's alive with changed state).
   * @type {Map<string, number>}
   */
  #relayAttempts = new Map();

  /**
   * Peers that look unreachable (no mutual-edge path from us in the topology),
   * mapped to when we first noticed. Entries still unreachable after
   * UNREACHABLE_GRACE_MS are pruned — this garbage-collects departed peers,
   * whose own entries nobody is authoritative to update. The grace period
   * covers transient asymmetry while gossip converges (e.g. a joining peer's
   * entry arriving before its neighbor's updated entry).
   * @type {Map<string, number>}
   */
  #unreachableSince = new Map();

  /** @type {MeshCallbacks} */
  #callbacks;

  /** @type {MediaStreamTrack[]} */
  #localTracks = [];

  /**
   * Known mesh topology: maps peer ID → its self-reported entry.
   * We are authoritative for our own entry; remote entries are accepted only if version is higher.
   * @type {Map<string, TopologyEntry>}
   */
  #topology = new Map();

  /** @type {number} */
  #myVersion = 0;

  /** O(1) seen-set for relay message deduplication. */
  /** @type {Set<string>} */
  #seenMsgIdSet = new Set();
  /** @type {string[]} */
  #seenMsgIdQueue = [];

  /** @type {number | undefined} */
  #antiEntropyInterval = undefined;

  /** @type {MeshTransport} */
  #transport;

  /** @type {MeshClock} */
  #clock;

  /** @type {number} */
  #relayTimeoutMs;

  /** @type {number} */
  #antiEntropyMs;

  /** @type {number} */
  #unreachableGraceMs;

  /**
   * @param {MeshCallbacks} callbacks
   * @param {MeshTransport} [transport] - connection factory; tests inject an in-memory fake
   * @param {MeshOptions} [opts] - timing overrides and virtual clock for tests
   */
  constructor(callbacks, transport, opts) {
    this.#callbacks = callbacks;
    this.#transport = transport ?? { startOffer, answerOffer };
    this.#clock = opts?.clock ?? defaultClock;
    this.#relayTimeoutMs = opts?.relayTimeoutMs ?? RELAY_TIMEOUT_MS;
    this.#antiEntropyMs = opts?.antiEntropyMs ?? ANTI_ENTROPY_MS;
    this.#unreachableGraceMs = opts?.unreachableGraceMs ?? UNREACHABLE_GRACE_MS;
  }

  /** IDs of currently connected peers (for tests and debugging). */
  get connectedPeerIds() {
    return [...this.#peers.keys()];
  }

  /** Deep copy of the known topology (for tests and debugging). */
  topologySnapshot() {
    return [...this.#topology.values()].map(e => ({ ...e, neighbors: [...e.neighbors] }));
  }

  /**
   * Build connection callbacks for a given peer.
   * @param {PeerIdRef} peerIdRef - mutable ref so offerer can update peerId after answer arrives
   * @returns {import('./peer-connection.js').ConnectionCallbacks}
   */
  #makeCallbacks(peerIdRef) {
    return {
      onRemoteStream: (stream) => {
        if (peerIdRef.discarded) return;
        this.#callbacks.onRemoteStream(peerIdRef.peerId, stream);
      },
      onDisconnected: () => {
        if (peerIdRef.discarded) return;
        // Only tear down the peer if this attempt's connection is the one
        // currently registered — a failing stale or duplicate attempt must
        // not evict a live connection to the same peer.
        const peer = this.#peers.get(peerIdRef.peerId);
        if (!peer || peer.connection !== peerIdRef.connection) return;
        this.#handlePeerDisconnected(peerIdRef.peerId);
      },
      onMessage: (data) => {
        if (peerIdRef.discarded) return;
        this.#handleMessage(peerIdRef.peerId, data);
      },
    };
  }

  /**
   * Create an offer token for a new peer to use when joining.
   * @param {string} myId
   * @param {string} myName
   * @returns {Promise<{offerLink: string, acceptAnswer: (answerTokenOrUrl: string) => Promise<void>}>}
   */
  async createInvite(myId, myName) {
    this.#myId = myId;
    this.#myName = myName;
    this.#updateMyEntry();


    /** @type {PeerIdRef} */
    const peerIdRef = { peerId: 'pending' };
    const { offerSdp, acceptAnswer: acceptAnswerSdp } = await this.#transport.startOffer(
      this.#makeCallbacks(peerIdRef),
      undefined,
      this.#localTracks,
    );

    const tokenData = /** @type {TokenData} */ ({
      peerId: myId,
      name: myName,
      sdp: offerSdp,
      type: 'offer'
    });
    const offerLink = `${location.href.split('#')[0]}#offer=${await encodeToken(tokenData)}`;

    const acceptAnswer = async (/** @type {string} */ input) => {
      const answerData = /** @type {TokenData} */ (await decodeToken(input.trim()));


      // Update the peer ID reference before setting remote description
      // so that any ontrack events that fire will have the correct peer ID
      peerIdRef.peerId = answerData.peerId;

      const connection = await acceptAnswerSdp(answerData.sdp);
      this.#registerPeer(answerData.peerId, answerData.name, connection, peerIdRef);
    };

    return { offerLink, acceptAnswer };
  }

  /**
   * Accept an offer token, returning an answer token string to send back to the inviter.
   * Connection completes asynchronously and fires onPeerConnected.
   * @param {string} offerInput
   * @param {string} myId
   * @param {string} myName
   * @returns {Promise<string>} answer token (raw base64, not a URL)
   */
  async acceptInvite(offerInput, myId, myName) {
    this.#myId = myId;
    this.#myName = myName;
    this.#updateMyEntry();

    const offerData = await this.#parseToken(offerInput);

    /** @type {PeerIdRef} */
    const peerIdRef = { peerId: offerData.peerId };
    const { answerSdp, waitForConnect } = await this.#transport.answerOffer(
      offerData.sdp,
      this.#makeCallbacks(peerIdRef),
      undefined,
      this.#localTracks,
    );

    // Connection completes asynchronously when the data channel opens
    waitForConnect().then(connection => {
      this.#registerPeer(offerData.peerId, offerData.name, connection, peerIdRef);
    }).catch(err => console.error('PeerMesh: connection failed', err));

    const tokenData = /** @type {TokenData} */ ({
      peerId: myId,
      name: myName,
      sdp: answerSdp,
      type: 'answer'
    });
    const answerToken = await encodeToken(tokenData);

    return answerToken;
  }

  /** @param {MeshMessage} message */
  broadcast(message) {
    const str = JSON.stringify(message);
    for (const peer of this.#peers.values()) {
      peer.connection.sendData(str);
    }
  }

  /**
   * @param {string} peerId
   * @param {MeshMessage} message
   */
  send(peerId, message) {
    const peer = this.#peers.get(peerId);
    if (peer) {
      peer.connection.sendData(JSON.stringify(message));
    }
  }

  /**
   * Add local media tracks to all existing peer connections and store for future connections.
   * This will trigger renegotiation for existing connections via the 'negotiationneeded' event.
   * @param {MediaStreamTrack[]} tracks
   */
  addLocalTracks(tracks) {
    this.#localTracks = tracks;

    // Add tracks to all existing peer connections
    for (const peer of this.#peers.values()) {
      peer.connection.addLocalTracks(tracks);
    }
  }

  /**
   * Replace (or remove) the track of a given kind in all peer connections
   * (screen sharing, device switching).
   * @param {'video' | 'audio'} kind
   * @param {MediaStreamTrack | null} newTrack - New track, or null to remove
   * @returns {Promise<void>}
   */
  async replaceTrack(kind, newTrack) {
    for (const peer of this.#peers.values()) {
      if (newTrack) {
        await peer.connection.replaceTrack(newTrack);
      } else {
        await peer.connection.removeTrack(kind);
      }
    }

    // Update stored local tracks
    this.#localTracks = this.#localTracks.filter(t => t.kind !== kind);
    if (newTrack) this.#localTracks.push(newTrack);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Parse a raw base64 token or a URL containing a fragment like `#offer=BASE64`.
   * @param {string} input
   * @returns {Promise<TokenData>}
   */
  async #parseToken(input) {
    const trimmed = input.trim();
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx === -1) {
      return /** @type {TokenData} */ (await decodeToken(trimmed));
    }
    const fragment = trimmed.slice(hashIdx + 1);
    const eqIdx = fragment.indexOf('=');
    const raw = eqIdx === -1 ? fragment : fragment.slice(eqIdx + 1);
    return /** @type {TokenData} */ (await decodeToken(raw));
  }

  /**
   * Update our own topology entry (call whenever our neighbor set changes).
   * @returns {TopologyEntry}
   */
  #updateMyEntry() {
    this.#myVersion++;
    const entry = /** @type {TopologyEntry} */ ({
      id: this.#myId,
      name: this.#myName,
      version: this.#myVersion,
      neighbors: [...this.#peers.keys()],
    });
    this.#topology.set(this.#myId, entry);
    return entry;
  }

  /**
   * Merge remote topology entries using LWW (last-write-wins by version).
   * We are authoritative for our own entry, so we skip it.
   * @param {TopologyEntry[]} entries
   * @returns {TopologyEntry[]} entries that were new or updated
   */
  #mergeTopology(entries) {
    /** @type {TopologyEntry[]} */
    const updated = [];
    for (const entry of entries) {
      if (entry.id === this.#myId) continue;
      const existing = this.#topology.get(entry.id);
      if (!existing || entry.version > existing.version) {
        this.#topology.set(entry.id, entry);
        // Fresh gossip from this peer proves it's alive: allow relay retries.
        this.#relayAttempts.delete(entry.id);
        updated.push(entry);
      }
    }
    if (updated.length > 0) this.#pruneTopology();
    return updated;
  }

  /**
   * Garbage-collect topology entries for departed peers.
   *
   * A peer is considered reachable if there is a path from us to it over
   * mutual edges (both entries list each other as neighbors); directly
   * connected peers are always reachable. When a peer leaves, its neighbors
   * drop it from their entries, so no mutual edge to it remains — but its own
   * entry lingers because only the owner may update an entry. Entries that
   * stay unreachable for UNREACHABLE_GRACE_MS are deleted.
   */
  #pruneTopology() {
    // Directly connected peers are reachable by definition, even if their
    // updated entry (listing us) hasn't arrived yet.
    const reachable = new Set([this.#myId, ...this.#peers.keys()]);
    const queue = [...reachable];
    while (queue.length > 0) {
      const id = /** @type {string} */ (queue.shift());
      const entry = this.#topology.get(id);
      if (!entry) continue;
      for (const n of entry.neighbors) {
        if (reachable.has(n)) continue;
        const nEntry = this.#topology.get(n);
        if (!nEntry || !nEntry.neighbors.includes(id)) continue; // require mutual edge
        reachable.add(n);
        queue.push(n);
      }
    }

    const now = this.#clock.now();
    for (const id of [...this.#topology.keys()]) {
      if (id === this.#myId || reachable.has(id)) {
        this.#unreachableSince.delete(id);
        continue;
      }
      const since = this.#unreachableSince.get(id);
      if (since === undefined) {
        this.#unreachableSince.set(id, now);
      } else if (now - since > this.#unreachableGraceMs) {
        this.#topology.delete(id);
        this.#unreachableSince.delete(id);
        this.#relayAttempts.delete(id);
      }
    }
  }

  /**
   * Check topology for peers we're not yet connected to and initiate relay connections.
   * The peer with the lexicographically lower ID is responsible for initiating,
   * preventing both sides from sending duplicate offers simultaneously.
   */
  #checkForNewPeers() {
    for (const [id, entry] of this.#topology) {
      if (id === this.#myId) continue;
      if (this.#peers.has(id)) continue;
      if (this.#pendingOut.has(id)) continue;
      if (this.#unreachableSince.has(id)) continue; // likely departed
      if ((this.#relayAttempts.get(id) ?? 0) >= RELAY_MAX_ATTEMPTS) continue;
      if (this.#myId < id) {
        this.#initiateRelayConnection(id, entry.name)
          .catch(err => console.error('PeerMesh: relay connection failed', err));
      }
    }
  }

  /**
   * Mark a relay msgId as seen. Returns true if already seen (message should be dropped).
   * Bounded to 500 entries via a circular queue.
   * @param {string} msgId
   * @returns {boolean}
   */
  #markSeen(msgId) {
    if (this.#seenMsgIdSet.has(msgId)) return true;
    this.#seenMsgIdSet.add(msgId);
    this.#seenMsgIdQueue.push(msgId);
    if (this.#seenMsgIdQueue.length > 500) {
      const evicted = this.#seenMsgIdQueue.shift();
      if (evicted) this.#seenMsgIdSet.delete(evicted);
    }
    return false;
  }

  /**
   * Start the anti-entropy interval: periodically sends a full TOPOLOGY
   * snapshot to all neighbors (heals third-party divergence, not just our own
   * entry — receivers merge and fan out anything they were missing), prunes
   * departed peers, and retries missing connections.
   */
  #startAntiEntropy() {
    if (this.#antiEntropyInterval !== undefined) return;
    this.#antiEntropyInterval = this.#clock.setInterval(() => {
      this.#pruneTopology();
      this.#checkForNewPeers();
      if (this.#peers.size === 0) return;
      const str = JSON.stringify(/** @type {TopologyMessage} */({
        type: 'TOPOLOGY',
        entries: [...this.#topology.values()],
      }));
      for (const p of this.#peers.values()) {
        p.connection.sendData(str);
      }
    }, this.#antiEntropyMs);
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {MeshConnection} connection
   * @param {PeerIdRef} peerIdRef
   */
  #registerPeer(id, name, connection, peerIdRef) {
    if (this.#peers.has(id)) {
      // Already connected (e.g. simultaneous invite + relay). Discard the
      // loser: mark its callbacks inert so closing it doesn't tear down the
      // winning connection's peer entry.
      peerIdRef.discarded = true;
      connection.close();
      return;
    }
    peerIdRef.connection = connection;


    /** @type {ConnectedPeer} */
    const peer = { id, name, connection };
    this.#peers.set(id, peer);

    // Update our own entry to include the new neighbor
    const myEntry = this.#updateMyEntry();

    // Send full topology (anti-entropy sync) to the new peer
    connection.sendData(JSON.stringify(/** @type {TopologyMessage} */({
      type: 'TOPOLOGY',
      entries: [...this.#topology.values()],
    })));

    this.#callbacks.onPeerConnected(peer);

    // Broadcast our updated entry to all other peers
    const updateMsg = JSON.stringify(/** @type {TopologyUpdateMessage} */({
      type: 'TOPOLOGY_UPDATE',
      entry: myEntry,
    }));
    for (const p of this.#peers.values()) {
      if (p.id !== id) {
        p.connection.sendData(updateMsg);
      }
    }

    this.#startAntiEntropy();
  }

  /** @param {string} peerId */
  #handlePeerDisconnected(peerId) {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    this.#peers.delete(peerId);
    peer.connection.close(); // release the RTCPeerConnection (idempotent)
    this.#callbacks.onPeerDisconnected(peerId);

    // Update our own entry to remove the departed neighbor
    const myEntry = this.#updateMyEntry();
    const updateMsg = JSON.stringify(/** @type {TopologyUpdateMessage} */({
      type: 'TOPOLOGY_UPDATE',
      entry: myEntry,
    }));
    for (const p of this.#peers.values()) {
      p.connection.sendData(updateMsg);
    }
    this.#pruneTopology();
  }

  /**
   * @param {string} fromId
   * @param {string} rawData
   */
  #handleMessage(fromId, rawData) {
    /** @type {MeshMessage} */
    let message;
    try {
      const parsed = /** @type {unknown} */ (JSON.parse(rawData));
      if (typeof parsed !== 'object' || parsed === null || typeof (/** @type {{type?: unknown}} */ (parsed).type) !== 'string') {
        throw new Error('not a mesh message');
      }
      message = /** @type {MeshMessage} */ (parsed);
    } catch {
      return;
    }

    if (message.type === 'TOPOLOGY') {
      const updated = this.#mergeTopology(message.entries);
      if (updated.length > 0) {
        // Fan-out newly-learned entries to all other peers (same as TOPOLOGY_UPDATE)
        for (const entry of updated) {
          const str = JSON.stringify(/** @type {TopologyUpdateMessage} */({ type: 'TOPOLOGY_UPDATE', entry }));
          for (const p of this.#peers.values()) {
            if (p.id !== fromId) p.connection.sendData(str);
          }
        }
        this.#checkForNewPeers();
      }
    } else if (message.type === 'TOPOLOGY_UPDATE') {
      const updated = this.#mergeTopology([message.entry]);
      if (updated.length > 0) {
        // Fan-out: re-gossip to all peers except the sender
        const str = JSON.stringify(message);
        for (const p of this.#peers.values()) {
          if (p.id !== fromId) p.connection.sendData(str);
        }
        this.#checkForNewPeers();
      }
    } else if (message.type === 'RELAY_OFFER') {
      if (this.#markSeen(message.msgId)) return;
      if (message.to === this.#myId) {
        this.#handleRelayOffer(message).catch(err => console.error('PeerMesh: handleRelayOffer failed', err));
      } else {
        // Flood to all peers except sender
        const str = JSON.stringify(message);
        for (const p of this.#peers.values()) {
          if (p.id !== fromId) p.connection.sendData(str);
        }
      }
    } else if (message.type === 'RELAY_ANSWER') {
      if (this.#markSeen(message.msgId)) return;
      if (message.to === this.#myId) {
        this.#handleRelayAnswer(message).catch(err => console.error('PeerMesh: handleRelayAnswer failed', err));
      } else {
        // Flood to all peers except sender
        const str = JSON.stringify(message);
        for (const p of this.#peers.values()) {
          if (p.id !== fromId) p.connection.sendData(str);
        }
      }
    } else {
      this.#callbacks.onMessage(fromId, message);
    }
  }

  /**
   * @param {string} targetId
   * @param {string} targetName
   */
  async #initiateRelayConnection(targetId, targetName) {
    if (this.#peers.has(targetId)) return;
    if (this.#pendingOut.has(targetId)) return;


    /** @type {PeerIdRef} */
    const peerIdRef = { peerId: targetId };
    const { offerSdp, acceptAnswer, cancel } = await this.#transport.startOffer(
      this.#makeCallbacks(peerIdRef),
      undefined,
      this.#localTracks,
    );

    const msgId = crypto.randomUUID();
    this.#markSeen(msgId); // Prevent re-processing if flooded back to us

    // If no RELAY_ANSWER arrives (message lost, target gone), abandon the
    // attempt so this pair isn't blocked forever, and retry up to the cap.
    const timer = this.#clock.setTimeout(() => {
      if (this.#pendingOut.get(targetId) !== pending) return;
      this.#pendingOut.delete(targetId);
      peerIdRef.discarded = true;
      cancel();
      const attempts = (this.#relayAttempts.get(targetId) ?? 0) + 1;
      this.#relayAttempts.set(targetId, attempts);
      this.#checkForNewPeers();
    }, this.#relayTimeoutMs);

    const pending = { name: targetName, msgId, acceptAnswer, cancel, timer, peerIdRef };
    this.#pendingOut.set(targetId, pending);

    const str = JSON.stringify(/** @type {RelayOfferMessage} */({
      type: 'RELAY_OFFER',
      msgId,
      from: this.#myId,
      to: targetId,
      name: this.#myName,
      sdp: offerSdp,
    }));
    for (const p of this.#peers.values()) {
      p.connection.sendData(str);
    }
  }

  /** @param {RelayOfferMessage} message */
  async #handleRelayOffer(message) {
    if (this.#peers.has(message.from)) {
      return; // already connected
    }

    /** @type {PeerIdRef} */
    const peerIdRef = { peerId: message.from };
    const { answerSdp, waitForConnect } = await this.#transport.answerOffer(
      message.sdp,
      this.#makeCallbacks(peerIdRef),
      undefined,
      this.#localTracks,
    );

    // Connection completes asynchronously when the data channel opens
    waitForConnect().then(connection => {
      this.#registerPeer(message.from, message.name, connection, peerIdRef);
    }).catch(err => console.error('PeerMesh: relay connection failed', err));

    const msgId = crypto.randomUUID();
    this.#markSeen(msgId); // Prevent re-processing if flooded back to us

    const str = JSON.stringify(/** @type {RelayAnswerMessage} */({
      type: 'RELAY_ANSWER',
      msgId,
      replyTo: message.msgId,
      from: this.#myId,
      to: message.from,
      sdp: answerSdp,
    }));
    for (const p of this.#peers.values()) {
      p.connection.sendData(str);
    }
  }

  /** @param {RelayAnswerMessage} message */
  async #handleRelayAnswer(message) {
    const pending = this.#pendingOut.get(message.from);
    if (!pending) {
      return;
    }
    if (message.replyTo !== pending.msgId) {
      // Answer to an earlier, already-abandoned offer (e.g. it arrived after
      // our timeout retried). The current attempt is still waiting for its
      // own answer — keep it.
      return;
    }
    this.#pendingOut.delete(message.from);
    this.#clock.clearTimeout(pending.timer);

    try {
      const connection = await pending.acceptAnswer(message.sdp);
      this.#registerPeer(message.from, pending.name, connection, pending.peerIdRef);
    } catch (err) {
      pending.peerIdRef.discarded = true;
      pending.cancel();
      const attempts = (this.#relayAttempts.get(message.from) ?? 0) + 1;
      this.#relayAttempts.set(message.from, attempts);
    }
  }
}
