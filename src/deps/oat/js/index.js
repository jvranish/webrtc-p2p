import './base.js';
import './tabs.js';
import './dropdown.js';
import './tooltip.js';
import './sidebar.js';
import { toast, toastEl, toastClear } from './toast.js';

// Register the global window.ot.* APIs.
/**
 * @typedef {Object} OatAPI
 * @property {typeof toast & {el: typeof toastEl, clear: typeof toastClear}} toast
 */

const w = /** @type {Window & typeof globalThis & {ot?: OatAPI}} */ (/** @type {unknown} */ (window));
const ot = w.ot || (w.ot = /** @type {OatAPI} */ ({}));
ot.toast = /** @type {typeof toast & {el: typeof toastEl, clear: typeof toastClear}} */ (/** @type {unknown} */ (toast));
ot.toast.el = toastEl;
ot.toast.clear = toastClear;
