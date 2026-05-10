const params = new URLSearchParams(location.search);
const targetDomain = params.get('domain') || '';
const targetPolicyId = params.get('policy') || '';
const targetView = params.get('view') || '';

const EXPORT_FORMAT = 'curb-export-v1';

let policies = [];
let devices = [];
let ruleEvals = {};
let todayUsage = {};
let statusTimer = null;

// Cached full remote history while the history view is open. Populated lazily.
let historyRemoteCache = null;

/***************
 * Load / Save
 ***************/

async function load() {
  const data = await browser.storage.local.get(['policies', 'devices']);
  policies = data.policies || [];
  devices = data.devices || [];

  renderSidebar();
  resolveView();
  if (targetView === 'settings') {
    renderSync();
    renderDevices();
  }
  pollStatus();
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(pollStatus, 1000);

  autoSync();
}

async function saveDevices() {
  await browser.storage.local.set({ devices });
}

// Best-effort sync on page open. Silent on failure — manual sync surfaces errors.
async function autoSync() {
  if (!(await getSession())) return;
  const onSettings = targetView === 'settings';
  try {
    const result = await syncNow();
    if (result.policies.status === 'pulled' || result.policies.status === 'merged') {
      const data = await browser.storage.local.get('policies');
      policies = data.policies || [];
      renderSidebar();
      // The current view may now point at a tombstoned policy or stale state;
      // re-resolve so the user lands somewhere coherent.
      resolveView();
    }
    if (result.devices.status === 'pulled' || result.devices.status === 'merged') {
      const data = await browser.storage.local.get('devices');
      devices = data.devices || [];
      if (onSettings) renderDevices();
    }
    if (onSettings) renderSync();
  } catch {}
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

function touchPolicy(p) {
  p.updated_at = Date.now();
}

function livePolicies() {
  return policies.filter((p) => !p.deleted);
}

function trackedDomains() {
  const set = new Set();
  for (const p of livePolicies()) for (const d of p.domains) set.add(d);
  return Array.from(set).sort();
}

function nextPolicyName() {
  const used = new Set(livePolicies().map((p) => p.name));
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
    const p = livePolicies().find((x) => x.id === targetPolicyId);
    if (p) {
      qs('#policy-view').classList.remove('hidden');
      renderPolicyView(p);
      return;
    }
  }

  const live = livePolicies();
  if (live.length) {
    location.href = 'main.html?policy=' + encodeURIComponent(live[0].id);
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
  const live = livePolicies();
  if (!live.length) {
    const el = document.createElement('div');
    el.className = 'sidebar-empty';
    el.textContent = 'No policies yet.';
    pList.appendChild(el);
  } else {
    const sorted = live.slice().sort((a, b) => a.name.localeCompare(b.name));
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

  const applicable = livePolicies().filter((p) => p.domains.includes(targetDomain));

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
    touchPolicy(p);
    await savePolicies();
    renderSidebar();
  });

  renderRules(p);
  renderPolicyDomains(p);
  renderSchedule(p);
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
      livePolicies().some(
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
      touchPolicy(p);
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
      touchPolicy(p);
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
  touchPolicy(p);
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
  touchPolicy(p);
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
  return livePolicies().find(
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
      touchPolicy(p);
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
    touchPolicy(p);
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
 * Schedule
 ***************/

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const SCHEDULE_PRESETS = {
  always: { windows: [] },
  workdays: { windows: [{ days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 }] },
  weekends: { windows: [{ days: [0, 6], startMin: 0, endMin: 24 * 60 }] },
};

function emptySchedule() {
  return { windows: [] };
}

function schedulesEqual(a, b) {
  return JSON.stringify(a || emptySchedule()) === JSON.stringify(b || emptySchedule());
}

function detectPreset(schedule) {
  if (!schedule || !schedule.windows || !schedule.windows.length) return 'always';
  for (const [name, preset] of Object.entries(SCHEDULE_PRESETS)) {
    if (schedulesEqual(schedule, preset)) return name;
  }
  return 'custom';
}

function minToHHMM(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

function hhmmToMin(s) {
  const [h, m] = (s || '').split(':').map((x) => parseInt(x, 10));
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

function isPolicyActive(policy, now = new Date()) {
  const sched = policy.schedule;
  if (!sched || !Array.isArray(sched.windows) || !sched.windows.length) return true;
  const day = now.getDay();
  const min = now.getHours() * 60 + now.getMinutes();
  for (const w of sched.windows) {
    if (!w || !Array.isArray(w.days) || !w.days.includes(day)) continue;
    if (typeof w.startMin !== 'number' || typeof w.endMin !== 'number') continue;
    if (w.endMin <= w.startMin) continue;
    if (min >= w.startMin && min < w.endMin) return true;
  }
  return false;
}

function describeSchedule(schedule) {
  const preset = detectPreset(schedule);
  if (preset === 'always') return 'always on';
  if (preset === 'workdays') return '9–5 workdays';
  if (preset === 'weekends') return 'weekends only';
  const n = (schedule && schedule.windows && schedule.windows.length) || 0;
  return n + ' window' + (n === 1 ? '' : 's');
}

function renderSchedule(p) {
  const presetEls = qsa('#schedule-presets input[name="schedule-preset"]');
  const custom = qs('#schedule-custom');
  const badge = qs('#schedule-status-badge');
  const current = detectPreset(p.schedule);

  for (const el of presetEls) {
    el.checked = el.value === current;
    el.onchange = async () => {
      if (!el.checked) return;
      if (el.value === 'custom') {
        if (!p.schedule || !p.schedule.windows || !p.schedule.windows.length) {
          p.schedule = { windows: [{ days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 }] };
        }
      } else {
        p.schedule = JSON.parse(JSON.stringify(SCHEDULE_PRESETS[el.value]));
      }
      touchPolicy(p);
      await savePolicies();
      renderSchedule(p);
    };
  }

  custom.classList.toggle('hidden', current !== 'custom');
  if (current === 'custom') renderScheduleWindows(p);

  badge.textContent = describeSchedule(p.schedule) + (isPolicyActive(p) ? '' : ' · off now');
}

function renderScheduleWindows(p) {
  const host = qs('#schedule-windows');
  host.innerHTML = '';
  const windows = (p.schedule && p.schedule.windows) || [];

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    const row = document.createElement('div');
    row.className = 'schedule-window';

    const days = document.createElement('div');
    days.className = 'schedule-days';
    for (let d = 0; d < 7; d++) {
      const id = `sched-day-${i}-${d}`;
      const checked = w.days.includes(d);
      days.insertAdjacentHTML(
        'beforeend',
        `<label class="schedule-day${checked ? ' on' : ''}" title="${esc(DAY_NAMES[d])}">
          <input type="checkbox" id="${id}" data-day="${d}" ${checked ? 'checked' : ''}>
          <span>${DAY_LABELS[d]}</span>
        </label>`
      );
    }
    row.appendChild(days);

    const times = document.createElement('div');
    times.className = 'schedule-times';
    times.innerHTML = `
      <input type="time" class="sched-start" value="${minToHHMM(w.startMin)}">
      <span>to</span>
      <input type="time" class="sched-end" value="${minToHHMM(w.endMin)}">
      <button type="button" class="btn btn-ghost sched-remove">Remove</button>
    `;
    row.appendChild(times);

    host.appendChild(row);

    const update = async () => {
      const newDays = qsa('input[type="checkbox"]', days)
        .filter((cb) => cb.checked)
        .map((cb) => parseInt(cb.dataset.day, 10));
      const startMin = hhmmToMin(qs('.sched-start', row).value);
      const endMin = hhmmToMin(qs('.sched-end', row).value);
      if (startMin === null || endMin === null) return;
      if (endMin <= startMin) return;
      windows[i] = { days: newDays, startMin, endMin };
      touchPolicy(p);
      await savePolicies();
      renderSchedule(p);
    };

    qsa('input[type="checkbox"]', days).forEach((cb) => cb.addEventListener('change', update));
    qs('.sched-start', row).addEventListener('change', update);
    qs('.sched-end', row).addEventListener('change', update);
    qs('.sched-remove', row).addEventListener('click', async () => {
      windows.splice(i, 1);
      if (!windows.length) {
        p.schedule = emptySchedule();
      }
      touchPolicy(p);
      await savePolicies();
      renderSchedule(p);
    });
  }

  qs('#schedule-add-window').onclick = async () => {
    const ws = (p.schedule && p.schedule.windows) || [];
    ws.push({ days: [1, 2, 3, 4, 5], startMin: 9 * 60, endMin: 17 * 60 });
    p.schedule = { windows: ws };
    touchPolicy(p);
    await savePolicies();
    renderSchedule(p);
  };
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
  if (e.active === false) textEl.textContent += ' · off-schedule';
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
  // Policy view: refresh schedule badge so "off now" stays current
  const badge = qs('#schedule-status-badge');
  if (badge && targetPolicyId) {
    const p = livePolicies().find((x) => x.id === targetPolicyId);
    if (p) {
      badge.textContent = describeSchedule(p.schedule) + (isPolicyActive(p) ? '' : ' · off now');
    }
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

// Handles both the minute-bucket shape ({[minute]: seconds}) and the legacy
// flat-number shape carried over from older installs.
function sumDomainEntry(entry) {
  if (!entry) return 0;
  if (typeof entry === 'number') return entry;
  let total = 0;
  for (const v of Object.values(entry)) total += v || 0;
  return total;
}

async function loadHistory() {
  const panel = qs('#site-history-panel');
  panel.innerHTML = '<div class="empty">Loading…</div>';

  const data = await browser.storage.local.get(['usage', 'device_id']);
  const localUsage = data.usage || {};
  const selfId = data.device_id;

  // Lazy fetch full remote history once per page open (cached in module scope).
  if (historyRemoteCache === null && (await getSession())) {
    try {
      const { shards = {} } = await fetchRemoteHistory();
      if (selfId) delete shards[selfId];
      historyRemoteCache = shards;
    } catch {
      historyRemoteCache = {};
    }
  }
  const remote = historyRemoteCache || {};

  const dateTotals = new Map();
  const accumulate = (shard) => {
    for (const [date, dayUsage] of Object.entries(shard || {})) {
      const sec = sumDomainEntry(dayUsage[targetDomain]);
      if (sec > 0) dateTotals.set(date, (dateTotals.get(date) || 0) + sec);
    }
  };
  accumulate(localUsage);
  for (const shard of Object.values(remote)) accumulate(shard);

  const rows = Array.from(dateTotals, ([date, sec]) => ({ date, sec }));
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
    updated_at: Date.now(),
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
  for (const p of livePolicies()) {
    if (p.domains.includes(targetDomain)) {
      p.domains = p.domains.filter((d) => d !== targetDomain);
      touchPolicy(p);
      touched = true;
    }
  }
  if (touched) await savePolicies();

  const remaining = trackedDomains();
  const live = livePolicies();
  if (remaining.length) {
    location.href = 'main.html?domain=' + encodeURIComponent(remaining[0]);
  } else if (live.length) {
    location.href = 'main.html?policy=' + encodeURIComponent(live[0].id);
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
    policies: livePolicies(),
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
    if (typeof p.id !== 'string') return 'Policy missing id.';
    if (p.deleted === true) continue;
    if (typeof p.name !== 'string') return 'Policy missing name.';
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
    if (p.schedule !== undefined) {
      if (!p.schedule || typeof p.schedule !== 'object' || !Array.isArray(p.schedule.windows)) {
        return 'Policy schedule must be { windows: [...] }.';
      }
      for (const w of p.schedule.windows) {
        if (!w || !Array.isArray(w.days) || !w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) {
          return 'Schedule window days must be integers 0–6.';
        }
        if (typeof w.startMin !== 'number' || typeof w.endMin !== 'number') {
          return 'Schedule window missing startMin/endMin.';
        }
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

  const liveCount = livePolicies().length;
  const ok = await confirmModal({
    title: 'Import policies?',
    message: `Merges ${parsed.policies.length} polic${parsed.policies.length === 1 ? 'y' : 'ies'} from the file with your current ${liveCount}. Policies with the same id are overwritten by whichever has the more recent change.`,
    okLabel: 'Import',
  });
  if (!ok) return;

  // Stamp updated_at on incoming policies so the merge prefers them by default.
  const now = Date.now();
  const incoming = parsed.policies.map((p) => ({
    ...p,
    updated_at: typeof p.updated_at === 'number' ? p.updated_at : now,
  }));
  const merged = mergePolicies(policies, incoming);
  policies = merged;
  await savePolicies();
  location.href = 'main.html?view=settings';
}

async function removeCurrentPolicy() {
  const p = livePolicies().find((x) => x.id === targetPolicyId);
  if (!p) return;
  const ok = await confirmModal({
    title: `Remove "${p.name}"?`,
    message: `${p.rules.length} rule${p.rules.length === 1 ? '' : 's'} on ${p.domains.length} site${p.domains.length === 1 ? '' : 's'} will be deleted.`,
    okLabel: 'Remove',
  });
  if (!ok) return;

  // Replace with a tombstone so the deletion propagates through sync.
  const idx = policies.findIndex((x) => x.id === targetPolicyId);
  if (idx >= 0) {
    policies[idx] = { id: targetPolicyId, deleted: true, updated_at: Date.now() };
  }
  await savePolicies();

  const live = livePolicies();
  if (live.length) {
    location.href = 'main.html?policy=' + encodeURIComponent(live[0].id);
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
  const p = livePolicies().find((x) => x.id === targetPolicyId);
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
    // Refresh policies + devices UI in case sync pulled new data.
    const data = await browser.storage.local.get(['policies', 'devices']);
    policies = data.policies || [];
    devices = data.devices || [];
    renderSidebar();
    renderDevices();
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
    if (result.policies.status === 'pulled' || result.policies.status === 'merged') {
      const data = await browser.storage.local.get('policies');
      policies = data.policies || [];
      renderSidebar();
    }
    if (result.devices.status === 'pulled' || result.devices.status === 'merged') {
      const data = await browser.storage.local.get('devices');
      devices = data.devices || [];
      renderDevices();
    }
    // Invalidate the lazy history cache so a re-open re-fetches.
    historyRemoteCache = null;
    await renderSync();
  } catch (err) {
    showSyncError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sync now';
  }
}

/***************
 * Devices UI
 ***************/

function liveDevices() {
  return devices.filter((d) => !d.deleted);
}

async function renderDevices() {
  const card = qs('#devices-card');
  const session = await getSession();
  if (!session) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');

  const list = qs('#devices-list');
  list.innerHTML = '';

  const { device_id: selfId } = await browser.storage.local.get('device_id');
  const live = liveDevices().slice().sort((a, b) => {
    if (a.id === selfId) return -1;
    if (b.id === selfId) return 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  if (!live.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No devices registered yet.';
    list.appendChild(empty);
    return;
  }

  for (const d of live) {
    const row = document.createElement('div');
    row.className = 'device-row';
    row.dataset.deviceId = d.id;

    const input = document.createElement('input');
    input.className = 'device-name-input';
    input.value = d.name || '';
    input.spellcheck = false;
    input.addEventListener('change', async () => {
      const v = input.value.trim();
      if (!v || v === d.name) {
        input.value = d.name || '';
        return;
      }
      d.name = v;
      d.updated_at = Date.now();
      await saveDevices();
    });
    row.appendChild(input);

    if (d.id === selfId) {
      const tag = document.createElement('span');
      tag.className = 'device-tag';
      tag.textContent = 'this device';
      row.appendChild(tag);
    } else {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'btn btn-ghost btn-remove-device';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', () => removeDevice(d));
      row.appendChild(removeBtn);
    }

    list.appendChild(row);
  }
}

async function removeDevice(d) {
  const ok = await confirmModal({
    title: `Remove "${d.name || 'device'}"?`,
    message: 'Its tracked usage will be deleted from sync. The device entry can be re-created if it signs in again.',
    okLabel: 'Remove',
  });
  if (!ok) return;

  const idx = devices.findIndex((x) => x.id === d.id);
  if (idx >= 0) {
    devices[idx] = { id: d.id, deleted: true, updated_at: Date.now() };
  }
  await saveDevices();
  renderDevices();
}

async function handleSignOut() {
  const ok = await confirmModal({
    title: 'Sign out?',
    message: 'Local policies stay on this device. Sync stops until you sign in again.',
    okLabel: 'Sign out',
  });
  if (!ok) return;
  await signOut();
  historyRemoteCache = null;
  await renderSync();
  await renderDevices();
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
