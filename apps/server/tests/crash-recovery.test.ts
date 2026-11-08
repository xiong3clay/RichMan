import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Peer, type Message } from './persistence-harness.js';
function ipc(child: ChildProcess, type: string): Promise<Message> {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { child.off('message',listener); reject(new Error('IPC '+type)); },10000);
    const listener = (m: unknown) => { const v=m as Message; if(v.type===type){clearTimeout(timer);child.off('message',listener);resolve(v);} };
    child.on('message',listener);
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(r => child.once('exit',()=>r())); child.kill('SIGKILL'); await exited;
}
async function boot(dir:string) {
  const child=fork(fileURLToPath(new URL('./recovery-worker.ts',import.meta.url)),[],{
    execArgv:['--import','tsx'],env:{...process.env,RICHMAN_DATA_DIR:dir},stdio:['ignore','pipe','pipe','ipc'],windowsHide:true,
  });
  child.stdout?.on('data',()=>{}); child.stderr?.on('data',()=>{});
  const ready=await ipc(child,'ready'); return {child,port:ready.port as number};
}
for(const point of ['before_rename','after_rename'] as const) {
  it(point==='before_rename' ? 'crash_before_rename: 真子进程强杀，恢复旧账、无结果、重放只执行一次' :
    'crash_after_rename_before_ack: 真子进程强杀，已提交转账与原回执同恢复且不重复',async()=>{
    const dir=await mkdtemp(path.join(os.tmpdir(),'richman-crash-')); const children:ChildProcess[]=[]; const peers:Peer[]=[];
    try {
      let server=await boot(dir); children.push(server.child);
      const healthBefore=await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
      const {roomCode:code}=await (await fetch(`http://127.0.0.1:${server.port}/api/rooms`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json() as {roomCode:string};
      const connect=async(port:number,credentials?:Message)=>{
        const p=await new Peer(`ws://127.0.0.1:${port}/ws?room=${code}`).open();peers.push(p);
        p.send(credentials?{type:'resume',roomCode:code,...credentials}:{type:'join',nickname:'玩家'+peers.length});
        return {p,joined:await p.next('joined')};
      };
      const a=await connect(server.port), b=await connect(server.port);
      a.p.send({type:'ready',ready:true});b.p.send({type:'ready',ready:true});
      await a.p.next('room',m=>m.players.every((p:Message)=>p.ready));a.p.send({type:'start'});await a.p.next('started');
      const first=(await a.p.next('snapshot')).view;
      a.p.send({protocolVersion:1,gameId:first.gameId,commandId:'request',type:'REQUEST_PRIVATE_LOAN',payload:{lenderId:'p2',principalCents:'500',rateBps:1000},expectedGameVersion:first.version});
      expect((await a.p.next('command_result')).outcome.ok).toBe(true);
      const pending=(await a.p.next('snapshot',m=>m.view.finance.pendingRequest!==null)).view;
      const requestId=pending.finance.pendingRequest.requestId;
      const accept={protocolVersion:1,gameId:first.gameId,commandId:'accept',type:'ACCEPT_PRIVATE_LOAN',payload:{requestId}};
      const observationStart=[a.p.history.length,b.p.history.length];
      const armed=ipc(server.child,'armed');server.child.send({type:'arm',point});await armed;
      const barrier=ipc(server.child,'barrier');b.p.send(accept);await barrier;
      expect(b.p.history.some(m=>m.type==='command_result'&&m.commandId==='accept')).toBe(false);
      for(const [index,peer] of [a.p,b.p].entries())expect(peer.history.slice(observationStart[index]).some(m=>
        (m.type==='snapshot'&&m.view.version>pending.version)||(m.type==='events'&&m.gameVersion>pending.version))).toBe(false);
      const savedBefore=JSON.parse(await readFile(path.join(dir,'rooms',code,'snapshot.json'),'utf8'));
      expect(savedBefore.game.players.map((p:Message)=>p.cents)).toEqual(point==='before_rename'?[10000,10000]:[10500,9500]);
      expect(savedBefore.commands.some((c:Message)=>c.reply.commandId==='accept')).toBe(point==='after_rename');
      const healthLive=await (await fetch(`http://127.0.0.1:${server.port}/health`)).json();
      await kill(server.child);
      server=await boot(dir);children.push(server.child);
      const healthAfter=await (await fetch(`http://127.0.0.1:${server.port}/health`)).json() as Message;
      expect(healthAfter.rooms).toBe(1);
      const restoredA=await connect(server.port,{sessionToken:a.joined.sessionToken});
      const restoredB=await connect(server.port,{sessionToken:b.joined.sessionToken});
      const restored=(await restoredA.p.next('snapshot')).view;
      expect(restored.paused).toBe(true);expect(restored.version).toBe(savedBefore.game.version);
      expect(restored.eventSeq).toBe(savedBefore.game.eventSeq);
      expect(restored.finance.cents).toBe(point==='before_rename'?'10000':'10500');
      let originalReply:Message|undefined;
      if(point==='after_rename') {
        originalReply=savedBefore.commands.find((c:Message)=>c.reply.commandId==='accept').reply;
        restoredB.p.send(accept);expect(await restoredB.p.next('command_result')).toEqual(originalReply);
      }
      restoredA.p.send({type:'resume_game'});const continued=(await restoredA.p.next('snapshot',m=>m.view.paused===false)).view;
      expect(continued.phase).toBe(savedBefore.game.phase);
      restoredB.p.send(accept);const reply=await restoredB.p.next('command_result');expect(reply.outcome.ok).toBe(true);
      if(originalReply)expect(reply).toEqual(originalReply);
      restoredB.p.send(accept);expect(await restoredB.p.next('command_result')).toEqual(reply);
      const stateNow=JSON.parse(await readFile(path.join(dir,'rooms',code,'snapshot.json'),'utf8'));
      expect(stateNow.game.players.map((p:Message)=>p.cents)).toEqual([10500,9500]);expect(stateNow.game.privateLoans).toHaveLength(1);
      const currentB=(await restoredB.p.next('snapshot',m=>m.view.currentSeatId===2&&m.view.paused===false&&m.view.version===stateNow.game.version)).view;
      restoredB.p.send({protocolVersion:1,gameId:first.gameId,commandId:'continue-end',type:'END_ACTION',payload:{},expectedGameVersion:currentB.version});
      expect((await restoredB.p.next('command_result')).outcome.ok).toBe(true);
      console.log('[06 restart demo]',point,JSON.stringify({healthBefore,healthLive,healthAfter,
        snapshotDiff:{before:{gameId:savedBefore.gameId,version:savedBefore.game.version,eventSeq:savedBefore.game.eventSeq,balances:savedBefore.game.players.map((p:Message)=>p.cents)},
          restored:{gameId:restored.gameId,version:restored.version,eventSeq:restored.eventSeq,paused:restored.paused,cents:restored.finance.cents},
          continued:{phase:continued.phase,version:continued.version,deadlineAt:continued.deadlineAt}},ackBeforeKill:false,transfers:1,continuedCommand:'ok'}));
    }finally{await Promise.all(children.map(kill));await Promise.all(peers.map(p=>p.close()));await rm(dir,{recursive:true,force:true});}
  },30000);
}
