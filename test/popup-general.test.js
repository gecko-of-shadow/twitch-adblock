import popupSource from "../src/popup.js" with { type: "text" };
import popupHtml from "../src/popup.html" with { type: "text" };
import settingsSource from "../src/general-settings.js" with { type: "text" };
import backgroundSource from "../src/general-background.js" with { type: "text" };
import manifest from "../manifest.json" with { type: "json" };
import vendorSource from "../src/vendor/video-swap-new.user.js" with { type: "text" };
import youtubeSource from "../src/youtube.js" with { type: "text" };

function assert(condition, label) {
  if (!condition) throw new Error(label || "assert failed");
}

function assertEquals(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label || "expected equal"}\n${left}\n${right}`);
}

Deno.test("general popup defaults on and never auto-fetches lists", () => {
  assert(popupHtml.includes('id="general-enabled"'), "master switch present");
  assert(/id="general-enabled"[^>]*checked|checked[^>]*id="general-enabled"/.test(popupHtml), "master defaults checked");
  assert(popupSource.includes("generalEnabled: true") || popupSource.includes("generalEnabled: true,"), "storage default ON");
  assert(popupSource.includes("updateLists") || popupHtml.includes("Update lists"), "manual Update control");
  assert(!popupSource.includes("chrome.alarms"), "no alarms in popup");
  assert(!/periodInMinutes/.test(backgroundSource), "no repeating alarms in background");
  assert(!backgroundSource.includes("setInterval"), "no interval polling for lists");
  assert(backgroundSource.includes("manual"), "update path is manual");
});

Deno.test("allow-this-page skips Twitch YouTube Kick hosts", () => {
  assert(settingsSource.includes("twitch\\.tv") || settingsSource.includes("twitch.tv"), "settings know twitch");
  assert(settingsSource.includes("youtube\\.com") || settingsSource.includes("youtube.com"), "settings know youtube");
  assert(settingsSource.includes("kick\\.com") || settingsSource.includes("kick.com"), "settings know kick");
  assert(popupSource.includes("HARD_EXCLUDE_HOST_RE"), "popup hard-excludes streams");
  assert(popupHtml.includes("Allow this page"), "allow control labeled");
});

Deno.test("glowing-eyes icon variants are packaged and wired", () => {
  assert(popupHtml.includes("icon48-working.png"), "popup uses working glow icon");
  assert(popupSource.includes("icon48-off.png"), "popup can dim eyes when off");
  assertEquals(manifest.action.default_icon["48"], "icons/icon48-working.png");
  assert(backgroundSource.includes("icon48-working.png"), "worker sets working icon");
  assert(backgroundSource.includes("icon48-off.png"), "worker sets off icon");
});

Deno.test("playback files stay untouched by general UI APIs", () => {
  for (const [name, source] of [
    ["vendor", vendorSource],
    ["youtube", youtubeSource],
  ]) {
    assert(!source.includes("chrome."), `${name} has no chrome.*`);
    assert(!source.includes("generalEnabled"), `${name} does not read general master`);
    assert(!source.includes("declarativeNetRequest"), `${name} does not use DNR`);
  }
});

Deno.test("storage key contract matches settings module", () => {
  assert(settingsSource.includes('enabled: "generalEnabled"'), "enabled key");
  assert(settingsSource.includes('allowedOrigins: "generalAllowedOrigins"'), "allow key");
  assert(settingsSource.includes('listUpdateRequestAt: "generalListUpdateRequestAt"'), "manual update flag");
  assert(settingsSource.includes('RULESET_ID = "general"'), "ruleset id general");
  assert(backgroundSource.includes("importScripts(\"general-settings.js\", \"general/update.js\", \"general/cosmetic-parse.js\")"), "worker loads shared settings");
});

Deno.test("opening the popup sends nothing to the worker; switch, allow and Update tell open tabs to re-read", async () => {
  const handlers = {};
  const element = (id) => ({ id, dataset: {}, textContent: "", checked: true, disabled: false, src: "",
    setAttribute() {}, addEventListener(type, fn) { handlers[id + ":" + type] = fn; } });
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || element(id)), querySelector: () => null };
  const sent = [];
  const tabMessages = [];
  const store = { generalEnabled: true, generalAllowedOrigins: [] };
  const chrome = {
    runtime: { lastError: undefined, getManifest: () => ({ version: "0.0.0" }),
      sendMessage(msg, cb) { sent.push(msg.type); cb({ ok: true }); } },
    storage: { local: {
      get(_k, cb) { cb(structuredClone(store)); },
      set(items, cb) { Object.assign(store, items); cb(); },
    } },
    tabs: {
      query(q, cb) { cb(q.active ? [{ id: 7 }] : [{ id: 7 }, { id: 8 }, {}]); },
      sendMessage(id, msg, opts, cb) {
        if (typeof opts === "function") { cb = opts; opts = undefined; }
        if (msg.type === "pageOrigin") cb({ origin: "https://news.example" });
        else { tabMessages.push([id, msg.type]); cb(); }
      },
    },
  };
  new Function("chrome", "document", popupSource)(chrome, document);
  await new Promise((r) => setTimeout(r, 20));
  assertEquals(sent, [], "popup open: no applyGeneralState round trip");

  els["general-enabled"].checked = false;
  await handlers["general-enabled:change"]();
  assertEquals(tabMessages, [[7, "generalSync"], [8, "generalSync"]], "switch: every tab told to re-read");
  assertEquals(sent, ["applyGeneralState"], "switch still applies DNR");

  tabMessages.length = 0;
  els["general-enabled"].checked = true;
  await handlers["general-enabled:change"]();
  tabMessages.length = 0;
  await handlers["allow-page:click"]();
  assertEquals(store.generalAllowedOrigins, ["https://news.example"], "origin saved");
  assertEquals(tabMessages.length, 2, "allow: tabs told to re-read");

  tabMessages.length = 0;
  await handlers["update-lists:click"]();
  assertEquals(tabMessages.length, 2, "Update: tabs told to re-read");
});
