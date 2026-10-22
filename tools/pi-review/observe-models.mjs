import { createServer } from 'node:http';
import { resolveJevKey } from '../../dist/src/connectors/secrets.js';

export async function observeModels(apiKey, emit) {
  const jevKey = resolveJevKey()?.key;
  if (!jevKey) throw new Error('TypeSafe credential unavailable');
  let sequence = 0;
  const server = createServer(async (request, response) => {
    const isJev = request.url === '/jev';
    const isWork = request.url === '/v1/chat/completions';
    if (request.method !== 'POST' || (!isJev && !isWork) || request.headers.authorization !== `Bearer ${isJev ? jevKey : apiKey}`) {
      response.writeHead(403).end();
      return;
    }
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4_000_000) throw new Error('Oversized model request');
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const payload = JSON.parse(body);
      const keys = Object.keys(payload.questions ?? {});
      const patch = keys[0]?.split(':')[0] ?? 'decision';
      const system = payload.messages?.[0]?.content ?? '';
      const call = ++sequence;
      const label = isJev ? `System 1 / Jev · ${patch} · ${keys.length} questions` : `CLI / DeepSeek · ${system.includes('extract person names') ? 'name refinement' : 'scene extraction'}`;
      const start = Date.now();
      await emit({ type: 'system1.call', call, status: 'working', stage: isJev ? 1 : 2, label });
      const upstream = await fetch(isJev ? 'https://api.typesafe.ai/v1/systemone' : 'https://api.deepseek.com/v1/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${isJev ? jevKey : apiKey}` }, body,
        signal: AbortSignal.timeout(180000),
      });
      const result = await upstream.arrayBuffer();
      await emit({ type: 'system1.call', call, status: upstream.ok ? 'ok' : 'error', stage: isJev ? 1 : 2, label: `${label} · HTTP ${upstream.status} · ${Date.now() - start} ms` });
      response.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(Buffer.from(result));
    } catch {
      await emit({ type: 'system1.call', status: 'error', stage: isJev ? 1 : 2, label: 'Model request interrupted; CLI retry policy applies' });
      response.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":{"message":"Local model observer upstream failure"}}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  return { env: { JEV_ENDPOINT: `http://127.0.0.1:${port}/jev`, WORK_LLM_BASE_URL: `http://127.0.0.1:${port}/v1` }, close: () => new Promise((resolve) => server.close(resolve)), redact: (value) => value.split(apiKey).join('[redacted]').split(jevKey).join('[redacted]') };
}
