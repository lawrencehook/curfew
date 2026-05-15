// Client-side helpers for the Curb sync server.
//
// Storage keys used:
//   sync_session:           { token, email } | absent     — auth state
//   sync_version:           integer                       — last synced policies version
//   devices_version:        integer                       — last synced devices version
//   sync_state:             { last_synced_at?, last_error? }
//   device_id:              string                        — stable per-install id (set by background)
//   last_signed_in_email:   string                        — survives sign-out so we can detect
//                                                          account switches and wipe local state
//   usage_remote_today:     { [date]: { [deviceId]: { [domain]: { [minute]: seconds } } } }
//                           — siblings' today-slice, refreshed each sync
//
// Merge models:
//   - policies & devices: merged by `id` with last-write-wins on `updated_at`.
//     Deletions propagate via tombstones — `{id, deleted: true, updated_at}`.
//   - usage: each device owns one shard. The local device PUTs its full shard
//     on every sync. The today-slice is pulled on every sync (cheap). Full
//     shards are pulled on demand when the history view is opened.

// Production sync server. For local development, swap to 'http://localhost:3000'.
// const SERVER_URL = 'http://localhost:3000';
const SERVER_URL = 'https://server.lawrencehook.com/curb';

/***************
 * Session
 ***************/

async function getSession() {
  const data = await browser.storage.local.get('sync_session');
  return data.sync_session || null;
}

async function setSession(session) {
  if (session) await browser.storage.local.set({ sync_session: session });
  else await browser.storage.local.remove('sync_session');
}

async function getSyncState() {
  const data = await browser.storage.local.get(['sync_version', 'sync_state']);
  return {
    version: data.sync_version || 0,
    lastSyncedAt: (data.sync_state && data.sync_state.last_synced_at) || null,
    lastError: (data.sync_state && data.sync_state.last_error) || null,
  };
}

async function setSyncState(patch) {
  const cur = (await browser.storage.local.get('sync_state')).sync_state || {};
  await browser.storage.local.set({ sync_state: { ...cur, ...patch } });
}

/***************
 * Auth
 ***************/

async function requestCode(email) {
  const r = await fetch(`${SERVER_URL}/auth/request-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

async function verifyCode(email, code) {
  const r = await fetch(`${SERVER_URL}/auth/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  await setSession({ token: body.session_token, email: body.email });

  // If the user is switching accounts, drop local state tied to the previous
  // one — otherwise the next sync would merge it into the new account's bucket.
  const { last_signed_in_email: lastEmail } = await browser.storage.local.get('last_signed_in_email');
  if (lastEmail && lastEmail !== body.email) {
    await browser.storage.local.remove([
      'policies',
      'devices',
      'usage',
      'usage_remote_today',
      'sync_version',
      'devices_version',
    ]);
  }
  await browser.storage.local.set({ last_signed_in_email: body.email });

  return body;
}

async function signOut() {
  await setSession(null);
  await browser.storage.local.remove([
    'sync_version',
    'devices_version',
    'sync_state',
    'usage_remote_today',
  ]);
}

/***************
 * Merge (used for both policies and devices)
 ***************/

function mergeById(a, b) {
  const byId = new Map();
  for (const e of [...(a || []), ...(b || [])]) {
    if (!e || !e.id) continue;
    const existing = byId.get(e.id);
    if (!existing || (e.updated_at || 0) > (existing.updated_at || 0)) {
      byId.set(e.id, e);
    }
  }
  return Array.from(byId.values());
}
const mergePolicies = mergeById;

// Canonical form: arrays preserve order, but object keys are sorted so that
// two objects with the same fields in different insertion orders stringify
// identically. Without this, a remote round-trip that happens to reorder keys
// looks like a "change" and triggers a needless PUT — server bumps version
// forever as devices ping-pong syncs.
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const k of Object.keys(value).sort()) sorted[k] = canonicalize(value[k]);
    return sorted;
  }
  return value;
}

function listsEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  const sortById = (arr) => arr.slice().sort((x, y) => x.id.localeCompare(y.id));
  return JSON.stringify(canonicalize(sortById(a))) === JSON.stringify(canonicalize(sortById(b)));
}

/***************
 * Sync
 ***************/

