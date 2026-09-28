/*
 * Page-context capture. Hooks are installed at document_start.
 * Manifest responses are preferred. If a target language has no text URL,
 * the active player track is selected just long enough for Netflix to fill
 * one, then the previous track is restored.
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

  const store = {
    videoId: null,
    lockedMovieId: null,
    buckets: { manifest: [], player: [] }
  };

  let generation = 0;
  let activeId = null;
  let previousMovieId = null;
  let pendingManifest = null;
  let lastPosted = {};
  let fetchSeq = 0;
  let lastUrlSignature = '';
  let downloadToken = 0;
  let downloadStartedFor = -1;

  function watchId() {
    const match = location.pathname.match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
  }

  function post(message) {
    message.source = 'NFJP-PAGE';
    if (message.type) lastPosted[message.type] = message;
    window.postMessage(message, '*');
  }

  function mergedTracks() {
    // A manifest for this episode is the only URL source. Player-session URLs
    // from the previous title must not be merged in; they are already expired.
    if (store.buckets.manifest.length) return store.buckets.manifest.slice();
    return store.buckets.player.slice();
  }

  function isStaleMovie(movieId) {
    if (!movieId || !previousMovieId) return false;
    return movieId === previousMovieId && movieId !== activeId;
  }

  function manifestMatchesPlayback(movieId) {
    if (!movieId) return true;
    if (isStaleMovie(movieId)) return false;
    if (movieId === activeId) return true;
    const playerMovie = NF.peekMovieId();
    if (playerMovie && movieId === playerMovie && !isStaleMovie(playerMovie)) return true;
    if (!playerMovie) return true;
    return false;
  }

  function onManifest(manifest, via) {
    try {
      const id = watchId();
      const movieId = manifest && manifest.movieId != null ? String(manifest.movieId) : '';
      const count = manifest && (manifest.timedtexttracks || manifest.textTracks || []).length;
      nfLog('manifest via', via, 'movieId', movieId || '?', 'watch', id || 'none', 'raw tracks', count || 0);
      if (!id || id !== activeId || store.videoId !== id) return;
      if (movieId && isStaleMovie(movieId)) {
        nfLog('drop previous episode manifest', movieId);
        return;
      }
      if (movieId && !manifestMatchesPlayback(movieId)) {
        pendingManifest = manifest;
        nfLog('hold manifest until it matches this playback', movieId, 'player', NF.peekMovieId());
        return;
      }
      if (movieId) store.lockedMovieId = movieId;
      const tracks = NF.extractNetflixTracks(manifest);
      nfLog('manifest normalized', tracks.length, NF.summarizeTracks(tracks));
      store.buckets.manifest = tracks;
      store.buckets.player = [];
      publishTracks();
      const signature = urlSignature(tracks);
      if (signature && signature !== lastUrlSignature) {
        lastUrlSignature = signature;
        nfLog('new manifest urls, downloading', activeId);
        const gen = generation;
        const id = activeId;
        downloadStartedFor = gen;
        const token = ++downloadToken;
        runDownload(gen, id, Date.now(), token).catch(function (err) {
          nfLog('capture error', err && err.stack ? err.stack : err);
          post({ type: 'STATUS', videoId: id, status: 'capture error' });
        });
      }
    } catch (e) {
      nfLog('manifest handler failed', e && e.stack ? e.stack : e);
    }
  }

  function applyPendingManifest() {
    if (!pendingManifest) return;
    const movieId = pendingManifest.movieId != null ? String(pendingManifest.movieId) : '';
    if (movieId && isStaleMovie(movieId)) {
      pendingManifest = null;
      return;
    }
    if (movieId && !manifestMatchesPlayback(movieId)) return;
    const manifest = pendingManifest;
    pendingManifest = null;
    onManifest(manifest, 'held');
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
    if (manifest) onManifest(manifest, via);
    else nfLog(via, 'timedtexttracks string was not a manifest object');
  }

  function publishTracks() {
    if (!activeId) return;
    const tracks = mergedTracks();
    const picked = NF.pickTargets(tracks);
    post({
      type: 'TRACKS',
      videoId: activeId,
      movieId: store.lockedMovieId || NF.peekMovieId(),
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
      if (manifest) onManifest(manifest, 'JSON.parse');
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
                onManifest(manifest, 'xhr');
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
    const watchAtStart = activeId;
    try {
      for (let i = 0; i < 20; i++) {
        if (activeId !== watchAtStart) break;
        await sleep(250);
        const again = NF.scanPlayer();
        if (!again || isStaleMovie(again.movieId)) continue;
        store.buckets.player = again.tracks;
        if (again.movieId && !isStaleMovie(again.movieId)) store.lockedMovieId = again.movieId;
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
    return sig(picked.ja) + '||' + sig(picked.zh);
  }

  function freshPick() {
    const fromPlayer = NF.pickTargets(store.buckets.player);
    const fromManifest = NF.pickTargets(store.buckets.manifest);
    function choose(key) {
      const playerTrack = fromPlayer[key];
      if (playerTrack && playerTrack.downloadUrl) return playerTrack;
      return fromManifest[key];
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

  async function runDownload(gen, id, started, token) {
    if (gen !== generation || token !== downloadToken) return;
    const picked = NF.pickTargets(mergedTracks());
    nfLog('download decision', 'ja', describe(picked.ja), 'zh', describe(picked.zh));
    post({ type: 'STATUS', videoId: id, status: 'downloading' });
    let ja = await downloadLanguage(gen, token, picked.ja, 'ja');
    if (gen !== generation || token !== downloadToken) return;
    let zh = await downloadLanguage(gen, token, picked.zh, 'zh');
    if (gen !== generation || token !== downloadToken) return;
    const jaBad = !cuesOf(ja);
    const zhBad = !cuesOf(zh);
    if (jaBad || zhBad) {
      const remain = 10000 - (Date.now() - started);
      if (remain > 0) {
        post({ type: 'STATUS', videoId: id, status: outcomeStatus(ja, zh) });
        await sleep(remain);
      }
      if (gen !== generation || token !== downloadToken) return;
      nfLog('still 0 cues after 10s, selecting tracks to refresh urls');
      post({ type: 'STATUS', videoId: id, status: 'reloading track urls' });
      if (jaBad && picked.ja && !picked.ja.isImage) await forceTrackUrl(picked.ja);
      if (gen !== generation || token !== downloadToken) return;
      if (zhBad && picked.zh && !picked.zh.isImage) await forceTrackUrl(picked.zh);
      if (gen !== generation || token !== downloadToken) return;
      const again = freshPick();
      if (jaBad) ja = await downloadLanguage(gen, token, again.ja, 'ja');
      if (gen !== generation || token !== downloadToken) return;
      if (zhBad) zh = await downloadLanguage(gen, token, again.zh, 'zh');
      if (gen !== generation || token !== downloadToken) return;
    }
    if (ja) ja.fallback = !!(ja.isCC || NF.jaRank(ja.language) > 0);
    if (zh) zh.fallback = !!(zh.isCC || NF.zhRank(zh.language) > 1);
    publishParsed(id, ja, zh, null, null);
    const finalPick = freshPick();
    const forced = await Promise.all([
      downloadLanguage(gen, token, finalPick.jaForced, 'ja-forced'),
      downloadLanguage(gen, token, finalPick.zhForced, 'zh-forced')
    ]);
    if (gen !== generation || token !== downloadToken) return;
    if (cuesOf(forced[0]) || cuesOf(forced[1])) publishParsed(id, ja, zh, forced[0], forced[1]);
  }

  function publishParsed(id, ja, zh, jaForced, zhForced) {
    const status = outcomeStatus(ja, zh);
    post({
      type: 'PARSED',
      videoId: id,
      movieId: store.lockedMovieId || NF.peekMovieId(),
      source: store.buckets.manifest.length ? 'manifest' : 'player',
      capturedAt: new Date().toISOString(),
      tracks: mergedTracks().map(NF.publicTrack),
      ja: ja,
      zh: zh,
      jaForced: cuesOf(jaForced) ? jaForced : null,
      zhForced: cuesOf(zhForced) ? zhForced : null,
      status: status
    });
    nfLog('capture done', id, status);
    post({ type: 'STATUS', videoId: id, status: status });
  }

  async function runCapture(gen, id) {
    const started = Date.now();
    let lastSummary = '';
    let loggedStale = false;
    nfLog('capture start', id);
    post({ type: 'STATUS', videoId: id, status: 'waiting for subtitles' });

    while (gen === generation && Date.now() - started < 8000 && !store.buckets.manifest.length) {
      applyPendingManifest();
      if (store.buckets.manifest.length) break;
      let scan = null;
      try { scan = NF.scanPlayer(); } catch (e) {
        nfLog('scanPlayer failed', e && e.stack ? e.stack : e);
      }
      if (scan && isStaleMovie(scan.movieId)) {
        if (!loggedStale) {
          loggedStale = true;
          nfLog('player still on previous movie', scan.movieId);
        }
      } else if (scan && scan.movieId && scan.movieId !== previousMovieId) {
        store.buckets.player = scan.tracks;
        if (!store.lockedMovieId) store.lockedMovieId = scan.movieId;
        const summary = NF.summarizeTracks(scan.tracks);
        if (summary !== lastSummary) {
          lastSummary = summary;
          nfLog('tracks', summary);
          publishTracks();
        }
        if (urlSignature(scan.tracks)) break;
      }
      await sleep(300);
    }

    if (gen !== generation) {
      nfLog('capture cancelled', id);
      return;
    }
    if (downloadStartedFor === gen) return;
    downloadStartedFor = gen;
    const token = ++downloadToken;
    await runDownload(gen, id, started, token);
  }

  function retryCapture() {
    if (!activeId) return;
    const id = activeId;
    generation++;
    const gen = generation;
    downloadStartedFor = gen;
    store.buckets.player = [];
    nfLog('retry capture', id);
    post({ type: 'STATUS', videoId: id, status: 'retrying capture' });
    const token = ++downloadToken;
    runDownload(gen, id, Date.now(), token).catch(function (err) {
      nfLog('capture error', err && err.stack ? err.stack : err);
      post({ type: 'STATUS', videoId: id, status: 'capture error' });
    });
  }

  function startWatch(id) {
    const gen = ++generation;
    previousMovieId = store.lockedMovieId;
    activeId = id;
    store.videoId = id;
    store.lockedMovieId = null;
    store.buckets = { manifest: [], player: [] };
    pendingManifest = null;
    lastPosted = {};
    lastUrlSignature = '';
    downloadStartedFor = -1;
    nfLog('watch', id, 'generation', gen);
    runCapture(gen, id).catch(function (e) {
      nfLog('capture error', e && e.stack ? e.stack : e);
      post({ type: 'STATUS', videoId: id, status: 'capture error' });
      post({ type: 'ERROR', videoId: id, error: String(e && e.message ? e.message : e) });
    });
  }

  function checkLocation() {
    const id = watchId();
    if (id === activeId) return;
    if (!id) {
      if (activeId) nfLog('left watch page');
      activeId = null;
      generation++;
      post({ type: 'STATUS', videoId: null, status: 'not on a watch page' });
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
  setInterval(checkLocation, 500);

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'NFJP-CS') return;
    if (data.type === 'SEEK') {
      seekSeconds(data.seconds);
      return;
    }
    if (data.type === 'RETRY') {
      retryCapture();
      return;
    }
    if (data.type !== 'HELLO') return;
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
