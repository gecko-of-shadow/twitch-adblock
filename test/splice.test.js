// In-place splice: stitched ad slots are filled with the clean segment another
// player type lists for the same wall-clock time. No setSrc, no reload.
import pageSource from "../src/page.js" with { type: "text" };
import playlistSource from "../src/playlist.js" with { type: "text" };

function assertEquals(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${label || "expected equal values"}\n${left}\n${right}`);
}

function assert(condition, label) {
  if (!condition) throw new Error(label);
}

const playlist = new Function(`${playlistSource}\nreturn TwitchAdblockPlaylist;`)();
globalThis.TwitchAdblockPlaylist = playlist;
const guardSource = pageSource.slice(pageSource.indexOf("function createPlaylistGuard"));
const createPlaylistGuard = new Function(`${guardSource}\nreturn createPlaylistGuard;`)();

const T0 = Date.parse("2026-10-09T06:00:00.234Z");
const iso = (ms) => new Date(ms).toISOString();

// A Twitch-shaped live media playlist: one PDT per 2 s segment, ad slots inside
// [adFrom, adTo) segment indexes, two prefetch lines at the edge.
function media({ host, first = 0, count = 8, adFrom = -1, adTo = -1, upcoming = false, prefetch = true, adDisc = true }) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:6", `#EXT-X-MEDIA-SEQUENCE:${1000 + first}`];
  lines.push(`#EXT-X-DATERANGE:ID="playlist-creation-1",CLASS="timestamp",START-DATE="${iso(T0)}"`);
  if (adFrom >= 0) {
    lines.push(`#EXT-X-DATERANGE:ID="stitched-ad-1",CLASS="twitch-stitched-ad",START-DATE="${iso(T0 + adFrom * 2000)}",DURATION=${(adTo - adFrom) * 2}.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"`);
  }
  for (let n = first; n < first + count; n++) {
    const ad = n >= adFrom && n < adTo;
    if (adDisc && (n === adFrom || (adFrom >= 0 && n === adTo))) lines.push("#EXT-X-DISCONTINUITY");
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + n * 2000)}`);
    lines.push(ad ? "#EXTINF:2.000,Amazon|123" : "#EXTINF:2.000,live");
    lines.push(ad ? `https://ads.example/ad-${n}.ts` : `https://${host}/seg-${n}.ts`);
  }
  if (upcoming) {
    lines.push(`#EXT-X-DATERANGE:ID="stitched-ad-2",CLASS="twitch-stitched-ad",START-DATE="${iso(T0 + (first + count) * 2000 + 1000)}",DURATION=30.000,X-TV-TWITCH-AD-ROLL-TYPE="MIDROLL"`);
  }
  if (prefetch) {
    const last = first + count;
    const adEdge = upcoming || (last >= adFrom && last < adTo);
    lines.push(`#EXT-X-TWITCH-PREFETCH:${adEdge ? "https://ads.example/pf-" + last : "https://" + host + "/pf-" + last}.ts`);
  }
  return lines.join("\n");
}

const segs = (text) => text.split("\n").filter((line) => line && !line.startsWith("#"));

Deno.test("each ad slot gets the clean segment for the same wall clock, one for one", () => {
  const main = media({ host: "main.example", count: 8, adFrom: 3, adTo: 6 });
  const clean = media({ host: "embed.example", count: 8 });
  const result = playlist.spliceAligned(main, clean, "https://embed.example/v.m3u8", { seamless: true });
  assert(result.ok, "splice accepted");
  assertEquals(result.replaced, 3);
  assertEquals(segs(result.text), [
    "https://main.example/seg-0.ts", "https://main.example/seg-1.ts", "https://main.example/seg-2.ts",
    "https://embed.example/seg-3.ts", "https://embed.example/seg-4.ts", "https://embed.example/seg-5.ts",
    "https://main.example/seg-6.ts", "https://main.example/seg-7.ts",
  ], "same count, same times, no ad url");
  assert(!result.text.includes("stitched-ad"), "the ad marker is gone so the player shows no ad UI");
  assert(!result.text.includes("Amazon"), "no ad EXTINF title left");
  assert(result.text.includes("#EXT-X-MEDIA-SEQUENCE:1000"), "numbering untouched");
  assert(!playlist.hasAdBreak(result.text), "result is a clean playlist");
});

Deno.test("same rendition splices without discontinuities, another rendition marks both edges", () => {
  const main = media({ host: "main.example", count: 8, adFrom: 3, adTo: 6 });
  const clean = media({ host: "embed.example", count: 8 });
  const seamless = playlist.spliceAligned(main, clean, "", { seamless: true });
  assertEquals(seamless.text.includes("#EXT-X-DISCONTINUITY"), false, "identical bytes need no new timeline");
  const other = playlist.spliceAligned(main, clean, "", { seamless: false });
  assertEquals(other.text.split("\n").filter((line) => line === "#EXT-X-DISCONTINUITY").length, 2, "one break in, one break out");
});

