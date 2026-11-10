// Minimal CDP transport over Node's built-in WebSocket. This is the adapter boundary: the rest of the
// toolkit only uses `send(method, params, sessionId)` and `on(event, handler)`. To reuse an existing
// CDP helper, implement the same two methods on top of it.

export type Handler = (params: any, sessionId?: string) => void;

export interface Cdp {
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T>;
  on(method: string, handler: Handler): () => void;
  close(): void;
}

export class CdpClient implements Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private handlers = new Map<string, Set<Handler>>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        for (const h of this.handlers.get(msg.method) ?? []) h(msg.params, msg.sessionId);
      }
    });
    ws.addEventListener('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: connection closed`));
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`Cannot connect to ${wsUrl}`)), { once: true });
    });
    return new CdpClient(ws);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  on(method: string, handler: Handler): () => void {
    let set = this.handlers.get(method);
    if (!set) this.handlers.set(method, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  close() {
    this.ws.close();
  }
}

export async function connectBrowser(port: number): Promise<CdpClient> {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
  if (!res?.ok) throw new Error(`No Chrome with remote debugging on port ${port}. Start Chrome with --remote-debugging-port=${port} (see references/porting.md).`);
  const { webSocketDebuggerUrl } = await res.json();
  return CdpClient.connect(webSocketDebuggerUrl);
}
