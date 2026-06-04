/*
 * Curvonomics — toolbar icon state
 * Keeps the toolbar icon in sync with the popup toggle:
 *   enabled  -> green glow  (on)
 *   disabled -> orange glow (off)
 * The popup writes `enabled` to chrome.storage.local; we react to that, so the
 * icon stays correct whether the change came from the popup or another window,
 * and after a browser restart.
 */
'use strict';

const ICONS = {
  on: {
    16: 'icons/icon-on-16.png',
    48: 'icons/icon-on-48.png',
    128: 'icons/icon-on-128.png',
  },
  off: {
    16: 'icons/icon-off-16.png',
    48: 'icons/icon-off-48.png',
    128: 'icons/icon-off-128.png',
  },
};

function applyIcon(enabled) {
  chrome.action.setIcon({ path: enabled ? ICONS.on : ICONS.off });
}

function syncFromStorage() {
  chrome.storage.local.get({ enabled: true }, (res) => {
    applyIcon(res.enabled !== false);
  });
}

// React the moment the toggle flips (popup writes the same key).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.enabled) {
    applyIcon(changes.enabled.newValue !== false);
  }
});

// Set the right icon on install, on browser startup, and whenever the service
// worker wakes back up.
chrome.runtime.onInstalled.addListener((details) => {
  syncFromStorage();
  // First install only (not reloads/updates): open a one-time welcome tab. Its
  // only job is to flag the single quirk — chat tabs that were already open
  // when you installed need a refresh to flip. New tabs work on their own.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  }
});
chrome.runtime.onStartup.addListener(syncFromStorage);
syncFromStorage();
