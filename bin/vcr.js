#!/usr/bin/env node
const { createServer } = require('../src/proxy');

function die(message) {
  console.error(`[vcr] ${message}`);
  process.exit(1);
}

const VALID_MODES = ['record', 'replay', 'drift'];
const mode = (process.env.VCR_MODE || 'replay').toLowerCase();
if (!VALID_MODES.includes(mode)) {
  die(`Invalid VCR_MODE "${mode}". Use one of: ${VALID_MODES.join(', ')}`);
}

const config = {
  mode,
  upstream: process.env.VCR_UPSTREAM || '',
  cassetteDir: process.env.VCR_CASSETTES || './cassettes',
  port: Number(process.env.VCR_PORT || 9090),
  onMiss: (process.env.VCR_ON_MISS || 'error').toLowerCase(),
  upstreamTimeoutMs: Number(process.env.VCR_UPSTREAM_TIMEOUT_MS || 120000),
  reportFile: process.env.VCR_REPORT || '.vcr-drift-report.md'
};

if (config.onMiss !== 'error' && config.onMiss !== 'record') {
  die(`Invalid VCR_ON_MISS "${config.onMiss}". Use: error | record`);
}

const { server, state, stats } = createServer(config);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[vcr] Port ${config.port} is already in use.`);
    console.error(`[vcr] Another llm-vcr (or other app) is running on it. Find it:  lsof -i :${config.port}`);
    console.error(`[vcr] Kill it:  kill $(lsof -ti :${config.port})   or pick another port:  VCR_PORT=9091`);
  } else {
    console.error(`[vcr] server error: ${err.stack || err.message}`);
  }
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  console.error(`[vcr] unexpected error: ${err.stack || err.message}`);
  console.error('[vcr] server stays up.');
});

process.on('unhandledRejection', (err) => {
  console.error(`[vcr] async error: ${err && (err.stack || err.message) || err}`);
  console.error('[vcr] server stays up.');
});

server.listen(config.port, () => {
  console.log(`[vcr] llm-vcr listening on http://localhost:${config.port}`);
  console.log(`[vcr] Studio UI:  http://localhost:${config.port}/studio  (record/replay/cassettes/live log)`);
  console.log(`[vcr] mode=${state.mode} cassettes=${config.cassetteDir} upstream=${state.upstream || '(none)'}`);
  if (state.mode === 'replay') {
    console.log('[vcr] point your app at this proxy and run your tests. no API key needed.');
  }
  if (state.mode === 'record') {
    console.log('[vcr] live calls will pass through and be saved as cassettes.');
  }
  if (state.mode === 'drift') {
    console.log(
      `[vcr] live calls pass through and are diffed against cassettes. report: ${config.reportFile}`
    );
  }
});

process.on('SIGINT', () => {
  console.log(`[vcr] shutting down. stats: ${JSON.stringify(stats)}`);
  process.exit(0);
});
