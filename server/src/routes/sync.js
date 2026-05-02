const express = require('express');
const s3 = require('../services/s3');
const { requireAuth } = require('../services/jwt');

const router = express.Router();

// All sync routes require a valid session token.
router.use(requireAuth);

const EMPTY_DOC = { policies: [], version: 0, updated_at: null };

function project(doc) {
  // Strip the etag from the wire response — clients drive concurrency by version.
  return {
    policies: doc.policies,
    version: doc.version,
    updated_at: doc.updated_at,
  };
}

// GET /sync → { policies, version, updated_at }
router.get('/', async (req, res) => {
  try {
    const doc = await s3.getDocument(req.userEmail);
    res.json(doc ? project(doc) : EMPTY_DOC);
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

    // Pre-check: caller's version doesn't match what's already there.
    if (!current && version !== 0) {
      return res.status(409).json({ ok: false, current: EMPTY_DOC });
    }
    if (current && current.version !== version) {
      return res.status(409).json({ ok: false, current: project(current) });
    }

    const newDoc = {
      policies,
      version: (current ? current.version : 0) + 1,
      updated_at: Date.now(),
    };

    const opts = current ? { ifMatch: current.etag } : { ifNoneMatch: '*' };
    const result = await s3.putDocument(req.userEmail, newDoc, opts);

    if (result.conflict) {
      // Race: another writer slipped in between our GET and PUT. Return their state.
      const fresh = await s3.getDocument(req.userEmail);
      return res.status(409).json({ ok: false, current: fresh ? project(fresh) : EMPTY_DOC });
    }

    res.json({ ok: true, version: newDoc.version, updated_at: newDoc.updated_at });
  } catch (err) {
    console.error('Sync PUT error:', err);
    res.status(500).json({ error: 'Sync PUT failed' });
  }
});

module.exports = router;
