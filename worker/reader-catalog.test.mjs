import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReaderCatalog} from './reader-catalog.mjs';
test('rejects invalid catalogs and supports the legacy server fallback',()=>{
  assert.equal(parseReaderCatalog('{broken',0).ok,false);
  assert.deepEqual(parseReaderCatalog('',1234),{ok:true,entries:[{key:'default',label:'Standardreader',code:1234}]});
});
