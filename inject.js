/*
 * Page-context capture. Hooks are installed at document_start.
 * The current video id comes only from /watch/<id>. Manifests are stored by
 * their own movieId. A manifest for any other id never touches this video.
 * Parsed ja+zh cues are final until Retry capture.
 */
(function () {
  'use strict';

  const NF = globalThis.__NFJP;
  if (!NF || !NF.extractNetflixTracks || !NF.parseSubtitleDocument) {
    console.log('[NFJP]', 'page scripts missing __NFJP. Load order is netflixTracks.js, parsers.js, inject.js.');
    return;
  }
  if (globalThis.__NFJP_HOOKED) {
    NF.nfLog('hooks already installed');
    return;
  }
  globalThis.__NFJP_HOOKED = true;

  const nfLog = NF.nfLog;
  const originalParse = JSON.parse;
  const originalStringify = JSON.stringify;
  const originalFetch = window.fetch;
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  // movieId -> { manifestTracks, playerTracks, manifestAt, playerAt }
  const manifests = new Map();
  // videoId -> { final, ja, zh, jaForced, zhForced }
  const finals = new Map();

  let generation = 0;
  let activeId = null;
  let lastPosted = {};
  let fetchSeq = 0;
  let downloadToken = 0;
  let flight = null;
  let downloadsOpen = false;
  let captureMode = 'auto';
  let cacheWaiter = null;

  function watchId() {
    const match = location.pathname.match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
  }

  function post(message) {
    message.source = 'NFJP-PAGE';
    if (message.type && (!message.videoId || message.videoId === activeId || message.videoId === watchId())) {
      lastPosted[message.type] = message;
    }
    window.postMessage(message, '*');
  }

  function ensure(movieId) {
    const key = String(movieId);
    let entry = manifests.get(key);
    if (!entry) {
      entry = { manifestTracks: null, playerTracks: null, manifestAt: 0, playerAt: 0 };
      manifests.set(key, entry);
    }
    return entry;
  }

  function manifestMovieId(manifest, parent) {
    const objs = [manifest, parent];
    if (manifest && manifest.result) objs.push(manifest.result);
    if (parent && parent.result) objs.push(parent.result);
    for (let pass = 0; pass < 2; pass++) {
      const field = pass === 0 ? 'movieId' : 'videoId';
      for (let i = 0; i < objs.length; i++) {
        const obj = objs[i];
        if (!obj || typeof obj !== 'object') continue;
        if (obj[field] != null && obj[field] !== '') return String(obj[field]);
      }
    }
    return '';
  }

  function rawTrackCount(manifest) {
    if (!manifest) return 0;
    const raw = manifest.timedtexttracks || manifest.textTracks;
    return Array.isArray(raw) ? raw.length : 0;
  }

  function hasJaOrZh(tracks) {
    const picked = NF.pickTargets(tracks || []);
    return !!(picked.ja || picked.zh || picked.jaForced || picked.zhForced);
  }

  function isFinal(id) {
    const saved = id && finals.get(String(id));
    return !!(saved && saved.final);
  }

  function logManifest(movieId, trackCount, action, via) {
    nfLog('manifest', 'movieId', movieId || '?', 'url', watchId() || 'none', 'tracks', trackCount, 'action', action, 'via', via);
  }

  function onManifest(manifest, parent, via) {
    try {
      const movieId = manifestMovieId(manifest, parent);
      const rawCount = rawTrackCount(manifest);
      if (!rawCount) {
        logManifest(movieId, 0, 'ignored', via);
        return;
      }
      const tracks = NF.extractNetflixTracks(manifest);
      if (!movieId || !hasJaOrZh(tracks)) {
        logManifest(movieId, tracks.length, 'ignored', via);
        return;
      }
      const entry = ensure(movieId);
      const incoming = urlSignature(tracks);
      const existing = urlSignature(entry.manifestTracks || []);
      if (entry.manifestTracks && !incoming && existing) {
        logManifest(movieId, tracks.length, 'ignored', via);
        return;
      }
      entry.manifestTracks = tracks;
      entry.manifestAt = Date.now();
      logManifest(movieId, tracks.length, 'stored', via);
      if (movieId !== String(watchId() || '')) return;
      if (!downloadsOpen || isFinal(movieId) || captureMode === 'skip') return;
      publishTracks(movieId);
      ensureDownload(movieId, Date.now(), false);
    } catch (e) {
      nfLog('manifest handler failed', e && e.stack ? e.stack : e);
    }
  }

  function ingestManifestText(text, via) {
    if (!text || (text.indexOf('timedtexttracks') === -1 && text.indexOf('textTracks') === -1)) {
      nfLog(via, 'response has no timedtexttracks', text ? text.length : 0);
      return;
    }
    let data;
    try {
      data = originalParse(text);
    } catch (e) {
      nfLog(via, 'manifest JSON.parse failed', e && e.message ? e.message : e);
      return;
    }
    const manifest = NF.pluckManifest(data);
    if (manifest) onManifest(manifest, data, via);
    else nfLog(via, 'timedtexttracks string was not a manifest object');
  }

  function tracksFor(id) {
    const entry = manifests.get(String(id));
    if (!entry) return [];
    const manifestSig = urlSignature(entry.manifestTracks || []);
    const playerSig = urlSignature(entry.playerTracks || []);
    if (manifestSig && (!playerSig || entry.manifestAt >= entry.playerAt)) return entry.manifestTracks;
    if (playerSig) return entry.playerTracks;
    if (entry.manifestTracks && entry.manifestTracks.length) return entry.manifestTracks;
    return entry.playerTracks || [];
  }

  function publishTracks(id) {
    if (!id || String(id) !== String(watchId() || '')) return;
    const tracks = tracksFor(id);
    if (!tracks.length) return;
    const picked = NF.pickTargets(tracks);
    post({
      type: 'TRACKS',
      videoId: String(id),
      movieId: String(id),
      tracks: tracks.map(NF.publicTrack),
      ja: NF.targetMeta(picked.ja, NF.jaRank, 0),
      zh: NF.targetMeta(picked.zh, NF.zhRank, 1),
      jaForced: picked.jaForced ? NF.publicTrack(picked.jaForced) : null,
      zhForced: picked.zhForced ? NF.publicTrack(picked.zhForced) : null
    });
  }

  function looksLikeManifestBody(data) {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.url === 'string' && NF.isManifestUrl(data.url)) return true;
    const params = data.params;
    if (params && Array.isArray(params.profiles) && typeof params.showAllSubDubTracks === 'boolean') return true;
    if (Array.isArray(data.profiles) && typeof data.showAllSubDubTracks === 'boolean') return true;
    return false;
  }

  JSON.parse = function (text) {
    const data = originalParse.apply(this, arguments);
    try {
      const manifest = NF.pluckManifest(data);
      if (manifest) onManifest(manifest, data, 'JSON.parse');
    } catch (e) {
      nfLog('JSON.parse hook failed', e && e.message ? e.message : e);
    }
    return data;
  };

  JSON.stringify = function (data) {
    try {
      if (looksLikeManifestBody(data) && NF.forceManifestRequest(data)) {
        nfLog('mutated manifest request on JSON.stringify', typeof data.url === 'string' ? data.url.split('?')[0] : 'params');
      }
    } catch (e) {
      nfLog('JSON.stringify hook failed', e && e.message ? e.message : e);
    }
    return originalStringify.apply(this, arguments);
  };

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  async function mutateAndFetch(ctx, input, init) {
    let url = requestUrl(input);
    let nextInput = input;
    let nextInit = init;
    if (NF.isManifestUrl(url)) {
      try {
        if (nextInit && typeof nextInit.body === 'string') {
          const parsed = originalParse(nextInit.body);
          if (NF.forceManifestRequest(parsed)) {
            nextInit = Object.assign({}, nextInit, { body: originalStringify(parsed) });
            nfLog('mutated fetch init body', url.split('?')[0]);
          }
        } else if (typeof Request !== 'undefined' && nextInput instanceof Request && (!nextInit || nextInit.body == null)) {
          const method = (nextInput.method || 'GET').toUpperCase();
          if (method !== 'GET' && method !== 'HEAD') {
            const bodyText = await nextInput.clone().text();
            if (bodyText && bodyText.indexOf('profiles') !== -1) {
              const parsed = originalParse(bodyText);
              if (NF.forceManifestRequest(parsed)) {
                nextInput = new Request(nextInput.url, {
                  method: nextInput.method,
                  headers: new Headers(nextInput.headers),
                  body: originalStringify(parsed),
                  credentials: nextInput.credentials,
                  mode: nextInput.mode,
                  cache: nextInput.cache,
                  redirect: nextInput.redirect,
                  referrer: nextInput.referrer,
                  integrity: nextInput.integrity
                });
                nfLog('mutated Request body', url.split('?')[0]);
              }
            }
          }
        }
      } catch (e) {
        nfLog('manifest mutate skipped', e && e.message ? e.message : e);
      }
    }

    const response = await originalFetch.call(ctx, nextInput, nextInit);
    if (NF.isManifestUrl(url) && response && typeof response.clone === 'function') {
      response.clone().text().then(function (text) {
        ingestManifestText(text, 'fetch');
      }).catch(function (e) {
        nfLog('manifest body read failed', e && e.message ? e.message : e);
      });
    }
    return response;
  }

  window.fetch = function (input, init) {
    try {
      const url = requestUrl(input);
      if (!NF.isManifestUrl(url)) return originalFetch.apply(this, arguments);
      return mutateAndFetch(this, input, init);
    } catch (e) {
      nfLog('fetch hook failed open', e && e.message ? e.message : e);
      return originalFetch.apply(this, arguments);
    }
  };

  XMLHttpRequest.prototype.open = function (method, url) {
    try { this.__nfjpUrl = typeof url === 'string' ? url : String(url || ''); } catch (e) { /* ignore */ }
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__nfjpUrl || '';
      if (NF.isManifestUrl(url)) {
        if (typeof body === 'string') {
          try {
            const parsed = originalParse(body);
            if (NF.forceManifestRequest(parsed)) {
              body = originalStringify(parsed);
              nfLog('mutated XHR manifest body', url.split('?')[0]);
            }
          } catch (e) {
            nfLog('XHR body mutate skipped', e && e.message ? e.message : e);
          }
        }
        this.addEventListener('load', function () {
          try {
            if (typeof this.response === 'object' && this.response && !(this.response instanceof Blob)) {
              const manifest = NF.pluckManifest(this.response);
              if (manifest) {
                onManifest(manifest, this.response, 'xhr');
                return;
              }
            }
            const text = typeof this.responseText === 'string' ? this.responseText : '';
            if (text) ingestManifestText(text, 'xhr');
          } catch (e) {
            nfLog('XHR manifest read failed', e && e.message ? e.message : e);
          }
        });
      }
    } catch (e) {
      nfLog('XHR hook failed', e && e.message ? e.message : e);
    }
    return originalSend.call(this, body);
  };

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function fetchViaExtension(url) {
    const requestId = ++fetchSeq;
    return new Promise(function (resolve, reject) {
      const timer = setTimeout(function () {
        window.removeEventListener('message', onMessage);
        reject(new Error('extension fetch timed out'));
      }, 20000);
      function onMessage(event) {
        if (event.source !== window) return;
        const data = event.data;
        if (!data || data.source !== 'NFJP-CS' || data.type !== 'FETCH_TEXT_RESULT' || data.requestId !== requestId) return;
        clearTimeout(timer);
        window.removeEventListener('message', onMessage);
        if (!data.ok) reject(new Error(data.error || ('HTTP ' + data.status)));
        else resolve(data.text || '');
      }
      window.addEventListener('message', onMessage);
      window.postMessage({ source: 'NFJP-PAGE', type: 'FETCH_TEXT', requestId: requestId, url: url }, '*');
    });
  }

  function byteLength(text) {
    try { return new TextEncoder().encode(text || '').length; } catch (e) { return (text || '').length; }
  }

  async function requestSubtitle(url) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(function () { controller.abort(); }, 8000) : null;
    try {
      const response = await originalFetch(url, {
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      const text = await response.text();
      return { ok: response.ok, status: response.status, text: response.ok ? text : '', bytes: byteLength(text) };
    } catch (e) {
      try {
        const text = await fetchViaExtension(url);
        return { ok: true, status: 200, text: text, bytes: byteLength(text) };
      } catch (extensionError) {
        const message = String(extensionError && extensionError.message ? extensionError.message : extensionError);
        const code = /HTTP (\d+)/.exec(message);
        return { ok: false, status: code ? Number(code[1]) : 0, text: '', bytes: 0 };
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function emptyPacket(track, label, error) {
    return {
      language: track && track.language || label,
      displayName: track && track.displayName || label,
      isForced: !!(track && track.isForced),
      isCC: !!(track && track.isCC),
      format: track && track.preferredFormat || null,
      fallback: false,
      cues: [],
      error: error
    };
  }

  async function downloadLanguage(gen, token, track, label) {
    const candidates = NF.textFormatsInOrder(track);
    if (!track || !candidates.length) return emptyPacket(track, label, label + ' missing');
    let lastError = label + ' parse failed';
    for (let i = 0; i < candidates.length; i++) {
      const fmt = candidates[i];
      for (let attempt = 0; attempt < 2; attempt++) {
        if (gen !== generation || token !== downloadToken) return null;
        if (attempt === 1) await sleep(2000);
        if (gen !== generation || token !== downloadToken) return null;
        nfLog('download start', label, NF.urlHost(fmt.url));
        const result = await requestSubtitle(fmt.url);
        nfLog('download status', result.status, 'bytes', result.bytes);
        if (!result.ok) {
          lastError = label + ' download ' + (result.status || 'failed');
          if (label === 'ja' || label === 'zh') post({ type: 'STATUS', videoId: activeId, status: lastError });
          continue;
        }
        let parsed = null;
        try {
          parsed = NF.parseSubtitleDocument(result.text, fmt.format);
        } catch (e) {
          parsed = { cues: [] };
        }
        nfLog('parsed', label, 'cues', parsed.cues ? parsed.cues.length : 0);
        const sample = parsed.cues && parsed.cues.find(function (cue) { return cue.ruby; });
        if (sample) nfLog('ruby sample', label, sample.ruby.slice(0, 120));
        if (parsed.cues && parsed.cues.length) {
          return {
            language: track.language,
            displayName: track.displayName,
            isForced: !!track.isForced,
            isCC: !!track.isCC,
            format: parsed.format,
            profile: fmt.format,
            fallback: false,
            cues: parsed.cues
          };
        }
        lastError = label + ' parse failed';
        if (label === 'ja' || label === 'zh') post({ type: 'STATUS', videoId: activeId, status: lastError });
      }
    }
    return emptyPacket(track, label, lastError);
  }

  function describe(track) {
    if (!track) return 'missing';
    return track.language + (track.isCC ? '/CC' : '') + (track.isForced ? '/forced' : '') + (track.downloadUrl ? ' url' : ' no-url');
  }

  async function forceTrackUrl(track) {
    const scan = NF.scanPlayer();
    if (!scan || !scan.player || !scan.player.setTimedTextTrack) {
      nfLog('cannot select track, player API missing', track && track.language);
      return;
    }
    const raw = NF.findPlayerTrack(scan.rawTracks, track);
    if (!raw) {
      nfLog('player list has no raw track for', track.language, track.trackId);
      return;
    }
    let previous = null;
    try { previous = scan.player.getTimedTextTrack ? scan.player.getTimedTextTrack() : null; } catch (e) { previous = null; }
    nfLog('selecting track to load url', track.language, raw.bcp47 || raw.language, raw.trackId);
    post({ type: 'STATUS', videoId: activeId, status: 'loading url for ' + track.language });
    try {
      await Promise.resolve(scan.player.setTimedTextTrack(raw));
    } catch (e) {
      nfLog('setTimedTextTrack failed', e && e.message ? e.message : e);
      return;
    }
    const watchAtStart = watchId();
    try {
      for (let i = 0; i < 20; i++) {
        if (watchId() !== watchAtStart) break;
        await sleep(250);
        const again = NF.scanPlayer();
        if (!again || !again.movieId || String(again.movieId) !== String(watchAtStart)) continue;
        rememberPlayer(String(again.movieId), again.tracks);
        const hit = NF.pickTargets(again.tracks);
        const japanese = NF.jaRank(track.language) >= 0;
        const candidate = track.isForced
          ? (japanese ? hit.jaForced : hit.zhForced)
          : (japanese ? hit.ja : hit.zh);
        if (candidate && candidate.downloadUrl && candidate.downloadUrl !== track.downloadUrl && !!candidate.isForced === !!track.isForced) {
          nfLog('url ready after select', candidate.language, candidate.preferredFormat, NF.urlHost(candidate.downloadUrl));
          break;
        }
      }
    } finally {
      if (previous && scan.player.setTimedTextTrack) {
        try {
          await Promise.resolve(scan.player.setTimedTextTrack(previous));
          nfLog('restored previous subtitle track');
        } catch (e) {
          nfLog('restore track failed', e && e.message ? e.message : e);
        }
      }
    }
  }

  function urlSignature(tracks) {
    const picked = NF.pickTargets(tracks || []);
    function sig(track) {
      if (!track || !track.downloadUrl) return '';
      return [track.language, track.isCC ? 'cc' : 'full', track.isForced ? 'f' : 'm', track.downloadUrl].join(':');
    }
    const value = sig(picked.ja) + '||' + sig(picked.zh);
    return value === '||' ? '' : value;
  }

  function rememberPlayer(movieId, tracks) {
    if (!movieId || !hasJaOrZh(tracks)) return false;
    const entry = ensure(movieId);
    const next = urlSignature(tracks);
    const prev = urlSignature(entry.playerTracks || []);
    if (entry.playerTracks && next === prev) return false;
    entry.playerTracks = tracks;
    entry.playerAt = Date.now();
    return true;
  }

  function freshPick(id) {
    const entry = manifests.get(String(id)) || { manifestAt: 0, playerAt: 0 };
    const fromPlayer = NF.pickTargets(entry.playerTracks || []);
    const fromManifest = NF.pickTargets(entry.manifestTracks || []);
    const playerNewer = (entry.playerAt || 0) >= (entry.manifestAt || 0);
    function choose(key) {
      const playerTrack = fromPlayer[key];
      const manifestTrack = fromManifest[key];
      if (playerTrack && playerTrack.downloadUrl && manifestTrack && manifestTrack.downloadUrl) {
        return playerNewer ? playerTrack : manifestTrack;
      }
      if (playerTrack && playerTrack.downloadUrl) return playerTrack;
      return manifestTrack;
    }
    return {
      ja: choose('ja'),
      zh: choose('zh'),
      jaForced: choose('jaForced'),
      zhForced: choose('zhForced')
    };
  }

  function cuesOf(packet) {
    return packet && packet.cues ? packet.cues.length : 0;
  }

  function outcomeStatus(ja, zh) {
    function side(label, packet) {
      if (packet && packet.error && !cuesOf(packet)) return packet.error;
      if (cuesOf(packet)) return label + ' cues ' + packet.cues.length;
      if (!packet) return label + ' missing';
      return label + ' parse failed';
    }
    return side('ja', ja) + ' · ' + side('zh', zh);
  }

  function stillCurrent(gen, token, id) {
    return gen === generation && token === downloadToken && String(id) === String(watchId() || '');
  }

  function keepParsed(prev, next) {
    if (!cuesOf(next) && cuesOf(prev)) return prev;
    return next;
  }

  async function runDownload(gen, id, started, token) {
    if (!stillCurrent(gen, token, id)) return;
    if (isFinal(id) && captureMode !== 'retry') return;
    const picked = freshPick(id);
    nfLog('download decision', 'url', id, 'ja', describe(picked.ja), 'zh', describe(picked.zh));
    post({ type: 'STATUS', videoId: id, status: 'downloading' });
    let ja = await downloadLanguage(gen, token, picked.ja, 'ja');
    if (!stillCurrent(gen, token, id)) return;
    let zh = await downloadLanguage(gen, token, picked.zh, 'zh');
    if (!stillCurrent(gen, token, id)) return;
    const jaBad = !cuesOf(ja);
    const zhBad = !cuesOf(zh);
    if (jaBad || zhBad) {
      const remain = 10000 - (Date.now() - started);
      if (remain > 0) {
        post({ type: 'STATUS', videoId: id, status: outcomeStatus(ja, zh) });
        await sleep(remain);
      }
      if (!stillCurrent(gen, token, id)) return;
      nfLog('still 0 cues after 10s, selecting tracks to refresh urls');
      post({ type: 'STATUS', videoId: id, status: 'reloading track urls' });
      if (jaBad && picked.ja && !picked.ja.isImage) await forceTrackUrl(picked.ja);
      if (!stillCurrent(gen, token, id)) return;
      if (zhBad && picked.zh && !picked.zh.isImage) await forceTrackUrl(picked.zh);
      if (!stillCurrent(gen, token, id)) return;
      const again = freshPick(id);
      if (jaBad) ja = await downloadLanguage(gen, token, again.ja, 'ja');
      if (!stillCurrent(gen, token, id)) return;
      if (zhBad) zh = await downloadLanguage(gen, token, again.zh, 'zh');
      if (!stillCurrent(gen, token, id)) return;
    }
    if (ja) ja.fallback = !!(ja.isCC || NF.jaRank(ja.language) > 0);
    if (zh) zh.fallback = !!(zh.isCC || NF.zhRank(zh.language) > 1);
    const prev = finals.get(String(id));
    if (prev) {
      ja = keepParsed(prev.ja, ja);
      zh = keepParsed(prev.zh, zh);
    }
    publishParsed(id, ja, zh, null, null);
    if (!stillCurrent(gen, token, id)) return;
    const finalPick = freshPick(id);
    const forced = await Promise.all([
      downloadLanguage(gen, token, finalPick.jaForced, 'ja-forced'),
      downloadLanguage(gen, token, finalPick.zhForced, 'zh-forced')
    ]);
    if (!stillCurrent(gen, token, id)) return;
    const saved = finals.get(String(id));
    const jaForced = keepParsed(saved && saved.jaForced, forced[0]);
    const zhForced = keepParsed(saved && saved.zhForced, forced[1]);
    if (cuesOf(jaForced) || cuesOf(zhForced)) publishParsed(id, ja, zh, jaForced, zhForced);
  }

  function publishParsed(id, ja, zh, jaForced, zhForced) {
    if (String(id) !== String(watchId() || '')) return;
    const both = cuesOf(ja) && cuesOf(zh);
    finals.set(String(id), {
      final: both,
      ja: ja,
      zh: zh,
      jaForced: cuesOf(jaForced) ? jaForced : null,
      zhForced: cuesOf(zhForced) ? zhForced : null
    });
    if (both) captureMode = 'skip';
    const status = outcomeStatus(ja, zh);
    const entry = manifests.get(String(id));
    post({
      type: 'PARSED',
      videoId: String(id),
      movieId: String(id),
      source: entry && entry.manifestTracks && entry.manifestTracks.length ? 'manifest' : 'player',
      cacheSource: 'network',
      capturedAt: new Date().toISOString(),
      tracks: tracksFor(id).map(NF.publicTrack),
      ja: ja,
      zh: zh,
      jaForced: cuesOf(jaForced) ? jaForced : null,
      zhForced: cuesOf(zhForced) ? zhForced : null,
      status: status
    });
    nfLog('capture done', id, status, both ? 'final' : 'partial');
    post({ type: 'STATUS', videoId: String(id), status: status });
  }

  function ensureDownload(id, startedAt, force) {
    if (String(id) !== String(watchId() || '')) return;
    if (isFinal(id) && captureMode !== 'retry') return;
    if (captureMode === 'skip' && !force) return;
    const picked = freshPick(id);
    const pickedSig = urlSignature([picked.ja, picked.zh, picked.jaForced, picked.zhForced].filter(Boolean));
    if (!force && !pickedSig) return;
    if (!force && flight && flight.id === String(id) && flight.signature === pickedSig) return;
    const gen = generation;
    const token = ++downloadToken;
    flight = { id: String(id), token: token, signature: pickedSig };
    runDownload(gen, id, startedAt || Date.now(), token).catch(function (err) {
      nfLog('capture error', err && err.stack ? err.stack : err);
      post({ type: 'STATUS', videoId: id, status: 'capture error' });
    });
  }

  async function runCapture(gen, id) {
    const started = Date.now();
    let lastSummary = '';
    nfLog('capture start', id);
    post({ type: 'STATUS', videoId: id, status: 'waiting for subtitles' });

    while (gen === generation && String(watchId() || '') === String(id) && Date.now() - started < 8000) {
      if (isFinal(id) || captureMode === 'skip') return;
      if (urlSignature(tracksFor(id))) break;
      let scan = null;
      try { scan = NF.scanPlayer(); } catch (e) {
        nfLog('scanPlayer failed', e && e.stack ? e.stack : e);
      }
      if (scan && scan.movieId && rememberPlayer(String(scan.movieId), scan.tracks)) {
        if (String(scan.movieId) === String(id)) {
          const summary = NF.summarizeTracks(scan.tracks);
          if (summary !== lastSummary) {
            lastSummary = summary;
            nfLog('tracks', summary);
            publishTracks(id);
          }
        }
      }
      if (urlSignature(tracksFor(id))) break;
      await sleep(300);
    }

    if (gen !== generation || String(watchId() || '') !== String(id)) {
      nfLog('capture cancelled', id);
      return;
    }
    if (isFinal(id) || captureMode === 'skip') return;
    if (flight && flight.id === String(id) && flight.token === downloadToken) return;
    ensureDownload(id, started, true);
  }

  function retryCapture(requestedId) {
    const id = watchId();
    if (!id) return;
    if (requestedId && String(requestedId) !== String(id)) {
      nfLog('retry ignored', 'url', id, 'request', requestedId);
      return;
    }
    captureMode = 'retry';
    downloadsOpen = true;
    finals.delete(String(id));
    flight = null;
    nfLog('retry capture', id);
    post({ type: 'STATUS', videoId: id, status: 'retrying capture' });
    ensureDownload(id, Date.now(), true);
  }

  function waitForCache(id) {
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        if (cacheWaiter && cacheWaiter.id === String(id)) cacheWaiter = null;
        resolve('timeout');
      }, 800);
      cacheWaiter = {
        id: String(id),
        resolve: function (kind) {
          clearTimeout(timer);
          if (cacheWaiter && cacheWaiter.id === String(id)) cacheWaiter = null;
          resolve(kind);
        }
      };
    });
  }

  function onCacheNotice(data) {
    const id = data.videoId != null ? String(data.videoId) : '';
    if (!id || id !== String(activeId || '')) {
      if (cacheWaiter && cacheWaiter.id === id) cacheWaiter.resolve('miss');
      return;
    }
    if (data.type === 'CACHED') {
      if (captureMode === 'retry') return;
      const prev = finals.get(id);
      if (prev) prev.final = true;
      else finals.set(id, { final: true });
      captureMode = 'skip';
      downloadToken++;
      flight = null;
      nfLog('cache hit, skip capture', id, 'ja', data.jaCues || 0, 'zh', data.zhCues || 0);
      if (cacheWaiter && cacheWaiter.id === id) cacheWaiter.resolve('hit');
      return;
    }
    if (cacheWaiter && cacheWaiter.id === id) cacheWaiter.resolve('miss');
  }

  function logClear(reason) {
    nfLog('state cleared', reason, new Error('state cleared: ' + reason).stack);
  }

  function republishFinal(id) {
    const saved = finals.get(String(id));
    if (!saved || !cuesOf(saved.ja) || !cuesOf(saved.zh)) return;
    publishParsed(id, saved.ja, saved.zh, saved.jaForced, saved.zhForced);
  }

  function startWatch(id) {
    const gen = ++generation;
    downloadToken++;
    const previousId = activeId;
    activeId = id;
    downloadsOpen = false;
    captureMode = 'auto';
    flight = null;
    lastPosted = {};
    if (previousId && previousId !== id) logClear('url ' + previousId + ' -> ' + id);
    nfLog('watch', id, 'generation', gen);
    if (isFinal(id)) {
      captureMode = 'skip';
      nfLog('memory final, skip capture', id);
      Promise.resolve().then(function () {
        if (generation === gen && watchId() === id) republishFinal(id);
      });
      return;
    }
    waitForCache(id).then(function (decision) {
      if (gen !== generation || watchId() !== id) return;
      if (captureMode === 'retry') return;
      if (decision === 'hit' || isFinal(id)) {
        captureMode = 'skip';
        nfLog('cache hit, skip capture', id);
        return;
      }
      downloadsOpen = true;
      if (manifests.has(String(id))) publishTracks(id);
      runCapture(gen, id).catch(function (e) {
        nfLog('capture error', e && e.stack ? e.stack : e);
        post({ type: 'STATUS', videoId: id, status: 'capture error' });
        post({ type: 'ERROR', videoId: id, error: String(e && e.message ? e.message : e) });
      });
    });
  }

  function checkLocation() {
    const id = watchId();
    if (id === activeId) return;
    if (!id) {
      if (activeId) {
        logClear('url ' + activeId + ' -> none');
        generation++;
        downloadToken++;
        downloadsOpen = false;
        captureMode = 'auto';
        flight = null;
        nfLog('left watch page', activeId);
        activeId = null;
        post({ type: 'STATUS', videoId: null, status: 'not on a watch page' });
      }
      return;
    }
    startWatch(id);
  }

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function () {
    const result = originalPushState.apply(this, arguments);
    checkLocation();
    return result;
  };
  history.replaceState = function () {
    const result = originalReplaceState.apply(this, arguments);
    checkLocation();
    return result;
  };
  window.addEventListener('popstate', checkLocation);
  setInterval(checkLocation, 1000);

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'NFJP-CS') return;
    if (data.type === 'SEEK') {
      seekSeconds(data.seconds);
      return;
    }
    if (data.type === 'CACHED' || data.type === 'CACHE_MISS') {
      onCacheNotice(data);
      return;
    }
    if (data.type === 'RETRY') {
      retryCapture(data.videoId);
      return;
    }
    if (data.type !== 'HELLO') return;
    if (cacheWaiter || captureMode === 'skip') return;
    const types = Object.keys(lastPosted);
    if (!types.length) {
      post({ type: 'STATUS', videoId: activeId, status: activeId ? 'waiting for subtitles' : 'not on a watch page' });
      return;
    }
    for (let i = 0; i < types.length; i++) window.postMessage(lastPosted[types[i]], '*');
  });

  function seekSeconds(seconds) {
    const time = Number(seconds);
    if (!Number.isFinite(time)) return;
    try {
      const scan = NF.scanPlayer();
      if (scan && scan.player && scan.player.seek) {
        scan.player.seek(Math.round(time * 1000));
        nfLog('seek', time);
        return;
      }
    } catch (e) {
      nfLog('player seek failed', e && e.message ? e.message : e);
    }
    const videos = document.getElementsByTagName('video');
    let best = null;
    let area = 0;
    for (let i = 0; i < videos.length; i++) {
      const rect = videos[i].getBoundingClientRect();
      const size = rect.width * rect.height;
      if (size > area) {
        area = size;
        best = videos[i];
      }
    }
    if (best) {
      best.currentTime = time;
      nfLog('seek via video element', time);
    }
  }

  nfLog('hooks installed (JSON.parse, JSON.stringify, fetch, XHR) and player scan ready');
  checkLocation();
})();
