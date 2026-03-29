// @ts-check

/**
 * @typedef {Object} PeerConnectionCallbacks
 * @property {(stream: MediaStream) => void} [onRemoteStream] - Called when a remote media stream is received
 * @property {() => void} [onDisconnected] - Called when the connection is lost
 * @property {(state: RTCPeerConnectionState) => void} [onConnectionStateChange] - Called when connection state changes
 * @property {(state: RTCIceConnectionState) => void} [onIceConnectionStateChange] - Called when ICE connection state changes
 * @property {() => void} [onDataChannelOpen] - Called when the data channel is open and ready
 * @property {(data: string) => void} [onDataChannelMessage] - Called when a message is received on the data channel
 */

export const defaultIceServers = [
  {
    urls: "stun:stun.l.google.com:19302",
  },
];

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

export class PeerConnection {
  /** @type {RTCPeerConnection} */
  #connection;

  /** @type {PeerConnectionCallbacks} */
  #callbacks;

  /** @type {MediaStreamTrack[]} */
  #localTracks = [];

  /** @type {Map<string, MediaStream>} */
  #remoteStreams = new Map();

  /** @type {{ makingOffer: boolean, ignoreOffer: boolean }} */
  #negotiationState = { makingOffer: false, ignoreOffer: false };

  /** @type {boolean} */
  #isPolite = false;

  /** @type {boolean} */
  #isConnected = false;

  /** @type {RTCDataChannel | null} */
  #dataChannel = null;

  /**
   * @param {PeerConnectionCallbacks} [callbacks]
   * @param {RTCConfiguration} [config]
   */
  constructor(callbacks = {}, config = { iceServers: defaultIceServers }) {
    this.#callbacks = callbacks;
    this.#connection = new RTCPeerConnection(config);
    this.#setupEventHandlers();
  }

