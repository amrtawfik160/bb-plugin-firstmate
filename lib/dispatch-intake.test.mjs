import test from 'node:test';import assert from 'node:assert/strict';
import {taskDelivery,nativeDispatchIntake} from './dispatch-intake.ts';
test('local-only delivery is branch readiness, never a PR/merge requirement or authority',()=>{
 assert.equal(taskDelivery('local-only'),'branch');assert.equal(taskDelivery('local-only','branch'),'branch');
 for(const contract of ['pr','merged','merged-and-verified'])assert.throws(()=>taskDelivery('local-only',contract),/conflicts/);
 assert.throws(()=>taskDelivery('direct-PR','branch'),/requires mode/);
 assert.equal(taskDelivery('direct-PR'),'merged');assert.equal(taskDelivery('no-mistakes','pr'),'pr');
 assert.equal(taskDelivery('local-only',undefined,'scout'),'merged');assert.throws(()=>taskDelivery('local-only','branch','scout'),/only to ship/);
});
test('native resolver off is inert; enabled decisions and configuration errors are never silently mapped or ignored',()=>{
 assert.equal(nativeDispatchIntake(0,'dispatch-resolve: off (no key)'),'off');
 for(const status of ['clear','ambiguous','escalate','error']){
  const result=`dispatch-resolve:\n  status: ${status}\n  profile: --harness codex --model native-model --effort high\n`;
  assert.throws(()=>nativeDispatchIntake(0,result),/intake\/approval/);
  assert.equal(nativeDispatchIntake(0,result,'Current user selected validated BB execution; preserve native approval rules'),status);
 }
 assert.throws(()=>nativeDispatchIntake(2,'bad rules','an override'),/configuration\/usage/);
 for(const output of ['', 'unknown', '  status: clear\n  status: error'])assert.throws(()=>nativeDispatchIntake(0,output,'reason'),/unique status/);
});
