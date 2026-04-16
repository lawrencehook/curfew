const params = new URLSearchParams(location.search);
const domain = params.get('domain') || 'unknown';
const spent = parseInt(params.get('spent'), 10) || 0;
const limit = parseInt(params.get('limit'), 10) || 0;

function fmt(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + ' minutes';
}

qs('#domain').textContent = domain;
qs('#spent').textContent = fmt(spent);
qs('#limit').textContent = fmt(limit);

// Extend time
const extendBtn = qs('#extend-btn');
const dateKey = new Date().toISOString().slice(0, 10);
const extKey = 'ext_' + dateKey + '_' + domain;

browser.storage.local.get(extKey).then((data) => {
  if (data[extKey]) extendBtn.disabled = true;
});

extendBtn.addEventListener('click', async () => {
  extendBtn.disabled = true;
  extendBtn.textContent = 'Extending\u2026';

  const resp = await browser.runtime.sendMessage({
    type: 'extendTime',
    domain,
  });

  if (resp && resp.success) {
    location.href = 'https://' + domain;
  } else {
    extendBtn.textContent = '+1 Minute (used)';
  }
});
