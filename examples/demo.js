const DEMO_BASE_URL = process.env.DEMO_BASE_URL || 'http://localhost:9090';

const nonStreamBody = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Say hello in one short sentence.' }]
};

const streamBody = {
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Count from 1 to 5.' }],
  stream: true
};

async function main() {
  const base = DEMO_BASE_URL.replace(/\/$/, '');

  const res1 = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(nonStreamBody)
  });
  const json = await res1.json();
  console.log(`non-stream  [${res1.status}] x-vcr=${res1.headers.get('x-vcr')}`);
  console.log(`  content: ${json.choices[0].message.content}`);

  const res2 = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(streamBody)
  });
  const raw = await res2.text();
  let streamed = '';
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const chunk = JSON.parse(payload);
    if (chunk.choices[0].delta.content) streamed += chunk.choices[0].delta.content;
  }
  console.log(`stream      [${res2.status}] x-vcr=${res2.headers.get('x-vcr')}`);
  console.log(`  content: ${streamed}`);
}

main().catch((err) => {
  console.error('demo failed:', err.message);
  process.exit(1);
});
