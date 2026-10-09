// Playlist helpers for live Twitch HLS. Loaded as a classic script before page.js.
function installTwitchAdblockPlaylist(target) {
  function linesOf(text) {
    return String(text || "").replaceAll("\r", "").split("\n");
  }

  function parseAttributes(header) {
    const body = String(header || "");
    const attrs = {};
    const pattern = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match = pattern.exec(body);
    while (match) {
      let value = match[2];
      if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
      attrs[match[1]] = value;
      match = pattern.exec(body);
    }
    return attrs;
  }

  function hasStitchedAd(text) {
    const source = String(text || "");
    return source.includes("stitched-ad")
      || source.includes("twitch-stitched")
      || source.includes("twitch-maf-ad")
      || source.includes('CLASS="twitch-trigger"')
      || source.includes("#EXT-X-CUE-OUT");
  }

  // A live maf cue is one DATERANGE. Segments stay live, so this is not an ad
  // break and must not start a backup swap or a reload. The page skips the
  // client-side player separately. VODs never reach that skip.
  function isClientAdCue(text) {
    return String(text || "").includes('CLASS="twitch-maf-ad"');
  }

  function removeMafAds(text) {
    const source = String(text || "");
    if (!source.includes("twitch-maf-ad")) return { text: source, removed: 0 };
    let removed = 0;
    const kept = source.split("\n").filter((line) => {
      if (!line.startsWith("#EXT-X-DATERANGE:") || !line.includes('CLASS="twitch-maf-ad"')) return true;
      removed += 1;
      return false;
    });
    return { text: kept.join("\n"), removed };
  }

  function isMidroll(text) {
    return /"midroll"/i.test(String(text || ""));
  }

  function isMasterPlaylist(text) {
    return String(text || "").includes("#EXT-X-STREAM-INF");
  }

  function isLivePlaylistUrl(url) {
    const value = String(url || "");
    if (value.includes("/vod/")) return false;
    let parsed;
    try {
      parsed = new URL(value, "https://usher.ttvnw.net");
    } catch {
      return false;
    }
    const host = parsed.hostname;
    if (host !== "usher.ttvnw.net" && !host.endsWith(".ttvnw.net")) return false;
    const path = parsed.pathname;
    return path.includes("/channel/hls/") || path.includes("/playlist/") || path.endsWith(".m3u8");
  }

  function channelFromPlaylistUrl(url) {
    try {
      const path = new URL(url, "https://usher.ttvnw.net").pathname;
      const match = path.match(/\/channel\/hls\/([^/]+)\.m3u8$/i);
      return match ? decodeURIComponent(match[1]) : null;
    } catch {
      return null;
    }
  }

  function readServerTime(text) {
    const source = String(text || "");
    const session = source.match(/#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE="([^"]+)"/);
    if (session) return session[1];
    const legacy = source.match(/SERVER-TIME="([0-9.]+)"/);
    return legacy ? legacy[1] : null;
  }

  function writeServerTime(text, time) {
    const source = String(text || "");
    if (!time) return source;
    if (source.includes('DATA-ID="SERVER-TIME"')) {
      return source.replace(/(#EXT-X-SESSION-DATA:DATA-ID="SERVER-TIME",VALUE=")[^"]+(")/, `$1${time}$2`);
    }
    return source.replace(/(SERVER-TIME=")[0-9.]+(")/, `$1${time}$2`);
  }

  function listVariants(text) {
    const lines = linesOf(text);
    const variants = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const url = lines[i + 1].trim();
      if (!url || url.startsWith("#")) continue;
      const attrs = parseAttributes(lines[i]);
      variants.push({
        resolution: attrs.RESOLUTION || "",
        frameRate: attrs["FRAME-RATE"] || "",
        codecs: attrs.CODECS || "",
        video: attrs.VIDEO || "",
        url,
      });
    }
    return variants;
  }

  function partsOf(resolution) {
    const parts = String(resolution).split("x").map(Number);
    if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return [0, 0];
    return parts;
  }

  function area(resolution) {
    const [width, heightValue] = partsOf(resolution);
    return width * heightValue;
  }

  function height(resolution) {
    return partsOf(resolution)[1];
  }

  function pickVariant(text, wanted) {
    const variants = listVariants(text);
    if (!variants.length) return null;
    if (!wanted) return variants[0].url;
    if (!wanted.resolution) {
      if (wanted.video) {
        const named = variants.find((variant) => variant.video === wanted.video);
        if (named) return named.url;
      }
      const unresolved = variants.find((variant) => !variant.resolution);
      return unresolved ? unresolved.url : null;
    }
    let exact = null;
    let exactRate = false;
    let closest = variants[0];
    let closestHeight = Infinity;
    const wantedHeight = height(wanted.resolution);
    for (const variant of variants) {
      if (variant.resolution === wanted.resolution) {
        const rateMatches = Boolean(wanted.frameRate) && variant.frameRate === String(wanted.frameRate);
        if (!exact || (rateMatches && !exactRate)) {
          exact = variant;
          exactRate = rateMatches;
        }
      }
      const heightGap = Math.abs(height(variant.resolution) - wantedHeight);
      if (heightGap < closestHeight || (heightGap === closestHeight && area(variant.resolution) > area(closest.resolution))) {
        closest = variant;
        closestHeight = heightGap;
      }
    }
    return (exact || closest).url;
  }

  function mapVariantsToBackup(mainText, backupText, backupBase) {
    const lines = linesOf(mainText);
    const backupVariants = listVariants(backupText);
    if (!backupVariants.length) return String(mainText || "");
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
      const current = lines[i + 1].trim();
      if (!current || current.startsWith("#")) continue;
      const attrs = parseAttributes(lines[i]);
      const backupUrl = pickVariant(backupText, {
        resolution: attrs.RESOLUTION,
        frameRate: attrs["FRAME-RATE"],
        video: attrs.VIDEO,
      });
      if (!backupUrl) continue;
      const backupVariant = backupVariants.find((item) => item.url === backupUrl);
      if (backupVariant && attrs.CODECS && backupVariant.codecs && attrs.CODECS.slice(0, 3) !== backupVariant.codecs.slice(0, 3)) {
        lines[i] = lines[i].replace(/CODECS="[^"]+"/, `CODECS="${backupVariant.codecs}"`);
      }
      let resolved = backupUrl;
      if (backupBase) {
        try {
          resolved = new URL(backupUrl, backupBase).href;
        } catch {
          resolved = backupUrl;
        }
      }
      lines[i + 1] = `${resolved}#tab${i + 1}`;
    }
    return lines.join("\n");
  }

  function isAdInf(line) {
    return line.startsWith("#EXTINF") && (!line.includes(",live") || line.includes("Amazon"));
  }

  function isAdSegmentUrl(url) {
    return url.includes("/adsquared/") || url.includes("/_404/") || url.includes("/processing/");
  }

  function adWindows(lines) {
    const windows = [];
    for (const line of lines) {
      if (!line.startsWith("#EXT-X-DATERANGE:") || !hasStitchedAd(line)) continue;
      const attrs = parseAttributes(line);
      const start = Date.parse(attrs["START-DATE"] || "");
      if (!Number.isFinite(start)) continue;
      let end = Date.parse(attrs["END-DATE"] || "");
      if (!Number.isFinite(end)) {
        // PLANNED-DURATION is the live maf cue. It is not a stitched-segment
        // window: treating it as DURATION would start a backup swap.
        const duration = Number(attrs.DURATION);
        if (Number.isFinite(duration) && duration > 0) end = start + Math.round(duration * 1000);
      }
      if (!Number.isFinite(end) || end <= start) continue;
      windows.push([start, end]);
    }
    return windows;
  }

  function segmentTimes(lines) {
    const times = new Map();
    let cursor = NaN;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
        const parsed = Date.parse(line.slice("#EXT-X-PROGRAM-DATE-TIME:".length).trim());
        if (Number.isFinite(parsed)) cursor = parsed;
        continue;
      }
      if (!line.startsWith("#EXTINF")) continue;
      const next = (lines[i + 1] || "").trim();
      if (!next || next.startsWith("#")) continue;
      if (Number.isFinite(cursor)) times.set(i, cursor);
      const duration = Number(line.slice("#EXTINF:".length).split(",")[0]);
      if (Number.isFinite(cursor) && Number.isFinite(duration)) cursor += Math.round(duration * 1000);
    }
    return times;
  }

  function inAdWindow(time, windows) {
    return windows.some(([start, end]) => time >= start && time < end);
  }

  // A stitched range that starts after the newest listed segment is a break that
  // has only reached the prefetch lines. video-swap-new reacts to the ad tag itself.
  const upcomingHorizonMs = 10000;
  function hasUpcomingAd(windows, times) {
    let newest = NaN;
    for (const time of times.values()) {
      if (!Number.isFinite(newest) || time > newest) newest = time;
    }
    if (!Number.isFinite(newest)) return false;
    return windows.some(([start]) => start > newest && start - newest <= upcomingHorizonMs);
  }

  function isAdSegmentLine(lines, index, windows, times) {
    const line = lines[index];
    if (!line || !line.startsWith("#EXTINF")) return false;
    const next = (lines[index + 1] || "").trim();
    if (!next || next.startsWith("#")) return false;
    if (isAdInf(line) || isAdSegmentUrl(next)) return true;
    const time = times.get(index);
    return Number.isFinite(time) && inAdWindow(time, windows);
  }

  function hasAdBreak(text) {
    const lines = linesOf(text);
    const windows = adWindows(lines);
    const times = segmentTimes(lines);
    for (let i = 0; i < lines.length - 1; i++) {
      if (isAdSegmentLine(lines, i, windows, times)) return true;
    }
    return hasUpcomingAd(windows, times);
  }

  // Why a playlist counts as an ad break, for the debug log only.
  function adReason(text) {
    const lines = linesOf(text);
    const windows = adWindows(lines);
    const times = segmentTimes(lines);
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXTINF")) continue;
      const next = (lines[i + 1] || "").trim();
      if (!next || next.startsWith("#")) continue;
      if (isAdInf(line)) return "inf";
      if (isAdSegmentUrl(next)) return "url";
      const time = times.get(i);
      if (Number.isFinite(time) && inAdWindow(time, windows)) return "range";
    }
    return hasUpcomingAd(windows, times) ? "upcoming" : "none";
  }

  function mediaSequence(lines) {
    const line = lines.find((item) => item.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
    if (!line) return 0;
    const value = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length).trim());
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
  }

  function createStripLedger() {
    return { dropped: new Set(), base: 0, first: NaN, passing: false };
  }

  function droppedBelow(book, sequence) {
    let count = book.base;
    for (const value of book.dropped) {
      if (value < sequence) count += 1;
    }
    return count;
  }

  // A window this many segments behind the newest one (a stale edge, another
  // rendition) is read through the ledger; a bigger jump back is a new stream.
  const staleWindow = 15;

  // Drop ad slots that live video follows, and renumber through a ledger kept
  // across refreshes so no live segment is listed twice or replayed. A break at the
  // live edge passes through unmodified until it ends: dropping it starves the player.
  // readOnly applies earlier drops and numbering without dropping anything new.
  function stripAds(text, ledger, readOnly) {
    const lines = linesOf(text);
    const unchanged = lines.join("\n");
    const numbered = lines.some((line) => line.startsWith("#EXT-X-MEDIA-SEQUENCE:"));
    const book = numbered && ledger && ledger.dropped instanceof Set ? ledger : createStripLedger();
    const windows = adWindows(lines);
    const times = segmentTimes(lines);
    const firstSequence = mediaSequence(lines);
    let frozen = readOnly === true;
    if (Number.isFinite(book.first) && firstSequence < book.first) {
      if (book.first - firstSequence > staleWindow) {
        if (frozen) return { text: unchanged, adUrls: [], stripped: false, passed: false };
        book.dropped.clear();
        book.base = 0;
        book.passing = false;
        book.first = NaN;
      } else {
        frozen = true;
      }
    }
    if (!frozen) {
      book.first = firstSequence;
      for (const value of [...book.dropped]) {
        if (value >= firstSequence - staleWindow) continue;
        book.dropped.delete(value);
        book.base += 1;
      }
    }

    const segments = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith("#EXTINF")) continue;
      const next = lines[i + 1].trim();
      if (!next || next.startsWith("#")) continue;
      const sequence = firstSequence + segments.length;
      segments.push({ index: i, sequence, ad: book.dropped.has(sequence) || isAdSegmentLine(lines, i, windows, times) });
    }
    const upcoming = hasUpcomingAd(windows, times);
    const anyAd = upcoming || segments.some((segment) => segment.ad);
    if (!anyAd && !frozen) book.passing = false;
    const lastLive = segments.reduce((last, segment) => (segment.ad ? last : segment.index), -1);
    const fresh = segments.filter((segment) => segment.ad && !book.dropped.has(segment.sequence));
    const dropNow = frozen || book.passing || upcoming ? [] : fresh.filter((segment) => segment.index < lastLive);
    for (const segment of dropNow) book.dropped.add(segment.sequence);
    const passedAds = fresh.filter((segment) => !book.dropped.has(segment.sequence));
    if ((passedAds.length || upcoming) && !frozen) book.passing = true;

    const dropped = new Set(segments.filter((segment) => book.dropped.has(segment.sequence)).map((segment) => segment.index));
    const firstKept = segments.find((segment) => !dropped.has(segment.index));
    const outSequence = firstKept ? firstKept.sequence - droppedBelow(book, firstKept.sequence) : firstSequence - book.base;
    // Ad markers stay while any ad still plays so Twitch's ad UI can finish cleanly.
    const cleanMarkers = dropped.size > 0 && !passedAds.length && !upcoming;
    const passed = anyAd && (book.passing || passedAds.length > 0 || upcoming);
    if (!dropped.size && !cleanMarkers && outSequence === firstSequence) {
      return { text: unchanged, adUrls: [], stripped: false, passed };
    }

    const kept = [];
    let held = [];
    let carryBreak = false;
    let wroteSequence = false;
    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        kept.push(`#EXT-X-MEDIA-SEQUENCE:${outSequence}`);
        wroteSequence = true;
        continue;
      }
      if (cleanMarkers) {
        if (line.startsWith("#EXT-X-TWITCH-PREFETCH:")) continue;
        if (line.startsWith("#") && hasStitchedAd(line)) continue;
        line = line
          .replaceAll(/(X-TV-TWITCH-AD-URL=")[^"]*(")/g, "$1https://twitch.tv$2")
          .replaceAll(/(X-TV-TWITCH-AD-CLICK-TRACKING-URL=")[^"]*(")/g, "$1https://twitch.tv$2");
      }
      if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:") || line.trim() === "#EXT-X-DISCONTINUITY") {
        held.push(line);
        continue;
      }
      if (dropped.has(i)) {
        // The live video after a dropped slot still starts a new timeline.
        if (held.some((tag) => tag.trim() === "#EXT-X-DISCONTINUITY")) carryBreak = true;
        held = [];
        i += 1;
        continue;
      }
      if (line.startsWith("#EXTINF")) {
        if (carryBreak && !held.some((tag) => tag.trim() === "#EXT-X-DISCONTINUITY")) kept.push("#EXT-X-DISCONTINUITY");
        carryBreak = false;
      }
      kept.push(...held, line);
      held = [];
    }
    kept.push(...held);
    if (!wroteSequence && outSequence !== firstSequence) kept.splice(1, 0, `#EXT-X-MEDIA-SEQUENCE:${outSequence}`);
    return { text: kept.join("\n"), adUrls: [], stripped: dropped.size > 0 || cleanMarkers, passed };
  }

  // Live segments of a clean playlist keyed by wall clock (PROGRAM-DATE-TIME).
  function liveSegmentsByTime(text, base) {
    const lines = linesOf(text);
    const windows = adWindows(lines);
    const times = segmentTimes(lines);
    const found = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith("#EXTINF")) continue;
      const next = lines[i + 1].trim();
      if (!next || next.startsWith("#")) continue;
      if (isAdSegmentLine(lines, i, windows, times)) continue;
      const time = times.get(i);
      if (!Number.isFinite(time)) continue;
      let url = next;
      if (base) {
        try {
          url = new URL(next, base).href;
        } catch {
          url = next;
        }
      }
      found.push({ time, inf: lines[i], url });
    }
    return found;
  }

  // Fill each stitched ad slot of a main media playlist with the clean segment that
  // covers the same wall-clock time on another player type. Same encoder, same
  // timeline: the player keeps its buffer and never needs setSrc. One slot, one
  // segment, so segment numbering never moves. Slots at the live edge that the clean
  // playlist has not reached yet are left out for this refresh (at most maxTrim);
  // any other slot without an exact partner refuses the whole splice.
  function spliceAligned(mainText, cleanText, cleanBase, options) {
    const opts = options || {};
    const toleranceMs = opts.toleranceMs == null ? 500 : Number(opts.toleranceMs);
    const maxTrim = opts.maxTrim == null ? 3 : Number(opts.maxTrim);
    const lines = linesOf(mainText);
    const unchanged = lines.join("\n");
    const refuse = (why) => ({ ok: false, text: unchanged, replaced: 0, trimmed: 0, need: 0, why });
    const windows = adWindows(lines);
    const times = segmentTimes(lines);
    const clean = liveSegmentsByTime(cleanText, cleanBase);
    if (!clean.length) return refuse("no-clean");
    const newestClean = clean[clean.length - 1].time;

    const slots = [];
    for (let i = 0; i < lines.length - 1; i++) {
      if (!lines[i].startsWith("#EXTINF")) continue;
      const next = lines[i + 1].trim();
      if (!next || next.startsWith("#")) continue;
      slots.push({ index: i, ad: isAdSegmentLine(lines, i, windows, times), time: times.get(i) });
    }
    // memory: wall clock -> fill from earlier refreshes. A slot keeps its partner
    // after the clean playlist has scrolled past it, so the head never goes stale.
    const memory = opts.memory instanceof Map ? opts.memory : null;
    const used = new Set();
    let need = 0;
    for (const slot of slots) {
      if (!slot.ad) continue;
      need += 1;
      if (!Number.isFinite(slot.time)) return refuse("no-time");
      const kept = memory ? memory.get(slot.time) : null;
      if (kept && !used.has(kept.url)) {
        used.add(kept.url);
        slot.fill = kept;
        continue;
      }
      let best = null;
      for (const item of clean) {
        if (used.has(item.url)) continue;
        const gap = Math.abs(item.time - slot.time);
        if (gap <= toleranceMs && (!best || gap < Math.abs(best.time - slot.time))) best = item;
      }
      if (best) {
        used.add(best.url);
        slot.fill = best;
      } else if (slot.time > newestClean) {
        slot.trim = true;
      } else {
        return refuse("gap");
      }
    }
    // Only a tail of unfilled slots may wait for the next refresh.
    let tail = slots.length;
    while (tail > 0 && slots[tail - 1].trim) tail -= 1;
    const trimmed = slots.length - tail;
    if (slots.slice(0, tail).some((slot) => slot.trim)) return refuse("gap");
    if (trimmed > maxTrim) return refuse("behind");
    if (tail === 0) return refuse("empty");

    if (memory) {
      for (const slot of slots) if (slot.fill) memory.set(slot.time, slot.fill);
      const oldest = slots.length && Number.isFinite(slots[0].time) ? slots[0].time : NaN;
      for (const time of [...memory.keys()]) if (Number.isFinite(oldest) && time < oldest - 60000) memory.delete(time);
    }
    const bySlot = new Map(slots.map((slot) => [slot.index, slot]));
    const cutAt = tail < slots.length ? slots[tail].index : lines.length;
    const out = [];
    let held = [];
    let lastWasFill = null;
    let prevEnd = NaN;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-TWITCH-PREFETCH:")) continue;
      if (line.startsWith("#EXT-X-CUE-OUT") || line.startsWith("#EXT-X-CUE-IN")) continue;
      if (line.startsWith("#EXT-X-DATERANGE:") && hasStitchedAd(line) && !line.includes('CLASS="twitch-trigger"')) continue;
      // Per-ad tracking ranges (quartiles, the creative as stream source) go with it.
      if (line.startsWith("#EXT-X-DATERANGE:") && (line.includes('CLASS="twitch-ad-quartile"')
        || (line.includes('CLASS="twitch-stream-source"') && !line.includes('X-TV-TWITCH-STREAM-SOURCE="live"')))) continue;
      if (i >= cutAt) {
        // Header-free tail: keep only end-of-list tags.
        if (line.startsWith("#EXT-X-ENDLIST")) out.push(line);
        continue;
      }
      // Every tag between two segments belongs to the next one.
      if (line.startsWith("#") && !line.startsWith("#EXTINF")) {
        held.push(line);
        continue;
      }
      const slot = bySlot.get(i);
      if (slot) {
        const isFill = Boolean(slot.fill);
        const start = isFill ? slot.fill.time : slot.time;
        // seamless: the clean rung is the same rendition (Twitch serves the very same
        // segment bytes to every player type), so where main and clean meet end to
        // end it is one timeline and a discontinuity would only make the player flush
        // and pause. Where they do not meet (the live cut after a break moves by the
        // ad's odd tail), main's own discontinuity stays.
        // The head slot's predecessor has scrolled out; a fill there met it on the
        // 2 s grid when it was still listed, so it keeps the same answer as before.
        const meets = lastWasFill === null
          ? isFill
          : Number.isFinite(prevEnd) && Number.isFinite(start) && Math.abs(start - prevEnd) <= 50;
        if (opts.seamless && meets && (isFill || lastWasFill === true)) held = held.filter((tag) => tag.trim() !== "#EXT-X-DISCONTINUITY");
        const hasBreak = held.some((tag) => tag.trim() === "#EXT-X-DISCONTINUITY");
        // A new timeline starts wherever the source switches between main and clean.
        if ((!opts.seamless || !meets) && lastWasFill !== null && lastWasFill !== isFill && !hasBreak) held.unshift("#EXT-X-DISCONTINUITY");
        lastWasFill = isFill;
        const inf = isFill ? slot.fill.inf : line;
        const seconds = Number(inf.slice("#EXTINF:".length).split(",")[0]);
        prevEnd = Number.isFinite(start) && Number.isFinite(seconds) ? start + Math.round(seconds * 1000) : NaN;
        if (isFill) {
          const isBreak = (tag) => tag.trim() === "#EXT-X-DISCONTINUITY";
          const isTime = (tag) => tag.startsWith("#EXT-X-PROGRAM-DATE-TIME:");
          out.push(...held.filter((tag) => !isBreak(tag) && !isTime(tag)));
          out.push(...held.filter(isBreak).slice(0, 1));
          out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(slot.fill.time).toISOString()}`);
          out.push(slot.fill.inf.includes(",live") ? slot.fill.inf : slot.fill.inf.replace(/,.*$/, ",live"));
          out.push(slot.fill.url);
          held = [];
          i += 1;
          continue;
        }
      }
      out.push(...held, line);
      held = [];
    }
    if (cutAt === lines.length) out.push(...held);
    // Low-latency prefetch lines are the player's lead over the live edge; dropping
    // them all drains its buffer. Keep main's own when its edge is live, else take
    // the clean edge's when it is the same rendition at the same wall clock.
    const lastKept = slots[tail - 1];
    const mainPrefetch = lines.filter((line) => line.startsWith("#EXT-X-TWITCH-PREFETCH:"));
    if (trimmed === 0 && !lastKept.ad && !hasUpcomingAd(windows, times)) {
      out.push(...mainPrefetch);
    } else if (opts.seamless && Number.isFinite(lastKept.time) && Math.abs(lastKept.time - newestClean) <= toleranceMs) {
      for (const line of linesOf(cleanText)) {
        if (!line.startsWith("#EXT-X-TWITCH-PREFETCH:")) continue;
        let target = line.slice("#EXT-X-TWITCH-PREFETCH:".length).trim();
        try {
          target = new URL(target, cleanBase || undefined).href;
        } catch {
          // keep as listed
        }
        out.push("#EXT-X-TWITCH-PREFETCH:" + target);
      }
    }
    const replaced = slots.filter((slot) => slot.fill).length;
    return { ok: true, text: out.join("\n"), replaced, trimmed, need, why: "" };
  }

  function mpegCrc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i] << 24;
      for (let bit = 0; bit < 8; bit++) {
        if (crc & 0x80000000) crc = ((crc << 1) ^ 0x04c11db7) >>> 0;
        else crc = (crc << 1) >>> 0;
      }
    }
    return crc >>> 0;
  }

  function withCrc(section) {
    const crc = mpegCrc32(section);
    const full = new Uint8Array(section.length + 4);
    full.set(section);
    full[section.length] = (crc >>> 24) & 0xff;
    full[section.length + 1] = (crc >>> 16) & 0xff;
    full[section.length + 2] = (crc >>> 8) & 0xff;
    full[section.length + 3] = crc & 0xff;
    return full;
  }

  function sectionPacket(pid, section) {
    const packet = new Uint8Array(188);
    packet[0] = 0x47;
    packet[1] = 0x40 | ((pid >> 8) & 0x1f);
    packet[2] = pid & 0xff;
    packet[3] = 0x10;
    packet[4] = 0x00;
    packet.set(section, 5);
    packet.fill(0xff, 5 + section.length);
    return packet;
  }

  function firstAdSegmentUrl(text) {
    const lines = linesOf(text);
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i];
      if (!line.startsWith("#EXTINF") || line.includes(",live")) continue;
      const next = lines[i + 1].trim();
      if (!next || next.startsWith("#")) continue;
      return next;
    }
    return "";
  }

  function blankSegmentBytes() {
    const pat = withCrc(Uint8Array.from([
      0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe1, 0x00,
    ]));
    const pmt = withCrc(Uint8Array.from([
      0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe1, 0x01, 0xf0, 0x00, 0x1b, 0xe1, 0x01, 0xf0, 0x00,
    ]));
    const pes = Uint8Array.from([
      0x00, 0x00, 0x01, 0xe0, 0x00, 0x09, 0x80, 0x80, 0x05, 0x21, 0x00, 0x01, 0x00, 0x01, 0x00,
    ]);
    const video = new Uint8Array(188);
    video[0] = 0x47;
    video[1] = 0x41;
    video[2] = 0x01;
    video[3] = 0x30;
    const adaptationLength = 188 - 5 - pes.length;
    video[4] = adaptationLength;
    video[5] = 0x00;
    video.fill(0xff, 6, 5 + adaptationLength);
    video.set(pes, 5 + adaptationLength);
    const packets = new Uint8Array(188 * 3);
    packets.set(sectionPacket(0x0000, pat), 0);
    packets.set(sectionPacket(0x0100, pmt), 188);
    packets.set(video, 376);
    return packets;
  }

  Object.assign(target, {
    parseAttributes,
    hasStitchedAd,
    isClientAdCue,
    removeMafAds,
    hasAdBreak,
    adReason,
    isMidroll,
    isMasterPlaylist,
    isLivePlaylistUrl,
    channelFromPlaylistUrl,
    readServerTime,
    writeServerTime,
    listVariants,
    pickVariant,
    mapVariantsToBackup,
    createStripLedger,
    stripAds,
    liveSegmentsByTime,
    spliceAligned,
    firstAdSegmentUrl,
    blankSegmentBytes,
  });
}

installTwitchAdblockPlaylist(globalThis.TwitchAdblockPlaylist = globalThis.TwitchAdblockPlaylist || {});
