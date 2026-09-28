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
    if (!message || message.target !== 'offscreen' || message.type !== 'NFJP_TOKENIZE') return;
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
  });
})();
