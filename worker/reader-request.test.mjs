import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReaderCreation} from './reader-request.mjs';

test('a valid custom major/minor reader is accepted',()=>assert.deepEqual(validateReaderCreation({name:'Gym floor',major:'123',minor:'456'}),{ok:true,name:'Gym floor',nameKey:'gym floor',major:'123',minor:'456'}));
test('preset and arbitrary reader codes are rejected',()=>{
  assert.equal(validateReaderCreation({name:'Office',readerKey:'front'}).status,400);
  assert.equal(validateReaderCreation({name:'Office',major:'1',minor:'2',cardReader:9999}).status,400);
  assert.equal(validateReaderCreation({name:'Office',major:'1',minor:'2',readerCode:9999}).status,400);
});
test('custom mode rejects non-numeric or oversized major/minor',()=>{
  assert.equal(validateReaderCreation({name:'Office',major:'abc',minor:'1'}).status,400);
  assert.equal(validateReaderCreation({name:'Office',major:'1',minor:'1234567890123'}).status,400);
});
