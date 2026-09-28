/*
 * Debug overlay. Isolated world: it only paints state handed over by content.js.
 */
(function () {
  'use strict';

  const hostId = 'nfjp-debug';
  let root = null;
  let state = null;
  let statusText = 'starting';
  let visible = false;

  function nfLog() {
    const args = ['[NFJP]'];
    for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function slot(className) {
    return el('div', className, '');
  }

  function mount() {
    if (root && root.isConnected) return;
    const parent = document.body || document.documentElement;
    if (!parent) return;
    root = document.getElementById(hostId);
    if (!root) {
      root = el('div', null, null);
      root.id = hostId;
      root.appendChild(el('div', 'nfjp-title', 'NF JP Reader'));
      root.appendChild(slot('nfjp-status'));
      root.appendChild(slot('nfjp-id'));
      root.appendChild(slot('nfjp-tracks'));
      root.appendChild(slot('nfjp-counts'));
      root.appendChild(slot('nfjp-ja'));
      root.appendChild(slot('nfjp-zh'));
      const actions = el('div', 'nfjp-actions', null);
      const retry = el('button', 'nfjp-retry', 'Retry capture');
      retry.type = 'button';
      retry.addEventListener('click', function () {
        if (globalThis.NFJPOnRetry) globalThis.NFJPOnRetry();
      });
      const button = el('button', 'nfjp-export', 'Export JSON');
      button.type = 'button';
      button.disabled = true;
      button.addEventListener('click', function () {
        if (globalThis.NFJPOnExport) globalThis.NFJPOnExport();
      });
      actions.appendChild(retry);
      actions.appendChild(button);
      root.appendChild(actions);
      parent.appendChild(root);
      nfLog('overlay mounted');
    }
    paint();
  }

  function setText(className, text) {
    if (!root) return;
    const node = root.querySelector('.' + className);
    if (node) node.textContent = text;
  }

  function trackLine(track) {
    const formats = (track.formats || []).map(function (fmt) { return fmt.format; });
    const kind = track.hasUrl ? 'text' : (track.isImage ? 'image' : 'no-url');
    const flags = [];
    if (track.isCC) flags.push('CC');
    if (track.isForced) flags.push('forced');
    const format = track.preferredFormat || formats.join(', ') || 'none';
    return track.language + '  ' + (track.displayName || '') +
      (flags.length ? '  ' + flags.join('/') : '') +
      '  ' + format + '  ' + kind;
  }

  function activeCues(cues, time) {
    if (!cues || time == null || !Number.isFinite(time)) return [];
    const hits = [];
    for (let i = 0; i < cues.length; i++) {
      if (time >= cues[i].start && time < cues[i].end) hits.push(cues[i]);
    }
    return hits;
  }

  function formatCues(label, packet, time) {
    if (!packet) return label + '  —';
    const cues = activeCues(packet.cues, time);
    if (!cues.length) return label + '  —';
    return cues.map(function (cue, index) {
      const head = index === 0 ? label : ' '.repeat(label.length);
      const ruby = cue.ruby ? '\n' + ' '.repeat(label.length + 2) + cue.ruby : '';
      return head + '  ' + cue.text + ruby;
    }).join('\n');
  }

  function paint() {
    if (!root) return;
    root.hidden = !visible;
    setText('nfjp-status', statusText || '');
    const videoId = state && state.videoId ? state.videoId : '—';
    const movieId = state && state.movieId && String(state.movieId) !== String(videoId) ? '  movie ' + state.movieId : '';
    setText('nfjp-id', 'video ' + videoId + movieId);
    const tracks = state && state.tracks ? state.tracks : [];
    const shown = tracks.slice(0, 14).map(trackLine);
    if (tracks.length > 14) shown.push('+' + (tracks.length - 14) + ' more');
    setText('nfjp-tracks', shown.length ? shown.join('\n') : 'tracks  —');
    function sideLabel(side) {
      if (!side) return 'missing';
      const bits = [side.language || '?'];
      if (side.isCC) bits.push('CC');
      if (side.fallback) bits.push('fallback');
      return bits.join(' ');
    }
    const jaCount = state && state.ja && state.ja.cues ? state.ja.cues.length : 0;
    const zhCount = state && state.zh && state.zh.cues ? state.zh.cues.length : 0;
    const jaForcedCount = state && state.jaForced && state.jaForced.cues ? state.jaForced.cues.length : 0;
    const zhForcedCount = state && state.zhForced && state.zhForced.cues ? state.zhForced.cues.length : 0;
    const jaError = state && state.ja && state.ja.error ? '  ' + state.ja.error : '';
    const zhError = state && state.zh && state.zh.error ? '  ' + state.zh.error : '';
    setText('nfjp-counts',
      'ja cues ' + jaCount + ' (' + sideLabel(state && state.ja) + ')' + jaError +
      '\nzh cues ' + zhCount + ' (' + sideLabel(state && state.zh) + ')' + zhError +
      '\nforced ' + jaForcedCount + ' / ' + zhForcedCount);
    const button = root.querySelector('.nfjp-export');
    if (button) button.disabled = !(state && state.capturedAt);
  }

  function findVideo() {
    const videos = document.getElementsByTagName('video');
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < videos.length; i++) {
      const rect = videos[i].getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = videos[i];
      }
    }
    return bestArea >= 1600 ? best : null;
  }

  function place(video) {
    if (!root) return;
    if (!video) {
      root.style.top = '8px';
      root.style.left = '8px';
      return;
    }
    const rect = video.getBoundingClientRect();
    root.style.top = Math.max(8, rect.top + 8) + 'px';
    root.style.left = Math.max(8, rect.left + 8) + 'px';
  }

  function sync(time, video) {
    mount();
    place(video || findVideo());
    const clock = time == null || !Number.isFinite(time) ? 'no video' : time.toFixed(1) + 's';
    setText('nfjp-ja', formatCues('JA', state && state.ja, time) + '\n@ ' + clock);
    setText('nfjp-zh', formatCues('ZH', state && state.zh, time));
  }

  globalThis.NFJPOverlay = {
    setVisible: function (next) {
      visible = !!next;
      mount();
      paint();
    },
    setStatus: function (text) {
      statusText = text || '';
      mount();
      paint();
    },
    setState: function (next) {
      state = next;
      mount();
      paint();
    },
    sync: sync,
    findVideo: findVideo
  };
})();
