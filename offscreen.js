/*
 * Extension page (not the Netflix page) so kuromoji can read its dictionary
 * without Netflix's content-security policy blocking the requests.
 */
(function () {
  'use strict';

  let loading = null;

  function tokenizer() {
    if (!loading) {
      loading = new Promise(function (resolve, reject) {
        if (!globalThis.kuromoji || !globalThis.NFJPRuby) {
          reject(new Error('kuromoji or ruby helpers missing'));
          return;
        }
        console.log('[NFJP]', 'kuromoji dictionary loading');
        kuromoji.builder({ dicPath: 'lib/kuromoji/dict/' }).build(function (err, built) {
          if (err) {
            console.log('[NFJP]', 'kuromoji failed', err);
            reject(err);
            return;
          }
          console.log('[NFJP]', 'kuromoji ready');
          resolve(built);
        });
      });
    }
    return loading;
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.target !== 'offscreen') return;
    if (message.type === 'NFJP_TOKENIZE') {
      tokenizer().then(function (built) {
        const lines = message.lines || [];
        const segments = {};
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || segments[line]) continue;
          try {
            segments[line] = NFJPRuby.segmentsFromTokens(built.tokenize(line));
          } catch (e) {
            segments[line] = [{ text: line, reading: null }];
          }
        }
        sendResponse({ ok: true, segments: segments });
      }).catch(function (err) {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
      return true;
    }
    if (message.type === 'NFJP_TRANSLATE_LINES') {
      translateLines(message.lines || []).then(function (lines) {
        sendResponse({ ok: true, lines: lines });
      }).catch(function (err) {
        sendResponse({ ok: false, error: translateError(err) });
      });
      return true;
    }
  });

  const translateOptions = { sourceLanguage: 'ja', targetLanguage: 'zh-Hant' };
  let translatorPromise = null;

  function translateError(err) {
    const name = err && err.name ? err.name : '';
    const message = String(err && err.message ? err.message : err);
    if (message === 'download' || message === 'unavailable') return message;
    if (name === 'NotAllowedError' || /user gesture|not allowed/i.test(message)) return 'download';
    if (/unavailable|not supported/i.test(message)) return 'unavailable';
    return message || 'translation failed';
  }

  function translator() {
    if (!translatorPromise) {
      translatorPromise = (async function () {
        if (typeof Translator === 'undefined') throw new Error('unavailable');
        const availability = await Translator.availability(translateOptions);
        if (availability === 'unavailable') throw new Error('unavailable');
        if (availability === 'downloadable' || availability === 'downloading') throw new Error('download');
        console.log('[NFJP]', 'translator ready', availability);
        return Translator.create(translateOptions);
      })();
      translatorPromise.catch(function () { translatorPromise = null; });
    }
    return translatorPromise;
  }

  async function translateLines(lines) {
    const engine = await translator();
    const unique = [];
    const seen = Object.create(null);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] == null ? '' : String(lines[i]);
      if (!line.trim() || seen[line]) continue;
      seen[line] = true;
      unique.push(line);
    }
    const translated = Object.create(null);
    let cursor = 0;
    let failures = 0;
    async function worker() {
      while (cursor < unique.length) {
        const line = unique[cursor++];
        try {
          translated[line] = await engine.translate(line);
        } catch (err) {
          const code = translateError(err);
          if (code === 'download' || code === 'unavailable') throw new Error(code);
          failures++;
          translated[line] = '';
          console.log('[NFJP]', 'translate line failed', code);
        }
      }
    }
    const workers = [];
    const count = Math.min(4, unique.length);
    for (let i = 0; i < count; i++) workers.push(worker());
    await Promise.all(workers);
    if (unique.length && failures === unique.length) throw new Error('translation failed');
    return lines.map(function (line) {
      const text = line == null ? '' : String(line);
      if (!text.trim()) return '';
      return translated[text] || '';
    });
  }
})();
