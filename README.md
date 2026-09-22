# yt_utility

Chrome extension: live YouTube playlist watch-progress.

Shows `Watched X / Y (Z%)` based on the furthest position you've reached in
each video of a playlist, summed against the playlist's total duration.
Updates every second while a video plays — no waiting for a video to finish.

Rendered as a small fixed overlay pill in the top-right corner of the page,
on both a playlist page (`youtube.com/playlist?list=...`) and a watch page
for a video that's part of a playlist. It's not woven into YouTube's own
header markup — that markup turned out to change shape (and sometimes exist
in an invisible, A/B-tested form) too often to target reliably.

No YouTube API key needed — durations are read from the page itself, and
your watched position per video is stored locally (`chrome.storage.local`),
scoped per playlist.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open any YouTube playlist or a video that belongs to one.

## Notes / limitations

- Duration scraping relies on YouTube's current DOM structure
  (`content.js` → `SELECTORS`). If YouTube ships a redesign and durations
  stop showing, that's the place to add a new fallback selector.
- On the playlist page, videos load lazily as you scroll, so the total may
  climb as more of the list renders.
- "Watched" = furthest playback position reached per video, not cumulative
  replay time.
