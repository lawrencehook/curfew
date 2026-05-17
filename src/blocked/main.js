const params = new URLSearchParams(location.search);
const domain = params.get('domain') || 'unknown';
const limitType = params.get('type') || 'daily';
const ruleId = params.get('ruleId') || '';
const policyName = params.get('policyName') || '';
const spent = parseInt(params.get('spent'), 10) || 0;
const capacity = parseInt(params.get('capacity'), 10) || 0;
const sharedDomains = (params.get('domains') || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function fmt(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  if (m > 0) return m + ' minutes';
  return seconds + ' seconds';
}

function sharedSuffix() {
  const others = sharedDomains.filter((d) => d !== domain);
  if (!others.length) return '';
  if (others.length === 1) return ` (shared with <strong>${esc(others[0])}</strong>)`;
  return ` (shared with <strong>${esc(others[0])}</strong> and ${others.length - 1} more)`;
}

if (limitType === 'sliding') {
  qs('#title').textContent = 'On cooldown';
  qs('#message').innerHTML =
    `You've used your quota on <strong>${esc(domain)}</strong>${sharedSuffix()}.`;
  qs('#sub').textContent = policyName
    ? `Policy: ${policyName} — access opens up once your recent usage drops.`
    : 'Come back in a bit — access opens up once your recent usage drops.';
} else {
  qs('#title').textContent = "Time's Up";
  qs('#message').innerHTML =
    `You've spent <strong>${esc(fmt(spent))}</strong> on <strong>${esc(domain)}</strong>${sharedSuffix()} today.`;
  qs('#sub').innerHTML = policyName
    ? `Daily limit: <span>${esc(fmt(capacity))}</span> · Policy: ${esc(policyName)}.`
    : `Your daily limit was <span>${esc(fmt(capacity))}</span>.`;
}

const extendBtn = qs('#extend-btn');
const dateKey = new Date().toISOString().slice(0, 10);
const extKey = 'ext_' + dateKey + '_' + ruleId;

if (limitType === 'daily' && ruleId) {
  extendBtn.classList.remove('hidden');
  browser.storage.local.get(extKey).then((data) => {
    if (data[extKey]) extendBtn.disabled = true;
  });

  extendBtn.addEventListener('click', async () => {
    extendBtn.disabled = true;
    extendBtn.textContent = 'Extending…';

    const resp = await browser.runtime.sendMessage({
      type: 'extendTime',
      ruleId,
    });

    if (resp && resp.success) {
      location.href = 'https://' + domain;
    } else {
      extendBtn.textContent = '+1 Minute (used)';
    }
  });
}
