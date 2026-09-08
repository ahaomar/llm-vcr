const fs = require('fs');
const path = require('path');
const eventlog = require('./eventlog');
const { requestKey } = require('./canonical');

const FRONTEND_DIR = path.join(__dirname, '..', 'studio');

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon'
    }[ext] || 'application/octet-stream'
  );
}

function cassetteSummary(cassette, file) {
  return {
    key: cassette.key,
    file,
    model: (cassette.request.body && cassette.request.body.model) || 'unknown',
    path: cassette.request.path,
    method: cassette.request.method,
    streaming: !!cassette.streaming,
    recordedAt: cassette.recordedAt,
    tokens:
      cassette.usage && typeof cassette.usage.total_tokens === 'number'
        ? cassette.usage.total_tokens
        : 0,
    promptTokens:
      cassette.usage && typeof cassette.usage.prompt_tokens === 'number'
        ? cassette.usage.prompt_tokens
        : 0,
    completionTokens:
      cassette.usage && typeof cassette.usage.completion_tokens === 'number'
        ? cassette.usage.completion_tokens
        : 0,
    status: cassette.response.status
  };
}

function listCassetteFiles(state) {
  const files = fs
    .readdirSync(state.cassetteDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const out = [];
  for (const file of files) {
    try {
      const cassette = JSON.parse(fs.readFileSync(path.join(state.cassetteDir, file), 'utf8'));
      out.push(cassetteSummary(cassette, file));
    } catch {}
  }
  return out;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

function handleConfig(state, body) {
  const { client, baseUrl, apiKey, model } = body;
  const home = state.cwd;
  const safeModel = String(model || '').replace(/[^\w.\-\/]/g, '');
  if (!baseUrl || !model) {
    return { error: 'baseUrl and model are required' };
  }
  const keyLine = apiKey ? apiKey : 'YOUR_API_KEY_HERE';
  let fileName;
  let content;
  if (client === 'opencode') {
    fileName = 'opencode.json';
    content = JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          'vcr-replay': {
            npm: '@ai-sdk/openai-compatible',
            name: 'llm-vcr replay (local proxy)',
            options: {
              baseURL: `${baseUrl.replace(/\/+$/, '')}/v1`,
              apiKey: keyLine
            },
            models: {
              [safeModel]: { name: `${safeModel} via llm-vcr` }
            }
          }
        }
      },
      null,
      2
    );
  } else if (client === 'cursor') {
    fileName = 'cursor-vcr-setup.md';
    content = [
      '# Cursor → llm-vcr setup',
      '',
      '1. Open Cursor Settings → Models',
      `2. Set OpenAI API Base URL to: \`${baseUrl.replace(/\/+$/, '')}/v1\``,
      '3. Set API key to any placeholder (replay mode ignores it)',
      `4. Enable model: \`${safeModel}\``,
      '',
      'Cursor stores this in its own settings; this file is your reference.'
    ].join('\n');
  } else if (client === 'curl') {
    fileName = 'vcr-curl-examples.sh';
    content = [
      '#!/bin/sh',
      '# Test llm-vcr from the terminal',
      `curl -X POST ${baseUrl.replace(/\/+$/, '')}/v1/chat/completions \\`,
      `  -H 'content-type: application/json' \\`,
      `  -d '{"model":"${safeModel}","messages":[{"role":"user","content":"your prompt"}]}'`
    ].join('\n');
  } else {
    return { error: 'unknown client. use: opencode | cursor | curl' };
  }
  const filePath = path.join(home, fileName);
  const exists = fs.existsSync(filePath);
  fs.writeFileSync(filePath, content + '\n');
  return { written: filePath, created: !exists, fileName };
}

async function serveStudio(state, req, res, corsHeaders, sendJson) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/' || p === '/studio' || p === '/studio/') {
    res.writeHead(302, { location: '/studio/index.html' });
    res.end();
    return true;
  }

  if (p.startsWith('/__vcr/studio/api/')) {
    const api = p.replace('/__vcr/studio/api/', '');

    if (api === 'state' && req.method === 'GET') {
      sendJson(res, 200, {
        mode: state.mode,
        upstream: state.upstream,
        onMiss: state.onMiss,
        port: state.port,
        cassetteDir: path.basename(state.cassetteDir),
        stats: state.stats,
        totalCassettes: listCassetteFiles(state).length
      });
      return true;
    }

    if (api === 'mode' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const result = state.setMode(body.mode, body.upstream);
        sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        sendJson(res, 400, { ok: false, error: err.message });
      }
      return true;
    }

    if (api === 'cassettes' && req.method === 'GET') {
      const list = listCassetteFiles(state);
      const totals = list.reduce(
        (acc, c) => {
          acc.tokens += c.tokens;
          acc.promptTokens += c.promptTokens;
          acc.completionTokens += c.completionTokens;
          if (c.streaming) acc.streaming += 1;
          return acc;
        },
        { tokens: 0, promptTokens: 0, completionTokens: 0, streaming: 0 }
      );
      sendJson(res, 200, { cassettes: list, totals });
      return true;
    }

    if (api === 'cassettes/file' && req.method === 'GET') {
      const file = url.searchParams.get('name') || '';
      if (!/^[\w.\-]+$/.test(file) || !file.endsWith('.json')) {
        sendJson(res, 400, { error: 'invalid file name' });
        return true;
      }
      const full = path.join(state.cassetteDir, file);
      if (!fs.existsSync(full)) {
        sendJson(res, 404, { error: 'not found' });
        return true;
      }
      sendJson(res, 200, JSON.parse(fs.readFileSync(full, 'utf8')));
      return true;
    }

    if (api === 'cassettes/delete' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const file = String(body.file || '');
      if (!/^[\w.\-]+$/.test(file) || !file.endsWith('.json')) {
        sendJson(res, 400, { error: 'invalid file name' });
        return true;
      }
      const full = path.join(state.cassetteDir, file);
      if (fs.existsSync(full)) {
        fs.rmSync(full);
      }
      state.reloadCassettes();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (api === 'log' && req.method === 'GET') {
      sendJson(res, 200, { entries: eventlog.recent(200) });
      return true;
    }

    if (api === 'log/stream' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...corsHeaders()
      });
      res.write(`data: ${JSON.stringify({ kind: 'hello', mode: state.mode })}\n\n`);
      const unsubscribe = eventlog.onLog((entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      });
      const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(keepAlive);
        unsubscribe();
      });
      return true;
    }

    if (api === 'log/clear' && req.method === 'POST') {
      eventlog.clear();
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (api === 'drift' && req.method === 'GET') {
      sendJson(res, 200, { results: state.driftResults });
      return true;
    }

    if (api === 'config' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const result = handleConfig(state, body);
      if (result.error) {
        sendJson(res, 400, result);
      } else {
        sendJson(res, 200, result);
      }
      return true;
    }

    sendJson(res, 404, { error: 'unknown studio api' });
    return true;
  }

  if (p.startsWith('/studio/')) {
    const rel = p.replace('/studio/', '');
    const file = path.join(FRONTEND_DIR, rel);
    if (!file.startsWith(FRONTEND_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('studio: not found');
      return true;
    }
    res.writeHead(200, { 'content-type': mimeFor(file) });
    res.end(fs.readFileSync(file));
    return true;
  }

  return false;
}

module.exports = { serveStudio };
