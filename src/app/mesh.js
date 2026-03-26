// @ts-check

import { defaultIceServers } from 'webrtc-mini';
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
 * @property {RTCPeerConnection} connection
 * @property {RTCDataChannel} channel
 */

/**
 * @typedef {{ type: 'PEER_LIST', peers: Array<{id: string, name: string}> }} PeerListMessage
 * @typedef {{ type: 'RELAY_OFFER', from: string, to: string, name: string, sdp: string }} RelayOfferMessage
 * @typedef {{ type: 'RELAY_ANSWER', from: string, to: string, sdp: string }} RelayAnswerMessage
 * @typedef {{ type: 'PEER_META', name: string }} PeerMetaMessage
 * @typedef {{ type: 'PEER_LEFT' }} PeerLeftMessage
 * @typedef {{ type: 'CHAT', text: string, timestamp: number }} ChatMessage
 * @typedef {{ type: 'SCREEN_SHARE', active: boolean }} ScreenShareMessage
 * @typedef {{ type: 'RENEGOTIATE_OFFER', sdp: string }} RenegotiateOfferMessage
 * @typedef {{ type: 'RENEGOTIATE_ANSWER', sdp: string }} RenegotiateAnswerMessage
 * @typedef {PeerListMessage | RelayOfferMessage | RelayAnswerMessage | PeerMetaMessage | PeerLeftMessage | ChatMessage | ScreenShareMessage | RenegotiateOfferMessage | RenegotiateAnswerMessage} MeshMessage
 */

/**
 * @typedef {Object} MeshCallbacks
 * @property {(peer: ConnectedPeer) => void} onPeerConnected
 * @property {(peerId: string) => void} onPeerDisconnected
 * @property {(fromId: string, message: MeshMessage) => void} onMessage
 * @property {(peerId: string, stream: MediaStream) => void} onRemoteStream
 */

/**
 * Wait for ICE gathering to reach the 'complete' state.
 * @param {RTCPeerConnection} connection
 * @returns {Promise<void>}
 */
function waitIceComplete(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const handler = () => {
      if (connection.iceGatheringState === 'complete') {
        connection.removeEventListener('icegatheringstatechange', handler);
        resolve();
      }
    };
    connection.addEventListener('icegatheringstatechange', handler);
  });
}

export class PeerMesh {
  /** @type {string} */
  #myId = '';

  /** @type {string} */
  #myName = '';

  /** @type {Map<string, ConnectedPeer>} */
  #peers = new Map();

  /**
   * Outgoing relay connections waiting for a RELAY_ANSWER.
   * @type {Map<string, {connection: RTCPeerConnection, channel: RTCDataChannel, name: string}>}
   */
  #pendingOut = new Map();

  /** @type {MeshCallbacks} */
  #callbacks;

  /** @type {MediaStreamTrack[]} */
  #localTracks = [];

  /** @type {WeakMap<RTCPeerConnection, string>} */
  #connectionToPeerId = new WeakMap();

  /**
   * Track negotiation state per peer to implement perfect negotiation.
   * @type {Map<string, { makingOffer: boolean, ignoreOffer: boolean }>}
   */
  #negotiationState = new Map();

