// @ts-check

import { startOffer, answerOffer, Connection } from './peer-connection.js';
import { encodeToken, decodeToken } from './utils.js';

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
 * @property {Connection} connection
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
 * @typedef {{ type: 'RELAY_ANSWER', msgId: string, from: string, to: string, sdp: string }} RelayAnswerMessage
 * @typedef {{ type: 'PEER_META', name: string }} PeerMetaMessage
 * @typedef {{ type: 'PEER_LEFT' }} PeerLeftMessage
 * @typedef {{ type: 'CHAT', text: string, timestamp: number }} ChatMessage
 * @typedef {{ type: 'SCREEN_SHARE', active: boolean }} ScreenShareMessage
 * @typedef {TopologyMessage | TopologyUpdateMessage | RelayOfferMessage | RelayAnswerMessage | PeerMetaMessage | PeerLeftMessage | ChatMessage | ScreenShareMessage} MeshMessage
 */

/**
 * @typedef {Object} MeshCallbacks
 * @property {(peer: ConnectedPeer) => void} onPeerConnected
 * @property {(peerId: string) => void} onPeerDisconnected
 * @property {(fromId: string, message: MeshMessage) => void} onMessage
 * @property {(peerId: string, stream: MediaStream) => void} onRemoteStream
 */

export class PeerMesh {
  /** @type {string} */
  #myId = '';

  /** @type {string} */
  #myName = '';

  /** @type {Map<string, ConnectedPeer>} */
  #peers = new Map();

  /**
   * Outgoing relay connections waiting for a RELAY_ANSWER.
   * @type {Map<string, {name: string, acceptAnswer: (answerSdp: string) => Promise<Connection>}>}
   */
  #pendingOut = new Map();

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

  /** @type {ReturnType<typeof setInterval> | undefined} */
  #antiEntropyInterval = undefined;

  /** @param {MeshCallbacks} callbacks */
  constructor(callbacks) {
    this.#callbacks = callbacks;
  }

