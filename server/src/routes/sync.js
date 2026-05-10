const express = require('express');
const s3 = require('../services/s3');
const { requireAuth } = require('../services/jwt');

const router = express.Router();

// All sync routes require a valid session token.
router.use(requireAuth);

const EMPTY_POLICIES = { policies: [], version: 0, updated_at: null };
const EMPTY_DEVICES = { devices: [], version: 0, updated_at: null };

function project(doc, listKey) {
  // Strip the etag from the wire response — clients drive concurrency by version.
  return {
    [listKey]: doc[listKey],
    version: doc.version,
    updated_at: doc.updated_at,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// GET /sync → { policies, version, updated_at }
router.get('/', async (req, res) => {
  try {
    const doc = await s3.getDocument(req.userEmail);
    res.json(doc ? project(doc, 'policies') : EMPTY_POLICIES);
  } catch (err) {
    console.error('Sync GET error:', err);
    res.status(500).json({ error: 'Sync GET failed' });
  }
});

// PUT /sync  { policies, version }
//   On version match → 200 { ok: true, version, updated_at }
//   On mismatch     → 409 { ok: false, current: { policies, version, updated_at } }
router.put('/', async (req, res) => {
  const { policies, version } = req.body || {};

  if (!Array.isArray(policies)) {
    return res.status(400).json({ error: 'policies must be an array' });
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return res.status(400).json({ error: 'version must be a non-negative integer' });
  }

  try {
    const current = await s3.getDocument(req.userEmail);

    if (!current && version !== 0) {
      return res.status(409).json({ ok: false, current: EMPTY_POLICIES });
    }
    if (current && current.version !== version) {
      return res.status(409).json({ ok: false, current: project(current, 'policies') });
    }

    const newDoc = {
      policies,
      version: (current ? current.version : 0) + 1,
      updated_at: Date.now(),
    };

    const opts = current ? { ifMatch: current.etag } : { ifNoneMatch: '*' };
    const result = await s3.putDocument(req.userEmail, newDoc, opts);

    if (result.conflict) {
      const fresh = await s3.getDocument(req.userEmail);
      return res.status(409).json({
        ok: false,
        current: fresh ? project(fresh, 'policies') : EMPTY_POLICIES,
      });
    }

    res.json({ ok: true, version: newDoc.version, updated_at: newDoc.updated_at });
  } catch (err) {
    console.error('Sync PUT error:', err);
    res.status(500).json({ error: 'Sync PUT failed' });
  }
});

/***************
 * Devices
 *
 * Document at <email>/devices.json holds [{id, name, updated_at, deleted?}].
 * Same optimistic-concurrency + LWW-by-id merge as policies. When a device
 * entry is tombstoned, its usage shard is best-effort deleted so storage
 * doesn't accumulate forever.
 ***************/

router.get('/devices', async (req, res) => {
  try {
    const doc = await s3.getDevicesDocument(req.userEmail);
    res.json(doc ? project(doc, 'devices') : EMPTY_DEVICES);
  } catch (err) {
    console.error('Devices GET error:', err);
    res.status(500).json({ error: 'Devices GET failed' });
  }
});

router.put('/devices', async (req, res) => {
  const { devices, version } = req.body || {};
  if (!Array.isArray(devices)) {
    return res.status(400).json({ error: 'devices must be an array' });
  }
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return res.status(400).json({ error: 'version must be a non-negative integer' });
  }

  try {
    const current = await s3.getDevicesDocument(req.userEmail);

    if (!current && version !== 0) {
      return res.status(409).json({ ok: false, current: EMPTY_DEVICES });
    }
    if (current && current.version !== version) {
      return res.status(409).json({ ok: false, current: project(current, 'devices') });
    }

    const newDoc = {
      devices,
      version: (current ? current.version : 0) + 1,
      updated_at: Date.now(),
    };

    const opts = current ? { ifMatch: current.etag } : { ifNoneMatch: '*' };
    const result = await s3.putDevicesDocument(req.userEmail, newDoc, opts);

    if (result.conflict) {
      const fresh = await s3.getDevicesDocument(req.userEmail);
      return res.status(409).json({
        ok: false,
        current: fresh ? project(fresh, 'devices') : EMPTY_DEVICES,
      });
    }

    // Best-effort: prune usage shards for newly tombstoned devices.
    const previouslyAlive = new Set(
      ((current && current.devices) || []).filter((d) => !d.deleted).map((d) => d.id)
    );
    const tombstones = devices.filter((d) => d && d.deleted && previouslyAlive.has(d.id));
    await Promise.all(tombstones.map((d) =>
      s3.deleteUsageShard(req.userEmail, d.id).catch((err) => {
        console.error(`Failed to delete usage shard for ${d.id}:`, err);
      })
    ));

    res.json({ ok: true, version: newDoc.version, updated_at: newDoc.updated_at });
  } catch (err) {
    console.error('Devices PUT error:', err);
    res.status(500).json({ error: 'Devices PUT failed' });
  }
});

/***************
 * Usage shards
 *
 * Each device owns <email>/usage/<deviceId>.json containing
 *   { [date]: { [domain]: { [minute]: seconds } } }.
 * Daily totals across devices are computed by summing shards on read.
 *
 * /usage/today is the hot path called every sync — it returns just the
 * caller-supplied date's slice across all shards (small payload).
 * /usage returns the full set and is intended for the history view only.
 ***************/

// GET /sync/usage/today?date=YYYY-MM-DD
//   → { shards: { [deviceId]: { [domain]: { [minute]: seconds } } } }
router.get('/usage/today', async (req, res) => {
  const date = req.query.date;
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'date query param must be YYYY-MM-DD' });
  }
  try {
    const ids = await s3.listUsageDeviceIds(req.userEmail);
    const shards = {};
    await Promise.all(ids.map(async (id) => {
      const shard = await s3.getUsageShard(req.userEmail, id);
      const today = shard && shard[date];
      if (today) shards[id] = today;
    }));
    res.json({ shards });
  } catch (err) {
    console.error('Usage today GET error:', err);
    res.status(500).json({ error: 'Usage today GET failed' });
  }
});

// GET /sync/usage → { shards: { [deviceId]: shardData } }  (full history)
router.get('/usage', async (req, res) => {
  try {
    const ids = await s3.listUsageDeviceIds(req.userEmail);
    const shards = {};
    await Promise.all(ids.map(async (id) => {
      const shard = await s3.getUsageShard(req.userEmail, id);
      if (shard) shards[id] = shard;
    }));
    res.json({ shards });
  } catch (err) {
    console.error('Usage GET error:', err);
    res.status(500).json({ error: 'Usage GET failed' });
  }
});

// PUT /sync/usage  { device_id, shard }
//   shard: { [date]: { [domain]: { [minute]: seconds } } }
router.put('/usage', async (req, res) => {
  const { device_id: deviceId, shard } = req.body || {};
  if (typeof deviceId !== 'string' || !DEVICE_ID_RE.test(deviceId)) {
    return res.status(400).json({ error: 'device_id must be 1-64 chars [A-Za-z0-9_-]' });
  }
  if (!shard || typeof shard !== 'object' || Array.isArray(shard)) {
    return res.status(400).json({ error: 'shard must be an object' });
  }

  try {
    await s3.putUsageShard(req.userEmail, deviceId, shard);
    res.json({ ok: true });
  } catch (err) {
    console.error('Usage PUT error:', err);
    res.status(500).json({ error: 'Usage PUT failed' });
  }
});

module.exports = router;
