// Constraints that used to live only in comments.
import manifest from "../manifest.json" with { type: "json" };
import rules from "../src/rules/general-network.json" with { type: "json" };
import mergeMeta from "../src/rules/dnr-merge-meta.json" with { type: "json" };
import ytRules from "../src/rules/ubo-youtube-network.json" with { type: "json" };
import updateSource from "../src/general/update.js" with { type: "text" };
import cosmeticSource from "../src/cosmetic.js" with { type: "text" };
import parseSource from "../src/general/cosmetic-parse.js" with { type: "text" };
import excludeSource from "../src/general-exclude-hosts.js" with { type: "text" };
import popupSource from "../src/popup.js" with { type: "text" };
import popupHtml from "../src/popup.html" with { type: "text" };
import settingsSource from "../src/general-settings.js" with { type: "text" };
import youtubeSource from "../src/youtube.js" with { type: "text" };
import youtubeCss from "../src/youtube-ads.css" with { type: "text" };
import packerSource from "../scripts/pack-filter-lists.py" with { type: "text" };

function assert(condition, label) {
  if (!condition) throw new Error(label || "assertion failed");
}

function assertEquals(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label || "expected equal"}\n${left}\n${right}`);
}

const updateApi = {};
new Function(`${updateSource}\nreturn installGeneralAdblockUpdate;`)()(updateApi);
const cosmeticApi = {};
new Function(`${cosmeticSource}\nreturn installCosmeticHide;`)()(cosmeticApi);
const parseApi = new Function("self", `${parseSource}\nreturn self.GeneralCosmeticParse;`)({});
const excludeApi = {};
new Function(`${excludeSource}\nreturn installGeneralExcludeHosts;`)()(excludeApi);

function evalConst(src, name) {
  const m = src.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\s*\\};)`));
  if (!m) throw new Error("missing const " + name);
  return new Function(`return ${m[1]}`)();
}

