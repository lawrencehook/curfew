// End-to-end smoke test for the auth + sync flow.
//
// Boots the Express app on an ephemeral port against a temp SQLite file
// (login codes + rate limits) and stubbed email + S3 services, then
// exercises the same paths a real extension client takes.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Env must be set before requiring the app.
process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
process.env.EMAIL_FROM = 'test@example.com';
process.env.S3_BUCKET = 'test-bucket';
process.env.AWS_ACCESS_KEY_ID = 'x';
process.env.AWS_SECRET_ACCESS_KEY = 'x';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curb-smoke-'));
process.env.DATA_DIR = tmpDir;

// Stub the email service.
let lastCode = null;
const emailPath = require.resolve('../src/services/email');
require.cache[emailPath] = {
  id: emailPath,
  filename: emailPath,
  loaded: true,
  exports: {
    sendLoginCodeEmail: async (_email, code) => {
      lastCode = code;
    },
  },
};

// Stub the S3 service. In-memory map keyed by email, mimicking
// optimistic-concurrency semantics via ETags.
const s3Store = new Map();
let etagCounter = 0;
const s3Path = require.resolve('../src/services/s3');
require.cache[s3Path] = {
  id: s3Path,
  filename: s3Path,
  loaded: true,
  exports: {
    getDocument: async (email) => {
      const entry = s3Store.get(email.toLowerCase());
      return entry ? { ...entry.doc, etag: entry.etag } : null;
    },
    putDocument: async (email, doc, opts = {}) => {
      const k = email.toLowerCase();
      const existing = s3Store.get(k);
      if (opts.ifNoneMatch === '*' && existing) return { conflict: true };
      if (opts.ifMatch && (!existing || existing.etag !== opts.ifMatch)) return { conflict: true };
      const etag = `"e${++etagCounter}"`;
      s3Store.set(k, { doc, etag });
      return { ok: true, etag };
    },
  },
};

const { app } = require('../src/index.js');
const storage = require('../src/storage');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  storage.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const post = (p, body, headers = {}) =>
  fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const put = (p, body, headers = {}) =>
  fetch(baseUrl + p, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const get = (p, headers = {}) => fetch(baseUrl + p, { headers });

async function signIn(email) {
  email = email || `user-${crypto.randomBytes(4).toString('hex')}@example.com`;
  await post('/auth/request-code', { email });
  const r = await post('/auth/verify', { email, code: lastCode });
  assert.equal(r.status, 200, 'verify should succeed');
  const body = await r.json();
  return {
    email,
    token: body.session_token,
    auth: { Authorization: `Bearer ${body.session_token}` },
  };
}

test('health endpoint returns ok', async () => {
  const r = await get('/health');
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.status, 'ok');
});

test('sync requires auth', async () => {
  const r = await get('/sync');
  assert.equal(r.status, 401);
});

test('request-code rejects malformed email', async () => {
  const r = await post('/auth/request-code', { email: 'not-an-email' });
  assert.equal(r.status, 400);
});

test('verify with no active code returns no_code', async () => {
  const r = await post('/auth/verify', {
    email: 'never-asked@example.com',
    code: '000000',
  });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.reason, 'no_code');
});

test('full sign-in + sync round trip', async () => {
  const { auth } = await signIn();

  // Initial sync: empty doc, version 0.
  let r = await get('/sync', auth);
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.deepEqual(body, { policies: [], version: 0, updated_at: null });

  // PUT first version.
  r = await put('/sync', { policies: [{ id: 'p1', name: 'Test' }], version: 0 }, auth);
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.version, 1);

  // GET reflects PUT.
  r = await get('/sync', auth);
  body = await r.json();
  assert.equal(body.version, 1);
  assert.deepEqual(body.policies, [{ id: 'p1', name: 'Test' }]);

  // Stale PUT (race condition simulation) → 409 with server state.
  r = await put('/sync', { policies: [], version: 0 }, auth);
  assert.equal(r.status, 409);
  body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.current.version, 1);
  assert.deepEqual(body.current.policies, [{ id: 'p1', name: 'Test' }]);

  // Follow-up PUT with current version succeeds and bumps to 2.
  r = await put('/sync', { policies: [{ id: 'p2' }], version: 1 }, auth);
  assert.equal(r.status, 200);
  body = await r.json();
  assert.equal(body.version, 2);
});

test('code is single-use', async () => {
  const email = `single-use-${crypto.randomBytes(4).toString('hex')}@example.com`;
  await post('/auth/request-code', { email });
  const code = lastCode;

  let r = await post('/auth/verify', { email, code });
  assert.equal(r.status, 200);

  // Reusing the consumed code returns no_code, not wrong_code.
  r = await post('/auth/verify', { email, code });
  assert.equal(r.status, 401);
  const body = await r.json();
  assert.equal(body.reason, 'no_code');
});

test('code locks after max wrong attempts', async () => {
  const email = `attempts-${crypto.randomBytes(4).toString('hex')}@example.com`;
  await post('/auth/request-code', { email });
  const correct = lastCode;

  for (let i = 0; i < 4; i++) {
    const r = await post('/auth/verify', { email, code: '999999' });
    assert.equal(r.status, 401);
    const body = await r.json();
    assert.equal(body.reason, 'wrong_code');
  }
  // 5th wrong attempt purges the code.
  const r = await post('/auth/verify', { email, code: '999999' });
  assert.equal(r.status, 401);

  // Even the correct code fails now — must request a new one.
  const after = await post('/auth/verify', { email, code: correct });
  assert.equal(after.status, 401);
  const body = await after.json();
  assert.equal(body.reason, 'no_code');
});

test('PUT with non-zero version on empty user returns 409', async () => {
  const { auth } = await signIn();
  const r = await put('/sync', { policies: [{ id: 'x' }], version: 5 }, auth);
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.equal(body.current.version, 0);
  assert.deepEqual(body.current.policies, []);
});

test('PUT validates body shape', async () => {
  const { auth } = await signIn();
  let r = await put('/sync', { policies: 'not-an-array', version: 0 }, auth);
  assert.equal(r.status, 400);
  r = await put('/sync', { policies: [], version: -1 }, auth);
  assert.equal(r.status, 400);
  r = await put('/sync', { policies: [], version: 'oops' }, auth);
  assert.equal(r.status, 400);
});
