// @ts-check

/** @import {ConnectedPeer} from './mesh.js' */

/**
 * @typedef {Object} ChatMessage
 * @property {string} fromId
 * @property {string} fromName
 * @property {string} text
 * @property {number} timestamp
 */

/**
 * @typedef {Object} PeerEntry
 * @property {string} id
 * @property {string} name
 * @property {MediaStream | null} stream
 */

/**
 * A single-use invite. One ticket connects one guest.
 * @typedef {Object} InviteTicket
 * @property {string} id
 * @property {'generating' | 'ready' | 'connecting' | 'connected'} phase
 * @property {string | null} offerLink
 * @property {string | null} error
 * @property {string | null} peerName  - set once a guest connects
 */

/** @type {(() => void) | null} */
let _renderCallback = null;

let _renderPending = false;

/** @param {() => void} fn */
export function setRenderCallback(fn) {
  _renderCallback = fn;
}

export function scheduleRender() {
  if (_renderPending) return;
  _renderPending = true;
  queueMicrotask(() => {
    _renderPending = false;
    _renderCallback?.();
  });
}

export class AppState {
  myId = crypto.randomUUID();
  myName = localStorage.getItem('displayName') ?? 'Guest';

  /** @type {Map<string, PeerEntry>} */
  peers = new Map();

  /** @type {ChatMessage[]} */
  messages = [];

  chatOpen = false;

  /** @type {string | null} */
  pinnedPeerId = null;

  /** @type {MediaStream | null} */
  localStream = null;

  audioEnabled = true;
  videoEnabled = true;

  screenShareActive = false;

  /** @type {MediaStream | null} */
  screenStream = null;

  /** @type {MediaDeviceInfo[]} */
  audioDevices = [];

  /** @type {MediaDeviceInfo[]} */
  videoDevices = [];

  /** @type {string | null} */
  selectedAudioDeviceId = null;

  /** @type {string | null} */
  selectedVideoDeviceId = null;

  settingsOpen = false;

  // --- Invite flow (multiple single-use tickets) ---

  inviteModalOpen = false;

  /** @type {InviteTicket[]} */
  invites = [];

  /** @type {'idle' | 'processing' | 'showing-answer'} */
  joinPhase = 'idle';

  /** @type {string | null} */
  answerToken = null;

  /** @type {string | null} */
  joinError = null;

  // --- Identity ---

  /** @param {string} name */
  setName(name) {
    this.myName = name;
    localStorage.setItem('displayName', name);
  }

  // --- Peer lifecycle ---

  /** @param {ConnectedPeer} peer */
  peerConnected(peer) {
    const existing = this.peers.get(peer.id);
    if (existing) {
      existing.name = peer.name;
    } else {
      this.peers.set(peer.id, { id: peer.id, name: peer.name, stream: null });
      if (this.pinnedPeerId === null) this.pinnedPeerId = peer.id;
    }
    if (this.joinPhase === 'showing-answer') this.closeJoinModal();
  }

  /** @param {string} id */
  peerDisconnected(id) {
    this.peers.delete(id);
    if (this.pinnedPeerId === id) this.pinnedPeerId = null;
  }

  /**
   * @param {string} fromId
   * @param {string} text
   * @param {number} timestamp
   */
  receiveChat(fromId, text, timestamp) {
    const peer = this.peers.get(fromId);
    this.messages = [...this.messages, {
      fromId,
      fromName: peer?.name ?? 'Unknown',
      text,
      timestamp,
    }];
  }

  /**
   * @param {string} fromId
   * @param {string} name
   */
  receivePeerMeta(fromId, name) {
    const peer = this.peers.get(fromId);
    if (peer) peer.name = name;
  }

  /**
   * @param {string} peerId
   * @param {MediaStream} stream
   */
  setPeerStream(peerId, stream) {
    let peer = this.peers.get(peerId);
    if (!peer) {
      // Peer not yet registered - create placeholder entry (race condition with peerConnected)
      peer = { id: peerId, name: 'Connecting...', stream: null };
      this.peers.set(peerId, peer);
    }
    peer.stream = stream;
  }

  /** @param {string | null} peerId */
  setPinnedPeer(peerId) {
    this.pinnedPeerId = peerId === this.pinnedPeerId ? null : peerId;
  }

  // --- Invite flow ---

  openInvites() {
    this.inviteModalOpen = true;
  }

  closeInvites() {
    // Keep tickets alive so answers can still be pasted after reopening.
    this.inviteModalOpen = false;
  }

