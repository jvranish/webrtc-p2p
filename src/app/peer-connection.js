// @ts-check

/**
 * @typedef {Object} ConnectionCallbacks
 * @property {(stream: MediaStream) => void} [onRemoteStream] - Called when a remote media stream is received
 * @property {() => void} [onDisconnected] - Called when the connection is lost
 * @property {(data: string) => void} [onMessage] - Called when a message is received on the data channel
 */

export const defaultIceServers = [
  {
    urls: "stun:stun.l.google.com:19302",
  },
];

const defaultRtcConfig = /** @type {RTCConfiguration} */ ({ iceServers: defaultIceServers });

/**
 * Wait for ICE gathering to reach the 'complete' state.
 * Falls back after 10s with whatever candidates have been gathered so far,
 * so a misbehaving STUN server can't hang token creation forever.
 * @param {RTCPeerConnection} connection
 * @returns {Promise<void>}
 */
function waitIceComplete(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      connection.removeEventListener('icegatheringstatechange', handler);
      resolve();
    };
    const handler = () => {
      if (connection.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(() => {
      console.warn('ICE gathering timed out; proceeding with partial candidates');
      done();
    }, 10_000);
    connection.addEventListener('icegatheringstatechange', handler);
  });
}

/**
 * Wait for a data channel to reach the 'open' state.
 * Rejects if the underlying connection fails or is closed, so callers
 * (e.g. the invite modal) can surface the error instead of hanging.
 * No fixed timeout: the wait legitimately spans human copy/paste time.
 * @param {RTCDataChannel} channel
 * @param {RTCPeerConnection} pc
 * @returns {Promise<void>}
 */
function waitForChannelOpen(channel, pc) {
  if (channel.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => pc.removeEventListener('connectionstatechange', onState);
    const onState = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        cleanup();
        reject(new Error(`Connection ${pc.connectionState} before data channel opened`));
      }
    };
    pc.addEventListener('connectionstatechange', onState);
    channel.addEventListener('open', () => { cleanup(); resolve(); }, { once: true });
    channel.addEventListener('error', () => { cleanup(); reject(new Error('Data channel error')); }, { once: true });
  });
}

/**
 * Set up RTCPeerConnection event handlers needed during negotiation.
 * @param {RTCPeerConnection} pc
 * @param {ConnectionCallbacks} callbacks
 * @param {Map<string, MediaStream>} remoteStreams
 */
function setupNegotiationHandlers(pc, callbacks, remoteStreams) {
  pc.addEventListener('track', (e) => {
    const stream = e.streams[0];
    if (stream && !remoteStreams.has(stream.id)) {
      remoteStreams.set(stream.id, stream);
      callbacks.onRemoteStream?.(stream);
    }
  });

  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' ||
        pc.connectionState === 'closed') {
      callbacks.onDisconnected?.();
    }
  });

  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed') {
      callbacks.onDisconnected?.();
    }
  });
}

/**
 * Add tracks to an RTCPeerConnection.
 * @param {RTCPeerConnection} pc
 * @param {MediaStreamTrack[]} tracks
 */
function addTracks(pc, tracks) {
  if (tracks.length === 0) return;
  const stream = new MediaStream(tracks);
  for (const track of tracks) {
    pc.addTrack(track, stream);
  }
}

/**
 * Create an offer for a peer to join.
 * Returns the offer SDP and an acceptAnswer function that completes the
 * handshake and returns a usable Connection.
 *
 * @param {ConnectionCallbacks} [callbacks]
 * @param {RTCConfiguration} [rtcConfig]
 * @param {MediaStreamTrack[]} [tracks]
 * Also returns a cancel function that aborts the attempt and releases the
 * RTCPeerConnection (used when a relay handshake times out).
 *
 * @returns {Promise<{offerSdp: string, acceptAnswer: (answerSdp: string) => Promise<Connection>, cancel: () => void}>}
 */
export async function startOffer(callbacks = {}, rtcConfig = defaultRtcConfig, tracks = []) {
  const pc = new RTCPeerConnection(rtcConfig);
  const remoteStreams = new Map();

  setupNegotiationHandlers(pc, callbacks, remoteStreams);
  addTracks(pc, tracks);

  const channel = pc.createDataChannel('mesh');
  channel.addEventListener('close', () => callbacks.onDisconnected?.());
  channel.addEventListener('error', (e) => console.error('Data channel error:', e));

  const offerInit = await pc.createOffer();
  await pc.setLocalDescription(offerInit);
  await waitIceComplete(pc);

  const desc = pc.localDescription;
  if (!desc) throw new Error('Failed to create local description');

  const acceptAnswer = async (/** @type {string} */ answerSdp) => {
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    await waitForChannelOpen(channel, pc);
    return new Connection(pc, channel, callbacks, false, [...tracks], remoteStreams);
  };

  const cancel = () => {
    channel.close();
    pc.close();
  };

  return { offerSdp: desc.sdp ?? '', acceptAnswer, cancel };
}

