import { mkdtemp, readFile, readdir, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { writeSnapshotAtomic } from '../src/storage/atomic.js';
import { validateSnapshot } from '../src/storage/file-store.js';
import { diskHarness, command, Peer } from './persistence-harness.js';
import { MAX_MONEY_CENTS } from '@richman/shared';
import { createInitialState, type EngineState } from '@richman/game-core';
import { RoomScheduler } from '../src/rooms/scheduler.js';
import { RoomCommandQueue } from '../src/rooms/command-queue.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
it('atomic_snapshot_backup_and_before_rename: fsync后替换，备份上一提交，失败不改权威文件且清临时文件', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'richman-atomic-')); dirs.push(dir);
  const file = path.join(dir, 'rooms', '0042', 'snapshot.json');
  await writeSnapshotAtomic(file, { version: 1 });
  await expect(writeSnapshotAtomic(file, { version: 2 }, { failAt: 'before_rename' })).rejects.toThrow();
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ version: 1 });
  await writeSnapshotAtomic(file, { version: 3 });
  expect(JSON.parse(await readFile(path.join(path.dirname(file), 'snapshot.bak.json'), 'utf8'))).toEqual({ version: 1 });
  expect(await readFile(file, 'utf8')).toBe('{\n  "version": 3\n}\n');
  expect(await readdir(path.join(dir, '.tmp'))).toEqual([]);
});
it('candidate_identity_isolation: fsync等待期间旧epoch仍有效，提交后才可见新epoch', async () => {
  const h = await diskHarness(); let release = () => {}; let pending: Promise<unknown> | undefined;
  try {
    const {code} = await h.start(); const manager = h.server().manager;
    const old = manager.sessionRecords()[0]!;
    let entered!: () => void; const atBarrier = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    h.store.options.checkpoint = async point => { if (point === 'before_rename') { entered(); await gate; } };
    pending = manager.transact(code, () => manager.saveSession({...old,connectionEpoch:old.connectionEpoch+1}));
    await atBarrier;
    expect(manager.sessionRecords().find(r => r.playerId === old.playerId)!.connectionEpoch).toBe(old.connectionEpoch);
    release(); await pending;
    expect(manager.sessionRecords().find(r => r.playerId === old.playerId)!.connectionEpoch).toBe(old.connectionEpoch+1);
  } finally { release(); await pending; h.store.options.checkpoint = undefined; await h.close(); }
});
it('snapshot_shape_guard: 损坏金币与重复引擎身份不能载入', async () => {
  const h = await diskHarness();
  try {
    const {code} = await h.start(); const snapshot = h.server().manager.exportRoom(code)!;
    const bad = structuredClone(snapshot); Object.assign(bad.game!.players[0]!,{cents:'malformed-money'});
    expect(() => validateSnapshot(bad,code)).toThrow();
    const duplicate = structuredClone(snapshot); duplicate.game!.players[1] = duplicate.game!.players[0]!;
    expect(() => validateSnapshot(duplicate,code)).toThrow();
    const loan = structuredClone(snapshot); loan.game!.bankLoans=[{loanId:'broken',remainingCents:'not-money'} as any];
    expect(() => validateSnapshot(loan,code)).toThrow();
  } finally { await h.close(); }
});
it('backup_survives_failed_commit: 主快照损坏后回退备份，紧接写失败也不能破坏唯一好提交', async () => {
  const h = await diskHarness();
  try {
    const {code} = await h.start(); const file = path.join(h.dir,'rooms',code,'snapshot.json');
    await writeFile(file,'{broken'); const [restored] = await h.store.loadAll(); expect(restored).toBeDefined();
    h.store.options.failAt = 'before_rename';
    await expect(h.store.commitRoom(code,restored!,[])).rejects.toThrow();
    expect(await h.store.loadAll()).toHaveLength(1);
  } finally { h.store.options.failAt = undefined; await h.close(); }
});
it('credentials_restored: token/恢复码/epoch恢复，大额整数精确且存档全目录无秘密原文', async () => {
  const h=await diskHarness(); let rejected:Peer|undefined;
  try {
    const {code,a}=await h.start(); const state=structuredClone(h.server().manager.getGame(code)!);
    state.players[0]!.cents=MAX_MONEY_CENTS-1;state.version++;
    await h.server().manager.commitTransition(code,{state,events:[],outcome:{ok:true},nextDeadlineAt:state.deadlineAt});
    const oldEpoch=a.joined.connectionEpoch;
    await h.restart(); const token=await h.connect(code,{sessionToken:a.joined.sessionToken});
    expect(token.joined.playerId).toBe(a.joined.playerId);expect(token.joined.connectionEpoch).toBeGreaterThan(oldEpoch);
    expect((await token.p.next('snapshot')).view.finance.cents).toBe('999999999999');
    const recovery=await h.connect(code,{recoveryCode:a.joined.recoveryCode});
    expect(recovery.joined.connectionEpoch).toBeGreaterThan(token.joined.connectionEpoch);
    expect(recovery.joined.sessionToken===a.joined.sessionToken).toBe(false);
    rejected=await new Peer(`ws://127.0.0.1:${h.server().port}/ws?room=${code}`).open();
    rejected.send({type:'resume',roomCode:code,sessionToken:a.joined.sessionToken});
    expect(await rejected.next('error')).toMatchObject({code:'UNAUTHORIZED'});
    const files=await readdir(path.join(h.dir,'rooms',code));
    for(const name of files){const text=await readFile(path.join(h.dir,'rooms',code,name),'utf8');
      for(const secret of [a.joined.sessionToken,a.joined.recoveryCode,recovery.joined.sessionToken])expect(text.includes(secret)).toBe(false);
      expect(/"(?:sessionToken|recoveryCode|token)"\s*:/.test(text)).toBe(false);
    }
    const saved=await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8');
    expect(saved.includes('999999999999')).toBe(true);expect(JSON.parse(saved).game.players[0].cents).toBe(MAX_MONEY_CENTS-1);
  }finally{await rejected?.close();await h.close();}
});
it('write_failure: 写失败不广播成功不改账，暂停且ERROR_PAUSED；修复磁盘可继续', async()=>{
  const h=await diskHarness();
  try {
    const {code,a,b,view}=await h.start();const before=structuredClone(h.server().manager.getGame(code)!);const checkpoint=a.p.history.length;
    h.store.options.failAt='before_rename';a.p.send(command(view,'disk-fail'));
    expect(await a.p.next('error')).toMatchObject({code:'ERROR_PAUSED'});
    expect(await b.p.next('error')).toMatchObject({code:'ERROR_PAUSED'});
    expect(h.server().manager.getGame(code)).toEqual(before);expect(h.server().manager.isPaused(code)).toBe(true);
    expect(h.server().manager.getCommand(JSON.stringify([view.gameId,'p1','disk-fail']))).toBeUndefined();
    expect(a.p.history.slice(checkpoint).some(m=>m.type==='command_result'&&m.outcome?.ok)).toBe(false);
    expect(a.p.history.slice(checkpoint).some(m=>m.type==='snapshot'||m.type==='events')).toBe(false);
    h.store.options.failAt=undefined;a.p.send({type:'resume_game'});
    const resumed=(await a.p.next('snapshot',m=>m.view.paused===false&&m.view.version>view.version)).view;
    a.p.send(command(resumed,'disk-fail'));expect((await a.p.next('command_result')).outcome.ok).toBe(true);
    expect(h.server().manager.getGame(code)!.players[0]!.cents).toBe(10500);
  }finally{h.store.options.failAt=undefined;await h.close();}
});
it('after_rename_identity_write: 未应答已提交账在暂停恢复码轮换后也不能被旧内存覆盖', async()=>{
  const h=await diskHarness();let failedRecovery:Peer|undefined;
  try{
    const {code,a}=await h.start();
    h.store.options.failAt='after_rename';
    failedRecovery=await new Peer(`ws://127.0.0.1:${h.server().port}/ws?room=${code}`).open();
    failedRecovery.send({type:'resume',roomCode:code,recoveryCode:a.joined.recoveryCode});
    expect(await failedRecovery.next('error')).toMatchObject({code:'ERROR_PAUSED'});
    await a.p.next('error');h.store.options.failAt=undefined;
    a.p.send({type:'resume_game'});
    expect(await a.p.next('error')).toMatchObject({code:'NOT_JOINED'});
    a.p.send(command({gameId:h.server().manager.getGame(code)!.gameId,version:1},'revoked-old'));
    expect(await a.p.next('error')).toMatchObject({code:'NOT_JOINED'});
    const fresh=await h.connect(code,{recoveryCode:a.joined.recoveryCode});fresh.p.send({type:'resume_game'});
    const view=(await fresh.p.next('snapshot',m=>m.view.paused===false&&m.view.version>1)).view;
    const original=command(view,'committed-unacked');
    h.store.options.failAt='after_rename';fresh.p.send(original);expect(await fresh.p.next('error')).toMatchObject({code:'ERROR_PAUSED'});
    expect(h.server().manager.getGame(code)!.players[0]!.cents).toBe(10000);
    h.store.options.failAt=undefined;const rotated=await h.connect(code,{recoveryCode:a.joined.recoveryCode});
    await h.restart();const restored=await h.connect(code,{sessionToken:rotated.joined.sessionToken});
    expect((await restored.p.next('snapshot')).view.finance.cents).toBe('10500');
    restored.p.send(original);expect((await restored.p.next('command_result')).outcome.ok).toBe(true);
    expect(h.server().manager.getGame(code)!.players[0]!.cents).toBe(10500);
    expect(h.server().manager.getGame(code)!.bankLoans).toHaveLength(1);
  }finally{h.store.options.failAt=undefined;await failedRecovery?.close();await h.close();}
});
it('stale_owner_not_revived: 连续rename后失败与大厅座位复用不能使旧连接接管新身份', async()=>{
  // 原断言要求失败 join 留座，属 M2 错误行为，2026-11-05 修正。
  const h=await diskHarness();let newcomer:Peer|undefined;
  try{
    const base=`http://127.0.0.1:${h.server().port}`;
    const {roomCode:code}=await (await fetch(base+'/api/rooms',{method:'POST',body:'{}'})).json();
    const a=await h.connect(code),b=await h.connect(code);
    h.store.options.failAt='after_rename';a.p.send({type:'leave'});
    expect(await a.p.next('error')).toMatchObject({code:'ERROR_PAUSED'});
    await b.p.next('error');
    newcomer=await new Peer(`ws://127.0.0.1:${h.server().port}/ws?room=${code}`).open();
    let failedDigest='';
    h.store.options.checkpoint=async point=>{if(point==='after_rename'){
      const saved=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
      failedDigest=saved.players.find((p:any)=>p.nickname==='新身份')?.tokenDigest??failedDigest;
    }};
    newcomer.send({type:'join',nickname:'新身份'});
    expect(await newcomer.next('error')).toMatchObject({code:'ERROR_PAUSED'});
    h.store.options.failAt=undefined;h.store.options.checkpoint=undefined;
    a.p.send({type:'ready',ready:true});
    expect(await a.p.next('error')).toMatchObject({code:'NOT_JOINED'});
    b.p.send({type:'ready',ready:true});
    const room=await b.p.next('room',m=>m.players.find((p:any)=>p.playerId===b.joined.playerId)?.ready===true);
    expect(room.players.some((p:any)=>p.nickname==='新身份')).toBe(false);
    expect(h.server().manager.sessionRecords().some(r=>r.playerId===a.joined.playerId)).toBe(false);
    expect(room.hostId).toBe(b.joined.playerId);
    await h.restart();expect(h.server().manager.getRoom(code)!.players.some(p=>p.playerId===a.joined.playerId)).toBe(false);
    expect(h.server().manager.sessionRecords().some(r=>r.playerId===a.joined.playerId)).toBe(false);
    const returned=await h.connect(code,{sessionToken:b.joined.sessionToken}),newJoin=await h.connect(code);
    expect(newJoin.joined.sessionToken).toBeTruthy();
    expect(failedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(h.server().manager.matchesIdentity(code,newJoin.joined.playerId,failedDigest)).toBe(false);
    newJoin.p.send({type:'ready',ready:true});await returned.p.next('room',m=>m.players.every((p:any)=>p.ready));
    returned.p.send({type:'start'});await returned.p.next('started');
  }finally{h.store.options.failAt=undefined;await newcomer?.close();await h.close();}
});
it('orphan_events: 多3行不重放，断号/坏行/缺行均告警且保留权威快照', async()=>{
  const h=await diskHarness();
  try{
    const {code}=await h.start();const snapshot=h.server().manager.exportRoom(code)!;const seq=snapshot.game!.eventSeq;
    const file=path.join(h.dir,'rooms',code,'events.ndjson');
    for(let i=1;i<=3;i++)await appendFile(file,JSON.stringify({seq:seq+i,gameId:snapshot.gameId,at:0,events:[{seq:seq+i,type:'ORPHAN',at:'x',payload:{}}]})+'\n');
    expect((await h.store.loadAll())[0]!.game).toEqual(snapshot.game);
    await writeFile(file,'{bad\n'+JSON.stringify({seq,gameId:snapshot.gameId,events:[{seq,type:'GAP',at:'x',payload:{}}]})+'\n');
    expect((await h.store.loadAll())[0]!.game!.eventSeq).toBe(seq);
    expect(h.warnings.some(w=>w.includes('断号'))).toBe(true);expect(h.warnings.some(w=>w.includes('行无效'))).toBe(true);
    await writeFile(file,'');await h.store.loadAll();expect(h.warnings.some(w=>w.includes('缺行'))).toBe(true);
  }finally{await h.close();}
});
it('stale_payload: 重启同ID同载荷返回原reply，改载荷COMMAND_ID_REUSED不改账', async()=>{
  const h=await diskHarness();
  try{
    const {code,a,view}=await h.start();const cmd=command(view,'persisted-hash');a.p.send(cmd);const reply=await a.p.next('command_result');
    await h.restart();const restored=await h.connect(code,{sessionToken:a.joined.sessionToken});
    restored.p.send(cmd);expect(await restored.p.next('command_result')).toEqual(reply);
    restored.p.send({...cmd,payload:{amountCents:'600'}});
    expect((await restored.p.next('command_result')).outcome.code).toBe('COMMAND_ID_REUSED');
    expect(h.server().manager.getGame(code)!.players[0]!.cents).toBe(10500);
    const saved=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
    expect(saved.commands[0].payloadHash).toMatch(/^[a-f0-9]{64}$/);expect(saved.commands[0].reply).toEqual(reply);
  }finally{await h.close();}
});
it('schema_guard: schema99隔离整个目录，health和房间列表均不能出现坏房间', async()=>{
  const h=await diskHarness();
  try{
    const {code}=await h.start();const file=path.join(h.dir,'rooms',code,'snapshot.json');
    const saved=JSON.parse(await readFile(file,'utf8'));saved.schemaVersion=99;await writeFile(file,JSON.stringify(saved));
    await h.restart();expect(h.server().manager.getRoom(code)).toBeNull();
    const base=`http://127.0.0.1:${h.server().port}`;
    expect((await (await fetch(base+'/health')).json()).rooms).toBe(0);
    expect((await (await fetch(base+'/api/rooms')).json()).rooms).toEqual([]);
    expect((await readdir(path.join(h.dir,'rooms'))).some(p=>p.startsWith('corrupt-')&&p.includes(code))).toBe(true);
  }finally{await h.close();}
});
it('cold_start_and_rematch: 空目录启动，反复再开只保存当前局commands且旧ID不串账', async()=>{
  const h=await diskHarness();
  try{
    expect(h.server().manager.roomCount()).toBe(0);const {code,a,view}=await h.start();let current=view;
    for(let round=0;round<3;round++){
      a.p.send(command(current,'same-id'));expect((await a.p.next('command_result')).outcome.ok).toBe(true);
      const snapshot=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
      expect(snapshot.commands).toHaveLength(1);expect(JSON.parse(snapshot.commands[0].key)[0]).toBe(current.gameId);
      if(round<2){Object.assign(h.server().manager.getGame(code)!,{phase:'GAME_OVER',winnerId:'p1',deadlineAt:null,windowDeadlineMs:null});
        a.p.send({type:'rematch'});const started=await a.p.next('started');expect(started.gameId).not.toBe(current.gameId);
        current=(await a.p.next('snapshot',m=>m.view.gameId===started.gameId)).view;
      }
    }
  }finally{await h.close();}
});
it('empty_lobby_deleted: 大厅最后一人leave删除目录，重启不能复活空房间', async()=>{
  const h=await diskHarness();
  try{
    const base=`http://127.0.0.1:${h.server().port}`;const {roomCode:code}=await (await fetch(base+'/api/rooms',{method:'POST',body:'{}'})).json();
    const a=await h.connect(code),b=await h.connect(code);a.p.send({type:'leave'});await b.p.next('room',m=>m.players.length===1);
    b.p.send({type:'leave'});
    for(let i=0;i<100&&h.server().manager.getRoom(code)!==null;i++)await new Promise(r=>setTimeout(r,5));
    expect(h.server().manager.getRoom(code)).toBeNull();expect((await readdir(path.join(h.dir,'rooms'))).includes(code)).toBe(false);
    await h.restart();expect(h.server().manager.getRoom(code)).toBeNull();
  }finally{await h.close();}
});
it.each(['INTEREST','TAX','BETTING'] as const)('timeout_and_result_once %s: 同deadline两次唤醒加重启后旧回调，只结算一次',async phase=>{
  const h=await diskHarness();let scheduler:RoomScheduler|undefined;
  try{
    const {code}=await h.start();const old=h.server().manager.getGame(code)!;
    const state=createInitialState(old.gameId,old.config,[{nickname:'甲'},{nickname:'乙'}]);
    Object.assign(state,{phase,round:phase==='BETTING'?1:3,phaseInstanceId:'fixture-'+phase,eventSeq:old.eventSeq,version:old.version+1});
    if(phase==='INTEREST')state.bankLoans=[{loanId:'loan',borrowerId:'p1',seatId:1,principalCents:1000,remainingCents:1000,rateBps:1000,issuedRound:1,dueRound:99,lastInterestRound:2,status:'ACTIVE',origin:'NORMAL'}];
    if(phase==='TAX'){state.taxSeats=[1,2];state.taxIndex=0;}
    if(phase==='BETTING'){
      state.bets={p1:{betCents:100,guess:1,leverage:1},p2:{betCents:100,guess:0,leverage:1}};
      state.deadlineAt=new Date(1000).toISOString();state.windowDeadlineMs=1000;
    }
    await h.server().manager.commitTransition(code,{state,events:[],outcome:{ok:true},nextDeadlineAt:state.deadlineAt});
    const queue=new RoomCommandQueue();const draw=vi.fn(()=>1 as const);const errors:unknown[]=[];
    scheduler=new RoomScheduler({queue,now:()=>1000,draw,getState:c=>h.server().manager.isPaused(c)?null:h.server().manager.getGame(c),
      commit:(c,r)=>h.server().manager.commitTransition(c,r),onError:e=>errors.push(e)});
    let wake!:()=>void;
    const spy=vi.spyOn(globalThis,'setTimeout').mockImplementationOnce(callback=>{wake=callback as ()=>void;return {unref(){}} as NodeJS.Timeout;});
    scheduler.schedule(code);spy.mockRestore();wake();wake();await queue.run(code,()=>{});
    expect(errors).toEqual([]);const committed=structuredClone(h.server().manager.getGame(code)!);
    const disk=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
    if(phase==='INTEREST'){expect(committed.bankLoans[0]!.remainingCents).toBe(1100);expect(disk.lastEvents.filter((e:any)=>e.type==='INTEREST_ACCRUED')).toHaveLength(1);}
    if(phase==='TAX'){expect(committed.players.map(p=>p.cents)).toEqual([8000,8000]);expect(disk.lastEvents.filter((e:any)=>e.type==='TAX_CHARGED')).toHaveLength(2);}
    if(phase==='BETTING'){expect(committed.players.map(p=>p.cents)).toEqual([10100,9900]);expect(draw).toHaveBeenCalledTimes(1);
      expect(disk.lastEvents.find((e:any)=>e.type==='BET_SETTLED').payload.drawResult).toBe(1);}
    await h.restart();wake();await queue.run(code,()=>{});
    expect(h.server().manager.getGame(code)).toEqual(committed);
    expect(JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8')).lastEvents).toEqual(disk.lastEvents);
    if(phase==='BETTING')expect(draw).toHaveBeenCalledTimes(1);
  }finally{scheduler?.close();await h.close();}
});
it('command_capacity: 当前局最多5000条按最旧淘汰且JSON键/摘要/原reply落盘',async()=>{
  const h=await diskHarness();
  try{
    const {code,view}=await h.start();const manager=h.server().manager;
    for(let i=0;i<=5000;i++)manager.setCommand(JSON.stringify([view.gameId,'p1','cmd-'+i]),{payloadHash:'a'.repeat(64),
      reply:{type:'command_result',commandId:'cmd-'+i,gameId:view.gameId,gameVersion:view.version,outcome:{ok:true}}});
    await manager.persist(code);const saved=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
    expect(saved.commands).toHaveLength(5000);expect(JSON.parse(saved.commands[0].key)[2]).toBe('cmd-1');
    expect(JSON.parse(saved.commands.at(-1).key)[2]).toBe('cmd-5000');
  }finally{await h.close();}
});
it('automatic_invariant_pauses: 自动计息越界保持最后一致账并真正暂停而非仅打印',async()=>{
  const h=await diskHarness();
  try{
    const {code,a,view}=await h.start();const state=h.server().manager.getGame(code)!;
    Object.assign(state,{phase:'INTEREST',round:2,deadlineAt:null,windowDeadlineMs:null,currentSeatId:null});
    state.bankLoans=[{loanId:'overflow',borrowerId:'p1',seatId:1,principalCents:MAX_MONEY_CENTS,remainingCents:MAX_MONEY_CENTS,rateBps:1000,issuedRound:1,dueRound:99,lastInterestRound:1,status:'ACTIVE',origin:'NORMAL'}];
    const before=structuredClone(state);a.p.send(command(view,'overflow','END_ACTION',{} as any));
    expect(await a.p.next('error')).toMatchObject({code:'ERROR_PAUSED'});
    expect(h.server().manager.isPaused(code)).toBe(true);expect(h.server().manager.getGame(code)).toEqual(before);
  }finally{await h.close();}
});
