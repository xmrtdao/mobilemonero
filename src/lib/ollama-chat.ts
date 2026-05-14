export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp?: number;
}

export interface OllamaConfig {
  endpoint: string;
  model: string;
  temperature?: number;
  systemPrompt?: string;
  fallbackEndpoint?: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("mobilemonero_v1", 2);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains("ollama_chat"))
        db.createObjectStore("ollama_chat", { keyPath: "id", autoIncrement: true });
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

async function fetchStream(url: string, body: object, signal?: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  return res.body.getReader();
}

function parseOpenAIChunk(chunk: Uint8Array): string {
  const text = new TextDecoder().decode(chunk);
  let result = "";
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t === "data: [DONE]") continue;
    if (t.startsWith("data: ")) {
      try {
        const json = JSON.parse(t.slice(6));
        const delta = json.choices?.[0]?.delta?.content || "";
        result += delta;
      } catch { /* ignore parse errors */ }
    }
  }
  return result;
}

/**
 * Chat with Ollama (local) or fallback to cloud endpoint.
 * Supports streaming via onChunk callback.
 */
export async function chat(
  messages: OllamaMessage[],
  cfg: OllamaConfig,
  onChunk?: (chunk: string) => void
): Promise<string> {
  const endpoint = cfg.endpoint || "http://127.0.0.1:11434";
  const model = cfg.model || "llama3.2";
  const temp = cfg.temperature ?? 0.7;
  const system = cfg.systemPrompt || "You are a helpful assistant.";

  const body = {
    model,
    messages: [{ role: "system", content: system }, ...messages],
    stream: !!onChunk,
    options: { temperature: temp },
  };

  // Save user message to IndexedDB
  if (messages.length > 0 && messages[messages.length - 1].role === "user") {
    await dbPut("ollama_chat", { ...messages[messages.length - 1], timestamp: Date.now() });
  }

  try {
    if (onChunk) {
      const reader = await fetchStream(`${endpoint}/api/chat`, body);
      let full = "";
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        // Ollama /api/chat streams JSON lines
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            const json = JSON.parse(line);
            const text = json.message?.content || "";
            if (text) {
              full += text;
              onChunk(text);
            }
            if (json.done) break;
          } catch { /* ignore */ }
        }
      }
      await dbPut("ollama_chat", { role: "assistant", content: full, timestamp: Date.now() });
      return full;
    } else {
      const res = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const text = json.message?.content || "";
      await dbPut("ollama_chat", { role: "assistant", content: text, timestamp: Date.now() });
      return text;
    }
  } catch (err) {
    console.warn("[OllamaChat] Local Ollama failed:", err);
    if (cfg.fallbackEndpoint) {
      console.log("[OllamaChat] Trying fallback endpoint...");
      const res = await fetch(cfg.fallbackEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, temperature: temp, model }),
      });
      if (!res.ok) throw new Error(`Fallback HTTP ${res.status}`);
      const text = await res.text();
      await dbPut("ollama_chat", { role: "assistant", content: text, timestamp: Date.now() });
      return text;
    }
    throw err;
  }
}

/**
 * Load full chat history from IndexedDB.
 */
export async function getHistory(): Promise<OllamaMessage[]> {
  const rows = await dbGetAll("ollama_chat");
  return rows.map((r: any) => ({ role: r.role, content: r.content }));
}

/**
 * Clear local chat history.
 */
export async function clearHistory(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("ollama_chat", "readwrite");
    const os = tx.objectStore("ollama_chat");
    const req = os.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}