/**
 * Accept an offer from a peer.
 * Returns the answer SDP to send back, and a waitForConnect function that
 * resolves with a usable Connection once the data channel opens.
 *
 * @param {string} offerSdp
 * @param {ConnectionCallbacks} [callbacks]
 * @param {RTCConfiguration} [rtcConfig]
 * @param {MediaStreamTrack[]} [tracks]
 * @returns {Promise<{answerSdp: string, waitForConnect: () => Promise<Connection>}>}
 */
export async function answerOffer(offerSdp, callbacks = {}, rtcConfig = defaultRtcConfig, tracks = []) {
  const pc = new RTCPeerConnection(rtcConfig);
  const remoteStreams = new Map();

  setupNegotiationHandlers(pc, callbacks, remoteStreams);
  addTracks(pc, tracks);

  // Listen for the data channel before setting remote description
  /** @type {Promise<RTCDataChannel>} */
  const channelPromise = new Promise((resolve) => {
    pc.addEventListener('datachannel', (e) => {
      const channel = e.channel;
      channel.addEventListener('close', () => callbacks.onDisconnected?.());
      channel.addEventListener('error', (ev) => console.error('Data channel error:', ev));
      resolve(channel);
    }, { once: true });
  });

  // Rejects if the connection fails before the data channel ever arrives,
  // so waitForConnect doesn't hang forever on a dead handshake.
  /** @type {Promise<never>} */
  const connectionFailed = new Promise((_, reject) => {
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        reject(new Error(`Connection ${pc.connectionState} before data channel opened`));
      }
    });
  });
  connectionFailed.catch(() => {}); // prevent unhandled rejection if never awaited

  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });

  const answerInit = await pc.createAnswer();
  await pc.setLocalDescription(answerInit);
  await waitIceComplete(pc);

  const desc = pc.localDescription;
  if (!desc) throw new Error('Failed to create local description');

  const waitForConnect = async () => {
    const channel = await Promise.race([channelPromise, connectionFailed]);
    await waitForChannelOpen(channel, pc);
    return new Connection(pc, channel, callbacks, true, [...tracks], remoteStreams);
  };

  return { answerSdp: desc.sdp ?? '', waitForConnect };
}

/**
 * A connected peer connection with an open data channel.
 * Only exists after the connection is fully established.
 */
export class Connection {
  /** @type {RTCPeerConnection} */
  #pc;

  /** @type {RTCDataChannel} */
  #dataChannel;

  /** @type {ConnectionCallbacks} */
  #callbacks;

  /** @type {MediaStreamTrack[]} */
  #localTracks;

  /** @type {Map<string, MediaStream>} */
  #remoteStreams;

  /** @type {{ makingOffer: boolean, ignoreOffer: boolean }} */
  #negotiationState = { makingOffer: false, ignoreOffer: false };

  /** @type {boolean} */
  #isPolite;

