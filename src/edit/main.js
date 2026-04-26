const params = new URLSearchParams(location.search);
const targetDomain = params.get('domain') || '';
const targetPolicyId = params.get('policy') || '';
const targetView = params.get('view') || '';

const EXPORT_FORMAT = 'curb-export-v1';

let policies = [];
let ruleEvals = {};
let todayUsage = {};
let statusTimer = null;

/***************
 * Load / Save
 ***************/

async function load() {
  const data = await browser.storage.local.get('policies');
  policies = data.policies || [];

  renderSidebar();
  resolveView();
  if (targetView === 'settings') renderSync();
  pollStatus();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(pollStatus, 1000);
}

async function savePolicies() {
  await browser.storage.local.set({ policies });
}

async function pollStatus() {
  try {
    const status = await browser.runtime.sendMessage({ type: 'getStatus' });
    if (!status) return;
    ruleEvals = status.ruleEvals || {};
    todayUsage = status.usage || {};
    updateStatus();
  } catch {}
}

/***************
 * Helpers
 ***************/

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function trackedDomains() {
  const set = new Set();
  for (const p of policies) for (const d of p.domains) set.add(d);
  return Array.from(set).sort();
}

function nextPolicyName() {
  const used = new Set(policies.map((p) => p.name));
  let n = 1;
  while (used.has(`Policy ${n}`)) n++;
  return `Policy ${n}`;
}

function ruleSummary(r) {
  if (r.type === 'daily') return `${r.minutes}m / day`;
  if (r.type === 'bucket') return `${r.capacityMin}m per ${r.windowMin}m`;
  return 'rule';
}

function ruleTypeName(r) {
  if (r.type === 'daily') return 'Daily cap';
  if (r.type === 'bucket') return 'Rate (leaky bucket)';
  return 'Rule';
}

function policyMeta(p) {
  const r = `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'}`;
  const d = `${p.domains.length} site${p.domains.length === 1 ? '' : 's'}`;
  return `${r} · ${d}`;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  if (sec < 60) return sec + 's';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

/***************
 * View routing
 ***************/

function resolveView() {
  qs('#site-view').classList.add('hidden');
  qs('#policy-view').classList.add('hidden');
  qs('#settings-view').classList.add('hidden');
  qs('#empty-view').classList.add('hidden');

  if (targetView === 'settings') {
    qs('#settings-view').classList.remove('hidden');
    qs('#settings-link').classList.add('active');
    return;
  }

  const domains = trackedDomains();

  if (targetDomain && domains.includes(targetDomain)) {
    qs('#site-view').classList.remove('hidden');
    renderSiteView();
    return;
  }

  if (targetPolicyId) {
    const p = policies.find((x) => x.id === targetPolicyId);
    if (p) {
      qs('#policy-view').classList.remove('hidden');
      renderPolicyView(p);
      return;
    }
  }

  if (policies.length) {
    location.href = 'main.html?policy=' + encodeURIComponent(policies[0].id);
    return;
  }

  qs('#empty-view').classList.remove('hidden');
}

/***************
 * Sidebar
 ***************/

function renderSidebar() {
  // Sites — derived from policy.domains
  const sList = qs('#sidebar-sites');
  sList.innerHTML = '';
  const domains = trackedDomains();
  if (!domains.length) {
    const el = document.createElement('div');
    el.className = 'sidebar-empty';
    el.textContent = 'No sites yet.';
    sList.appendChild(el);
  } else {
    for (const d of domains) {
      const el = document.createElement('a');
      el.className = 'sidebar-item';
      el.href = 'main.html?domain=' + encodeURIComponent(d);
      el.textContent = d;
      if (d === targetDomain) el.classList.add('active');
      sList.appendChild(el);
    }
  }

  // Policies
  const pList = qs('#sidebar-policies');
  pList.innerHTML = '';
  if (!policies.length) {
    const el = document.createElement('div');
    el.className = 'sidebar-empty';
    el.textContent = 'No policies yet.';
    pList.appendChild(el);
  } else {
    const sorted = policies.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const p of sorted) {
      const el = document.createElement('a');
      el.className = 'sidebar-item sidebar-limit';
      el.href = 'main.html?policy=' + encodeURIComponent(p.id);
      el.innerHTML = `
        <span class="sidebar-limit-label">${esc(p.name)}</span>
        <span class="sidebar-limit-meta">${esc(policyMeta(p))}</span>
      `;
      if (p.id === targetPolicyId) el.classList.add('active');
      pList.appendChild(el);
    }
  }
}

