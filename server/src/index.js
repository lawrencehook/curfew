require('dotenv').config();

// Add timestamps to all console output
const originalLog = console.log;
const originalError = console.error;
const timestamp = () => new Date().toISOString();
console.log = (...args) => originalLog(timestamp(), ...args);
console.error = (...args) => originalError(timestamp(), ...args);

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const config = require('./config');
const storage = require('./storage');

const authRoutes = require('./routes/auth');
const syncRoutes = require('./routes/sync');

const app = express();

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) {
    return true;
  }
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json({ limit: '256kb' }));

// Email is set by requireAuth (from JWT) for authed routes,
// or read from the body on unauth routes like /auth/request-code.
morgan.token('email', (req) => req.userEmail || (req.body && req.body.email) || '-');

app.use(morgan(':method :url :status :response-time ms email=:email', {
  stream: { write: msg => console.log(msg.trimEnd()) },
}));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/auth', authRoutes);
app.use('/sync', syncRoutes);

app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS origin denied' });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Periodic cleanup of expired data
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function runCleanup() {
  try {
    storage.pruneExpiredLoginCodes();
    storage.pruneExpiredEmailRateLimits();
    storage.pruneExpiredIpRateLimits();
  } catch (err) {
    console.error('Cleanup error:', err);
  }
}

function start() {
  const required = ['JWT_SECRET', 'EMAIL_FROM', 'S3_BUCKET'];
  const missing = required.filter(key => !config[key]);
  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('See .env.example for required configuration');
    process.exit(1);
  }
  if (config.JWT_SECRET.length < 32) {
    console.error('JWT_SECRET must be at least 32 characters long');
    process.exit(1);
  }

  storage.ensureDirectories();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  app.listen(config.PORT, () => {
    console.log(`Curb sync server running on port ${config.PORT}`);
    console.log(`Base URL: ${config.BASE_URL}`);
  });
}

module.exports = { app, start };

if (require.main === module) {
  start();
}
