/*
 * Pure furigana helpers shared by the content script and the offscreen tokenizer.
 * Readings are hiragana. Ruby is only placed over kanji, not kana.
 */
(function () {
  'use strict';

  function kataToHira(value) {
    return String(value || '').replace(/[\u30a1-\u30f6]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0x60);
    });
  }

  function isKanji(ch) {
    return /[\u4e00-\u9fff\u3400-\u4dbf々〆ヶ]/.test(ch);
  }

  function isKana(ch) {
    return /[\u3040-\u30ff]/.test(ch);
  }

  function hiraChar(ch) {
    return kataToHira(ch);
  }

  /*
   * surface 食べ / reading たべ -> prefix "", kanji 食, reading た, suffix べ.
   * Returns null when the token has no kanji that needs a reading.
   */
  function splitOkurigana(surface, reading) {
    const chars = Array.from(surface || '');
    const reads = Array.from(kataToHira(reading || ''));
    if (!chars.length || !reads.length || !chars.some(isKanji)) return null;
    let i = chars.length;
    let j = reads.length;
    while (i > 0 && j > 0 && isKana(chars[i - 1]) && hiraChar(chars[i - 1]) === reads[j - 1]) {
      i--;
      j--;
    }
    let start = 0;
    let readStart = 0;
    while (start < i && readStart < j && isKana(chars[start]) && hiraChar(chars[start]) === reads[readStart]) {
      start++;
      readStart++;
    }
    const kanji = chars.slice(start, i).join('');
    const furi = reads.slice(readStart, j).join('');
    if (!kanji || !furi || !Array.from(kanji).some(isKanji)) return null;
    return {
      prefix: chars.slice(0, start).join(''),
      kanji: kanji,
      reading: furi,
      suffix: chars.slice(i).join('')
    };
  }

  function pushPlain(segments, text) {
    if (!text) return;
    const last = segments[segments.length - 1];
    if (last && !last.reading) last.text += text;
    else segments.push({ text: text, reading: null });
  }

  function pushRuby(segments, kanji, reading) {
    if (!kanji) return;
    if (!reading) {
      pushPlain(segments, kanji);
      return;
    }
    segments.push({ text: kanji, reading: reading });
  }

  function segmentsFromParts(prefix, kanji, reading, suffix) {
    const segments = [];
    pushPlain(segments, prefix);
    pushRuby(segments, kanji, reading);
    pushPlain(segments, suffix);
    return segments;
  }

  function segmentsFromSurface(surface, reading) {
    const parts = splitOkurigana(surface, reading);
    if (!parts) return [{ text: surface, reading: null }];
    return segmentsFromParts(parts.prefix, parts.kanji, parts.reading, parts.suffix);
  }

  /* Netflix ruby is stored as base(reading) inside the line, e.g. 私は食(た)べた. */
  function segmentsFromRubyMarkup(markup) {
    const source = String(markup || '');
    const re = /([\u4e00-\u9fff\u3400-\u4dbf々〆ヶ]+[ぁ-んァ-ン]*)\(([^)]+)\)/g;
    const segments = [];
    let cursor = 0;
    let found = false;
    let match;
    while ((match = re.exec(source))) {
      const reading = kataToHira(match[2]);
      if (!/[ぁ-ん]/.test(reading)) continue;
      found = true;
      pushPlain(segments, source.slice(cursor, match.index));
      const parts = splitOkurigana(match[1], reading);
      if (parts) {
        const built = segmentsFromParts(parts.prefix, parts.kanji, parts.reading, parts.suffix);
        for (let i = 0; i < built.length; i++) {
          if (built[i].reading) pushRuby(segments, built[i].text, built[i].reading);
          else pushPlain(segments, built[i].text);
        }
      } else if (Array.from(match[1]).some(isKanji)) {
        pushRuby(segments, match[1], reading);
      } else {
        pushPlain(segments, match[0]);
      }
      cursor = match.index + match[0].length;
    }
    if (!found) return null;
    pushPlain(segments, source.slice(cursor));
    return segments;
  }

  function segmentsFromTokens(tokens) {
    const segments = [];
    const list = tokens || [];
    for (let i = 0; i < list.length; i++) {
      const token = list[i];
      const surface = token.surface_form || token.surface || '';
      if (!surface) continue;
      const reading = token.reading && token.reading !== '*' ? token.reading : '';
      const built = segmentsFromSurface(surface, reading);
      for (let s = 0; s < built.length; s++) {
        if (built[s].reading) pushRuby(segments, built[s].text, built[s].reading);
        else pushPlain(segments, built[s].text);
      }
    }
    return segments;
  }

  globalThis.NFJPRuby = {
    kataToHira: kataToHira,
    splitOkurigana: splitOkurigana,
    segmentsFromRubyMarkup: segmentsFromRubyMarkup,
    segmentsFromSurface: segmentsFromSurface,
    segmentsFromTokens: segmentsFromTokens
  };
})();