  /** @param {MeshCallbacks} callbacks */
  constructor(callbacks) {
    this.#callbacks = callbacks;
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

    // Note: peerId not known yet, will be set when answer arrives
    const connection = this.#createConnection('pending');
    const channel = connection.createDataChannel('mesh');

    const offer = await this.#gatherOffer(connection);

    const tokenData = /** @type {TokenData} */ ({ peerId: myId, name: myName, sdp: offer.sdp ?? '', type: offer.type });
    const offerLink = `${location.href.split('#')[0]}#offer=${encodeToken(tokenData)}`;

    const acceptAnswer = async (/** @type {string} */ input) => {
      const answerData = /** @type {TokenData} */ (decodeToken(input.trim()));
      // Update the peer ID mapping BEFORE setting remote description
      // so that any ontrack events get the correct peer ID
      this.#connectionToPeerId.set(connection, answerData.peerId);
      await connection.setRemoteDescription(new RTCSessionDescription({ sdp: answerData.sdp, type: answerData.type }));
      await this.#waitChannelOpen(channel);
      this.#registerPeer(answerData.peerId, answerData.name, connection, channel, true);
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

    const offerData = this.#parseToken(offerInput);
    const connection = this.#createConnection(offerData.peerId);

    /** @type {Promise<RTCDataChannel>} */
    const channelReady = new Promise((resolve) => {
      connection.addEventListener('datachannel', (e) => resolve(e.channel), { once: true });
    });

    await connection.setRemoteDescription(new RTCSessionDescription({ sdp: offerData.sdp, type: offerData.type }));
    const answer = await this.#gatherAnswer(connection);

    const tokenData = /** @type {TokenData} */ ({ peerId: myId, name: myName, sdp: answer.sdp ?? '', type: answer.type });
    const answerToken = encodeToken(tokenData);

    channelReady.then(async (channel) => {
      await this.#waitChannelOpen(channel);
      this.#registerPeer(offerData.peerId, offerData.name, connection, channel, false);
    }).catch((err) => console.error('PeerMesh: acceptInvite channel error', err));

    return answerToken;
  }

  /** @param {MeshMessage} message */
  broadcast(message) {
    const str = JSON.stringify(message);
    for (const peer of this.#peers.values()) {
      if (peer.channel.readyState === 'open') peer.channel.send(str);
    }
  }

  /**
   * @param {string} peerId
   * @param {MeshMessage} message
   */
  send(peerId, message) {
    const peer = this.#peers.get(peerId);
    if (peer?.channel.readyState === 'open') peer.channel.send(JSON.stringify(message));
  }

  /**
   * Add local media tracks to all existing peer connections and store for future connections.
   * This will trigger renegotiation for existing connections via the 'negotiationneeded' event.
   * @param {MediaStreamTrack[]} tracks
   */
  addLocalTracks(tracks) {
    this.#localTracks = tracks;

    // Create a MediaStream from the tracks so they're properly grouped
    const stream = new MediaStream(tracks);

    // Add tracks to all existing peer connections with the stream
    // This will automatically trigger 'negotiationneeded' event for each connection
    for (const peer of this.#peers.values()) {
      for (const track of tracks) {
        peer.connection.addTrack(track, stream);
      }
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Set up a new RTCPeerConnection with local tracks and remote stream handler.
   * @param {string} peerId
   * @returns {RTCPeerConnection}
   */
  #createConnection(peerId) {
    const connection = new RTCPeerConnection({ iceServers: defaultIceServers });

    // Store mapping for later updates
    this.#connectionToPeerId.set(connection, peerId);

    // Initialize negotiation state
    this.#negotiationState.set(peerId, { makingOffer: false, ignoreOffer: false });

    // Add local tracks if available
    if (this.#localTracks.length > 0) {
      const stream = new MediaStream(this.#localTracks);
      for (const track of this.#localTracks) {
        connection.addTrack(track, stream);
      }
    }

    // Handle incoming remote tracks
    /** @type {Map<string, MediaStream>} */
    const remoteStreams = new Map();

    connection.addEventListener('track', (e) => {
      const stream = e.streams[0];
      // Always get the current peer ID from the mapping, not the closure
      const currentPeerId = this.#connectionToPeerId.get(connection) ?? peerId;
      if (stream && !remoteStreams.has(stream.id)) {
        remoteStreams.set(stream.id, stream);
        this.#callbacks.onRemoteStream(currentPeerId, stream);
      }
    });

    // Handle negotiation needed (when tracks are added/removed dynamically)
    connection.addEventListener('negotiationneeded', async () => {
      const actualPeerId = this.#connectionToPeerId.get(connection) ?? peerId;
      const peer = this.#peers.get(actualPeerId);
      if (!peer) return; // Not registered yet, initial negotiation handles this

      await this.#handleNegotiationNeeded(actualPeerId, peer);
    });

    return connection;
  }

  /**
   * Handle negotiation needed event - send renegotiation offer to peer.
   * Uses perfect negotiation pattern to avoid glare.
   * @param {string} peerId
   * @param {ConnectedPeer} peer
   */
  async #handleNegotiationNeeded(peerId, peer) {
    const state = this.#negotiationState.get(peerId);
    if (!state) return;

    try {
      state.makingOffer = true;

      await peer.connection.setLocalDescription();
      const offer = peer.connection.localDescription;
      if (!offer) return;

      this.send(peerId, {
        type: 'RENEGOTIATE_OFFER',
        sdp: offer.sdp ?? '',
      });
    } catch (err) {
      console.error('PeerMesh: Failed to create renegotiation offer:', err);
    } finally {
      state.makingOffer = false;
    }
  }

  /**
   * Determine if this peer is "polite" in the perfect negotiation pattern.
   * Polite peer yields during conflicts. Based on lexicographic peer ID comparison.
   * @param {string} remotePeerId
   * @returns {boolean}
   */
  #isPolite(remotePeerId) {
    return this.#myId < remotePeerId;
  }

  /**
   * @param {RTCPeerConnection} connection
   * @returns {Promise<RTCSessionDescription>}
   */
  async #gatherOffer(connection) {
    const offerInit = await connection.createOffer();
    await connection.setLocalDescription(offerInit);
    await waitIceComplete(connection);
    return /** @type {RTCSessionDescription} */ (connection.localDescription);
  }

