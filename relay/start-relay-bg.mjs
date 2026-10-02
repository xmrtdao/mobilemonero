#!/usr/bin/env node
/**
 * start-relay-bg.mjs — Starts relay in background, redirecting stdin
 */
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const child = spawn('node', [join(__dirname, 'server.js')], {
  cwd: __dirname,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});

child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));

child.on('error', (e) => {
  console.error('Failed to start relay:', e.message);
  process.exit(1);
});

// Wait a moment then check health
setTimeout(async () => {
  try {
    const res = await fetch('http://localhost:8080/health');
    const data = await res.json();
    console.log('Relay started OK:', JSON.stringify(data));
  } catch (e) {
    console.error('Relay health check failed:', e.message);
    process.exit(1);
  }
}, 8000);
