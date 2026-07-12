import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptJson,decryptJson} from './secret-box.mjs';

const key=btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
test('major and minor are encrypted at rest and decrypt correctly',async()=>{
  const value={major:'8251',minor:'543516'},ciphertext=await encryptJson(value,key);
  assert.equal(ciphertext.includes(value.major),false);assert.equal(ciphertext.includes(value.minor),false);
  assert.deepEqual(await decryptJson(ciphertext,key),value);
});
test('encrypted reader configuration rejects the wrong key',async()=>{
  const ciphertext=await encryptJson({major:'1',minor:'2'},key),wrong=btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));
  await assert.rejects(()=>decryptJson(ciphertext,wrong));
});
