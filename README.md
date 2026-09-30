# NF JP Reader

Chrome extension (Manifest V3, plain JavaScript, no build step) for watching Netflix with Japanese and Traditional Chinese subtitles. Stage 1 captures the subtitle files automatically. Stage 2 draws them in the player, with furigana on kanji.

Track discovery follows the same two Netflix mechanisms as [asbplayer](https://github.com/asbplayer/asbplayer) (MIT). Only that detection approach is used.

## Load unpacked

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose this folder (`subtitle`), the one that contains `manifest.json`.
4. Reload any Netflix tab that was already open. The hooks run at `document_start`, so a tab that started playing before the extension was installed will not capture until it is refreshed.

After code changes, click the reload icon on the extension card, then refresh the Netflix tab.

## What you should see

Open an episode that has Japanese and Chinese subtitles. You do not need to turn those languages on in Netflix's own menu.

- Netflix's own subtitle text disappears.
- A centered block sits near the bottom of the picture: Japanese on top (larger, white), Traditional Chinese underneath (smaller, slightly dimmed). It tracks pause, seek, playback speed, and the next episode.
- Kanji grow hiragana readings a moment after the episode loads (`[NFJP] kuromoji ready`, then `furigana cached`). If the Netflix file already has ruby, those readings are used immediately.
- The block stays at the bottom center, about 8% up from the edge, or 14% while the Netflix control bar is visible. It grows upward when a second line appears, so the bottom edge stays put. Alt+↑ / Alt+↓ nudge that spot, and the nudge is kept on the next episode. Japanese timing leads: Chinese lines that overlap the active Japanese cue are shown with it. **Follow Netflix position** in the popup (off by default) is what moves the block to the top for a top-region or forced lyric cue.
- The toolbar icon opens the same toggles, a font-size slider, and a background shade with its own opacity slider. Alt+B toggles the shade.

Press **Alt+D** for the debug box (hidden until then): video id, whether the cues came from `network` or `cache`, the time and reason of the last state clear, the track list, cue counts, the current line, and any download or parse error. **Retry capture** downloads the episode in the current `/watch/<id>` URL again without reloading the page. **Export JSON** saves the cues.

## Keys

| Key | Action |
| --- | --- |
| Alt+S | Turn our subtitles off and bring Netflix's back. Press again to restore ours. |
| Alt+J | Japanese line |
| Alt+C | Chinese line |
| Alt+F | Furigana |
| Alt+B | Background shade |
| Alt+D | Debug overlay |
| Alt+↑ / Alt+↓ | Nudge the block. The offset is remembered. |
| A | Replay the current line |
| Q / E | Previous / next line |

A, Q, and E are ignored while a text field is focused.

## How capture works

1. Hook `JSON.parse`, `JSON.stringify`, `fetch`, and `XMLHttpRequest` before the player starts. Manifest requests get text profiles (`dfxp-ls-sdh`, `imsc1.1`, `webvtt-lssdh-ios8`, `simplesdh`) and `showAllSubDubTracks: true`.
2. If that manifest never reaches the main thread, read `getTimedTextTrackList()` and walk the active player session for `{type: "timedtext", urls}`. When a chosen language still has no text URL, the extension selects that track, waits for the URL, then restores the previous track.

Main Japanese is the full `ja` track, then `ja` CC. Main Chinese is full `zh-Hant`, then `zh-Hant` CC, then full `zh-Hans`, then any other full `zh*`. Forced tracks are kept separate and are never the main dialogue track. Image profiles such as `nflx-cmisc` are listed and not downloaded. Netflix-shaped parsing lives in `netflixTracks.js`.

Console lines are prefixed with `[NFJP]`. The watch id comes only from the page URL. Each manifest is stored under its own movie id, and a manifest for a different id leaves the current episode alone. Once Japanese and Chinese cues are both parsed, they are saved in IndexedDB (`nfjp`, keys `<videoId>:ja` and `<videoId>:zh`) and the next visit of that episode loads them without downloading again.

## If something looks wrong

1. **No replacement text, and `[NFJP]` never logs `parsed`.** Capture failed the same way as stage 1: no manifest and no player track list (`no cadmium session root`), or the chosen language stayed `no-url` (`selecting track to load url` without `url ready`), or the download/parser failed (`page fetch failed`, `unrecognized subtitle document`). Alt+D shows the track list. A title with no Japanese or Chinese simply has nothing to draw.
2. **Japanese and Chinese are the forced or closed-caption track, or Simplified Chinese when Traditional exists.** The preference order is in `pickTargets` in `netflixTracks.js`. Alt+D prints the chosen language plus `CC` or `fallback`. A track with no text URL can still lose out to one that has a file.
3. **Text is there but furigana never appears.** The offscreen kuromoji page did not load its dictionary. Look for `kuromoji failed`, `offscreen failed`, or `furigana batch failed`. Readings that Netflix already embedded still show; kuromoji is only the fallback. Alt+F turns the feature off entirely.
