import { expect, it } from 'vitest';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { diskHarness } from './persistence-harness.js';
const bank=()=>({loanId:'b',borrowerId:'p1',seatId:1,principalCents:100,remainingCents:100,rateBps:1000,issuedRound:1,dueRound:4,lastInterestRound:1,status:'ACTIVE',origin:'NORMAL'});
const privateLoan=()=>({loanId:'p',borrowerId:'p1',lenderId:'p2',requestId:'r',principalCents:100,remainingCents:100,rateBps:1000,issuedRound:1,lastInterestRound:1,status:'ACTIVE'});
const request=()=>({requestId:'r',borrowerId:'p1',lenderId:'p2',principalCents:100,rateBps:1000,createdRound:1,createdAtMs:1000,deadlineMs:46000,status:'PENDING',context:'ACTION'});
const cases: Array<[string,(s:any)=>void]>=[
  ['lenderId',s=>{s.game.privateLoans=[{...privateLoan(),lenderId:'ghost'}];}],
  ['bank.status',s=>{s.game.bankLoans=[{...bank(),status:'FROZEN'}];}],
  ['private.status',s=>{s.game.privateLoans=[{...privateLoan(),status:'DEFAULTED'}];}],
  ['request.status',s=>{s.game.requests=[{...request(),status:'ACTIVE'}];}],
  ['dueRound',s=>{s.game.bankLoans=[{...bank(),dueRound:'tomorrow'}];}],
  ['origin',s=>{s.game.bankLoans=[{...bank(),origin:'PRIVATE'}];}],
  ['loan.seatId',s=>{s.game.bankLoans=[{...bank(),seatId:2}];}],
  ['duplicate.loanId',s=>{s.game.bankLoans=[bank(),bank()];}],
  ['duplicate.requestId',s=>{s.game.requests=[request(),request()];}],
  ['windowDeadlineMs',s=>{s.game.windowDeadlineMs='Infinity';}],
  ['dangerDeadlineMs',s=>{s.game.dangerDeadlineMs='NaN';}],
  ['currentSeatId',s=>{s.game.currentSeatId=9;}],
  ['dangerSeatId',s=>{s.game.dangerSeatId=9;}],
  ['pendingRequestId',s=>{s.game.pendingRequestId='missing';}],
  ['pendingDueLoanId',s=>{s.game.pendingDueLoanId='missing';}],
  ['taxSeats',s=>{s.game.taxSeats=[1,9];}],
  ['actedSeats',s=>{s.game.actedSeats=[1,1];}],
  ['taxIndex',s=>{s.game.taxIndex=99;}],
  ['playing.without.game',s=>{s.game=null;s.gameId=null;}],
  ['lobby.with.game',s=>{s.roomState='LOBBY';}],
  ['playing.pendingDelivery',s=>{s.sessions[0].pendingDelivery=true;}],
  ['hostId',s=>{s.hostId=null;}],
  ['tokenDigest.unique',s=>{s.players[1].tokenDigest=s.players[0].tokenDigest;s.sessions[1].tokenDigest=s.sessions[0].tokenDigest;}],
  ['recoveryDigest.unique',s=>{s.sessions[1].recoveryDigest=s.sessions[0].recoveryDigest;}],
  ['commands.capacity',s=>{s.commands=Array.from({length:5001},(_,i)=>({key:JSON.stringify([s.gameId,'p1','c'+i]),payloadHash:'a'.repeat(64),reply:{type:'command_result',commandId:'c'+i,gameId:s.gameId,gameVersion:s.game.version,outcome:{ok:true}}}));}],
  ['lastEvents.array',s=>{s.lastEvents={};}],
  ['lastEvents.seq',s=>{s.lastEvents=[{seq:s.game.eventSeq+1,type:'X',at:new Date(1000).toISOString(),payload:{}}];}],
  ['lastEvents.type',s=>{s.lastEvents=[{seq:1,type:7,at:new Date(1000).toISOString(),payload:{}}];}],
  ['lastEvents.at',s=>{s.lastEvents=[{seq:1,type:'X',at:'invalid',payload:{}}];}],
  ['lastEvents.payload',s=>{s.lastEvents=[{seq:1,type:'X',at:new Date(1000).toISOString()}];}],
  ['drawResult',s=>{s.lastEvents=[{seq:1,type:'BET_SETTLED',at:new Date(1000).toISOString(),payload:{drawResult:7}}];}],
];
it.each(cases)('S2 snapshot_shape_guard %s: corrupt directory is quarantined',async(_name,mutate)=>{
  const h=await diskHarness();try{
    const {code}=await h.start();const dir=path.join(h.dir,'rooms',code);const file=path.join(dir,'snapshot.json');
    const snapshot=JSON.parse(await readFile(file,'utf8'));mutate(snapshot);
    await writeFile(file,JSON.stringify(snapshot));await rm(path.join(dir,'snapshot.bak.json'),{force:true});
    expect(await h.store.loadAll()).toEqual([]);
    expect((await readdir(path.join(h.dir,'rooms'))).some(name=>name.startsWith('corrupt-')&&name.includes(code))).toBe(true);
  }finally{await h.close();}
});
