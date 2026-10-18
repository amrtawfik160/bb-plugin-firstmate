import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startDevProxy } = require('./workstream-dev-proxy.cjs');

test('dev proxy forwards the app and records actual HTTP activity without copying config', async () => {
  const dir = mkdtempSync(join(tmpdir(),'fm-dev-proxy-')), activity = join(dir,'activity');
  const app = http.createServer((req,res) => { res.setHeader('x-app','fixture'); res.end(`app:${req.url}`); });
  app.listen(0,'127.0.0.1'); await once(app,'listening');
  const proxy = startDevProxy({ port:0, upstreamPort:app.address().port, activity });
  await once(proxy,'listening');
  try {
    assert.equal(existsSync(activity),false);
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/design`);
    assert.equal(await response.text(),'app:/design');
    assert.equal(response.headers.get('x-app'),'fixture');
    assert.ok(Number(readFileSync(activity,'utf8')) > 0);
    writeFileSync(activity,'old');
    await (await fetch(`http://127.0.0.1:${proxy.address().port}/again`)).text();
    assert.notEqual(readFileSync(activity,'utf8'),'old');
  } finally { proxy.closeAllConnections(); app.closeAllConnections(); await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>app.close(r))]); rmSync(dir,{recursive:true,force:true}); }
});

test('dev proxy reports starting while the app has no listener', async () => {
  const dir = mkdtempSync(join(tmpdir(),'fm-dev-proxy-'));
  const app = http.createServer(); app.listen(0,'127.0.0.1'); await once(app,'listening');
  const port = app.address().port; await new Promise(r=>app.close(r));
  const proxy = startDevProxy({port:0,upstreamPort:port,activity:join(dir,'activity')}); await once(proxy,'listening');
  try { const response = await fetch(`http://127.0.0.1:${proxy.address().port}`); assert.equal(response.status,503); }
  finally { proxy.closeAllConnections(); await new Promise(r=>proxy.close(r)); rmSync(dir,{recursive:true,force:true}); }
});

test('dev proxy forwards WebSocket upgrades for Vite hot reload', async () => {
  const dir = mkdtempSync(join(tmpdir(),'fm-dev-proxy-'));
  let appSocket;
  const app = http.createServer();
  app.on('upgrade',(_req,socket) => {
    appSocket = socket;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data',(chunk) => socket.write(chunk));
  });
  app.listen(0,'127.0.0.1'); await once(app,'listening');
  const proxy = startDevProxy({port:0,upstreamPort:app.address().port,activity:join(dir,'activity')}); await once(proxy,'listening');
  const client = net.connect(proxy.address().port,'127.0.0.1'); client.setTimeout(2000,()=>client.destroy(new Error('upgrade timeout')));
  try {
    await once(client,'connect');
    client.write('GET /hmr HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    const [headers] = await once(client,'data'); assert.match(headers.toString(),/101 Switching Protocols/);
    client.write('hot reload'); const [echo] = await once(client,'data'); assert.equal(echo.toString(),'hot reload');
  } finally {
    client.destroy(); appSocket?.destroy(); proxy.closeAllConnections(); app.closeAllConnections();
    await Promise.all([new Promise(r=>proxy.close(r)),new Promise(r=>app.close(r))]); rmSync(dir,{recursive:true,force:true});
  }
});
