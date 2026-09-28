/**
 * app/js/toast.js — transient messages at the bottom of the window.
 *
 * - An identical message refreshes the existing toast (a lane key hammered on a
 *   finished tree) instead of stacking copies that push useful ones out.
 * - At most 3 at once; plain toasts are evicted before ones with an action, so
 *   an offer like "Go to Endgame" survives a burst of key presses.
 * - The container is a manual popover, re-shown for each toast: that puts it in the
 *   top layer ABOVE an open modal dialog (Settings, Load build), which a z-index can't.
 *   A modal makes everything outside it inert, popovers included, so while one is open
 *   the container moves inside it (its buttons stay clickable) and comes back on close.
 */

import { h } from './dom.js';
import { ui } from './icons.js';

const MAX_TOASTS = 3;

/** @param {HTMLElement} container */
export function createToaster(container) {
  /** Put the container in the topmost open modal (or the body) and on top of the top layer. */
  function raise() {
    const modal = [...document.querySelectorAll('dialog[open]')].filter(d => d.matches(':modal')).pop();
    const host = modal ?? document.body;
    if (container.parentElement !== host) host.append(container); // moving closes a popover
    if (!container.children.length || !container.showPopover) return;
    if (container.matches(':popover-open')) container.hidePopover();
    container.showPopover(); // last shown = topmost
  }
  // A dialog closing (or re-rendering its content) must not take the toasts with it.
  document.addEventListener('close', () => setTimeout(raise), true);

  return function toast(message, { kind = 'info', action = null, duration = action ? 6000 : 3200 } = {}) {
    const same = [...container.children].find(t => t.dataset.msg === message && !t.classList.contains('is-leaving'));
    if (same && !action) {
      same.restartTimer(duration);
      return;
    }
    let timer = null;
    const remove = () => {
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => {
        el.remove();
        if (!container.children.length && container.matches?.(':popover-open')) container.hidePopover();
      }, 180);
    };
    const el = h(`div.toast.toast-${kind}`, { role: 'status', dataset: { msg: message }, class: action ? 'has-action' : '' },
      h('span.toast-msg', message),
      action ? h('button.toast-action', { type: 'button', onclick: () => { action.run(); remove(); } }, action.label) : null,
      h('button.toast-x', { type: 'button', 'aria-label': 'Dismiss', onclick: remove }, ui('x', { size: 14 })),
    );
    el.restartTimer = (ms) => { clearTimeout(timer); timer = setTimeout(remove, ms); };
    while (container.children.length >= MAX_TOASTS) {
      (container.querySelector('.toast:not(.has-action)') ?? container.firstElementChild).remove();
    }
    container.append(el);
    raise();
    el.restartTimer(duration);
  };
}
