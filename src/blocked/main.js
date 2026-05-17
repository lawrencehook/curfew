const params = new URLSearchParams(location.search);
const domain = params.get('domain') || 'unknown';
const limitType = params.get('type') || 'daily';
const ruleId = params.get('ruleId') || '';
const policyName = params.get('policyName') || '';

qs('#title').textContent = limitType === 'sliding' ? 'On cooldown' : 'Daily limit reached';
qs('#message').innerHTML = `<strong>${esc(domain)}</strong>`;
qs('#sub').textContent = policyName ? `Policy: ${policyName}` : '';

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