  /**
   * Set up event handlers for the connection.
   */
  #setupEventHandlers() {
    // Handle incoming remote tracks
    this.#connection.addEventListener('track', (e) => {
      const stream = e.streams[0];
      if (stream && !this.#remoteStreams.has(stream.id)) {
        this.#remoteStreams.set(stream.id, stream);
        this.#callbacks.onRemoteStream?.(stream);
      }
    });

    // Handle connection state changes
    this.#connection.addEventListener('connectionstatechange', () => {
      this.#callbacks.onConnectionStateChange?.(this.#connection.connectionState);

      if (this.#connection.connectionState === 'failed' ||
          this.#connection.connectionState === 'disconnected' ||
          this.#connection.connectionState === 'closed') {
        this.#callbacks.onDisconnected?.();
      }
    });

    // Handle ICE connection state changes
    this.#connection.addEventListener('iceconnectionstatechange', () => {
      this.#callbacks.onIceConnectionStateChange?.(this.#connection.iceConnectionState);

      if (this.#connection.iceConnectionState === 'failed' ||
          this.#connection.iceConnectionState === 'disconnected') {
        this.#callbacks.onDisconnected?.();
      }
    });

    // Handle negotiation needed (when tracks are added/removed dynamically)
    this.#connection.addEventListener('negotiationneeded', async () => {
      await this.#handleNegotiationNeeded();
    });

    // Handle incoming data channels (for the peer accepting an offer)
    this.#connection.addEventListener('datachannel', (e) => {
      this.#setupDataChannel(e.channel);
    });
  }

  /**
   * Set up event handlers for a data channel.
   * @param {RTCDataChannel} channel
   */
  #setupDataChannel(channel) {
    this.#dataChannel = channel;

    channel.addEventListener('open', () => {
      this.#callbacks.onDataChannelOpen?.();
    });

    channel.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        const message = JSON.parse(e.data);
        if (message.type === 'RENEGOTIATE_OFFER') {
          this.#handleRenegotiateOffer(message.sdp).catch(err => console.error('PeerConnection: handleRenegotiateOffer failed', err));
        } else if (message.type === 'RENEGOTIATE_ANSWER') {
          this.#handleRenegotiateAnswer(message.sdp).catch(err => console.error('PeerConnection: handleRenegotiateAnswer failed', err));
        } else {
          this.#callbacks.onDataChannelMessage?.(e.data);
        }
      }
    });

    channel.addEventListener('close', () => {
      this.#callbacks.onDisconnected?.();
    });

    channel.addEventListener('error', (e) => {
      console.error('PeerConnection: Data channel error:', e);
    });
  }

  /**
   * Handle negotiation needed event - send renegotiation offer to peer.
   * Uses perfect negotiation pattern to avoid glare.
   * Only triggers after the initial connection is established.
   */
  async #handleNegotiationNeeded() {
    // Don't handle renegotiation until the initial connection is complete
    if (!this.#isConnected) return;

    try {
      this.#negotiationState.makingOffer = true;

      await this.#connection.setLocalDescription();
      const offer = this.#connection.localDescription;
      if (!offer) return;

      this.sendData(JSON.stringify({ type: 'RENEGOTIATE_OFFER', sdp: offer.sdp ?? '' }));
    } catch (err) {
      console.error('PeerConnection: Failed to create renegotiation offer:', err);
    } finally {
      this.#negotiationState.makingOffer = false;
    }
  }

  /**
   * Add local media tracks to the connection.
   * This will trigger renegotiation if the connection is already established and negotiation is enabled.
   * @param {MediaStreamTrack[]} tracks
   */
  addLocalTracks(tracks) {
    this.#localTracks = tracks;

    // Create a MediaStream from the tracks so they're properly grouped
    const stream = new MediaStream(tracks);

    // Add tracks to the connection
    for (const track of tracks) {
      this.#connection.addTrack(track, stream);
    }
  }

  /**
   * Replace a track of a specific kind (video or audio).
   * @param {MediaStreamTrack | null} newTrack - New track, or null to remove the track
   * @returns {Promise<void>}
   */
  async replaceTrack(newTrack) {
    if (!newTrack) {
      throw new Error('replaceTrack requires a non-null track. Use removeTrack() to remove tracks.');
    }

    const senders = this.#connection.getSenders();
    const sender = senders.find(s => s.track?.kind === newTrack.kind);

    if (sender) {
      // Replace existing track
      await sender.replaceTrack(newTrack);
    } else {
      // No sender exists yet, add the track
      const stream = new MediaStream([newTrack]);
      this.#connection.addTrack(newTrack, stream);
    }

    // Update stored local tracks
    this.#localTracks = this.#localTracks.filter(t => t.kind !== newTrack.kind);
    this.#localTracks.push(newTrack);
  }

  /**
   * Remove a track of a specific kind (video or audio).
   * @param {'video' | 'audio'} kind
   * @returns {Promise<void>}
   */
  async removeTrack(kind) {
    const senders = this.#connection.getSenders();
    const sender = senders.find(s => s.track?.kind === kind);

    if (sender) {
      await sender.replaceTrack(null);
    }

    // Update stored local tracks
    this.#localTracks = this.#localTracks.filter(t => t.kind !== kind);
  }

  /**
   * Create an offer with full ICE candidates gathered.
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  async #createOffer() {
    const offerInit = await this.#connection.createOffer();
    await this.#connection.setLocalDescription(offerInit);
    await waitIceComplete(this.#connection);

    const desc = this.#connection.localDescription;
    if (!desc) throw new Error('Failed to create local description');

    return { type: desc.type, sdp: desc.sdp };
  }

  /**
   * Create an answer with full ICE candidates gathered.
   * Remote description must be set first.
   * @returns {Promise<RTCSessionDescriptionInit>}
   */
  async #createAnswer() {
    const answerInit = await this.#connection.createAnswer();
    await this.#connection.setLocalDescription(answerInit);
    await waitIceComplete(this.#connection);

    const desc = this.#connection.localDescription;
    if (!desc) throw new Error('Failed to create local description');

    return { type: desc.type, sdp: desc.sdp };
  }

  /**
   * Set the remote description (offer or answer).
   * @param {RTCSessionDescriptionInit} description
   * @returns {Promise<void>}
   */
  async #setRemoteDescription(description) {
    await this.#connection.setRemoteDescription(description);
    // Mark as connected after setting remote description (initial negotiation complete)
    this.#isConnected = true;
  }

  /**
   * Handle an incoming renegotiation offer using the perfect negotiation pattern.
   * @param {string} sdp
   * @returns {Promise<void>}
   */
  async #handleRenegotiateOffer(sdp) {
    const offerCollision = this.#negotiationState.makingOffer ||
                          this.#connection.signalingState !== 'stable';

    this.#negotiationState.ignoreOffer = !this.#isPolite && offerCollision;
    if (this.#negotiationState.ignoreOffer) return;

    try {
      await this.#connection.setRemoteDescription({ type: 'offer', sdp });

      await this.#connection.setLocalDescription();
      const answer = this.#connection.localDescription;
      if (!answer) return;

      this.sendData(JSON.stringify({ type: 'RENEGOTIATE_ANSWER', sdp: answer.sdp ?? '' }));
    } catch (err) {
      console.error('PeerConnection: Failed to handle renegotiation offer:', err);
    }
  }

  /**
   * Handle an incoming renegotiation answer.
   * @param {string} sdp
   * @returns {Promise<void>}
   */
  async #handleRenegotiateAnswer(sdp) {
    try {
      await this.#connection.setRemoteDescription({ type: 'answer', sdp });
    } catch (err) {
      console.error('PeerConnection: Failed to handle renegotiation answer:', err);
    }
  }

  /**
   * Send data on the data channel.
   * @param {string} data
   * @returns {boolean} - true if sent, false if channel not ready
   */
  sendData(data) {
    if (this.#dataChannel?.readyState === 'open') {
      this.#dataChannel.send(data);
      return true;
    }
    return false;
  }

  /**
   * Wait for the data channel to reach the 'open' state.
   * @returns {Promise<void>}
   */
  #waitDataChannelOpen() {
    if (this.#dataChannel?.readyState === 'open') return Promise.resolve();

    return new Promise((resolve, reject) => {
      if (!this.#dataChannel) {
        reject(new Error('No data channel'));
        return;
      }

      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (/** @type {Event} */ e) => {
        cleanup();
        reject(e);
      };
      const cleanup = () => {
        this.#dataChannel?.removeEventListener('open', onOpen);
        this.#dataChannel?.removeEventListener('error', onError);
      };

      this.#dataChannel.addEventListener('open', onOpen, { once: true });
      this.#dataChannel.addEventListener('error', onError, { once: true });
    });
  }

  /**
   * Create an invite (offer) for a peer to join.
   * Returns the offer SDP and an acceptAnswer function to complete the handshake.
   * @returns {Promise<{offerSdp: string, acceptAnswer: (answerSdp: string) => Promise<void>}>}
   */
  async createInvite() {
    this.#isPolite = false;

    // Create data channel (we're the offerer)
    const channel = this.#connection.createDataChannel('mesh');
    this.#setupDataChannel(channel);

    // Create offer
    const offer = await this.#createOffer();

    const acceptAnswer = async (/** @type {string} */ answerSdp) => {
      await this.#setRemoteDescription({ type: 'answer', sdp: answerSdp });
      await this.#waitDataChannelOpen();
    };

    return {
      offerSdp: offer.sdp ?? '',
      acceptAnswer,
    };
  }

  /**
   * Accept an invite (offer) from a peer.
   * Returns the answer SDP to send back. The data channel will open asynchronously.
   * @param {string} offerSdp
   * @returns {Promise<string>} - answer SDP
   */
  async acceptInvite(offerSdp) {
    this.#isPolite = true;

    // Set remote description (offer)
    await this.#setRemoteDescription({ type: 'offer', sdp: offerSdp });

    // Create answer
    const answer = await this.#createAnswer();

    // Data channel will be received via 'datachannel' event (already set up in #setupEventHandlers)
    // and will trigger onDataChannelOpen callback when ready

    return answer.sdp ?? '';
  }

  /**
   * Close the connection and clean up resources.
   */
  close() {
    this.#dataChannel?.close();
    this.#connection.close();
    this.#remoteStreams.clear();
  }
}
