// One-shot storage migrations, run at background-script load time.
//
// Today this covers:
//
//   1. Policy shape — legacy `sites` / `limits` arrays → `policies` array.
//      `sites` was the original per-domain shape (`{domain, limits: [...]}` or
//      `{domain, daily_limit_minutes}`); `limits` was a brief flat multi-domain
//      shape. Both fold into the current `policies = [{id, name, domains, rules}]`.
//
//   2. Rule type — `bucket` (token-bucket rate limit) → `sliding`
//      (rolling-window counter). `capacityMin` → `minutes`.
//
//   3. Cleanup — drop the dead `buckets` storage key left behind by the
//      old token-bucket implementation.
//
// Read shims for the in-memory `usage[domain]` shape (legacy flat-number
// entries vs. `{[minute]: seconds}` maps) live with their readers in
// background/main.js and edit/main.js, since they're hot-path tolerances
// rather than one-shot upgrades.

function _newId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'r_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function _bucketToSliding(r) {
  return { id: r.id, type: 'sliding', minutes: r.capacityMin, windowMin: r.windowMin };
}

// Pure transform: build the canonical `policies` list from whichever legacy
// shape is present, and rewrite any `bucket` rules to `sliding`. Returns
// { policies, changed }; `changed` signals that storage needs to be rewritten.
function migratePolicies(rawSites, rawLimits, rawPolicies) {
  let policies;
  let changed = false;

  if (Array.isArray(rawPolicies)) {
    policies = rawPolicies;
  } else if (Array.isArray(rawLimits)) {
    policies = [];
    let n = 0;
    for (const lim of rawLimits) {
      n++;
      let rule;
      if (lim.type === 'daily') {
        rule = { id: lim.id || _newId(), type: 'daily', minutes: lim.minutes };
      } else if (lim.type === 'bucket' || lim.type === 'sliding') {
        rule = {
          id: lim.id || _newId(),
          type: 'sliding',
          minutes: lim.type === 'bucket' ? lim.capacityMin : lim.minutes,
          windowMin: lim.windowMin,
        };
      } else continue;
      policies.push({
        id: _newId(),
        name: `Policy ${n}`,
        domains: (lim.domains || []).slice(),
        rules: [rule],
      });
    }
    changed = true;
  } else {
    policies = [];
    let n = 0;
    for (const s of rawSites || []) {
      const inline = Array.isArray(s.limits)
        ? s.limits
        : typeof s.daily_limit_minutes === 'number'
          ? [{ type: 'daily', minutes: s.daily_limit_minutes }]
          : [];
      for (const l of inline) {
        n++;
        let rule;
        if (l.type === 'daily') {
          rule = { id: _newId(), type: 'daily', minutes: l.minutes };
        } else if (l.type === 'bucket' || l.type === 'sliding') {
          rule = {
            id: _newId(),
            type: 'sliding',
            minutes: l.type === 'bucket' ? l.capacityMin : l.minutes,
            windowMin: l.windowMin,
          };
        } else continue;
        policies.push({
          id: _newId(),
          name: `Policy ${n}`,
          domains: [s.domain],
          rules: [rule],
        });
      }
    }
    changed = true;
  }

  // Catches both the `rawPolicies` passthrough above and any imports of
  // older exports that slipped past validation.
  for (const p of policies) {
    if (!Array.isArray(p.rules)) continue;
    for (let i = 0; i < p.rules.length; i++) {
      const r = p.rules[i];
      if (r && r.type === 'bucket') {
        p.rules[i] = _bucketToSliding(r);
        changed = true;
      }
    }
  }

  return { policies, changed };
}

// Apply every migration against `storage` (a browser.storage.local-shaped
// API). Returns the migrated `policies` array.
async function runMigrations(storage) {
  const data = await storage.get(['sites', 'limits', 'policies', 'buckets']);
  const { policies, changed } = migratePolicies(data.sites, data.limits, data.policies);

  if (changed) {
    await storage.set({ policies });
    const stale = [];
    if (data.sites !== undefined) stale.push('sites');
    if (data.limits !== undefined) stale.push('limits');
    if (stale.length) await storage.remove(stale);
  }

  if (data.buckets !== undefined) await storage.remove('buckets');

  return policies;
}
