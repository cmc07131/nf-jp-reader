/*
 * Isolated-world bridge: Netflix page -> overlay + chrome.storage.session.
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
    fontScale: 1
  };

  let videoId = null;
  let payload = null;
  let statusText = 'starting';
  let settings = Object.assign({}, settingDefaults);

  function nfLog() {
    const args = ['[NFJP]'];
    for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  function watchIdFrom(url) {
    const match = String(url || '').match(/\/watch\/(\d+)/);
    return match ? match[1] : null;
  }

  function storageKey(id) {
    return 'nfjp:' + id;
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
    if (globalThis.NFJPSubs) NFJPSubs.setPayload(payload);
    if (globalThis.NFJPFurigana) {
      NFJPFurigana.setVideo(payload && payload.videoId);
      if (settings.furigana && payload) {
        NFJPFurigana.prepare(cueTexts(payload.ja).concat(cueTexts(payload.jaForced)));
      }
    }
    if (globalThis.NFJPOverlay) {
      NFJPOverlay.setState(payload);
      NFJPOverlay.setStatus(statusText || '');
    }
  }

  function applyPayload(next, fromCache) {
    payload = next;
    if (fromCache) statusText = 'cached · ' + (statusText || 'captured');
    publishPayload();
  }

  async function savePayload(next) {
    payload = next;
    if (!next || !next.videoId || !chrome.storage || !chrome.storage.session) {
      nfLog('content: session storage unavailable');
      return;
    }
    try {
      const stored = {};
      stored[storageKey(next.videoId)] = next;
      await chrome.storage.session.set(stored);
      nfLog('content: cached', next.videoId, 'ja', next.ja && next.ja.cues ? next.ja.cues.length : 0, 'zh', next.zh && next.zh.cues ? next.zh.cues.length : 0);
    } catch (e) {
      nfLog('content: cache write failed', e && e.message ? e.message : e);
    }
  }

  async function restore(id) {
    if (!chrome.storage || !chrome.storage.session) return;
    try {
      const data = await chrome.storage.session.get(storageKey(id));
      const cached = data[storageKey(id)];
      if (!cached || String(cached.videoId) !== String(id)) return;
      if (payload && payload.videoId === id && payload.capturedAt && cached.capturedAt && payload.capturedAt >= cached.capturedAt) return;
      nfLog('content: restored cache', id);
      statusText = statusText || 'cached';
      applyPayload(cached, true);
    } catch (e) {
      nfLog('content: cache read failed', e && e.message ? e.message : e);
    }
  }

  function refreshChrome() {
    const overlay = globalThis.NFJPOverlay;
    if (!overlay) return;
    const onWatch = !!videoId;
    overlay.setVisible(onWatch && !!settings.debug);
    if (!onWatch) return;
    overlay.setStatus(statusText);
    overlay.setState(payload && payload.videoId === videoId ? payload : { videoId: videoId, tracks: [], ja: null, zh: null });
  }

  function onLocation() {
    const id = watchIdFrom(location.href);
    if (id === videoId) return;
    const previousId = videoId;
    videoId = id;
    payload = null;
    if (previousId && chrome.storage && chrome.storage.session) {
      chrome.storage.session.remove(storageKey(previousId));
      nfLog('content: cleared cache', previousId);
    }
    if (!id) {
      statusText = 'not on a watch page';
      nfLog('content: left watch page');
      refreshChrome();
      return;
    }
    statusText = 'waiting for subtitles';
    nfLog('content: watch', id);
    refreshChrome();
    restore(id);
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
    statusText = 'retrying capture';
    if (payload && String(payload.videoId) === String(videoId)) {
      payload = {
        videoId: payload.videoId,
        movieId: payload.movieId || null,
        source: null,
        capturedAt: null,
        tracks: payload.tracks || [],
        ja: null,
        zh: null,
        jaForced: null,
        zhForced: null
      };
    }
    if (chrome.storage && chrome.storage.session) chrome.storage.session.remove(storageKey(videoId));
    publishPayload();
    refreshChrome();
    nfLog('content: retry capture', videoId);
    window.postMessage({ source: 'NFJP-CS', type: 'RETRY' }, '*');
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
      statusText = data.status || '';
      nfLog('content: status', statusText);
      refreshChrome();
      return;
    }

    if (data.type === 'TRACKS') {
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
      payload = {
        videoId: data.videoId,
        movieId: data.movieId || (previous && previous.movieId) || null,
        source: previous && previous.source || null,
        capturedAt: previous && previous.capturedAt || null,
        tracks: data.tracks || [],
        ja: keepParsed(previous && previous.ja, data.ja),
        zh: keepParsed(previous && previous.zh, data.zh),
        jaForced: keepParsed(previous && previous.jaForced, data.jaForced),
        zhForced: keepParsed(previous && previous.zhForced, data.zhForced)
      };
      publishPayload();
      nfLog('content: track list', (data.tracks || []).length);
      refreshChrome();
      return;
    }

    if (data.type === 'PARSED') {
      payload = {
        videoId: data.videoId,
        movieId: data.movieId || null,
        source: data.source || null,
        capturedAt: data.capturedAt || new Date().toISOString(),
        tracks: data.tracks || [],
        ja: data.ja || null,
        zh: data.zh || null,
        jaForced: data.jaForced || null,
        zhForced: data.zhForced || null
      };
      publishPayload();
      statusText = data.status || (
        'ja cues ' + (payload.ja && payload.ja.cues ? payload.ja.cues.length : 0) +
        ' / zh cues ' + (payload.zh && payload.zh.cues ? payload.zh.cues.length : 0)
      );
      nfLog('content: parsed', payload.videoId, statusText, 'source', payload.source);
      refreshChrome();
      savePayload(payload);
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
    nfLog('content: settings', settings.enabled ? 'on' : 'off', 'ja', settings.showJa, 'zh', settings.showZh, 'furigana', settings.furigana, 'debug', settings.debug);
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
    if (alt && (event.code === 'KeyD' || event.code === 'KeyF' || event.code === 'KeyJ' || event.code === 'KeyC' || event.code === 'KeyS' || event.code === 'ArrowUp' || event.code === 'ArrowDown')) {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'KeyD') settings.debug = !settings.debug;
      else if (event.code === 'KeyF') settings.furigana = !settings.furigana;
      else if (event.code === 'KeyJ') settings.showJa = !settings.showJa;
      else if (event.code === 'KeyC') settings.showZh = !settings.showZh;
      else if (event.code === 'KeyS') settings.enabled = !settings.enabled;
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

  setInterval(onLocation, 300);
  window.addEventListener('popstate', onLocation);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onLocation);
  }
  onLocation();
  nfLog('content: listening');
})();
