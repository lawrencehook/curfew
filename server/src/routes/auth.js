const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const storage = require('../storage');
const emailService = require('../services/email');
const { generateSessionToken } = require('../services/jwt');

const router = express.Router();

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function generateCode() {
  // crypto.randomInt is uniform; range [0, 10**6) padded to N digits.
  const max = 10 ** config.CODE_LENGTH;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(config.CODE_LENGTH, '0');
}

function clientIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || '0.0.0.0';
}

// POST /auth/request-code  { email } → { ok: true }
//
// Same response whether the email exists or not — never leak account existence.
router.post('/request-code', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const ip = clientIp(req);
    const ipLimit = storage.checkIpRateLimit(ip);
    if (!ipLimit.allowed) {
      const retryAfter = Math.ceil((ipLimit.resetTime - Date.now()) / 1000);
      res.set('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many requests, please try again later.', retryAfter });
    }

    const emailLimit = storage.checkEmailRateLimit(email);
    if (!emailLimit.allowed) {
      const retryAfter = Math.ceil((emailLimit.resetTime - Date.now()) / 1000);
      res.set('Retry-After', retryAfter);
      return res.status(429).json({ error: 'Too many requests, please try again later.', retryAfter });
    }

    const code = generateCode();
    storage.createLoginCode(email, code, { ip });

    try {
      await emailService.sendLoginCodeEmail(email, code);
    } catch (err) {
      console.error('Failed to send login code email:', err);
      return res.status(502).json({ error: 'Failed to send code email' });
    }

    console.log(`[auth] Login code sent to ${email}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('Error in request-code:', err);
    res.status(500).json({ error: 'Failed to request code' });
  }
});

// POST /auth/verify  { email, code } → { session_token, email } | 401
router.post('/verify', (req, res) => {
  try {
    const { email, code } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'Missing code' });
    }

    const result = storage.consumeLoginCode(email, code.trim());
    if (!result.ok) {
      const map = {
        no_code: 'No active code for this email.',
        expired: 'Code expired. Request a new one.',
        wrong_code: typeof result.remaining === 'number'
          ? `Wrong code. ${result.remaining} attempt${result.remaining === 1 ? '' : 's'} left.`
          : 'Wrong code.',
        too_many_attempts: 'Too many wrong attempts. Request a new code.',
      };
      return res.status(401).json({ error: map[result.reason] || 'Invalid code', reason: result.reason });
    }

    const lower = email.toLowerCase();
    const sessionToken = generateSessionToken({ email: lower });

    // Refund the email rate-limit count on successful verify (mirrors YT server pattern).
    storage.decrementEmailRateLimit(email);

    console.log(`[auth] User signed in: ${lower}`);
    res.json({ session_token: sessionToken, email: lower });
  } catch (err) {
    console.error('Error in verify:', err);
    res.status(500).json({ error: 'Failed to verify code' });
  }
});

module.exports = router;
