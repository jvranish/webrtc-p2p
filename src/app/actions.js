// @ts-check

import { PeerMesh } from './mesh.js';
import { dispatch, select } from './state.js';

/** @import {MeshMessage} from './mesh.js' */

/** @type {((answerInput: string) => Promise<void>) | null} */
let acceptAnswerFn = null;

const mesh = new PeerMesh({
  onPeerConnected: (peer) => dispatch('peerConnected', peer),
  onPeerDisconnected: (id) => dispatch('peerDisconnected', id),
  onMessage: (fromId, msg) => onMessage(fromId, msg),
  onRemoteStream: (peerId, stream) => dispatch('setPeerStream', peerId, stream),
});

/**
 * @param {string} fromId
 * @param {MeshMessage} msg
 */
function onMessage(fromId, msg) {
  if (msg.type === 'CHAT') {
    dispatch('receiveChat', fromId, msg.text, msg.timestamp);
  } else if (msg.type === 'PEER_META') {
    dispatch('receivePeerMeta', fromId, msg.name);
  }
}

// --- Identity ---

/** @param {string} name */
export function setName(name) {
  dispatch('setName', name);
  mesh.broadcast({ type: 'PEER_META', name });
}

// --- Invite flow ---

export async function startInvite() {
  dispatch('setInviting');
  try {
    const { offerLink, acceptAnswer } = await mesh.createInvite(select(s => s.myId), select(s => s.myName));
    acceptAnswerFn = acceptAnswer;
    dispatch('setOfferReady', offerLink);
  } catch (err) {
    dispatch('setInviteError', err instanceof Error ? err.message : 'Failed to create invite');
  }
}

/** @param {string} answerInput */
export async function submitAnswer(answerInput) {
  if (!acceptAnswerFn) return;
  dispatch('setConnecting');
  try {
    await acceptAnswerFn(answerInput);
    acceptAnswerFn = null;
    dispatch('cancelInvite');
  } catch (err) {
    dispatch('setInviteError', err instanceof Error ? err.message : 'Failed to connect');
  }
}

export function cancelInvite() {
  acceptAnswerFn = null;
  dispatch('cancelInvite');
}

// --- Join flow ---

/** @param {string} offerInput */
export async function handleOffer(offerInput) {
  dispatch('setProcessingOffer');
  try {
    const answerToken = await mesh.acceptInvite(offerInput, select(s => s.myId), select(s => s.myName));
    dispatch('setAnswerToken', answerToken);
  } catch (err) {
    dispatch('setJoinError', err instanceof Error ? err.message : 'Failed to process invite');
  }
}

// --- Chat ---

/** @param {string} text */
export function sendChat(text) {
  if (!text.trim()) return;
  const timestamp = Date.now();
  dispatch('addChatMessage', select(s => s.myId), select(s => s.myName), text, timestamp);
  mesh.broadcast({ type: 'CHAT', text, timestamp });
}

// --- Media ---

async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    dispatch('setDevices',
      devices.filter(d => d.kind === 'audioinput'),
      devices.filter(d => d.kind === 'videoinput'),
    );
  } catch (err) {
    console.error('Failed to enumerate devices:', err);
  }
}

export async function startMedia() {
  if (select(s => s.localStream)) return;
  try {
    const videoDeviceId = select(s => s.selectedVideoDeviceId);
    const audioDeviceId = select(s => s.selectedAudioDeviceId);
    const constraints = {
      video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
      audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    dispatch('setLocalStream', stream);
    // Enumerate AFTER getting permissions to get proper labels
    await enumerateDevices();
    mesh.addLocalTracks(stream.getTracks());
  } catch (err) {
    console.error('Failed to get user media:', err);
    throw err;
  }
}

export async function toggleScreenShare() {
  if (select(s => s.screenShareActive)) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    dispatch('setScreenShare', screenStream);

    const videoTrack = screenStream.getVideoTracks()[0];
    if (videoTrack) {
      await mesh.replaceTrack('video', videoTrack);
      mesh.broadcast({ type: 'SCREEN_SHARE', active: true });
      videoTrack.addEventListener('ended', () => {
        stopScreenShare().catch(err => console.error('Failed to stop screen share:', err));
      });
    }
  } catch (err) {
    console.error('Failed to start screen share:', err);
    dispatch('setScreenShare', null);
  }
}

async function stopScreenShare() {
  const screenStream = select(s => s.screenStream);
  if (!screenStream) return;
  for (const track of screenStream.getTracks()) {
    track.stop();
  }
  dispatch('setScreenShare', null);

  const cameraTrack = select(s => s.localStream)?.getVideoTracks()[0] ?? null;
  await mesh.replaceTrack('video', cameraTrack);
  mesh.broadcast({ type: 'SCREEN_SHARE', active: false });
}

/**
 * @param {'audio' | 'video'} kind
 * @param {string} deviceId
 */
async function switchDevice(kind, deviceId) {
  const localStream = select(s => s.localStream);
  if (!localStream) return;
  try {
    const constraint = { deviceId: { exact: deviceId } };
    const stream = await navigator.mediaDevices.getUserMedia(
      kind === 'audio' ? { audio: constraint } : { video: constraint },
    );
    const newTrack = (kind === 'audio' ? stream.getAudioTracks() : stream.getVideoTracks())[0];
    if (!newTrack) return;

    newTrack.enabled = select(s => kind === 'audio' ? s.audioEnabled : s.videoEnabled);

    const oldTrack = (kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks())[0];
    if (oldTrack) {
      oldTrack.stop();
      localStream.removeTrack(oldTrack);
    }
    localStream.addTrack(newTrack);
    await mesh.replaceTrack(kind, newTrack);

    dispatch(kind === 'audio' ? 'setSelectedAudioDevice' : 'setSelectedVideoDevice', deviceId);
  } catch (err) {
    console.error(`Failed to switch ${kind} device:`, err);
  }
}

/** @param {string} deviceId */
export async function switchAudioDevice(deviceId) {
  await switchDevice('audio', deviceId);
}

/** @param {string} deviceId */
export async function switchVideoDevice(deviceId) {
  if (select(s => s.screenShareActive)) return;
  await switchDevice('video', deviceId);
}

// --- Settings ---

export function toggleSettings() {
  dispatch('toggleSettings');
  if (select(s => s.settingsOpen) && select(s => s.localStream)) {
    enumerateDevices();
  }
}
