import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReaderName, readerPath, validateReaderName } from './reader-model.mjs';

test('normalizes whitespace without changing display identity',()=>assert.equal(normalizeReaderName('  Huvud   entré  '),'Huvud entré'));
test('rejects empty reader names',()=>assert.deepEqual(validateReaderName('   '),{ok:false,error:'Ange ett namn.'}));
test('rejects invalid reader names',()=>assert.equal(validateReaderName('../reader').ok,false));
test('rejects names longer than 40 characters',()=>assert.equal(validateReaderName('a'.repeat(41)).ok,false));
test('accepts Swedish names and creates a stable duplicate key',()=>assert.deepEqual(validateReaderName('  Södra Entrén  '),{ok:true,name:'Södra Entrén',nameKey:'södra entrén'}));
test('builds routes from permanent IDs, not display names',()=>assert.equal(readerPath('1a44fecd-c786-4e1a-bda3-4377761bd42e'),'/readers/1a44fecd-c786-4e1a-bda3-4377761bd42e'));
