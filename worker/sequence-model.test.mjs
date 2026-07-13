import test from 'node:test';
import assert from 'node:assert/strict';
import {runSequenceSteps,validateSequenceInput} from './sequence-model.mjs';

const valid={name:'Entry',steps:[{doorName:'Main entrance',delaySeconds:3},{doorName:'Sluss',delaySeconds:0}]};

test('validates ordered named-door steps and delays',()=>{
  const result=validateSequenceInput(valid);assert.equal(result.ok,true);
  assert.deepEqual(result.steps.map(step=>[step.position,step.doorNameKey,step.delayAfterMs]),[[0,'main entrance',3000],[1,'sluss',0]]);
});

test('rejects raw IDs, invalid delays, empty and oversized sequences',()=>{
  assert.equal(validateSequenceInput({...valid,readerId:'raw'}).status,400);
  assert.equal(validateSequenceInput({...valid,steps:[{readerId:'raw',doorName:'Main entrance',delaySeconds:0}]}).status,400);
  assert.equal(validateSequenceInput({...valid,steps:[]}).status,400);
  assert.equal(validateSequenceInput({...valid,steps:[{doorName:'Main',delaySeconds:11}]}).status,400);
  assert.equal(validateSequenceInput({...valid,steps:Array.from({length:8},(_,index)=>({doorName:`Door ${index}`,delaySeconds:5}))}).status,400);
});

test('runs in order, waits between steps, and stops on partial failure',async()=>{
  const events=[];
  const steps=[{name:'one',delayAfterMs:3000},{name:'two',delayAfterMs:0}];
  const success=await runSequenceSteps({steps,openStep:async step=>{events.push(`open:${step.name}`);return {ok:true}},wait:async ms=>events.push(`wait:${ms}`)});
  assert.deepEqual(events,['open:one','wait:3000','open:two']);assert.deepEqual(success,{ok:true,completedSteps:2});
  const failed=await runSequenceSteps({steps,openStep:async(_,index)=>index?{ok:false,status:502,error:'Rejected.'}:{ok:true},wait:async()=>{}});
  assert.deepEqual(failed,{ok:false,status:502,error:'Rejected.',failedStep:2,completedSteps:1});
});
