/**
 * A TCP proxy that adds a fixed round-trip latency to a Postgres (or PgBouncer)
 * endpoint, for convergence and timing tests: every chunk is delayed by half
 * the round trip in each direction, preserving order. `drop()` destroys every
 * live connection at once, as a pooler restart looks to its clients.
 */
import { createConnection, createServer, type Server, type Socket } from 'node:net';

/** A TCP proxy that delays every chunk by half the configured round trip in each direction, preserving order. */
export class LatencyProxy {
  private server: Server;
  private sockets = new Set<Socket>();
  port = 0;
  constructor(private target: { host: string; port: number }, private oneWayMs: number) {
    this.server = createServer(client => this.accept(client));
  }
  async listen(): Promise<void> {
    await new Promise<void>(done => this.server.listen(0, '127.0.0.1', done));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('latency proxy has no port');
    this.port = address.port;
  }
  private delayed(from: Socket, to: Socket): void {
    const queue: { at: number; chunk: Buffer }[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drain = () => {
      timer = undefined;
      const now = performance.now();
      while (queue.length && queue[0].at <= now) { const { chunk } = queue.shift()!; if (!to.destroyed) to.write(chunk); else if (process.env.PROBE_PROXY_LOG) { for (const v of this.stats.values()) if (v.c === from || v.u === from) v.dropped += chunk.length; } }
      if (queue.length) timer = setTimeout(drain, Math.max(0, queue[0].at - performance.now()));
    };
    from.on('data', (chunk: Buffer) => {
      queue.push({ at: performance.now() + this.oneWayMs, chunk });
      if (!timer) timer = setTimeout(drain, this.oneWayMs);
    });
    from.on('end', () => { const close = () => (queue.length ? setTimeout(close, this.oneWayMs) : to.end()); close(); });
  }
  private stats = new Map<number, any>();
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private dumpProbe(): void {
    const f = process.env.PROBE_PROXY_LOG; if (!f) return;
    require('node:fs').writeFileSync(f, JSON.stringify([...this.stats.entries()].map(([k, v]) => ({ port: k, ...v, cDestroyed: v.c.destroyed, uDestroyed: v.u.destroyed, cState: v.c.readyState, uState: v.u.readyState, uWritten: v.u.bytesWritten, uPending: v.u.writableLength, c: undefined, u: undefined }))));
  }
  private accept(client: Socket): void {
    const upstream = createConnection(this.target);
    if (process.env.PROBE_PROXY_LOG) {
      const st: any = { at: Date.now(), cin: 0, uout: 0, uin: 0, cout: 0, dropped: 0, ev: [] as string[], c: client, u: upstream };
      this.stats.set(client.remotePort ?? -this.stats.size, st);
      const t0 = performance.now(); const ev = (e: string) => { if (st.ev.length < 40) st.ev.push(Math.round(performance.now() - t0) + ':' + e); };
      client.on('data', (b: Buffer) => { st.cin += b.length; });
      upstream.on('data', (b: Buffer) => { st.uin += b.length; });
      const ow = upstream.write.bind(upstream); (upstream as any).write = (b: any, ...a: any[]) => { st.uout += b.length; return ow(b, ...a); };
      const cw = client.write.bind(client); (client as any).write = (b: any, ...a: any[]) => { st.cout += b.length; return cw(b, ...a); };
      upstream.on('connect', () => ev('u-connect'));
      for (const [n, sk] of [['c', client], ['u', upstream]] as const) {
        sk.on('end', () => ev(n + '-end')); sk.on('close', (h: boolean) => ev(n + '-close' + (h ? '!' : ''))); sk.on('error', (e: any) => ev(n + '-error ' + e?.code));
      }
      if (!this.probeTimer) { this.probeTimer = setInterval(() => this.dumpProbe(), 5000); (this.probeTimer as any).unref?.(); }
    }
    for (const socket of [client, upstream]) {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      socket.on('error', () => { client.destroy(); upstream.destroy(); });
    }
    this.delayed(client, upstream);
    this.delayed(upstream, client);
  }
  /** Mode (f): every live connection through the pooler drops at once, as a pooler restart looks to its clients. */
  drop(): number { this.dumpProbe(); const n = this.sockets.size; for (const socket of this.sockets) socket.destroy(); return n; }
  async close(): Promise<void> {
    this.dumpProbe(); if (this.probeTimer) clearInterval(this.probeTimer);
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(done => this.server.close(() => done()));
  }
}
