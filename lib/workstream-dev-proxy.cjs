const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');

function startDevProxy({ port, upstreamPort, activity }) {
  const touch = () => fs.writeFileSync(activity, String(Date.now()), { mode: 0o600 });
  const server = http.createServer((request, response) => {
    touch();
    const target = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: request.url, method: request.method, headers: request.headers }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    target.on('error', () => {
      if (response.destroyed || response.writableEnded) return;
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(503, { 'content-type': 'text/plain' });
      response.end('Dev app is starting.');
    });
    request.on('aborted', () => target.destroy());
    request.on('error', () => target.destroy());
    response.on('close', () => target.destroy());
    request.pipe(target);
  });
  server.on('upgrade', (request, socket, head) => {
    touch();
    const target = net.connect(upstreamPort, '127.0.0.1', () => {
      const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
      for (let i = 0; i < request.rawHeaders.length; i += 2) lines.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      target.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) target.write(head);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.on('close', () => target.destroy());
    target.on('close', () => socket.destroy());
  });
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startDevProxy };
if (process.env.FM_DEV_PROXY_RUN === '1') {
  startDevProxy({ port: Number(process.argv[1]), upstreamPort: Number(process.argv[2]), activity: process.argv[3] });
}
