const params = new URLSearchParams(location.search);
const targetDomain = params.get('domain') || '';

let sites = [];
let site = null;

/***************
 * Load / Save
 ***************/

async function load() {
  const data = await browser.storage.local.get('sites');
  sites = data.sites || [];
  site = sites.find((s) => s.domain === targetDomain);

  if (!site) {
    qs('#domain').textContent = '—';
    qs('#not-found').classList.remove('hidden');
    return;
  }

  qs('#domain').textContent = site.domain;
  qs('#content').classList.remove('hidden');
  render();
}

async function save() {
  const i = sites.findIndex((s) => s.domain === targetDomain);
  if (i >= 0) sites[i] = site;
  await browser.storage.local.set({ sites });
}

/***************
 * Render
 ***************/

function render() {
  const list = qs('#limits-list');
  list.innerHTML = '';

  if (site.limits.length) {
    site.limits.forEach((lim, idx) => {
      const el = document.createElement('div');
      el.className = 'limit-row';
      el.innerHTML = renderLimit(lim, idx);
      attachLimitHandlers(el, idx);
      list.appendChild(el);
    });
  } else {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No limits configured. This site will be tracked but never blocked.';
    list.appendChild(empty);
  }

  renderAddLimit();
}

function renderAddLimit() {
  const select = qs('#limit-type');
  const hasDaily = site.limits.some((l) => l.type === 'daily');
  const dailyOpt = qs('option[value="daily"]', select);
  dailyOpt.disabled = hasDaily;
  dailyOpt.textContent = hasDaily ? 'Daily cap (already added)' : 'Daily cap';
  if (hasDaily && select.value === 'daily') select.value = 'bucket';
}

function renderLimit(lim, idx) {
  const removeBtn = `<button class="btn btn-ghost btn-remove" data-idx="${idx}">Remove</button>`;

  if (lim.type === 'daily') {
    return `
      <div class="limit-kind">Daily cap</div>
      <div class="limit-fields">
        <input type="number" class="fld-minutes" value="${lim.minutes}" min="0" max="1440">
        <span>min / day</span>
      </div>
      <div class="limit-desc">Blocks after total daily time on this site exceeds the cap.</div>
      ${removeBtn}`;
  }

  if (lim.type === 'bucket') {
    return `
      <div class="limit-kind">Rate (leaky bucket)</div>
      <div class="limit-fields">
        <input type="number" class="fld-capacity" value="${lim.capacityMin}" min="0" max="1440">
        <span>min per</span>
        <input type="number" class="fld-window" value="${lim.windowMin}" min="1" max="1440">
        <span>min window</span>
      </div>
      <div class="limit-desc">Grants up to <strong>${lim.capacityMin}</strong> min of access, refilling continuously over a <strong>${lim.windowMin}</strong> min window.</div>
      ${removeBtn}`;
  }

  return `<div class="limit-kind">Unknown limit</div>${removeBtn}`;
}

function attachLimitHandlers(el, idx) {
  const lim = site.limits[idx];

  if (lim.type === 'daily') {
    const f = qs('.fld-minutes', el);
    f.addEventListener('change', () => {
      const v = parseInt(f.value, 10);
      if (isNaN(v) || v < 0) return;
      lim.minutes = v;
      save();
    });
  }

  if (lim.type === 'bucket') {
    const c = qs('.fld-capacity', el);
    const w = qs('.fld-window', el);
    const onChange = () => {
      const cv = parseInt(c.value, 10);
      const wv = parseInt(w.value, 10);
      if (isNaN(cv) || cv < 0 || isNaN(wv) || wv < 1) return;
      lim.capacityMin = cv;
      lim.windowMin = wv;
      save().then(render);
    };
    c.addEventListener('change', onChange);
    w.addEventListener('change', onChange);
  }

  const rm = qs('.btn-remove', el);
  if (rm) rm.addEventListener('click', () => removeLimit(idx));
}

/***************
 * Actions
 ***************/

async function addLimit(type) {
  let lim;
  if (type === 'daily') {
    if (site.limits.some((l) => l.type === 'daily')) return;
    lim = { type: 'daily', minutes: 30 };
  } else if (type === 'bucket') {
    lim = { type: 'bucket', capacityMin: 5, windowMin: 30 };
  } else {
    return;
  }
  site.limits.push(lim);
  await save();
  render();
}

async function removeLimit(idx) {
  site.limits.splice(idx, 1);
  await save();
  render();
}

async function removeSite() {
  if (!confirm(`Remove ${site.domain}?`)) return;
  sites = sites.filter((s) => s.domain !== targetDomain);
  await browser.storage.local.set({ sites });
  window.close();
}

/***************
 * Init
 ***************/

qs('#add-limit-btn').addEventListener('click', () => {
  addLimit(qs('#limit-type').value);
});

qs('#remove-btn').addEventListener('click', removeSite);

load();
