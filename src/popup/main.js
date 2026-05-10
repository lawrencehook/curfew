let state = { domains: [], policies: [], usage: {}, dateKey: '', evals: {}, ruleEvals: {} };
let currentHost = null;
let matchedDomain = null;
let refreshTimer = null;
let lastPolicyKey = '';

/***************
 * Data
 ***************/

async function fetchStatus() {
  state = await browser.runtime.sendMessage({ type: 'getStatus' });
  recomputeMatched();
  render();
}

async function loadCurrentTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0] || !tabs[0].url) return;
    currentHost = new URL(tabs[0].url).hostname || null;
  } catch {
    currentHost = null;
  }
}

function recomputeMatched() {
  matchedDomain = null;
  if (!currentHost || !state.domains) return;
  if (state.domains.includes(currentHost)) {
    matchedDomain = currentHost;
    return;
  }
  for (const d of state.domains) {
    if (currentHost.endsWith('.' + d)) {
      matchedDomain = d;
      return;
    }
  }
}

/***************
 * Format helpers
 ***************/

function fmtMin(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return sec + 's';
  return Math.floor(sec / 60) + 'm';
}

function ruleKindLabel(rule) {
  if (rule.type === 'daily') return 'Daily';
  if (rule.type === 'bucket') return `Rate · ${rule.capacityMin}m / ${rule.windowMin}m`;
  return '';
}

function ruleStat(e) {
  if (!e) return '—';
  if (e.type === 'daily') {
    return `${fmtMin(e.current)} / ${fmtMin(e.limit)}`;
  }
  if (e.type === 'bucket') {
    const remaining = Math.max(0, e.limit - e.current);
    return `${fmtMin(remaining)} / ${fmtMin(e.limit)} left`;
  }
  return '';
}

/***************
 * Render
 ***************/

const WARN_THRESHOLD_SEC = 15;

function tightestActiveRule() {
  if (!matchedDomain) return null;
  let best = null;
  for (const p of state.policies || []) {
    if (!p.domains.includes(matchedDomain)) continue;
    for (const r of p.rules) {
      const e = state.ruleEvals && state.ruleEvals[r.id];
      if (!e || e.blocked) continue;
      const remaining = e.remainingSec;
      if (!isFinite(remaining) || remaining <= 0) continue;
      if (!best || remaining < best.remaining) {
        best = { policy: p, rule: r, remaining };
      }
    }
  }
  return best;
}

function render() {
  renderHeader();
  renderWarn();
  renderTrack();
  renderPolicies();
}

function renderTrack() {
  const banner = qs('#track-banner');
  if (!currentHost || matchedDomain) {
    banner.classList.add('hidden');
    return;
  }
  banner.classList.remove('hidden');
  qs('#track-host').textContent = currentHost.replace(/^www\./, '');
}

function renderWarn() {
  const banner = qs('#warn-banner');
  const tight = tightestActiveRule();
  if (!tight || tight.remaining > WARN_THRESHOLD_SEC) {
    banner.classList.add('hidden');
    return;
  }

  banner.classList.remove('hidden');
  qs('#warn-seconds').textContent = Math.max(0, Math.ceil(tight.remaining));
  qs('#warn-sub').textContent = tight.policy.name + ' · ' + matchedDomain;

  const extendBtn = qs('#warn-extend');
  if (tight.rule.type === 'daily') {
    extendBtn.classList.remove('hidden');
    if (extendBtn.dataset.ruleId !== tight.rule.id) {
      extendBtn.dataset.ruleId = tight.rule.id;
      extendBtn.disabled = false;
      extendBtn.textContent = '+1 min';
    }
  } else {
    extendBtn.classList.add('hidden');
    delete extendBtn.dataset.ruleId;
  }
}

function renderHeader() {
  const nameEl = qs('#site-name');
  const timeEl = qs('#site-time');

  if (!currentHost) {
    nameEl.textContent = 'Curb';
    timeEl.textContent = '';
    return;
  }

  nameEl.textContent = matchedDomain || currentHost;
  if (matchedDomain) {
    const sec = state.usage[matchedDomain] || 0;
    const min = Math.floor(sec / 60);
    timeEl.textContent = min + 'm today';
  } else {
    timeEl.textContent = 'untracked';
  }
}

