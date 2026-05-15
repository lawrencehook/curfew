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
 * usage:           {[domain]: {[minute]: seconds}}        — today only, this device
 * allUsage (disk): {[date]: {[domain]: {[minute]: seconds}}} — full local history
 * usageRemoteToday:{[deviceId]: {[domain]: {[minute]: seconds}}}
 *                  — siblings' today-slice, refreshed on each sync, used for
 *                    cross-device daily-cap evaluation
 * buckets:         {[ruleId]: {tokens, lastRefillMs, cap}}
 * ext_<date>_<ruleId>: number
 *
 * Tracked domains are the union of all policy.domains — sites are not stored.
 ***************/

let policies = [];
let usage = {};
let usageRemoteToday = {};
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

function getMinuteOfDay() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

// Sums seconds across a domain's entry. Handles both the minute-bucket shape
// ({[minute]: seconds}) and the legacy flat-number shape (pre-minute-bucket
// data carried forward from older installs).
function sumDomainEntry(entry) {
  if (!entry) return 0;
  if (typeof entry === 'number') return entry;
  let total = 0;
  for (const v of Object.values(entry)) total += v || 0;
  return total;
}

// Today's seconds for a domain across this device + every device's today-slice.
function todayDomainSeconds(domain) {
  let total = sumDomainEntry(usage[domain]);
  for (const today of Object.values(usageRemoteToday)) {
    total += sumDomainEntry(today[domain]);
  }
  return total;
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

function livePolicies() {
  return policies.filter((p) => !p.deleted);
}

// Absent/empty schedule = always active. Each window applies only on its
// listed days (0=Sun..6=Sat), within [startMin, endMin) — same-day windows only.
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

function trackedDomainsSet() {
  const set = new Set();
  for (const p of livePolicies()) for (const d of p.domains) set.add(d);
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
  return livePolicies().filter((p) => p.domains.includes(domain));
}

function findRule(ruleId) {
  for (const p of livePolicies()) {
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

async function ensureDeviceId() {
  const data = await browser.storage.local.get('device_id');
  if (typeof data.device_id === 'string' && data.device_id) return data.device_id;
  const id = newId();
  await browser.storage.local.set({ device_id: id });
  return id;
}

async function load() {
  await ensureDeviceId();
  const data = await browser.storage.local.get([
    'sites',
    'limits',
    'policies',
    'usage',
    'usage_remote_today',
    'buckets',
  ]);
  const m = migrate(data.sites, data.limits, data.policies);
  policies = m.policies;

  const allUsage = data.usage || {};
  usage = allUsage[dateKey] || {};

  // usage_remote_today is keyed by date as well so a stale day rolls off cleanly.
  const remoteByDate = data.usage_remote_today || {};
  usageRemoteToday = remoteByDate[dateKey] || {};
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
  for (const p of livePolicies()) {
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
  const active = isPolicyActive(policy);
  if (rule.type === 'daily') {
    let sec = 0;
    for (const d of policy.domains) sec += todayDomainSeconds(d);
    const ext = await getExtensionCount(rule.id);
    const limitSec = rule.minutes * 60 + ext * EXTENSION_BONUS;
    return {
      policyId: policy.id,
      policyName: policy.name,
      ruleId: rule.id,
      type: 'daily',
      blocked: active && limitSec > 0 && sec >= limitSec,
      progress: limitSec > 0 ? sec / limitSec : 1,
      current: sec,
      limit: limitSec,
      domains: policy.domains.slice(),
      active,
    };
  }
  if (rule.type === 'bucket') {
    const state = refillBucket(rule);
    const cap = rule.capacityMin * 60;
    return {
      policyId: policy.id,
      policyName: policy.name,
      ruleId: rule.id,
      type: 'bucket',
      blocked: active && cap > 0 && state.tokens <= 0,
      progress: cap > 0 ? 1 - state.tokens / cap : 1,
      current: cap - state.tokens,
      limit: cap,
      domains: policy.domains.slice(),
      active,
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
    usageRemoteToday = {};
    return true;
  }
  return false;
}

async function tick() {
  if (!trackedDomain) return;

  checkDayRollover();

  const minute = String(getMinuteOfDay());
  let bucket = usage[trackedDomain];
  // First write since upgrade can find a legacy flat-number entry sitting in
  // today's slot — preserve those seconds in a sentinel bucket alongside the
  // new minute counts.
  if (!bucket || typeof bucket !== 'object') {
    bucket = typeof bucket === 'number' ? { legacy: bucket } : {};
    usage[trackedDomain] = bucket;
  }
  bucket[minute] = (bucket[minute] || 0) + 1;
  dirty = true;

  const applicable = policiesForDomain(trackedDomain);
  for (const p of applicable) {
    if (!isPolicyActive(p)) continue;
    for (const r of p.rules) {
      if (r.type === 'bucket') drainBucket(r);
    }
  }

  const results = await evalDomainRules(trackedDomain);
  const sec = todayDomainSeconds(trackedDomain);
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

  const sec = todayDomainSeconds(domain);
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
  if (changes.usage_remote_today) {
    const byDate = changes.usage_remote_today.newValue || {};
    usageRemoteToday = byDate[dateKey] || {};
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
  const todayUsage = {};
  for (const d of domains) {
    evals[d] = await evalDomainRules(d);
    todayUsage[d] = todayDomainSeconds(d);
  }
  const live = livePolicies();
  const ruleEvals = {};
  const policyActive = {};
  for (const p of live) {
    policyActive[p.id] = isPolicyActive(p);
    for (const r of p.rules) {
      const e = await evalRule(p, r);
      if (e) ruleEvals[r.id] = e;
    }
  }
  return { domains, policies: live, usage: todayUsage, dateKey, evals, ruleEvals, policyActive };
}

/***************
 * Init
 ***************/

load().then(() => {
  browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
    if (tabs[0]) evaluate(tabs[0].id);
  });
});
