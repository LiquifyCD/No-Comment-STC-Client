import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
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

test('SQLite upgrades only the legacy conflict and then returns every configured reader',async()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE readers(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,card_reader INTEGER NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT,config_ciphertext TEXT,UNIQUE(owner_id,name_key))');
  sqlite.prepare('INSERT INTO readers VALUES(?,?,?,?,?,?,?,?)').run('legacy','owner','Main entrance','main entrance',1306,'old',null,null);
  const db={prepare(sql){const statement=sqlite.prepare(sql);return {bind(...values){return {first:async()=>statement.get(...values)}}}}};
  const upgraded=await saveConfiguredReader({db,id:'replacement',owner:'owner',name:'Main entrance',nameKey:'main entrance',now:'new',ciphertext:'encrypted'});
  assert.equal(upgraded,'legacy');
  const visible=sqlite.prepare('SELECT id,config_ciphertext FROM readers WHERE config_ciphertext IS NOT NULL').all();
  assert.equal(visible.length,1);assert.equal(visible[0].id,'legacy');assert.equal(visible[0].config_ciphertext,'encrypted');
  assert.equal(await saveConfiguredReader({db,id:'duplicate',owner:'owner',name:'Main entrance',nameKey:'main entrance',now:'later',ciphertext:'changed'}),null);
  assert.equal(sqlite.prepare('SELECT config_ciphertext FROM readers WHERE id=?').get('legacy').config_ciphertext,'encrypted');
  sqlite.close();
});
