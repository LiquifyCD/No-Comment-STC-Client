const CACHE='no-comment-stc-v26';
const SHELL=['/','/index.html','/style.css','/theme.js','/launch.js','/app.js','/site.webmanifest','/icon-192.png','/icon-512.png','/icon-maskable-192.png','/icon-maskable-512.png','/apple-touch-icon.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{const request=event.request,url=new URL(request.url);if(request.method!=='GET'||url.origin!==location.origin||url.pathname.startsWith('/api/')||request.headers.has('range'))return;
  // Stale-while-revalidate: the shell is answered from the cache at once and refreshed behind it, so a new version shows on the next launch.
  if(SHELL.includes(url.pathname)){let copy;const fresh=fetch(request).then(response=>{if(response.ok)copy=response.clone();return response});event.waitUntil(fresh.then(()=>copy&&caches.open(CACHE).then(cache=>cache.put(request,copy))).catch(()=>{}));event.respondWith(caches.match(request).then(match=>match||fresh));return}
  event.respondWith(fetch(request).then(response=>{if(response.ok)event.waitUntil(caches.open(CACHE).then(cache=>cache.put(request,response.clone())));return response}).catch(()=>caches.match(request).then(match=>match||(/^\/readers(?:\/|$)/.test(url.pathname)?caches.match('/index.html'):undefined))))});
