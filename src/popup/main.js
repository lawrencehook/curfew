let state = { sites: [], usage: {}, dateKey: '', evals: {} };
let refreshTimer = null;
let lastSiteKey = '';

/***************
 * Data
 ***************/

async function fetchStatus() {
  state = await browser.runtime.sendMessage({ type: 'getStatus' });
  render();
}

/***************
 * Render
 ***************/

function render() {
  const list = qs('#site-list');
  const empty = qs('#empty-state');

  if (state.sites.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    qs('#total-time').textContent = '0m today';
    lastSiteKey = '';
    return;
  }

  empty.classList.add('hidden');

  const siteKey = state.sites.map((s) => s.domain).join(',');
  if (siteKey !== lastSiteKey) {
    lastSiteKey = siteKey;
    buildCards(list);
  }

  let totalSeconds = 0;
  for (const site of state.sites) {
    const sec = state.usage[site.domain] || 0;
    totalSeconds += sec;
    const evals = state.evals[site.domain] || [];
    const maxProg = evals.length ? Math.max(...evals.map((e) => e.progress)) : 0;
    const pct = Math.min(100, maxProg * 100);
    const min = Math.floor(sec / 60);
    const color = statusColor(pct);

    const card = qs(`[data-site="${site.domain}"]`, list);
    if (!card) continue;

    card.style.borderLeftColor = color;
    qs('.progress-fill', card).style.width = pct + '%';
    qs('.progress-fill', card).style.background = color;
    qs('.site-time', card).textContent = min + 'm today';
  }

  const totalMin = Math.floor(totalSeconds / 60);
  qs('#total-time').textContent = totalMin + 'm today';
}

function buildCards(list) {
  let html = '';
  for (const site of state.sites) {
    html += `
      <div class="site-card" data-site="${esc(site.domain)}">
        <div class="site-header">
          <span class="site-domain">${esc(site.domain)}</span>
          <span class="site-time"></span>
        </div>
        <div class="progress-track">
          <div class="progress-fill"></div>
        </div>
      </div>`;
  }
  list.innerHTML = html;

  for (const card of qsa('.site-card', list)) {
    card.addEventListener('click', () => openEdit(card.dataset.site));
  }
}

function openEdit(domain) {
  browser.tabs.create({
    url: browser.runtime.getURL('edit/main.html?domain=' + encodeURIComponent(domain)),
  });
  window.close();
}

/***************
 * Actions
 ***************/

async function addSite(raw, limit) {
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');

  if (!domain || !domain.includes('.')) return;
  if (state.sites.some((s) => s.domain === domain)) return;

  state.sites.push({
    domain,
    limits: [{ type: 'daily', minutes: limit }],
  });
  await browser.storage.local.set({ sites: state.sites });
  lastSiteKey = '';
  render();
}

async function prefillDomain() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tabs[0] || !tabs[0].url) return;
    const host = new URL(tabs[0].url).hostname.replace(/^www\./, '');
    if (host && host.includes('.')) {
      qs('#domain-input').value = host;
    }
  } catch {}
}

/***************
 * Init
 ***************/

fetchStatus();
refreshTimer = setInterval(fetchStatus, 1000);

qs('#toggle-add').addEventListener('click', () => {
  const form = qs('#add-form');
  const wasHidden = form.classList.contains('hidden');
  form.classList.toggle('hidden');
  if (wasHidden) {
    prefillDomain().then(() => qs('#domain-input').focus());
  }
});

qs('#add-btn').addEventListener('click', () => {
  const domain = qs('#domain-input').value;
  const limit = parseInt(qs('#limit-input').value, 10) || 30;
  addSite(domain, limit);
  qs('#domain-input').value = '';
});

qs('#domain-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') qs('#add-btn').click();
});

window.addEventListener('unload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
