/**
 * oat - Tabs Component
 * Provides keyboard navigation and ARIA state management.
 *
 * Usage:
 * <ot-tabs>
 *   <div role="tablist">
 *     <button role="tab">Tab 1</button>
 *     <button role="tab">Tab 2</button>
 *   </div>
 *   <div role="tabpanel">Content 1</div>
 *   <div role="tabpanel">Content 2</div>
 * </ot-tabs>
 */

import { OtBase } from './base.js';

class OtTabs extends OtBase {
  /** @type {Element[]} */
  #tabs = [];
  /** @type {Element[]} */
  #panels = [];

  /** @override */
  init() {
    const tablist = this.$(':scope > [role="tablist"]');
    this.#tabs = tablist ? [...tablist.querySelectorAll('[role="tab"]')] : [];
    this.#panels = this.$$(':scope > [role="tabpanel"]');

    if (this.#tabs.length === 0 || this.#panels.length === 0) {
      console.warn('ot-tabs: Missing tab or tabpanel elements');
      return;
    }

    // Generate IDs and set up ARIA.
    this.#tabs.forEach((tab, i) => {
      const panel = this.#panels[i];
      if (!panel) return;

      const tabId = tab.id || `ot-tab-${this.uid()}`;
      const panelId = panel.id || `ot-panel-${this.uid()}`;

      tab.id = tabId;
      panel.id = panelId;
      tab.setAttribute('aria-controls', panelId);
      panel.setAttribute('aria-labelledby', tabId);
    });

    if (tablist) {
      tablist.addEventListener('click', this);
      tablist.addEventListener('keydown', this);
    }

    // Find initially active tab or default to first.
    const activeTab = this.#tabs.findIndex(t => t.ariaSelected === 'true');
    this.#activate(activeTab >= 0 ? activeTab : 0);
  }

  /**
   * @override
   * @type {(e: MouseEvent) => void}
   */
  onclick = (e) => {
    if (!(e.target instanceof Element)) return;
    const tab = e.target.closest('[role="tab"]');
    const index = tab ? this.#tabs.indexOf(tab) : -1;
    if (index >= 0) this.#activate(index);
  };

  /**
   * @override
   * @type {(e: KeyboardEvent) => void}
   */
  onkeydown = (e) => {
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest('[role="tab"]')) return;

    const next = this.keyNav(e, this.activeIndex, this.#tabs.length, 'ArrowLeft', 'ArrowRight');
    if (next >= 0) {
      this.#activate(next);
      if (this.#tabs[next] instanceof HTMLElement) {
        this.#tabs[next].focus();
      }
    }
  };

  /** @param {number} idx */
  #activate(idx) {
    this.#tabs.forEach((tab, i) => {
      const isActive = i === idx;
      if (tab instanceof HTMLElement) {
        tab.ariaSelected = String(isActive);
        tab.tabIndex = isActive ? 0 : -1;
      }
    });

    this.#panels.forEach((panel, i) => {
      if (panel instanceof HTMLElement) {
        panel.hidden = i !== idx;
      }
    });

    this.emit('ot-tab-change', { index: idx, tab: this.#tabs[idx] });
  }

  get activeIndex() {
    return this.#tabs.findIndex(t => t.ariaSelected === 'true');
  }

  set activeIndex(value) {
    if (value >= 0 && value < this.#tabs.length) {
      this.#activate(value);
    }
  }
}

customElements.define('ot-tabs', OtTabs);
