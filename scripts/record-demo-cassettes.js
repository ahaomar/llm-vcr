#!/usr/bin/env node
// Records demo cassettes against a local mock OpenAI server.
// No API key, no network, no cost. Run: npm run record:demo
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const CASSETTES = path.join(ROOT, 'cassettes');
const MOCK_PORT = 9099;
const VCR_PORT = 9090;

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(url, tries = 50) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {}
    await wait(100);
  }
  throw new Error(`service at ${url} did not start`);
}

async function main() {
  fs.mkdirSync(CASSETTES, { recursive: true });
  for (const f of fs.readdirSync(CASSETTES)) {
    if (f.endsWith('.json')) fs.unlinkSync(path.join(CASSETTES, f));
  }

  const mock = spawn('node', [path.join(ROOT, 'test/mock-openai.js')], {
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
    stdio: 'inherit'
  });
  const vcr = spawn(
    'node',
    [path.join(ROOT, 'bin/vcr.js')],
    {
      env: {
        ...process.env,
        VCR_MODE: 'record',
        VCR_UPSTREAM: `http://127.0.0.1:${MOCK_PORT}`,
        VCR_PORT: String(VCR_PORT),
        VCR_CASSETTES: CASSETTES
      },
      stdio: 'inherit'
    }
  );

  let replayVcr;
  let demo;
  let verify;

  try {
    await waitFor(`http://127.0.0.1:${MOCK_PORT}/__vcr/health`).catch(async () => {
      await waitFor(`http://127.0.0.1:${MOCK_PORT}`);
    });
    await waitFor(`http://127.0.0.1:${VCR_PORT}/__vcr/health`);

    process.env.DEMO_BASE_URL = `http://127.0.0.1:${VCR_PORT}`;
    demo = spawn('node', [path.join(ROOT, 'examples/demo.js')], {
      env: { ...process.env, DEMO_BASE_URL: `http://127.0.0.1:${VCR_PORT}` },
      stdio: 'inherit'
    });
    await new Promise((resolve, reject) => {
      demo.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('demo failed'))));
    });

    // replay verification pass against freshly recorded cassettes
    replayVcr = spawn(
      'node',
      [path.join(ROOT, 'bin/vcr.js')],
      {
        env: {
          ...process.env,
          VCR_MODE: 'replay',
          VCR_PORT: '9091',
          VCR_CASSETTES: CASSETTES
        },
        stdio: 'inherit'
      }
    );
    await waitFor('http://127.0.0.1:9091/__vcr/health');
    verify = spawn('node', [path.join(ROOT, 'examples/demo.js')], {
      env: { ...process.env, DEMO_BASE_URL: 'http://127.0.0.1:9091' },
      stdio: 'inherit'
    });
    await new Promise((resolve, reject) => {
      verify.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('replay verify failed'))));
    });

    const files = fs.readdirSync(CASSETTES).filter((f) => f.endsWith('.json'));
    console.log(`\n[record-demo] OK: ${files.length} cassettes recorded and replay-verified.`);
  } finally {
    for (const p of [mock, vcr, replayVcr, demo, verify]) {
      if (p && p.exitCode === null) {
        p.kill('SIGKILL');
      }
    }
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
