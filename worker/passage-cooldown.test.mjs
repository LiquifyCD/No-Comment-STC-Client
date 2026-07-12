import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {acquirePassageCooldown,PASSAGE_COOLDOWN_MS} from './passage-cooldown.mjs';

function database(){
  const sqlite=new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE passage_cooldowns(owner_id TEXT NOT NULL,reader_id TEXT NOT NULL,last_attempt_ms INTEGER NOT NULL,PRIMARY KEY(owner_id,reader_id))');
  return {sqlite,db:{prepare(sql){const statement=sqlite.prepare(sql);return {bind(...values){return {first:async()=>statement.get(...values)??null}}}}}};
}

test('atomic cooldown is scoped to owner and reader and lasts two seconds',async()=>{
  const {sqlite,db}=database();
  assert.equal(PASSAGE_COOLDOWN_MS,2000);
  assert.equal(await acquirePassageCooldown({db,owner:'owner-a',readerId:'reader-a',now:10_000}),true);
  assert.equal(await acquirePassageCooldown({db,owner:'owner-a',readerId:'reader-a',now:11_999}),false);
  assert.equal(await acquirePassageCooldown({db,owner:'owner-b',readerId:'reader-a',now:11_000}),true);
  assert.equal(await acquirePassageCooldown({db,owner:'owner-a',readerId:'reader-b',now:11_000}),true);
  assert.equal(await acquirePassageCooldown({db,owner:'owner-a',readerId:'reader-a',now:12_000}),true);
  sqlite.close();
});
