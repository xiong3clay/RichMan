import { expect, it, vi } from 'vitest';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { diskHarness, command, Peer } from './persistence-harness.js';
import { writeSnapshotAtomic } from '../src/storage/atomic.js';

it('M1 revoked_socket: failed recovery rotation cannot revive old command/resume authority',async()=>{
  const h=await diskHarness();let failed:Peer|undefined;
  try{
    const {code,a,view}=await h.start();h.store.options.failAt='after_rename';
    failed=await new Peer(`ws://127.0.0.1:${h.server().port}/ws?room=${code}`).open();
    failed.send({type:'resume',roomCode:code,recoveryCode:a.joined.recoveryCode});await failed.next('error');await a.p.next('error');
    h.store.options.failAt=undefined;a.p.send(command(view,'revoked'));
    expect(await a.p.next('error')).toMatchObject({code:'NOT_JOINED'});
    a.p.send({type:'resume_game'});expect(await a.p.next('error')).toMatchObject({code:'NOT_JOINED'});
    const fresh=await h.connect(code,{recoveryCode:a.joined.recoveryCode});fresh.p.send({type:'resume_game'});
    expect((await fresh.p.next('snapshot',m=>m.view.paused===false)).view.finance.cents).toBe('10000');
  }finally{h.store.options.failAt=undefined;await failed?.close();await h.close();}
});
it('S1 cleanup_warning: cleanup failure cannot mask a completed rename',async()=>{
  const h=await diskHarness();try{
    const warn=vi.fn();const file=path.join(h.dir,'rooms','0042','snapshot.json');
    await writeSnapshotAtomic(file,{version:2},{failCleanup:true,warn} as any);
    expect(JSON.parse(await readFile(file,'utf8'))).toEqual({version:2});expect(warn).toHaveBeenCalledTimes(1);
  }finally{await h.close();}
});
it.each(['publish','emit','setCommand'])('S1 post_commit_%s: exceptions never restore pre-commit state',async mode=>{
  const h=await diskHarness();try{
    const {code}=await h.start();const manager=h.server().manager;const original=manager.exportRoom(code)!;
    if(mode==='setCommand'){
      const state=structuredClone(original.game!);state.version++;state.players[0]!.cents+=500;
      const spy=vi.spyOn(manager,'setCommand').mockImplementationOnce(()=>{throw new Error('post-commit cache');});
      await manager.commitTransition(code,{state,events:[],outcome:{ok:true},nextDeadlineAt:state.deadlineAt},
        {key:JSON.stringify([state.gameId,'p1','committed']),record:{payloadHash:'a'.repeat(64),reply:{type:'command_result',gameId:state.gameId,commandId:'committed',gameVersion:state.version,outcome:{ok:true}}}}).catch(()=>{});
      spy.mockRestore();manager.reconcileDurable(code);
      expect(manager.getGame(code)!.players[0]!.cents).toBe(10500);
      expect(manager.getCommand(JSON.stringify([state.gameId,'p1','committed']))).toBeDefined();
    }else{
      const unsubscribe=mode==='emit'?manager.subscribe(()=>{throw new Error('subscriber');}):()=>{};
      await manager.transact(code,()=>manager.disconnectFor(code,'p1'),mode==='publish'?()=>{throw new Error('publisher');}:undefined).catch(()=>{});
      unsubscribe();manager.reconcileDurable(code);
      expect(manager.getRoom(code)!.players[0]!.online).toBe(false);
    }
    const disk=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
    expect(manager.getGame(code)).toEqual(disk.game);
  }finally{await h.close();}
});
it.each(['open','writeFile','sync'])('S3 append_%s: committed reply survives restart without replaying money',async appendFailAt=>{
  const h=await diskHarness();try{
    const {code,a,view}=await h.start();(h.store.options as any).appendFailAt=appendFailAt;
    const cmd=command(view,'append-fault');a.p.send(cmd);expect(await a.p.next('error')).toMatchObject({code:'ERROR_PAUSED'});
    (h.store.options as any).appendFailAt=undefined;await h.restart();const host=await h.connect(code,{sessionToken:a.joined.sessionToken});
    host.p.send(cmd);const reply=await host.p.next('command_result');expect(reply.outcome.ok).toBe(true);
    expect(h.server().manager.getGame(code)!.players[0]!.cents).toBe(10500);
    host.p.send(cmd);expect(await host.p.next('command_result')).toEqual(reply);expect(h.server().manager.getGame(code)!.bankLoans).toHaveLength(1);
    if(appendFailAt!=='sync')expect(h.warnings.some(w=>w.includes('缺行'))).toBe(true);
  }finally{(h.store.options as any).appendFailAt=undefined;await h.close();}
});
it('S4 single_error: an identity failure broadcast followed by revocation sends one ERROR_PAUSED',async()=>{
  const h=await diskHarness();try{
    const {roomCode:code}=await(await fetch(`http://127.0.0.1:${h.server().port}/api/rooms`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
    const a=await h.connect(code);await h.connect(code);const begin=a.p.history.length;
    const unsubscribe=h.server().manager.subscribe(e=>{if(e.type==='storage_error')h.server().manager.reconcileDurable(code);});
    h.store.options.failAt='after_rename';a.p.send({type:'leave'});await a.p.next('error');
    a.p.send({type:'invalid-barrier'});await a.p.next('error',m=>m.code==='INVALID_MESSAGE');unsubscribe();
    expect(a.p.history.slice(begin).filter(m=>m.type==='error'&&m.code==='ERROR_PAUSED')).toHaveLength(1);
  }finally{h.store.options.failAt=undefined;await h.close();}
});
it('S6 failed_create: after-rename failure leaves no resurrectable empty room',async()=>{
  const h=await diskHarness();try{
    h.store.options.failAt='after_rename';expect((await fetch(`http://127.0.0.1:${h.server().port}/api/rooms`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status).toBe(503);
    h.store.options.failAt=undefined;await h.restart();expect(h.server().manager.roomCount()).toBe(0);
    expect((await readdir(path.join(h.dir,'rooms'))).filter(p=>/^\d+$/.test(p))).toEqual([]);
  }finally{h.store.options.failAt=undefined;await h.close();}
});
it('M2 failed_join_restart: unissued first credentials cannot leave an ownerless host',async()=>{
  const h=await diskHarness();let failed:Peer|undefined;
  try{
    const {roomCode:code}=await(await fetch(`http://127.0.0.1:${h.server().port}/api/rooms`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
    h.store.options.failAt='after_rename';failed=await new Peer(`ws://127.0.0.1:${h.server().port}/ws?room=${code}`).open();
    failed.send({type:'join',nickname:'never-issued'});await failed.next('error');h.store.options.failAt=undefined;
    await failed.close();await h.restart();expect(h.server().manager.getRoom(code)!.players).toEqual([]);
    const a=await h.connect(code),b=await h.connect(code);expect(h.server().manager.getRoom(code)!.hostId).toBe(a.joined.playerId);
    a.p.send({type:'ready',ready:true});b.p.send({type:'ready',ready:true});await a.p.next('room',m=>m.players.every((p:any)=>p.ready));
    a.p.send({type:'start'});expect((await a.p.next('snapshot')).view.phase).toBe('ACTION');
  }finally{h.store.options.failAt=undefined;await failed?.close();await h.close();}
});
it('M3 rejected_not_cached: no-version result stays out of memory and future snapshots',async()=>{
  const h=await diskHarness();try{
    const {code,a,view}=await h.start();const bad=command(view,'bad','BORROW_BANK',{amountCents:'0'});
    a.p.send(bad);const rejection=await a.p.next('command_result');expect(rejection.outcome.ok).toBe(false);
    a.p.send(bad);expect(await a.p.next('command_result')).toEqual(rejection);
    a.p.send(command(view,'good'));expect((await a.p.next('command_result')).outcome.ok).toBe(true);
    expect(h.server().manager.getCommand(JSON.stringify([view.gameId,'p1','bad']))).toBeUndefined();
    const disk=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
    expect(disk.commands.map((c:any)=>c.reply.commandId)).toEqual(['good']);
  }finally{await h.close();}
});
it('M4 game_over_events: restart and resume preserve drawResult and version/seq',async()=>{
  const h=await diskHarness();try{
    const {code,a}=await h.start();const state=structuredClone(h.server().manager.getGame(code)!);
    Object.assign(state,{phase:'GAME_OVER',winnerId:'p1',deadlineAt:null,windowDeadlineMs:null});
    const events=[{seq:state.eventSeq,type:'BET_SETTLED',at:new Date(1000).toISOString(),payload:{drawResult:1,players:[]}}];
    await h.server().manager.commitTransition(code,{state,events,outcome:{ok:true},nextDeadlineAt:null});
    await h.restart();const host=await h.connect(code,{sessionToken:a.joined.sessionToken});host.p.send({type:'resume_game'});
    await host.p.next('snapshot',m=>m.view.paused===false);
    const saved=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
    expect(saved.lastEvents).toEqual(events);expect(saved.game.version).toBe(state.version);expect(saved.game.eventSeq).toBe(state.eventSeq);
  }finally{await h.close();}
});
