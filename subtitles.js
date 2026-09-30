/*
 * Draws Japanese and Chinese lines inside the Netflix player and hides
 * .player-timedtext while the extension overlay is on.
 */
(function () {
  'use strict';

  let payload = null;
  let settings = {
    enabled: true,
    showJa: true,
    showZh: true,
    furigana: true,
    nudge: 0,
    fontScale: 1,
    followNetflix: false,
    shade: false,
    shadeOpacity: 0.5
  };
  let renderKey = '';
  let mainPairs = [];
  let forcedPairs = [];

  function nfLog() {
    const args = ['[NFJP]'];
    for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
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

  function playerRoot(video) {
    return video.closest('.watch-video') ||
      video.closest('[data-uia="video-canvas"]') ||
      video.closest('[data-uia="player"]') ||
      video.parentElement;
  }

  function ensureBox(root) {
    let box = document.getElementById('nfjp-subs');
    if (!box) {
      box = document.createElement('div');
      box.id = 'nfjp-subs';
      const ja = document.createElement('div');
      ja.className = 'nfjp-ja';
      const zh = document.createElement('div');
      zh.className = 'nfjp-zh';
      box.appendChild(ja);
      box.appendChild(zh);
    }
    if (box.parentElement !== root) root.appendChild(box);
    return box;
  }

  function activeCues(packet, time) {
    const cues = packet && packet.cues;
    if (!cues || time == null || !Number.isFinite(time)) return [];
    const hits = [];
    for (let i = 0; i < cues.length; i++) {
      if (time >= cues[i].start && time < cues[i].end) hits.push(cues[i]);
    }
    return hits;
  }

  function controlsVisible(root) {
    const selectors = [
      '.watch-video--bottom-controls-container',
      '.PlayerControlsNeo__bottom-controls',
      '.bottom-controls',
      '[data-uia="controls-standard"]'
    ];
    const player = root.getBoundingClientRect();
    if (player.height < 40) return false;
    for (let s = 0; s < selectors.length; s++) {
      const nodes = root.querySelectorAll(selectors[s]);
      for (let i = 0; i < nodes.length; i++) {
        const style = getComputedStyle(nodes[i]);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.4) continue;
        const rect = nodes[i].getBoundingClientRect();
        if (rect.width < 80 || rect.height < 16) continue;
        const onBottomEdge = rect.bottom > player.bottom - player.height * 0.25 && rect.top < player.bottom;
        if (onBottomEdge) return true;
      }
    }
    return false;
  }

  function appendSegments(parent, segments) {
    const list = segments || [];
    for (let i = 0; i < list.length; i++) {
      const part = list[i];
      const chunks = String(part.text || '').split('\n');
      for (let c = 0; c < chunks.length; c++) {
        if (c > 0) parent.appendChild(document.createElement('br'));
        if (!chunks[c]) continue;
        if (part.reading) {
          const ruby = document.createElement('ruby');
          ruby.appendChild(document.createTextNode(chunks[c]));
          const rt = document.createElement('rt');
          rt.textContent = part.reading;
          ruby.appendChild(rt);
          parent.appendChild(ruby);
        } else {
          parent.appendChild(document.createTextNode(chunks[c]));
        }
      }
    }
  }

  function fillLine(element, cues, useFurigana) {
    element.replaceChildren();
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const block = document.createElement('div');
      block.className = 'nfjp-cue';
      let segments = null;
      if (useFurigana && globalThis.NFJPFurigana) {
        segments = NFJPFurigana.segmentsFor(cue.text, cue.ruby);
        if (!segments && !cue.ruby) NFJPFurigana.prepare([cue.text]);
      }
      if (segments) appendSegments(block, segments);
      else block.appendChild(document.createTextNode(cue.text || ''));
      element.appendChild(block);
    }
  }

  function cuesOf(packet) {
    return packet && packet.cues ? packet.cues : [];
  }

  function matchingZh(anchor, zhCues) {
    const hits = [];
    for (let i = 0; i < zhCues.length; i++) {
      const cue = zhCues[i];
      if (cue.start >= anchor.end) break;
      const overlap = Math.min(anchor.end, cue.end) - Math.max(anchor.start, cue.start);
      if (!(overlap > 0)) continue;
      const duration = cue.end - cue.start;
      if (overlap > 0.3 || (duration > 0 && overlap > duration * 0.3)) hits.push(cue);
    }
    const out = [];
    const seen = {};
    for (let i = 0; i < hits.length; i++) {
      const key = String(hits[i].text || '').trim();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(hits[i]);
    }
    return out;
  }

  function buildPairs(jaPacket, zhPacket) {
    const jaCues = cuesOf(jaPacket);
    const zhCues = cuesOf(zhPacket).slice().sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });
    const pairs = [];
    for (let i = 0; i < jaCues.length; i++) {
      pairs.push({ ja: jaCues[i], zh: matchingZh(jaCues[i], zhCues) });
    }
    return pairs;
  }

  function rebuildPairs() {
    mainPairs = buildPairs(payload && payload.ja, payload && payload.zh);
    forcedPairs = buildPairs(payload && payload.jaForced, payload && payload.zhForced);
  }

  function dedupeCues(lists) {
    const out = [];
    const seen = {};
    const flat = [];
    for (let i = 0; i < lists.length; i++) {
      const list = lists[i] || [];
      for (let j = 0; j < list.length; j++) flat.push(list[j]);
    }
    flat.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    for (let i = 0; i < flat.length; i++) {
      const key = String(flat[i].text || '').trim();
      if (seen[key]) continue;
      seen[key] = true;
      out.push(flat[i]);
    }
    return out;
  }

  function linesFromPairs(pairs, zhPacket, time) {
    const active = [];
    for (let i = 0; i < pairs.length; i++) {
      const ja = pairs[i].ja;
      if (time >= ja.start && time < ja.end) active.push(pairs[i]);
    }
    if (settings.showJa && active.length) {
      return {
        ja: active.map(function (pair) { return pair.ja; }),
        zh: settings.showZh ? dedupeCues(active.map(function (pair) { return pair.zh; })) : [],
        forced: false
      };
    }
    if (!settings.showJa && settings.showZh) {
      const zh = activeCues(zhPacket, time);
      return { ja: [], zh: zh, forced: false };
    }
    if (settings.showJa && settings.showZh) {
      const zh = activeCues(zhPacket, time);
      if (zh.length) return { ja: [], zh: zh, forced: false };
    }
    return null;
  }

  function chooseLines(time) {
    const main = linesFromPairs(mainPairs, payload && payload.zh, time);
    let lines = main;
    let fromForced = false;
    if (!main || (!main.ja.length && !main.zh.length)) {
      const forced = linesFromPairs(forcedPairs, payload && payload.zhForced, time);
      if (forced && (forced.ja.length || forced.zh.length)) {
        lines = forced;
        fromForced = true;
      }
    }
    if (!lines) lines = { ja: [], zh: [] };
    let top = false;
    if (settings.followNetflix) {
      const shown = lines.ja.concat(lines.zh);
      if (fromForced && shown.length) top = true;
      else {
        for (let i = 0; i < shown.length; i++) {
          if (shown[i].top) {
            top = true;
            break;
          }
        }
      }
    }
    return { ja: lines.ja, zh: lines.zh, top: top };
  }

  function shadeOpacity() {
    let value = Number(settings.shadeOpacity);
    if (!Number.isFinite(value)) return 0.5;
    if (value > 1) value = value / 100;
    return Math.max(0, Math.min(1, value));
  }

  function place(box, root, video, top) {
    const rect = root.getBoundingClientRect();
    const height = rect.height || video.getBoundingClientRect().height || 720;
    const scale = Number(settings.fontScale) || 1;
    const nudge = Math.max(-0.06, Math.min(0.2, Number(settings.nudge) || 0)) * height;
    box.style.fontSize = (height * 0.032 * scale) + 'px';
    box.classList.toggle('nfjp-shade', !!settings.shade);
    box.style.setProperty('--nfjp-shade', String(shadeOpacity()));
    if (top) {
      box.style.top = Math.max(0, height * 0.08 - nudge) + 'px';
      box.style.bottom = 'auto';
      return;
    }
    const base = height * (controlsVisible(root) ? 0.14 : 0.08);
    box.style.bottom = Math.max(0, base + nudge) + 'px';
    box.style.top = 'auto';
  }

  function textKey(cues) {
    return cues.map(function (cue) {
      return cue.start + ':' + cue.text + ':' + (cue.ruby || '');
    }).join('|');
  }

  function onWatchPage() {
    return /\/watch\/\d+/.test(location.pathname);
  }

  function tick() {
    if (!onWatchPage()) {
      document.documentElement.classList.remove('nfjp-hide-native');
      const parked = document.getElementById('nfjp-subs');
      if (parked) parked.hidden = true;
      renderKey = '';
      return;
    }
    const video = findVideo();
    const hideNative = !!(settings.enabled && video);
    document.documentElement.classList.toggle('nfjp-hide-native', hideNative);
    if (!video || !settings.enabled) {
      const existing = document.getElementById('nfjp-subs');
      if (existing) existing.hidden = true;
      renderKey = '';
      return;
    }
    const root = playerRoot(video);
    if (!root) return;
    const box = ensureBox(root);
    const jaEl = box.querySelector('.nfjp-ja');
    const zhEl = box.querySelector('.nfjp-zh');
    if (!jaEl || !zhEl) {
      box.remove();
      renderKey = '';
      return;
    }
    const time = video.currentTime;
    const lines = chooseLines(time);
    const furiganaOn = !!settings.furigana;
    const jaReady = furiganaOn && lines.ja.length && globalThis.NFJPFurigana && lines.ja.every(function (cue) {
      return cue.ruby || NFJPFurigana.lookup(cue.text);
    });
    const key = [
      lines.top ? 'top' : 'bottom',
      furiganaOn ? 'f' : 'p',
      jaReady ? 'ready' : 'plain',
      textKey(lines.ja),
      textKey(lines.zh)
    ].join('~');
    box.hidden = !lines.ja.length && !lines.zh.length;
    jaEl.hidden = !lines.ja.length;
    zhEl.hidden = !lines.zh.length;
    if (key !== renderKey) {
      renderKey = key;
      fillLine(jaEl, lines.ja, furiganaOn);
      fillLine(zhEl, lines.zh, false);
    }
    place(box, root, video, lines.top);
  }

  globalThis.NFJPSubs = {
    setPayload: function (next) {
      payload = next;
      rebuildPairs();
      renderKey = '';
    },
    setSettings: function (next) {
      settings = next || settings;
      renderKey = '';
    },
    tick: tick,
    findVideo: findVideo
  };
})();
