// @ts-check

import { html, asComponent } from 'scaffold-html';
import { submitAnswer, cancelInvite } from '../actions.js';
import { cast } from '../utils.js';

/** @import {AppState} from '../state.js' */

const InviteModal = asComponent({
  init() {
    return { answerDraft: '' };
  },
  /** @param {AppState} props */
  render(props) {
    if (props.invitePhase === 'idle') return html``;

    if (props.invitePhase === 'offering') {
      return html`
        <div class="modal-overlay">
          <div class="modal" role="dialog" aria-modal="true" aria-label="Invite someone">
            <header>
              <h2>Invite someone</h2>
              <p>Generating invite link…</p>
            </header>
            <div>
              <div class="spinner" aria-label="Loading"></div>
            </div>
          </div>
        </div>
      `;
    }

    const copyLink = () => {
      if (props.offerLink) navigator.clipboard.writeText(props.offerLink);
    };

    return html`
      <div class="modal-overlay">
        <div class="modal" role="dialog" aria-modal="true" aria-label="Invite someone">
          <header>
            <h2>Invite someone</h2>
            <p>Share this link, then paste their answer token below.</p>
          </header>
          <div>
            <label>
              <span class="field-label">Invite link</span>
              <div class="copy-row">
                <input type="text" readonly value=${props.offerLink ?? ''} onclick=${(/** @type {Event} */ e) => {
                  cast(HTMLInputElement, e.target).select();
                }}>
                <button onclick=${copyLink}>Copy</button>
              </div>
            </label>
            <label>
              <span class="field-label">Paste their answer token</span>
              <textarea
                rows="4"
                placeholder="Paste the answer token or URL here…"
                oninput=${(/** @type {Event} */ e) => {
                  const ta = cast(HTMLTextAreaElement, e.target);
                  this.update(s => { s.answerDraft = ta.value; });
                }}
              >${this.state.answerDraft}</textarea>
            </label>
            ${props.inviteError ? html`<p class="error-msg">${props.inviteError}</p>` : ''}
          </div>
          <footer>
            <button onclick=${() => cancelInvite()}>Cancel</button>
            <button
              onclick=${() => submitAnswer(this.state.answerDraft)}
              disabled=${!this.state.answerDraft.trim()}
            >Connect</button>
          </footer>
        </div>
      </div>
    `;
  },
});

export { InviteModal };
