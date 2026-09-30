/*
 * Isolated-world bridge: Netflix page -> overlay + IndexedDB.
 * Parsed cues are stored per video id and language. A full ja+zh capture is
 * reused on the next visit, and the page skips downloading it again.
 * Also fetches subtitle files when the page itself is blocked by CORS.
 */
(function () {
  'use strict';

  const settingDefaults = {
    enabled: true,
    showJa: true,
    showZh: true,
    furigana: true,
    debug: false,
    nudge: 0,
    fontScale: 1,
    followNetflix: false,
    shade: false,
    shadeOpacity: 0.5
  };

  let videoId = null;
  let payload = null;
  let statusText = 'starting';
  let settings = Object.assign({}, settingDefaults);
  let cacheSource = '';
  let lastClear = null;
  let blockNetwork = false;
  let watchGen = 0;
  let dbPromise = null;

  function nfLog() {
    const args = ['[NFJP]'];
    for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  function watchIdFrom(url) {
    const match = String(url || '').match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
  }

  function cueCount(packet) {
    return packet && packet.cues ? packet.cues.length : 0;
  }

  function statusFrom(ja, zh) {
    function side(label, packet) {
      if (packet && packet.error && !cueCount(packet)) return packet.error;
      if (cueCount(packet)) return label + ' cues ' + packet.cues.length;
      if (!packet) return label + ' missing';
      return label + ' parse failed';
    }
    return side('ja', ja) + ' · ' + side('zh', zh);
  }

  function logClear(reason) {
    lastClear = { at: new Date().toISOString(), reason: reason };
    nfLog('state cleared', reason, new Error('state cleared: ' + reason).stack);
  }

  function viewState() {
    const base = payload && videoId && String(payload.videoId) === String(videoId)
      ? payload
      : { videoId: videoId, movieId: null, source: null, capturedAt: null, tracks: [], ja: null, zh: null, jaForced: null, zhForced: null };
    return {
      videoId: base.videoId || videoId,
      movieId: base.movieId || null,
      source: base.source || null,
      cacheSource: cacheSource || '',
      capturedAt: base.capturedAt || null,
      tracks: base.tracks || [],
      ja: base.ja || null,
      zh: base.zh || null,
      jaForced: base.jaForced || null,
      zhForced: base.zhForced || null,
      clearedAt: lastClear ? lastClear.at : '',
      clearedReason: lastClear ? lastClear.reason : ''
    };
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!globalThis.indexedDB) {
        dbPromise = null;
        reject(new Error('indexedDB unavailable'));
        return;
      }
      const request = indexedDB.open('nfjp', 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains('cues')) request.result.createObjectStore('cues');
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () {
        dbPromise = null;
        reject(request.error || new Error('indexedDB open failed'));
      };
    });
    return dbPromise;
  }

  function cueKey(id, language) {
    return String(id) + ':' + language;
  }

  function loadFinal(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction('cues', 'readonly');
        const store = tx.objectStore('cues');
        const names = ['ja', 'zh', 'ja-forced', 'zh-forced', 'meta'];
        const out = {};
        let pending = names.length;
        names.forEach(function (name) {
          const request = store.get(cueKey(id, name));
          request.onsuccess = function () {
            out[name] = request.result || null;
            pending--;
            if (pending === 0) resolve(out);
          };
          request.onerror = function () { reject(request.error); };
        });
        tx.onerror = function () { reject(tx.error); };
      });
    }).then(function (out) {
      if (!cueCount(out.ja) || !cueCount(out.zh)) return null;
      const meta = out.meta || {};
      return {
        videoId: String(id),
        movieId: meta.movieId || null,
        source: 'cache',
        cacheSource: 'cache',
        capturedAt: meta.capturedAt || null,
        tracks: meta.tracks || [],
        ja: out.ja,
        zh: out.zh,
        jaForced: cueCount(out['ja-forced']) ? out['ja-forced'] : null,
        zhForced: cueCount(out['zh-forced']) ? out['zh-forced'] : null,
        status: meta.status || statusFrom(out.ja, out.zh)
      };
    });
  }

  function saveFinal(next) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction('cues', 'readwrite');
        const store = tx.objectStore('cues');
        const id = String(next.videoId);
        store.put(next.ja, cueKey(id, 'ja'));
        store.put(next.zh, cueKey(id, 'zh'));
        store.put(next.jaForced || null, cueKey(id, 'ja-forced'));
        store.put(next.zhForced || null, cueKey(id, 'zh-forced'));
        store.put({
          videoId: id,
          movieId: next.movieId || null,
          tracks: next.tracks || [],
          capturedAt: next.capturedAt || new Date().toISOString(),
          status: statusFrom(next.ja, next.zh)
        }, cueKey(id, 'meta'));
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('indexedDB abort')); };
      });
    });
  }

  function deleteFinal(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction('cues', 'readwrite');
        const store = tx.objectStore('cues');
        ['ja', 'zh', 'ja-forced', 'zh-forced', 'meta'].forEach(function (language) {
          store.delete(cueKey(id, language));
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('indexedDB abort')); };
      });
    });
  }

  function cueTexts(packet) {
    const cues = packet && packet.cues;
    if (!cues) return [];
    const lines = [];
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].text && !cues[i].ruby) lines.push(cues[i].text);
    }
    return lines;
  }

  function publishPayload() {
    if (globalThis.NFJPSubs) NFJPSubs.setPayload(payload && videoId && String(payload.videoId) === String(videoId) ? payload : null);
    if (globalThis.NFJPFurigana) {
      NFJPFurigana.setVideo(payload && payload.videoId);
      if (settings.furigana && payload) {
        NFJPFurigana.prepare(cueTexts(payload.ja).concat(cueTexts(payload.jaForced)));
      }
    }
    refreshChrome();
  }

  function refreshChrome() {
    const overlay = globalThis.NFJPOverlay;
    if (!overlay) return;
    const onWatch = !!videoId;
    overlay.setVisible(onWatch && !!settings.debug);
    overlay.setStatus(statusText || '');
    overlay.setState(onWatch ? viewState() : null);
  }

  async function onLocation() {
    const id = watchIdFrom(location.href);
    if (id === videoId) return;
    const previousId = videoId;
    const gen = ++watchGen;
    videoId = id;
    blockNetwork = false;
    if (previousId && previousId !== id) logClear('url ' + previousId + ' -> ' + (id || 'none'));
    if (payload && String(payload.videoId) !== String(id || '')) payload = null;
    cacheSource = payload && cueCount(payload.ja) && cueCount(payload.zh) ? (cacheSource || 'network') : '';
    if (!id) {
      statusText = 'not on a watch page';
      nfLog('content: left watch page');
      refreshChrome();
      return;
    }
    if (!(payload && String(payload.videoId) === String(id) && (cueCount(payload.ja) || cueCount(payload.zh)))) {
      statusText = 'waiting for subtitles';
    }
    nfLog('content: watch', id);
    refreshChrome();
    let cached = null;
    try {
      cached = await loadFinal(id);
    } catch (e) {
      nfLog('content: cache read failed', e && e.message ? e.message : e);
    }
    if (gen !== watchGen || watchIdFrom(location.href) !== id) return;
    if (cached) {
      cacheSource = 'cache';
      blockNetwork = true;
      payload = cached;
      statusText = cached.status || statusFrom(cached.ja, cached.zh);
      publishPayload();
      nfLog('content: cache hit', id, statusText);
      window.postMessage({
        source: 'NFJP-CS',
        type: 'CACHED',
        videoId: id,
        jaCues: cueCount(cached.ja),
        zhCues: cueCount(cached.zh)
      }, '*');
      return;
    }
    window.postMessage({ source: 'NFJP-CS', type: 'CACHE_MISS', videoId: id }, '*');
  }

  async function fetchForPage(url) {
    if (typeof url !== 'string' || url.indexOf('https://') !== 0) {
      return { ok: false, error: 'refusing non-https url' };
    }
    try {
      const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
      const text = await response.text();
      if (!response.ok) return { ok: false, status: response.status, error: 'HTTP ' + response.status, text: text.slice(0, 180) };
      return { ok: true, status: response.status, text: text };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  }

  function exportJson() {
    if (!payload) {
      nfLog('content: nothing to export');
      return;
    }
    const body = JSON.stringify(payload, null, 2);
    const blob = new Blob([body], { type: 'application/json' });
    const link = document.createElement('a');
    const href = URL.createObjectURL(blob);
    link.href = href;
    link.download = 'nfjp-' + (payload.videoId || 'subtitles') + '.json';
    document.documentElement.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(href); }, 2000);
    nfLog('content: exported', link.download, body.length);
  }

  globalThis.NFJPOnExport = exportJson;

  globalThis.NFJPOnRetry = function () {
    if (!videoId) return;
    const id = videoId;
    watchGen++;
    blockNetwork = false;
    statusText = 'retrying capture';
    refreshChrome();
    nfLog('content: retry capture', id);
    deleteFinal(id).catch(function (e) {
      nfLog('content: cache delete failed', e && e.message ? e.message : e);
    });
    window.postMessage({ source: 'NFJP-CS', type: 'RETRY', videoId: id }, '*');
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'NFJP-PAGE') return;
    if (data.type === 'FETCH_TEXT') return;

    if (data.videoId && videoId && String(data.videoId) !== String(videoId)) {
      nfLog('content: ignore stale message', data.type, data.videoId);
      return;
    }

    if (data.type === 'STATUS') {
      const settled = cueCount(payload && payload.ja) && cueCount(payload && payload.zh);
      if (settled && (blockNetwork || /missing|parse failed/.test(data.status || ''))) {
        nfLog('content: ignore status, cues already parsed', data.status);
        return;
      }
      statusText = data.status || '';
      nfLog('content: status', statusText);
      refreshChrome();
      return;
    }

    if (data.type === 'TRACKS') {
      if (blockNetwork && cueCount(payload && payload.ja) && cueCount(payload && payload.zh)) {
        nfLog('content: ignore tracks, cache is final', (data.tracks || []).length);
        return;
      }
      const previous = payload && String(payload.videoId) === String(data.videoId) ? payload : null;
      function keepParsed(prevSide, meta) {
        if (prevSide && prevSide.cues && prevSide.cues.length) return prevSide;
        if (!meta) return prevSide || null;
        const next = {};
        const keys = Object.keys(meta);
        for (let i = 0; i < keys.length; i++) next[keys[i]] = meta[keys[i]];
        next.cues = prevSide && prevSide.cues ? prevSide.cues : [];
        return next;
      }
      const incomingTracks = data.tracks || [];
      payload = {
        videoId: data.videoId,
        movieId: data.movieId || (previous && previous.movieId) || null,
        source: previous && previous.source || null,
        cacheSource: cacheSource,
        capturedAt: previous && previous.capturedAt || null,
        tracks: incomingTracks.length ? incomingTracks : (previous && previous.tracks) || [],
        ja: keepParsed(previous && previous.ja, data.ja),
        zh: keepParsed(previous && previous.zh, data.zh),
        jaForced: keepParsed(previous && previous.jaForced, data.jaForced),
        zhForced: keepParsed(previous && previous.zhForced, data.zhForced)
      };
      publishPayload();
      nfLog('content: track list', (payload.tracks || []).length);
      return;
    }

    if (data.type === 'PARSED') {
      const haveFinal = blockNetwork && cueCount(payload && payload.ja) && cueCount(payload && payload.zh);
      const addsForced = (cueCount(data.jaForced) && !cueCount(payload && payload.jaForced))
        || (cueCount(data.zhForced) && !cueCount(payload && payload.zhForced));
      if (haveFinal && !addsForced) {
        nfLog('content: ignore parsed, cached cues are final', data.videoId);
        return;
      }
      const previous = payload && String(payload.videoId) === String(data.videoId) ? payload : null;
      function keepSide(prevSide, nextSide) {
        if (cueCount(nextSide)) return nextSide;
        if (cueCount(prevSide)) return prevSide;
        return nextSide || prevSide || null;
      }
      const next = {
        videoId: data.videoId,
        movieId: data.movieId || (previous && previous.movieId) || null,
        source: data.source || (previous && previous.source) || null,
        capturedAt: data.capturedAt || new Date().toISOString(),
        tracks: (data.tracks && data.tracks.length) ? data.tracks : (previous && previous.tracks) || [],
        ja: keepSide(previous && previous.ja, data.ja || null),
        zh: keepSide(previous && previous.zh, data.zh || null),
        jaForced: keepSide(previous && previous.jaForced, data.jaForced || null),
        zhForced: keepSide(previous && previous.zhForced, data.zhForced || null)
      };
      if (cueCount(data.ja) && cueCount(data.zh)) cacheSource = data.cacheSource || 'network';
      else if (!cacheSource && (cueCount(next.ja) || cueCount(next.zh))) cacheSource = data.cacheSource || 'network';
      if (cueCount(next.ja) && cueCount(next.zh)) blockNetwork = true;
      payload = next;
      statusText = statusFrom(next.ja, next.zh);
      nfLog('content: parsed', payload.videoId, statusText, 'source', cacheSource || payload.source);
      publishPayload();
      if (cueCount(next.ja) && cueCount(next.zh)) {
        saveFinal(next).then(function () {
          nfLog('content: cached', next.videoId, 'ja', cueCount(next.ja), 'zh', cueCount(next.zh));
        }).catch(function (e) {
          nfLog('content: cache write failed', e && e.message ? e.message : e);
        });
      }
      return;
    }

    if (data.type === 'ERROR') {
      statusText = data.error || 'error';
      nfLog('content: error', statusText);
      refreshChrome();
    }
  });

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'NFJP-PAGE' || data.type !== 'FETCH_TEXT') return;
    fetchForPage(data.url).then(function (result) {
      nfLog('content: fetch fallback', result.ok ? 'ok' : result.error, data.url ? data.url.split('?')[0].slice(0, 120) : '');
      window.postMessage({
        source: 'NFJP-CS',
        type: 'FETCH_TEXT_RESULT',
        requestId: data.requestId,
        ok: result.ok,
        status: result.status || 0,
        error: result.error || '',
        text: result.ok ? result.text : ''
      }, '*');
    });
  });

  let settingsJson = '';

  function applySettings(next) {
    const merged = Object.assign({}, settingDefaults, next || {});
    const json = JSON.stringify(merged);
    if (json === settingsJson) return;
    settingsJson = json;
    settings = merged;
    if (globalThis.NFJPSubs) NFJPSubs.setSettings(settings);
    if (settings.furigana && payload && globalThis.NFJPFurigana) {
      NFJPFurigana.prepare(cueTexts(payload.ja).concat(cueTexts(payload.jaForced)));
    }
    refreshChrome();
    nfLog('content: settings', settings.enabled ? 'on' : 'off', 'ja', settings.showJa, 'zh', settings.showZh, 'furigana', settings.furigana, 'debug', settings.debug, 'shade', !!settings.shade, 'follow', !!settings.followNetflix);
  }

  function saveSettings() {
    chrome.storage.local.set({ nfjpSettings: settings });
  }

  function timeline() {
    if (settings.showJa && payload && payload.ja && payload.ja.cues && payload.ja.cues.length) return payload.ja.cues;
    if (settings.showZh && payload && payload.zh && payload.zh.cues && payload.zh.cues.length) return payload.zh.cues;
    return [];
  }

  function seekTo(seconds) {
    nfLog('content: seek', seconds);
    window.postMessage({ source: 'NFJP-CS', type: 'SEEK', seconds: seconds }, '*');
  }

  function replayLine() {
    const video = globalThis.NFJPSubs && NFJPSubs.findVideo();
    const cues = timeline();
    if (!video || !cues.length) return;
    const time = video.currentTime;
    let cue = null;
    for (let i = 0; i < cues.length; i++) {
      if (time >= cues[i].start && time < cues[i].end) cue = cues[i];
      else if (cues[i].start <= time) cue = cues[i];
    }
    if (cue) seekTo(cue.start + 0.01);
  }

  function jumpLine(direction) {
    const video = globalThis.NFJPSubs && NFJPSubs.findVideo();
    const cues = timeline();
    if (!video || !cues.length) return;
    const time = video.currentTime;
    if (direction < 0) {
      let index = -1;
      for (let i = 0; i < cues.length; i++) {
        if (cues[i].start <= time + 0.05) index = i;
        else break;
      }
      const target = index <= 0 ? cues[0] : cues[index - 1];
      seekTo(target.start + 0.01);
      return;
    }
    for (let i = 0; i < cues.length; i++) {
      if (cues[i].start > time + 0.05) {
        seekTo(cues[i].start + 0.01);
        return;
      }
    }
  }

  function typingTarget(event) {
    const target = event.target;
    if (!target) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  document.addEventListener('keydown', function (event) {
    if (typingTarget(event)) return;
    if (!videoId) return;
    const alt = event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    if (alt && (event.code === 'KeyD' || event.code === 'KeyF' || event.code === 'KeyJ' || event.code === 'KeyC' || event.code === 'KeyS' || event.code === 'KeyB' || event.code === 'ArrowUp' || event.code === 'ArrowDown')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'KeyD') settings.debug = !settings.debug;
      else if (event.code === 'KeyF') settings.furigana = !settings.furigana;
      else if (event.code === 'KeyJ') settings.showJa = !settings.showJa;
      else if (event.code === 'KeyC') settings.showZh = !settings.showZh;
      else if (event.code === 'KeyS') settings.enabled = !settings.enabled;
      else if (event.code === 'KeyB') settings.shade = !settings.shade;
      else if (event.code === 'ArrowUp') settings.nudge = Math.min(0.2, (Number(settings.nudge) || 0) + 0.02);
      else settings.nudge = Math.max(-0.06, (Number(settings.nudge) || 0) - 0.02);
      saveSettings();
      applySettings(settings);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.repeat) return;
    if (event.code !== 'KeyA' && event.code !== 'KeyQ' && event.code !== 'KeyE') return;
    if (!settings.enabled) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'KeyA') replayLine();
    else if (event.code === 'KeyQ') jumpLine(-1);
    else jumpLine(1);
  }, true);

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.nfjpSettings) return;
    applySettings(changes.nfjpSettings.newValue || {});
  });

  chrome.storage.local.get('nfjpSettings', function (data) {
    applySettings((data && data.nfjpSettings) || {});
  });

  function frame() {
    try {
      if (globalThis.NFJPSubs) NFJPSubs.tick();
    } catch (err) {
      nfLog('content: subtitle tick', err && err.message ? err.message : err);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  setInterval(function () {
    const overlay = globalThis.NFJPOverlay;
    if (!overlay || !videoId || !settings.debug) return;
    const video = overlay.findVideo();
    overlay.sync(video ? video.currentTime : null, video);
  }, 200);

  let hellos = 0;
  const helloTimer = setInterval(function () {
    hellos++;
    window.postMessage({ source: 'NFJP-CS', type: 'HELLO' }, '*');
    if (hellos >= 8) clearInterval(helloTimer);
  }, 1000);
  window.postMessage({ source: 'NFJP-CS', type: 'HELLO' }, '*');

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function () {
    const result = originalPushState.apply(this, arguments);
    onLocation();
    return result;
  };
  history.replaceState = function () {
    const result = originalReplaceState.apply(this, arguments);
    onLocation();
    return result;
  };
  setInterval(onLocation, 1000);
  window.addEventListener('popstate', onLocation);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onLocation);
  }
  onLocation();
  nfLog('content: listening');
})();
