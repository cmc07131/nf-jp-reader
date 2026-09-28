(function () {
  'use strict';

  const defaults = {
    enabled: true,
    showJa: true,
    showZh: true,
    furigana: true,
    debug: false,
    nudge: 0,
    fontScale: 1
  };

  const ids = ['enabled', 'showJa', 'showZh', 'furigana', 'debug'];
  let settings = Object.assign({}, defaults);

  function paint() {
    for (let i = 0; i < ids.length; i++) {
      document.getElementById(ids[i]).checked = !!settings[ids[i]];
    }
    const percent = Math.round((Number(settings.fontScale) || 1) * 100);
    document.getElementById('fontScale').value = String(percent);
    document.getElementById('fontValue').textContent = percent + '%';
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
})();
