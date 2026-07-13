// @ts-check

import { svg } from 'scaffold-html';

/**
 * Minimal line-icon set. Each returns an inline <svg> that inherits the
 * current text color (stroke=currentColor), so buttons style them for free.
 * @param {number} [size]
 */
export const icon = {
  /** @param {number} [s] */
  mic: (s = 20) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3"></rect>
      <path d="M5 11a7 7 0 0 0 14 0"></path>
      <line x1="12" y1="18" x2="12" y2="21"></line>
      <line x1="8" y1="21" x2="16" y2="21"></line>
    </svg>`,

  /** @param {number} [s] */
  micOff: (s = 20) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 9v-3a3 3 0 0 1 6 0v3"></path>
      <path d="M15 12.5a3 3 0 0 1-4.5 2.6"></path>
      <path d="M5 11a7 7 0 0 0 10.5 6.05"></path>
      <path d="M19 11a6.98 6.98 0 0 1-.85 3.35"></path>
      <line x1="12" y1="18" x2="12" y2="21"></line>
      <line x1="8" y1="21" x2="16" y2="21"></line>
      <line x1="4" y1="3" x2="20" y2="21"></line>
    </svg>`,

  /** @param {number} [s] */
  cam: (s = 20) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="12" height="12" rx="2.5"></rect>
      <path d="M15 10l6-3.5v11L15 14"></path>
    </svg>`,

  /** @param {number} [s] */
  camOff: (s = 20) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M15 10l6-3.5v11l-4-2.3"></path>
      <path d="M13 6H5.5A2.5 2.5 0 0 0 3 8.5V16a2.5 2.5 0 0 0 2.5 2h6.5"></path>
      <line x1="3" y1="3" x2="21" y2="21"></line>
    </svg>`,

  /** @param {number} [s] */
  share: (s = 20) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="12" rx="2"></rect>
      <line x1="8" y1="20" x2="16" y2="20"></line>
      <path d="M9 11l3-3 3 3"></path>
      <line x1="12" y1="8" x2="12" y2="13"></line>
    </svg>`,

  /** @param {number} [s] */
  chat: (s = 20) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
    </svg>`,

  /** @param {number} [s] */
  invite: (s = 18) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M10.5 13.5l3-3"></path>
      <path d="M8.5 16.5l-2 2a3 3 0 0 1-4.2-4.2l3-3a3 3 0 0 1 4.2 0"></path>
      <path d="M15.5 10.5l2-2a3 3 0 1 1 4.2 4.2l-3 3a3 3 0 0 1-4.2 0"></path>
    </svg>`,

  /** @param {number} [s] */
  settings: (s = 20) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="4" y1="7" x2="20" y2="7"></line>
      <circle cx="9" cy="7" r="2"></circle>
      <line x1="4" y1="14" x2="20" y2="14"></line>
      <circle cx="16" cy="14" r="2"></circle>
    </svg>`,

  /** @param {number} [s] */
  close: (s = 16) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
      <line x1="5" y1="5" x2="19" y2="19"></line>
      <line x1="19" y1="5" x2="5" y2="19"></line>
    </svg>`,

  /** @param {number} [s] */
  copy: (s = 15) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="12" height="12" rx="2"></rect>
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
    </svg>`,

  /** @param {number} [s] */
  send: (s = 15) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13"></line>
      <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
    </svg>`,

  /** @param {number} [s] */
  pin: (s = 16) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true">
      <path d="M14 2l8 8-5 1-3 3-1 6-3-3-5 5-1-1 5-5-3-3 6-1 3-3z"></path>
    </svg>`,

  /** @param {number} [s] */
  camera: (s = 18) => svg`
    <svg width=${s} height=${s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="3" y="6" width="12" height="12" rx="2.5"></rect>
      <path d="M15 10l6-3.5v11L15 14"></path>
    </svg>`,
};
