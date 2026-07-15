// @ts-check

import { html, asComponent } from 'scaffold-html';
import { newInvite, submitInviteAnswer, removeInvite, closeInvites } from '../actions.js';
import { cast } from '../utils.js';
import { icon } from '../icons.js';

/** @import {AppState, InviteTicket} from '../state.js' */

const STATUS = {
  generating: { cls: 'pill--waiting', label: 'Generating…' },
  ready: { cls: 'pill--waiting', label: 'Awaiting guest' },
  connecting: { cls: 'pill--connecting', label: 'Connecting…' },
  connected: { cls: 'pill--connected', label: 'Connected' },
};

const InviteModal = asComponent({
  init() {
    return { drafts: /** @type {Record<string, string>} */ ({}) };
  },

  /** @param {AppState} props */
  render(props) {
    if (!props.inviteModalOpen) return html``;

    /** @param {InviteTicket} inv @param {number} i */
    const ticket = (inv, i) => {
      const status = inv.error
        ? { cls: 'pill--error', label: 'Error' }
        : STATUS[inv.phase];

      const draft = this.state.drafts[inv.id] ?? '';
      const setDraft = (/** @type {string} */ v) => {
        this.update(s => { s.drafts = { ...s.drafts, [inv.id]: v }; });
      };
      const copyLink = () => {
        if (inv.offerLink) navigator.clipboard.writeText(inv.offerLink);
      };

      return html`
        <div class=${['ticket', inv.phase === 'connected' ? 'ticket--connected' : '', inv.error ? 'ticket--error' : '']}>
          <div class="ticket-head">
            <span class="ticket-num">Invite ${i + 1}</span>
            <span class="ticket-single">· one guest</span>
            <span class="ticket-head-spacer"></span>
            <span class=${['pill', status.cls]}>${status.label}</span>
            <button class="ticket-remove" onclick=${() => removeInvite(inv.id)} aria-label="Remove invite">${icon.close(14)}</button>
          </div>

          ${inv.phase === 'generating'
            ? html`<div class="ticket-generating"><div class="spinner spinner--sm"></div><span>Creating single-use link…</span></div>`
            : inv.phase === 'connected'
            ? html`<div class="ticket-connected-msg">${icon.pin()} Connected to ${inv.peerName ?? 'guest'} — link used up.</div>`
            : html`
              <div class="copy-row">
                <input type="text" readonly value=${inv.offerLink ?? ''} onclick=${(/** @type {Event} */ e) => cast(HTMLInputElement, e.target).select()}>
                <button onclick=${copyLink}>${icon.copy()} Copy</button>
              </div>
              <div class="ticket-answer">
                <span class="field-label">Paste this guest's answer token</span>
                <textarea
                  placeholder="Paste the answer they send back…"
                  oninput=${(/** @type {Event} */ e) => setDraft(cast(HTMLTextAreaElement, e.target).value)}
                >${draft}</textarea>
                ${inv.error ? html`<p class="error-msg">${inv.error}</p>` : ''}
                <button
                  class="primary"
                  onclick=${() => submitInviteAnswer(inv.id, draft)}
                  disabled=${!draft.trim() || inv.phase === 'connecting'}
                >Connect this guest</button>
              </div>
            `}
        </div>
      `;
    };

    return html`
      <div class="modal-overlay" onclick=${() => closeInvites()}>
        <div class="modal invite-modal" onclick=${(/** @type {Event} */ e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Invite people">
          <div class="modal-header">
            <h2>Invite people</h2>
            <button class="close-btn" onclick=${() => closeInvites()} aria-label="Close">${icon.close()}</button>
          </div>
          <div class="invite-scroll">
            <p class="invite-intro">Each link connects <strong>one guest only</strong>. Generate a separate invite for each person — once anyone joins, others you invite connect to the whole group automatically.</p>
            <div class="invite-list">
              ${props.invites.map((inv, i) => ({ key: inv.id, value: ticket(inv, i) }))}
            </div>
          </div>
          <div class="invite-footer">
            <button onclick=${() => newInvite()}>${icon.invite()} New invite</button>
          </div>
        </div>
      </div>
    `;
  },
});

export { InviteModal };
