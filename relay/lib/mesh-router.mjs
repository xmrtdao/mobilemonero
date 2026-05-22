#!/usr/bin/env node
/**
 * XMRT DAO Mesh Router — Gossipsub P2P Layer
 * Phase 1 of Issue #13: TS Gossipsub on Vex's relay.
 *
 * Topics:
 *   - agent-heartbeat — agent status/heartbeat pulses (30s interval)
 *   - agent-tasks    — task dispatch to specific agents
 *   - agent-discovery — capability announcements
 *   - fleet-broadcast — fleet-wide messages
 *
 * Routes:
 *   POST /mesh/init       — Initialize the gossipsub node
 *   POST /mesh/publish    — Publish a message to a topic
 *   POST /mesh/subscribe  — Subscribe to a topic
 *   GET  /mesh/status     — Get node status
 *   POST /mesh/stop       — Stop the node
 */

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { keys } from '@libp2p/crypto';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_PATH = join(__dirname, '..', '..', 'relay-data', 'mesh-key.bin');


// ── Config ──────────────────────────────────────────────────
const VALID_TOPICS = new Set([
  'agent-heartbeat',
  'agent-tasks',
  'agent-discovery',
  'fleet-broadcast',
]);

const MAX_PAYLOAD_SIZE = 64 * 1024; // 64KB
const RATE_LIMIT = 30; // messages per minute per peer
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000; // ±5 minutes

let node = null;
let nodeStatus = 'stopped';
let startTime = null;
let messageCount = 0;
let errorCount = 0;
const messageLog = [];
const peerSet = new Set();
const rateTracker = new Map(); // topic -> [{ts}]

// ── Helpers ─────────────────────────────────────────────────
function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') return 'Message must be an object';
  if (!msg.topic || !VALID_TOPICS.has(msg.topic)) return `Invalid topic. Must be one of: ${[...VALID_TOPICS].join(', ')}`;
  if (!msg.payload) return 'Payload is required';
  const payloadStr = typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload);
  if (Buffer.byteLength(payloadStr, 'utf8') > MAX_PAYLOAD_SIZE) return `Payload exceeds ${MAX_PAYLOAD_SIZE / 1024}KB limit`;

  // Timestamp validation
  const now = Date.now();
  const ts = msg.timestamp || now;
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) return `Timestamp outside ±5min window`;

  // Rate limiting per topic
  const key = msg.topic;
  const window = rateTracker.get(key) || [];
  const cutoff = now - 60000; // 1 minute ago
  const recent = window.filter(t => t > cutoff);
  recent.push(now);
  rateTracker.set(key, recent);
  if (recent.length > RATE_LIMIT) return `Rate limit exceeded for topic "${msg.topic}" (${RATE_LIMIT}/min)`;

  return null; // valid
}

function logMessage(topic, from, data) {
  const entry = {
    ts: new Date().toISOString(),
    topic,
    from: from?.toString() || 'local',
    data: typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200),
  };
  messageLog.unshift(entry);
  if (messageLog.length > 500) messageLog.length = 500;
  console.log(`[Mesh] ${topic} <- ${entry.from}: ${entry.data.slice(0, 80)}`);
}

// ── Node Lifecycle ──────────────────────────────────────────

/**
 * Initialize the gossipsub mesh node.
 * @param {object} opts
 * @param {number} opts.port - Listen port (default: 9000)
 * @param {string[]} opts.bootstrappers - Multiaddr list of bootstrap peers
 * @param {string} opts.agentName - Agent identifier
 */
