# Efficiency check — 2026-10-11, v0.2.3 source review

Reference notes from a code review and micro-benchmark session on the runtime
scripts shipped in stable v0.2.3. This is the source-level companion to
[efficiency-check-2026-10-11.md](./efficiency-check-2026-10-11.md), which
measures the v0.2.12 beta in headless Chrome; the two were produced
independently on the same day and cover different builds and methods.
Nothing in the extension was changed as part of
this check. Numbers come from Node 22 on a 4-core VM running the pure functions
from `src/youtube.js` and the top-level helpers extracted from
`src/vendor/video-swap-new.user.js` against synthetic payloads sized like real
YouTube/Twitch responses. Browser-only parts (DOM observers, Worker lifecycle)
were assessed by reading the code.

Scope asked for: load times, drag on the system, memory leaks, hangs.

## Summary

| Area | Verdict |
| --- | --- |
| Script compile / injection cost | Negligible (all four scripts < 0.4 ms each). |
| YouTube page-load stall | Real. `stripValue` on `ytInitialData` blocks the main thread 50–130 ms for 1–3 MB payloads. |
| YouTube steady-state CPU | Every `JSON.parse` and every youtubei response is scanned; ~2× native parse cost when clean, ~11× when a marker is present. |
| Twitch player creation | Synchronous XHR in `getWasmWorkerJs` blocks the main thread (upstream, unmodified). |
| Memory leaks (pure paths) | None found. Caches are bounded or per-request. |
| Memory leaks (Twitch page) | `twitchWorkers` array never releases old Workers (upstream, unmodified). |
| Hangs | None. All hooks fail open; cyclic/deep/wide inputs stay bounded. |

## Load times

- Compile cost per page (`document_start`, main world): `debug.js` 7 KB / 0.06 ms,
  `youtube.js` 32 KB / 0.28 ms, `video-swap-new.user.js` 50 KB / 0.37 ms,
  `debug-bridge.js` 1 KB / 0.03 ms. The Twitch script is injected into every
  twitch.tv frame (`all_frames: true`); each copy starts its own 1 s timer.
- **YouTube Home load stall.** `hookInitial` intercepts the `ytInitialData`
  setter and runs `stripValue` synchronously. `stripValue` deep-clones via
  `JSON.stringify` + `JSON.parse`, then walks every node.

  | Payload | `stripValue` | native `JSON.parse` | ratio | transient heap |
  | --- | --- | --- | --- | --- |
  | 0.4 MB | 20 ms | 2.9 ms | 6.7× | ~16 MB |
  | 1.1 MB | 51 ms | 6.2 ms | 8.2× | ~30 MB |
  | 3.0 MB | 132 ms | 17.2 ms | 7.7× | ~78 MB |

  Real Home `ytInitialData` is typically 1–3 MB. The same cost applies to each
  infinite-scroll `browse` continuation that contains a Sponsored card.
- **Twitch player creation.** `getWasmWorkerJs` does
  `req.open('GET', twitchBlobUrl, false)` — a synchronous XHR on the main thread
  — every time a Worker is constructed (initial load, each ad swap in/out,
  quality change, raid). Upstream behaviour in pixeltris v1.55.

## Drag on the system

### YouTube (`src/youtube.js`)

- **Global `JSON.parse` hook.** `textLooksLikeAds` runs up to 20 `String.includes`
  scans over the full text before deciding anything. Clean 0.8 MB browse text:
  4.25 ms per call with no early exit. Hooked parse vs native: 8.4 ms vs 4.4 ms
  when clean (~2×); 46.6 ms vs 4.2 ms when a marker is present (~11×, because
  the clone + walk runs).
- **False-positive trigger.** Markers include plain `"isAd":true`,
  `"adSlots"`, etc. A 1.2 MB comments payload where a user typed `"isAd":true`
  in a comment triggered the full clone + walk (9 ms). Any marker string inside
  user content pays the full cost.
- **Double buffering.** The fetch hook calls `response.clone().text()` for
  every OK youtubei response, so each body exists twice in memory and YouTube
  cannot consume it until the whole body has arrived.
- **SABR/UMP stream.** Every googlevideo byte is copied once through the
  `TransformStream` (64 MB in 32 ms, roughly one memcpy — fine). The XHR
  `response` getter has no cache: each read re-parses and re-copies the whole
  ArrayBuffer (16 MB: 8.5 ms per read; 5 reads → 32 ms). Only matters if the
  player reads `response` more than once.
