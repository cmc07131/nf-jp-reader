/*
 * Turns Japanese lines into ruby segments. Netflix ruby wins over kuromoji.
 * Kuromoji runs in the offscreen document; results are cached per episode.
 */
(function () {
  'use strict';

  const ruby = globalThis.NFJPRuby;
  const cache = new Map();
  const queued = new Set();
  let videoId = null;
  let chain = Promise.resolve();

  function nfLog() {
    const args = ['[NFJP]'];
    for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
    console.log.apply(console, args);
  }

  function setVideo(id) {
    if (id === videoId) return;
    videoId = id;
    cache.clear();
    queued.clear();
    chain = Promise.resolve();
    nfLog('furigana cache cleared', id || 'none');
  }

  function lookup(line) {
    return cache.has(line) ? cache.get(line) : null;
  }

  function send(lines) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: 'NFJP_TOKENIZE', lines: lines }, function (response) {
          const error = chrome.runtime.lastError;
          if (error) {
            nfLog('furigana request failed', error.message);
            resolve(null);
            return;
          }
          resolve(response);
        });
      } catch (err) {
        nfLog('furigana request failed', err && err.message ? err.message : err);
        resolve(null);
      }
    });
  }

  function prepare(lines) {
    const todo = [];
    const list = lines || [];
    for (let i = 0; i < list.length; i++) {
      const line = list[i];
      if (!line || cache.has(line) || queued.has(line)) continue;
      queued.add(line);
      todo.push(line);
    }
    if (!todo.length) return chain;
    chain = chain.then(async function () {
      for (let i = 0; i < todo.length; i += 40) {
        const slice = todo.slice(i, i + 40);
        const response = await send(slice);
        if (!response || !response.ok || !response.segments) {
          nfLog('furigana batch failed', response && response.error);
          for (let s = 0; s < slice.length; s++) queued.delete(slice[s]);
          continue;
        }
        const keys = Object.keys(response.segments);
        for (let k = 0; k < keys.length; k++) cache.set(keys[k], response.segments[keys[k]]);
      }
      nfLog('furigana cached', cache.size);
    });
    return chain;
  }

  function segmentsFor(text, rubyMarkup) {
    if (rubyMarkup && ruby) {
      const fromFile = ruby.segmentsFromRubyMarkup(rubyMarkup);
      if (fromFile && fromFile.length) return fromFile;
    }
    if (text && cache.has(text)) return cache.get(text);
    return null;
  }

  globalThis.NFJPFurigana = {
    setVideo: setVideo,
    prepare: prepare,
    lookup: lookup,
    segmentsFor: segmentsFor
  };
})();