  /**
   * @param {RTCPeerConnection} connection
   * @returns {Promise<RTCSessionDescription>}
   */
  async #gatherAnswer(connection) {
    const answerInit = await connection.createAnswer();
    await connection.setLocalDescription(answerInit);
    await waitIceComplete(connection);
    return /** @type {RTCSessionDescription} */ (connection.localDescription);
  }

  /**
   * @param {RTCDataChannel} channel
   * @returns {Promise<void>}
   */
  #waitChannelOpen(channel) {
    if (channel.readyState === 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      channel.addEventListener('open', () => resolve(), { once: true });
      channel.addEventListener('error', (e) => reject(e), { once: true });
    });
  }

  /**
   * Parse a raw base64 token or a URL containing a fragment like `#offer=BASE64`.
   * @param {string} input
   * @returns {TokenData}
   */
  #parseToken(input) {
    const trimmed = input.trim();
    const hashIdx = trimmed.indexOf('#');
    const fragment = hashIdx === -1 ? trimmed : trimmed.slice(hashIdx + 1);
    const eqIdx = fragment.indexOf('=');
    const raw = eqIdx === -1 ? fragment : fragment.slice(eqIdx + 1);
    return /** @type {TokenData} */ (decodeToken(raw));
  }

  /**
   * @param {string} id
   * @param {string} name
   * @param {RTCPeerConnection} connection
   * @param {RTCDataChannel} channel
   * @param {boolean} sendPeerList — true when we're the one who invited this peer (A side)
   */
  #registerPeer(id, name, connection, channel, sendPeerList) {
    if (this.#peers.has(id)) return; // already connected (shouldn't happen, but guard it)

    // Update the connection-to-peerId mapping with the actual peer ID
    this.#connectionToPeerId.set(connection, id);

    /** @type {ConnectedPeer} */
    const peer = { id, name, connection, channel };
    this.#peers.set(id, peer);

    channel.addEventListener('message', (e) => {
      if (typeof e.data === 'string') this.#handleMessage(id, e.data);
    });

    const disconnect = () => this.#handlePeerDisconnected(id);
    connection.addEventListener('iceconnectionstatechange', () => {
      if (connection.iceConnectionState === 'failed' || connection.iceConnectionState === 'disconnected') {
        disconnect();
      }
    });
    channel.addEventListener('close', disconnect);

    if (sendPeerList) {
      const others = [...this.#peers.values()]
        .filter(p => p.id !== id)
        .map(p => ({ id: p.id, name: p.name }));
      if (others.length > 0) {
        channel.send(JSON.stringify(/** @type {PeerListMessage} */({ type: 'PEER_LIST', peers: others })));
      }
    }

    this.#callbacks.onPeerConnected(peer);
  }

  /** @param {string} peerId */
  #handlePeerDisconnected(peerId) {
    if (!this.#peers.has(peerId)) return;
    this.#peers.delete(peerId);
    this.#callbacks.onPeerDisconnected(peerId);
  }

  /**
   * @param {string} fromId
   * @param {string} rawData
   */
  #handleMessage(fromId, rawData) {
    const message = /** @type {MeshMessage} */ (JSON.parse(rawData));

    if (message.type === 'PEER_LIST') {
      // Fire-and-forget; each relay connection is independent
      for (const peerInfo of message.peers) {
        this.#initiateRelayConnection(peerInfo.id, peerInfo.name)
          .catch(err => console.error('PeerMesh: relay connection failed', err));
      }
    } else if (message.type === 'RELAY_OFFER') {
      if (message.to === this.#myId) {
        this.#handleRelayOffer(message, fromId).catch(err => console.error('PeerMesh: handleRelayOffer failed', err));
      } else {
        this.send(message.to, message);
      }
    } else if (message.type === 'RELAY_ANSWER') {
      if (message.to === this.#myId) {
        this.#handleRelayAnswer(message).catch(err => console.error('PeerMesh: handleRelayAnswer failed', err));
      } else {
        this.send(message.to, message);
      }
    } else if (message.type === 'RENEGOTIATE_OFFER') {
      this.#handleRenegotiateOffer(fromId, message).catch(err => console.error('PeerMesh: handleRenegotiateOffer failed', err));
    } else if (message.type === 'RENEGOTIATE_ANSWER') {
      this.#handleRenegotiateAnswer(fromId, message).catch(err => console.error('PeerMesh: handleRenegotiateAnswer failed', err));
    } else {
      this.#callbacks.onMessage(fromId, message);
    }
  }

  /**
   * Handle incoming renegotiation offer using perfect negotiation pattern.
   * @param {string} fromId
   * @param {RenegotiateOfferMessage} message
   */
  async #handleRenegotiateOffer(fromId, message) {
    const peer = this.#peers.get(fromId);
    if (!peer) return;

    const state = this.#negotiationState.get(fromId);
    if (!state) return;

    const polite = this.#isPolite(fromId);
    const offerCollision = state.makingOffer || peer.connection.signalingState !== 'stable';

    state.ignoreOffer = !polite && offerCollision;
    if (state.ignoreOffer) return;

    try {
      await peer.connection.setRemoteDescription({
        type: 'offer',
        sdp: message.sdp,
      });

      await peer.connection.setLocalDescription();
      const answer = peer.connection.localDescription;
      if (!answer) return;

      this.send(fromId, {
        type: 'RENEGOTIATE_ANSWER',
        sdp: answer.sdp ?? '',
      });
    } catch (err) {
      console.error('PeerMesh: Failed to handle renegotiation offer:', err);
    }
  }

  /**
   * Handle incoming renegotiation answer.
   * @param {string} fromId
   * @param {RenegotiateAnswerMessage} message
   */
  async #handleRenegotiateAnswer(fromId, message) {
    const peer = this.#peers.get(fromId);
    if (!peer) return;

    try {
      await peer.connection.setRemoteDescription({
        type: 'answer',
        sdp: message.sdp,
      });
    } catch (err) {
      console.error('PeerMesh: Failed to handle renegotiation answer:', err);
    }
  }

  /**
   * @param {string} targetId
   * @param {string} targetName
   */
  async #initiateRelayConnection(targetId, targetName) {
    const connection = this.#createConnection(targetId);
    const channel = connection.createDataChannel('mesh');

    const offer = await this.#gatherOffer(connection);
    this.#pendingOut.set(targetId, { connection, channel, name: targetName });

    this.broadcast(/** @type {RelayOfferMessage} */({
      type: 'RELAY_OFFER',
      from: this.#myId,
      to: targetId,
      name: this.#myName,
      sdp: offer.sdp ?? '',
    }));
  }

  /**
   * @param {RelayOfferMessage} message
   * @param {string} viaId — peer that forwarded this relay offer to us
   */
  async #handleRelayOffer(message, viaId) {
    const connection = this.#createConnection(message.from);

    /** @type {Promise<RTCDataChannel>} */
    const channelReady = new Promise((resolve) => {
      connection.addEventListener('datachannel', (e) => resolve(e.channel), { once: true });
    });

    await connection.setRemoteDescription(new RTCSessionDescription({ sdp: message.sdp, type: 'offer' }));
    const answer = await this.#gatherAnswer(connection);

    this.send(viaId, /** @type {RelayAnswerMessage} */({
      type: 'RELAY_ANSWER',
      from: this.#myId,
      to: message.from,
      sdp: answer.sdp ?? '',
    }));

    channelReady.then(async (channel) => {
      await this.#waitChannelOpen(channel);
      this.#registerPeer(message.from, message.name, connection, channel, false);
    }).catch(err => console.error('PeerMesh: relay offer channel error', err));
  }

  /** @param {RelayAnswerMessage} message */
  async #handleRelayAnswer(message) {
    const pending = this.#pendingOut.get(message.from);
    if (!pending) return;
    this.#pendingOut.delete(message.from);

    await pending.connection.setRemoteDescription(new RTCSessionDescription({ sdp: message.sdp, type: 'answer' }));
    await this.#waitChannelOpen(pending.channel);
    this.#registerPeer(message.from, pending.name, pending.connection, pending.channel, false);
  }
}
