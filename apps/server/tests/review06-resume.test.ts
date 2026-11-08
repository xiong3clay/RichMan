import { expect, it } from 'vitest';
import { advanceSystem, applyCommand, createInitialState, type EngineState } from '@richman/game-core';
import { diskHarness, command } from './persistence-harness.js';
import { GameCommandProcessor, RoomCommandQueue } from '../src/rooms/command-queue.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

it.each(['ACTION','TAX','BANK_DUE','INTEREST','TAX_AUTO'] as const)('S5 server_resume_%s: real WS resumes deadlines then scheduler and decisions continue',async phase=>{
  const h=await diskHarness();try{
    const {code,a,b}=await h.start();const old=h.server().manager.getGame(code)!;
    let state=createInitialState(old.gameId,old.config,[{nickname:'甲'},{nickname:'乙'}]);
    const ctx={actorId:'SYSTEM',nowMs:1000,drawResult:0 as const};
    if(phase==='ACTION')state=advanceSystem(state,ctx).state as EngineState;
    if(phase==='TAX'){
      Object.assign(state,{phase:'TAX',round:3,taxSeats:[1,2],taxIndex:0});state.players[0]!.cents=500;
      state=advanceSystem(state,ctx).state as EngineState;
    }
    if(phase==='ACTION'||phase==='TAX'){
      state=applyCommand(state,{protocolVersion:1,gameId:state.gameId,commandId:'request-fixture',type:'REQUEST_PRIVATE_LOAN',payload:{lenderId:'p2',principalCents:100,rateBps:1000},expectedGameVersion:state.version},
        {actorId:'p1',nowMs:1001,drawResult:0}).state as EngineState;
      if(phase==='ACTION')expect(state.pendingRequestId).toBeNull();
      else expect(state.pendingRequestId).not.toBeNull();
    }
    if(phase==='BANK_DUE'||phase==='INTEREST'){
      state.round=phase==='BANK_DUE'?4:2;
      state.bankLoans=[{loanId:'due',borrowerId:'p1',seatId:1,principalCents:1000,remainingCents:1000,rateBps:1000,issuedRound:1,dueRound:phase==='BANK_DUE'?4:99,lastInterestRound:state.round-1,status:'ACTIVE',origin:'NORMAL'}];
      if(phase==='BANK_DUE')state=advanceSystem(state,ctx).state as EngineState;
    }
    if(phase==='TAX_AUTO')Object.assign(state,{phase:'TAX',round:3,taxSeats:[1,2],taxIndex:0});
    state.version=old.version+1;state.eventSeq=old.eventSeq;
    await h.server().manager.commitTransition(code,{state,events:[],outcome:{ok:true},nextDeadlineAt:state.deadlineAt});
    const before=structuredClone(state);h.time(10000000);await h.restart();
    expect(h.server().manager.getGame(code)).toEqual(before);
    const host=await h.connect(code,{sessionToken:a.joined.sessionToken}),guest=await h.connect(code,{sessionToken:b.joined.sessionToken});
    host.p.send({type:'resume_game'});const resumed=(await host.p.next('snapshot',m=>m.view.paused===false)).view;
    expect(resumed.phase).toBe(before.phase);expect(resumed.version).toBe(before.version+1);
    if(phase==='ACTION'||phase==='TAX'){
      const after=h.server().manager.getGame(code)!;
      expect(after.players).toEqual(before.players);expect(after.actedSeats).toEqual(before.actedSeats);
      expect(Date.parse(resumed.deadlineAt)).toBe(10000000+(phase==='ACTION'?60000:45000));
      const request=after.requests.find(r=>r.borrowerId==='p1'&&r.status==='PENDING')!;
      expect(request.deadlineMs).toBe(10000000+45000);
      expect(after.currentSeatId).toBe(before.currentSeatId);
      if(phase==='ACTION')expect(after.pendingRequestId).toBeNull();
      if(phase==='TAX')expect(after.dangerDeadlineMs).toBe(10000000+60000);
      guest.p.send({protocolVersion:1,gameId:state.gameId,commandId:'resume-accept',type:'ACCEPT_PRIVATE_LOAN',payload:{requestId:request.requestId}});
      expect((await guest.p.next('command_result')).outcome.ok).toBe(true);
      expect(h.server().manager.getGame(code)!.privateLoans).toHaveLength(1);
    }else if(phase==='BANK_DUE'){
      expect(Date.parse(resumed.deadlineAt)).toBe(10000000+45000);
      host.p.send({protocolVersion:1,gameId:state.gameId,commandId:'due-repay',type:'BANK_DUE_DECISION',payload:{loanId:'due',decision:'REPAY'}});
      expect((await host.p.next('command_result')).outcome.ok).toBe(true);
      expect(h.server().manager.getGame(code)!.bankLoans[0]!.status).toBe('REPAID');
    }else{
      expect(resumed.deadlineAt).toBeNull();
      await host.p.next('snapshot',m=>m.view.phase==='ACTION'&&m.view.paused===false);
      const after=h.server().manager.getGame(code)!;
      if(phase==='INTEREST')expect(after.bankLoans[0]!.remainingCents).toBe(1100);
      else expect(after.players.map(p=>p.cents)).toEqual([8000,8000]);
      const events=host.p.history.filter(m=>m.type==='events').flatMap(m=>m.events);
      expect(events.filter(e=>e.type===(phase==='INTEREST'?'INTEREST_ACCRUED':'TAX_CHARGED'))).toHaveLength(phase==='INTEREST'?1:2);
    }
  }finally{await h.close();}
});

