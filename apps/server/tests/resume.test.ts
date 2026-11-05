import { afterEach, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { diskHarness, command } from './persistence-harness.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GameView } from '../../web/src/GameView.js';
import { viewFixture } from '../../web/tests/view-fixtures.js';
import type { RichmanClient } from '../../web/src/net/client.js';
import { mountDom } from '../../web/tests/dom-harness.js';
let h: Awaited<ReturnType<typeof diskHarness>>;
afterEach(async () => { if (h) { await h.close(); h = null!; } });
it('paused_banner: sticky常驻暂停提示、房主继续入口且经济操作只读', () => {
  const html = renderToStaticMarkup(createElement(GameView, { roomCode:'0042',hostId:'p1', view:Object.assign(viewFixture(),{paused:true}),
    client:{hasJoined:true} as RichmanClient,status:'open',statusDetail:null,result:null,error:null,events:[] }));
  expect(html).toContain('对局已暂停（服务重启）'); expect(html).toContain('继续对局');
  expect(html).not.toContain('class="choice ');
  expect(html.indexOf('对局已暂停')).toBeLessThan(html.indexOf('class="stage"'));
});
it('paused_game_over_ui: 结束局暂停时继续按钮不被结束弹框遮挡，一次点击只发送一条',async()=>{
  const view=Object.assign(viewFixture(),{paused:true,phase:'GAME_OVER' as const,winnerId:'p1'});let calls=0;
  const props={roomCode:'0042',hostId:'p1',view,client:{hasJoined:true,resumeGame:()=>{calls++;return true;}} as unknown as RichmanClient,
    status:'open' as const,statusDetail:null,result:null,error:null,events:[]};
  const dom=await mountDom(createElement(GameView,props));
  try{
    expect(dom.container.querySelectorAll('[role="dialog"]').length).toBe(0);
    const button=dom.container.querySelectorAll('button').find(b=>b.textContent==='继续对局')!;
    await dom.clickElement(button);await dom.clickElement(button);expect(calls).toBe(1);
    await dom.update(createElement(GameView,{...props,view:{...view,paused:false}}));
    expect(dom.text()).not.toContain('对局已暂停');expect(dom.container.querySelectorAll('[role="dialog"]').length).toBe(1);
  }finally{await dom.cleanup();}
});
it('restart_paused: 过期锁注重启不追赶，只有房主继续且续时不解锁', async () => {
  h = await diskHarness(); const {code,a,b,view} = await h.start();
  a.p.send(command(view,'end-a','END_ACTION',{} as any)); await a.p.next('command_result');
  const action = (await b.p.next('snapshot', m => m.view.currentSeatId === 2)).view;
  b.p.send(command(action,'end-b','END_ACTION',{} as any)); await b.p.next('command_result');
  const betting = (await a.p.next('snapshot', m => m.view.phase === 'BETTING')).view;
  a.p.send({...command(betting,'lock','SUBMIT_BET',{betCents:'100',guess:1,leverage:1} as any),roundId:betting.round,phaseInstanceId:betting.phaseInstanceId});
  await a.p.next('command_result'); const old = structuredClone(h.server().manager.getGame(code)!);
  h.time(10000000); await h.restart();
  expect(h.server().manager.isPaused(code)).toBe(true); expect(h.server().manager.getGame(code)).toEqual(old);
  const guest = await h.connect(code,{sessionToken:b.joined.sessionToken}); guest.p.send({type:'resume_game'});
  expect(await guest.p.next('error')).toMatchObject({code:'NOT_HOST'});
  const host = await h.connect(code,{sessionToken:a.joined.sessionToken}); host.p.send({type:'resume_game'});
  const resumed = (await host.p.next('snapshot', m => m.view.paused === false)).view;
  expect(resumed.phase).toBe('BETTING'); expect(resumed.finance.myBet).toEqual({betCents:'100',guess:1,leverage:1});
  expect(Date.parse(resumed.deadlineAt)).toBe(10000000+45000); expect(resumed.phaseInstanceId).not.toBe(old.phaseInstanceId);
  expect(h.server().manager.getGame(code)!.players).toEqual(old.players);
  const saved = JSON.parse(await readFile(path.join(h.dir,'rooms',code,'snapshot.json'),'utf8'));
  expect(saved.lastEvents[0].type).toBe('GAME_RESUMED'); expect(saved.paused).toBe(false);
});
