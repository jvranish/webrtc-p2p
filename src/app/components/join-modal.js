// @ts-check

import { html, asComponent } from 'scaffold-html';
import { dispatch } from '../state.js';
import { cast } from '../utils.js';

/** @import {AppState} from '../state.js' */

const JoinModal = asComponent({
  init() {
    return { offerDraft: '' };
  },
  /** @param {AppState} props */
  render(props) {
    if (props.joinPhase === 'idle') return html``;

    if (props.joinPhase === 'processing') {
      return html`
        <div class="modal-overlay">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Joining session">
            <header>
              <h2>Joining…</h2>
              <p>Processing invite link.</p>
            </header>
            <div>
              <div class="spinner" aria-label="Loading"></div>
            </div>
          </div>
        </div>
      `;
    }

    const copyAnswer = () => {
      if (props.answerToken) navigator.clipboard.writeText(props.answerToken);
    };

    return html`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Joining session">
          <header>
            <h2>Almost there</h2>
            <p>Copy this answer token and send it back to the person who invited you.</p>
          </header>
          <div>
            <label>
              <span class="field-label">Your answer token</span>
              <div class="copy-row">
                <input type="text" readonly value=${props.answerToken ?? ''} onclick=${(/** @type {Event} */ e) => {
                  cast(HTMLInputElement, e.target).select();
                }}>
                <button onclick=${copyAnswer}>Copy</button>
              </div>
            </label>
            <p class="hint">Once they paste your token, you'll be connected automatically.</p>
          </div>
          <footer>
            <button onclick=${() => dispatch('closeJoinModal')}>Done</button>
          </footer>
        </div>
      </div>
    `;
  },
});

/** Rendered unconditionally; shows a join button that opens the modal. */
const JoinButton = asComponent({
  init() {
    return { offerDraft: '' };
  },
  /** @param {AppState} props */
  render(props) {
    const open = () => {
      if (this.state.offerDraft.trim()) {
        dispatch('handleOffer', this.state.offerDraft);
      }
    };

    return html`
      <div class="join-input-row">
        <input
          type="text"
          placeholder="Paste invite link to join…"
          value=${this.state.offerDraft}
          oninput=${(/** @type {Event} */ e) => {
            const input = cast(HTMLInputElement, e.target);
            this.update(s => { s.offerDraft = input.value; });
          }}
          onkeydown=${(/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Enter') open();
          }}
        >
        <button
          onclick=${open}
          disabled=${!this.state.offerDraft.trim() || props.joinPhase !== 'idle'}
        >Join</button>
      </div>
      ${props.joinError ? html`<p class="error-msg">${props.joinError}</p>` : ''}
    `;
  },
});

export { JoinModal, JoinButton };
