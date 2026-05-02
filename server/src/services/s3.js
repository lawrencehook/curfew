const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const config = require('../config');

const client = new S3Client({ region: config.AWS_REGION });

function key(email) {
  return `${config.S3_PREFIX}/${email.toLowerCase()}.json`;
}

// Returns { policies, version, updated_at, etag } or null if the object doesn't exist.
async function getDocument(email) {
  try {
    const r = await client.send(new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key(email),
    }));
    const body = await r.Body.transformToString();
    const parsed = JSON.parse(body);
    return { ...parsed, etag: r.ETag };
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// Optimistic-concurrency write.
//   { ifMatch: <etag> }      → update only if existing ETag matches.
//   { ifNoneMatch: '*' }     → create only if object doesn't exist.
// Returns { ok: true, etag } on success, { conflict: true } on a precondition mismatch.
async function putDocument(email, doc, { ifMatch, ifNoneMatch } = {}) {
  const params = {
    Bucket: config.S3_BUCKET,
    Key: key(email),
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

module.exports = {
  getDocument,
  putDocument,
};