/***************
 * Tabs (site view)
 ***************/

function switchSiteTab(name) {
  for (const t of qsa('#site-tabs .tab')) {
    t.classList.toggle('active', t.dataset.tab === name);
  }
  qs('#site-policies-panel').classList.toggle('active', name === 'policies');
  qs('#site-history-panel').classList.toggle('active', name === 'history');
  if (name === 'history') loadHistory();
}

qsa('#site-tabs .tab').forEach((t) => {
  t.addEventListener('click', () => switchSiteTab(t.dataset.tab));
});

/***************
 * Site view
 ***************/

function renderSiteView() {
  const list = qs('#site-policies-list');
  list.innerHTML = '';

  const applicable = policies.filter((p) => p.domains.includes(targetDomain));

  if (!applicable.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No policies cover this site. It will be tracked but never blocked.';
    list.appendChild(empty);
  } else {
    for (const p of applicable) {
      const card = document.createElement('a');
      card.className = 'policy-link';
      card.href = 'main.html?policy=' + encodeURIComponent(p.id);
      let rulesHtml = '';
      if (!p.rules.length) {
        rulesHtml = `<div class="policy-link-empty">No rules — tracking only.</div>`;
      } else {
        for (const r of p.rules) {
          rulesHtml += `
            <div class="policy-rule-mini" data-rule-id="${esc(r.id)}">
              <span class="policy-rule-mini-kind">${esc(ruleTypeName(r))}</span>
              <span class="policy-rule-mini-summary">${esc(ruleSummary(r))}</span>
              <div class="status-track"><div class="status-fill"></div></div>
              <span class="status-text">—</span>
            </div>`;
        }
      }
      card.innerHTML = `
        <div class="policy-link-head">
          <span class="policy-link-name">${esc(p.name)}</span>
          <span class="policy-link-meta">${esc(policyMeta(p))}</span>
        </div>
        ${rulesHtml}`;
      list.appendChild(card);
    }
  }

  updateStatus();
}

/***************
 * Policy view
 ***************/

function renderPolicyView(p) {
  // Name
  const nameInput = qs('#policy-name-input');
  nameInput.value = p.name;
  nameInput.oninput = null;
  nameInput.addEventListener('change', async () => {
    const v = nameInput.value.trim();
    if (!v) {
      nameInput.value = p.name;
      return;
    }
    p.name = v;
    await savePolicies();
    renderSidebar();
  });

  renderRules(p);
  renderPolicyDomains(p);
  refreshAddRuleOptions(p);
  updateStatus();
}

function refreshAddRuleOptions(p) {
  const select = qs('#add-rule-type');
  if (!select) return;
  const dailyOpt = qs('option[value="daily"]', select);
  const policyHasDaily = p.rules.some((r) => r.type === 'daily');
  const conflict =
    !policyHasDaily &&
    p.domains.some((d) =>
      policies.some(
        (other) =>
          other.id !== p.id && other.rules.some((r) => r.type === 'daily') && other.domains.includes(d)
      )
    );

  if (policyHasDaily) {
    dailyOpt.disabled = true;
    dailyOpt.textContent = 'Daily cap (already added)';
  } else if (conflict) {
    dailyOpt.disabled = true;
    dailyOpt.textContent = 'Daily cap (a domain is already covered by another policy)';
  } else {
    dailyOpt.disabled = false;
    dailyOpt.textContent = 'Daily cap';
  }

  if (dailyOpt.disabled && select.value === 'daily') select.value = 'bucket';
}

