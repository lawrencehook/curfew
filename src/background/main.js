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
const PRUNE_DAYS = 30;
const DEFAULT_SITES = [
  { domain: 'twitter.com', daily_limit_minutes: 30 },
  { domain: 'x.com', daily_limit_minutes: 30 },
];

/***************
 * State
 ***************/

let sites = [];
let usage = {};
let dateKey = getDateKey();
let activeTabId = null;
let trackedDomain = null;
let ticker = null;
let dirty = false;

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

function badgeColor(sec, limitSec) {
  const r = sec / limitSec;
  if (r >= 0.95) return '#b5636a';
  if (r >= 0.8) return '#c4856b';
  if (r >= 0.5) return '#c9a84e';
  return '#7a9e7e';
}

/***************
 * Storage
 ***************/

async function load() {
  const data = await browser.storage.local.get(['sites', 'usage']);
  sites = data.sites || DEFAULT_SITES.slice();
  const allUsage = data.usage || {};

  // Prune entries older than PRUNE_DAYS
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - PRUNE_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  for (const k of Object.keys(allUsage)) {
    if (k < cutoffStr) delete allUsage[k];
  }

  usage = allUsage[dateKey] || {};
  if (!data.sites) await browser.storage.local.set({ sites });

  pruneExtKeys(cutoffStr);
}

async function pruneExtKeys(cutoffStr) {
  const all = await browser.storage.local.get(null);
  const stale = Object.keys(all).filter(k =>
    k.startsWith('ext_') && k.slice(4, 14) < cutoffStr
  );
  if (stale.length) await browser.storage.local.remove(stale);
}

async function flush() {
  if (!dirty) return;
  const { usage: allUsage = {} } = await browser.storage.local.get('usage');
  allUsage[dateKey] = usage;
  await browser.storage.local.set({ usage: allUsage });
  dirty = false;
}

/***************
 * Extensions (bonus time)
 ***************/

async function getExtensionCount(domain) {
  const key = `ext_${dateKey}_${domain}`;
  const data = await browser.storage.local.get(key);
  return data[key] || 0;
}

async function effectiveLimit(site) {
  const ext = await getExtensionCount(site.domain);
  return site.daily_limit_minutes * 60 + ext * EXTENSION_BONUS;
}

/***************
 * Tracking
 ***************/

function tick() {
  if (!trackedDomain) return;

  // Day rollover
  const now = getDateKey();
  if (now !== dateKey) {
    dateKey = now;
    usage = {};
  }

  usage[trackedDomain] = (usage[trackedDomain] || 0) + 1;
  dirty = true;

  const sec = usage[trackedDomain];
  const site = findSite(trackedDomain);
  if (!site) return;

  browser.browserAction.setBadgeText({ text: badgeText(sec) });
  browser.browserAction.setBadgeBackgroundColor({
    color: badgeColor(sec, site.daily_limit_minutes * 60),
  });

  // Check limit (async)
  effectiveLimit(site).then((limit) => {
    if (sec >= limit && trackedDomain === site.domain) {
      blockTab(trackedDomain, sec, limit);
    }
  });
}

function startTracking(domain) {
  if (trackedDomain === domain) return;
  stopTracking();
  trackedDomain = domain;

  const sec = usage[domain] || 0;
  const site = findSite(domain);
  if (site) {
    browser.browserAction.setBadgeText({ text: badgeText(sec) });
    browser.browserAction.setBadgeBackgroundColor({
      color: badgeColor(sec, site.daily_limit_minutes * 60),
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

function blockTab(domain, spent, limit) {
  const tabId = activeTabId;
  stopTracking();
  const p = new URLSearchParams({
    domain,
    spent: String(spent),
    limit: String(limit),
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

    const sec = usage[site.domain] || 0;
    const limit = await effectiveLimit(site);
    if (sec >= limit) {
      blockTab(site.domain, sec, limit);
      return;
    }

    startTracking(site.domain);
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
    if (activeTabId) evaluate(activeTabId);
  }
});

setInterval(flush, FLUSH_INTERVAL);

/***************
 * Message handling
 ***************/

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    sendResponse({ sites, usage, dateKey });
    return false;
  }

  if (msg.type === 'extendTime') {
    const site = findSite(msg.domain);
    if (!site) {
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
    return true; // async response
  }
});

/***************
 * Init
 ***************/

load().then(() => {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0]) evaluate(tabs[0].id);
  });
});
