const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const config = require('../config');

const client = new S3Client({ region: config.AWS_REGION });

// Keys land at s3://<bucket>/<email>/policies.json. The per-email folder
// leaves room for sibling docs (usage, settings, etc.) without restructuring.
function key(email) {
  return `${email.toLowerCase()}/policies.json`;
}

function devicesKey(email) {
  return `${email.toLowerCase()}/devices.json`;
}

function usagePrefix(email) {
  return `${email.toLowerCase()}/usage/`;
}

function usageKey(email, deviceId) {
  return `${usagePrefix(email)}${deviceId}.json`;
}

async function getJsonAt(s3Key) {
  try {
    const r = await client.send(new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: s3Key,
    }));
    const body = await r.Body.transformToString();
    return { ...JSON.parse(body), etag: r.ETag };
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function putJsonAt(s3Key, doc, { ifMatch, ifNoneMatch } = {}) {
  const params = {
    Bucket: config.S3_BUCKET,
    Key: s3Key,
    Body: JSON.stringify(doc),
    ContentType: 'application/json',
  };
  if (ifMatch) params.IfMatch = ifMatch;
  if (ifNoneMatch) params.IfNoneMatch = ifNoneMatch;

  try {
    const r = await client.send(new PutObjectCommand(params));
    return { ok: true, etag: r.ETag };
  } catch (err) {
    if (err.name === 'PreconditionFailed' || err.$metadata?.httpStatusCode === 412) {
      return { conflict: true };
    }
    throw err;
  }
}

// Policies doc: { policies, version, updated_at, etag } or null.
const getDocument = (email) => getJsonAt(key(email));
// Optimistic-concurrency write — see getDocument for shape.
const putDocument = (email, doc, opts) => putJsonAt(key(email), doc, opts);

// Devices doc: { devices, version, updated_at, etag } or null.
const getDevicesDocument = (email) => getJsonAt(devicesKey(email));
const putDevicesDocument = (email, doc, opts) => putJsonAt(devicesKey(email), doc, opts);

// Returns the shard JSON ({date: {domain: {minute: seconds}}}) or null if missing.
async function getUsageShard(email, deviceId) {
  try {
    const r = await client.send(new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: usageKey(email, deviceId),
    }));
    const body = await r.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// Writes the shard for this device. No optimistic concurrency — the shard is
// device-owned and only one device writes its own key.
async function putUsageShard(email, deviceId, shard) {
  await client.send(new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: usageKey(email, deviceId),
    Body: JSON.stringify(shard),
    ContentType: 'application/json',
  }));
}

// Deletes a device's usage shard (called when the device entry is tombstoned).
async function deleteUsageShard(email, deviceId) {
  try {
    await client.send(new DeleteObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: usageKey(email, deviceId),
    }));
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return;
    throw err;
  }
}

// Lists every shard's deviceId under this email.
async function listUsageDeviceIds(email) {
  const prefix = usagePrefix(email);
  const ids = [];
  let token;
  do {
    const r = await client.send(new ListObjectsV2Command({
      Bucket: config.S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const obj of r.Contents || []) {
      const tail = obj.Key.slice(prefix.length);
      if (tail.endsWith('.json')) ids.push(tail.slice(0, -5));
    }
    token = r.IsTruncated ? r.NextContinuationToken : null;
  } while (token);
  return ids;
}

module.exports = {
  getDocument,
  putDocument,
  getDevicesDocument,
  putDevicesDocument,
  getUsageShard,
  putUsageShard,
  deleteUsageShard,
  listUsageDeviceIds,
};