function renderRules(p) {
  const list = qs('#rules-list');
  list.innerHTML = '';

  if (!p.rules.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No rules. This policy tracks usage on its domains but never blocks.';
    list.appendChild(empty);
    return;
  }

  for (const r of p.rules) {
    const el = document.createElement('div');
    el.className = 'limit-row';
    el.dataset.ruleId = r.id;
    el.innerHTML = renderRuleRow(r);
    attachRuleHandlers(el, p, r);
    list.appendChild(el);
  }
}

function renderRuleRow(r) {
  const removeBtn = `<button class="btn btn-ghost btn-remove" data-rule-id="${esc(r.id)}">Remove</button>`;
  const status = `
    <div class="limit-status">
      <div class="status-track"><div class="status-fill"></div></div>
      <span class="status-text">—</span>
    </div>`;

  if (r.type === 'daily') {
    return `
      <div class="limit-kind">Daily cap</div>
      <div class="limit-fields">
        <input type="number" class="fld-minutes" value="${r.minutes}" min="0" max="1440">
        <span>min / day</span>
      </div>
      ${status}
      <div class="limit-desc">Blocks the policy when total daily time across its domains exceeds the cap.</div>
      ${removeBtn}`;
  }

  if (r.type === 'bucket') {
    return `
      <div class="limit-kind">Rate (leaky bucket)</div>
      <div class="limit-fields">
        <input type="number" class="fld-capacity" value="${r.capacityMin}" min="0" max="1440">
        <span>min per</span>
        <input type="number" class="fld-window" value="${r.windowMin}" min="1" max="1440">
        <span>min window</span>
      </div>
      ${status}
      <div class="limit-desc">Grants up to <strong>${r.capacityMin}</strong> min of access shared across domains, refilling continuously over a <strong>${r.windowMin}</strong> min window.</div>
      ${removeBtn}`;
  }

  return `<div class="limit-kind">Unknown rule</div>${removeBtn}`;
}

function attachRuleHandlers(el, p, r) {
  if (r.type === 'daily') {
    const f = qs('.fld-minutes', el);
    f.addEventListener('change', async () => {
      const v = parseInt(f.value, 10);
      if (isNaN(v) || v < 0) return;
      r.minutes = v;
      await savePolicies();
    });
  }
  if (r.type === 'bucket') {
    const c = qs('.fld-capacity', el);
    const w = qs('.fld-window', el);
    const onChange = async () => {
      const cv = parseInt(c.value, 10);
      const wv = parseInt(w.value, 10);
      if (isNaN(cv) || cv < 0 || isNaN(wv) || wv < 1) return;
      r.capacityMin = cv;
      r.windowMin = wv;
      await savePolicies();
      renderRules(p);
    };
    c.addEventListener('change', onChange);
    w.addEventListener('change', onChange);
  }

  const rm = qs('.btn-remove', el);
  if (rm) rm.addEventListener('click', () => removeRule(p, r));
}

async function removeRule(p, r) {
  p.rules = p.rules.filter((x) => x.id !== r.id);
  await savePolicies();
  renderRules(p);
  refreshAddRuleOptions(p);
  renderSidebar();
}

async function addRule(p, type) {
  let rule;
  if (type === 'daily') {
    if (p.rules.some((r) => r.type === 'daily')) return;
    rule = { id: newId(), type: 'daily', minutes: 30 };
  } else if (type === 'bucket') {
    rule = { id: newId(), type: 'bucket', capacityMin: 5, windowMin: 30 };
  } else return;
  p.rules.push(rule);
  await savePolicies();
  renderRules(p);
  refreshAddRuleOptions(p);
  renderSidebar();
}

