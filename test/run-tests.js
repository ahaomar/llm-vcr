#!/usr/bin/env node
// Full test suite: record -> replay -> miss -> scrub -> drift, no network, no API key.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'test', '.tmp');
const MOCK_PORT = 9199;
const VCR_PORT = 9190;
const REPLAY_PORT = 9191;
const DRIFT_PORT = 9192;

const PASSED = [];
const FAILED = [];

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await wait(100);
  }
  throw new Error(`service at ${url} did not start`);
}

function startNode(file, env) {
  return spawn('node', [file], { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function stopProc(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await wait(200);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

function test(name, fn) {
  return fn()
    .then(() => {
      PASSED.push(name);
      console.log(`  ok - ${name}`);
    })
    .catch((err) => {
      FAILED.push({ name, err });
      console.error(`  FAIL - ${name}`);
      console.error(`    ${err.message}`);
    });
}

const BODY_JSON = JSON.stringify({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hello in one short sentence.' }]
});
const BODY_STREAM = JSON.stringify({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
  stream: true
});
const BODY_SECRET = JSON.stringify({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'user', content: 'my key is sk-abcdef1234567890abcdef1234 keep it secret sk-test_1234567890abcdef123456' }
  ]
});

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });
  return res;
}

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  const mockEnv = { ...process.env, MOCK_PORT: String(MOCK_PORT) };
  const mock = startNode(path.join(ROOT, 'test/mock-openai.js'), mockEnv);
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/__vcr/health`).catch(async () => {
    await waitFor(`http://127.0.0.1:${MOCK_PORT}`);
  });

  // ---- PHASE 1: record ----
  const recordDir = path.join(TMP, 'cassettes-record');
  const vcrRecord = startNode(path.join(ROOT, 'bin/vcr.js'), {
    ...process.env,
    VCR_MODE: 'record',
    VCR_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
    VCR_PORT: String(VCR_PORT),
    VCR_CASSETTES: recordDir
  });
  await waitFor(`http://127.0.0.1:${VCR_PORT}/__vcr/health`);

  await test('record: non-streaming call is saved as cassette', async () => {
    const res = await post(VCR_PORT, '/v1/chat/completions', BODY_JSON);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-vcr'), 'recorded');
    const json = await res.json();
    assert.strictEqual(json.choices[0].message.content.startsWith('Hello! You said:'), true);
  });

  await test('record: streaming call is saved as cassette', async () => {
    const res = await post(VCR_PORT, '/v1/chat/completions', BODY_STREAM);
    assert.strictEqual(res.status, 200);
    const raw = await res.text();
    assert.strictEqual(raw.includes('data:'), true);
    assert.strictEqual(raw.includes('[DONE]'), true);
  });

  await test('record: secret scrubbing masks keys in cassettes', async () => {
    await post(VCR_PORT, '/v1/chat/completions', BODY_SECRET);
    await wait(300);
    const files = fs.readdirSync(recordDir).filter((f) => f.endsWith('.json'));
    let found = false;
    for (const f of files) {
      const text = fs.readFileSync(path.join(recordDir, f), 'utf8');
      if (text.includes('sk-abcdef1234567890abcdef1234')) {
        throw new Error(`unscrubbed secret found in ${f}`);
      }
      if (text.includes('[SCRUBBED:openai-key]')) {
        found = true;
      }
    }
    assert.strictEqual(found, true, 'expected scrubbed marker in cassettes');
  });

  await stopProc(vcrRecord);

  // ---- PHASE 2: replay ----
  const replayDir = path.join(TMP, 'cassettes-record');
  const vcrReplay = startNode(path.join(ROOT, 'bin/vcr.js'), {
    ...process.env,
    VCR_MODE: 'replay',
    VCR_PORT: String(REPLAY_PORT),
    VCR_CASSETTES: replayDir
  });
  await waitFor(`http://127.0.0.1:${REPLAY_PORT}/__vcr/health`);

  await test('replay: non-streaming cassette replays byte-identical content', async () => {
    const res = await post(REPLAY_PORT, '/v1/chat/completions', BODY_JSON);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-vcr'), 'replayed');
    const json = await res.json();
    assert.strictEqual(json.choices[0].message.content, 'Hello! You said: Say hello in one short sentence.');
  });

  await test('replay: streaming cassette replays full SSE sequence', async () => {
    const res = await post(REPLAY_PORT, '/v1/chat/completions', BODY_STREAM);
    assert.strictEqual(res.status, 200);
    const raw = await res.text();
    assert.strictEqual(raw.includes('Counting:'), true);
    assert.strictEqual(raw.includes('five.'), true);
    assert.strictEqual(raw.includes('[DONE]'), true);
  });

  await test('replay: different body = different key = 404 miss', async () => {
    const res = await post(REPLAY_PORT, '/v1/chat/completions', JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'totally different prompt' }]
    }));
    assert.strictEqual(res.status, 404);
    const json = await res.json();
    assert.strictEqual(json.error.type, 'vcr_cassette_missing');
  });

  await test('replay: key order in body does not change match', async () => {
    const res = await post(REPLAY_PORT, '/v1/chat/completions', JSON.stringify({
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      model: 'gpt-4o-mini'
    }));
    assert.strictEqual(res.status, 200);
  });

  await test('replay: health endpoint reports zero misses', async () => {
    const res = await fetch(`http://127.0.0.1:${REPLAY_PORT}/__vcr/health`);
    const json = await res.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.stats.missed, 1);
    assert.ok(json.stats.replayed >= 3);
  });

  await stopProc(vcrReplay);

  // ---- PHASE 3: replay with on-miss=record ----
  const hybridDir = path.join(TMP, 'cassettes-hybrid');
  fs.cpSync(recordDir, hybridDir, { recursive: true });
  const vcrHybrid = startNode(path.join(ROOT, 'bin/vcr.js'), {
    ...process.env,
    VCR_MODE: 'replay',
    VCR_ON_MISS: 'record',
    VCR_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
    VCR_PORT: '9193',
    VCR_CASSETTES: hybridDir
  });
  await waitFor('http://127.0.0.1:9193/__vcr/health');

  await test('replay+on-miss=record: known key replays, unknown key records', async () => {
    const replayed = await post(9193, '/v1/chat/completions', BODY_JSON);
    assert.strictEqual(replayed.headers.get('x-vcr'), 'replayed');
    const recorded = await post(9193, '/v1/chat/completions', JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'brand new prompt' }]
    }));
    assert.strictEqual(recorded.headers.get('x-vcr'), 'recorded');
    assert.strictEqual(recorded.status, 200);
  });

  await stopProc(vcrHybrid);

  // ---- PHASE 4: drift ----
  const driftDir = path.join(TMP, 'cassettes-drift');
  fs.cpSync(recordDir, driftDir, { recursive: true });
  const reportFile = path.join(TMP, 'drift-report.md');
  const vcrDrift = startNode(path.join(ROOT, 'bin/vcr.js'), {
    ...process.env,
    VCR_MODE: 'drift',
    VCR_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
    VCR_PORT: String(DRIFT_PORT),
    VCR_CASSETTES: driftDir,
    VCR_REPORT: reportFile
  });
  await waitFor(`http://127.0.0.1:${DRIFT_PORT}/__vcr/health`);

  await test('drift: unchanged model output reports MATCH', async () => {
    const res = await post(DRIFT_PORT, '/v1/chat/completions', BODY_JSON);
    assert.strictEqual(res.headers.get('x-vcr'), 'drift-match');
    assert.strictEqual(res.status, 200);
  });

  await test('drift: report file written with MATCH verdict', async () => {
    await wait(300);
    const report = fs.readFileSync(reportFile, 'utf8');
    assert.strictEqual(report.includes('MATCH'), true);
    assert.strictEqual(report.includes('drift-match'), false);
  });

  await stopProc(vcrDrift);

  // ---- PHASE 5: unit checks ----
  await test('unit: canonicalization sorts keys deterministically', async () => {
    const { requestKey } = require(path.join(ROOT, 'src/canonical'));
    const a = requestKey('POST', '/v1/x', JSON.stringify({ a: 1, b: { y: 2, x: 3 } }));
    const b = requestKey('POST', '/v1/x', JSON.stringify({ b: { x: 3, y: 2 }, a: 1 }));
    assert.strictEqual(a, b);
  });

  await test('unit: scrubber masks all key formats', async () => {
    const { scrubText } = require(path.join(ROOT, 'src/scrub'));
    const text = scrubText('sk-ant-abc123def456ghi789jkl012 Bearer abcdefghijklmnopqrst AKIAIOSFODNN7EXAMPLE ghz_abcdefghijklmnopqrstuvwxyz012345 AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU4');
    assert.strictEqual(text.includes('sk-ant-abc'), false);
    assert.strictEqual(text.includes('[SCRUBBED:'), true);
  });

  await test('unit: drift diff produces line diff', async () => {
    const { diffLines } = require(path.join(ROOT, 'src/drift'));
    const diff = diffLines('hello\nworld', 'hello\nthere');
    assert.strictEqual(diff.includes('- world'), true);
    assert.strictEqual(diff.includes('+ there'), true);
  });

  console.log('\n=========================================');
  console.log(`PASSED: ${PASSED.length}  FAILED: ${FAILED.length}`);
  if (FAILED.length) {
    process.exit(1);
  }
  await stopProc(mock);
  process.exit(0);
}

main().catch(async (err) => {
  console.error('fatal:', err);
  process.exit(1);
});
