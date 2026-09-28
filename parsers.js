/*
 * TTML / DFXP / IMSC 1.1 and WebVTT -> [{start, end, text, ruby}] in seconds.
 * Tick times ("123456t") use ttp:tickRate. <br/> becomes a newline.
 * Style spans are stripped. Netflix ruby is kept on `ruby` as base(reading).
 */
(function () {
  'use strict';

  const NF = globalThis.__NFJP || (globalThis.__NFJP = {});

  const XML_NS = 'http://www.w3.org/XML/1998/namespace';
  const PARAM_NS = 'http://www.w3.org/ns/ttml#parameter';
  const STYLE_NS = 'http://www.w3.org/ns/ttml#styling';
  const TT_NS = 'http://www.w3.org/ns/ttml';

  function nfLog() {
    const args = ['[NFJP]'];
    for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  function round3(value) {
    return Math.round(value * 1000) / 1000;
  }

  function clean(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\u200e\u200f\u202a-\u202c\u2060\ufeff]/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function attr(element, local) {
    if (!element || element.nodeType !== 1) return null;
    const namespaces = [XML_NS, PARAM_NS, STYLE_NS, TT_NS, null];
    for (let i = 0; i < namespaces.length; i++) {
      const value = namespaces[i] ? element.getAttributeNS(namespaces[i], local) : element.getAttribute(local);
      if (value != null && value !== '') return value;
    }
    const attributes = element.attributes;
    if (!attributes) return null;
    for (let i = 0; i < attributes.length; i++) {
      const name = attributes[i].localName || attributes[i].name || '';
      if (name === local || name.slice(-(local.length + 1)) === ':' + local) return attributes[i].value;
    }
    return null;
  }

  function localTag(element) {
    const name = element.localName || element.tagName || '';
    const lower = String(name).toLowerCase();
    const colon = lower.lastIndexOf(':');
    return colon === -1 ? lower : lower.slice(colon + 1);
  }

  function parseClock(raw, rates) {
    if (raw == null) return null;
    const text = String(raw).trim();
    if (!text) return null;

    const tick = /^(\d+(?:\.\d+)?)t$/.exec(text);
    if (tick) {
      if (!rates.tickRate) return null;
      return Number(tick[1]) / rates.tickRate;
    }

    const offset = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(text);
    if (offset) {
      const amount = Number(offset[1]);
      if (offset[2] === 'h') return amount * 3600;
      if (offset[2] === 'm') return amount * 60;
      if (offset[2] === 's') return amount;
      return amount / 1000;
    }

    const body = text.replace(',', '.');
    const parts = body.split(':');
    if (parts.length === 4) {
      const hours = Number(parts[0]);
      const minutes = Number(parts[1]);
      const seconds = Number(parts[2]);
      const last = parts[3];
      if (![hours, minutes, seconds].every(Number.isFinite)) return null;
      const base = hours * 3600 + minutes * 60 + seconds;
      if (rates.frameRate && last.length <= 2) return base + Number(last) / rates.frameRate;
      if (last.length === 3) return base + Number(last) / 1000;
      if (rates.frameRate) return base + Number(last) / rates.frameRate;
      return null;
    }
    if (parts.length === 3) {
      const hours = Number(parts[0]);
      const minutes = Number(parts[1]);
      const seconds = Number(parts[2]);
      if (![hours, minutes, seconds].every(Number.isFinite)) return null;
      return hours * 3600 + minutes * 60 + seconds;
    }
    if (parts.length === 2) {
      const minutes = Number(parts[0]);
      const seconds = Number(parts[1]);
      if (![minutes, seconds].every(Number.isFinite)) return null;
      return minutes * 60 + seconds;
    }
    return null;
  }

  function rubyMap(doc) {
    const map = new Map();
    const styles = doc.getElementsByTagNameNS('*', 'style');
    for (let i = 0; i < styles.length; i++) {
      const id = attr(styles[i], 'id');
      const role = attr(styles[i], 'ruby');
      if (id && role) map.set(id, role.trim());
    }
    return map;
  }

  function rubyRole(element, map) {
    const direct = attr(element, 'ruby');
    if (direct) return direct.trim();
    const ref = element.getAttribute('style') || attr(element, 'style');
    if (!ref) return null;
    const ids = ref.trim().split(/\s+/);
    for (let i = 0; i < ids.length; i++) {
      if (map.has(ids[i])) return map.get(ids[i]);
    }
    return null;
  }

  function walk(node, map) {
    if (!node) return { text: '', ruby: '' };
    if (node.nodeType === 3) {
      const value = node.nodeValue || '';
      return { text: value, ruby: value };
    }
    if (node.nodeType !== 1) return { text: '', ruby: '' };
    const tag = localTag(node);
    if (tag === 'br') return { text: '\n', ruby: '\n' };
    if (tag === 'rp' || tag === 'metadata' || tag === 'styling' || tag === 'layout' || tag === 'style' || tag === 'region') {
      return { text: '', ruby: '' };
    }
    if (tag === 'ruby' || rubyRole(node, map) === 'container') return walkRuby(node, map);
    let text = '';
    let ruby = '';
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      const part = walk(children[i], map);
      text += part.text;
      ruby += part.ruby;
    }
    return { text: text, ruby: ruby };
  }

  function walkRuby(element, map) {
    let baseText = '';
    let baseRuby = '';
    let reading = '';
    const children = element.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child.nodeType === 1) {
        const tag = localTag(child);
        const role = rubyRole(child, map);
        if (tag === 'rt' || role === 'text') {
          reading += child.textContent || '';
          continue;
        }
        if (tag === 'rp' || role === 'delimiter') continue;
      }
      const part = walk(child, map);
      baseText += part.text;
      baseRuby += part.ruby;
    }
    reading = reading.replace(/\s+/g, '').trim();
    if (!reading) return { text: baseText, ruby: baseRuby };
    return { text: baseText, ruby: baseRuby + '(' + reading + ')' };
  }

  function regionOrigins(doc) {
    const origins = new Map();
    const regions = doc.getElementsByTagNameNS('*', 'region');
    for (let i = 0; i < regions.length; i++) {
      const id = attr(regions[i], 'id');
      const origin = attr(regions[i], 'origin');
      if (!id || !origin) continue;
      const match = /(-?\d+(?:\.\d+)?)%\s+(-?\d+(?:\.\d+)?)%/.exec(origin);
      if (match) origins.set(id, Number(match[2]));
    }
    return origins;
  }

  function ratesFrom(root) {
    const rates = { tickRate: 0, frameRate: 0 };
    const tick = Number(attr(root, 'tickRate'));
    if (Number.isFinite(tick) && tick > 0) rates.tickRate = tick;
    let frame = Number(attr(root, 'frameRate'));
    const multiplier = attr(root, 'frameRateMultiplier');
    if (multiplier && Number.isFinite(frame) && frame > 0) {
      const pieces = multiplier.trim().split(/\s+/).map(Number);
      if (pieces.length === 2 && pieces[0] && pieces[1]) frame = frame * pieces[0] / pieces[1];
    }
    if (Number.isFinite(frame) && frame > 0) rates.frameRate = frame;
    return rates;
  }

  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const root = doc.documentElement;
    if (!root || localTag(root) === 'parsererror') {
      nfLog('ttml parse error');
      return [];
    }
    const rates = ratesFrom(root);
    nfLog('ttml timing', 'tickRate', rates.tickRate || 'none', 'frameRate', rates.frameRate || 'none');
    const roles = rubyMap(doc);
    const origins = regionOrigins(doc);
    let paragraphs = Array.from(doc.getElementsByTagNameNS('*', 'p'));
    if (!paragraphs.length) {
      paragraphs = Array.from(doc.getElementsByTagNameNS('*', 'div')).filter(function (element) {
        return attr(element, 'begin') || attr(element, 'end');
      });
    }
    const cues = [];
    let loggedTick = false;
    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i];
      const begin = attr(paragraph, 'begin');
      const endAttr = attr(paragraph, 'end');
      const durAttr = attr(paragraph, 'dur');
      if (!begin || (!endAttr && !durAttr)) continue;
      if (/t$/.test(begin) && !rates.tickRate) {
        if (!loggedTick) {
          loggedTick = true;
          nfLog('ttml tick timestamp without ttp:tickRate; dropping those cues');
        }
        continue;
      }
      const start = parseClock(begin, rates);
      let end = endAttr ? parseClock(endAttr, rates) : null;
      if (end == null && durAttr) {
        const dur = parseClock(durAttr, rates);
        if (start != null && dur != null) end = start + dur;
      }
      if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const rendered = walk(paragraph, roles);
      const plain = clean(rendered.text);
      const rubyText = clean(rendered.ruby);
      if (!plain) continue;
      const regionId = paragraph.getAttribute('region') || attr(paragraph, 'region');
      cues.push({
        start: round3(start),
        end: round3(end),
        text: plain,
        ruby: rubyText && rubyText !== plain ? rubyText : null,
        regionY: regionId && origins.has(regionId) ? origins.get(regionId) : null,
        top: regionId && origins.has(regionId) ? origins.get(regionId) <= 40 : false,
        sourceIndex: i
      });
    }
    cues.sort(function (a, b) {
      return a.start - b.start || (a.regionY == null ? 0 : a.regionY) - (b.regionY == null ? 0 : b.regionY) || a.sourceIndex - b.sourceIndex;
    });
    return cues.map(finishCue);
  }

  function decodeEntities(value) {
    const area = document.createElement('textarea');
    area.innerHTML = value;
    return area.value;
  }

  function parseVttTime(raw) {
    const text = String(raw || '').trim().replace(',', '.');
    const full = /^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{1,3})$/.exec(text);
    if (full) {
      const hours = full[1] ? Number(full[1]) : 0;
      const fraction = full[4].length === 3 ? Number(full[4]) / 1000 : Number(full[4]) / Math.pow(10, full[4].length);
      return hours * 3600 + Number(full[2]) * 60 + Number(full[3]) + fraction;
    }
    const short = /^(\d{1,2}):(\d{2})\.(\d{1,3})$/.exec(text);
    if (short) {
      const fraction = short[3].length === 3 ? Number(short[3]) / 1000 : Number(short[3]) / Math.pow(10, short[3].length);
      return Number(short[1]) * 60 + Number(short[2]) + fraction;
    }
    return null;
  }

  function renderVttBody(body) {
    let source = body.replace(/<\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '');
    source = source.replace(/<br\s*\/?>/gi, '\n');
    source = source.replace(/<\/?c(?:\.[^>\s]*)?(?:\s[^>]*)?>/gi, '');
    source = source.replace(/<\/?v(?:\s[^>]*)?>/gi, '');
    source = source.replace(/<\/?(?:b|i|u|lang|font)(?:\s[^>]*)?>/gi, '');
    if (!/<\s*ruby[\s>]/i.test(source)) {
      const text = clean(decodeEntities(source.replace(/<[^>]+>/g, '')));
      return { text: text, ruby: null };
    }
    const doc = new DOMParser().parseFromString('<div>' + source + '</div>', 'text/html');
    const rendered = walk(doc.body, new Map());
    const text = clean(rendered.text);
    const rubyText = clean(rendered.ruby);
    return { text: text, ruby: rubyText && rubyText !== text ? rubyText : null };
  }

  function parseWebVtt(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const cues = [];
    let index = 0;
    if (lines.length && /^WEBVTT/i.test(lines[0].trim())) {
      index = 1;
      while (index < lines.length && lines[index].trim() !== '') index++;
    }
    while (index < lines.length) {
      while (index < lines.length && lines[index].trim() === '') index++;
      if (index >= lines.length) break;
      const header = lines[index].trim().toUpperCase();
      if (header.indexOf('NOTE') === 0 || header.indexOf('STYLE') === 0 || header.indexOf('REGION') === 0) {
        index++;
        while (index < lines.length && lines[index].trim() !== '') index++;
        continue;
      }
      let timeLine = lines[index];
      if (timeLine.indexOf('-->') === -1 && index + 1 < lines.length && lines[index + 1].indexOf('-->') !== -1) {
        index++;
        timeLine = lines[index];
      }
      if (timeLine.indexOf('-->') === -1) {
        index++;
        continue;
      }
      const halves = timeLine.split('-->');
      const start = parseVttTime(halves[0]);
      const endToken = halves[1] ? halves[1].trim().split(/\s+/)[0] : '';
      const end = parseVttTime(endToken);
      const lineSetting = /(?:^|\s)line:(-?\d+(?:\.\d+)?)(%)?/.exec(halves[1] || '');
      index++;
      const body = [];
      while (index < lines.length && lines[index].trim() !== '') {
        body.push(lines[index]);
        index++;
      }
      if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const rendered = renderVttBody(body.join('\n'));
      if (!rendered.text) continue;
      cues.push({
        start: round3(start),
        end: round3(end),
        text: rendered.text,
        ruby: rendered.ruby,
        regionY: lineSetting ? Number(lineSetting[1]) : null,
        top: !!(lineSetting && lineSetting[2] === '%' && Number(lineSetting[1]) <= 40),
        sourceIndex: cues.length
      });
    }
    cues.sort(function (a, b) {
      return a.start - b.start || (a.regionY == null ? 0 : a.regionY) - (b.regionY == null ? 0 : b.regionY) || a.sourceIndex - b.sourceIndex;
    });
    return cues.map(finishCue);
  }

  function finishCue(cue) {
    return {
      start: cue.start,
      end: cue.end,
      text: cue.text,
      ruby: cue.ruby,
      top: !!cue.top
    };
  }

  function sniff(text) {
    const sample = String(text || '').slice(0, 4000);
    if (/^\uFEFF?\s*WEBVTT(\s|$)/i.test(sample)) return 'webvtt';
    if (/<tt(\s|>|:)/i.test(sample)) return 'ttml';
    return null;
  }

  function parseSubtitleDocument(text, formatHint) {
    const detected = sniff(text);
    const hint = /vtt/i.test(formatHint || '') ? 'webvtt' : (/tt|dfxp|imsc|xml|sdh/i.test(formatHint || '') ? 'ttml' : null);
    const format = detected || hint || 'unknown';
    if (!detected && text) {
      nfLog('subtitle sniff fallback', format, 'hint', formatHint || 'none', 'head', String(text).slice(0, 80).replace(/\s+/g, ' '));
    }
    if (format === 'webvtt') return { format: 'webvtt', cues: parseWebVtt(text) };
    if (format === 'ttml') return { format: 'ttml', cues: parseTtml(text) };
    nfLog('unrecognized subtitle document', 'chars', text ? text.length : 0);
    return { format: 'unknown', cues: [] };
  }

  NF.parseSubtitleDocument = parseSubtitleDocument;
  NF.sniffSubtitle = sniff;
})();
