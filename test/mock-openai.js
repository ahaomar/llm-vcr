const http = require('http');

const HOST = '127.0.0.1';
const PORT = Number(process.env.MOCK_PORT || 9099);

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let i = 0;
  const timer = setInterval(() => {
    if (i < events.length) {
      res.write(`data: ${JSON.stringify(events[i])}\n\n`);
      i++;
    } else {
      res.write('data: [DONE]\n\n');
      clearInterval(timer);
      res.end();
    }
  }, 10);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {}
    const isStream = body.stream === true;
    const prompt = (body.messages || []).map((m) => m.content).join(' ');

    if (isStream) {
      const words = ['Counting:', ' one', ' two', ' three', ' four', ' five.'];
      const events = words.map((content, idx) => ({
        id: 'chatcmpl-mock-stream',
        object: 'chat.completion.chunk',
        created: 1700000000,
        model: body.model || 'gpt-4o-mini',
        choices: [{ index: 0, delta: { content }, finish_reason: idx === words.length - 1 ? 'stop' : null }]
      }));
      return sse(res, events);
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: 1700000000,
        model: body.model || 'gpt-4o-mini',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: `Hello! You said: ${prompt}` },
            finish_reason: 'stop'
          }
        ],
        usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 }
      })
    );
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-openai] listening on http://${HOST}:${PORT}`);
});
