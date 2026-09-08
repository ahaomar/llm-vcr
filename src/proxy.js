const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { requestKey, keyToFilename } = require('./canonical');
const { loadCassettes, saveCassette } = require('./cassette');
const { scrubDeep, scrubText } = require('./scrub');
const { diffLines, extractContent } = require('./drift');
const eventlog = require('./eventlog');
const { serveStudio } = require('./studio');

const MAX_BODY = 25 * 1024 * 1024;
const VALID_MODES = ['record', 'replay', 'drift'];

function buildUsage(promptText, completionText, model, recordedUsage) {
  if (recordedUsage && typeof recordedUsage === 'object') {
    return recordedUsage;
  }
  const approx = (text) => (text ? Math.ceil(text.length / 4) : 0);
  return {
    prompt_tokens: approx(promptText),
    completion_tokens: approx(completionText),
    total_tokens: approx(promptText) + approx(completionText),
    model,
    approximated: true
  };
}

function getModel(rawBody) {
  try {
    return JSON.parse(rawBody).model || 'unknown';
  } catch {
    return 'unknown';
  }
}

function createServer(config) {
  const cassetteDir = path.resolve(config.cassetteDir);
  fs.mkdirSync(cassetteDir, { recursive: true });

  const state = {
    mode: config.mode,
    upstream: config.upstream || '',
    onMiss: config.onMiss || 'error',
    reportFile: config.reportFile || '.vcr-drift-report.md',
    cassetteDir,
    port: config.port,
    cwd: process.cwd(),
    stats: { replayed: 0, recorded: 0, missed: 0, driftMatch: 0, driftDiff: 0 },
    cassettes: config.mode === 'record' ? new Map() : loadCassettes(cassetteDir),
    driftResults: [],
    VALID_MODES
  };

  state.setMode = (mode, upstream) => {
    if (!VALID_MODES.includes(mode)) {
      throw new Error(`invalid mode "${mode}"`);
    }
    state.mode = mode;
    if (upstream !== undefined && upstream !== null && upstream !== '') {
      state.upstream = String(upstream).replace(/\/+$/, '');
    }
    if (mode !== 'record') {
      state.cassettes = loadCassettes(cassetteDir);
    }
    eventlog.emit({ ts: Date.now(), kind: 'mode', mode: state.mode, upstream: state.upstream });
    return { mode: state.mode, upstream: state.upstream };
  };

  state.reloadCassettes = () => {
    state.cassettes = loadCassettes(cassetteDir);
    return state.cassettes.size;
  };

  function corsHeaders() {
    return {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS'
    };
  }

  function sendJson(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      ...corsHeaders(),
      ...extraHeaders
    });
    res.end(body);
  }

  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY) {
        throw new Error('request body too large');
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function forwardUpstream(req, res, bodyBuffer) {
    if (!state.upstream) {
      sendJson(res, 400, {
        error: {
          type: 'vcr_no_upstream',
          message: 'No upstream configured. Set it in the Studio UI or via VCR_UPSTREAM.'
        }
      });
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const upstream = new URL(state.upstream);
      const isHttps = upstream.protocol === 'https:';
      const mod = isHttps ? https : http;
      const headers = { ...req.headers };
      delete headers.host;
      delete headers['content-length'];
      headers.host = upstream.host;
      headers['accept-encoding'] = 'identity';
      headers['content-length'] = String(bodyBuffer.length);
      const upstreamReq = mod.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || (isHttps ? 443 : 80),
          path: upstream.pathname.replace(/\/$/, '') + req.url,
          method: req.method,
          headers
        },
        (upstreamRes) => resolve(upstreamRes)
      );
      upstreamReq.setTimeout(config.upstreamTimeoutMs, () => {
        upstreamReq.destroy(new Error('upstream timeout'));
      });
      upstreamReq.on('error', (err) => {
        sendJson(res, 502, {
          error: { type: 'vcr_upstream_error', message: err.message }
        });
        resolve(null);
      });
      if (bodyBuffer.length) {
        upstreamReq.write(bodyBuffer);
      }
      upstreamReq.end();
    });
  }

  function buildCassette(key, method, reqPath, rawBody, status, contentType, respRaw, isStream) {
    const reqParsed = (() => {
      try {
        return JSON.parse(rawBody);
      } catch {
        return rawBody;
      }
    })();
    const respParsed = isStream
      ? null
      : (() => {
          try {
            return JSON.parse(respRaw);
          } catch {
            return null;
          }
        })();
    let promptText = '';
    if (reqParsed && typeof reqParsed === 'object' && Array.isArray(reqParsed.messages)) {
      promptText = reqParsed.messages
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
        .join('\n');
    } else if (reqParsed && typeof reqParsed === 'object' && typeof reqParsed.prompt === 'string') {
      promptText = reqParsed.prompt;
    }
    const completionText = isStream
      ? extractContent('text/event-stream', respRaw)
      : extractContent(contentType, respRaw);
    return {
      version: 1,
      key,
      recordedAt: new Date().toISOString(),
      streaming: isStream,
      request: { method, path: reqPath, body: scrubDeep(reqParsed) },
      response: {
        status,
        headers: { 'content-type': contentType },
        body: respParsed ? scrubDeep(respParsed) : scrubText(respRaw),
        chunks: isStream ? respRaw.split(/(?=data:)/g).filter((c) => c.trim()) : undefined
      },
      usage: buildUsage(
        promptText,
        completionText,
        reqParsed && reqParsed.model ? reqParsed.model : 'unknown',
        respParsed && respParsed.usage ? respParsed.usage : null
      )
    };
  }

  function replayCassette(res, cassette, filename) {
    state.stats.replayed += 1;
    const headers = {
      'content-type': cassette.response.headers['content-type'] || 'application/json',
      'x-vcr': 'replayed',
      'x-vcr-cassette': filename,
      ...corsHeaders()
    };
    eventlog.emit({
      ts: Date.now(),
      kind: 'request',
      mode: state.mode,
      method: 'POST',
      path: cassette.request.path,
      key: cassette.key,
      verdict: 'replayed',
      model: cassetteModel(cassette),
      tokens: cassette.usage ? cassette.usage.total_tokens : 0,
      status: cassette.response.status,
      streaming: !!cassette.streaming
    });
    if (cassette.streaming && Array.isArray(cassette.response.chunks)) {
      res.writeHead(cassette.response.status, headers);
      for (const chunk of cassette.response.chunks) {
        res.write(chunk.endsWith('\n') ? chunk : chunk + '\n');
      }
      res.end();
    } else {
      const body =
        typeof cassette.response.body === 'string'
          ? cassette.response.body
          : JSON.stringify(cassette.response.body);
      headers['content-length'] = Buffer.byteLength(body);
      res.writeHead(cassette.response.status, headers);
      res.end(body);
    }
  }

  function cassetteModel(cassette) {
    const body = cassette.request && cassette.request.body;
    if (body && typeof body === 'object' && body.model) {
      return body.model;
    }
    return cassette.usage ? cassette.usage.model || 'unknown' : 'unknown';
  }

  async function handleRecordPassthrough(req, res, key, bodyBuffer, rawBody, label) {
    const started = Date.now();
    const upstreamRes = await forwardUpstream(req, res, bodyBuffer);
    if (!upstreamRes) {
      return;
    }
    const contentType = upstreamRes.headers['content-type'] || 'application/json';
    const isStream = /text\/event-stream/i.test(contentType);
    const parts = [];
    upstreamRes.on('data', (chunk) => {
      parts.push(chunk);
    });
    await new Promise((resolve) => upstreamRes.on('end', resolve));
    const respRaw = Buffer.concat(parts).toString('utf8');
    try {
      const cassette = buildCassette(
        key,
        req.method,
        req.url,
        rawBody,
        upstreamRes.statusCode,
        contentType,
        respRaw,
        isStream
      );
      const file = saveCassette(cassetteDir, cassette);
      state.cassettes.set(key, cassette);
      eventlog.emit({
        ts: Date.now(),
        kind: 'request',
        mode: state.mode,
        method: req.method,
        path: req.url,
        key,
        verdict: label === 'record' ? 'recorded' : 'auto-recorded',
        model: cassetteModel(cassette),
        tokens: cassette.usage ? cassette.usage.total_tokens : 0,
        status: upstreamRes.statusCode,
        streaming: isStream,
        durationMs: Date.now() - started,
        file: path.basename(file)
      });
      console.log(`[vcr:${label}] saved ${file}`);
      if (label === 'record') {
        state.stats.recorded += 1;
      }
    } catch (err) {
      console.error(`[vcr] failed to save cassette: ${err.message}`);
    }
    const headers = { ...upstreamRes.headers };
    delete headers['transfer-encoding'];
    delete headers['content-encoding'];
    headers['content-length'] = Buffer.byteLength(respRaw);
    headers['x-vcr'] = 'recorded';
    res.writeHead(upstreamRes.statusCode, { ...headers, ...corsHeaders() });
    res.end(respRaw);
  }

  async function handleDrift(req, res, key, bodyBuffer, rawBody) {
    const started = Date.now();
    const cassette = state.cassettes.get(key);
    const upstreamRes = await forwardUpstream(req, res, bodyBuffer);
    if (!upstreamRes) {
      return;
    }
    const contentType = upstreamRes.headers['content-type'] || 'application/json';
    const parts = [];
    upstreamRes.on('data', (chunk) => parts.push(chunk));
    await new Promise((resolve) => upstreamRes.on('end', resolve));
    const respRaw = Buffer.concat(parts).toString('utf8');

    let verdict = 'NO_CASSETTE';
    let diff = '';
    if (cassette) {
      const expected = extractContent(
        cassette.response.headers['content-type'],
        typeof cassette.response.body === 'string'
          ? cassette.response.body
          : JSON.stringify(cassette.response.body)
      );
      const actual = extractContent(contentType, respRaw);
      verdict = expected === actual ? 'MATCH' : 'DIFF';
      if (verdict === 'MATCH') {
        state.stats.driftMatch += 1;
      } else {
        state.stats.driftDiff += 1;
        diff = diffLines(expected, actual);
      }
    }
    state.driftResults.push({
      ts: Date.now(),
      method: req.method,
      path: req.url,
      key,
      verdict,
      model: getModel(rawBody),
      expected: cassette ? cassette.response.body : null,
      actual: contentType.includes('json') ? safeJson(respRaw) : respRaw,
      diff
    });
    if (state.driftResults.length > 100) {
      state.driftResults.shift();
    }
    writeDriftReport(state.reportFile, state.driftResults, state.upstream);
    eventlog.emit({
      ts: Date.now(),
      kind: 'request',
      mode: state.mode,
      method: req.method,
      path: req.url,
      key,
      verdict: `drift-${verdict.toLowerCase()}`,
      model: getModel(rawBody),
      status: upstreamRes.statusCode,
      durationMs: Date.now() - started
    });
    console.log(`[vcr:drift] ${req.method} ${req.url} -> ${verdict}`);

    const headers = { ...upstreamRes.headers };
    delete headers['transfer-encoding'];
    delete headers['content-encoding'];
    headers['content-length'] = Buffer.byteLength(respRaw);
    headers['x-vcr'] = `drift-${verdict.toLowerCase()}`;
    res.writeHead(upstreamRes.statusCode, { ...headers, ...corsHeaders() });
    res.end(respRaw);
  }

  function safeJson(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function writeDriftReport(reportFile, results, upstreamUrl) {
    const lines = [
      '# LLM VCR Drift Report',
      '',
      `- Generated: ${new Date().toISOString()}`,
      `- Upstream: ${upstreamUrl || '(none)'}`,
      `- Checks: ${results.length} | MATCH: ${state.stats.driftMatch} | DIFF: ${state.stats.driftDiff}`,
      ''
    ];
    for (const r of results) {
      lines.push(`## ${r.method} ${r.path} (${r.key})`);
      lines.push('');
      lines.push(`**Verdict: ${r.verdict}**`);
      lines.push('');
      if (r.verdict === 'DIFF') {
        lines.push('```diff');
        lines.push(r.diff);
        lines.push('```');
        lines.push('');
      }
    }
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, lines.join('\n'));
  }

  const server = http.createServer(async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    const handled = await serveStudio(state, req, res, corsHeaders(), sendJson);
    if (handled) {
      return;
    }

    if (req.method === 'GET' && req.url === '/__vcr/health') {
      sendJson(res, 200, {
        ok: true,
        mode: state.mode,
        upstream: state.upstream,
        cassettes: state.cassettes.size,
        stats: state.stats
      });
      return;
    }

    let bodyBuffer;
    try {
      bodyBuffer = await readBody(req);
    } catch (err) {
      sendJson(res, 413, { error: { type: 'vcr_body_too_large', message: err.message } });
      return;
    }
    const rawBody = bodyBuffer.toString('utf8');
    const key = requestKey(req.method, req.url, rawBody);
    console.log(`[vcr:${state.mode}] ${req.method} ${req.url} key=${key}`);

    if (state.mode === 'replay') {
      const cassette = state.cassettes.get(key);
      if (!cassette) {
        if (state.onMiss === 'record' && state.upstream) {
          await handleRecordPassthrough(req, res, key, bodyBuffer, rawBody, 'auto-record');
          return;
        }
        state.stats.missed += 1;
        eventlog.emit({
          ts: Date.now(),
          kind: 'request',
          mode: state.mode,
          method: req.method,
          path: req.url,
          key,
          verdict: 'miss',
          model: getModel(rawBody),
          status: 404
        });
        sendJson(res, 404, {
          error: {
            type: 'vcr_cassette_missing',
            message: `No cassette for ${req.method} ${req.url} (key=${key}). Record it first, or switch VCR_ON_MISS=record.`
          }
        });
        return;
      }
      replayCassette(res, cassette, keyToFilename(req.method, req.url, key));
      return;
    }

    if (state.mode === 'drift') {
      await handleDrift(req, res, key, bodyBuffer, rawBody);
      return;
    }

    await handleRecordPassthrough(req, res, key, bodyBuffer, rawBody, 'record');
  });

  return { server, state, stats: state.stats, mode: state.mode, cassetteDir };
}

module.exports = { createServer, buildUsage, MAX_BODY, VALID_MODES };
