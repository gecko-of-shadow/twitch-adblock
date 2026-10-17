#!/usr/bin/env python3
"""EXPERIMENT: pack Bran's Firefox uBO list set into general-network.json.

Reuses pack-filter-lists.py parsing + never-block guard. Reads local copies
from a directory (default /workspace/biglists/<name>.txt). Keeps main's
non-list rules (stream exclusions, YT doubleclick rule, extra tracker rule).
Usage: python3 scripts/exp-pack-big-lists.py [list_dir]
"""
import importlib.util, json, sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("pfl", ROOT / "scripts" / "pack-filter-lists.py")
pfl = importlib.util.module_from_spec(spec); spec.loader.exec_module(pfl)
LIST_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/workspace/biglists")
# priority order: existing four first, then Bran's uBO set
NAMES = ["peter_lowe", "urlhaus_hosts", "easylist", "easyprivacy",
  "ublock-filters", "ublock-badware", "ublock-privacy", "ublock-quick-fixes",
  "adguard-generic", "adguard-mobile", "adguard-spyware-url", "curben-phishing",
  "dpollock-0", "ds-antimalware", "iam-antimalware", "hagezi-pro-mini",
  "yok-privacy-essentials", "ds-urlshortener", "antipaywall",
  "adguard-social", "fanboy-social", "easylist-annoyances", "ublock-annoyances",
  "adguard-other-annoyances", "adguard-popup-overlays", "adguard-mobile-app-banners",
  "adguard-widgets", "adguard-cookies", "ublock-cookies-easylist", "fanboy-cookiemonster",
  "fanboy-ai-suggestions", "yok-annoyance", "yok-adult-annoyance"]
pfl.SOURCES = {n: {"priority": 0} for n in NAMES}
# Also protect every host the merge script / exclusions protect.
pfl.NEVER_BLOCK_SUFFIXES = tuple(pfl.NEVER_BLOCK_SUFFIXES) + ("live-video.net",
  "youtube-nocookie.com", "youtubekids.com", "twitchsvc.net", "twitchcdn-shadow.net")
# Stricter than main's packer: only whole-domain blocks. Drop modifier-only
# rules (removeparam, popup, redirect, csp, badfilter, cookie edits, ...).
BAD_OPTS = ("removeparam", "queryprune", "popup", "redirect", "badfilter", "csp",
  "permissions", "replace", "urltransform", "uritransform", "cookie", "header",
  "1p", "first-party", "~third-party", "~3p", "domain=", "from=", "denyallow",
  "method=", "to=", "match-case", "ping", "websocket", "font", "media", "other",
  "inline-", "generichide", "elemhide", "specifichide", "ehide", "shide", "ghide")
def _filtered(text):
    keep = []
    for line in text.splitlines():
        if "$" in line and line.startswith("||"):
            opts = line.split("$", 1)[1].lower()
            if any(b in opts for b in BAD_OPTS):
                continue
        keep.append(line)
    return "\n".join(keep)
buckets = {n: pfl.extract_domains(_filtered((LIST_DIR / f"{n}.txt").read_text(errors="replace"))) for n in NAMES}
domains, stats = pfl.merge_domains(buckets)
assert not any(pfl.is_never_block(d) for d in domains)
blocks = pfl.domains_to_dnr_rules(domains)
cur = json.loads((ROOT / "src/rules/general-network.json").read_text())
keep_low = [r for r in cur if r["id"] < 100]
extra = [r for r in cur if r["id"] >= 100 and r["action"]["type"] == "block"
         and not any(x in r["condition"].get("requestDomains", []) for x in ["0"])][-1:]
out = list(keep_low); rid = 100
for b in blocks:
    out.append({"id": rid, "priority": 1, "action": {"type": "block"}, "condition": b["condition"]}); rid += 1
for e in extra:
    e = dict(e); e["id"] = rid; out.append(e); rid += 1
assert len(out) <= 30000
(ROOT / "src/rules/general-network.json").write_text(json.dumps(out, separators=(",", ":")))
mm = json.loads((ROOT / "src/rules/dnr-merge-meta.json").read_text())
mm.update(block_rules=len(out) - len(keep_low), rule_count=len(out), extra_tracker_rule_id=rid - 1,
          source_blocks="scripts/exp-pack-big-lists.py")
mm["allow_rules"] = sum(1 for r in out if r["action"]["type"] != "block")
(ROOT / "src/rules/dnr-merge-meta.json").write_text(json.dumps(mm, indent=2) + "\n")
json.dump({"domains_total": len(domains), "dnr_rules_total": len(out), "stats": stats},
          open(ROOT / "src/rules/exp-big-lists-meta.json", "w"), indent=1)
print(len(domains), len(out))
for n in NAMES: print(f"{n:28s} raw={stats[n]['raw']:7d} new={stats[n]['kept']:7d}")
