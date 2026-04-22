const params = new URLSearchParams(location.search);
const domain = params.get('domain') || 'unknown';
const limitType = params.get('type') || 'daily';
const spent = parseInt(params.get('spent'), 10) || 0;
const limit = parseInt(params.get('limit'), 10) || 0;

function fmt(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + ' minutes';
  return seconds + ' seconds';
}

if (limitType === 'bucket') {
  qs('#title').textContent = 'Slow down';
  qs('#message').innerHTML = `You've used your quota on <strong>${esc(domain)}</strong>.`;
  qs('#sub').textContent = 'Come back in a bit — access refills over time.';
} else {
  qs('#title').textContent = "Time's Up";
  qs('#message').innerHTML =
    `You've spent <strong>${esc(fmt(spent))}</strong> on <strong>${esc(domain)}</strong> today.`;
  qs('#sub').innerHTML = `Your daily limit was <span>${esc(fmt(limit))}</span>.`;
}

const extendBtn = qs('#extend-btn');
const dateKey = new Date().toISOString().slice(0, 10);
const extKey = 'ext_' + dateKey + '_' + domain;

if (limitType === 'daily') {
  extendBtn.classList.remove('hidden');
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
}
