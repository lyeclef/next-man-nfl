import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../scripts/serve.mjs';
test('Preview serves the dashboard and model, but not project source or unknown files', async () => {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(origin + '/'); assert.equal(page.status, 200); assert.match(await page.text(), /NFL Injury Research/);
    const model = await fetch(origin + '/lib/model.mjs'); assert.equal(model.status, 200); assert.match(model.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(origin + '/not-found')).status, 404);
    assert.notEqual((await fetch(origin + '/%2e%2e%5cpackage.json')).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
