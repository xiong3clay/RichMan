import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { Peer, diskHarness } from './persistence-harness.js';
function ipc(child:ChildProcess,type:string):Promise<any>{return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{child.off('message',listener);reject(new Error('IPC '+type));},10000);
  const listener=(m:any)=>{if(m.type===type){clearTimeout(timer);child.off('message',listener);resolve(m);}};child.on('message',listener);
});}
async function kill(child:ChildProcess){if(child.exitCode!==null||child.signalCode!==null)return;const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGKILL');await exited;}
it('M2 confirmation_disconnect: a delivered join closing during confirmation cannot remain online',async()=>{
  const h=await diskHarness();let peer:Peer|undefined;let release=()=>{};
  try{
    const {roomCode:code}=await(await fetch(`http://127.0.0.1:${h.server().port}/api/rooms`,{method:'POST',body:'{}'})).json();
    let entered!:()=>void;let writes=0;const barrier=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
    h.store.options.checkpoint=async point=>{if(point==='after_rename'&&++writes===2){entered();await gate;}};
    peer=await new Peer(`ws://127.0.0.1:${h.server().port}/ws?room=${code}`).open();peer.send({type:'join',nickname:'delivered'});
    await peer.next('joined');await barrier;await peer.close();h.store.options.checkpoint=undefined;release();
    await vi.waitFor(()=>expect(h.server().manager.getRoom(code)!.players[0]!.online).toBe(false),{timeout:1000});
  }finally{release();h.store.options.checkpoint=undefined;await peer?.close();await h.close();}
});
it('M2 join_commit_kill: first join killed after rename before joined is revoked on real process restart',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'richman-join-kill-'));const children:ChildProcess[]=[];const peers:Peer[]=[];
  const boot=async()=>{const child=fork(fileURLToPath(new URL('./recovery-worker.ts',import.meta.url)),[],{
    execArgv:['--import','tsx'],env:{...process.env,RICHMAN_DATA_DIR:dir},stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
    children.push(child);const {port}=await ipc(child,'ready');return{child,port};};
  try{
    let server=await boot();const base=`http://127.0.0.1:${server.port}`;
    const {roomCode:code}=await(await fetch(base+'/api/rooms',{method:'POST',body:'{}'})).json();
    const first=await new Peer(`ws://127.0.0.1:${server.port}/ws?room=${code}`).open();peers.push(first);
    const armed=ipc(server.child,'armed');server.child.send({type:'arm',point:'after_rename'});await armed;
    const barrier=ipc(server.child,'barrier');first.send({type:'join',nickname:'undelivered'});await barrier;
    expect(first.history.some(m=>m.type==='joined')).toBe(false);
    const disk=JSON.parse(await readFile(path.join(dir,'rooms',code,'snapshot.json'),'utf8'));
    expect(disk.sessions).toHaveLength(1);expect(disk.sessions[0].pendingDelivery).toBe(true);
    await kill(server.child);server=await boot();
    const saved=JSON.parse(await readFile(path.join(dir,'rooms',code,'snapshot.json'),'utf8'));
    expect(saved.players).toEqual([]);expect(saved.sessions).toEqual([]);expect(saved.hostId).toBeNull();
    const join=async(nickname:string)=>{const p=await new Peer(`ws://127.0.0.1:${server.port}/ws?room=${code}`).open();peers.push(p);
      p.send({type:'join',nickname});const joined=await p.next('joined');const room=await p.next('room');return{p,joined,room};};
    const a=await join('new host'),b=await join('guest');expect(a.room.hostId).toBe(a.joined.playerId);
    a.p.send({type:'ready',ready:true});b.p.send({type:'ready',ready:true});await a.p.next('room',m=>m.players.every((p:any)=>p.ready));
    a.p.send({type:'start'});await a.p.next('started');expect((await a.p.next('snapshot')).view.phase).toBe('ACTION');
  }finally{await Promise.all(children.map(kill));await Promise.all(peers.map(p=>p.close()));await rm(dir,{recursive:true,force:true});}
},30000);

it.each(['join','recovery'] as const)('M1_M2 disconnect_during_%s: delivery interruption cannot retain a ghost seat or upgrade an old owner',async mode=>{
  const h=await diskHarness();let incoming:Peer|undefined;let release=()=>{};
  try{
    let code:string,old:any;
    if(mode==='recovery'){const started=await h.start();code=started.code;old=started.a;}
    else({roomCode:code}=await(await fetch(`http://127.0.0.1:${h.server().port}/api/rooms`,{method:'POST',body:'{}'})).json());
    let entered!:()=>void;const barrier=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
    h.store.options.checkpoint=async point=>{if(point==='after_rename'){entered();await gate;}};
    incoming=await new Peer(`ws://127.0.0.1:${h.server().port}/ws?room=${code!}`).open();
    incoming.send(mode==='join'?{type:'join',nickname:'never-delivered'}:{type:'resume',roomCode:code!,recoveryCode:old.joined.recoveryCode});
    await barrier;await incoming.close();h.store.options.checkpoint=undefined;release();
    if(mode==='join'){
      const fresh=await h.connect(code!);expect(fresh.joined.seatId).toBe(1);
      expect(h.server().manager.getRoom(code!)!.players).toHaveLength(1);
    }else{
      // 同房队列中的重新认证是补偿完成屏障；旧连接从未被claim升级。
      const fresh=await h.connect(code!,{recoveryCode:old.joined.recoveryCode});
      expect(fresh.joined.sessionToken===old.joined.sessionToken).toBe(false);
      old.p.send({type:'resume_game'});expect(await old.p.next('error')).toMatchObject({code:'NOT_JOINED'});
    }
  }finally{release();h.store.options.checkpoint=undefined;await incoming?.close();await h.close();}
});
