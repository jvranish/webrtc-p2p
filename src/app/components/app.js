// @ts-check

import { html } from 'scaffold-html';
import { dispatch } from '../state.js';
import { cast } from '../utils.js';
import { ChatPanel } from './chat-panel.js';
import { InviteModal } from './invite-modal.js';
import { JoinModal, JoinButton } from './join-modal.js';

/** @import {AppState, PeerEntry} from '../state.js' */

/**
 * @param {PeerEntry} peer
 * @param {boolean} pinned
 */
const PeerTile = (peer, pinned) => html`
  <div
    class=${['peer-tile', pinned ? 'peer-tile--pinned' : '']}
    onclick=${() => dispatch('setPinnedPeer', peer.id)}
    title=${pinned ? 'Click to unpin' : 'Click to pin'}
  >
    <div class="peer-avatar">${peer.name.charAt(0).toUpperCase()}</div>
    <div class="peer-name">${peer.name}</div>
    ${pinned ? html`<div class="pin-badge">📌</div>` : ''}
  </div>
`;

/** @param {AppState} state */
const SelfTile = (state) => html`
  <div class="peer-tile peer-tile--self">
    <div class="peer-avatar peer-avatar--self">${state.myName.charAt(0).toUpperCase()}</div>
    <div class="peer-name">
      <input
        class="name-input"
        type="text"
        value=${state.myName}
        aria-label="Your display name"
        onchange=${(/** @type {Event} */ e) => {
          const input = cast(HTMLInputElement, e.target);
          if (input.value.trim()) dispatch('setName', input.value.trim());
        }}
      >
    </div>
    <div class="self-label">You</div>
  </div>
`;

/** @param {AppState} state */
const GridLayout = (state) => {
  const peers = [...state.peers.values()];
  return html`
    <div class="tiles-grid">
      ${SelfTile(state)}
      ${peers.map(p => ({ key: p.id, value: PeerTile(p, false) }))}
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
        ${PeerTile(pinnedPeer, true)}
      </div>
      <div class="tile-strip">
        ${SelfTile(state)}
        ${others.map(p => ({ key: p.id, value: PeerTile(p, false) }))}
      </div>
    </div>
  `;
};

/** @param {AppState} state */
const EmptyState = (state) => html`
  <div class="empty-state">
    <div class="empty-state-content">
      ${SelfTile(state)}
      <p class="empty-hint">Invite someone or paste an invite link below to get started.</p>
      ${JoinButton(state)}
    </div>
  </div>
`;

/** @param {AppState} state */
const Toolbar = (state) => html`
  <div class="toolbar">
    <button
      onclick=${() => dispatch('startInvite')}
      disabled=${state.invitePhase !== 'idle'}
    >Invite</button>
    <button
      class=${state.chatOpen ? 'active' : ''}
      onclick=${() => dispatch('toggleChat')}
    >Chat ${state.messages.length > 0 ? html`<span class="badge">${state.messages.length}</span>` : ''}</button>
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
    </div>
  `;
};
