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
})();