Deno.test("slots past the clean edge wait for the next refresh; a gap or a long lag refuses", () => {
  const main = media({ host: "main.example", count: 8, adFrom: 4, adTo: 20 });
  const lagging = media({ host: "embed.example", count: 6 });
  const waited = playlist.spliceAligned(main, lagging, "", { seamless: true });
  assert(waited.ok, "two tail slots can wait");
  assertEquals(waited.trimmed, 2);
  assertEquals(segs(waited.text).length, 6, "the tail is left out, nothing earlier moves");
  assert(!waited.text.includes("ads.example"), "no ad prefetch either");

  const farBehind = media({ host: "embed.example", count: 3 });
  assertEquals(playlist.spliceAligned(main, farBehind, "", { seamless: true }).ok, false, "too far behind: refuse (no freeze at the edge)");

  const holey = media({ host: "embed.example", count: 8 }).replace(/#EXT-X-PROGRAM-DATE-TIME:[^\n]*\n#EXTINF:2.000,live\nhttps:\/\/embed.example\/seg-5.ts\n/, "");
  const gap = playlist.spliceAligned(main, holey, "", { seamless: true });
  assertEquals(gap.ok, false, "a missing middle slot refuses instead of repeating a segment");
});

Deno.test("a clean playlist with its own ad never fills a slot with ad video", () => {
  const main = media({ host: "main.example", count: 8, adFrom: 3, adTo: 6 });
  const dirty = media({ host: "embed.example", count: 8, adFrom: 3, adTo: 6 });
  const result = playlist.spliceAligned(main, dirty, "", { seamless: true });
  assertEquals(result.ok, false, "all player types dirty: refuse, the swap path and fail-open decide");
  assertEquals(result.text, main.replaceAll("\r", ""), "refusal returns main unchanged");
});

Deno.test("no segment is ever listed twice, even when slot times are close together", () => {
  const main = media({ host: "main.example", count: 8, adFrom: 3, adTo: 6 })
    .replace(`#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + 8000)}`, `#EXT-X-PROGRAM-DATE-TIME:${iso(T0 + 6100)}`);
  const clean = media({ host: "embed.example", count: 8 });
  const result = playlist.spliceAligned(main, clean, "", { seamless: true });
  const all = segs(result.text);
  assertEquals(new Set(all).size, all.length, "no anchor duplication");
});

Deno.test("a slot keeps its partner after the clean playlist scrolls past it", () => {
  const memory = new Map();
  const first = playlist.spliceAligned(media({ host: "main.example", first: 0, count: 8, adFrom: 2, adTo: 30 }), media({ host: "embed.example", first: 0, count: 8 }), "", { seamless: true, memory });
  assert(first.ok, "first refresh fills");
  // Main keeps a longer window than the clean playlist: slot 2 is gone from clean.
  const second = playlist.spliceAligned(media({ host: "main.example", first: 0, count: 10, adFrom: 2, adTo: 30 }), media({ host: "embed.example", first: 4, count: 6 }), "", { seamless: true, memory });
  assert(second.ok, "head slots come from memory");
  assertEquals(segs(second.text).slice(2, 4), ["https://embed.example/seg-2.ts", "https://embed.example/seg-3.ts"], "same partner as before");
});

Deno.test("prefetch lead is kept: main's own at a live edge, the clean edge's during the break", () => {
  const liveEdge = playlist.spliceAligned(media({ host: "main.example", count: 8, adFrom: 2, adTo: 4 }), media({ host: "embed.example", count: 8 }), "", { seamless: true });
  assert(liveEdge.text.includes("#EXT-X-TWITCH-PREFETCH:https://main.example/pf-8.ts"), "main prefetch stays when its edge is live");
  const adEdge = playlist.spliceAligned(media({ host: "main.example", count: 8, adFrom: 4, adTo: 30 }), media({ host: "embed.example", count: 8 }), "", { seamless: true });
  assert(adEdge.text.includes("#EXT-X-TWITCH-PREFETCH:https://embed.example/pf-8.ts"), "clean prefetch at the same edge");
  assert(!adEdge.text.includes("ads.example"), "never an ad prefetch");
  const upcoming = playlist.spliceAligned(media({ host: "main.example", count: 8, upcoming: true }), media({ host: "embed.example", count: 8 }), "", { seamless: true });
  assert(upcoming.ok && !upcoming.text.includes("ads.example") && !upcoming.text.includes("stitched-ad"), "an upcoming break leaks neither its marker nor its prefetch");
  assert(upcoming.text.includes("https://embed.example/pf-8.ts"), "and the lead is still there");
});

Deno.test("a maf client-ad cue is not a stitched slot and is never spliced", () => {
  const maf = media({ host: "main.example", count: 6 }).replace("#EXT-X-VERSION:3", '#EXT-X-VERSION:3\n#EXT-X-DATERANGE:ID="maf-ad-1",CLASS="twitch-maf-ad",START-DATE="' + iso(T0) + '",PLANNED-DURATION=60.000,END-ON-NEXT=YES');
  assertEquals(playlist.hasAdBreak(maf), false);
});

// ---- guard level -------------------------------------------------------------

function playlistResponse(body) {
  return new Response(body, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } });
}
const rung = '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,CODECS="avc1.4D401F",FRAME-RATE=30.000,VIDEO="720p30"';
const master = (url) => ["#EXTM3U", rung, url].join("\n");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness({ dirtyBackups = false } = {}) {
  const state = { first: 0, ad: false, reloads: 0, statuses: [], gql: 0 };
  const guard = createPlaylistGuard({
    handoffGraceMs: 0,
    probeDeadlineMs: 200,
    async fetch(url) {
      const value = String(url);
      if (value.includes("/channel/hls/")) {
        const type = (value.match(/token=([a-z-]+)/) || [])[1];
        return playlistResponse(master(`https://${type}.example/v720.m3u8`));
      }
      const adNow = state.ad ? { adFrom: state.first + 3, adTo: state.first + 40 } : {};
      if (value.startsWith("https://live.example/")) return playlistResponse(media({ host: "live.example", first: state.first, count: 8, ...adNow }));
      const host = new URL(value).host;
      if (host.endsWith(".example") && value.endsWith("v720.m3u8")) {
        return playlistResponse(media({ host, first: state.first, count: 8, ...(dirtyBackups ? adNow : {}) }));
      }
      return new Response("missing", { status: 404 });
    },
    async gql(body) {
      state.gql += 1;
      return JSON.stringify({ data: { streamPlaybackAccessToken: { value: body.variables.playerType, signature: "sig" } } });
    },
    reload() {
      state.reloads += 1;
    },
    status(on) {
      state.statuses.push(on);
    },
  });
  return { guard, state };
}

