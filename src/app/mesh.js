// @ts-check

import { PeerConnection } from './peer-connection.js';
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
 * @property {PeerConnection} peerConnection
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
 * @property {(peerId: string, active: boolean) => void} onScreenShare
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
   * @type {Map<string, {peerConnection: PeerConnection, name: string, acceptAnswer: (answerSdp: string) => Promise<void>}>}
   */
  #pendingOut = new Map();

  /** @type {MeshCallbacks} */
  #callbacks;

  /** @type {MediaStreamTrack[]} */
  #localTracks = [];

  /** @type {WeakMap<PeerConnection, {peerId: string}>} */
  #peerIdRefs = new WeakMap();

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
    const peerConnection = this.#createPeerConnection('pending');

    const { offerSdp, acceptAnswer: acceptAnswerSdp } = await peerConnection.createInvite();

    const tokenData = /** @type {TokenData} */ ({
      peerId: myId,
      name: myName,
      sdp: offerSdp,
      type: 'offer'
    });
    const offerLink = `${location.href.split('#')[0]}#offer=${encodeToken(tokenData)}`;

    const acceptAnswer = async (/** @type {string} */ input) => {
      const answerData = /** @type {TokenData} */ (decodeToken(input.trim()));

      // Update the peer ID reference before setting remote description
      // so that any ontrack events that fire will have the correct peer ID
      const peerIdRef = this.#peerIdRefs.get(peerConnection);
      if (peerIdRef) {
        peerIdRef.peerId = answerData.peerId;
      }

      await acceptAnswerSdp(answerData.sdp);
      this.#registerPeer(answerData.peerId, answerData.name, peerConnection, true);
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
    const peerConnection = this.#createPeerConnection(offerData.peerId, () => {
      this.#registerPeer(offerData.peerId, offerData.name, peerConnection, false);
    });

    const answerSdp = await peerConnection.acceptInvite(offerData.sdp);

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
      peer.peerConnection.sendData(str);
    }
  }

  /**
   * @param {string} peerId
   * @param {MeshMessage} message
   */
  send(peerId, message) {
    const peer = this.#peers.get(peerId);
    if (peer) {
      peer.peerConnection.sendData(JSON.stringify(message));
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
      peer.peerConnection.addLocalTracks(tracks);
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
        await peer.peerConnection.replaceTrack(newTrack);
      } else {
        await peer.peerConnection.removeTrack('video');
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
        await peer.peerConnection.replaceTrack(newTrack);
      } else {
        await peer.peerConnection.removeTrack('audio');
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
   * Create a new PeerConnection with callbacks for this mesh.
   * @param {string} peerId
   * @param {() => void} [onDataChannelOpen] - Optional callback for when data channel opens
   * @returns {PeerConnection}
   */
  #createPeerConnection(peerId, onDataChannelOpen) {
    // Create a mutable reference for the peer ID so it can be updated later
    const peerIdRef = { peerId };

    const peerConnection = new PeerConnection({
      onRemoteStream: (stream) => {
        this.#callbacks.onRemoteStream(peerIdRef.peerId, stream);
      },
      onDisconnected: () => {
        this.#handlePeerDisconnected(peerIdRef.peerId);
      },
      onDataChannelMessage: (data) => {
        this.#handleMessage(peerIdRef.peerId, data);
      },
      onDataChannelClosed: () => {
        this.#handlePeerDisconnected(peerIdRef.peerId);
      },
      onDataChannelOpen: onDataChannelOpen,
      onRenegotiateOffer: (sdp) => {
        this.send(peerIdRef.peerId, { type: 'RENEGOTIATE_OFFER', sdp });
      },
      onRenegotiateAnswer: (sdp) => {
        this.send(peerIdRef.peerId, { type: 'RENEGOTIATE_ANSWER', sdp });
      },
      isPolite: this.#myId < peerId,
    });

    // Store the reference so we can update it later
    this.#peerIdRefs.set(peerConnection, peerIdRef);

    // Add local tracks if available
    if (this.#localTracks.length > 0) {
      peerConnection.addLocalTracks(this.#localTracks);
    }

    return peerConnection;
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
   * @param {PeerConnection} peerConnection
   * @param {boolean} sendPeerList — true when we're the one who invited this peer (A side)
   */
  #registerPeer(id, name, peerConnection, sendPeerList) {
    if (this.#peers.has(id)) return; // already connected (shouldn't happen, but guard it)

    /** @type {ConnectedPeer} */
    const peer = { id, name, peerConnection };
    this.#peers.set(id, peer);

    if (sendPeerList) {
      const others = [...this.#peers.values()]
        .filter(p => p.id !== id)
        .map(p => ({ id: p.id, name: p.name }));
      if (others.length > 0) {
        peerConnection.sendData(JSON.stringify(/** @type {PeerListMessage} */({
          type: 'PEER_LIST',
          peers: others
        })));
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

    await peer.peerConnection.handleOffer(message.sdp);
  }

  /**
   * Handle incoming renegotiation answer.
   * @param {string} fromId
   * @param {RenegotiateAnswerMessage} message
   */
  async #handleRenegotiateAnswer(fromId, message) {
    const peer = this.#peers.get(fromId);
    if (!peer) return;

    await peer.peerConnection.handleAnswer(message.sdp);
  }

  /**
   * @param {string} targetId
   * @param {string} targetName
   */
  async #initiateRelayConnection(targetId, targetName) {
    const peerConnection = this.#createPeerConnection(targetId);

    const { offerSdp, acceptAnswer } = await peerConnection.createInvite();
    this.#pendingOut.set(targetId, { peerConnection, name: targetName, acceptAnswer });

    this.broadcast(/** @type {RelayOfferMessage} */({
      type: 'RELAY_OFFER',
      from: this.#myId,
      to: targetId,
      name: this.#myName,
      sdp: offerSdp,
    }));
  }

  /**
   * @param {RelayOfferMessage} message
   * @param {string} viaId — peer that forwarded this relay offer to us
   */
  async #handleRelayOffer(message, viaId) {
    const peerConnection = this.#createPeerConnection(message.from, () => {
      this.#registerPeer(message.from, message.name, peerConnection, false);
    });

    const answerSdp = await peerConnection.acceptInvite(message.sdp);

    this.send(viaId, /** @type {RelayAnswerMessage} */({
      type: 'RELAY_ANSWER',
      from: this.#myId,
      to: message.from,
      sdp: answerSdp,
    }));
  }

  /** @param {RelayAnswerMessage} message */
  async #handleRelayAnswer(message) {
    const pending = this.#pendingOut.get(message.from);
    if (!pending) return;
    this.#pendingOut.delete(message.from);

    await pending.acceptAnswer(message.sdp);
    this.#registerPeer(message.from, pending.name, pending.peerConnection, false);
  }
}
