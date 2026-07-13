import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {getDefaultSelection,resolveSequenceReaders} from './sequence-store.mjs';

function adapter(sqlite){
  return {prepare(sql){const statement=sqlite.prepare(sql);return {bind(...values){return {first:async()=>statement.get(...values)??null,all:async()=>({results:statement.all(...values)})}}}}};
}

function database(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON; CREATE TABLE readers(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,card_reader INTEGER NOT NULL,created_at TEXT NOT NULL,last_opened_at TEXT,config_ciphertext TEXT,UNIQUE(owner_id,name_key)); CREATE TABLE sequences(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,name TEXT NOT NULL,name_key TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(owner_id,name_key)); CREATE TABLE sequence_steps(sequence_id TEXT NOT NULL,position INTEGER NOT NULL,reader_id TEXT NOT NULL,delay_after_ms INTEGER NOT NULL,PRIMARY KEY(sequence_id,position),FOREIGN KEY(sequence_id) REFERENCES sequences(id) ON DELETE CASCADE,FOREIGN KEY(reader_id) REFERENCES readers(id) ON DELETE CASCADE); CREATE TABLE user_preferences(owner_id TEXT PRIMARY KEY,default_type TEXT NOT NULL,default_id TEXT NOT NULL,updated_at TEXT NOT NULL)');
  return sqlite;
}

test('sequence reader resolution is owner scoped and accepts saved authorized reader types',async()=>{
  const sqlite=database();
  sqlite.prepare('INSERT INTO readers VALUES(?,?,?,?,?,?,?,?)').run('catalog-a','owner-a','Main','main',1306,'now',null,null);
  sqlite.prepare('INSERT INTO readers VALUES(?,?,?,?,?,?,?,?)').run('custom-b','owner-b','Main','main',0,'now',null,'encrypted');
  const db=adapter(sqlite),step={doorNameKey:'main',position:0,delayAfterMs:0};
  assert.deepEqual(await resolveSequenceReaders({db,owner:'owner-a',steps:[step]}),{ok:true,steps:[{readerId:'catalog-a',position:0,delayAfterMs:0}]});
  assert.deepEqual(await resolveSequenceReaders({db,owner:'owner-b',steps:[step]}),{ok:true,steps:[{readerId:'custom-b',position:0,delayAfterMs:0}]});
  assert.equal((await resolveSequenceReaders({db,owner:'owner-a',steps:[{...step,doorNameKey:'missing'}]})).status,404);
  sqlite.prepare('DELETE FROM readers WHERE id=?').run('catalog-a');
  assert.equal((await resolveSequenceReaders({db,owner:'owner-a',steps:[step]})).status,404);
  sqlite.close();
});

test('ambiguous saved names are rejected instead of choosing a reader',async()=>{
  const db={prepare(){return {bind(){return {all:async()=>({results:[{id:'one'},{id:'two'}]})}}}}};
  const result=await resolveSequenceReaders({db,owner:'owner',steps:[{doorNameKey:'main',position:0,delayAfterMs:0}]});
  assert.equal(result.ok,false);assert.equal(result.status,409);
});

test('deleted and other-owner defaults fall back to the first valid owner item',async()=>{
  const sqlite=database(),db=adapter(sqlite);
  sqlite.prepare('INSERT INTO readers VALUES(?,?,?,?,?,?,?,?)').run('door-a','owner-a','A','a',1,'2026-01-01',null,null);
  sqlite.prepare('INSERT INTO readers VALUES(?,?,?,?,?,?,?,?)').run('door-b','owner-a','B','b',2,'2026-01-02',null,null);
  sqlite.prepare('INSERT INTO readers VALUES(?,?,?,?,?,?,?,?)').run('door-c','owner-b','C','c',3,'2026-01-03',null,null);
  sqlite.prepare('INSERT INTO sequences VALUES(?,?,?,?,?,?)').run('sequence-a','owner-a','Flow','flow','now','now');
  sqlite.prepare('INSERT INTO sequence_steps VALUES(?,?,?,?)').run('sequence-a',0,'door-a',0);
  sqlite.prepare('INSERT INTO user_preferences VALUES(?,?,?,?)').run('owner-a','sequence','sequence-a','now');
  assert.deepEqual(await getDefaultSelection({db,owner:'owner-a'}),{type:'sequence',id:'sequence-a'});
  sqlite.prepare('DELETE FROM readers WHERE id=?').run('door-a');
  assert.deepEqual(await getDefaultSelection({db,owner:'owner-a'}),{type:'door',id:'door-b'});
  sqlite.prepare('UPDATE user_preferences SET default_type=?,default_id=? WHERE owner_id=?').run('door','door-c','owner-a');
  assert.deepEqual(await getDefaultSelection({db,owner:'owner-a'}),{type:'door',id:'door-b'});
  sqlite.prepare('DELETE FROM readers WHERE owner_id=?').run('owner-a');
  assert.equal(await getDefaultSelection({db,owner:'owner-a'}),null);
  sqlite.close();
});

test('sequence migration preserves existing readers and enforces ordered cascading steps',()=>{
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('../migrations/0001_readers.sql',import.meta.url),'utf8'));
  sqlite.prepare('INSERT INTO readers VALUES(?,?,?,?,?,?,?)').run('existing','owner','Main','main',1306,'before',null);
  for(const name of ['0002_reader_lookup_config.sql','0003_main_entrance_default.sql','0004_passage_cooldowns.sql','0005_sequences_and_defaults.sql'])sqlite.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM readers WHERE id=?').get('existing').count,1);
  sqlite.prepare('INSERT INTO sequences VALUES(?,?,?,?,?,?)').run('sequence','owner','Flow','flow','now','now');
  sqlite.prepare('INSERT INTO sequence_steps VALUES(?,?,?,?)').run('sequence',0,'existing',1000);
  assert.throws(()=>sqlite.prepare('INSERT INTO sequence_steps VALUES(?,?,?,?)').run('sequence',8,'existing',0));
  sqlite.prepare('DELETE FROM readers WHERE id=?').run('existing');
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM sequence_steps').get().count,0);
  sqlite.close();
});
