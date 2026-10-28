import source from "../src/twitch-directory-ads.js" with { type: "text" };
import manifest from "../manifest.json" with { type: "json" };

function assert(condition, label) {
  if (!condition) throw new Error(label || "assertion failed");
}

function assertEquals(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label || "expected equal"}\n${left}\n${right}`);
}

const api = {};
const install = new Function(`${source}\nreturn installTwitchDirectoryAds;`)();
install(api);

Deno.test("directory cosmetic targets the banner slot and grid Ad cards only", () => {
  assert(api.CSS.includes('[data-a-target="browse-banner-ad-slot"]'), "top banner slot");
  assert(api.CSS.includes("display:none!important") || api.CSS.includes("display: none !important"), "slot is hidden");
  assert(source.includes('Leave feedback for this Ad'), "grid Ad feedback control");
  assert(!source.includes("video-swap-new"), "does not edit the player script");
  assert(!source.includes("gql.twitch.tv"), "does not rewrite gql");
  assert(!/video\.pause|currentTime/.test(source), "does not drive the player");
});

Deno.test("a grid Ad card is the node above the shared stream grid", () => {
  function node(attrs, children) {
    const el = {
      attrs,
      children,
      parentElement: null,
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector) {
        const found = [];
        for (const child of this.children) {
          if (selector === '[data-a-target="preview-card-image-link"]' && child.attrs.target === "preview-card-image-link") {
            found.push(child);
          }
          if (selector === "video" && child.attrs.tag === "video") found.push(child);
          found.push(...child.querySelectorAll(selector));
        }
        return found;
      },
    };
    for (const child of children) child.parentElement = el;
    return el;
  }
  const adCard = node({ target: "ad-card" }, [node({ target: "ad-label" }, [])]);
  const stream = node({ target: "stream" }, [node({ target: "preview-card-image-link" }, [])]);
  const other = node({ target: "stream-2" }, [node({ target: "preview-card-image-link" }, [])]);
  const grid = node({ target: "grid" }, [adCard, stream, other]);
  const label = adCard.children[0];
  assert(api.cardFor(label) === adCard, "grid Ad card");
  const player = node({ tag: "video" }, []);
  const watch = node({ target: "player" }, [player, node({ target: "ad-label" }, [])]);
  assert(api.cardFor(watch.children[1]) === watch.children[1], "do not climb into the player");
});

Deno.test("manifest runs directory cosmetic on Twitch pages only", () => {
  const script = manifest.content_scripts.find((entry) => (entry.js || []).includes("src/twitch-directory-ads.js"));
  assert(script, "directory content script");
  assertEquals(script.matches.slice().sort(), ["*://*.twitch.tv/*", "*://twitch.tv/*"]);
  assertEquals(script.run_at, "document_start");
  assert(script.world !== "MAIN", "stay out of the player world");
  const general = manifest.content_scripts.find((entry) => (entry.js || []).includes("src/cosmetic.js"));
  assert((general.exclude_matches || []).includes("*://twitch.tv/*"), "full EasyList sheet stays off Twitch");
});

Deno.test("directory page: a feedback button with no card boundary never hides the page", () => {
  function node(tagName, children, id) {
    const el = { tagName, id: id || "", children, parentElement: null, hidden: false,
      style: { setProperty(k, v) { if (k === "display" && v === "none") el.hidden = true; } },
      matches() { return false; },
      querySelector(s) { return this.querySelectorAll(s)[0] || null; },
      querySelectorAll(s) {
        const out = [];
        for (const c of this.children) {
          if (s === 'button[aria-label="Leave feedback for this Ad"]' && c.tagName === "BUTTON") out.push(c);
          out.push(...c.querySelectorAll(s));
        }
        return out;
      } };
    for (const c of children) c.parentElement = el;
    return el;
  }
  const button = node("BUTTON", []);
  const tiles = node("DIV", [node("DIV", [button]), node("DIV", [])]);
  const root = node("DIV", [tiles], "root");
  const body = node("BODY", [root]);
  const html = node("HTML", [body]);
  assert(api.cardFor(button) === null, "no boundary -> no card");
  api.hideDirectoryAds(html);
  for (const el of [html, body, root, tiles]) assert(!el.hidden, `${el.tagName} must stay visible`);
});

Deno.test("directory watcher: CSS alone hides the banner and Advertisement boxes; mutations only queue feedback buttons, once per frame", () => {
  const watch = new Function(`${source}\nreturn watchDirectoryAds;`)();
  assert(api.CSS.startsWith('[data-a-target="browse-banner-ad-slot"],[aria-label="Advertisement"],'), "both hidden by the injected style");
  const FEEDBACK = api.FEEDBACK_SELECTOR;
  function el(tag, children = [], attrs = {}) {
    const e = { nodeType: 1, tagName: tag, attrs, children, parentElement: null, isConnected: true, hidden: false, id: "",
      style: { setProperty(k, v) { if (k === "display" && v === "none") e.hidden = true; } },
      matches(s) { return s === FEEDBACK && tag === "BUTTON"; },
      querySelector(s) { return this.querySelectorAll(s)[0] || null; },
      querySelectorAll(s) {
        const out = [];
        for (const c of this.children) {
          if ((s === FEEDBACK && c.tagName === "BUTTON") || (s === "video" && c.tagName === "VIDEO") ||
            (s === '[data-a-target="preview-card-image-link"]' && c.attrs.preview)) out.push(c);
          out.push(...c.querySelectorAll(s));
        }
        return out;
      } };
    for (const c of children) c.parentElement = e;
    return e;
  }
  const frames = [];
  const raf = (fn) => frames.push(fn);
  const style = { isConnected: true };
  const doc = { documentElement: { appendChild(s) { s.isConnected = true; } } };
  let looks = 0;
  const spy = Object.assign({}, api, { hideCardOf: (b) => { looks++; return api.hideCardOf(b); } });
  const onMutations = watch(spy, doc, style, raf);

  // Chat churn: many batches, no feedback buttons -> one frame queued, no card lookups.
  for (let i = 0; i < 50; i++) onMutations([{ addedNodes: [el("DIV", [el("SPAN")])] }]);
  assertEquals(frames.length, 1, "coalesced to one frame");
  frames.shift()();
  assertEquals(looks, 0, "no card lookups for chat lines");

  // A grid Ad card lands: its card is hidden on the next frame, and only once.
  const button = el("BUTTON");
  const adCard = el("DIV", [el("DIV", [button])]);
  const grid = el("DIV", [adCard, el("DIV", [el("A", [], { preview: true })]), el("DIV", [el("A", [], { preview: true })])]);
  onMutations([{ addedNodes: [grid] }]);
  frames.shift()();
  assert(adCard.hidden && looks === 1, "card hidden after one look");
  onMutations([{ addedNodes: [el("DIV")] }]);
  frames.shift()();
  assertEquals(looks, 1, "a handled button is not looked at again");

  // A button whose grid isn't there yet is retried on later frames, then dropped.
  looks = 0;
  const early = el("BUTTON");
  const lonely = el("DIV", [el("DIV", [early])]);
  el("DIV", [lonely]);
  onMutations([{ addedNodes: [lonely] }]);
  for (let i = 0; i < 15; i++) { frames.shift()(); onMutations([{ addedNodes: [el("DIV")] }]); }
  frames.shift()();
  assertEquals(looks, 10, "retried up to 10 looks");

  // The hide style is put back if the page drops it.
  style.isConnected = false;
  onMutations([{ addedNodes: [el("DIV")] }]);
  frames.shift()();
  assert(style.isConnected, "style re-attached");
});
