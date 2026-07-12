import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReaderCatalog} from './reader-catalog.mjs';
import {validateReaderCreation} from './reader-request.mjs';

const catalog=parseReaderCatalog('{"front":{"label":"Front door","code":1234}}',0);
test('mocked reader API resolves an alias to a server-side code',()=>assert.deepEqual(validateReaderCreation({name:'Office',readerKey:'front'},catalog),{ok:true,mode:'catalog',name:'Office',nameKey:'office',cardReader:1234}));
test('mocked reader API rejects arbitrary aliases and codes',()=>{
  assert.equal(validateReaderCreation({name:'Office',readerKey:'unknown'},catalog).status,400);
  assert.equal(validateReaderCreation({name:'Office',readerKey:'front',cardReader:9999},catalog).status,400);
  assert.equal(validateReaderCreation({name:'Office',readerKey:'front',readerCode:9999},catalog).status,400);
});
test('a valid major/minor pair is accepted as a custom beacon reader',()=>assert.deepEqual(validateReaderCreation({name:'Gym floor',major:'123','minor':'456'},catalog),{ok:true,mode:'beacon',name:'Gym floor',nameKey:'gym floor',major:'123',minor:'456'}));
test('beacon mode rejects non-numeric or oversized major/minor',()=>{
  assert.equal(validateReaderCreation({name:'Office',major:'abc',minor:'1'},catalog).status,400);
  assert.equal(validateReaderCreation({name:'Office',major:'1',minor:'1234567890123'},catalog).status,400);
});
