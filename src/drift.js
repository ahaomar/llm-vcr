function diffLines(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    out.push(`- ${a[i]}`);
    i++;
  }
  while (j < m) {
    out.push(`+ ${b[j]}`);
    j++;
  }
  return out.join('\n');
}

function extractSseContent(raw) {
  const parts = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      continue;
    }
    try {
      const json = JSON.parse(payload);
      const delta = json.choices && json.choices[0];
      const text =
        (delta.delta && delta.delta.content) ||
        (delta.message && delta.message.content) ||
        (delta.text || '');
      if (text) {
        parts.push(text);
      }
    } catch {
      parts.push(payload);
    }
  }
  return parts.join('');
}

function extractJsonContent(raw) {
  try {
    const json = JSON.parse(raw);
    const choice = json.choices && json.choices[0];
    if (!choice) {
      return JSON.stringify(json).slice(0, 2000);
    }
    return (choice.message && choice.message.content) || choice.text || '';
  } catch {
    return raw.slice(0, 2000);
  }
}

function extractContent(contentType, rawBody) {
  if (/text\/event-stream/i.test(contentType || '')) {
    return extractSseContent(rawBody);
  }
  return extractJsonContent(rawBody);
}

module.exports = { diffLines, extractContent, extractSseContent, extractJsonContent };