/***************
 * Policy domains
 ***************/

function dailyConflictsFor(p, domain) {
  // Returns the conflicting policy if `domain` is covered by another policy's daily rule.
  const policyHasDaily = p.rules.some((r) => r.type === 'daily');
  if (!policyHasDaily) return null;
  return policies.find(
    (other) =>
      other.id !== p.id &&
      other.rules.some((r) => r.type === 'daily') &&
      other.domains.includes(domain)
  ) || null;
}

function renderPolicyDomains(p) {
  qs('#policy-domain-count').textContent = String(p.domains.length);
  const list = qs('#policy-domains');
  list.innerHTML = '';

  const universe = new Set([...trackedDomains(), ...p.domains]);
  const domains = Array.from(universe).sort();

  for (const d of domains) {
    const checked = p.domains.includes(d);
    let disabledReason = '';
    if (!checked) {
      const conflict = dailyConflictsFor(p, d);
      if (conflict) disabledReason = `Already covered by "${conflict.name}"`;
    }

    const id = 'dom-' + d.replace(/\W+/g, '-');
    const row = document.createElement('label');
    row.className = 'domain-row' + (disabledReason ? ' disabled' : '');
    row.htmlFor = id;
    row.dataset.domain = d;
    row.innerHTML = `
      <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabledReason ? 'disabled' : ''}>
      <span class="domain-name">${esc(d)}</span>
      ${disabledReason ? `<span class="domain-note">${esc(disabledReason)}</span>` : ''}
      ${checked ? `<span class="domain-time">—</span>` : ''}
    `;
    const cb = qs('input', row);
    cb.addEventListener('change', async () => {
      if (cb.checked) {
        if (!p.domains.includes(d)) p.domains.push(d);
      } else {
        p.domains = p.domains.filter((x) => x !== d);
      }
      await savePolicies();
      renderPolicyDomains(p);
      refreshAddRuleOptions(p);
      renderSidebar();
    });
    list.appendChild(row);
  }

  const addRow = document.createElement('div');
  addRow.className = 'domain-add';
  addRow.innerHTML = `
    <input type="text" id="domain-add-input" placeholder="add domain (e.g. reddit.com)" spellcheck="false">
    <button type="button" id="domain-add-btn" class="btn btn-ghost btn-add-domain">Add</button>
  `;
  list.appendChild(addRow);

  const input = qs('#domain-add-input', addRow);
  const btn = qs('#domain-add-btn', addRow);
  const submit = async () => {
    const raw = input.value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
    if (!raw || !raw.includes('.')) return;
    if (p.domains.includes(raw)) {
      input.value = '';
      return;
    }
    if (dailyConflictsFor(p, raw)) {
      input.value = '';
      return;
    }
    p.domains.push(raw);
    await savePolicies();
    renderPolicyDomains(p);
    refreshAddRuleOptions(p);
    renderSidebar();
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
}

/***************
 * Status updates
 ***************/

function applyStatus(fillEl, textEl, e) {
  if (!fillEl || !textEl) return;
  if (!e) {
    fillEl.style.width = '0%';
    textEl.textContent = '—';
    return;
  }
  const pct = Math.min(100, Math.max(0, e.progress * 100));
  fillEl.style.width = pct + '%';
  fillEl.style.background = statusColor(pct);
  if (e.type === 'daily') {
    textEl.textContent = `${fmtDuration(e.current)} / ${fmtDuration(e.limit)}`;
  } else if (e.type === 'bucket') {
    const remaining = Math.max(0, e.limit - e.current);
    textEl.textContent = `${fmtDuration(remaining)} available`;
  }
}

function updateStatus() {
  // Site view: per-rule mini status inside each policy card
  for (const mini of qsa('#site-policies-list .policy-rule-mini')) {
    const id = mini.dataset.ruleId;
    applyStatus(qs('.status-fill', mini), qs('.status-text', mini), ruleEvals[id]);
  }
  // Policy view: per-rule status inside each rule row
  for (const row of qsa('#rules-list .limit-row')) {
    const id = row.dataset.ruleId;
    applyStatus(qs('.status-fill', row), qs('.status-text', row), ruleEvals[id]);
  }
  // Policy view: per-domain time spent today
  for (const row of qsa('#policy-domains .domain-row')) {
    const t = qs('.domain-time', row);
    if (!t) continue;
    const sec = todayUsage[row.dataset.domain] || 0;
    t.textContent = `${fmtDuration(sec)} today`;
  }
}

/***************
 * History (site view)
 ***************/

function todayKey() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatHistoryDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

async function loadHistory() {
  const panel = qs('#site-history-panel');
  panel.innerHTML = '<div class="empty">Loading…</div>';

  const data = await browser.storage.local.get('usage');
  const usage = data.usage || {};

  const rows = [];
  for (const [date, dayUsage] of Object.entries(usage)) {
    const sec = dayUsage[targetDomain];
    if (typeof sec === 'number' && sec > 0) rows.push({ date, sec });
  }
  rows.sort((a, b) => b.date.localeCompare(a.date));

  renderHistory(rows);
}

function renderHistory(rows) {
  const panel = qs('#site-history-panel');
  panel.innerHTML = '';

  if (!rows.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No history yet for this site.';
    panel.appendChild(empty);
    return;
  }

  const totalSec = rows.reduce((s, r) => s + r.sec, 0);
  const days = rows.length;
  const avg = totalSec / days;

  const summary = document.createElement('div');
  summary.className = 'history-summary';
  summary.innerHTML = `
    <div class="history-stat">
      <div class="history-stat-label">Total</div>
      <div class="history-stat-value">${esc(fmtDuration(totalSec))}</div>
    </div>
    <div class="history-stat">
      <div class="history-stat-label">${days === 1 ? 'Day' : 'Days'}</div>
      <div class="history-stat-value">${days}</div>
    </div>
    <div class="history-stat">
      <div class="history-stat-label">Avg / day</div>
      <div class="history-stat-value">${esc(fmtDuration(avg))}</div>
    </div>
  `;
  panel.appendChild(summary);

  const maxSec = Math.max(...rows.map((r) => r.sec));
  const today = todayKey();
  const chronological = rows.slice().reverse(); // oldest → today

  const wrap = document.createElement('div');
  wrap.className = 'history-chart-wrap';

  // Plot area: y-axis labels + bars
  const area = document.createElement('div');
  area.className = 'history-chart-area';

  const yAxis = document.createElement('div');
  yAxis.className = 'history-y';
  yAxis.innerHTML = `
    <span>${esc(fmtDuration(maxSec))}</span>
    <span>${esc(fmtDuration(maxSec / 2))}</span>
    <span>0</span>
  `;
  area.appendChild(yAxis);

  const plot = document.createElement('div');
  plot.className = 'history-plot';

  const bars = document.createElement('div');
  bars.className = 'history-bars';
  bars.innerHTML = chronological
    .map(({ date, sec }) => {
      const pct = Math.max(1.5, (sec / maxSec) * 100);
      const cls = 'history-bar' + (date === today ? ' today' : '');
      return `<div class="${cls}" data-date="${esc(date)}" data-sec="${sec}" style="height:${pct}%"></div>`;
    })
    .join('');
  plot.appendChild(bars);
  area.appendChild(plot);
  wrap.appendChild(area);

  // X-axis label row
  const x = document.createElement('div');
  x.className = 'history-x';
  if (chronological.length === 1) {
    x.innerHTML = `<span>${esc(formatHistoryDate(chronological[0].date))}</span>`;
  } else {
    x.innerHTML = `
      <span>${esc(formatHistoryDate(chronological[0].date))}</span>
      <span>${esc(formatHistoryDate(chronological[chronological.length - 1].date))}</span>
    `;
  }
  wrap.appendChild(x);

  panel.appendChild(wrap);

  attachHistoryTooltips(bars);
}

function attachHistoryTooltips(barsEl) {
  const tip = qs('#history-tooltip');
  let visible = false;

  const show = (bar, ev) => {
    const date = bar.dataset.date;
    const sec = parseInt(bar.dataset.sec, 10) || 0;
    tip.innerHTML = `
      <div class="history-tooltip-date">${esc(formatHistoryDate(date))}</div>
      <div class="history-tooltip-time">${esc(fmtDuration(sec))}</div>
    `;
    tip.classList.remove('hidden');
    visible = true;
    position(ev);
  };

  const position = (ev) => {
    if (!visible) return;
    const offset = 12;
    let x = ev.clientX + offset;
    let y = ev.clientY + offset;
    const rect = tip.getBoundingClientRect();
    if (x + rect.width > window.innerWidth - 8) x = ev.clientX - rect.width - offset;
    if (y + rect.height > window.innerHeight - 8) y = ev.clientY - rect.height - offset;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  };

  const hide = () => {
    visible = false;
    tip.classList.add('hidden');
  };

  for (const bar of qsa('.history-bar', barsEl)) {
    bar.addEventListener('mouseenter', (e) => show(bar, e));
    bar.addEventListener('mousemove', position);
    bar.addEventListener('mouseleave', hide);
  }
}

/***************
 * Modal
 ***************/

function confirmModal({ title, message, okLabel = 'OK', cancelLabel = 'Cancel', alert = false }) {
  return new Promise((resolve) => {
    const backdrop = qs('#modal-backdrop');
    qs('#modal-title').textContent = title;
    qs('#modal-message').textContent = message;
    const okBtn = qs('#modal-ok');
    const cancelBtn = qs('#modal-cancel');
    okBtn.textContent = okLabel;
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.display = alert ? 'none' : '';

    backdrop.classList.remove('hidden');
    okBtn.focus();

    const cleanup = () => {
      backdrop.classList.add('hidden');
      cancelBtn.style.display = '';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e) => { if (e.target === backdrop) onCancel(); };
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

function alertModal({ title, message, okLabel = 'OK' }) {
  return confirmModal({ title, message, okLabel, alert: true });
}

/***************
 * Actions
 ***************/

async function createPolicy(initialDomains = []) {
  const policy = {
    id: newId(),
    name: nextPolicyName(),
    domains: initialDomains.slice(),
    rules: [],
  };
  policies.push(policy);
  await savePolicies();
  location.href = 'main.html?policy=' + encodeURIComponent(policy.id);
}

async function removeCurrentSite() {
  const ok = await confirmModal({
    title: `Stop tracking ${targetDomain}?`,
    message:
      'Removes this domain from every policy. Any policy left covering no domains will become inert (you can re-attach domains later). Recorded history is preserved.',
    okLabel: 'Stop tracking',
  });
  if (!ok) return;

  let touched = false;
  for (const p of policies) {
    if (p.domains.includes(targetDomain)) {
      p.domains = p.domains.filter((d) => d !== targetDomain);
      touched = true;
    }
  }
  if (touched) await savePolicies();

  const remaining = trackedDomains();
  if (remaining.length) {
    location.href = 'main.html?domain=' + encodeURIComponent(remaining[0]);
  } else if (policies.length) {
    location.href = 'main.html?policy=' + encodeURIComponent(policies[0].id);
  } else {
    location.href = 'main.html';
  }
}

/***************
 * Export / import
 ***************/

function buildExport() {
  return {
    format: EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    policies,
  };
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportPolicies() {
  const data = buildExport();
  const stamp = new Date().toISOString().slice(0, 10);
  downloadFile(`curb-policies-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json');
}

function validateImport(parsed) {
  if (!parsed || typeof parsed !== 'object') return 'Not a JSON object.';
  if (parsed.format !== EXPORT_FORMAT) return `Unrecognized format: ${parsed.format || '(missing)'}.`;
  if (!Array.isArray(parsed.policies)) return 'Missing "policies" array.';
  for (const p of parsed.policies) {
    if (!p || typeof p !== 'object') return 'Policy entry is not an object.';
    if (typeof p.id !== 'string' || typeof p.name !== 'string') return 'Policy missing id or name.';
    if (!Array.isArray(p.domains) || !p.domains.every((d) => typeof d === 'string')) {
      return 'Policy domains must be an array of strings.';
    }
    if (!Array.isArray(p.rules)) return 'Policy rules must be an array.';
    for (const r of p.rules) {
      if (!r || typeof r.id !== 'string' || typeof r.type !== 'string') return 'Rule missing id or type.';
      if (r.type === 'daily' && typeof r.minutes !== 'number') return 'Daily rule missing minutes.';
      if (r.type === 'bucket' && (typeof r.capacityMin !== 'number' || typeof r.windowMin !== 'number')) {
        return 'Bucket rule missing capacityMin or windowMin.';
      }
    }
  }
  return null;
}

async function importPoliciesFromFile(file) {
  let text;
  try {
    text = await file.text();
  } catch {
    return alertModal({ title: 'Import failed', message: 'Could not read file.' });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return alertModal({ title: 'Import failed', message: 'File is not valid JSON.' });
  }

  const err = validateImport(parsed);
  if (err) {
    return alertModal({ title: 'Import failed', message: err });
  }

  const ok = await confirmModal({
    title: 'Replace all policies?',
    message: `This replaces your current ${policies.length} polic${policies.length === 1 ? 'y' : 'ies'} with ${parsed.policies.length} from the file.`,
    okLabel: 'Replace and import',
  });
  if (!ok) return;

  await browser.storage.local.set({ policies: parsed.policies });
  location.href = 'main.html?view=settings';
}

async function removeCurrentPolicy() {
  const p = policies.find((x) => x.id === targetPolicyId);
  if (!p) return;
  const ok = await confirmModal({
    title: `Remove "${p.name}"?`,
    message: `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'} on ${p.domains.length} site${p.domains.length === 1 ? '' : 's'} will be deleted.`,
    okLabel: 'Remove',
  });
  if (!ok) return;

  policies = policies.filter((x) => x.id !== targetPolicyId);
  await savePolicies();

  if (policies.length) {
    location.href = 'main.html?policy=' + encodeURIComponent(policies[0].id);
  } else {
    location.href = 'main.html';
  }
}

/***************
 * Init / event wiring
 ***************/

qs('#sidebar-add-policy').addEventListener('click', () => createPolicy());

qs('#site-add-policy-btn').addEventListener('click', () => {
  if (targetDomain) createPolicy([targetDomain]);
});

qs('#add-rule-btn').addEventListener('click', () => {
  const p = policies.find((x) => x.id === targetPolicyId);
  if (!p) return;
  addRule(p, qs('#add-rule-type').value);
});

qs('#remove-site-btn').addEventListener('click', removeCurrentSite);
qs('#remove-policy-btn').addEventListener('click', removeCurrentPolicy);

qs('#export-btn').addEventListener('click', exportPolicies);
qs('#import-btn').addEventListener('click', () => qs('#import-file').click());
qs('#import-file').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) importPoliciesFromFile(file);
  e.target.value = '';
});

/***************
 * Sync UI
 ***************/

let syncCodeEmail = '';

function showSyncStep(name) {
  qs('#sync-step-email').classList.toggle('hidden', name !== 'email');
  qs('#sync-step-code').classList.toggle('hidden', name !== 'code');
  qs('#sync-step-signed-in').classList.toggle('hidden', name !== 'in');
}

function showSyncError(message) {
  const el = qs('#sync-error');
  if (!message) {
    el.textContent = '';
    el.classList.add('hidden');
    return;
  }
  el.textContent = message;
  el.classList.remove('hidden');
}

function relativeTimeAgo(ts) {
  if (!ts) return null;
  const ms = Date.now() - ts;
  if (ms < 5_000) return 'just now';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

async function renderSync() {
  showSyncError('');
  const session = await getSession();
  const badge = qs('#sync-status-badge');

  if (!session) {
    badge.textContent = 'Signed out';
    showSyncStep('email');
    return;
  }

  badge.textContent = 'Signed in';
  qs('#sync-account-email').textContent = session.email;
  showSyncStep('in');

  const state = await getSyncState();
  const lastMeta = qs('#sync-last-meta');
  if (state.lastError) {
    lastMeta.textContent = state.lastError;
  } else if (state.lastSyncedAt) {
    lastMeta.textContent = `Last synced ${relativeTimeAgo(state.lastSyncedAt)} · v${state.version}`;
  } else {
    lastMeta.textContent = 'Never synced.';
  }
}

async function handleSendCode() {
  showSyncError('');
  const email = qs('#sync-email-input').value.trim();
  if (!email) return;
  const btn = qs('#sync-send-code-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  try {
    await requestCode(email);
    syncCodeEmail = email;
    qs('#sync-code-recipient').textContent = email;
    qs('#sync-code-input').value = '';
    showSyncStep('code');
    setTimeout(() => qs('#sync-code-input').focus(), 0);
  } catch (err) {
    showSyncError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send code';
  }
}

async function handleVerify() {
  showSyncError('');
  const code = qs('#sync-code-input').value.trim();
  if (!code || !syncCodeEmail) return;
  const btn = qs('#sync-verify-btn');
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  try {
    await verifyCode(syncCodeEmail, code);
    syncCodeEmail = '';
    qs('#sync-email-input').value = '';
    qs('#sync-code-input').value = '';
    await renderSync();
    // Auto-pull on first sign-in.
    try {
      await syncNow();
    } catch (err) {
      showSyncError('Signed in, but initial sync failed: ' + err.message);
    }
    await renderSync();
    // Refresh policies UI in case sync pulled new data.
    const data = await browser.storage.local.get('policies');
    policies = data.policies || [];
    renderSidebar();
  } catch (err) {
    showSyncError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
}

async function handleSyncNow() {
  showSyncError('');
  const btn = qs('#sync-now-btn');
  btn.disabled = true;
  btn.textContent = 'Syncing…';
  try {
    const result = await syncNow();
    if (result.status === 'pulled' || result.status === 'conflict') {
      const data = await browser.storage.local.get('policies');
      policies = data.policies || [];
      renderSidebar();
    }
    await renderSync();
  } catch (err) {
    showSyncError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
}

async function handleSignOut() {
  const ok = await confirmModal({
    title: 'Sign out?',
    message: 'Local policies stay on this device. Sync stops until you sign in again.',
    okLabel: 'Sign out',
  });
  if (!ok) return;
  await signOut();
  await renderSync();
}

qs('#sync-send-code-btn').addEventListener('click', handleSendCode);
qs('#sync-email-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleSendCode();
});
qs('#sync-verify-btn').addEventListener('click', handleVerify);
qs('#sync-code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') handleVerify();
});
qs('#sync-cancel-link').addEventListener('click', (e) => {
  e.preventDefault();
  syncCodeEmail = '';
  showSyncError('');
  showSyncStep('email');
});
qs('#sync-resend-link').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!syncCodeEmail) return;
  showSyncError('');
  try {
    await requestCode(syncCodeEmail);
  } catch (err) {
    showSyncError(err.message);
  }
});
qs('#sync-now-btn').addEventListener('click', handleSyncNow);
qs('#sync-out-btn').addEventListener('click', handleSignOut);

window.addEventListener('unload', () => {
  if (statusTimer) clearInterval(statusTimer);
});

load();
