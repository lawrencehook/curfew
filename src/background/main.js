// Browser API compatibility
if (typeof browser === 'undefined') {
  browser = typeof chrome !== 'undefined' ? chrome : null;
}

// MV3 compatibility
if (browser && !browser.browserAction && browser.action) {
  browser.browserAction = browser.action;
}

/***************
 * Constants
 ***************/

const FLUSH_INTERVAL = 10000;
const EXTENSION_BONUS = 60;
const MAX_EXTENSIONS = 1;
const DEFAULT_SITES = [];

/***************
 * State
 ***************/

let sites = [];
let usage = {};
let buckets = {}; // `${domain}:${limitIdx}` → {tokens, lastRefillMs, cap}
let dateKey = getDateKey();
let activeTabId = null;
let trackedDomain = null;
let ticker = null;
let dirty = false;
let bucketsDirty = false;

/***************
 * Utilities
 ***************/

function getDateKey() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function findSite(host) {
  if (!host) return null;
  for (const s of sites) {
    if (host === s.domain || host.endsWith('.' + s.domain)) return s;
  }
  return null;
}

function badgeText(sec) {
  if (sec < 60) return sec + 's';
  const m = Math.floor(sec / 60);
  return m < 100 ? m + 'm' : Math.floor(m / 60) + 'h';
}

function badgeColor(ratio) {
  if (ratio >= 0.95) return '#b5636a';
  if (ratio >= 0.8) return '#c4856b';
  if (ratio >= 0.5) return '#c9a84e';
  return '#7a9e7e';
}

/***************
 * Migration
 ***************/

function migrateSites(raw) {
  return raw.map((s) => {
    if (Array.isArray(s.limits)) return s;
    if (typeof s.daily_limit_minutes === 'number') {
      return {
        domain: s.domain,
        limits: [{ type: 'daily', minutes: s.daily_limit_minutes }],
      };
    }
    return { domain: s.domain, limits: [] };
  });
}

/***************
 * Storage
 ***************/

async function load() {
  const data = await browser.storage.local.get(['sites', 'usage', 'buckets']);
  const raw = data.sites || DEFAULT_SITES.slice();
  sites = migrateSites(raw);
  const migrated = JSON.stringify(sites) !== JSON.stringify(raw);

  const allUsage = data.usage || {};
  usage = allUsage[dateKey] || {};
  buckets = data.buckets || {};

  if (migrated || !data.sites) {
    await browser.storage.local.set({ sites });
  }

  pruneExtKeys();
  pruneBuckets();
}

async function pruneExtKeys() {
  const all = await browser.storage.local.get(null);
  const stale = Object.keys(all).filter(
    (k) => k.startsWith('ext_') && k.slice(4, 14) !== dateKey
  );
  if (stale.length) await browser.storage.local.remove(stale);
}

function pruneBuckets() {
  const valid = new Set();
  for (const s of sites) {
    for (let i = 0; i < s.limits.length; i++) {
      if (s.limits[i].type === 'bucket') valid.add(bucketKey(s.domain, i));
    }
  }
  for (const k of Object.keys(buckets)) {
    if (!valid.has(k)) {
      delete buckets[k];
      bucketsDirty = true;
    }
  }
}

async function flush() {
  if (!dirty && !bucketsDirty) return;
  const { usage: allUsage = {} } = await browser.storage.local.get('usage');
  allUsage[dateKey] = usage;
  await browser.storage.local.set({ usage: allUsage, buckets });
  dirty = false;
  bucketsDirty = false;
}

/***************
 * Extensions (bonus time)
 ***************/

async function getExtensionCount(domain) {
  const key = `ext_${dateKey}_${domain}`;
  const data = await browser.storage.local.get(key);
  return data[key] || 0;
}

/***************
 * Bucket state
 ***************/

function bucketKey(domain, idx) {
  return domain + ':' + idx;
}

function refillBucket(domain, idx, lim) {
  const key = bucketKey(domain, idx);
  const cap = lim.capacityMin * 60;
  const windowSec = lim.windowMin * 60;
  const rate = windowSec > 0 ? cap / windowSec : 0;
  const now = Date.now();
  let state = buckets[key];
  if (!state || state.cap !== cap) {
    state = { tokens: cap, lastRefillMs: now, cap };
    buckets[key] = state;
    bucketsDirty = true;
    return state;
  }
  const elapsed = (now - state.lastRefillMs) / 1000;
  if (elapsed > 0) {
    state.tokens = Math.min(cap, state.tokens + elapsed * rate);
    state.lastRefillMs = now;
    bucketsDirty = true;
  }
  return state;
}

function drainBucket(domain, idx, lim) {
  const state = refillBucket(domain, idx, lim);
  state.tokens = Math.max(0, state.tokens - 1);
  bucketsDirty = true;
  return state;
}

/***************
 * Limit evaluation
 ***************/

