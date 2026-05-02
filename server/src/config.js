// Configuration constants
// All timing values in milliseconds unless noted.
// Use getters for values that may change in tests.

module.exports = {
  // Server
  get PORT() { return process.env.PORT || 3000; },
  get BASE_URL() { return process.env.BASE_URL || 'http://localhost:3000'; },

  // JWT
  get JWT_SECRET() { return process.env.JWT_SECRET; },
  SESSION_TOKEN_LIFETIME_DAYS: 30,

  // Auth code timing & limits
  CODE_LENGTH: 6,
  CODE_EXPIRY_MS: 10 * 60 * 1000,            // 10 minutes
  CODE_MAX_ATTEMPTS: 5,                       // wrong-code lock
  RATE_LIMIT_WINDOW_MS: 60 * 60 * 1000,       // 1 hour
  RATE_LIMIT_MAX_REQUESTS: 5,                  // per email per window
  IP_RATE_LIMIT_WINDOW_MS: 60 * 60 * 1000,    // 1 hour
  IP_RATE_LIMIT_MAX_REQUESTS: 10,              // per IP per window

  // AWS SES
  get AWS_REGION() { return process.env.AWS_REGION || 'us-east-1'; },
  get EMAIL_FROM() { return process.env.EMAIL_FROM; },

  // AWS S3 (sync documents)
  get S3_BUCKET() { return process.env.S3_BUCKET; },
  get S3_PREFIX() { return process.env.S3_PREFIX || 'curb'; },

  // File paths
  get DATA_DIR() { return process.env.DATA_DIR || './data'; },
};
