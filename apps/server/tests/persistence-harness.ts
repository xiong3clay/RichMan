import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/http.js';
import { FileRoomStore } from '../src/storage/file-store.js';
import type { FileStoreOptions } from '../src/storage/file-store.js';
export type Message = Record<string, any>;
export class Peer {
  readonly history: Message[] = [];
  private inbox: Message[] = [];
  private waiters: Array<{check: (v: Message) => boolean; resolve: (v: Message) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>}> = [];
  readonly ws: WebSocket;
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', raw => {
      const v = JSON.parse(String(raw)) as Message; this.history.push(v);
      const i = this.waiters.findIndex(w => w.check(v));
      if (i < 0) this.inbox.push(v); else { const w = this.waiters.splice(i, 1)[0]!; clearTimeout(w.timer); w.resolve(v); }
    });
  }
  async open() { await new Promise<void>((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); }); return this; }
  send(v: unknown) { this.ws.send(JSON.stringify(v)); }
  next(type: string, check: (v: Message) => boolean = () => true): Promise<Message> {
    const pred = (v: Message) => v.type === type && check(v);
    const i = this.inbox.findIndex(pred); if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => { const w = {check: pred, resolve, reject, timer: setTimeout(() => {
      this.waiters = this.waiters.filter(v => v !== w); reject(new Error('waiting ' + type));
    }, 5000)}; this.waiters.push(w); });
  }
  async close() {
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(new Error('peer closed')); }
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => { this.ws.once('close', resolve); this.ws.terminate(); });
  }
}
export async function diskHarness(options: FileStoreOptions = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'richman-store-'));
  const warnings: string[] = []; const store = new FileRoomStore(dir, { warn: m => warnings.push(m), ...options });
  let now = 1000;
  let server = await startServer({ port: 0, host: '0.0.0.0', store, wsOptions: { now: () => now } });
  const peers: Peer[] = [];
  const connect = async (code: string, credentials?: Record<string, string>) => {
    const p = await new Peer(`ws://127.0.0.1:${server.port}/ws?room=${code}`).open(); peers.push(p);
    p.send(credentials ? {type: 'resume', roomCode: code, ...credentials} : {type: 'join', nickname: '玩家' + peers.length});
    return { p, joined: await p.next('joined') };
  };
  const restart = async () => { await server.close(); await Promise.all(peers.splice(0).map(p => p.close()));
    server = await startServer({ port: 0, host: '0.0.0.0', store, wsOptions: { now: () => now } }); };
  return { dir, store, warnings, server: () => server, time: (n: number) => { now = n; }, connect, restart,
    async start() {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/rooms`, {method: 'POST', headers: {'content-type':'application/json'}, body:'{}'});
      const {roomCode: code} = await res.json() as {roomCode: string};
      const a = await connect(code), b = await connect(code);
      a.p.send({type:'ready', ready:true}); b.p.send({type:'ready',ready:true});
      await a.p.next('room', v => v.players.every((p: Message) => p.ready)); a.p.send({type:'start'});
      await a.p.next('started'); const snapshot = await a.p.next('snapshot');
      return {code,a,b,view:snapshot.view};
    },
    async close() { await Promise.all(peers.splice(0).map(p => p.close())); await server.close(); await rm(dir, {recursive:true,force:true}); },
  };
}
export function command(view: Message, id: string, type = 'BORROW_BANK', payload = {amountCents:'500'}): Message {
  return {protocolVersion:1,gameId:view.gameId,commandId:id,type,payload,expectedGameVersion:view.version};
}
