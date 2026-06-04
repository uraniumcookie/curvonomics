/*
 * Curvonomics — popup toggle
 * Reads/writes the on/off state in chrome.storage. content.js watches the same
 * key and flips the layout on/off live (no page refresh needed).
 */
(() => {
  'use strict';

  const toggle = document.getElementById('toggle');

  // Load the saved state (default: ON), then reveal the toggle. The two
  // requestAnimationFrame hops let the corrected (un-animated) state paint
  // first, so adding `.ready` can't make the toggle slide into position — it
  // just appears already in the right spot and only animates on real clicks.
  chrome.storage.local.get({ enabled: true }, (res) => {
    toggle.checked = res.enabled !== false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => document.body.classList.add('ready'));
    });
  });

  // Persist changes as the user flips it.
  toggle.addEventListener('change', () => {
    chrome.storage.local.set({ enabled: toggle.checked });
  });
})();
