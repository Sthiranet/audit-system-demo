'use strict';
// Sthiranet group audit trail · presentation demo server. No dependencies: `node server.js`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const demo = require('./src/demo');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const routes = [
  ['GET', /^\/api\/state$/, () => demo.state()],
  ['GET', /^\/api\/pending\/(\w+)$/, (m) => demo.pending(m[1])],
  ['POST', /^\/api\/capture\/(\w+)$/, (m, b) => demo.capture(m[1], b.count)],
  ['POST', /^\/api\/seal\/(\w+)$/, (m) => demo.seal(m[1])],
  ['GET', /^\/api\/batch\/(\w+)\/(\d+)$/, (m) => demo.batchDetail(m[1], Number(m[2]))],
  ['GET', /^\/api\/ledger\/(\w+)$/, (m) => demo.ledgerView(m[1])],
  ['POST', /^\/api\/ledger\/rewrite$/, (m, b) => demo.rewrite(b.actor, b.chain, b.seq)],
  ['GET', /^\/api\/trail\/(sub|hq)\/(\w+)$/, (m) => demo.trail(m[1], m[2])],
  ['POST', /^\/api\/push\/(\w+)$/, (m) => demo.push(m[1])],
  ['POST', /^\/api\/tamper$/, (m, b) => demo.tamper(b)],
  ['POST', /^\/api\/verify$/, (m, b) => demo.verify(b.verifier, b.chain)],
  ['POST', /^\/api\/auditor$/, () => demo.addAuditor()],
  ['POST', /^\/api\/auto$/, (m, b) => demo.setAuto(!!b.on)],
  ['POST', /^\/api\/reset$/, () => demo.reset()],
];

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new demo.DemoError('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];
  if (!urlPath.startsWith('/api/')) return serveStatic(req, res);
  const route = routes.find(([method, re]) => method === req.method && re.test(urlPath));
  if (!route) return sendJson(res, 404, { error: 'Not found' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    sendJson(res, 200, await route[2](urlPath.match(route[1]), body));
  } catch (e) {
    if (!(e instanceof demo.DemoError)) console.error(e);
    sendJson(res, e.status || 500, { error: e.message });
  }
});

demo.reset();
server.listen(PORT, () => console.log(`Sthiranet demo running at http://localhost:${PORT}`));
