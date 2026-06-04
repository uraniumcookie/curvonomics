/*
 * Input on Top — content script
 * -----------------------------------------------------------------------------
 * Strategy: "JS tags, CSS lays out."
 *
 * 1. Locate two anchors semantically (not by fragile class names):
 *      - the composer (the text-entry box)
 *      - any one rendered message
 *    Tag their nearest common ancestor + its two child branches with our own
 *    data-* attributes. style.css does the flip purely from those attributes.
 *
 * 2. COMPOSER-RESIZE: the composer + messages share one flex column that
 *    overflows an outer scroller. With the composer on top, growing it would
 *    reflow the page. So we bound that column to its scroll viewport and let
 *    the message branch scroll internally (style.css overflow-y:auto).
 *
 * 3. AUTO-SCROLL: because step 2 moves scrolling into OUR branch, the apps'
 *    native "scroll to the newest message" no longer reaches it. So we
 *    replicate it: when messages are added (or you send one) we keep the
 *    message branch pinned to the bottom — unless you've scrolled up to read,
 *    in which case we leave you alone until you return to the bottom.
 *
 * A MutationObserver re-applies everything on React re-renders / navigation.
 * Every pass is wrapped in try/catch and a fast "already applied?" check, so it
 * can never throw into — or slow down — the host page.
 * -----------------------------------------------------------------------------
 */
