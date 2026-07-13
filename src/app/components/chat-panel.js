// @ts-check

import { html, asComponent } from 'scaffold-html';
import { dispatch } from '../state.js';
import { sendChat } from '../actions.js';
import { cast } from '../utils.js';
import { icon } from '../icons.js';

/** @import {AppState} from '../state.js' */

const ChatPanel = asComponent({
  init() {
    return { draft: '' };
  },
  /** @param {AppState} props */
  render(props) {
    // messages is append-only, so the index is a stable key (timestamp+fromId
    // can collide for two same-millisecond messages from one peer)
    const messages = props.messages.map((msg, i) => ({
      key: String(i),
      value: html`
        <div class="chat-message">
          <div class="chat-from">${msg.fromId === props.myId ? 'You' : msg.fromName}</div>
          <div class="chat-text">${msg.text}</div>
        </div>
      `,
    }));

    const submit = () => {
      if (!this.state.draft.trim()) return;
      sendChat(this.state.draft);
      this.update(s => { s.draft = ''; });
    };

    return html`
      <aside class="chat-panel">
        <header class="chat-header">
          <span>Chat</span>
          <button class="icon-btn" onclick=${() => dispatch('toggleChat')} aria-label="Close chat">${icon.close()}</button>
        </header>
        <div class="chat-messages">
          ${messages.length > 0 ? messages : html`<p class="chat-empty">No messages yet.</p>`}
        </div>
        <div class="chat-input-row">
          <input
            type="text"
            placeholder="Message…"
            value=${this.state.draft}
            oninput=${(/** @type {Event} */ e) => {
              const input = cast(HTMLInputElement, e.target);
              this.update(s => { s.draft = input.value; });
            }}
            onkeydown=${(/** @type {KeyboardEvent} */ e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
            }}
          >
          <button class="primary" onclick=${submit} disabled=${!this.state.draft.trim()} aria-label="Send">${icon.send()}</button>
        </div>
      </aside>
    `;
  },
});

export { ChatPanel };
