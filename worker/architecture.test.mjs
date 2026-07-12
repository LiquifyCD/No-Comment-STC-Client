import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../web/style.css',import.meta.url),'utf8');
const manifest=JSON.parse(readFileSync(new URL('../web/site.webmanifest',import.meta.url),'utf8'));
const worker=readFileSync(new URL('./index.ts',import.meta.url),'utf8');
const app=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const config=readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8');

test('manifest launches the minimal app in standalone mode',()=>{assert.equal(manifest.display,'standalone');assert.equal(manifest.start_url,'/');assert.equal(manifest.scope,'/');assert.deepEqual(manifest.icons.map(icon=>icon.sizes),['192x192','512x512'])});
test('iPhone Home Screen metadata and all safe areas are present',()=>{for(const value of ['apple-mobile-web-app-capable','apple-mobile-web-app-title','apple-mobile-web-app-status-bar-style','viewport-fit=cover','apple-touch-icon'])assert.match(html,new RegExp(value));for(const value of ['safe-area-inset-top','safe-area-inset-bottom','safe-area-inset-left','safe-area-inset-right','100dvh','overflow-x:hidden','touch-action:manipulation'])assert.ok(css.includes(value))});
test('first view is limited to reader selector, create control, and Open',()=>{assert.match(app,/id="reader"/);assert.match(app,/id="open"/);assert.match(app,/id="create"/);assert.doesNotMatch(app,/Dina readers|Senaste aktivitet|reader-grid|raw ID|workspace/)});
test('credentials are requested in a modal and sent once without persistence',()=>{assert.match(app,/id="credentials"/);assert.match(app,/\/api\/open-door/);assert.match(app,/email:data\.get\('email'\)/);assert.match(app,/password:data\.get\('password'\)/);assert.doesNotMatch(app,/localStorage|sessionStorage|indexedDB/)});
test('configured-reader creation collects name, major, and minor',()=>{assert.match(app,/id="create-reader"/);assert.match(app,/name="major"/);assert.match(app,/name="minor"/);assert.match(app,/\/api\/configured-readers/)});
test('single open-door endpoint and configured-reader routes are wired',()=>{assert.match(worker,/path==='\/api\/open-door'/);assert.match(worker,/runOpenDoorFlow/);assert.match(worker,/path==='\/api\/configured-readers'/)});
test('open request sends only credentials and reader UUID',()=>{assert.match(app,/email:data\.get\('email'\),password:data\.get\('password'\),reader:selectedReader/);assert.doesNotMatch(app,/cardReader|readerCode|access_token|refresh_token|customerId/);assert.doesNotMatch(config,/PASSAGE_CARD_READER/)});
test('major and minor are encrypted and reader lookup is owner scoped',()=>{assert.match(worker,/encryptJson\(\{major:result\.major,minor:result\.minor\}/);assert.match(worker,/WHERE id=\? AND owner_id=\? AND config_ciphertext IS NOT NULL/);assert.match(worker,/decryptJson/)});
test('production opening remains disabled in committed configuration',()=>{assert.match(config,/"PASSAGE_ENABLED": "false"/)});
test('iPhone 13 controls are touch friendly and cannot overflow',()=>{assert.match(css,/min-height:64px/);assert.match(css,/width:min\(100%,390px\)/);assert.match(css,/@media\(max-width:430px\)/);assert.match(css,/min-width:0/)});
