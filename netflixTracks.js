/*
 * All Netflix-specific track discovery lives in this file.
 *
 * Two sources, same output shape:
 * 1. Playback manifest `timedtexttracks` / `textTracks` (JSON.parse, fetch, XHR).
 *    Text URLs exist only when the manifest request asked for text profiles and
 *    showAllSubDubTracks. Image profile "nflx-cmisc" is ignored for download.
 * 2. The live player (what asbplayer uses after Netflix stopped running the
 *    manifest through main-thread JSON.parse): getTimedTextTrackList() plus a
 *    walk of the active cadmium session for {type:"timedtext", trackId, urls}.
 *    Those URLs are often filled in only for the selected track.
 */
(function () {
  'use strict';

  const NF = globalThis.__NFJP || (globalThis.__NFJP = {});

  const TEXT_FORMATS = ['imsc1.1', 'dfxp-ls-sdh', 'webvtt-lssdh-ios8', 'simplesdh'];
  const IMAGE_FORMATS = new Set(['nflx-cmisc']);

  function nfLog() {
    const args = ['[NFJP]'];
    for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  function normLang(value) {
    return String(value || '').trim().toLowerCase().replace(/_/g, '-');
  }

  function jaRank(language) {
    const lang = normLang(language);
    if (lang === 'ja') return 0;
    if (lang === 'ja-jp') return 1;
    if (lang === 'ja' || lang.startsWith('ja-') || lang.startsWith('ja')) return 2;
    return -1;
  }

  function zhRank(language) {
    const lang = normLang(language);
    if (lang === 'zh-hant' || lang === 'zh-tw' || lang === 'zh-hk' || lang === 'zh-mo') return 0;
    if (lang.startsWith('zh-hant')) return 1;
    if (lang === 'zh-hans' || lang === 'zh-cn' || lang === 'zh-sg') return 2;
    if (lang.startsWith('zh-hans')) return 3;
    if (lang === 'zh' || lang.startsWith('zh-') || lang.startsWith('zh')) return 4;
    return -1;
  }

  function urlsFromDownloadable(downloadable) {
    const urls = [];
    if (!downloadable || typeof downloadable !== 'object') return urls;
    const downloadUrls = downloadable.downloadUrls;
    if (downloadUrls && typeof downloadUrls === 'object') {
      const values = Array.isArray(downloadUrls) ? downloadUrls : Object.values(downloadUrls);
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (typeof value === 'string' && value) urls.push(value);
        else if (value && typeof value.url === 'string') urls.push(value.url);
      }
    }
    if (Array.isArray(downloadable.urls)) {
      for (let i = 0; i < downloadable.urls.length; i++) {
        const value = downloadable.urls[i];
        if (typeof value === 'string' && value) urls.push(value);
        else if (value && typeof value.url === 'string') urls.push(value.url);
      }
    }
    if (typeof downloadable.url === 'string' && downloadable.url) urls.push(downloadable.url);
    return urls;
  }

  function formatKind(format, downloadable, track) {
    if (IMAGE_FORMATS.has(format)) return 'image';
    if (downloadable && downloadable.isImage === true) return 'image';
    if (track && track.isImageBased === true && IMAGE_FORMATS.has(format)) return 'image';
    return 'text';
  }

  function formatRank(format) {
    const index = TEXT_FORMATS.indexOf(format);
    return index === -1 ? 50 : index;
  }

  function emptyTrack(language, displayName) {
    return {
      language: language,
      displayName: displayName || language,
      isForced: false,
      isCC: false,
      isImage: false,
      trackId: null,
      altTrackIds: [],
      rawTrackType: '',
      formats: [],
      downloadUrl: null,
      preferredFormat: null
    };
  }

  function choosePreferred(track) {
    const text = [];
    let sawImage = false;
    for (let i = 0; i < track.formats.length; i++) {
      const fmt = track.formats[i];
      if (fmt.kind === 'text' && fmt.url) text.push(fmt);
      else if (fmt.kind === 'image') sawImage = true;
    }
    text.sort(function (a, b) { return formatRank(a.format) - formatRank(b.format); });
    if (text.length) {
      track.downloadUrl = text[0].url;
      track.preferredFormat = text[0].format;
      track.isImage = false;
      return;
    }
    track.downloadUrl = null;
    track.preferredFormat = null;
    // No text URL yet is not the same as an image track. Only mark image when
    // Netflix said so, or the only profiles we saw are image profiles.
    if (sawImage) track.isImage = true;
  }

  function addFormat(track, format, kind, url) {
    if (!url) return;
    for (let i = 0; i < track.formats.length; i++) {
      if (track.formats[i].format === format && track.formats[i].url === url) return;
    }
    track.formats.push({ format: format, kind: kind, url: url });
  }

  function absorbRawTrack(track, raw) {
    const language = String(raw.language || raw.bcp47 || raw.languageCode || '').trim();
    if (!track.language && language) track.language = language;
    const displayName = raw.languageDescription || raw.displayName || raw.trackName;
    if (displayName && (!track.displayName || track.displayName === track.language)) {
      track.displayName = String(displayName);
    }
    const rawType = String(raw.rawTrackType || raw.trackType || '');
    if (rawType) track.rawTrackType = rawType;
    const rawLower = rawType.toLowerCase();
    if (raw.isForcedNarrative === true || rawLower.indexOf('forced') !== -1) track.isForced = true;
    if (rawLower.indexOf('closedcaption') !== -1 || raw.isClosedCaptions === true) track.isCC = true;
    const trackId = raw.trackId || raw.new_track_id || raw.newTrackId || null;
    if (trackId) {
      if (!track.trackId) track.trackId = String(trackId);
      else if (track.trackId !== String(trackId) && track.altTrackIds.indexOf(String(trackId)) === -1) {
        track.altTrackIds.push(String(trackId));
      }
    }
    const downloadables = raw.ttDownloadables || raw.downloadables || null;
    if (downloadables && typeof downloadables === 'object') {
      const names = Object.keys(downloadables);
      for (let i = 0; i < names.length; i++) {
        const format = names[i];
        const urls = urlsFromDownloadable(downloadables[format]);
        const kind = formatKind(format, downloadables[format], raw);
        for (let u = 0; u < urls.length; u++) addFormat(track, format, kind, urls[u]);
      }
    }
    if (raw.isImageBased === true) track.isImage = true;
    choosePreferred(track);
  }

  function trackKey(track) {
    return [
      normLang(track.language),
      track.isForced ? 'F' : 'f',
      track.isCC ? 'C' : 'c',
      track.isImage ? 'I' : 't',
      String(track.displayName || '').toLowerCase()
    ].join('|');
  }

  function cloneTrack(track) {
    return {
      language: track.language,
      displayName: track.displayName,
      isForced: track.isForced,
      isCC: track.isCC,
      isImage: track.isImage,
      trackId: track.trackId,
      altTrackIds: (track.altTrackIds || []).slice(),
      rawTrackType: track.rawTrackType,
      formats: (track.formats || []).map(function (fmt) {
        return { format: fmt.format, kind: fmt.kind, url: fmt.url };
      }),
      downloadUrl: track.downloadUrl,
      preferredFormat: track.preferredFormat
    };
  }

  function mergeInto(prev, next) {
    if (next.trackId && prev.trackId && next.trackId !== prev.trackId && prev.altTrackIds.indexOf(next.trackId) === -1) {
      prev.altTrackIds.push(next.trackId);
    } else if (next.trackId && !prev.trackId) {
      prev.trackId = next.trackId;
    }
    for (let i = 0; i < (next.altTrackIds || []).length; i++) {
      const id = next.altTrackIds[i];
      if (id !== prev.trackId && prev.altTrackIds.indexOf(id) === -1) prev.altTrackIds.push(id);
    }
    for (let i = 0; i < next.formats.length; i++) {
      addFormat(prev, next.formats[i].format, next.formats[i].kind, next.formats[i].url);
    }
    const prevRank = prev.preferredFormat ? formatRank(prev.preferredFormat) : 99;
    const nextRank = next.preferredFormat ? formatRank(next.preferredFormat) : 99;
    if (next.downloadUrl && (!prev.downloadUrl || nextRank < prevRank)) {
      prev.downloadUrl = next.downloadUrl;
      prev.preferredFormat = next.preferredFormat;
    }
    if (prev.downloadUrl) prev.isImage = false;
  }

  function reconcile(tracks) {
    const groups = new Map();
    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const key = normLang(track.language) + '|' + (track.isForced ? 'F' : 'f') + '|' + (track.isCC ? 'C' : 'c');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(track);
    }
    groups.forEach(function (group) {
      const withText = group.filter(function (track) { return track.downloadUrl && !track.isImage; });
      if (withText.length !== 1) return;
      for (let i = 0; i < group.length; i++) {
        if (!group[i].isImage && !group[i].downloadUrl) mergeInto(group[i], withText[0]);
      }
    });
  }

  /**
   * Normalize a Netflix manifest result, or a synthetic payload built from the
   * player track list, into plain track records.
   */
  function extractNetflixTracks(payload) {
    const source = payload && payload.result && (payload.result.timedtexttracks || payload.result.textTracks)
      ? payload.result
      : payload;
    const rawTracks = source && (source.timedtexttracks || source.textTracks);
    if (!Array.isArray(rawTracks)) return [];

    const map = new Map();
    for (let i = 0; i < rawTracks.length; i++) {
      const raw = rawTracks[i];
      if (!raw || typeof raw !== 'object' || raw.isNoneTrack) continue;
      const language = String(raw.language || raw.bcp47 || raw.languageCode || '').trim();
      const displayName = String(raw.languageDescription || raw.displayName || raw.trackName || language);
      if (!language || normLang(language) === 'none' || /^off$/i.test(displayName)) continue;
      const draft = emptyTrack(language, displayName);
      absorbRawTrack(draft, raw);
      const key = trackKey(draft);
      if (!map.has(key)) map.set(key, draft);
      else mergeInto(map.get(key), draft);
    }
    const tracks = Array.from(map.values());
    reconcile(tracks);
    return tracks;
  }

  function mergeTrackLists(lists) {
    const map = new Map();
    for (let s = 0; s < lists.length; s++) {
      const list = lists[s] || [];
      for (let i = 0; i < list.length; i++) {
        const track = cloneTrack(list[i]);
        const key = trackKey(track);
        if (!map.has(key)) map.set(key, track);
        else mergeInto(map.get(key), track);
      }
    }
    const tracks = Array.from(map.values());
    reconcile(tracks);
    return tracks;
  }

  // Lower is better. Forced tracks are never a main subtitle.
  // Japanese: full > CC. Chinese: zh-Hant full > zh-Hant CC > zh-Hans full > any other zh full.
  function jaMainTier(track) {
    return track.isCC ? 1 : 0;
  }

  function zhMainTier(track) {
    const rank = zhRank(track.language);
    const traditional = rank <= 1;
    const simplified = rank === 2 || rank === 3;
    if (traditional && !track.isCC) return 0;
    if (traditional && track.isCC) return 1;
    if (simplified && !track.isCC) return 2;
    if (!track.isCC) return 3;
    if (simplified) return 4;
    return 5;
  }

  function bestMain(candidates, tierOf) {
    const pool = candidates.filter(function (track) { return !track.isForced; });
    if (!pool.length) return null;
    pool.sort(function (a, b) {
      const image = (a.isImage ? 1 : 0) - (b.isImage ? 1 : 0);
      if (image) return image;
      const tier = tierOf(a) - tierOf(b);
      if (tier) return tier;
      return (a.downloadUrl ? 0 : 1) - (b.downloadUrl ? 0 : 1);
    });
    return pool[0];
  }

  function bestForced(candidates, rankOf) {
    const pool = candidates.filter(function (track) { return track.isForced; });
    if (!pool.length) return null;
    pool.sort(function (a, b) {
      const image = (a.isImage ? 1 : 0) - (b.isImage ? 1 : 0);
      if (image) return image;
      const rank = rankOf(a.language) - rankOf(b.language);
      if (rank) return rank;
      return (a.downloadUrl ? 0 : 1) - (b.downloadUrl ? 0 : 1);
    });
    return pool[0];
  }

  function pickTargets(tracks) {
    const list = tracks || [];
    const jaCandidates = list.filter(function (track) { return jaRank(track.language) >= 0; });
    const zhCandidates = list.filter(function (track) { return zhRank(track.language) >= 0; });
    return {
      ja: bestMain(jaCandidates, jaMainTier),
      zh: bestMain(zhCandidates, zhMainTier),
      jaForced: bestForced(jaCandidates, jaRank),
      zhForced: bestForced(zhCandidates, zhRank),
      jaListed: jaCandidates.some(function (track) { return !track.isForced; }),
      zhListed: zhCandidates.some(function (track) { return !track.isForced; })
    };
  }

  function textFormatsInOrder(track) {
    if (!track) return [];
    const seen = new Set();
    const formats = [];
    for (let i = 0; i < (track.formats || []).length; i++) {
      const fmt = track.formats[i];
      if (fmt.kind !== 'text' || !fmt.url || seen.has(fmt.url)) continue;
      seen.add(fmt.url);
      formats.push(fmt);
    }
    formats.sort(function (a, b) { return formatRank(a.format) - formatRank(b.format); });
    return formats;
  }

  function publicTrack(track) {
    return {
      language: track.language,
      displayName: track.displayName,
      isForced: !!track.isForced,
      isCC: !!track.isCC,
      isImage: !!track.isImage,
      preferredFormat: track.preferredFormat,
      hasUrl: !!track.downloadUrl,
      formats: (track.formats || []).map(function (fmt) {
        return { format: fmt.format, kind: fmt.kind };
      })
    };
  }

  function summarizeTracks(tracks) {
    if (!tracks || !tracks.length) return '(none)';
    return tracks.map(function (track) {
      const flags = (track.isCC ? '/CC' : '') + (track.isForced ? '/forced' : '');
      const kind = track.downloadUrl ? (track.preferredFormat || 'text') : (track.isImage ? 'image' : 'no-url');
      return track.language + flags + ' ' + kind;
    }).join(' | ');
  }

  function urlHost(url) {
    try { return new URL(url).host; } catch (e) { return 'invalid-url'; }
  }

  /**
   * Ask a manifest request for every subtitle language and for text profiles,
   * not only the language currently selected in the player. Returns true when
   * the object was modified.
   */
  function forceManifestRequest(data) {
    let mutated = false;
    const seen = new WeakSet();
    let playback = false;

    function eachNode(node, depth, fn) {
      if (!node || typeof node !== 'object' || depth > 6 || seen.has(node)) return;
      seen.add(node);
      if (!Array.isArray(node)) fn(node);
      const values = Array.isArray(node) ? node : Object.keys(node).map(function (key) { return node[key]; });
      for (let i = 0; i < values.length; i++) {
        if (values[i] && typeof values[i] === 'object') eachNode(values[i], depth + 1, fn);
      }
    }

    eachNode(data, 0, function (node) {
      const profiles = node.profiles;
      if (Array.isArray(profiles) && profiles.some(function (profile) {
        return typeof profile === 'string' && /h264|h265|hevc|av1|vp9|playready|widevine|ddplus|eac3|aac|opus/i.test(profile);
      })) playback = true;
    });
    if (!playback) return false;

    const seenAgain = new WeakSet();
    function apply(node, depth) {
      if (!node || typeof node !== 'object' || depth > 6 || seenAgain.has(node)) return;
      seenAgain.add(node);
      if (!Array.isArray(node)) {
        try {
          if (Array.isArray(node.profiles) && node.profiles.some(function (profile) {
            return typeof profile === 'string' && /h264|h265|hevc|av1|vp9|playready|widevine/i.test(profile);
          })) {
            for (let i = TEXT_FORMATS.length - 1; i >= 0; i--) {
              if (node.profiles.indexOf(TEXT_FORMATS[i]) === -1) {
                node.profiles.unshift(TEXT_FORMATS[i]);
                mutated = true;
              }
            }
          }
          if (typeof node.showAllSubDubTracks === 'boolean' && node.showAllSubDubTracks !== true) {
            node.showAllSubDubTracks = true;
            mutated = true;
          }
        } catch (e) {
          /* A frozen request object cannot list every language. */
        }
      }
      const values = Array.isArray(node) ? node : Object.keys(node).map(function (key) { return node[key]; });
      for (let i = 0; i < values.length; i++) {
        if (values[i] && typeof values[i] === 'object') apply(values[i], depth + 1);
      }
    }
    apply(data, 0);
    return mutated;
  }

  function pluckManifest(data) {
    if (!data || typeof data !== 'object') return null;
    if (Array.isArray(data.timedtexttracks) || Array.isArray(data.textTracks)) return data;
    if (data.result && (Array.isArray(data.result.timedtexttracks) || Array.isArray(data.result.textTracks))) {
      return data.result;
    }
    return null;
  }

  function isManifestUrl(url) {
    return typeof url === 'string' && /manifest|licensedManifest|cadmium/i.test(url);
  }

  function getVideoPlayerApi() {
    try {
      const netflix = globalThis.netflix;
      if (!netflix) return null;
      return netflix.appContext && netflix.appContext.state && netflix.appContext.state.playerApp &&
        netflix.appContext.state.playerApp.getAPI &&
        netflix.appContext.state.playerApp.getAPI();
    } catch (e) {
      return null;
    }
  }

  function activeSession(videoPlayer) {
    const sessionIds = (videoPlayer.getAllPlayerSessionIds && videoPlayer.getAllPlayerSessionIds()) || [];
    if (!sessionIds.length) return null;
    const sessionId = sessionIds[sessionIds.length - 1];
    const player = videoPlayer.getVideoPlayerBySessionId && videoPlayer.getVideoPlayerBySessionId(sessionId);
    return { sessionId: sessionId, sessionIds: sessionIds, player: player || null };
  }

  function peekMovieId() {
    try {
      const api = getVideoPlayerApi();
      const videoPlayer = api && api.videoPlayer;
      if (!videoPlayer) return null;
      const session = activeSession(videoPlayer);
      if (!session || !session.player || !session.player.getMovieId) return null;
      const movieId = session.player.getMovieId();
      return movieId == null ? null : String(movieId);
    } catch (e) {
      return null;
    }
  }

  function sessionRoot(sessionId) {
    try {
      const playerApp = globalThis.netflix && globalThis.netflix.appContext &&
        globalThis.netflix.appContext.state && globalThis.netflix.appContext.state.playerApp;
      const state = playerApp && playerApp.getState && playerApp.getState();
      const byId = state && state.videoPlayer && state.videoPlayer.cadmiumPlayerRepository &&
        state.videoPlayer.cadmiumPlayerRepository.playersById;
      if (byId && byId[sessionId]) return { root: byId[sessionId], state: state, via: 'playersById' };
      if (byId) {
        const values = Object.values(byId);
        if (values.length) return { root: values[values.length - 1], state: state, via: 'playersById-last' };
      }
      return { root: null, state: state, via: 'missing' };
    } catch (e) {
      return { root: null, state: null, via: 'throw' };
    }
  }

  function walkSession(root) {
    const urls = new Map();
    const manifests = [];
    if (!root || typeof root !== 'object') return { urls: urls, manifests: manifests, nodes: 0, capped: false };
    const seen = new WeakSet();
    const stack = [{ node: root, depth: 0 }];
    let nodes = 0;
    let capped = false;

    while (stack.length) {
      const item = stack.pop();
      const node = item.node;
      if (!node || typeof node !== 'object') continue;
      if (item.depth > 20 || seen.has(node)) continue;
      if (typeof Node !== 'undefined' && node instanceof Node) continue;
      if (node instanceof ArrayBuffer || ArrayBuffer.isView(node)) continue;
      seen.add(node);
      nodes++;
      if (nodes > 25000) {
        capped = true;
        break;
      }

      try {
        if (node.type === 'timedtext' && typeof node.trackId === 'string' && Array.isArray(node.urls) && node.urls.length) {
          const first = node.urls[0];
          const url = typeof first === 'string' ? first : first && first.url;
          if (typeof url === 'string' && !urls.has(node.trackId)) urls.set(node.trackId, url);
        }
        if (Array.isArray(node.timedtexttracks) && node.timedtexttracks.length && manifests.length < 4) {
          manifests.push(node);
        }
      } catch (e) {
        continue;
      }

      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          if (node[i] && typeof node[i] === 'object') stack.push({ node: node[i], depth: item.depth + 1 });
        }
      } else {
        let keys;
        try { keys = Object.keys(node); } catch (e) { continue; }
        for (let i = 0; i < keys.length; i++) {
          let value;
          try { value = node[keys[i]]; } catch (e) { continue; }
          if (value && typeof value === 'object') stack.push({ node: value, depth: item.depth + 1 });
        }
      }
    }
    return { urls: urls, manifests: manifests, nodes: nodes, capped: capped };
  }

  let loggedShape = false;
  let loggedMissingRoot = false;

  /**
   * Read the active Netflix player. Returns null until the watch page has a session.
   */
  function scanPlayer() {
    const api = getVideoPlayerApi();
    const videoPlayer = api && api.videoPlayer;
    if (!videoPlayer) return null;
    const session = activeSession(videoPlayer);
    if (!session || !session.player) return null;
    const player = session.player;
    let rawList = [];
    try {
      rawList = player.getTimedTextTrackList ? (player.getTimedTextTrackList() || []) : [];
    } catch (e) {
      nfLog('getTimedTextTrackList failed', e && e.message ? e.message : e);
      return null;
    }
    if (!loggedShape && rawList.length && rawList[0]) {
      loggedShape = true;
      try { nfLog('player track keys', Object.keys(rawList[0])); } catch (e) { /* ignore */ }
      nfLog('player session ids', session.sessionIds);
    }

    const located = sessionRoot(session.sessionId);
    if (!located.root && !loggedMissingRoot) {
      loggedMissingRoot = true;
      const videoState = located.state && located.state.videoPlayer;
      nfLog('no cadmium session root', located.via, 'videoPlayer keys', videoState ? Object.keys(videoState) : null);
    }
    const started = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const walked = located.root ? walkSession(located.root) : { urls: new Map(), manifests: [], nodes: 0, capped: false };
    const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - started;
    if (elapsed > 40 || walked.capped) {
      nfLog('player walk', Math.round(elapsed) + 'ms', 'nodes', walked.nodes, 'urls', walked.urls.size, 'capped', walked.capped);
    }

    let movieId = null;
    try {
      const id = player.getMovieId && player.getMovieId();
      movieId = id == null ? null : String(id);
    } catch (e) {
      movieId = null;
    }

    const fromManifests = [];
    for (let i = 0; i < walked.manifests.length; i++) {
      const node = walked.manifests[i];
      const nodeMovie = node && node.movieId != null ? String(node.movieId) : '';
      if (movieId && nodeMovie && nodeMovie !== movieId) continue;
      const extracted = extractNetflixTracks(node);
      for (let t = 0; t < extracted.length; t++) fromManifests.push(extracted[t]);
    }

    const synthetic = {
      movieId: player.getMovieId ? player.getMovieId() : null,
      timedtexttracks: rawList.map(function (raw) {
        const url = raw && walked.urls.get(raw.trackId);
        const downloadables = {};
        if (url) {
          const format = raw.isImageBased ? 'nflx-cmisc' : 'player-state';
          downloadables[format] = { urls: [{ url: url }], isImage: raw.isImageBased === true };
        }
        return {
          language: raw && (raw.bcp47 || raw.language),
          languageDescription: raw && (raw.displayName || raw.languageDescription),
          rawTrackType: raw && raw.rawTrackType,
          isForcedNarrative: raw && raw.isForcedNarrative,
          isNoneTrack: raw && raw.isNoneTrack,
          isImageBased: raw && raw.isImageBased,
          trackId: raw && raw.trackId,
          ttDownloadables: downloadables
        };
      })
    };

    return {
      movieId: movieId,
      sessionId: session.sessionId,
      player: player,
      rawTracks: rawList,
      tracks: mergeTrackLists([fromManifests, extractNetflixTracks(synthetic)]),
      urlCount: walked.urls.size
    };
  }

  function findPlayerTrack(rawList, wanted) {
    if (!rawList || !wanted) return null;
    const ids = {};
    if (wanted.trackId) ids[wanted.trackId] = true;
    for (let i = 0; i < (wanted.altTrackIds || []).length; i++) ids[wanted.altTrackIds[i]] = true;
    for (let i = 0; i < rawList.length; i++) {
      if (rawList[i] && ids[rawList[i].trackId]) return rawList[i];
    }
    const wantLang = normLang(wanted.language);
    const strict = [];
    const relaxed = [];
    for (let i = 0; i < rawList.length; i++) {
      const raw = rawList[i];
      if (!raw || raw.isNoneTrack) continue;
      const lang = normLang(raw.bcp47 || raw.language);
      if (lang !== wantLang) continue;
      const forced = raw.isForcedNarrative === true;
      if (forced !== !!wanted.isForced) continue;
      relaxed.push(raw);
      const isCC = String(raw.rawTrackType || '').toLowerCase().indexOf('closedcaption') !== -1;
      if (isCC === !!wanted.isCC) strict.push(raw);
    }
    return strict[0] || relaxed[0] || null;
  }

  function targetMeta(track, rankOf, exactRank) {
    if (!track) return null;
    const meta = publicTrack(track);
    meta.fallback = rankOf(track.language) > exactRank;
    meta.trackId = track.trackId;
    return meta;
  }

  NF.TEXT_FORMATS = TEXT_FORMATS;
  NF.extractNetflixTracks = extractNetflixTracks;
  NF.mergeTrackLists = mergeTrackLists;
  NF.pickTargets = pickTargets;
  NF.textFormatsInOrder = textFormatsInOrder;
  NF.publicTrack = publicTrack;
  NF.summarizeTracks = summarizeTracks;
  NF.forceManifestRequest = forceManifestRequest;
  NF.pluckManifest = pluckManifest;
  NF.isManifestUrl = isManifestUrl;
  NF.scanPlayer = scanPlayer;
  NF.peekMovieId = peekMovieId;
  NF.findPlayerTrack = findPlayerTrack;
  NF.jaRank = jaRank;
  NF.zhRank = zhRank;
  NF.urlHost = urlHost;
  NF.targetMeta = targetMeta;
  NF.nfLog = nfLog;
})();
