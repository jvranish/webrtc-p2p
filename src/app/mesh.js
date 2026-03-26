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
 * @typedef {PeerListMessage | RelayOfferMessage | RelayAnswerMessage | PeerMetaMessage | PeerLeftMessage | ChatMessage | ScreenShareMessage} MeshMessage
 */

/**
 * @typedef {Object} MeshCallbacks
 * @property {(peer: ConnectedPeer) => void} onPeerConnected
 * @property {(peerId: string) => void} onPeerDisconnected
 * @property {(fromId: string, message: MeshMessage) => void} onMessage
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

    const connection = new RTCPeerConnection({ iceServers: defaultIceServers });
    const channel = connection.createDataChannel('mesh');

    const offer = await this.#gatherOffer(connection);

    const tokenData = /** @type {TokenData} */ ({ peerId: myId, name: myName, sdp: offer.sdp ?? '', type: offer.type });
    const offerLink = `${location.href.split('#')[0]}#offer=${encodeToken(tokenData)}`;

    const acceptAnswer = async (/** @type {string} */ input) => {
      const answerData = this.#parseToken(input);
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
    const connection = new RTCPeerConnection({ iceServers: defaultIceServers });

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

  // ── Private helpers ───────────────────────────────────────────────────────

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
    } else {
      this.#callbacks.onMessage(fromId, message);
    }
  }

  /**
   * @param {string} targetId
   * @param {string} targetName
   */
  async #initiateRelayConnection(targetId, targetName) {
    const connection = new RTCPeerConnection({ iceServers: defaultIceServers });
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
    const connection = new RTCPeerConnection({ iceServers: defaultIceServers });

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
