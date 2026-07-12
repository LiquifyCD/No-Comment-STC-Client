import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {deleteOwnedReader,validateReaderDeletion} from './reader-deletion.mjs';

const valid={authenticated:true,originMatches:true,csrfValid:true,confirmed:true};
test('anonymous and cross-origin deletions are rejected',()=>{
  assert.equal(validateReaderDeletion({...valid,authenticated:false}).status,401);
  assert.equal(validateReaderDeletion({...valid,originMatches:false}).status,403);
  assert.equal(validateReaderDeletion({...valid,csrfValid:false}).status,403);
});
test('deletion requires explicit confirmation',()=>assert.equal(validateReaderDeletion({...valid,confirmed:false}).status,400));
test('owner-scoped deletion rejects other, unknown, and repeated readers',async()=>{
  const calls=[];let changes=1;
  const db={prepare(sql){return {bind(...values){
    calls.push({sql,values});
    return {run:async()=>({meta:{changes:changes-- >0?1:0}})};
  }}}};
  assert.equal(await deleteOwnedReader({db,owner:'owner-a',readerId:'reader-a'}),true);
  assert.equal(await deleteOwnedReader({db,owner:'owner-a',readerId:'reader-a'}),false);
  assert.match(calls[0].sql,/id=\? AND owner_id=\?/);assert.deepEqual(calls[0].values,['reader-a','owner-a']);
});
test('SQLite preserves another owner reader and removes only the authenticated owner reader',async()=>{
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('CREATE TABLE readers(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL)');
  sqlite.prepare('INSERT INTO readers VALUES(?,?)').run('reader-a','owner-a');sqlite.prepare('INSERT INTO readers VALUES(?,?)').run('reader-b','owner-b');
  const db={
    prepare(sql){
      const statement=sqlite.prepare(sql);
      return {bind(...values){return {async run(){return {meta:{changes:Number(statement.run(...values).changes)}}}}}};
    }
  };
  assert.equal(await deleteOwnedReader({db,owner:'owner-a',readerId:'reader-b'}),false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM readers WHERE owner_id=?').get('owner-b').count,1);
  assert.equal(await deleteOwnedReader({db,owner:'owner-a',readerId:'reader-a'}),true);
  assert.equal(await deleteOwnedReader({db,owner:'owner-a',readerId:'reader-a'}),false);
  sqlite.close();
});