export async function initMeshNode(opts = {}) {
  if (node) {
    console.log('[Mesh] Node already running');
    return { ok: false, error: 'Node already initialized' };
  }

  const port = opts.port || 9000;
  const agentName = opts.agentName || 'vex';
  const bootstrappers = opts.bootstrappers || [];

  console.log(`[Mesh] Initializing gossipsub node "${agentName}" on port ${port}...`);

  // ── Persistent private key ────────────────────────────
  let privateKey;
  try {
    if (existsSync(KEY_PATH)) {
      const buf = readFileSync(KEY_PATH);
      privateKey = keys.privateKeyFromProtobuf(buf);
      console.log('[Mesh] Loaded saved private key');
    }
  } catch (e) {
    console.log('[Mesh] Could not load saved key, generating new one');
  }
  
  if (!privateKey) {
    privateKey = await keys.generateKeyPair('Ed25519');
    try {
      writeFileSync(KEY_PATH, keys.privateKeyToProtobuf(privateKey));
      console.log('[Mesh] Generated and saved new private key');
    } catch (e) {
      console.log('[Mesh] Could not save private key:', e.message);
    }
  }
  
  const peerId = peerIdFromPrivateKey(privateKey);

  try {
    node = await createLibp2p({
      privateKey,
      peerId,
      addresses: {
        listen: [`/ip4/0.0.0.0/tcp/${port}`],
      },
      transports: [tcp()],
      connectionEncryptors: [noise()],
      streamMuxers: [yamux()],
      services: {
        identify: identify(),
        pubsub: gossipsub({
          emitSelf: true,
          allowPublishToZeroPeers: true,
          fallbackToFloodsub: true,
          floodPublish: true,
          doPX: false,
          messageValidation: false, // we do custom validation in handler
        }),
      },
      peerDiscovery: bootstrappers.length > 0
        ? [bootstrap({ list: bootstrappers })]
        : [],
    });

    // ── Handle incoming messages ──────────────────────────
    node.services.pubsub.addEventListener('message', (evt) => {
      const { topic, data, from } = evt.detail;
      try {
        const decoded = new TextDecoder().decode(data);
        let parsed;
        try { parsed = JSON.parse(decoded); } catch { parsed = decoded; }

        const validationError = validateMessage({
          topic,
          payload: parsed,
          timestamp: parsed?.timestamp || Date.now(),
        });

        if (validationError) {
          console.log(`[Mesh] Rejected message on ${topic}: ${validationError}`);
          errorCount++;
          return;
        }

        messageCount++;
        logMessage(topic, from, parsed);
      } catch (e) {
        console.log(`[Mesh] Error processing message on ${topic}: ${e.message}`);
        errorCount++;
      }
    });

    await node.start();
    nodeStatus = 'running';
    startTime = Date.now();

    // Subscribe to all default topics
    for (const topic of VALID_TOPICS) {
      node.services.pubsub.subscribe(topic);
      console.log(`[Mesh] Subscribed to topic: ${topic}`);
    }

    // Log connected peers
    node.addEventListener('peer:connect', (evt) => {
      const peerId = evt.detail?.toString() || 'unknown';
      peerSet.add(peerId);
      console.log(`[Mesh] Peer connected: ${peerId}`);
    });

    node.addEventListener('peer:disconnect', (evt) => {
      const peerId = evt.detail?.toString() || 'unknown';
      peerSet.delete(peerId);
      console.log(`[Mesh] Peer disconnected: ${peerId}`);
    });

    // Periodic heartbeat on agent-heartbeat topic
    setInterval(() => {
      if (nodeStatus !== 'running') return;
      const heartbeat = {
        agent: agentName,
        status: 'online',
        uptime: Math.floor((Date.now() - startTime) / 1000),
        messageCount,
        errorCount,
        peers: peerSet.size,
        timestamp: Date.now(),
      };
      publishToMesh('agent-heartbeat', heartbeat).catch(() => {});
    }, 30000);

    const peerIdStr = node.peerId?.toString() || 'unknown';
    console.log(`[Mesh] Node started — Peer ID: ${peerIdStr}`);
    return { ok: true, peerId: peerIdStr, topicCount: VALID_TOPICS.size, bootstrappers };
  } catch (e) {
    nodeStatus = 'error';
    errorCount++;
    console.error(`[Mesh] Failed to start: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

/**
 * Publish a message to a mesh topic.
 * @param {string} topic - One of the valid topics
 * @param {*} payload - Data to publish (will be JSON.stringify'd)
 * @param {object} opts
 * @param {number} opts.timestamp - Override timestamp
 */
export async function publishToMesh(topic, payload, opts = {}) {
  if (!node || nodeStatus !== 'running') {
    return { ok: false, error: 'Mesh node not running' };
  }
  if (!VALID_TOPICS.has(topic)) {
    return { ok: false, error: `Invalid topic: ${topic}` };
  }

  const message = {
    topic,
    payload,
    timestamp: opts.timestamp || Date.now(),
  };

  const validationError = validateMessage(message);
  if (validationError) {
    return { ok: false, error: validationError };
  }

  try {
    const data = new TextEncoder().encode(JSON.stringify(message));
    node.services.pubsub.publish(topic, data);
    messageCount++;
    logMessage(topic, 'local', payload);
    return { ok: true, topic, size: data.byteLength };
  } catch (e) {
    errorCount++;
    return { ok: false, error: e.message };
  }
}

/**
 * Subscribe to additional topics beyond defaults.
 */
export function subscribeToTopic(topic) {
  if (!node || nodeStatus !== 'running') {
    return { ok: false, error: 'Mesh node not running' };
  }
  if (VALID_TOPICS.has(topic)) {
    return { ok: false, error: `Topic "${topic}" is already subscribed by default` };
  }
  node.services.pubsub.subscribe(topic);
  console.log(`[Mesh] Subscribed to additional topic: ${topic}`);
  return { ok: true, topic };
}

/**
 * Get mesh node status.
 */
export function getMeshStatus() {
  const peerIds = [...peerSet];
  return {
    ok: true,
    status: nodeStatus,
    agent: 'vex',
    peerId: node?.peerId?.toString() || null,
    uptime: startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
    topics: node ? Array.from(node.services.pubsub.subscriptions || []) : [],
    peers: {
      count: peerSet.size,
      list: peerIds,
    },
    messages: {
      total: messageCount,
      errors: errorCount,
      recentCount: messageLog.length,
    },
    libp2p: {
      version: '2.x',
      gossipsub: '@chainsafe/libp2p-gossipsub v14.1.1',
    },
  };
}

/**
 * Stop the mesh node.
 */
export async function stopMeshNode() {
  if (!node) return { ok: false, error: 'No node to stop' };
  try {
    await node.stop();
    node = null;
    nodeStatus = 'stopped';
    startTime = null;
    peerSet.clear();
    console.log('[Mesh] Node stopped');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Get recent messages from the mesh message log.
 * @param {number} [limit=50] - Max messages to return
 */
export function getMeshMessageLog(limit = 50) {
  return messageLog.slice(0, Math.min(limit, 500));
}

// ── Express Route Factory ───────────────────────────────────
// Returns an Express router with mesh endpoints.
// Usage: app.use('/mesh', createMeshRouter())
// Or mount individual routes.

/**
 * Create an Express router with mesh endpoints.
 */
export function createMeshRouter(express) {
  const router = express.Router();

  // POST /mesh/init — Initialize the mesh node
  router.post('/init', async (req, res) => {
    const { port, bootstrappers, agentName } = req.body || {};
    const result = await initMeshNode({ port, bootstrappers, agentName });
    res.json(result);
  });

  // POST /mesh/publish — Publish to a topic
  router.post('/publish', async (req, res) => {
    const { topic, payload, timestamp } = req.body || {};
    if (!topic || !payload) {
      return res.status(400).json({ ok: false, error: 'topic and payload required' });
    }
    const result = await publishToMesh(topic, payload, { timestamp });
    res.json(result);
  });

  // POST /mesh/subscribe — Subscribe to additional topics
  router.post('/subscribe', async (req, res) => {
    const { topic } = req.body || {};
    if (!topic) return res.status(400).json({ ok: false, error: 'topic required' });
    const result = subscribeToTopic(topic);
    res.json(result);
  });

  // GET /mesh/status — Node status
  router.get('/status', (req, res) => {
    const status = getMeshStatus();
    res.json(status);
  });

  // POST /mesh/stop — Stop the node
  router.post('/stop', async (req, res) => {
    const result = await stopMeshNode();
    res.json(result);
  });

  // GET /mesh/messages — Recent message log
  router.get('/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 500);
    res.json({
      ok: true,
      count: messageLog.length,
      messages: messageLog.slice(0, limit),
    });
  });

  return router;
}

// ── Direct CLI usage ────────────────────────────────────────
// Run: node lib/mesh-router.mjs [port]
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const port = parseInt(process.argv[2]) || 9000;
  const agentName = process.argv[3] || 'vex';
  console.log(`[Mesh] Starting via CLI — port: ${port}, agent: ${agentName}`);
  const result = await initMeshNode({ port, agentName });
  console.log(JSON.stringify(result, null, 2));

  // Keep alive
  process.on('SIGINT', async () => {
    console.log('\n[Mesh] Shutting down...');
    await stopMeshNode();
    process.exit(0);
  });
}

export default {
  initMeshNode,
  publishToMesh,
  subscribeToTopic,
  getMeshStatus,
  stopMeshNode,
  createMeshRouter,
};
