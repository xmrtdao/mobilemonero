#!/usr/bin/env node
/**
 * Hermes Gossipsub Client — XMRT DAO Mesh Node for Termux
 * 
 * Lightweight libp2p gossipsub node for Android/Termux ARM64.
 * Connects to Vex relay as bootstrap peer, subscribes to all 4 topics.
 * 
 * Usage:
 *   node hermes-mesh.mjs
 *   node hermes-mesh.mjs --port 9000 --peers /ip4/VEX_IP/tcp/9000/p2p/VEX_PEER_ID
 * 
 * Dependencies (install on Termux):
 *   npm install libp2p @libp2p/tcp @chainsafe/libp2p-noise \
 *     @chainsafe/libp2p-yamux @chainsafe/libp2p-gossipsub \
 *     @libp2p/bootstrap @libp2p/identify
 */

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';

// ── Configuration ──────────────────────────────────────────
const PORT = parseInt(process.argv.find(a => a.startsWith('--port='))?.split('=')[1]) || 9000;
const AGENT = 'hermes';

// Bootstrap peers: Vex relay
// Pass via --peers flag or default to Vex's known multiaddr
const customPeers = process.argv.find(a => a.startsWith('--peers='))?.split('=')[1];
const BOOTSTRAP_PEERS = customPeers ? customPeers.split(',') : [];

const VALID_TOPICS = [
  'agent-heartbeat',
  'agent-tasks',
  'agent-discovery',
  'fleet-broadcast',
];

// ── State ──────────────────────────────────────────────────
let node = null;
let startTime = null;
let messageCount = 0;
let errorCount = 0;
const recentMessages = [];

// ── Main ───────────────────────────────────────────────────
async function main() {
  console.log(`\n🤖 Hermes Gossipsub Node v1.0`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Agent: ${AGENT}`);
  console.log(`   Bootstrap peers: ${BOOTSTRAP_PEERS.length || 'none (connect manually)'}`);
  console.log(`   Topics: ${VALID_TOPICS.join(', ')}\n`);

  try {
    node = await createLibp2p({
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${PORT}`],
      },
      transports: [tcp()],
      connectionEncryptors: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          emitSelf: false, // Hermes doesn't need to see his own messages
          allowPublishToZeroPeers: true,
          fallbackToFloodsub: true,
          floodPublish: true,
          doPX: false,
        }),
      },
      peerDiscovery: BOOTSTRAP_PEERS.length > 0
        ? [bootstrap({ list: BOOTSTRAP_PEERS })]
        : [],
    });

    // ── Message handler ──────────────────────────────────
    node.services.pubsub.addEventListener('message', (evt) => {
      const { topic, data, from } = evt.detail;
      try {
        const decoded = new TextDecoder().decode(data);
        messageCount++;
        const entry = {
          ts: new Date().toISOString(),
          topic,
          from: from?.toString()?.slice(0, 20) || 'unknown',
          data: decoded.slice(0, 200),
        };
        recentMessages.unshift(entry);
        if (recentMessages.length > 100) recentMessages.length = 100;
        console.log(`[${entry.ts.slice(11, 19)}] [${topic}] from ${entry.from}: ${decoded.slice(0, 120)}`);
      } catch (e) {
        errorCount++;
      }
    });

    await node.start();
    startTime = Date.now();

    // Subscribe to all topics
    for (const topic of VALID_TOPICS) {
      node.services.pubsub.subscribe(topic);
      console.log(`✅ Subscribed to: ${topic}`);
    }

    console.log(`\n🚀 Hermes mesh node RUNNING`);
    console.log(`   Peer ID: ${node.peerId?.toString()}`);
    console.log(`   Listening on: /ip4/0.0.0.0/tcp/${PORT}`);
    console.log(`   Waiting for peers...\n`);

    // Print status every 30s
    setInterval(() => {
      const peers = [...node.getPeers()];
      const uptime = Math.floor((Date.now() - startTime) / 1000);
      process.stdout.write(`\r📡 [${uptime}s] Peers: ${peers.length} | Msgs: ${messageCount} | Err: ${errorCount}`);
    }, 30000);

    // Publish heartbeat every 60s
    setInterval(async () => {
      try {
        await node.services.pubsub.publish('agent-heartbeat', new TextEncoder().encode(JSON.stringify({
          agent: AGENT,
          status: 'online',
          uptime: Math.floor((Date.now() - startTime) / 1000),
          messageCount,
          errorCount,
          timestamp: Date.now(),
        })));
      } catch (e) {
        // heartbeat best-effort
      }
    }, 60000);

    // Publish discovery announcement every 5min
    setInterval(async () => {
      try {
        const peers = [...node.getPeers()].map(p => p.toString());
        await node.services.pubsub.publish('agent-discovery', new TextEncoder().encode(JSON.stringify({
          agent: AGENT,
          peer_id: node.peerId?.toString(),
          status: 'online',
          capabilities: ['mesh:gossipsub', 'mesh:python-p2p', 'fleet-chat', 'mining-worker'],
          peers_connected: peers.length,
          listening: [`/ip4/0.0.0.0/tcp/${PORT}`],
          timestamp: Date.now(),
        })));
      } catch (e) {
        // discovery best-effort
      }
    }, 300000);

    // Graceful shutdown
    process.on('SIGINT', async () => {
      console.log('\n\nShutting down...');
      await node.stop();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      await node.stop();
      process.exit(0);
    });

  } catch (e) {
    console.error('Failed to start mesh node:', e.message);
    process.exit(1);
  }
}

main();
