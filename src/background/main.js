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

/***************
 * State
 *
 * policies: [{id, name, domains: [string], rules: [Rule]}]
 *   Rule: {id, type: 'daily',  minutes}
 *       | {id, type: 'bucket', capacityMin, windowMin}
 * usage:    {[date]: {[domain]: seconds}}
 * buckets:  {[ruleId]: {tokens, lastRefillMs, cap}}
 * ext_<date>_<ruleId>: number
 *
 * Tracked domains are the union of all policy.domains — sites are not stored.
 ***************/

let policies = [];
let usage = {};
let buckets = {};
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

function newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function hostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function trackedDomainsSet() {
  const set = new Set();
  for (const p of policies) for (const d of p.domains) set.add(d);
  return set;
}

function matchTrackedDomain(host) {
  if (!host) return null;
  const set = trackedDomainsSet();
  if (set.has(host)) return host;
  for (const d of set) {
    if (host.endsWith('.' + d)) return d;
  }
  return null;
}

function policiesForDomain(domain) {
  return policies.filter((p) => p.domains.includes(domain));
}

function findRule(ruleId) {
  for (const p of policies) {
    for (const r of p.rules) if (r.id === ruleId) return { policy: p, rule: r };
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
 *
 * Old shapes:
 *   limits = [{id, type, ...config, domains}]            (multi-domain limits)
 *   sites  = [{domain, limits: [...]}]                   (per-site limits)
 *   sites  = [{domain, daily_limit_minutes}]             (oldest)
 *
 * New shape: policies = [{id, name, domains, rules}].
 * Bucket state and ext_ keys are keyed by rule.id — preserve incoming ids
 * so existing fill levels and today's extension counts survive the upgrade.
 ***************/

function migrate(rawSites, rawLimits, rawPolicies) {
  if (Array.isArray(rawPolicies)) {
    return { policies: rawPolicies, changed: false };
  }

  const out = [];
  let n = 0;

  if (Array.isArray(rawLimits)) {
    for (const lim of rawLimits) {
      n++;
      let rule;
      if (lim.type === 'daily') {
        rule = { id: lim.id || newId(), type: 'daily', minutes: lim.minutes };
      } else if (lim.type === 'bucket') {
        rule = {
          id: lim.id || newId(),
          type: 'bucket',
          capacityMin: lim.capacityMin,
          windowMin: lim.windowMin,
        };
      } else continue;
      out.push({
        id: newId(),
        name: `Policy ${n}`,
        domains: (lim.domains || []).slice(),
        rules: [rule],
      });
    }
    return { policies: out, changed: true };
  }

  for (const s of rawSites || []) {
    const inline = Array.isArray(s.limits)
      ? s.limits
      : typeof s.daily_limit_minutes === 'number'
        ? [{ type: 'daily', minutes: s.daily_limit_minutes }]
        : [];
    for (const l of inline) {
      n++;
      let rule;
      if (l.type === 'daily') {
        rule = { id: newId(), type: 'daily', minutes: l.minutes };
      } else if (l.type === 'bucket') {
        rule = {
          id: newId(),
          type: 'bucket',
          capacityMin: l.capacityMin,
          windowMin: l.windowMin,
        };
      } else continue;
      out.push({
        id: newId(),
        name: `Policy ${n}`,
        domains: [s.domain],
        rules: [rule],
      });
    }
  }

  return { policies: out, changed: true };
}

/***************
 * Storage
 ***************/

async function load() {
  const data = await browser.storage.local.get([
    'sites',
    'limits',
    'policies',
    'usage',
    'buckets',
  ]);
  const m = migrate(data.sites, data.limits, data.policies);
  policies = m.policies;

  const allUsage = data.usage || {};
  usage = allUsage[dateKey] || {};
  buckets = data.buckets || {};

  if (m.changed) {
    await browser.storage.local.set({ policies });
    const stale = [];
    if (data.sites !== undefined) stale.push('sites');
    if (data.limits !== undefined) stale.push('limits');
    if (stale.length) await browser.storage.local.remove(stale);
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
  for (const p of policies) {
    for (const r of p.rules) {
      if (r.type === 'bucket') valid.add(r.id);
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

async function getExtensionCount(ruleId) {
  const key = `ext_${dateKey}_${ruleId}`;
  const data = await browser.storage.local.get(key);
  return data[key] || 0;
}

/***************
 * Bucket state
 ***************/

function refillBucket(rule) {
  const cap = rule.capacityMin * 60;
  const windowSec = rule.windowMin * 60;
  const rate = windowSec > 0 ? cap / windowSec : 0;
  const now = Date.now();
  let state = buckets[rule.id];
  if (!state || state.cap !== cap) {
    state = { tokens: cap, lastRefillMs: now, cap };
    buckets[rule.id] = state;
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

function drainBucket(rule) {
  const state = refillBucket(rule);
  state.tokens = Math.max(0, state.tokens - 1);
  bucketsDirty = true;
  return state;
}

/***************
 * Rule evaluation
 ***************/

async function evalRule(policy, rule) {
  if (rule.type === 'daily') {
    let sec = 0;
    for (const d of policy.domains) sec += usage[d] || 0;
    const ext = await getExtensionCount(rule.id);
    const limitSec = rule.minutes * 60 + ext * EXTENSION_BONUS;
    return {
      policyId: policy.id,
      policyName: policy.name,
      ruleId: rule.id,
      type: 'daily',
      blocked: limitSec > 0 && sec >= limitSec,
      progress: limitSec > 0 ? sec / limitSec : 1,
      current: sec,
      limit: limitSec,
      remainingSec: Math.max(0, limitSec - sec),
      domains: policy.domains.slice(),
    };
  }
  if (rule.type === 'bucket') {
    const state = refillBucket(rule);
    const cap = rule.capacityMin * 60;
    const windowSec = rule.windowMin * 60;
    // Drain is 1 tok/sec while on the tab; refill is cap/windowSec tok/sec.
    // Net wall-seconds-until-empty = tokens / (1 - cap/windowSec).
    // If refill ≥ drain (cap ≥ windowSec), the bucket never empties while active.
    const netDrain = windowSec > 0 ? 1 - cap / windowSec : 1;
    const remainingSec = netDrain > 0 ? state.tokens / netDrain : Infinity;
    return {
      policyId: policy.id,
      policyName: policy.name,
      ruleId: rule.id,
      type: 'bucket',
      blocked: cap > 0 && state.tokens <= 0,
      progress: cap > 0 ? 1 - state.tokens / cap : 1,
      current: cap - state.tokens,
      limit: cap,
      remainingSec,
      domains: policy.domains.slice(),
    };
  }
  return null;
}

async function evalDomainRules(domain) {
  const out = [];
  for (const p of policiesForDomain(domain)) {
    for (const r of p.rules) {
      const e = await evalRule(p, r);
      if (e) out.push(e);
    }
  }
  return out;
}

function tightestProgress(results) {
  if (!results.length) return 0;
  return Math.max(...results.map((r) => r.progress));
}

/***************
 * Tracking
 ***************/

// Day rollover. Runs anywhere we're about to read or mutate `usage`,
// since `tick` (the only previous caller) doesn't fire when no site is tracked —
// so a Firefox-MV2 background that survives midnight idle would keep yesterday's
// usage in memory and re-block on first visit the next day.
function checkDayRollover() {
  const now = getDateKey();
  if (now !== dateKey) {
    dateKey = now;
    usage = {};
    return true;
  }
  return false;
}

async function tick() {
  if (!trackedDomain) return;

  checkDayRollover();

  usage[trackedDomain] = (usage[trackedDomain] || 0) + 1;
  dirty = true;

  const applicable = policiesForDomain(trackedDomain);
  for (const p of applicable) {
    for (const r of p.rules) {
      if (r.type === 'bucket') drainBucket(r);
    }
  }

  const results = await evalDomainRules(trackedDomain);
  const sec = usage[trackedDomain];
  browser.browserAction.setBadgeText({ text: badgeText(sec) });
  browser.browserAction.setBadgeBackgroundColor({
    color: badgeColor(tightestProgress(results)),
  });

  const blocked = results.find((r) => r.blocked);
  if (blocked) blockTab(trackedDomain, blocked);
}

async function startTracking(domain) {
  if (trackedDomain === domain) return;
  stopTracking();
  trackedDomain = domain;

  const sec = usage[domain] || 0;
  const results = await evalDomainRules(domain);
  browser.browserAction.setBadgeText({ text: badgeText(sec) });
  browser.browserAction.setBadgeBackgroundColor({
    color: badgeColor(tightestProgress(results)),
  });

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
    policyId: result.policyId,
    ruleId: result.ruleId,
    policyName: result.policyName || '',
    spent: String(Math.floor(result.current)),
    capacity: String(Math.floor(result.limit)),
    domains: result.domains.join(','),
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
  checkDayRollover();
  try {
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || tab.url.startsWith(browser.runtime.getURL(''))) {
      stopTracking();
      return;
    }

    const host = hostname(tab.url);
    const matched = matchTrackedDomain(host);
    if (!matched) {
      stopTracking();
      return;
    }

    const results = await evalDomainRules(matched);
    const blocked = results.find((r) => r.blocked);
    if (blocked) {
      blockTab(matched, blocked);
      return;
    }

    await startTracking(matched);
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
  if (changes.policies) {
    policies = changes.policies.newValue || [];
    pruneBuckets();
    if (activeTabId) evaluate(activeTabId);
  }
});

setInterval(flush, FLUSH_INTERVAL);
setInterval(checkDayRollover, 60_000);

/***************
 * Message handling
 ***************/

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getStatus') {
    evalStatusAll().then((status) => sendResponse(status));
    return true;
  }

  if (msg.type === 'extendTime') {
    const found = findRule(msg.ruleId);
    if (!found || found.rule.type !== 'daily') {
      sendResponse({ success: false });
      return false;
    }
    const key = `ext_${dateKey}_${found.rule.id}`;
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
  checkDayRollover();
  const domains = Array.from(trackedDomainsSet());
  const evals = {};
  for (const d of domains) {
    evals[d] = await evalDomainRules(d);
  }
  const ruleEvals = {};
  for (const p of policies) {
    for (const r of p.rules) {
      const e = await evalRule(p, r);
      if (e) ruleEvals[r.id] = e;
    }
  }
  return { domains, policies, usage, dateKey, evals, ruleEvals };
}

/***************
 * Init
 ***************/

load().then(() => {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0]) evaluate(tabs[0].id);
  });
});
