// YouTube Playlist Progress
//
// Tracks, per playlist, how far into each video you've actually watched
// (furthest playback position reached), stored in chrome.storage.local
// keyed by playlist ID. Renders a live progress bar:
//   - on the playlist listing page (youtube.com/playlist?list=...)
//   - at the top of the playlist sidebar panel while watching a video
//     that belongs to a playlist (youtube.com/watch?v=...&list=...)
//
// YouTube's DOM/class names change over time; duration-text lookup uses a
// list of fallback selectors (SELECTORS.durationCandidates) so it's a single
// place to patch if YouTube ships a redesign.

(function () {
  "use strict";

  const SELECTORS = {
    // YouTube renders playlist rows with different components depending on
    // rollout/A-B bucket — even the same account can see the legacy
    // renderer on one playlist and the newer "lockup" view-model on
    // another. Each is tried in turn; the first that yields any matches
    // wins (see scanItems).
    playlistPageItemCandidates: ["ytd-playlist-video-renderer", "yt-lockup-view-model"],
    panelItemCandidates: ["ytd-playlist-panel-video-renderer", "yt-lockup-view-model"],
    durationCandidates: [
      "ytd-thumbnail-overlay-time-status-renderer .ytBadgeShapeText",
      "ytd-thumbnail-overlay-time-status-renderer #text",
      "ytd-thumbnail-overlay-time-status-renderer span",
      ".badge-shape-wiz__text",
      "[class*='time-status'] span",
    ],
  };

  const state = {
    playlistId: null,
    pageType: null, // 'playlist' | 'watch'
    items: new Map(), // videoId -> { durationSec, index }
    watched: {}, // videoId -> furthest seconds reached
    currentVideoId: null,
    videoEl: null,
  };

  let playlistObserver = null;
  let watchObserver = null;
  let saveInterval = null;
  let timeUpdateHandler = null;
  let attachRetryTimer = null;

  // ---------- utils ----------

  function debounce(fn, wait) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  function parseDurationText(text) {
    if (!text) return 0;
    const cleaned = text.trim().replace(/[^\d:]/g, "");
    if (!cleaned.includes(":")) return 0;
    const parts = cleaned.split(":").filter((p) => p !== "").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return 0;
    let secs = 0;
    for (const p of parts) secs = secs * 60 + p;
    return secs;
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    }
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function getPlaylistIdFromUrl() {
    return new URL(location.href).searchParams.get("list");
  }

  function getVideoIdFromUrl() {
    return new URL(location.href).searchParams.get("v");
  }

  function getPageType() {
    if (location.pathname === "/playlist" && getPlaylistIdFromUrl()) return "playlist";
    if (location.pathname === "/watch" && getPlaylistIdFromUrl()) return "watch";
    return null;
  }

  // ---------- storage ----------

  function storageKey(playlistId) {
    return "ytpp_" + playlistId;
  }

  function loadWatched(playlistId) {
    return new Promise((resolve) => {
      chrome.storage.local.get([storageKey(playlistId)], (res) => {
        resolve(res[storageKey(playlistId)] || {});
      });
    });
  }

  function saveWatched(playlistId, watchedObj) {
    if (!playlistId) return;
    chrome.storage.local.set({ [storageKey(playlistId)]: watchedObj });
  }

  // ---------- scraping ----------

  // Generic rather than tied to a specific component's markup: any anchor
  // whose href points at a watch URL works, regardless of which renderer
  // (legacy ytd-* or the newer yt-lockup-view-model) produced it.
  function getVideoIdFromItem(item) {
    for (const a of item.querySelectorAll('a[href*="watch?v="]')) {
      try {
        const v = new URL(a.getAttribute("href"), location.origin).searchParams.get("v");
        if (v) return v;
      } catch {
        // ignore malformed hrefs and keep checking other anchors
      }
    }
    return null;
  }

  function getDurationFromItem(item) {
    for (const sel of SELECTORS.durationCandidates) {
      const el = item.querySelector(sel);
      if (el && el.textContent) {
        const secs = parseDurationText(el.textContent);
        if (secs > 0) return secs;
      }
    }
    // Fallback for components with no known selector match: scan leaf
    // elements for text that's shaped like a duration (mm:ss or h:mm:ss).
    // This is how we found `.ytBadgeShapeText` in the first place, and it
    // generalizes to whatever YouTube ships next.
    for (const el of item.querySelectorAll("*")) {
      if (el.children.length === 0) {
        const t = el.textContent.trim();
        if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) {
          const secs = parseDurationText(t);
          if (secs > 0) return secs;
        }
      }
    }
    return 0;
  }

  // Tries each selector in turn and uses the first that actually yields
  // usable items — see the comment on SELECTORS above for why more than
  // one candidate is needed. Scoped to `root` rather than the whole
  // document: generic tags like yt-lockup-view-model are reused elsewhere
  // on the page (recommendations, "up next"), so an unscoped query pulls
  // in videos that aren't actually part of this playlist and inflates the
  // total.
  function scanItems(root, selectorCandidates) {
    if (!root) return new Map();
    for (const selector of selectorCandidates) {
      const nodes = root.querySelectorAll(selector);
      if (nodes.length === 0) continue;
      const map = new Map();
      nodes.forEach((item, idx) => {
        const videoId = getVideoIdFromItem(item);
        if (!videoId) return;
        map.set(videoId, { durationSec: getDurationFromItem(item), index: idx });
      });
      if (map.size > 0) return map;
    }
    return new Map();
  }

  function getPlaylistListRoot() {
    return document.querySelector("ytd-playlist-video-list-renderer") || document.querySelector("#primary");
  }

  function getPanelRoot() {
    return document.querySelector("ytd-playlist-panel-renderer");
  }

  // ---------- UI ----------

  // Earlier versions tried to weave the bar into YouTube's playlist-header
  // DOM (ytd-playlist-sidebar-primary-info-renderer / the newer
  // page-header-view-model card). That markup turned out to be unstable
  // across A/B variants — sometimes present-but-invisible, sometimes a
  // different tag entirely, sometimes not laid out yet when we looked —
  // and every host-finding heuristic broke in a new way. A fixed-position
  // overlay anchored to <body> sidesteps all of that: <body> always
  // exists, so this can never fail to attach.
  function ensureUIElement() {
    let el = document.getElementById("ytpp-container");
    if (el) return el;
    el = document.createElement("div");
    el.id = "ytpp-container";
    el.innerHTML =
      '<div id="ytpp-text"></div><div id="ytpp-bar"><div id="ytpp-fill"></div></div>';
    document.body.appendChild(el);
    return el;
  }

  // On the playlist page, dock the overlay just under the "Play all"
  // button instead of the default top-right corner, so it reads as part
  // of the playlist info rather than a random floating badge. Matching by
  // button text (not a class/tag) is what survived every DOM redesign so
  // far in this component, so it's used as the anchor here too.
  function findPlayAllButton() {
    return [...document.querySelectorAll("yt-button-shape, ytd-button-renderer, button, a")].find(
      (el) => el.textContent && el.textContent.trim() === "Play all"
    );
  }

  function positionNearPlayAllButton(el) {
    const btn = findPlayAllButton();
    if (!btn) return false;
    const r = btn.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    el.style.top = Math.round(r.bottom + 12) + "px";
    el.style.left = Math.round(r.left) + "px";
    el.style.right = "auto";
    return true;
  }

  function useDefaultPosition(el) {
    el.style.top = "";
    el.style.left = "";
    el.style.right = "";
  }

  const repositionOnScroll = debounce(() => {
    if (state.pageType !== "playlist") return;
    const el = document.getElementById("ytpp-container");
    if (el) positionNearPlayAllButton(el);
  }, 100);
  window.addEventListener("scroll", repositionOnScroll, { passive: true });
  window.addEventListener("resize", repositionOnScroll);

  function renderProgress() {
    const el = document.getElementById("ytpp-container");
    if (!el) return;

    let totalSec = 0;
    let watchedSec = 0;
    for (const [videoId, item] of state.items) {
      const dur = item.durationSec || 0;
      totalSec += dur;
      let w = state.watched[videoId] || 0;
      if (dur > 0) w = Math.min(w, dur);
      watchedSec += w;
    }

    const pct = totalSec > 0 ? Math.min(100, (watchedSec / totalSec) * 100) : 0;
    el.querySelector("#ytpp-text").textContent =
      `Watched ${formatTime(watchedSec)} / ${formatTime(totalSec)} (${pct.toFixed(1)}%)`;
    el.querySelector("#ytpp-fill").style.width = pct + "%";
  }

  // ---------- playlist page ----------

  let playlistPollTimer = null;
  const PLAYLIST_POLL_MAX_TRIES = 25; // ~10s at 400ms

  function scanAndRenderPlaylistPage() {
    positionNearPlayAllButton(ensureUIElement());
    const map = scanItems(getPlaylistListRoot(), SELECTORS.playlistPageItemCandidates);
    if (map.size === 0) return false;
    state.items = map;
    renderProgress();
    return true;
  }

  function attachPlaylistListObserver() {
    // "#contents" is the tightest, cheapest-to-observe target, but its
    // exact selector varies by which renderer is active; fall back to
    // progressively broader containers that should exist either way.
    const target = document.querySelector("ytd-playlist-video-list-renderer #contents") || getPlaylistListRoot();
    if (playlistObserver) playlistObserver.disconnect();
    if (target) {
      playlistObserver = new MutationObserver(debounce(scanAndRenderPlaylistPage, 300));
      // subtree: true because duration badges are inserted into each item's
      // thumbnail asynchronously (once it loads), after the item itself
      // already exists — a top-level-only observer misses that and leaves
      // durations stuck at whatever was scraped on the first pass.
      playlistObserver.observe(target, { childList: true, subtree: true });
    }
  }

  function setupPlaylistPage(tries = 0) {
    clearTimeout(playlistPollTimer);
    const found = scanAndRenderPlaylistPage();
    if (found) {
      attachPlaylistListObserver();
      // Belt-and-braces: a handful of items can still be found with their
      // duration badge not painted yet, and if that badge's later arrival
      // doesn't fire a childList mutation the observer catches, the total
      // stays under-counted forever. A couple of extra rescans shortly
      // after the initial success catches those without relying solely on
      // the observer.
      [1000, 3000].forEach((delay) => setTimeout(scanAndRenderPlaylistPage, delay));
      return;
    }
    if (tries >= PLAYLIST_POLL_MAX_TRIES) {
      console.warn(
        "[ytpp] gave up waiting for playlist items via selectors:",
        SELECTORS.playlistPageItemCandidates
      );
      return;
    }
    playlistPollTimer = setTimeout(() => setupPlaylistPage(tries + 1), 400);
  }

  // ---------- watch page ----------

  function scanAndRenderWatchPage() {
    const map = scanItems(getPanelRoot(), SELECTORS.panelItemCandidates);
    if (map.size > 0) state.items = map;
    useDefaultPosition(ensureUIElement());
    renderProgress();
  }

  function attachVideoTracking() {
    clearTimeout(attachRetryTimer);
    const videoEl = document.querySelector("video.html5-main-video") || document.querySelector("video");
    const urlVideoId = getVideoIdFromUrl();

    if (!videoEl) {
      attachRetryTimer = setTimeout(attachVideoTracking, 500);
      return;
    }
    if (state.videoEl === videoEl && state.currentVideoId === urlVideoId) return;

    if (state.videoEl && timeUpdateHandler) {
      state.videoEl.removeEventListener("timeupdate", timeUpdateHandler);
    }

    state.videoEl = videoEl;
    state.currentVideoId = urlVideoId;

    timeUpdateHandler = () => {
      const videoId = state.currentVideoId;
      if (!videoId) return;
      const cur = videoEl.currentTime;
      const prevMax = state.watched[videoId] || 0;
      if (cur > prevMax) {
        state.watched[videoId] = cur;
        if (state.items.has(videoId)) {
          const item = state.items.get(videoId);
          if (!item.durationSec && videoEl.duration && isFinite(videoEl.duration)) {
            item.durationSec = videoEl.duration;
          }
        }
        renderProgress();
      }
    };
    videoEl.addEventListener("timeupdate", timeUpdateHandler);

    if (saveInterval) clearInterval(saveInterval);
    saveInterval = setInterval(() => {
      if (state.playlistId) saveWatched(state.playlistId, state.watched);
    }, 2000);
  }

  function setupWatchPage() {
    scanAndRenderWatchPage();
    attachVideoTracking();

    const panel = document.querySelector("ytd-playlist-panel-renderer #items");
    if (watchObserver) watchObserver.disconnect();
    if (panel) {
      watchObserver = new MutationObserver(debounce(scanAndRenderWatchPage, 300));
      watchObserver.observe(panel, { childList: true, subtree: true });
    }
  }

  // ---------- lifecycle ----------

  function teardown() {
    const el = document.getElementById("ytpp-container");
    if (el) el.remove();
    if (playlistObserver) {
      playlistObserver.disconnect();
      playlistObserver = null;
    }
    if (watchObserver) {
      watchObserver.disconnect();
      watchObserver = null;
    }
    if (saveInterval) {
      clearInterval(saveInterval);
      saveInterval = null;
    }
    clearTimeout(attachRetryTimer);
    clearTimeout(playlistPollTimer);
    if (state.videoEl && timeUpdateHandler) {
      state.videoEl.removeEventListener("timeupdate", timeUpdateHandler);
    }
    if (state.playlistId) saveWatched(state.playlistId, state.watched);
    state.videoEl = null;
    state.currentVideoId = null;
    state.items = new Map();
  }

  async function init() {
    const pageType = getPageType();
    if (!pageType) {
      teardown();
      state.playlistId = null;
      return;
    }

    const playlistId = getPlaylistIdFromUrl();
    if (state.playlistId !== playlistId) {
      if (state.playlistId) saveWatched(state.playlistId, state.watched);
      state.playlistId = playlistId;
      state.watched = await loadWatched(playlistId);
      state.items = new Map();
    }
    state.pageType = pageType;

    if (pageType === "playlist") {
      if (watchObserver) {
        watchObserver.disconnect();
        watchObserver = null;
      }
      setupPlaylistPage();
    } else {
      if (playlistObserver) {
        playlistObserver.disconnect();
        playlistObserver = null;
      }
      setupWatchPage();
    }
  }

  document.addEventListener("yt-navigate-finish", () => {
    init();
  });
  window.addEventListener("beforeunload", () => {
    if (state.playlistId) saveWatched(state.playlistId, state.watched);
  });

  init();
})();