  /** Log the current known topology in a readable format. */
  #logTopology() {
    const rows = [...this.#topology.values()].map(e =>
      `  ${e.id === this.#myId ? '*' : ' '}${e.id.slice(0, 8)} "${e.name}" v${e.version} → [${e.neighbors.map(n => n.slice(0, 8)).join(', ')}]`
    );
    console.log(`[mesh] topology (${this.#topology.size} known, ${this.#peers.size} connected):\n${rows.join('\n')}`);
  }

  /**
   * Build connection callbacks for a given peer.
   * @param {{ peerId: string }} peerIdRef - mutable ref so offerer can update peerId after answer arrives
   * @returns {import('./peer-connection.js').ConnectionCallbacks}
   */
  #makeCallbacks(peerIdRef) {
    return {
      onRemoteStream: (stream) => {
        this.#callbacks.onRemoteStream(peerIdRef.peerId, stream);
      },
      onDisconnected: () => {
        this.#handlePeerDisconnected(peerIdRef.peerId);
      },
      onMessage: (data) => {
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

    console.log(`[mesh] createInvite: myId=${myId.slice(0, 8)} name="${myName}"`);

    const peerIdRef = { peerId: 'pending' };
    const { offerSdp, acceptAnswer: acceptAnswerSdp } = await startOffer(
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
    const offerLink = `${location.href.split('#')[0]}#offer=${encodeToken(tokenData)}`;

    const acceptAnswer = async (/** @type {string} */ input) => {
      const answerData = /** @type {TokenData} */ (decodeToken(input.trim()));

      console.log(`[mesh] acceptAnswer: peer=${answerData.peerId.slice(0, 8)} name="${answerData.name}"`);

      // Update the peer ID reference before setting remote description
      // so that any ontrack events that fire will have the correct peer ID
      peerIdRef.peerId = answerData.peerId;

      const connection = await acceptAnswerSdp(answerData.sdp);
      this.#registerPeer(answerData.peerId, answerData.name, connection);
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

    const offerData = this.#parseToken(offerInput);
    console.log(`[mesh] acceptInvite: myId=${myId.slice(0, 8)} name="${myName}" offerFrom=${offerData.peerId.slice(0, 8)} name="${offerData.name}"`);

    const peerIdRef = { peerId: offerData.peerId };
    const { answerSdp, waitForConnect } = await answerOffer(
      offerData.sdp,
      this.#makeCallbacks(peerIdRef),
      undefined,
      this.#localTracks,
    );

    // Connection completes asynchronously when the data channel opens
    waitForConnect().then(connection => {
      this.#registerPeer(offerData.peerId, offerData.name, connection);
    }).catch(err => console.error('PeerMesh: connection failed', err));

    const tokenData = /** @type {TokenData} */ ({
      peerId: myId,
      name: myName,
      sdp: answerSdp,
      type: 'answer'
    });
    const answerToken = encodeToken(tokenData);

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
   * Replace the video track in all peer connections (for screen sharing).
   * @param {MediaStreamTrack | null} newTrack - New video track, or null to remove video
   * @returns {Promise<void>}
   */
  async replaceVideoTrack(newTrack) {
    for (const peer of this.#peers.values()) {
      if (newTrack) {
        await peer.connection.replaceTrack(newTrack);
      } else {
        await peer.connection.removeTrack('video');
      }
    }

    // Update stored local tracks
    if (newTrack) {
      this.#localTracks = this.#localTracks.filter(t => t.kind !== 'video');
      this.#localTracks.push(newTrack);
    } else {
      this.#localTracks = this.#localTracks.filter(t => t.kind !== 'video');
    }
  }

  /**
   * Replace the audio track in all peer connections (for device switching).
   * @param {MediaStreamTrack | null} newTrack - New audio track, or null to remove audio
   * @returns {Promise<void>}
   */
  async replaceAudioTrack(newTrack) {
    for (const peer of this.#peers.values()) {
      if (newTrack) {
        await peer.connection.replaceTrack(newTrack);
      } else {
        await peer.connection.removeTrack('audio');
      }
    }

    // Update stored local tracks
    if (newTrack) {
      this.#localTracks = this.#localTracks.filter(t => t.kind !== 'audio');
      this.#localTracks.push(newTrack);
    } else {
      this.#localTracks = this.#localTracks.filter(t => t.kind !== 'audio');
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Parse a raw base64 token or a URL containing a fragment like `#offer=BASE64`.
   * @param {string} input
   * @returns {TokenData}
   */
  #parseToken(input) {
    const trimmed = input.trim();
    const hashIdx = trimmed.indexOf('#');
    if (hashIdx === -1) {
      return /** @type {TokenData} */ (decodeToken(trimmed));
    }
    const fragment = trimmed.slice(hashIdx + 1);
    const eqIdx = fragment.indexOf('=');
    const raw = eqIdx === -1 ? fragment : fragment.slice(eqIdx + 1);
    return /** @type {TokenData} */ (decodeToken(raw));
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
        updated.push(entry);
      }
    }
    return updated;
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
   * Start a 30-second anti-entropy interval that re-gossips our own topology entry.
   * This heals any divergence caused by dropped j messages.
   */
  #startAntiEntropy() {
    if (this.#antiEntropyInterval !== undefined) return;
    this.#antiEntropyInterval = setInterval(() => {
      const entry = this.#topology.get(this.#myId);
      if (!entry || this.#peers.size === 0) return;
      const str = JSON.stringify(/** @type {TopologyUpdateMessage} */({
        type: 'TOPOLOGY_UPDATE',
        entry,
      }));
      for (const p of this.#peers.values()) {
        p.connection.sendData(str);
      }
    }, 30_000);
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {Connection} connection
   */
  #registerPeer(id, name, connection) {
    if (this.#peers.has(id)) return; // already connected (shouldn't happen, but guard it)

    console.log(`[mesh] peer connected: ${id.slice(0, 8)} "${name}"`);

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

    this.#logTopology();
    this.#startAntiEntropy();
  }

  /** @param {string} peerId */
  #handlePeerDisconnected(peerId) {
    if (!this.#peers.has(peerId)) return;
    console.log(`[mesh] peer disconnected: ${peerId.slice(0, 8)}`);
    this.#peers.delete(peerId);
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
    this.#logTopology();
  }

  /**
   * @param {string} fromId
   * @param {string} rawData
   */
  #handleMessage(fromId, rawData) {
    const message = /** @type {MeshMessage} */ (JSON.parse(rawData));

    if (message.type === 'TOPOLOGY') {
      const updated = this.#mergeTopology(message.entries);
      if (updated.length > 0) {
        console.log(`[mesh] TOPOLOGY from ${fromId.slice(0, 8)}: merged ${updated.length} new/updated entries`);
        // Fan-out newly-learned entries to all other peers (same as TOPOLOGY_UPDATE)
        for (const entry of updated) {
          const str = JSON.stringify(/** @type {TopologyUpdateMessage} */({ type: 'TOPOLOGY_UPDATE', entry }));
          for (const p of this.#peers.values()) {
            if (p.id !== fromId) p.connection.sendData(str);
          }
        }
        this.#checkForNewPeers();
        this.#logTopology();
      }
    } else if (message.type === 'TOPOLOGY_UPDATE') {
      const updated = this.#mergeTopology([message.entry]);
      if (updated.length > 0) {
        console.log(`[mesh] TOPOLOGY_UPDATE from ${fromId.slice(0, 8)}: ${message.entry.id.slice(0, 8)} "${message.entry.name}" v${message.entry.version} neighbors=[${message.entry.neighbors.map(n => n.slice(0, 8)).join(', ')}]`);
        // Fan-out: re-gossip to all peers except the sender
        const str = JSON.stringify(message);
        for (const p of this.#peers.values()) {
          if (p.id !== fromId) p.connection.sendData(str);
        }
        this.#checkForNewPeers();
        this.#logTopology();
      }
    } else if (message.type === 'RELAY_OFFER') {
      if (this.#markSeen(message.msgId)) return;
      if (message.to === this.#myId) {
        console.log(`[mesh] RELAY_OFFER for me from ${message.from.slice(0, 8)} "${message.name}"`);
        this.#handleRelayOffer(message).catch(err => console.error('PeerMesh: handleRelayOffer failed', err));
      } else {
        console.log(`[mesh] RELAY_OFFER relay: ${message.from.slice(0, 8)} → ${message.to.slice(0, 8)}`);
        // Flood to all peers except sender
        const str = JSON.stringify(message);
        for (const p of this.#peers.values()) {
          if (p.id !== fromId) p.connection.sendData(str);
        }
      }
    } else if (message.type === 'RELAY_ANSWER') {
      if (this.#markSeen(message.msgId)) return;
      if (message.to === this.#myId) {
        console.log(`[mesh] RELAY_ANSWER for me from ${message.from.slice(0, 8)}`);
        this.#handleRelayAnswer(message).catch(err => console.error('PeerMesh: handleRelayAnswer failed', err));
      } else {
        console.log(`[mesh] RELAY_ANSWER relay: ${message.from.slice(0, 8)} → ${message.to.slice(0, 8)}`);
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

    console.log(`[mesh] initiating relay connection to ${targetId.slice(0, 8)} "${targetName}"`);

    const peerIdRef = { peerId: targetId };
    const { offerSdp, acceptAnswer } = await startOffer(
      this.#makeCallbacks(peerIdRef),
      undefined,
      this.#localTracks,
    );
    this.#pendingOut.set(targetId, { name: targetName, acceptAnswer });

    const msgId = crypto.randomUUID();
    this.#markSeen(msgId); // Prevent re-processing if flooded back to us

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
      console.log(`[mesh] RELAY_OFFER from ${message.from.slice(0, 8)}: already connected, ignoring`);
      return; // already connected
    }

    const peerIdRef = { peerId: message.from };
    const { answerSdp, waitForConnect } = await answerOffer(
      message.sdp,
      this.#makeCallbacks(peerIdRef),
      undefined,
      this.#localTracks,
    );

    // Connection completes asynchronously when the data channel opens
    waitForConnect().then(connection => {
      this.#registerPeer(message.from, message.name, connection);
    }).catch(err => console.error('PeerMesh: relay connection failed', err));

    const msgId = crypto.randomUUID();
    this.#markSeen(msgId); // Prevent re-processing if flooded back to us

    const str = JSON.stringify(/** @type {RelayAnswerMessage} */({
      type: 'RELAY_ANSWER',
      msgId,
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
      console.warn(`[mesh] RELAY_ANSWER from ${message.from.slice(0, 8)}: no pending connection, ignoring`);
      return;
    }
    this.#pendingOut.delete(message.from);

    const connection = await pending.acceptAnswer(message.sdp);
    this.#registerPeer(message.from, pending.name, connection);
  }
}