(() => {
  'use strict';

  /* ===========================================================================
   * CONFIG — all selectors live here so contributors can update them in ONE
   * place. Selectors are tried in order; the first VISIBLE match wins.
   * See README.md → "Customizing / fixing selectors".
   * ========================================================================= */
  const CONFIG = {
    // The text-entry element that identifies the composer.
    // NOTE: no "form " prefix — Claude's composer is not inside a <form>.
    editor: [
      '#prompt-textarea',                 // ChatGPT (also the ProseMirror node)
      '.ProseMirror',                     // Claude  (tiptap / ProseMirror editor)
      'rich-textarea .ql-editor',         // Gemini  (Quill editor)
      '.ql-editor',                       // Gemini  (fallback)
      'main [contenteditable="true"]',    // generic rich-text composer
      'main textarea',                    // generic plain-text composer
      '[contenteditable="true"]',         // last-resort rich-text composer
      'textarea',                         // last-resort plain-text composer
    ],

    // Any one rendered conversation turn — a position anchor to find the
    // container that holds BOTH the messages and the composer.
    message: [
      '[data-message-author-role]',       // ChatGPT (verified)
      '[data-testid="user-message"]',     // Claude  (verified)
      'user-query',                       // Gemini  (a user turn, verified)
      'response-element',                 // Gemini  (a model turn)
      '.font-claude-message',             // Claude assistant turn (fallback)
      'main [data-testid="conversation-turn"]',
    ],

    // Specifically the user's own turns — when one appears, you just hit send,
    // so we always jump to the bottom (matching the apps' native behavior).
    userMessage: [
      '[data-message-author-role="user"]', // ChatGPT
      '[data-testid="user-message"]',      // Claude
      'user-query',                        // Gemini
    ],

    minViewportHeight: 200, // min height for an ancestor to count as the scroller
    nearBottomPx: 140,      // within this many px of the bottom = "following"
  };

  // data-* attributes we own. style.css keys ALL layout off of these.
  const ATTR = {
    root: 'data-chatflip-root',
    composer: 'data-chatflip-composer',
    composerBranch: 'data-chatflip-composer-branch',
    scrollBranch: 'data-chatflip-scroll-branch',
    unpin: 'data-chatflip-unpin',
  };

  /* ----------------------------- visibility -------------------------------- */

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  /* ------------------------------ finders ---------------------------------- */

  function findEditor() {
    for (const sel of CONFIG.editor) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el)) return el;
      }
    }
    return null;
  }

  function findMessage(editor) {
    for (const sel of CONFIG.message) {
      for (const el of document.querySelectorAll(sel)) {
        if (isVisible(el) && !el.contains(editor) && !editor.contains(el)) return el;
      }
    }
    return null;
  }

  function findViewportScroller(node) {
    for (let n = node.parentElement; n && n !== document.body; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.clientHeight > CONFIG.minViewportHeight) {
        return n;
      }
    }
    return null;
  }

  /* ----------------------------- geometry ---------------------------------- */

  function lowestCommonAncestor(a, b) {
    const seen = new Set();
    for (let n = a; n; n = n.parentElement) seen.add(n);
    for (let n = b; n; n = n.parentElement) if (seen.has(n)) return n;
    return null;
  }

  function branchOf(root, node) {
    let n = node;
    while (n && n.parentElement !== root) n = n.parentElement;
    return n;
  }

  function tallAncestor(node) {
    const vh = window.innerHeight || 800;
    for (let n = node.parentElement; n && n !== document.body; n = n.parentElement) {
      if (n.clientHeight >= vh * 0.6) return n;
    }
    return null;
  }

  /* ----------------------- root height binding ----------------------------- */

  let viewportRO = null;
  let boundRoot = null;

  function unbindRootHeight() {
    if (viewportRO) { viewportRO.disconnect(); viewportRO = null; }
    if (boundRoot) {
      boundRoot.style.removeProperty('max-height');
      boundRoot.style.removeProperty('overflow');
      boundRoot = null;
    }
  }

  function bindRootHeight(root) {
    const viewport = findViewportScroller(root);
    if (!viewport) return;
    const sync = () => {
      root.style.setProperty('max-height', viewport.clientHeight + 'px', 'important');
      root.style.setProperty('overflow', 'hidden', 'important');
    };
    sync();
    if (window.ResizeObserver) {
      viewportRO = new ResizeObserver(sync);
      viewportRO.observe(viewport);
    }
    boundRoot = root;
  }

  /* ----------------------- auto-scroll (follow newest) --------------------- */

  let autoScroll = null;     // { branch, onScroll, observer }
  let stickToBottom = true;
  let pinQueued = false;

  function isNearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= CONFIG.nearBottomPx;
  }

  function pinToBottom(branch) {
    if (pinQueued) return;
    pinQueued = true;
    requestAnimationFrame(() => {
      pinQueued = false;
      if (stickToBottom && branch.isConnected) branch.scrollTop = branch.scrollHeight;
    });
  }

  function isUserMessage(node) {
    if (!node || node.nodeType !== 1) return false;
    for (const sel of CONFIG.userMessage) {
      if (node.matches && node.matches(sel)) return true;
      if (node.querySelector && node.querySelector(sel)) return true;
    }
    return false;
  }

  function teardownAutoScroll() {
    if (!autoScroll) return;
    autoScroll.observer.disconnect();
    const b = autoScroll.branch;
    b.removeEventListener('wheel', autoScroll.onWheel);
    b.removeEventListener('touchstart', autoScroll.onTouchStart);
    b.removeEventListener('touchmove', autoScroll.onTouchMove);
    b.removeEventListener('scroll', autoScroll.onScroll);
    autoScroll = null;
  }

  function setupAutoScroll(branch) {
    teardownAutoScroll();

    // Stop following the INSTANT the user scrolls up; resume only when they come
    // back to the bottom. The stop keys off wheel/touch DIRECTION, not scroll
    // position — in a wheel handler the scroll hasn't applied yet, so a
    // position check still reads "at the bottom" and the pin yanks you back.
    // (That was the "can't scroll up while it's generating" jank.) Resume uses
    // the real, post-scroll position from the scroll event.
    const RESUME_PX = 24;
    const onWheel = (e) => { if (e.deltaY < 0) stickToBottom = false; };
    let touchY = null;
    const onTouchStart = (e) => { touchY = e.touches[0] ? e.touches[0].clientY : null; };
    const onTouchMove = (e) => {
      const y = e.touches[0] ? e.touches[0].clientY : null;
      if (touchY != null && y != null && y > touchY) stickToBottom = false; // drag down = scroll up
      touchY = y;
    };
    const onScroll = () => {
      if (branch.scrollHeight - branch.scrollTop - branch.clientHeight <= RESUME_PX) {
        stickToBottom = true;
      }
    };
    branch.addEventListener('wheel', onWheel, { passive: true });
    branch.addEventListener('touchstart', onTouchStart, { passive: true });
    branch.addEventListener('touchmove', onTouchMove, { passive: true });
    branch.addEventListener('scroll', onScroll, { passive: true });

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (isUserMessage(node)) stickToBottom = true; // you just sent → jump down
        }
      }
      pinToBottom(branch);
    });
    observer.observe(branch, { childList: true, subtree: true, characterData: true });

    autoScroll = { branch, onWheel, onTouchStart, onTouchMove, onScroll, observer };
    stickToBottom = true;
    pinToBottom(branch);
  }

  /* ------------------------------- apply ----------------------------------- */

  let enabled = true; // master on/off, controlled by the Curvonomics popup toggle
  let cache = {};

  function tagsValid() {
    const { root, composer, cBranch, sBranch } = cache;
    if (!(root && root.isConnected && root.hasAttribute(ATTR.root) &&
          composer && composer.isConnected &&
          cBranch && cBranch.isConnected && cBranch.parentElement === root &&
          cBranch.contains(composer))) {
      return false;
    }
    if (sBranch) {
      // Full setup is in place; valid as long as the message branch is intact.
      return sBranch.isConnected && sBranch.parentElement === root;
    }
    // Empty / new-chat state: only valid UNTIL the first message appears — then
    // we must re-apply to add the internal scroll + auto-scroll (otherwise a
    // freshly-started chat stays janky once you talk in it).
    return !messageExists();
  }

  // Cheap probe: is any conversation turn currently rendered?
  function messageExists() {
    for (const sel of CONFIG.message) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return true;
    }
    return false;
  }

  function clearTags() {
    for (const attr of Object.values(ATTR)) {
      document.querySelectorAll('[' + attr + ']')
        .forEach((el) => el.removeAttribute(attr));
    }
  }

  // Fully restore the page to its native layout (used when toggled off).
  function disableFlip() {
    unbindRootHeight();
    teardownAutoScroll();
    clearTags();
    cache = {};
  }

  function unpinInner(branch, editor) {
    let n = editor;
    while (n && n !== branch) {
      const pos = getComputedStyle(n).position;
      if (pos === 'sticky' || pos === 'fixed' || pos === 'absolute') {
        n.setAttribute(ATTR.unpin, '1');
      }
      n = n.parentElement;
    }
  }

  function apply() {
    if (!enabled) return;    // turned off via the Curvonomics popup toggle
    if (tagsValid()) return; // fast path

    const editor = findEditor();
    if (!editor) return;

    const composer = editor.closest('form') || editor;
    const message = findMessage(editor);

    let root;
    let composerBranch;
    let scrollBranch = null;

    if (message) {
      root = lowestCommonAncestor(composer, message);
      if (!root || root === document.documentElement || root === composer) return;
      composerBranch = branchOf(root, composer);
      scrollBranch = branchOf(root, message);
      if (!composerBranch || !scrollBranch || composerBranch === scrollBranch) return;
    } else {
      root = tallAncestor(composer);
      if (!root) return;
      composerBranch = branchOf(root, composer);
      if (!composerBranch || composerBranch === root) return;
    }

    unbindRootHeight();
    teardownAutoScroll();
    clearTags();

    root.setAttribute(ATTR.root, '1');
    composerBranch.setAttribute(ATTR.composerBranch, '1');
    if (scrollBranch) scrollBranch.setAttribute(ATTR.scrollBranch, '1');
    composer.setAttribute(ATTR.composer, '1');
    unpinInner(composerBranch, editor);

    if (scrollBranch) {
      bindRootHeight(root);
      setupAutoScroll(scrollBranch);
    }

    cache = { root, composer, cBranch: composerBranch, sBranch: scrollBranch };
  }

  /* ---------------------------- scheduling --------------------------------- */

  let queued = false;
  function flush() {
    if (!queued) return;       // already handled by the other trigger
    queued = false;
    try {
      apply();
    } catch (_) {
      /* Never break the host page. */
    }
  }
  function schedule() {
    if (queued) return;
    queued = true;
    // rAF gives smooth, paint-aligned updates while the tab is visible — but it
    // is PAUSED in hidden/background tabs, which would leave `queued` stuck and
    // the flip never applied (the classic "works sometimes" bug). The timeout
    // still fires in background tabs, so the layout is correct the instant you
    // look at it. Whichever fires first wins; the other no-ops.
    requestAnimationFrame(flush);
    setTimeout(flush, 200);
  }

  // React to the popup toggle (chrome.storage) live, without a page refresh.
  function initEnabled() {
    try {
      chrome.storage.local.get({ enabled: true }, (res) => {
        enabled = res.enabled !== false;
        if (enabled) schedule();
        else disableFlip();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.enabled) return;
        enabled = changes.enabled.newValue !== false;
        if (enabled) schedule();
        else disableFlip();
      });
    } catch (_) {
      /* storage unavailable — stay enabled. */
    }
  }

  function start() {
    initEnabled();
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    window.addEventListener('popstate', schedule); // browser back/forward
    window.addEventListener('resize', schedule);   // re-evaluate on viewport change
    setInterval(schedule, 2000);                   // cheap safety net
    schedule();
  }

  if (document.documentElement) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
