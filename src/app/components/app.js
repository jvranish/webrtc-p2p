// @ts-check

import { html, asComponent } from 'scaffold-html';
import { dispatch } from '../state.js';
import { setName, startMedia, toggleScreenShare, startInvite, toggleSettings } from '../actions.js';
import { cast } from '../utils.js';
import { ChatPanel } from './chat-panel.js';
import { InviteModal } from './invite-modal.js';
import { JoinModal, JoinButton } from './join-modal.js';
import { SettingsPanel } from './settings-panel.js';

/** @import {AppState, PeerEntry} from '../state.js' */

/**
 * @typedef {{peer: PeerEntry, pinned: boolean}} PeerTileProps
 */

const PeerTile = asComponent({
  /**
   * @param {PeerTileProps} props
   */
  render(props) {
    const { peer, pinned } = props;

    return html`
      <div
        class=${['peer-tile', pinned ? 'peer-tile--pinned' : '']}
        onclick=${() => dispatch('setPinnedPeer', peer.id)}
        title=${pinned ? 'Click to unpin' : 'Click to pin'}
      >
        ${peer.stream
          ? html`<video
              autoplay
              playsinline
              .srcObject=${peer.stream}
            ></video>`
          : html`<div class="peer-avatar">${peer.name.charAt(0).toUpperCase()}</div>`
        }
        <div class="peer-name">${peer.name}</div>
        ${pinned ? html`<div class="pin-badge">📌</div>` : ''}
      </div>
    `;
  },
});

/**
 * @typedef {{state: AppState}} SelfTileProps
 */

const SelfTile = asComponent({
  /**
   * @param {SelfTileProps} props
   */
  render(props) {
    const { state } = props;

    // Show screen share if active, otherwise show local camera
    const displayStream = state.screenShareActive ? state.screenStream : state.localStream;

    return html`
      <div class="peer-tile peer-tile--self">
        ${displayStream
          ? html`<video
              autoplay
              playsinline
              muted
              .srcObject=${displayStream}
            ></video>`
          : html`<div class="peer-avatar peer-avatar--self">${state.myName.charAt(0).toUpperCase()}</div>`
        }
        <div class="peer-name">
          <input
            class="name-input"
            type="text"
            value=${state.myName}
            aria-label="Your display name"
            onchange=${(/** @type {Event} */ e) => {
              const input = cast(HTMLInputElement, e.target);
              if (input.value.trim()) setName(input.value.trim());
            }}
          >
        </div>
        <div class="self-label">You${state.screenShareActive ? ' (Screen)' : ''}</div>
      </div>
    `;
  },
});

/** @param {AppState} state */
const GridLayout = (state) => {
  const peers = [...state.peers.values()];
  return html`
    <div class="tiles-grid">
      ${SelfTile({ state })}
      ${peers.map(p => ({ key: p.id, value: PeerTile({ peer: p, pinned: false }) }))}
    </div>
  `;
};

/** @param {AppState} state */
const PinnedLayout = (state) => {
  const pinnedPeer = state.peers.get(state.pinnedPeerId ?? '');
  if (!pinnedPeer) return GridLayout(state);

  const others = [...state.peers.values()].filter(p => p.id !== state.pinnedPeerId);

  return html`
    <div class="tiles-pinned">
      <div class="tile-main">
        ${PeerTile({ peer: pinnedPeer, pinned: true })}
      </div>
      <div class="tile-strip">
        ${SelfTile({ state })}
        ${others.map(p => ({ key: p.id, value: PeerTile({ peer: p, pinned: false }) }))}
      </div>
    </div>
  `;
};

/** @param {AppState} state */
const EmptyState = (state) => html`
  <div class="empty-state">
    <div class="empty-state-content">
      ${SelfTile({ state })}
      <p class="empty-hint">Invite someone or paste an invite link below to get started.</p>
      ${JoinButton(state)}
    </div>
  </div>
`;

/** @param {AppState} state */
const Toolbar = (state) => html`
  <div class="toolbar">
    ${!state.localStream
      ? html`<button onclick=${() => startMedia()}>Start Camera</button>`
      : html`
        <button
          class=${state.audioEnabled ? 'active' : ''}
          onclick=${() => dispatch('toggleAudio')}
          title=${state.audioEnabled ? 'Mute' : 'Unmute'}
        >${state.audioEnabled ? '🎤' : '🎤🚫'}</button>
        <button
          class=${state.videoEnabled ? 'active' : ''}
          onclick=${() => dispatch('toggleVideo')}
          title=${state.videoEnabled ? 'Stop Video' : 'Start Video'}
        >${state.videoEnabled ? '📹' : '📹🚫'}</button>
      `
    }
    <button
      class=${state.screenShareActive ? 'active' : ''}
      onclick=${() => toggleScreenShare()}
      title=${state.screenShareActive ? 'Stop Sharing' : 'Share Screen'}
    >${state.screenShareActive ? '🖥️✓' : '🖥️'}</button>
    <button
      onclick=${() => startInvite()}
      disabled=${state.invitePhase !== 'idle'}
    >Invite</button>
    <button
      class=${state.chatOpen ? 'active' : ''}
      onclick=${() => dispatch('toggleChat')}
    >Chat ${state.messages.length > 0 ? html`<span class="badge">${state.messages.length}</span>` : ''}</button>
    <button
      class=${state.settingsOpen ? 'active' : ''}
      onclick=${() => toggleSettings()}
      title="Settings"
    >⚙️</button>
  </div>
`;

/** @param {AppState} state */
export const App = (state) => {
  const hasPeers = state.peers.size > 0;
  return html`
    <div class="app">
      <div class="tiles-area">
        ${hasPeers
          ? (state.pinnedPeerId ? PinnedLayout(state) : GridLayout(state))
          : EmptyState(state)
        }
      </div>
      ${Toolbar(state)}
      ${state.chatOpen ? ChatPanel(state) : ''}
      ${InviteModal(state)}
      ${JoinModal(state)}
      ${SettingsPanel(state)}
    </div>
  `;
};