- **DOM observer.** A `MutationObserver` on the whole `documentElement` subtree
  runs `querySelectorAll` with 11 selectors on every animation frame in which a
  mutation occurred, on `/watch` and `/shorts`. YouTube mutates the DOM
  continuously during playback (progress bar, live chat, comments), so this
  fires several times per second. Not measured (no DOM in the harness);
  expected sub-millisecond per run but continuous.

### Twitch (`src/vendor/video-swap-new.user.js`)

- **1 s poll.** `monitorLiveStatus` reruns `getPlayerAndState` every second
  until a live player is found: two full React fiber walks, 0.34 ms on a
  10k-node tree, 0.95 ms on 40k nodes. On directory / following / offline
  channel tabs this runs for the life of the tab. CPU < 0.1%, but it keeps the
  tab's timer wheel active.
- **Network overhead during ad breaks (by design).** While on backup
  encodings, each media-playlist refresh (~every 2 s) also fetches the main
  playlist to detect the end of the break and fetches one ad `.ts` segment per
  playlist. Roughly +1 request and up to ~0.5 MB/s extra download for the
  duration of a break.
- m3u8 processing itself is cheap: `stripAdSegments` 0.09 ms per 63-segment
  playlist, `setStreamInfoUrls` 0.02 ms, `getStreamUrlForResolution` 0.01 ms.

## Memory leaks

- **Pure paths: none.** 2000 simulated youtubei responses through
  `stripResponseText` plus 2000 UMP parser instances retained 0.05 MB after GC.
  `AdSegmentCache` is swept on every call and stays bounded by its 2-minute TTL
  (checked with 7200 unique ad URLs). `retryTimers` / `hideTimer` are cleared;
  per-XHR caches die with the XHR; the debug ring buffer is capped at 80.
- **`twitchWorkers` (page scope, upstream).** `twitchWorkers.push(this)` on
  every Worker construction, with no splice/remove anywhere. Every player
  reload creates a new Worker and the old one, plus its two message-listener
  closures, stays referenced until the tab closes. `postTwitchWorkerMessage`
  also posts to all of them. Slow but unbounded growth.
- **`StreamInfos` / `StreamInfosByUrl` (worker scope).** Per-channel entries
  are never evicted (300 channels → 300 entries with cached playlists). They
  live inside the worker and are reclaimed when it terminates; a long-lived
  worker across many SPA channel navigations accumulates them. Minor.

## Hangs

- No unbounded loops or waits. `stripValue` uses a `WeakSet` seen-set; a cyclic
  object fails open in 0.06 ms; 5000-deep nesting completes in 5.9 ms. The UMP
  parser bounds its buffering (type-35 parts ≤ 64 KB, otherwise skip-through)
  and flips to passthrough on an invalid header; a pathological 3-byte-chunk
  stream (2.8 M pushes for 8 MB) took 335 ms but stayed bounded.
- The two genuine main-thread blockers are the ones above: the synchronous
  worker-blob XHR on Twitch and the 50–130 ms `stripValue` stall on large
  YouTube payloads. A 200k-element array walk took 192 ms, so unusually large
  YouTube continuations can produce a visible frame hitch.
- All hook paths are wrapped in try/catch and fail open, so an exception
  degrades to "ads show" rather than a frozen player.

## Priority list (not implemented)

1. `youtube.js` `stripValue`: avoid the stringify/parse deep clone (strip in
   place along the matched path, or clone only subtrees that actually contain
   ad nodes). Largest CPU and GC cost; source of the Home-page load stall.
2. `youtube.js` `JSON.parse` hook: collapse `textLooksLikeAds` into a single
   regex pass and/or restrict markers to the current `kind`; avoid rescanning
   text the fetch/XHR hooks already stripped.
3. `youtube.js` SABR XHR getter: cache the patched buffer per `xhr.__ytGen`.
4. `video-swap-new.user.js`: `twitchWorkers` retention and the synchronous XHR
   are upstream (pixeltris v1.55). The README commits to shipping the vendor
   file unmodified, so these are upstream reports rather than local patches.

## Method

- Payloads: synthetic YouTube `browse` responses of 500–4000 rich-grid cards
  with ~1% `adSlotRenderer` cards; synthetic `player` response with 24 adaptive
  formats and 3 `adPlacements`; a 64 MB synthetic UMP stream with 1 MB media
  parts; Twitch playlists from `test/fixtures/` plus a generated 63-segment
  live playlist with 3 stitched-ad segments.
- Each figure is the mean over 5–200k iterations after a forced GC, with heap
  delta read from `process.memoryUsage().heapUsed`.
- The harness was throwaway and is not in the repo; the figures above are the
  record.
