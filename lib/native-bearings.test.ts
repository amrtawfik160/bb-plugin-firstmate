import assert from "node:assert/strict";
import test from "node:test";
import { nativeBearingsProjection } from "./native-bearings.ts";

const base = {schema:"fm-bearings.v1",home:"/fixture",in_flight:[],decisions_open:[],landed:[],gates:[],omitted:[]};

test("native Bearings retains date reasons, coverage, home warnings and exclusive contribution calls", () => {
  const projected = nativeBearingsProjection({...base,
    decisions_open:[{id:"mate/held",key:"held",owner:"mate",summary:"Owner must choose"}],
    gates:[{id:"deferred",title:"Release",reason:"dated until 2026-10-01"}],
    secondmates:[{id:"unknown-mate",state:"unknown",reason:"unreadable home"}, {id:"mate",state:"active_child_work",reason:"structured home state invalid"}],
    secondmate_reconcile:[{id:"mate",kind:"orphan_in_flight"}],
    contributions:{known:4,checked:2,proven_clear:false,counts:{captain:1,fleet:1,maintainer:1,nobody:1},
      unmeasured_homes:2,missing_verdicts:1,captain:[{task:"held",hold:"held",owner:"mate",reason:"Owner must choose"}]},
  });
  assert.equal(projected.calls.length,1);
  assert.match(projected.next.join("\n"),/dated until 2026-10-01/);
  assert.match(projected.next.join("\n"),/mate.*unknown.*unreadable home/);
  assert.match(projected.next.join("\n"),/mate.*structured home state invalid/);
  assert.match(projected.text,/checked 2\/4 known/);
  assert.match(projected.text,/unmeasured_homes: 2/);
  assert.match(projected.text,/missing_verdicts: 1/);
  assert.equal(projected.text.split("\n").filter(s=>/^(Captain's Call|Recently Landed|Underway|Charted Next)$/.test(s)).length,4);
});

test("native Bearings does not claim clear action coverage without native proof", () => {
  assert.match(nativeBearingsProjection(base).text,/coverage checked unverified\/unverified known is unverified/);
  assert.doesNotMatch(nativeBearingsProjection(base).text,/nothing needs your action/);
  assert.match(nativeBearingsProjection({...base,contributions:{proven_clear:true,known:0,checked:0}}).text,/Captain, nothing needs your action/);
});