  /**
   * @param {RTCPeerConnection} pc
   * @param {RTCDataChannel} dataChannel
   * @param {ConnectionCallbacks} callbacks
   * @param {boolean} isPolite
   * @param {MediaStreamTrack[]} localTracks
   * @param {Map<string, MediaStream>} remoteStreams
   */
  constructor(pc, dataChannel, callbacks, isPolite, localTracks, remoteStreams) {
    this.#pc = pc;
    this.#dataChannel = dataChannel;
    this.#callbacks = callbacks;
    this.#isPolite = isPolite;
    this.#localTracks = localTracks;
    this.#remoteStreams = remoteStreams;

    // Handle data channel messages (intercept renegotiation, forward the rest)
    dataChannel.addEventListener('message', (e) => {
      if (typeof e.data === 'string') {
        /** @type {{type?: unknown, sdp?: unknown}} */
        let message;
        try {
          message = JSON.parse(e.data);
        } catch {
          console.warn('Connection: dropping malformed message');
          return;
        }
        const sdp = typeof message.sdp === 'string' ? message.sdp : '';
        if (message.type === 'RENEGOTIATE_OFFER') {
          this.#handleRenegotiateOffer(sdp).catch(err =>
            console.error('Connection: handleRenegotiateOffer failed', err));
        } else if (message.type === 'RENEGOTIATE_ANSWER') {
          this.#handleRenegotiateAnswer(sdp).catch(err =>
            console.error('Connection: handleRenegotiateAnswer failed', err));
        } else {
          this.#callbacks.onMessage?.(e.data);
        }
      }
    });

    // Handle renegotiation (e.g. when tracks are added after connection)
    pc.addEventListener('negotiationneeded', async () => {
      try {
        this.#negotiationState.makingOffer = true;
        await pc.setLocalDescription();
        const offer = pc.localDescription;
        if (!offer) return;
        this.sendData(JSON.stringify({ type: 'RENEGOTIATE_OFFER', sdp: offer.sdp ?? '' }));
      } catch (err) {
        console.error('Connection: Failed to create renegotiation offer:', err);
      } finally {
        this.#negotiationState.makingOffer = false;
      }
    });
  }

  /**
   * Handle an incoming renegotiation offer using the perfect negotiation pattern.
   * @param {string} sdp
   * @returns {Promise<void>}
   */
  async #handleRenegotiateOffer(sdp) {
    const offerCollision = this.#negotiationState.makingOffer ||
                          this.#pc.signalingState !== 'stable';

    this.#negotiationState.ignoreOffer = !this.#isPolite && offerCollision;
    if (this.#negotiationState.ignoreOffer) return;

    try {
      await this.#pc.setRemoteDescription({ type: 'offer', sdp });
      await this.#pc.setLocalDescription();
      const answer = this.#pc.localDescription;
      if (!answer) return;
      this.sendData(JSON.stringify({ type: 'RENEGOTIATE_ANSWER', sdp: answer.sdp ?? '' }));
    } catch (err) {
      console.error('Connection: Failed to handle renegotiation offer:', err);
    }
  }

  /**
   * Handle an incoming renegotiation answer.
   * @param {string} sdp
   * @returns {Promise<void>}
   */
  async #handleRenegotiateAnswer(sdp) {
    try {
      await this.#pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (err) {
      console.error('Connection: Failed to handle renegotiation answer:', err);
    }
  }

  /**
   * Send data on the data channel.
   * @param {string} data
   * @returns {boolean} - true if sent, false if channel not ready
   */
  sendData(data) {
    if (this.#dataChannel.readyState === 'open') {
      this.#dataChannel.send(data);
      return true;
    }
    return false;
  }

  /**
   * Add local media tracks to the connection.
   * This will trigger renegotiation via the 'negotiationneeded' event.
   * @param {MediaStreamTrack[]} tracks
   */
  addLocalTracks(tracks) {
    this.#localTracks = tracks;
    const stream = new MediaStream(tracks);
    for (const track of tracks) {
      this.#pc.addTrack(track, stream);
    }
  }

  /**
   * Find the sender we use for a given kind. Looks up by transceiver kind and
   * sending direction rather than sender.track — after removeTrack() the
   * sender's track is null, and matching on track.kind would miss it (causing
   * a duplicate transceiver to be added on every remove/replace cycle).
   * @param {'video' | 'audio'} kind
   * @returns {RTCRtpSender | null}
   */
  #findSender(kind) {
    const transceiver = this.#pc.getTransceivers().find(t =>
      (t.direction === 'sendrecv' || t.direction === 'sendonly') &&
      t.receiver.track.kind === kind);
    return transceiver?.sender ?? null;
  }

  /**
   * Replace a track of a specific kind (video or audio).
   * @param {MediaStreamTrack} newTrack
   * @returns {Promise<void>}
   */
  async replaceTrack(newTrack) {
    const kind = /** @type {'video' | 'audio'} */ (newTrack.kind);
    const sender = this.#findSender(kind);

    if (sender) {
      await sender.replaceTrack(newTrack);
    } else {
      const stream = new MediaStream([newTrack]);
      this.#pc.addTrack(newTrack, stream);
    }

    this.#localTracks = this.#localTracks.filter(t => t.kind !== newTrack.kind);
    this.#localTracks.push(newTrack);
  }

  /**
   * Remove a track of a specific kind (video or audio).
   * The sender is kept (with a null track) so a later replaceTrack reuses it.
   * @param {'video' | 'audio'} kind
   * @returns {Promise<void>}
   */
  async removeTrack(kind) {
    const sender = this.#findSender(kind);

    if (sender) {
      await sender.replaceTrack(null);
    }

    this.#localTracks = this.#localTracks.filter(t => t.kind !== kind);
  }

  /**
   * Close the connection and clean up resources.
   */
  close() {
    this.#dataChannel.close();
    this.#pc.close();
    this.#remoteStreams.clear();
  }
}
