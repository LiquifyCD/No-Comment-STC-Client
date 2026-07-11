import test from 'node:test';
import assert from 'node:assert/strict';
import {parseReaderCatalog,publicReaderOptions,resolveReaderCode} from './reader-catalog.mjs';

test('exposes aliases and labels without reader codes',()=>{
  const catalog=parseReaderCatalog('{"front":{"label":"Front door","code":1234}}',0);
  assert.equal(catalog.ok,true);
  assert.deepEqual(publicReaderOptions(catalog),[{key:'front',label:'Front door'}]);
  assert.equal(JSON.stringify(publicReaderOptions(catalog)).includes('1234'),false);
});
test('resolves only server-configured aliases',()=>{
  const catalog=parseReaderCatalog('{"front":{"label":"Front door","code":1234}}',0);
  assert.equal(resolveReaderCode(catalog,'front'),1234);
  assert.equal(resolveReaderCode(catalog,'arbitrary'),null);
});
test('rejects invalid catalogs and supports the legacy server fallback',()=>{
  assert.equal(parseReaderCatalog('{broken',0).ok,false);
  assert.deepEqual(parseReaderCatalog('',1234),{ok:true,entries:[{key:'default',label:'Standardreader',code:1234}]});
});
