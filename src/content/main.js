// Browser API compatibility
if (typeof browser === 'undefined') {
  browser = typeof chrome !== 'undefined' ? chrome : null;
}

const WARN_THRESHOLD_SEC = 15;
const POLL_INTERVAL_MS = 1000;

const OVERLAY_CSS = `
  .banner {
    position: fixed;
    bottom: 24px;
    right: 24px;
    display: none;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    background: #fbe9eb;
    border: 1px solid #d4737d;
    border-radius: 10px;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.22);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #3b3544;
    animation: pulse 1s ease-in-out infinite;
    max-width: 320px;
  }
  .banner.visible { display: flex; }
  .count {
    font-size: 40px;
    font-weight: 700;
    color: #b5333f;
    font-variant-numeric: tabular-nums;
    line-height: 1;
    flex-shrink: 0;
  }
  .unit {
    font-size: 18px;
    font-weight: 600;
    margin-left: 2px;
    opacity: 0.7;
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .title {
    font-size: 13px;
    font-weight: 700;
    color: #8a1f29;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .sub {
    font-size: 12px;
    color: #7d4a4f;
    margin-top: 3px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .extend {
    padding: 9px 14px;
    background: #b5333f;
    color: #fff;
    border: none;
    border-radius: 6px;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }
  .extend:hover { background: #8a1f29; }
  .extend:disabled { opacity: 0.5; cursor: not-allowed; }
  @keyframes pulse {
    0%, 100% { background: #fbe9eb; }
    50% { background: #f5d3d8; }
  }
`;

let host = null;
let bannerEl = null;
let numEl = null;
let subEl = null;
let extendBtn = null;
let pollTimer = null;

function ensureOverlay() {
  if (host) return;
  host = document.createElement('div');
  host.id = 'curb-warn-host';
  host.style.cssText = 'all: initial;';
  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = OVERLAY_CSS;
  shadow.appendChild(style);

  bannerEl = document.createElement('div');
  bannerEl.className = 'banner';
  bannerEl.innerHTML =
    '<div class="count"><span class="num">0</span><span class="unit">s</span></div>' +
    '<div class="text"><div class="title">Block imminent</div><div class="sub"></div></div>' +
    '<button class="extend" type="button">+1 min</button>';
  shadow.appendChild(bannerEl);

  numEl = bannerEl.querySelector('.num');
  subEl = bannerEl.querySelector('.sub');
  extendBtn = bannerEl.querySelector('.extend');
  extendBtn.addEventListener('click', onExtend);

  document.documentElement.appendChild(host);
}

function showOverlay(seconds, subText, ruleId, ruleType) {
  ensureOverlay();
  numEl.textContent = String(Math.max(0, Math.ceil(seconds)));
  subEl.textContent = subText;
  if (ruleType === 'daily') {
    extendBtn.style.display = '';
    if (extendBtn.dataset.ruleId !== ruleId) {
      extendBtn.dataset.ruleId = ruleId;
      extendBtn.disabled = false;
      extendBtn.textContent = '+1 min';
    }
  } else {
    extendBtn.style.display = 'none';
    delete extendBtn.dataset.ruleId;
  }
  bannerEl.classList.add('visible');
}

function hideOverlay() {
  if (bannerEl) bannerEl.classList.remove('visible');
}

async function onExtend(e) {
  const btn = e.currentTarget;
  const ruleId = btn.dataset.ruleId;
  if (!ruleId || btn.disabled) return;
  btn.disabled = true;
  try {
    const resp = await browser.runtime.sendMessage({ type: 'extendTime', ruleId });
    if (!resp || !resp.success) {
      btn.textContent = 'used';
    } else {
      poll();
    }
  } catch {
    btn.disabled = false;
  }
}

function matchDomain(host, domains) {
  for (const d of domains) {
    if (d === host) return d;
    if (host.endsWith('.' + d)) return d;
  }
  return null;
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function poll() {
  let status;
  try {
    status = await browser.runtime.sendMessage({ type: 'getStatus' });
  } catch {
    return;
  }
  if (!status) {
    hideOverlay();
    return;
  }
  const matched = matchDomain(location.hostname, status.domains || []);
  if (!matched) {
    hideOverlay();
    stopPolling();
    return;
  }
  startPolling();
  let best = null;
  for (const p of status.policies || []) {
    if (!p.domains.includes(matched)) continue;
    for (const r of p.rules) {
      const e = status.ruleEvals && status.ruleEvals[r.id];
      if (!e || e.blocked) continue;
      const rem = e.remainingSec;
      if (!isFinite(rem) || rem <= 0) continue;
      if (!best || rem < best.remaining) {
        best = { policy: p, rule: r, remaining: rem };
      }
    }
  }
  if (!best || best.remaining > WARN_THRESHOLD_SEC) {
    hideOverlay();
    return;
  }
  showOverlay(
    best.remaining,
    best.policy.name + ' · ' + matched,
    best.rule.id,
    best.rule.type
  );
}

if (window.top === window) {
  poll();
  if (browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes) => {
      if (changes.policies) poll();
    });
  }
}
