import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/style.css',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('../web/site.webmanifest',import.meta.url),'utf8'));
const migration=readFileSync(new URL('../migrations/0001_readers.sql',import.meta.url),'utf8');
const worker=readFileSync(new URL('./index.ts',import.meta.url),'utf8');

test('manifest defines a standalone scoped app',()=>{assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/readers');assert.equal(manifest.scope,'/');assert.ok(manifest.name);assert.ok(manifest.short_name);assert.deepEqual(manifest.icons.map(icon=>icon.sizes),['192x192','512x512'])});
test('iPhone standalone metadata and viewport-fit are present',()=>{for(const value of ['apple-mobile-web-app-capable','apple-mobile-web-app-title','apple-mobile-web-app-status-bar-style','viewport-fit=cover','apple-touch-icon'])assert.match(html,new RegExp(value))});
test('safe areas and mobile overflow protection are present',()=>{for(const value of ['safe-area-inset-top','safe-area-inset-bottom','safe-area-inset-left','safe-area-inset-right','100dvh','overflow-x:hidden','touch-action:manipulation'])assert.ok(css.includes(value))});
test('reader schema uses UUID IDs, owner-scoped duplicate keys, and cascading reader data',()=>{assert.match(migration,/id TEXT PRIMARY KEY/);assert.match(migration,/UNIQUE \(owner_id, name_key\)/);assert.match(migration,/reader_id TEXT NOT NULL/);assert.match(migration,/ON DELETE CASCADE/)});
test('reader mutations are owner scoped',()=>{assert.ok((worker.match(/WHERE id=\? AND owner_id=\?/g)||[]).length>=4);assert.match(worker,/reader_events\(id,reader_id,owner_id/)});
test('SPA routes cover overview, creation, and reader details',()=>{assert.match(worker,/path==='\/readers'/);assert.match(worker,/path==='\/readers\/new'/);assert.ok(worker.includes('/^\\/readers\\/[0-9a-f-]{36}$/i'))});
