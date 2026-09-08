const $ = (sel) => document.querySelector(sel);
const state = { mode: 'replay', upstream: '' };

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function badgeClass(verdict) {
  return `badge ${verdict}`;
}

async function api(path, opts) {
  const res = await fetch(`/__vcr/studio/api/${path}`, opts);
  return res.json();
}

async function refreshState() {
  const s = await api('state');
  state.mode = s.mode;
  state.upstream = s.upstream;
  document.querySelectorAll('#modeSwitch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === s.mode);
  });
  $('#upstreamStatus').textContent = s.upstream && s.upstream !== 'http://localhost:0'
    ? `upstream: ${s.upstream}`
    : 'no upstream (replay only)';
  $('#stat-replayed').textContent = s.stats.replayed;
  $('#stat-recorded').textContent = s.stats.recorded;
  $('#stat-missed').textContent = s.stats.missed;
  $('#stat-driftmatch').textContent = s.stats.driftMatch;
  $('#stat-driftdiff').textContent = s.stats.driftDiff;
  $('#stat-cassettes').textContent = s.totalCassettes;
}

async function switchMode(mode) {
  const upstream =
    mode === 'replay' ? '' : prompt(`Upstream URL for ${mode} mode:`, state.upstream || 'https://api.openai.com');
  if (mode !== 'replay' && upstream === null) return;
  await api('mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode, upstream })
  });
  refreshState();
}

document.querySelectorAll('#modeSwitch button').forEach((b) => {
  b.addEventListener('click', () => switchMode(b.dataset.mode));
});

function addLogEntry(entry) {
  if (entry.kind === 'mode') {
    refreshState();
    return;
  }
  const ul = $('#liveLog');
  const empty = ul.querySelector('.empty');
  if (empty) empty.remove();
  const li = document.createElement('li');
  li.innerHTML = `
    <span class="time">${fmtTime(entry.ts)}</span>
    <span class="${badgeClass(entry.verdict)}">${entry.verdict}</span>
    <span class="path" title="${entry.path || ''}">${entry.model || ''} · ${entry.path || ''}${entry.tokens ? ' · ' + entry.tokens + ' tok' : ''}</span>
    <span class="time">${entry.status || ''}</span>`;
  ul.prepend(li);
  while (ul.children.length > 100) ul.lastChild.remove();
}

function connectLogStream() {
  const es = new EventSource('/__vcr/studio/api/log/stream');
  es.onmessage = (e) => {
    try {
      addLogEntry(JSON.parse(e.data));
    } catch {}
  };
  es.onerror = () => setTimeout(connectLogStream, 3000);
}

async function refreshLog() {
  const { entries } = await api('log');
  const ul = $('#liveLog');
  ul.innerHTML = '';
  if (!entries.length) {
    ul.innerHTML = '<li class="empty">Waiting for requests…</li>';
    return;
  }
  [...entries].reverse().forEach(addLogEntry);
}

$('#clearLog').addEventListener('click', async () => {
  await api('log/clear', { method: 'POST' });
  $('#liveLog').innerHTML = '<li class="empty">Waiting for requests…</li>';
});

async function refreshCassettes() {
  const { cassettes, totals } = await api('cassettes');
  const ul = $('#cassetteList');
  ul.innerHTML = '';
  $('#cassetteTotals').textContent = `${cassettes.length} files · ${totals.tokens.toLocaleString()} tokens`;
  if (!cassettes.length) {
    ul.innerHTML = '<li class="empty">No cassettes yet. Switch to Record and make a call.</li>';
    return;
  }
  for (const c of cassettes) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${c.streaming ? '⚡' : '📄'} ${c.model}</span>
      <span class="meta">${c.tokens} tok · ${new Date(c.recordedAt).toLocaleString()}</span>
      <button class="del" title="delete">✕</button>`;
    li.addEventListener('click', (e) => {
      if (e.target.classList.contains('del')) return;
      openCassette(c.file);
    });
    li.querySelector('.del').addEventListener('click', async () => {
      if (!confirm(`Delete cassette ${c.file}?`)) return;
      await api('cassettes/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: c.file })
      });
      refreshCassettes();
    });
    ul.appendChild(li);
  }
}

async function openCassette(file) {
  const data = await api(`cassettes/file?name=${encodeURIComponent(file)}`);
  $('#dialogTitle').textContent = file;
  $('#dialogBody').textContent = JSON.stringify(data, null, 2);
  document.getElementById('cassetteDialog').showModal();
}

$('#connectForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const resultEl = $('#connectResult');
  const body = {
    client: $('#connect-client').value,
    baseUrl: $('#connect-baseurl').value.trim() || window.location.origin,
    apiKey: $('#connect-apikey').value.trim(),
    model: $('#connect-model').value.trim()
  };
  if (!body.model) {
    resultEl.className = 'result err';
    resultEl.textContent = 'model is required';
    return;
  }
  const res = await api('config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.error) {
    resultEl.className = 'result err';
    resultEl.textContent = res.error;
  } else {
    resultEl.className = 'result ok';
    resultEl.textContent = `${res.created ? 'Created' : 'Updated'}: ${res.written}`;
  }
});

async function refreshDrift() {
  const { results } = await api('drift');
  const el = $('#driftReport');
  if (!results || !results.length) {
    el.innerHTML = '<span class="empty">Run drift mode to compare live vs recorded.</span>';
    return;
  }
  el.innerHTML = results
    .slice(-10)
    .reverse()
    .map(
      (r) => `
      <div class="drift-entry">
        <div class="verdict" style="color:var(--${r.verdict === 'MATCH' ? 'green' : r.verdict === 'DIFF' ? 'purple' : 'muted'})">${r.verdict} · ${r.model || ''} · ${fmtTime(r.ts)}</div>
        ${r.diff ? `<pre>${r.diff.split('\n').map((l) => l.startsWith('+') ? `<span class="add-line">${l}</span>` : l.startsWith('-') ? `<span class="del-line">${l}</span>` : l).join('\n')}</pre>` : ''}
      </div>`
    )
    .join('');
}

setInterval(() => {
  refreshState();
  refreshCassettes();
  refreshDrift();
}, 5000);

refreshState();
refreshLog();
refreshCassettes();
refreshDrift();
connectLogStream();