Deno.test("a stitched break plays through on the same source: spliced, zero reloads, no ad", async () => {
  const { guard, state } = harness();
  const masterUrl = "https://usher.ttvnw.net/api/v2/channel/hls/somechan.m3u8?token=live&sig=x";
  const masterText = await (await guard(masterUrl)).text();
  assert(masterText.includes("https://live.example/v720.m3u8"), "no break: main ladder");
  const variant = "https://live.example/v720.m3u8";
  await (await guard(variant)).text();
  state.ad = true;
  for (let step = 0; step < 6; step++) {
    const text = await (await guard(variant)).text();
    assert(!text.includes("ads.example"), "no ad segment reaches the player");
    assert(!text.includes("stitched-ad"), "no ad marker reaches the player");
    assert(text.includes("https://live.example/seg-" + state.first + ".ts"), "main source kept");
    if (step > 0) assert(text.includes(".example/seg-" + (state.first + 3) + ".ts") && !text.includes("live.example/seg-" + (state.first + 3) + ".ts"), "the ad slot holds the clean segment for its time");
    state.first += 1;
  }
  state.ad = false;
  const after = await (await guard(variant)).text();
  assert(after.includes("live.example") && !after.includes("embed.example"), "back on main's own segments, untouched");
  await flush();
  assertEquals(state.reloads, 0, "no setSrc at any point");
});

Deno.test("every player type dirty: splice refuses and fail-open still passes the break", async () => {
  const { guard, state } = harness({ dirtyBackups: true });
  const masterUrl = "https://usher.ttvnw.net/api/v2/channel/hls/somechan.m3u8?token=live&sig=x";
  await (await guard(masterUrl)).text();
  const variant = "https://live.example/v720.m3u8";
  state.ad = true;
  const text = await (await guard(variant)).text();
  assert(text.includes("ads.example"), "the safety net: real ad passes instead of a freeze");
  await flush();
  assertEquals(state.reloads, 0, "no reload in fail-open");
});

import realEnd from "./fixtures/twitch-stitched-real-end.m3u8" with { type: "text" };

Deno.test("a real captured stitched break (redacted) is filled and its odd tail keeps one discontinuity", () => {
  // Clean embed rung for the same minutes: Twitch's 2 s grid that the ad followed.
  const times = [...realEnd.matchAll(/#EXT-X-PROGRAM-DATE-TIME:(\S+)/g)].map((match) => Date.parse(match[1]));
  const lines = ["#EXTM3U", "#EXT-X-MEDIA-SEQUENCE:500"];
  for (let t = Date.parse("2026-10-09T06:47:55.234Z"); t <= Math.max(...times) + 2000; t += 2000) {
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(t).toISOString()}`, "#EXTINF:2.000,live", `https://embed.example/at-${t}.ts`);
  }
  const before = playlist.hasAdBreak(realEnd);
  assert(before, "the fixture is a stitched break");
  const result = playlist.spliceAligned(realEnd, lines.join("\n"), "", { seamless: true });
  assert(result.ok, "accepted: " + result.why);
  assertEquals(result.replaced, result.need);
  assert(result.need >= 10, "every ad slot in the window was filled");
  assert(!result.text.includes("1911625960"), "no ad creative title or source left");
  assert(!result.text.includes("twitch-ad-quartile"), "no quartile ranges for the ad UI");
  assert(!playlist.hasAdBreak(result.text), "player sees a plain live playlist");
  assertEquals(result.text.split("\n").filter((line) => line === "#EXT-X-DISCONTINUITY").length, 1, "only where the live cut really moved (.234 -> .501)");
  assertEquals(segs(result.text).length, segs(realEnd).length, "one for one");
});
