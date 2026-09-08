const crypto = require('crypto');

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalBody(raw) {
  if (raw === undefined || raw === null || raw === '') {
    return '';
  }
  try {
    return JSON.stringify(sortKeys(JSON.parse(raw)));
  } catch {
    return String(raw);
  }
}

function requestKey(method, path, rawBody) {
  const canonical = canonicalBody(rawBody);
  const hash = crypto
    .createHash('sha256')
    .update(`${method.toUpperCase()}\n${path}\n${canonical}`)
    .digest('hex');
  return hash.slice(0, 12);
}

function keyToFilename(method, path, key) {
  const name = path
    .replace(/^\/+/, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'root';
  return `${name}-${key}.json`;
}

module.exports = { sortKeys, canonicalBody, requestKey, keyToFilename };
