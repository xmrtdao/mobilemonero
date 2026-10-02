#!/usr/bin/env node
// health-server.mjs — standalone health check server
// Runs as a separate process so the supervisor can always reach it,
// even when the relay's event loop is blocked by synchronous operations.
import http from 'http';
const PORT = parseInt(process.env.HEALTH_PORT || '8088', 10);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
});
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[health-server] listening on port ${PORT}`);
});
