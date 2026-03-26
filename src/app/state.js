// @ts-check

import { PeerMesh } from './mesh.js';

/** @import {ConnectedPeer, MeshMessage} from './mesh.js' */

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

  /** @type {'idle' | 'offering' | 'waiting-answer'} */
  invitePhase = 'idle';

  /** @type {string | null} */
  offerLink = null;

  /** @type {string | null} */
  inviteError = null;

  /** @type {((answerInput: string) => Promise<void>) | null} */
  #acceptAnswer = null;

  /** @type {'idle' | 'processing' | 'showing-answer'} */
  joinPhase = 'idle';

  /** @type {string | null} */
  answerToken = null;

  /** @type {string | null} */
  joinError = null;

  #mesh = new PeerMesh({
    onPeerConnected: (peer) => this.#onPeerConnected(peer),
    onPeerDisconnected: (id) => this.#onPeerDisconnected(id),
    onMessage: (fromId, msg) => this.#onMessage(fromId, msg),
  });

  /** @param {ConnectedPeer} peer */
  #onPeerConnected(peer) {
    this.peers.set(peer.id, { id: peer.id, name: peer.name });
    scheduleRender();
  }

  /** @param {string} id */
  #onPeerDisconnected(id) {
    this.peers.delete(id);
    if (this.pinnedPeerId === id) this.pinnedPeerId = null;
    scheduleRender();
  }

  /**
   * @param {string} fromId
   * @param {MeshMessage} msg
   */
  #onMessage(fromId, msg) {
    if (msg.type === 'CHAT') {
      const peer = this.peers.get(fromId);
      this.messages = [...this.messages, {
        fromId,
        fromName: peer?.name ?? 'Unknown',
        text: msg.text,
        timestamp: msg.timestamp,
      }];
      scheduleRender();
    } else if (msg.type === 'PEER_META') {
      const peer = this.peers.get(fromId);
      if (peer) {
        peer.name = msg.name;
        scheduleRender();
      }
    }
  }

  /** @param {string} name */
  setName(name) {
    this.myName = name;
    localStorage.setItem('displayName', name);
    this.#mesh.broadcast({ type: 'PEER_META', name });
  }

  async startInvite() {
    this.invitePhase = 'offering';
    this.inviteError = null;
    scheduleRender();
    try {
      const { offerLink, acceptAnswer } = await this.#mesh.createInvite(this.myId, this.myName);
      this.offerLink = offerLink;
      this.#acceptAnswer = acceptAnswer;
      this.invitePhase = 'waiting-answer';
    } catch (err) {
      this.inviteError = err instanceof Error ? err.message : 'Failed to create invite';
      this.invitePhase = 'idle';
    }
    scheduleRender();
  }

  /** @param {string} answerInput */
  async submitAnswer(answerInput) {
    if (!this.#acceptAnswer) return;
    this.inviteError = null;
    try {
      await this.#acceptAnswer(answerInput);
    } catch (err) {
      this.inviteError = err instanceof Error ? err.message : 'Failed to connect';
      scheduleRender();
      return;
    }
    this.invitePhase = 'idle';
    this.offerLink = null;
    this.#acceptAnswer = null;
    scheduleRender();
  }

  cancelInvite() {
    this.invitePhase = 'idle';
    this.offerLink = null;
    this.inviteError = null;
    this.#acceptAnswer = null;
  }

  /** @param {string} offerInput */
  async handleOffer(offerInput) {
    this.joinPhase = 'processing';
    this.joinError = null;
    scheduleRender();
    try {
      const answerToken = await this.#mesh.acceptInvite(offerInput, this.myId, this.myName);
      this.answerToken = answerToken;
      this.joinPhase = 'showing-answer';
    } catch (err) {
      this.joinError = err instanceof Error ? err.message : 'Failed to process invite';
      this.joinPhase = 'idle';
    }
    scheduleRender();
  }

  closeJoinModal() {
    this.joinPhase = 'idle';
    this.answerToken = null;
    this.joinError = null;
  }

  /** @param {string} text */
  sendChat(text) {
    if (!text.trim()) return;
    const timestamp = Date.now();
    this.messages = [...this.messages, {
      fromId: this.myId,
      fromName: this.myName,
      text,
      timestamp,
    }];
    this.#mesh.broadcast({ type: 'CHAT', text, timestamp });
  }

  toggleChat() {
    this.chatOpen = !this.chatOpen;
  }

  /** @param {string | null} peerId */
  setPinnedPeer(peerId) {
    this.pinnedPeerId = peerId === this.pinnedPeerId ? null : peerId;
  }
}

export const state = new AppState();

/**
 * Call a method on the app state and schedule a re-render.
 * Async methods manage their own intermediate renders via scheduleRender().
 * @param {keyof AppState} method
 * @param {...unknown} args
 */
export function dispatch(method, ...args) {
  const fn = /** @type {((...a: unknown[]) => unknown)} */ (/** @type {unknown} */ (state[method]));
  fn.call(state, ...args);
  scheduleRender();
}