async function authedFetch(path, opts = {}) {
  const session = await getSession();
  if (!session) throw new Error('Not signed in.');
  const r = await fetch(SERVER_URL + path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${session.token}`,
    },
  });
  if (r.status === 401) {
    await setSession(null);
    throw new Error('Session expired — please sign in again.');
  }
  return r;
}

// Reconcile spec describes how to sync one list-shaped doc (policies, devices).
const POLICIES_SPEC = {
  endpoint: '/sync',
  field: 'policies',
  storeKey: 'policies',
  versionKey: 'sync_version',
};
const DEVICES_SPEC = {
  endpoint: '/sync/devices',
  field: 'devices',
  storeKey: 'devices',
  versionKey: 'devices_version',
};

async function getRemoteList(spec) {
  const r = await authedFetch(spec.endpoint);
  if (!r.ok) throw new Error(`${spec.endpoint} GET failed (${r.status})`);
  return r.json();
}

async function putRemoteList(spec, list, version) {
  const r = await authedFetch(spec.endpoint, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [spec.field]: list, version }),
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 409) return { conflict: true, current: body.current };
  if (!r.ok) throw new Error(body.error || `${spec.endpoint} PUT failed (${r.status})`);
  return body;
}

// Pull → merge by id → push if merged differs from remote. On 409, re-merge
// against fresh server state and retry once.
async function syncList(spec) {
  const localData = await browser.storage.local.get(spec.storeKey);
  const local = localData[spec.storeKey] || [];

  let remote;
  try {
    remote = await getRemoteList(spec);
  } catch (err) {
    await setSyncState({ last_error: err.message });
    throw err;
  }

  return await reconcile(spec, local, remote, 1);
}

async function reconcile(spec, local, remote, retriesLeft) {
  const remoteList = remote[spec.field] || [];
  const merged = mergeById(local, remoteList);
  const localChanged = !listsEqual(merged, local);
  const remoteChanged = !listsEqual(merged, remoteList);

  if (localChanged) {
    await browser.storage.local.set({ [spec.storeKey]: merged });
  }

  if (!remoteChanged) {
    await browser.storage.local.set({ [spec.versionKey]: remote.version });
    await setSyncState({ last_synced_at: Date.now(), last_error: null });
    return { status: localChanged ? 'pulled' : 'noop', version: remote.version };
  }

  let put;
  try {
    put = await putRemoteList(spec, merged, remote.version);
  } catch (err) {
    await setSyncState({ last_error: err.message });
    throw err;
  }

  if (put.conflict) {
    if (retriesLeft > 0) {
      return await reconcile(spec, merged, put.current, retriesLeft - 1);
    }
    const reMerged = mergeById(merged, put.current[spec.field] || []);
    await browser.storage.local.set({
      [spec.storeKey]: reMerged,
      [spec.versionKey]: put.current.version,
    });
    await setSyncState({
      last_synced_at: Date.now(),
      last_error: 'Remote kept changing during sync — merged latest locally.',
    });
    return { status: 'merged', version: put.current.version };
  }

  await browser.storage.local.set({ [spec.versionKey]: put.version });
  await setSyncState({ last_synced_at: Date.now(), last_error: null });
  return { status: localChanged ? 'merged' : 'pushed', version: put.version };
}

const syncPoliciesNow = () => syncList(POLICIES_SPEC);
const syncDevicesNow = () => syncList(DEVICES_SPEC);

// Best-guess default name for this device. Users can edit afterwards.
function defaultDeviceName() {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  let browserName = 'Browser';
  if (/Firefox\//.test(ua)) browserName = 'Firefox';
  else if (/Edg\//.test(ua)) browserName = 'Edge';
  else if (/Chrome\//.test(ua)) browserName = 'Chrome';
  else if (/Safari\//.test(ua)) browserName = 'Safari';
  let os = '';
  if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return os ? `${browserName} on ${os}` : browserName;
}

// Make sure this install has a self-entry in local devices before sync runs.
async function ensureSelfDevice() {
  const data = await browser.storage.local.get(['device_id', 'devices']);
  const id = data.device_id;
  if (!id) return;
  const devices = data.devices || [];
  const existing = devices.find((d) => d.id === id && !d.deleted);
  if (existing) return;
  devices.push({ id, name: defaultDeviceName(), updated_at: Date.now() });
  await browser.storage.local.set({ devices });
}

// Returns { policies, devices, usage } each shaped { status, ... }.
async function syncNow() {
  await ensureSelfDevice();
  const policies = await syncPoliciesNow();
  const devices = await syncDevicesNow();
  const usage = await syncUsageNow();
  return { policies, devices, usage };
}

/***************
 * Usage sync
 *
 * On every sync: PUT this device's full shard + GET the today-slice across
 * shards (small). Full remote shards are pulled lazily by the history view
 * via fetchRemoteHistory().
 ***************/

function todayDateKey() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

async function putLocalUsage(deviceId, shard) {
  const r = await authedFetch('/sync/usage', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, shard }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `Usage PUT failed (${r.status})`);
  return body;
}

async function fetchRemoteUsageToday(date) {
  const r = await authedFetch('/sync/usage/today?date=' + encodeURIComponent(date));
  if (!r.ok) throw new Error(`Usage today GET failed (${r.status})`);
  return r.json();
}

// PUT local shard, then GET today's slice into usage_remote_today.
// Returns { status: 'synced' | 'no_device', deviceCount }.
async function syncUsageNow() {
  const data = await browser.storage.local.get(['device_id', 'usage']);
  const deviceId = data.device_id;
  if (!deviceId) {
    return { status: 'no_device', deviceCount: 0 };
  }
  const shard = data.usage || {};
  const date = todayDateKey();

  try {
    await putLocalUsage(deviceId, shard);
    const { shards = {} } = await fetchRemoteUsageToday(date);
    delete shards[deviceId];
    await browser.storage.local.set({ usage_remote_today: { [date]: shards } });
    return { status: 'synced', deviceCount: Object.keys(shards).length + 1 };
  } catch (err) {
    await setSyncState({ last_error: err.message });
    throw err;
  }
}

// On-demand pull of every device's full shard. Used by the history view only.
// Caller is responsible for caching the result for the session.
async function fetchRemoteHistory() {
  const r = await authedFetch('/sync/usage');
  if (!r.ok) throw new Error(`Usage GET failed (${r.status})`);
  return r.json(); // { shards: { [deviceId]: { [date]: { [domain]: { [minute]: seconds } } } } }
}