async function evalLimits(site, domain) {
  const ext = await getExtensionCount(domain);
  const results = [];
  for (let i = 0; i < site.limits.length; i++) {
    const lim = site.limits[i];
    if (lim.type === 'daily') {
      const sec = usage[domain] || 0;
      const limitSec = lim.minutes * 60 + ext * EXTENSION_BONUS;
      results.push({
        idx: i,
        type: 'daily',
        blocked: limitSec > 0 && sec >= limitSec,
        progress: limitSec > 0 ? sec / limitSec : 1,
        current: sec,
        limit: limitSec,
      });
    } else if (lim.type === 'bucket') {
      const state = refillBucket(domain, i, lim);
      const cap = lim.capacityMin * 60;
      results.push({
        idx: i,
        type: 'bucket',
        blocked: cap > 0 && state.tokens <= 0,
        progress: cap > 0 ? 1 - state.tokens / cap : 1,
        current: cap - state.tokens,
        limit: cap,
      });
    }
  }
  return results;
}

function tightestProgress(results) {
  if (!results.length) return 0;
  return Math.max(...results.map((r) => r.progress));
}

/***************
 * Tracking
 ***************/

async function tick() {
  if (!trackedDomain) return;

  // Day rollover
  const now = getDateKey();
  if (now !== dateKey) {
    dateKey = now;
    usage = {};
  }

  usage[trackedDomain] = (usage[trackedDomain] || 0) + 1;
  dirty = true;

  const site = findSite(trackedDomain);
  if (!site) return;

  // Drain bucket limits
  for (let i = 0; i < site.limits.length; i++) {
    if (site.limits[i].type === 'bucket') {
      drainBucket(trackedDomain, i, site.limits[i]);
    }
  }

  const results = await evalLimits(site, trackedDomain);
  const sec = usage[trackedDomain];
  browser.browserAction.setBadgeText({ text: badgeText(sec) });
  browser.browserAction.setBadgeBackgroundColor({
    color: badgeColor(tightestProgress(results)),
  });

  const blocked = results.find((r) => r.blocked);
  if (blocked && trackedDomain === site.domain) {
    blockTab(trackedDomain, blocked);
  }
}

async function startTracking(domain) {
  if (trackedDomain === domain) return;
  stopTracking();
  trackedDomain = domain;

  const sec = usage[domain] || 0;
  const site = findSite(domain);
  if (site) {
    const results = await evalLimits(site, domain);
    browser.browserAction.setBadgeText({ text: badgeText(sec) });
    browser.browserAction.setBadgeBackgroundColor({
      color: badgeColor(tightestProgress(results)),
    });
  }

  ticker = setInterval(tick, 1000);
}

function stopTracking() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  trackedDomain = null;
  browser.browserAction.setBadgeText({ text: '' });
  flush();
}

/***************
 * Blocking
 ***************/

function blockTab(domain, result) {
  const tabId = activeTabId;
  stopTracking();
  const p = new URLSearchParams({
    domain,
    type: result.type,
    spent: String(Math.floor(result.current)),
    limit: String(Math.floor(result.limit)),
  });
  browser.tabs.update(tabId, {
    url: browser.runtime.getURL('blocked/main.html?' + p),
  });
}

/***************
 * Tab evaluation
 ***************/

async function evaluate(tabId) {
  activeTabId = tabId;
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith(browser.runtime.getURL(''))) {
      stopTracking();
      return;
    }

    const host = hostname(tab.url);
    const site = findSite(host);
    if (!site) {
      stopTracking();
      return;
    }

    const results = await evalLimits(site, site.domain);
    const blocked = results.find((r) => r.blocked);
    if (blocked) {
      blockTab(site.domain, blocked);
      return;
    }

    await startTracking(site.domain);
  } catch {
    stopTracking();
  }
}

/***************
 * Event listeners
 ***************/

browser.tabs.onActivated.addListener(({ tabId }) => evaluate(tabId));

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === activeTabId && info.url) evaluate(tabId);
});

browser.windows.onFocusChanged.addListener((wid) => {
  if (wid === browser.windows.WINDOW_ID_NONE) {
    stopTracking();
    return;
  }
  browser.tabs.query({ active: true, windowId: wid }).then((tabs) => {
    if (tabs[0]) evaluate(tabs[0].id);
  });
});

browser.storage.onChanged.addListener((changes) => {
  if (changes.sites) {
    sites = changes.sites.newValue || [];
    pruneBuckets();
    if (activeTabId) evaluate(activeTabId);
  }
});

setInterval(flush, FLUSH_INTERVAL);

/***************
 * Message handling
 ***************/

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    evalStatusAll().then((status) => sendResponse(status));
    return true;
  }

  if (msg.type === 'extendTime') {
    const site = findSite(msg.domain);
    if (!site || !site.limits.some((l) => l.type === 'daily')) {
      sendResponse({ success: false });
      return false;
    }
    const key = `ext_${dateKey}_${msg.domain}`;
    browser.storage.local.get(key).then((data) => {
      const count = data[key] || 0;
      if (count >= MAX_EXTENSIONS) {
        sendResponse({ success: false, remaining: 0 });
        return;
      }
      browser.storage.local.set({ [key]: count + 1 }).then(() => {
        sendResponse({ success: true, remaining: MAX_EXTENSIONS - 1 - count });
      });
    });
    return true;
  }
});

async function evalStatusAll() {
  const evals = {};
  for (const site of sites) {
    evals[site.domain] = await evalLimits(site, site.domain);
  }
  return { sites, usage, dateKey, evals };
}

/***************
 * Init
 ***************/

load().then(() => {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0]) evaluate(tabs[0].id);
  });
});