  /**
   * Immutably update one ticket by id.
   * @param {string} id
   * @param {(t: InviteTicket) => InviteTicket} fn
   */
  #updateInvite(id, fn) {
    this.invites = this.invites.map(t => t.id === id ? fn(t) : t);
  }

  /** @param {string} id */
  addInvite(id) {
    this.invites = [...this.invites, {
      id,
      phase: 'generating',
      offerLink: null,
      error: null,
      peerName: null,
    }];
  }

  /**
   * @param {string} id
   * @param {string} offerLink
   */
  setInviteReady(id, offerLink) {
    this.#updateInvite(id, t => ({ ...t, phase: 'ready', offerLink, error: null }));
  }

  /** @param {string} id */
  setInviteConnecting(id) {
    this.#updateInvite(id, t => ({ ...t, phase: 'connecting', error: null }));
  }

  /**
   * @param {string} id
   * @param {string} peerName
   */
  markInviteConnected(id, peerName) {
    this.#updateInvite(id, t => ({ ...t, phase: 'connected', peerName, error: null }));
  }

  /**
   * @param {string} id
   * @param {string} msg
   */
  setInviteError(id, msg) {
    this.#updateInvite(id, t => ({ ...t, phase: 'ready', error: msg }));
  }

  /** @param {string} id */
  removeInvite(id) {
    this.invites = this.invites.filter(t => t.id !== id);
  }

  // --- Join flow ---

  setProcessingOffer() {
    this.joinPhase = 'processing';
    this.joinError = null;
  }

  /** @param {string} token */
  setAnswerToken(token) {
    this.answerToken = token;
    this.joinPhase = 'showing-answer';
  }

  /** @param {string} msg */
  setJoinError(msg) {
    this.joinError = msg;
    this.joinPhase = 'idle';
  }

  closeJoinModal() {
    this.joinPhase = 'idle';
    this.answerToken = null;
    this.joinError = null;
  }

  // --- Chat ---

  /**
   * @param {string} fromId
   * @param {string} fromName
   * @param {string} text
   * @param {number} timestamp
   */
  addChatMessage(fromId, fromName, text, timestamp) {
    this.messages = [...this.messages, { fromId, fromName, text, timestamp }];
  }

  toggleChat() {
    this.chatOpen = !this.chatOpen;
  }

  // --- Media ---

  toggleAudio() {
    if (!this.localStream) return;
    this.audioEnabled = !this.audioEnabled;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = this.audioEnabled;
    }
  }

  toggleVideo() {
    if (!this.localStream) return;
    this.videoEnabled = !this.videoEnabled;
    for (const track of this.localStream.getVideoTracks()) {
      track.enabled = this.videoEnabled;
    }
  }

  /**
   * @param {MediaDeviceInfo[]} audio
   * @param {MediaDeviceInfo[]} video
   */
  setDevices(audio, video) {
    this.audioDevices = audio;
    this.videoDevices = video;
    if (!this.selectedAudioDeviceId && audio.length > 0) {
      this.selectedAudioDeviceId = audio[0].deviceId;
    }
    if (!this.selectedVideoDeviceId && video.length > 0) {
      this.selectedVideoDeviceId = video[0].deviceId;
    }
  }

  /** @param {MediaStream} stream */
  setLocalStream(stream) {
    this.localStream = stream;
  }

  /** @param {MediaStream | null} stream */
  setScreenShare(stream) {
    this.screenStream = stream;
    this.screenShareActive = !!stream;
  }

  // --- Settings ---

  toggleSettings() {
    this.settingsOpen = !this.settingsOpen;
  }

  // --- Device selection ---

  /** @param {string} deviceId */
  setSelectedAudioDevice(deviceId) {
    this.selectedAudioDeviceId = deviceId;
  }

  /** @param {string} deviceId */
  setSelectedVideoDevice(deviceId) {
    this.selectedVideoDeviceId = deviceId;
  }
}

export const state = new AppState();

/**
 * Call a method on the app state and schedule a re-render.
 * @param {keyof AppState} method
 * @param {...unknown} args
 */
export function dispatch(method, ...args) {
  const fn = /** @type {((...a: unknown[]) => unknown)} */ (/** @type {unknown} */ (state[method]));
  fn.call(state, ...args);
  scheduleRender();
}

/**
 * Read a value from the app state without triggering a re-render.
 * @template T
 * @param {(s: AppState) => T} fn
 * @returns {T}
 */
export function select(fn) {
  return fn(state);
}
