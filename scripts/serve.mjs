import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const projectRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const root = path.resolve(projectRoot, 'dist');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
let activeRefresh = null;
function execStep(script) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['--max-old-space-size=384', path.join(projectRoot, script)], { cwd: projectRoot, timeout: 180000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}
export function runLiveUpdate() {
  if (activeRefresh) return activeRefresh;
  activeRefresh = (async () => {
    try {
      await execStep('scripts/refresh-real-data.mjs');
      return await execStep('scripts/build.mjs');
    } finally {
      activeRefresh = null;
    }
  })();
  return activeRefresh;
}
export function createServer() { return http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      await runLiveUpdate();
      const status = JSON.parse(await readFile(path.join(root, 'data/source-status.json'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, asOf: status.asOf, quotes: status.quotes, currentCases: status.currentCases, conditionalCases: status.conditionalCases }));
    }
    const target = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (target !== root && !target.startsWith(root + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    const bytes = await readFile(target); res.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
  } catch (err) {
    const code = req.method === 'POST' && req.url === '/api/refresh' ? 500 : 404;
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(code === 500 ? JSON.stringify({ ok: false, error: err.message }) : 'Not found');
  }
}); }
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const server = createServer();
  const intervalMin = Number(process.env.REFRESH_INTERVAL_MINUTES ?? 15);
  const host = process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const port = Number(process.env.PORT ?? 4173);
  server.listen(port, host, () => {
    console.log(`Listening on http://${host}:${server.address().port} (auto-refreshing live feeds every ${intervalMin} min)`);
    if (process.env.PORT) {
      runLiveUpdate().catch(e => console.error(`[${new Date().toISOString()}] Startup refresh failed:`, e.message));
    }
    if (intervalMin > 0) {
      setInterval(() => {
        runLiveUpdate()
          .then(() => console.log(`[${new Date().toISOString()}] Background live feed refresh complete.`))
          .catch(e => console.error(`[${new Date().toISOString()}] Background refresh failed:`, e.message));
      }, intervalMin * 60000).unref();
    }
  });
}

