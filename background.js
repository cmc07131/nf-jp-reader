/*
 * Opens the offscreen tokenizer on demand and forwards line batches to it.
 * Messages aimed at the offscreen document are ignored here so they do not loop.
 */
const nfLog = function () {
  const args = ['[NFJP]'];
  for (let i = 0; i < arguments.length; i++) args.push(arguments[i]);
  console.log.apply(console, args);
};

async function ensureOffscreen() {
  if (chrome.runtime.getContexts) {
    const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing && existing.length) return;
  }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Tokenize Japanese subtitle lines with the bundled kuromoji dictionary.'
    });
    nfLog('offscreen tokenizer opened');
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (!/exists|single offscreen/i.test(message)) throw err;
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.target === 'offscreen' || message.type !== 'NFJP_TOKENIZE') return;
  ensureOffscreen().then(function () {
    chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'NFJP_TOKENIZE',
      lines: message.lines || []
    }, function (response) {
      const error = chrome.runtime.lastError;
      if (error) {
        nfLog('tokenize forward failed', error.message);
        sendResponse({ ok: false, error: error.message });
        return;
      }
      sendResponse(response || { ok: false, error: 'empty tokenizer response' });
    });
  }).catch(function (err) {
    nfLog('offscreen failed', err && err.message ? err.message : err);
    sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
  });
  return true;
});
