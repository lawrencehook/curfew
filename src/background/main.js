// Browser API compatibility
if (typeof browser === 'undefined') {
  browser = typeof chrome !== 'undefined' ? chrome : null;
}

// MV3 compatibility
if (browser && !browser.browserAction && browser.action) {
  browser.browserAction = browser.action;
}

// Pull in shared modules. MV3 (Chrome) runs this file as a service worker, so
// importScripts is needed; MV2 (Firefox) loads them via the manifest's
// background.scripts array and importScripts is undefined.
if (typeof importScripts === 'function') {
  importScripts('/shared/migrations.js');
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
 *   Rule: {id, type: 'daily',   minutes}
 *       | {id, type: 'sliding', minutes, windowMin}
 * usage:                {[domain]: {[minute]: seconds}}        — today, this device
 * usageYesterday:       {[domain]: {[minute]: seconds}}        — yesterday, this device
 *                       (needed so sliding windows can straddle midnight)
 * allUsage (disk):      {[date]: {[domain]: {[minute]: seconds}}} — full local history
 * usageRemoteToday:     {[deviceId]: {[domain]: {[minute]: seconds}}}
 * usageRemoteYesterday: {[deviceId]: {[domain]: {[minute]: seconds}}}
 *                       — siblings' recent slices, refreshed on each sync
 * ext_<date>_<ruleId>: number
 *
 * Tracked domains are the union of all policy.domains — sites are not stored.
 ***************/

let policies = [];
let usage = {};
let usageYesterday = {};
let usageRemoteToday = {};
let usageRemoteYesterday = {};
let dateKey = getDateKey();
let activeTabId = null;
let trackedDomain = null;
let ticker = null;
let dirty = false;

/***************
 * Utilities
 ***************/

function getDateKey(d = new Date()) {
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function getYesterdayKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return getDateKey(d);
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

// Seconds recorded for (domain, minute) at the given slot, summed across local
// + every device's shard for that slot. `slot` is 'today' or 'yesterday'.
function minuteSecondsAt(domain, slot, minute) {
  const local = slot === 'yesterday' ? usageYesterday : usage;
  const remote = slot === 'yesterday' ? usageRemoteYesterday : usageRemoteToday;
  let total = 0;
  const localEntry = local[domain];
  if (localEntry && typeof localEntry === 'object') total += localEntry[minute] || 0;
  for (const shard of Object.values(remote)) {
    const e = shard[domain];
    if (e && typeof e === 'object') total += e[minute] || 0;
  }
  return total;
}

// Sum of seconds spent on `domains` in the trailing `windowMin` wall-clock
// minutes (inclusive of the current minute). Straddles midnight by reaching
// into yesterday's slot.
function slidingWindowSeconds(domains, windowMin) {
  const now = new Date();
  const curMin = now.getHours() * 60 + now.getMinutes();
  let total = 0;
  for (let i = 0; i < windowMin; i++) {
    const off = curMin - i;
    const slot = off < 0 ? 'yesterday' : 'today';
    const minute = off < 0 ? off + 1440 : off;
    for (const d of domains) total += minuteSecondsAt(d, slot, minute);
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
// `disabled: true` cascades through here so the entire policy (every rule)
// stops blocking, the same way off-schedule does.
function isPolicyActive(policy, now = new Date()) {
  if (policy.disabled === true) return false;
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
  policies = await runMigrations(browser.storage.local);

  const data = await browser.storage.local.get(['usage', 'usage_remote_today']);
  const allUsage = data.usage || {};
  usage = allUsage[dateKey] || {};
  usageYesterday = allUsage[getYesterdayKey()] || {};

  // usage_remote_today is keyed by date as well so a stale day rolls off cleanly.
  // Despite the name, we keep both today's and yesterday's slices so sliding
  // windows can straddle midnight.
  const remoteByDate = data.usage_remote_today || {};
  usageRemoteToday = remoteByDate[dateKey] || {};
  usageRemoteYesterday = remoteByDate[getYesterdayKey()] || {};

  pruneExtKeys();
}

async function pruneExtKeys() {
  const all = await browser.storage.local.get(null);
  const stale = Object.keys(all).filter(
    (k) => k.startsWith('ext_') && k.slice(4, 14) !== dateKey
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

async function getExtensionCount(ruleId) {
  const key = `ext_${dateKey}_${ruleId}`;
  const data = await browser.storage.local.get(key);
  return data[key] || 0;
}

/***************
 * Rule evaluation
 ***************/

async function evalRule(policy, rule) {
  const policyActive = isPolicyActive(policy);
  const disabled = rule.disabled === true;
  // `active` reflects whether this rule can currently block. The policy-level
  // disable / schedule already cascade through policyActive; rule-level
  // disable suppresses just this rule.
  const active = policyActive && !disabled;
  if (rule.type === 'daily') {
    let sec = 0;
    for (const d of policy.domains) sec += todayDomainSeconds(d);
    const ext = await getExtensionCount(rule.id);
    const limitSec = rule.minutes * 60 + ext * EXTENSION_BONUS;
    return {
      policyName: policy.name,
      ruleId: rule.id,
      type: 'daily',
      blocked: active && limitSec > 0 && sec >= limitSec,
      progress: limitSec > 0 ? sec / limitSec : 1,
      current: sec,
      limit: limitSec,
      // Inactive rules can't block, so suppress remainingSec — otherwise the
      // "Block imminent" overlay would falsely countdown for off-schedule or
      // disabled rules. The overlay/popup checks isFinite() and skips.
      remainingSec: active ? Math.max(0, limitSec - sec) : Infinity,
      active,
      disabled,
    };
  }
  if (rule.type === 'sliding') {
    const limitSec = rule.minutes * 60;
    const sec = slidingWindowSeconds(policy.domains, rule.windowMin);
    // `remainingSec` is the worst-case time-to-block (assumes the oldest
    // minutes in the window don't slide off freeing capacity). Good enough for
    // the ≤15s warning overlay — it errs on the side of warning slightly early.
    return {
      policyName: policy.name,
      ruleId: rule.id,
      type: 'sliding',
      blocked: active && limitSec > 0 && sec >= limitSec,
      progress: limitSec > 0 ? sec / limitSec : 1,
      current: sec,
      limit: limitSec,
      remainingSec: active ? Math.max(0, limitSec - sec) : Infinity,
      active,
      disabled,
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
    // Shift today → yesterday so sliding windows that straddle the midnight
    // boundary still see the previous day's tail.
    usageYesterday = usage;
    usage = {};
    usageRemoteYesterday = usageRemoteToday;
    usageRemoteToday = {};
    dateKey = now;
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
    ruleId: result.ruleId,
    policyName: result.policyName || '',
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
    if (activeTabId) evaluate(activeTabId);
  }
  if (changes.usage_remote_today) {
    const byDate = changes.usage_remote_today.newValue || {};
    usageRemoteToday = byDate[dateKey] || {};
    usageRemoteYesterday = byDate[getYesterdayKey()] || {};
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