it('M3 successful_capacity_replay: only committed transitions consume 5000 slots; evicted envelopes revalidate',async()=>{
  const h=await diskHarness();try{
    const {code,view}=await h.start();const manager=h.server().manager;
    const template=structuredClone(manager.getGame(code)!);let state=structuredClone(template);
    // 5001次真实规则命令+提交；测试存储适配器仅省掉重复磁盘IO，末尾真实持久化并重启。
    const processor=new GameCommandProcessor({queue:new RoomCommandQueue(),getState:()=>state,advance:()=>{},now:()=>1000,atomicCommit:true,
      store:{get:key=>manager.getCommand(key),set:(key,r)=>manager.setCommand(key,r)},commit:(_code,result,entry)=>{
        state=structuredClone(result.state) as EngineState;manager.setCommand(entry!.key,entry!.record);
      }});
    let first:any;
    for(let i=0;i<5001;i++){
      state={...structuredClone(template),version:i+1};
      const cmd=command({...view,version:state.version},'success-'+i,'END_ACTION',{} as any);
      if(i===0)first=cmd;
      expect((await processor.execute(code,'p1',cmd as any)).outcome.ok).toBe(true);
      const rejected=command({...view,version:state.version},'reject-'+i,'BORROW_BANK',{amountCents:'0'});
      await processor.execute(code,'p1',rejected as any);
      expect(manager.getCommand(JSON.stringify([view.gameId,'p1','reject-'+i]))).toBeUndefined();
    }
    Object.assign(manager.getGame(code)!,state);await manager.persist(code);
    const saved=JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
    expect(saved.commands).toHaveLength(5000);expect(saved.commands.every((c:any)=>c.reply.outcome.ok)).toBe(true);
    expect(manager.getCommand(JSON.stringify([view.gameId,'p1','success-0']))).toBeUndefined();
    expect((await processor.execute(code,'p1',first)).outcome).toMatchObject({ok:false,code:'VERSION_CONFLICT'});
    const latest=saved.commands.at(-1);expect(await processor.execute(code,'p1',command({...view,version:5001},'success-5000','END_ACTION',{} as any) as any)).toEqual(latest.reply);
    // 淘汰窗口外不承诺永久幂等：换为当前合法信封视为新命令。
    state={...structuredClone(template),version:5002};
    expect((await processor.execute(code,'p1',{...first,expectedGameVersion:5002})).outcome.ok).toBe(true);
    await h.restart();expect(h.server().manager.exportRoom(code)!.commands).toHaveLength(5000);
  }finally{await h.close();}
},20000);
