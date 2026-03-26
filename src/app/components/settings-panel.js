// @ts-check

import { html } from 'scaffold-html';
import { dispatch } from '../state.js';
import { cast } from '../utils.js';

/** @import {AppState} from '../state.js' */

/**
 * Settings panel component for device selection
 * @param {AppState} state
 */
export const SettingsPanel = (state) => {
  if (!state.settingsOpen) return '';

  return html`
    <div class="modal-overlay" onclick=${() => dispatch('toggleSettings')}>
      <div class="modal" onclick=${(/** @type {Event} */ e) => e.stopPropagation()}>
        <div class="modal-header">
          <h2>Settings</h2>
          <button class="close-btn" onclick=${() => dispatch('toggleSettings')}>×</button>
        </div>
        <div class="modal-body settings-body">
          <div class="settings-section">
            <label for="audio-device-select">Microphone</label>
            <select
              id="audio-device-select"
              onchange=${(/** @type {Event} */ e) => {
                const select = cast(HTMLSelectElement, e.target);
                dispatch('switchAudioDevice', select.value);
              }}
              disabled=${!state.localStream}
            >
              ${state.audioDevices.map(device => ({
                key: device.deviceId,
                value: html`
                  <option
                    value=${device.deviceId}
                    selected=${device.deviceId === state.selectedAudioDeviceId}
                  >${device.label || `Microphone ${device.deviceId.slice(0, 8)}`}</option>
                `
              }))}
            </select>
            ${!state.localStream ? html`<p class="hint">Start camera to enable device selection</p>` : ''}
          </div>

          <div class="settings-section">
            <label for="video-device-select">Camera</label>
            <select
              id="video-device-select"
              onchange=${(/** @type {Event} */ e) => {
                const select = cast(HTMLSelectElement, e.target);
                dispatch('switchVideoDevice', select.value);
              }}
              disabled=${!state.localStream || state.screenShareActive}
            >
              ${state.videoDevices.map(device => ({
                key: device.deviceId,
                value: html`
                  <option
                    value=${device.deviceId}
                    selected=${device.deviceId === state.selectedVideoDeviceId}
                  >${device.label || `Camera ${device.deviceId.slice(0, 8)}`}</option>
                `
              }))}
            </select>
            ${state.screenShareActive
              ? html`<p class="hint">Stop screen sharing to switch camera</p>`
              : !state.localStream
              ? html`<p class="hint">Start camera to enable device selection</p>`
              : ''
            }
          </div>
        </div>
      </div>
    </div>
  `;
};