function quotedList(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) throw new Error("missing " + marker);
  const bracket = src.indexOf("[", at);
  const paren = src.indexOf("(", at);
  const start = bracket === -1 ? paren : paren === -1 ? bracket : Math.min(bracket, paren);
  const close = src[start] === "(" ? src.indexOf("\n)", start) : src.indexOf("];", start);
  if (start < 0 || close < 0) throw new Error("unclosed " + marker);
  return [...src.slice(start, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function cssSelectors(src, name) {
  const m = src.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\])\\.join`));
  if (!m) throw new Error("missing " + name);
  return new Function(`return ${m[1]}`)();
}

async function pythonJson(code) {
  const root = new URL("..", import.meta.url);
  const res = await new Deno.Command("python3", {
    args: ["-c", code],
    cwd: root,
    env: { PYTHONDONTWRITEBYTECODE: "1" },
  }).output();
  const stderr = new TextDecoder().decode(res.stderr);
  if (res.code !== 0) throw new Error(stderr || "python failed");
  return JSON.parse(new TextDecoder().decode(res.stdout));
}

const FIXTURE = [
  "[Adblock Plus 2.0]",
  "! Expires: 4 days",
  "||ads.example.com^",
  "||track.example.net^$third-party",
  "||scoped.example.org^$domain=foo.com",
  "@@||ok.example.com^",
  "example.com##.ad",
  "/banner/*",
  "0.0.0.0 hosts.example.io",
  "127.0.0.1 localhost",
  "bare.example.co",
  "||bad*.example.com^",
  "||popup.example.com^$popup",
  "||both.example.com^$script,popup",
  "||keep.example.com^$important",
  "||img.example.com^$image",
  "||gone.example.com^$removeparam=foo",
  "0.0.0.0 local",
  "",
].join("\n");

Deno.test("list refresh parser matches the packer's extract_domains", async () => {
  const fromJs = updateApi.parseList(FIXTURE);
  const fromPy = await pythonJson(`
import importlib.util, json
spec = importlib.util.spec_from_file_location("pfl", "scripts/pack-filter-lists.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps(mod.extract_domains(${JSON.stringify(FIXTURE)})))
`);
  assertEquals(fromJs, fromPy, "parseList vs extract_domains");
  assert(!fromJs.includes("ok.example.com"), "@@ exceptions are not packed");
  assert(!fromJs.includes("popup.example.com"), "popup-only rules are not whole-domain blocks");
});

Deno.test("list-download allow rule sits outside list and user-allow id ranges", () => {
  const id = updateApi.LIST_ALLOW_RULE_ID;
  assert(id >= updateApi.ALLOW_RULE_ID_BASE + 10000, "outside the user-allow window 900000-909999");
  assert(!(id >= updateApi.LIST_RULE_ID_BASE && id < updateApi.ALLOW_RULE_ID_BASE), "not a list rule id");
  const rule = updateApi.listAllowRule("extid");
  assertEquals(rule.id, id);
  assert(rule.priority > 2_000_000, "outranks stream allows");
  assertEquals(rule.condition.initiatorDomains, ["extid"]);
});

Deno.test("never-block suffixes match between the packer and the refresh parser", () => {
  const js = quotedList(updateSource, "const NEVER_BLOCK_SUFFIXES");
  const py = quotedList(packerSource, "NEVER_BLOCK_SUFFIXES");
  assertEquals(js, py);
  for (const host of js) {
    assert(updateApi.isNeverBlock(host), host);
    assert(updateApi.isNeverBlock("cdn." + host), "child " + host);
  }
});

Deno.test("popup repeats general-settings keys and loads only popup.js", () => {
  assertEquals(evalConst(popupSource, "KEYS"), evalConst(settingsSource, "STORAGE_KEYS"));
  assertEquals(evalConst(popupSource, "DEFAULTS"), evalConst(settingsSource, "DEFAULTS"));
  const popupRe = popupSource.match(/const HARD_EXCLUDE_HOST_RE = (\/[\s\S]*?\/i);/);
  const settingsRe = settingsSource.match(/const HARD_EXCLUDE_HOST_RE = (\/[\s\S]*?\/i);/);
  assert(popupRe && settingsRe && popupRe[1] === settingsRe[1], "hard-exclude regex copied, not imported");
  const tags = [...popupHtml.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assertEquals(tags, ['<script src="popup.js">']);
  assert(!/<script(?![^>]*\bsrc="popup\.js")/.test(popupHtml), "no inline or other script");
});

Deno.test("cosmetic host check covers manifest excludes plus player CDNs the manifest still injects", () => {
  const script = manifest.content_scripts.find((entry) => (entry.js || []).includes("src/cosmetic.js"));
  assert(script.js[0] === "src/general/cosmetic-parse.js" && script.js[1] === "src/cosmetic.js", "parse loads before cosmetic.js");
  const manifestHosts = new Set();
  for (const pattern of script.exclude_matches) {
    const host = pattern.replace("*://", "").replace("*.", "").replace("/*", "");
    manifestHosts.add(host);
    assert(cosmeticApi.hostExcluded(host), "exclude_matches " + host);
    assert(cosmeticApi.hostExcluded("sub." + host), "child of " + host);
  }
  for (const extra of ["ttvnw.net", "jtvnw.net"]) {
    assert(cosmeticApi.hostExcluded(extra) && cosmeticApi.hostExcluded("edge." + extra), extra);
    assert(!manifestHosts.has(extra), extra + " is a host-check exclude, not an exclude_matches host");
  }
  assert(cosmeticApi.hostExcluded("static.twitchcdn.net"));
  assert(!script.exclude_matches.some((pattern) => pattern.includes("twitchcdn")), "twitchcdn is not an exclude_matches host");
  for (const host of ["twitch.tv", "youtube.com", "youtu.be", "youtube-nocookie.com", "youtubekids.com", "googlevideo.com", "kick.com", "kickusercontent.com"]) {
    assert(cosmeticApi.hostExcluded(host), "hard exclude " + host);
  }
  assert(cosmeticApi.hostExcluded("i.ytimg.com") && cosmeticApi.hostExcluded("yt3.ggpht.com"));
});

Deno.test("subframes skip the generic cosmetic sheet; a bad sheet fails open", async () => {
  const stored = parseApi.toStorage(parseApi.parseCosmetic("##.generic-ad\nnews.example##.site-ad"));
  assert(!parseApi.keysForHost("news.example", false).includes(parseApi.KEY_GENERIC), "subframe read skips cosG");
  assert(parseApi.keysForHost("news.example", true).includes(parseApi.KEY_GENERIC));
  const parsed = parseApi.parseCosmetic("##.generic-ad\nnews.example##.site-ad");
  assertEquals(Object.keys(parsed).sort(), ["exceptions", "generic", "sites", "stats"]);

  const local = {};
  new Function(`${cosmeticSource}\nreturn installCosmeticHide;`)()(local);
  local.hostname = "news.example";
  local.href = "https://news.example/a";
  local.isTop = false;
  local.parse = parseApi;
  let requested = [];
  await local.readStorage((keys, cb) => {
    requested = keys;
    cb({});
  });
  assert(!requested.includes(parseApi.KEY_GENERIC), "subframe storage read");
  assert(requested.includes(parseApi.KEY_META));

  const el = { id: "", isConnected: false, textContent: "" };
  const previous = globalThis.document;
  globalThis.document = {
    createElement() {
      return el;
    },
    documentElement: {
      appendChild(node) {
        node.isConnected = true;
      },
    },
    getElementById() {
      return null;
    },
  };
  try {
    const hidden = await local.applyState({ enabled: true, stored });
    assertEquals(hidden, true);
    assert(el.textContent.includes(".site-ad{"), el.textContent);
    assert(!el.textContent.includes(".generic-ad{"), el.textContent);
    local.isTop = true;
    await local.applyState({ enabled: true, stored });
    assert(el.textContent.includes(".generic-ad{"), "top frame keeps the generic sheet");
    assertEquals(typeof local.applyEnabled, "function");
    assertEquals(await local.applyEnabled(false), false);

    local.isTop = true;
    local.parse = {
      KEY_META: parseApi.KEY_META,
      buildPageCss() {
        throw new Error("bad sheet");
      },
    };
    local.runtimeGetURL = () => "chrome-extension://x/src/cosmetic-hide.css";
    const failed = await local.applyState({ enabled: true, stored }, () => Promise.reject(new Error("no css")));
    assertEquals(failed, false);
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});

Deno.test("broad clouds stay off the stream-allow list", () => {
  for (const host of ["googleapis.com", "imasdk.googleapis.com", "gstatic.com", "www.googleapis.com"]) {
    assert(!excludeApi.isExcludedHost(host), host);
    assert(!excludeApi.VIDEO_CDN_DOMAINS.includes(host), host);
    assert(!excludeApi.SITE_DOMAINS.includes(host), host);
  }
});

Deno.test("merge script domain lists match the exclusion module, and list blocks start at id 100", async () => {
  const packed = await pythonJson(`
import ast, json
from pathlib import Path
tree = ast.parse(Path("scripts/merge-dnr-rules.py").read_text())
found = {}
for node in tree.body:
    if isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id in ("SITE_DOMAINS", "VIDEO_CDN_DOMAINS", "BLOCK_ID_START", "YT_AD_BLOCK_ID"):
                found[target.id] = ast.literal_eval(node.value)
print(json.dumps(found))
`);
  assertEquals(packed.SITE_DOMAINS, [...excludeApi.SITE_DOMAINS]);
  assertEquals(packed.VIDEO_CDN_DOMAINS, [...excludeApi.VIDEO_CDN_DOMAINS]);
  assertEquals(packed.BLOCK_ID_START, 100);
  assertEquals(packed.YT_AD_BLOCK_ID, 4);
  assertEquals(mergeMeta.block_id_start, 100);
  assertEquals(mergeMeta.site_domains, [...excludeApi.SITE_DOMAINS]);
  assertEquals(mergeMeta.video_cdn_domains, [...excludeApi.VIDEO_CDN_DOMAINS]);
  const below = rules.filter((rule) => rule.id < 100).map((rule) => rule.id).sort((a, b) => a - b);
  assertEquals(below, [1, 2, 3, 4]);
  assertEquals(Math.min(...rules.filter((rule) => rule.id >= 100).map((rule) => rule.id)), 100);
});

Deno.test("uBO YouTube network rules outrank the general YouTube frame allow", () => {
  assert(ytRules.length > 0, "rules shipped");
  for (const rule of ytRules) {
    assert(rule.priority > 2_000_000, "priority " + rule.priority);
  }
});

Deno.test("uBO bundle installs once, and the push trap checks constructor.name before length", async () => {
  const main = await Deno.readTextFile(new URL("../src/vendor/ubo-youtube.js", import.meta.url));
  const isolated = await Deno.readTextFile(new URL("../src/vendor/ubo-youtube-isolated.js", import.meta.url));
  assert(main.includes('if (globalThis[Symbol.for("twitch-adblock.ubo")]) { return; }'), "main guard");
  assert(isolated.includes('if (globalThis[Symbol.for("twitch-adblock.ubo-isolated")]) { return; }'), "isolated guard");
  const at = isolated.indexOf("constructor.name");
  assert(at > 0, "push trap present");
  const window = isolated.slice(at, at + 160);
  const lengthAt = window.indexOf("o.length");
  assert(lengthAt > 0 && window.indexOf("constructor.name") < lengthAt, window);
});

Deno.test("youtube-ads.css includes every selector the script would inject", () => {
  for (const name of ["HOME_FEED_AD_CSS", "INTERRUPTIONS_TOAST_CSS"]) {
    for (const selector of cssSelectors(youtubeSource, name)) {
      assert(youtubeCss.includes(selector), name + " " + selector);
    }
  }
});
