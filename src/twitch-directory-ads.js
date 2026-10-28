// Directory display ads on Twitch. Hides the browse banner slot and in-grid
// Ad cards. Does not rewrite playback requests or the player.
function installTwitchDirectoryAds(target) {
  const BANNER_SELECTOR = '[data-a-target="browse-banner-ad-slot"]';
  const FEEDBACK_SELECTOR = 'button[aria-label="Leave feedback for this Ad"]';
  const STYLE_ID = "twitch-adblock-directory-ads";
  const CSS = [
    BANNER_SELECTOR,
    '[aria-label="Advertisement"]',
    FEEDBACK_SELECTOR,
  ].join(",") + "{display:none!important;}";

  // Climb from the feedback button to the ad card: stop at the first ancestor
  // whose parent holds a video or several preview cards. If no such boundary
  // is found (e.g. the ad video was blocked and the page uses category tiles,
  // as on /directory), return null instead of a page-wide container.
  function cardFor(node) {
    let current = node;
    for (let i = 0; i < 10 && current && current.parentElement; i++) {
      const parent = current.parentElement;
      if (parent.querySelector && parent.querySelector("video")) return current;
      const previews = parent.querySelectorAll
        ? parent.querySelectorAll('[data-a-target="preview-card-image-link"]')
        : [];
      if (previews.length > 1) return current;
      current = parent;
    }
    return null;
  }

  function isPageRoot(el) {
    const tag = String(el.tagName || "").toLowerCase();
    if (tag === "html" || tag === "body" || tag === "main") return true;
    return el.id === "root" || (el.matches && el.matches('[data-a-target="root-scroller"],.root-scrollable'));
  }

  function hide(element) {
    if (!element || isPageRoot(element) || !element.style || typeof element.style.setProperty !== "function") return;
    if (element.querySelector && element.querySelector("video")) return;
    element.style.setProperty("display", "none", "important");
  }

  // The banner slot and [aria-label="Advertisement"] are hidden by CSS alone.
  // Only the grid Ad card needs script: CSS can't reach from the feedback
  // button up to its card. A button whose card was found is not looked at
  // again; one with no boundary yet is retried a few times as the grid fills.
  const MAX_CARD_TRIES = 10;
  const done = typeof WeakSet === "function" ? new WeakSet() : null;
  const tries = typeof WeakMap === "function" ? new WeakMap() : null;

  // True once the button needs no more looks (card hidden, or out of tries).
  function hideCardOf(button) {
    if (done && done.has(button)) return true;
    const card = cardFor(button);
    if (card) {
      hide(card);
      if (done) done.add(button);
      return true;
    }
    if (!tries || !done) return false;
    const n = (tries.get(button) || 0) + 1;
    tries.set(button, n);
    if (n < MAX_CARD_TRIES) return false;
    done.add(button);
    return true;
  }

  function feedbackButtonsIn(node, out) {
    if (!node || node.nodeType !== 1) return out;
    if (node.matches && node.matches(FEEDBACK_SELECTOR)) out.push(node);
    if (node.querySelectorAll) out.push(...node.querySelectorAll(FEEDBACK_SELECTOR));
    return out;
  }

  function sweep(root) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    root.querySelectorAll(FEEDBACK_SELECTOR).forEach(hideCardOf);
  }

  target.BANNER_SELECTOR = BANNER_SELECTOR;
  target.FEEDBACK_SELECTOR = FEEDBACK_SELECTOR;
  target.STYLE_ID = STYLE_ID;
  target.CSS = CSS;
  target.cardFor = cardFor;
  target.hideCardOf = hideCardOf;
  target.feedbackButtonsIn = feedbackButtonsIn;
  target.hideDirectoryAds = sweep;
}

// Mutation batches only queue the feedback buttons inside added nodes (a
// small subtree each, and chat on channel pages adds many); card lookups run
// at most once per animation frame. Buttons without a card yet are retried on
// the next frame that follows a mutation.
function watchDirectoryAds(api, doc, style, raf) {
  const pending = new Set();
  const retry = new Set();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!style.isConnected) (doc.documentElement || doc.head || doc).appendChild(style);
    const buttons = Array.from(pending);
    pending.clear();
    for (const button of buttons) {
      if (!button.isConnected) continue;
      if (!api.hideCardOf(button)) retry.add(button);
    }
  };
  return (records) => {
    for (const button of retry) pending.add(button);
    retry.clear();
    for (const record of records) {
      for (const node of record.addedNodes || []) api.feedbackButtonsIn(node, []).forEach((b) => pending.add(b));
    }
    if (!scheduled) {
      scheduled = true;
      raf(flush);
    }
  };
}

function startTwitchDirectoryAds() {
  let host = "";
  try {
    host = location.hostname;
  } catch {
    return;
  }
  const name = String(host || "").toLowerCase();
  if (name !== "twitch.tv" && !name.endsWith(".twitch.tv")) return;
  const api = {};
  installTwitchDirectoryAds(api);
  const style = document.createElement("style");
  style.id = api.STYLE_ID;
  style.textContent = api.CSS;
  (document.documentElement || document.head || document).appendChild(style);
  api.hideDirectoryAds(document);
  if (typeof MutationObserver !== "function") return;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
  const observer = new MutationObserver(watchDirectoryAds(api, document, style, raf));
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

if (typeof document !== "undefined" && typeof location !== "undefined") {
  startTwitchDirectoryAds();
}
