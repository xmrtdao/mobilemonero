/**
 * Meshtastic Bridge Web Client
 * Talks to the local Python bridge at 127.0.0.1:9001
 * Caches mesh node list in IndexedDB for offline use.
 */

const BRIDGE_URL = "http://127.0.0.1:9001";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("mobilemonero_v1", 2);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("mesh_nodes_cache"))
        db.createObjectStore("mesh_nodes_cache", { keyPath: "id" });
    };
  });
}

async function dbPut(store: string, item: any) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const os = tx.objectStore(store);
    const req = os.put(item);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

async function dbGetAll(store: string): Promise<any[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const os = tx.objectStore(store);
    const req = os.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

export interface MeshNode {
  id: string;
  lastHeard: number;
  raw?: string;
}

export interface MeshMessage {
  from: string;
  to: string;
  channel: number;
  text: string;
  timestamp: number;
  status?: string;
}

export interface BridgeStatus {
  connected: boolean;
  nodes: number;
  bridge: string;
}

export async function getNodes(): Promise<MeshNode[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/nodes`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const list = Object.values(json.nodes || {}) as MeshNode[];
    // Cache locally
    for (const n of list) await dbPut("mesh_nodes_cache", n);
    return list;
  } catch (err) {
    console.warn("[MeshBridge] getNodes failed:", err);
    return dbGetAll("mesh_nodes_cache");
  }
}

export async function sendMessage(text: string, channel = 0, to = "^all"): Promise<MeshMessage> {
  const res = await fetch(`${BRIDGE_URL}/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, channel, to }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function getMessages(): Promise<MeshMessage[]> {
  const res = await fetch(`${BRIDGE_URL}/messages`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  return json.messages || [];
}

export async function getStatus(): Promise<BridgeStatus> {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    return { connected: false, nodes: 0, bridge: "offline" };
  }
}

export function useMeshBridge() {
  return {
    getNodes,
    sendMessage,
    getMessages,
    getStatus,
  };
}
