/**
 * oat - Dropdown Component
 * Provides positioning, keyboard navigation, and ARIA state management.
 *
 * Usage:
 * <ot-dropdown>
 *   <button popovertarget="menu-id">Options</button>
 *   <menu popover id="menu-id">
 *     <button role="menuitem">Item 1</button>
 *     <button role="menuitem">Item 2</button>
 *   </menu>
 * </ot-dropdown>
 */

import { OtBase } from './base.js';

class OtDropdown extends OtBase {
  /** @type {HTMLElement | null | undefined} */
  #menu;
  /** @type {HTMLElement | null | undefined} */
  #trigger;
  /** @type {(() => void) | null | undefined} */
  #position;
  /** @type {Element[] | null | undefined} */
  #items;

  /** @override */
  init() {
    const menu = this.$('[popover]');
    const trigger = this.$('[popovertarget]');

    if (!menu || !trigger) return;
    if (!(menu instanceof HTMLElement) || !(trigger instanceof HTMLElement)) return;

    this.#menu = menu;
    this.#trigger = trigger;

    this.#menu.addEventListener('toggle', this);
    this.#menu.addEventListener('keydown', this);

    this.#position = () => {
      if (!this.#menu || !this.#trigger) return;
      // Position has to be calculated and applied manually because
      // popover positioning is like fixed, relative to the window.
      const r = this.#trigger.getBoundingClientRect();
      const m = this.#menu.getBoundingClientRect();

      // Flip if menu overflows viewport.
      this.#menu.style.top = `${r.bottom + m.height > window.innerHeight ? r.top - m.height : r.bottom}px`;
      this.#menu.style.left = `${r.left + m.width > window.innerWidth ? r.right - m.width : r.left}px`;
    };
  }

  /**
   * @override
   * @type {(e: ToggleEvent) => void}
   */
  ontoggle = (e) => {
    if (e.newState === 'open') {
      this.#position?.();
      if (this.#position) {
        window.addEventListener('scroll', this.#position, true);
        window.addEventListener('resize', this.#position);
      }
      this.#items = this.$$('[role="menuitem"]');
      if (this.#items[0] instanceof HTMLElement) {
        this.#items[0].focus();
      }
      if (this.#trigger) {
        this.#trigger.ariaExpanded = 'true';
      }
    } else {
      this.cleanup();
      this.#items = null;
      if (this.#trigger) {
        this.#trigger.ariaExpanded = 'false';
        this.#trigger.focus();
      }
    }
  };

  /**
   * @override
   * @type {(e: KeyboardEvent) => void}
   */
  onkeydown = (e) => {
    if (!this.#items) return;
    if (!(e.target instanceof Element) || !e.target.matches('[role="menuitem"]')) return;

    const idx = this.#items.indexOf(e.target);
    const next = this.keyNav(e, idx, this.#items.length, 'ArrowUp', 'ArrowDown', true);
    if (next >= 0 && this.#items[next] instanceof HTMLElement) {
      this.#items[next].focus();
    }
  };

  /** @override */
  cleanup() {
    if (this.#position) {
      window.removeEventListener('scroll', this.#position, true);
      window.removeEventListener('resize', this.#position);
    }
  }
}

customElements.define('ot-dropdown', OtDropdown);