function renderPolicies() {
  const list = qs('#policy-list');
  const empty = qs('#empty-state');
  const policies = (state.policies || []).slice().sort((a, b) => a.name.localeCompare(b.name));

  if (!policies.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    lastPolicyKey = '';
    return;
  }
  empty.classList.add('hidden');

  // Cache key: policies + their rules + active match (for highlight border)
  const key = policies
    .map((p) => `${p.id}:${p.rules.map((r) => r.id + ':' + r.type).join('|')}`)
    .join(',') + '|' + (matchedDomain || '');

  if (key !== lastPolicyKey) {
    lastPolicyKey = key;
    buildCards(list, policies);
  }

  // Per-tick: update stats
  for (const p of policies) {
    const card = qs(`[data-policy-id="${p.id}"]`, list);
    if (!card) continue;
    let tightest = 0;
    for (const r of p.rules) {
      const e = state.ruleEvals && state.ruleEvals[r.id];
      const row = qs(`.rule-row[data-rule-id="${r.id}"]`, card);
      if (!row) continue;
      const fill = qs('.rule-fill', row);
      const text = qs('.rule-stat', row);
      if (e) {
        const pct = Math.min(100, Math.max(0, e.progress * 100));
        fill.style.width = pct + '%';
        fill.style.background = statusColor(pct);
        text.textContent = ruleStat(e);
        if (e.progress > tightest) tightest = e.progress;
      } else {
        fill.style.width = '0%';
        text.textContent = '—';
      }
    }
    const color = p.rules.length ? statusColor(tightest * 100) : 'var(--border-strong)';
    card.style.borderLeftColor = color;
  }
}

function buildCards(list, policies) {
  let html = '';
  for (const p of policies) {
    const isActive = matchedDomain && p.domains.includes(matchedDomain);
    let rulesHtml = '';
    if (!p.rules.length) {
      rulesHtml = `<div class="rule-empty">tracking only</div>`;
    } else {
      for (const r of p.rules) {
        rulesHtml += `
          <div class="rule-row" data-rule-id="${esc(r.id)}">
            <div class="rule-line">
              <span class="rule-kind">${esc(ruleKindLabel(r))}</span>
              <span class="rule-stat">—</span>
            </div>
            <div class="rule-track"><div class="rule-fill"></div></div>
          </div>`;
      }
    }
    html += `
      <div class="policy-card${isActive ? ' active' : ''}" data-policy-id="${esc(p.id)}">
        <div class="policy-head">
          <span class="policy-name">${esc(p.name)}</span>
          <span class="policy-meta">${p.domains.length} site${p.domains.length === 1 ? '' : 's'}</span>
        </div>
        ${rulesHtml}
      </div>`;
  }
  list.innerHTML = html;

  for (const card of qsa('.policy-card', list)) {
    card.addEventListener('click', () => openPolicy(card.dataset.policyId));
  }
}

function openPolicy(id) {
  browser.tabs.create({
    url: browser.runtime.getURL('edit/main.html?policy=' + encodeURIComponent(id)),
  });
  window.close();
}

/***************
 * Init
 ***************/

(async () => {
  await loadCurrentTab();
  await fetchStatus();
})();
refreshTimer = setInterval(fetchStatus, 1000);

qs('#manage-btn').addEventListener('click', () => {
  browser.tabs.create({
    url: browser.runtime.getURL('edit/main.html'),
  });
  window.close();
});

qs('#track-btn').addEventListener('click', () => {
  if (!currentHost) return;
  const domain = currentHost.replace(/^www\./, '');
  browser.tabs.create({
    url: browser.runtime.getURL(
      'edit/main.html?newPolicyDomain=' + encodeURIComponent(domain)
    ),
  });
  window.close();
});

qs('#warn-extend').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const ruleId = btn.dataset.ruleId;
  if (!ruleId || btn.disabled) return;
  btn.disabled = true;
  const resp = await browser.runtime.sendMessage({ type: 'extendTime', ruleId });
  if (!resp || !resp.success) {
    btn.textContent = 'used';
  } else {
    fetchStatus();
  }
});

window.addEventListener('unload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
