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
 * @property {MediaStream | null} stream
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
    onRemoteStream: (peerId, stream) => this.setPeerStream(peerId, stream),
    onScreenShare: (peerId, active) => this.#onScreenShare(peerId, active),
  });

  /** @param {ConnectedPeer} peer */
  #onPeerConnected(peer) {
    // Check if peer already exists (might have been created by setPeerStream due to race condition)
    const existingPeer = this.peers.get(peer.id);
    if (existingPeer) {
      // Update name but keep existing stream
      existingPeer.name = peer.name;
    } else {
      this.peers.set(peer.id, { id: peer.id, name: peer.name, stream: null });
    }

    // Auto-close join modal when first peer connects
    if (this.joinPhase === 'showing-answer') {
      this.closeJoinModal();
    }

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
    } else if (msg.type === 'SCREEN_SHARE') {
      this.#onScreenShare(fromId, msg.active);
    }
  }

  /**
   * @param {string} peerId
   * @param {boolean} active
   */
  #onScreenShare(peerId, active) {
    // Store screen share state per peer (could be extended in the future)
    console.log(`Peer ${peerId} screen share: ${active ? 'started' : 'stopped'}`);
    // The stream update will come through onRemoteStream via the track event
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

  async enumerateDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioDevices = devices.filter(d => d.kind === 'audioinput');
      this.videoDevices = devices.filter(d => d.kind === 'videoinput');

      // Set default selections if not already set
      if (!this.selectedAudioDeviceId && this.audioDevices.length > 0) {
        this.selectedAudioDeviceId = this.audioDevices[0].deviceId;
      }
      if (!this.selectedVideoDeviceId && this.videoDevices.length > 0) {
        this.selectedVideoDeviceId = this.videoDevices[0].deviceId;
      }

      scheduleRender();
    } catch (err) {
      console.error('Failed to enumerate devices:', err);
    }
  }

  async startMedia() {
    if (this.localStream) return; // already started
    try {
      const constraints = {
        video: this.selectedVideoDeviceId
          ? { deviceId: { exact: this.selectedVideoDeviceId } }
          : true,
        audio: this.selectedAudioDeviceId
          ? { deviceId: { exact: this.selectedAudioDeviceId } }
          : true,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      this.localStream = stream;

      // Enumerate devices AFTER getting permissions to get proper labels
      await this.enumerateDevices();

      // Pass local tracks to mesh for all existing connections
      this.#mesh.addLocalTracks(stream.getTracks());

      scheduleRender();
    } catch (err) {
      console.error('Failed to get user media:', err);
      throw err;
    }
  }

  toggleAudio() {
    if (!this.localStream) return;
    this.audioEnabled = !this.audioEnabled;
    const audioTracks = this.localStream.getAudioTracks();
    for (const track of audioTracks) {
      track.enabled = this.audioEnabled;
    }
  }

  toggleVideo() {
    if (!this.localStream) return;
    this.videoEnabled = !this.videoEnabled;
    const videoTracks = this.localStream.getVideoTracks();
    for (const track of videoTracks) {
      track.enabled = this.videoEnabled;
    }
  }

  async toggleScreenShare() {
    if (this.screenShareActive) {
      // Stop screen sharing
      await this.#stopScreenShare();
    } else {
      // Start screen sharing
      await this.#startScreenShare();
    }
  }

  async #startScreenShare() {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });

      this.screenStream = screenStream;
      this.screenShareActive = true;

      // Replace video track in all peer connections
      const videoTrack = screenStream.getVideoTracks()[0];
      if (videoTrack) {
        await this.#mesh.replaceVideoTrack(videoTrack);

        // Notify peers that we're sharing screen
        this.#mesh.broadcast({ type: 'SCREEN_SHARE', active: true });

        // Listen for the user stopping the share via browser UI
        videoTrack.addEventListener('ended', () => {
          this.#stopScreenShare().catch(err => console.error('Failed to stop screen share:', err));
        });
      }

      scheduleRender();
    } catch (err) {
      console.error('Failed to start screen share:', err);
      this.screenShareActive = false;
      this.screenStream = null;
      scheduleRender();
    }
  }

  async #stopScreenShare() {
    if (!this.screenStream) return;

    // Stop all screen share tracks
    for (const track of this.screenStream.getTracks()) {
      track.stop();
    }
    this.screenStream = null;
    this.screenShareActive = false;

    // Restore camera video track if we have local stream
    if (this.localStream) {
      const videoTrack = this.localStream.getVideoTracks()[0];
      if (videoTrack) {
        await this.#mesh.replaceVideoTrack(videoTrack);
      }
    } else {
      // No camera - remove video track
      await this.#mesh.replaceVideoTrack(null);
    }

    // Notify peers that we stopped sharing
    this.#mesh.broadcast({ type: 'SCREEN_SHARE', active: false });

    scheduleRender();
  }

  toggleSettings() {
    this.settingsOpen = !this.settingsOpen;
    if (this.settingsOpen && this.localStream) {
      // Re-enumerate devices when opening settings to get latest labels
      this.enumerateDevices();
    }
  }

  /** @param {string} deviceId */
  async switchAudioDevice(deviceId) {
    if (!this.localStream) return;
    this.selectedAudioDeviceId = deviceId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
      });

      const newAudioTrack = stream.getAudioTracks()[0];
      if (!newAudioTrack) return;

      // Apply current enabled state
      newAudioTrack.enabled = this.audioEnabled;

      // Stop old audio track
      const oldAudioTrack = this.localStream.getAudioTracks()[0];
      if (oldAudioTrack) {
        oldAudioTrack.stop();
        this.localStream.removeTrack(oldAudioTrack);
      }

      // Add new audio track to local stream
      this.localStream.addTrack(newAudioTrack);

      // Replace track in all peer connections
      await this.#mesh.replaceAudioTrack(newAudioTrack);

      scheduleRender();
    } catch (err) {
      console.error('Failed to switch audio device:', err);
    }
  }

  /** @param {string} deviceId */
  async switchVideoDevice(deviceId) {
    if (!this.localStream || this.screenShareActive) return;
    this.selectedVideoDeviceId = deviceId;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId } },
      });

      const newVideoTrack = stream.getVideoTracks()[0];
      if (!newVideoTrack) return;

      // Apply current enabled state
      newVideoTrack.enabled = this.videoEnabled;

      // Stop old video track
      const oldVideoTrack = this.localStream.getVideoTracks()[0];
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        this.localStream.removeTrack(oldVideoTrack);
      }

      // Add new video track to local stream
      this.localStream.addTrack(newVideoTrack);

      // Replace track in all peer connections
      await this.#mesh.replaceVideoTrack(newVideoTrack);

      scheduleRender();
    } catch (err) {
      console.error('Failed to switch video device:', err);
    }
  }

  /**
   * @param {string} peerId
   * @param {MediaStream} stream
   */
  setPeerStream(peerId, stream) {
    let peer = this.peers.get(peerId);
    if (!peer) {
      // Peer not yet registered - create placeholder entry (race condition with onPeerConnected)
      peer = { id: peerId, name: 'Connecting...', stream: null };
      this.peers.set(peerId, peer);
    }
    peer.stream = stream;
    scheduleRender();
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
