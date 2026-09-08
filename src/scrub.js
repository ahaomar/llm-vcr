const SCRUB_PATTERNS = [
  { name: 'openai-key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'anthropic-key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: 'bearer', re: /Bearer\s+[A-Za-z0-9._-]{16,}/gi },
  { name: 'aws-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'google-key', re: /AIza[A-Za-z0-9_-]{35}/g }
];

const SENSITIVE_KEYS = /authorization|api[-_]?key|token(?!s)|secret|password|cookie/i;

function scrubText(text) {
  let out = text;
  for (const { re, name } of SCRUB_PATTERNS) {
    out = out.replace(re, `[SCRUBBED:${name}]`);
  }
  return out;
}

function scrubDeep(value) {
  if (typeof value === 'string') {
    return scrubText(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubDeep);
  }
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_KEYS.test(key)) {
        out[key] = '[SCRUBBED]';
      } else {
        out[key] = scrubDeep(val);
      }
    }
    return out;
  }
  return value;
}

module.exports = { scrubText, scrubDeep, SENSITIVE_KEYS };
