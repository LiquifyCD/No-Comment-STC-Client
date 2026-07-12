import test from 'node:test';
import assert from 'node:assert/strict';
import {CONFIGURED_READER_UPSERT,saveConfiguredReader} from './configured-reader-store.mjs';

function mockDatabase(result){
  const state={sql:'',values:[]};
  return {state,prepare(sql){state.sql=sql;return {bind(...values){state.values=values;return {first:async()=>result}}}}};
}

test('upgrades a hidden legacy reader while preserving its id',async()=>{
  const db=mockDatabase({id:'existing-reader'});
  const id=await saveConfiguredReader({db,id:'new-id',owner:'owner',name:'Main entrance',nameKey:'main entrance',now:'2026-07-12T00:00:00Z',ciphertext:'encrypted'});
  assert.equal(id,'existing-reader');
  assert.match(db.state.sql,/ON CONFLICT\(owner_id,name_key\) DO UPDATE/);
  assert.match(db.state.sql,/WHERE readers\.config_ciphertext IS NULL/);
  assert.equal(db.state.values.includes('encrypted'),true);
});

test('does not overwrite an already configured duplicate',async()=>{
  const db=mockDatabase(null);
  assert.equal(await saveConfiguredReader({db,id:'new-id',owner:'owner',name:'Front',nameKey:'front',now:'now',ciphertext:'encrypted'}),null);
  assert.match(CONFIGURED_READER_UPSERT,/RETURNING id/);
});
