(function () {
  'use strict';

  const defaults = {
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

  const ids = ['enabled', 'showJa', 'showZh', 'furigana', 'debug', 'followNetflix', 'shade'];
  let settings = Object.assign({}, defaults);

  function paint() {
    for (let i = 0; i < ids.length; i++) {
      document.getElementById(ids[i]).checked = !!settings[ids[i]];
    }
    const percent = Math.round((Number(settings.fontScale) || 1) * 100);
    document.getElementById('fontScale').value = String(percent);
    document.getElementById('fontValue').textContent = percent + '%';
    let shade = Number(settings.shadeOpacity);
    if (!Number.isFinite(shade)) shade = 0.5;
    if (shade > 1) shade = shade / 100;
    shade = Math.max(0, Math.min(1, shade));
    const shadePercent = Math.round(shade * 100);
    document.getElementById('shadeOpacity').value = String(shadePercent);
    document.getElementById('shadeValue').textContent = shadePercent + '%';
    let nudge = Number(settings.nudge);
    if (!Number.isFinite(nudge)) nudge = 0;
    nudge = Math.max(-0.06, Math.min(0.2, nudge));
    const nudgePercent = Math.round(nudge * 100);
    document.getElementById('nudge').value = String(nudgePercent);
    document.getElementById('nudgeValue').textContent = (nudgePercent > 0 ? '+' : '') + nudgePercent;
  }

  function save() {
    chrome.storage.local.set({ nfjpSettings: settings });
  }

  chrome.storage.local.get('nfjpSettings', function (data) {
    settings = Object.assign({}, defaults, data.nfjpSettings || {});
    paint();
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== 'local' || !changes.nfjpSettings) return;
    settings = Object.assign({}, defaults, changes.nfjpSettings.newValue || {});
    paint();
  });

  for (let i = 0; i < ids.length; i++) {
    document.getElementById(ids[i]).addEventListener('change', function (event) {
      settings[event.target.id] = event.target.checked;
      save();
    });
  }

  document.getElementById('fontScale').addEventListener('input', function (event) {
    const percent = Number(event.target.value);
    settings.fontScale = percent / 100;
    document.getElementById('fontValue').textContent = percent + '%';
    save();
  });

  document.getElementById('shadeOpacity').addEventListener('input', function (event) {
    const percent = Number(event.target.value);
    settings.shadeOpacity = percent / 100;
    document.getElementById('shadeValue').textContent = percent + '%';
    save();
  });

  function clampNudge(value) {
    return Math.max(-0.06, Math.min(0.2, Math.round(value * 1000) / 1000));
  }

  function setNudge(value) {
    settings.nudge = clampNudge(value);
    paint();
    save();
  }

  document.getElementById('nudge').addEventListener('input', function (event) {
    setNudge(Number(event.target.value) / 100);
  });

  document.getElementById('nudgeUp').addEventListener('click', function () {
    setNudge((Number(settings.nudge) || 0) + 0.04);
  });

  document.getElementById('nudgeDown').addEventListener('click', function () {
    setNudge((Number(settings.nudge) || 0) - 0.04);
  });

  const translateOptions = { sourceLanguage: 'ja', targetLanguage: 'zh-Hant' };

  function setTranslateStatus(text) {
    document.getElementById('translateStatus').textContent = text || '';
  }

  function translateOutcome(response) {
    if (!response) return 'Translation did not start. Refresh the Netflix tab and try again.';
    if (response.ok && response.already) return 'Chinese subtitles are already on this episode.';
    if (response.ok) return 'Traditional Chinese added.';
    if (response.error === 'download') return 'Click Add Traditional Chinese again so Chrome can finish downloading the language model.';
    if (response.error === 'unavailable') return 'On-device translation needs Chrome 138 or newer on a desktop computer.';
    if (response.error === 'no-ja') return 'Japanese subtitles are not loaded for this episode yet.';
    if (response.error === 'empty') return 'Translation returned no Chinese lines.';
    if (response.error === 'stale') return 'The episode changed before translation finished.';
    return 'Translation failed. Refresh the Netflix tab and try again.';
  }

  async function addTraditionalChinese() {
    const button = document.getElementById('translate');
    button.disabled = true;
    try {
      if (typeof Translator === 'undefined') {
        setTranslateStatus('Update Chrome to version 138 or newer, then click again.');
        return;
      }
      let availability = 'unavailable';
      try {
        availability = await Translator.availability(translateOptions);
      } catch (err) {
        setTranslateStatus('On-device translation is unavailable on this device.');
        return;
      }
      if (availability === 'unavailable') {
        setTranslateStatus('This device cannot translate Japanese to Traditional Chinese.');
        return;
      }
      if (availability === 'downloadable' || availability === 'downloading') {
        setTranslateStatus('Downloading the language model…');
        try {
          const translator = await Translator.create({
            sourceLanguage: 'ja',
            targetLanguage: 'zh-Hant',
            monitor: function (monitor) {
              monitor.addEventListener('downloadprogress', function (event) {
                const loaded = Number(event && event.loaded);
                const pct = Number.isFinite(loaded) ? Math.round(loaded * 100) : 0;
                setTranslateStatus('Downloading the language model… ' + pct + '%');
              });
            }
          });
          if (translator && translator.destroy) translator.destroy();
        } catch (err) {
          if (err && err.name === 'NotAllowedError') {
            setTranslateStatus('Click Add Traditional Chinese again to allow the download.');
          } else {
            setTranslateStatus('Could not download the language model.');
          }
          return;
        }
      }
      if (!settings.showZh) {
        settings.showZh = true;
        paint();
        save();
      }
      setTranslateStatus('Translating this episode…');
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) {
        setTranslateStatus('Open a Netflix episode, then click again.');
        return;
      }
      if (tab.url && !/https:\/\/([^/]+\.)?netflix\.com\//.test(tab.url)) {
        setTranslateStatus('Open a Netflix episode, then click again.');
        return;
      }
      const response = await new Promise(function (resolve) {
        chrome.tabs.sendMessage(tab.id, { type: 'NFJP_TRANSLATE' }, function (result) {
          const error = chrome.runtime.lastError;
          if (error) {
            resolve({ ok: false, error: error.message });
            return;
          }
          resolve(result || { ok: false, error: 'no response' });
        });
      });
      if (response && response.error && /Receiving end does not exist|Could not establish connection/i.test(response.error)) {
        setTranslateStatus('Refresh the Netflix tab, then click again.');
        return;
      }
      setTranslateStatus(translateOutcome(response));
    } finally {
      button.disabled = false;
    }
  }

  document.getElementById('translate').addEventListener('click', function () {
    addTraditionalChinese();
  });
})();
