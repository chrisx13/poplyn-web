/* ============================================================================
   POPLYN — service worker offline-first. Le jeu est 100% statique : on met
   toute la coquille en cache à l'installation, puis on sert cache-first avec
   repli réseau. Une fois la première page chargée, le jeu tourne hors-ligne.

   Les chemins sont relatifs à ce fichier (racine du site) : ça marche aussi
   bien à la racine d'un domaine (Vercel/Netlify) que sous un sous-chemin
   (GitHub Pages, /poplyn/).

   Bump `VERSION` à chaque déploiement : l'ancien cache est purgé à l'activation.
   ========================================================================== */
const VERSION = 'poplyn-v3';

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'src/ad-config.js',
  'src/ads.js',
  'src/boosters.js',
  'src/game.js',
  'src/iap.js',
  'src/logic.js',
  'src/meta.js',
  'src/monetization.js',
  'src/storage.js',
  'src/style.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
];

/* Installation : précache. Un `addAll` échoue en bloc si une seule ressource
   manque — on ajoute donc fichier par fichier pour rester installable. */
self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(PRECACHE.map(async path => {
      try { await cache.add(new Request(path, { cache: 'reload' })); }
      catch { console.warn('[sw] précache ignoré :', path); }
    }));
    await self.skipWaiting();
  })());
});

/* Activation : on jette les caches des versions précédentes. */
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* Rafraîchit une entrée en tâche de fond (la partie en cours voit le cache,
   le prochain lancement voit la mise à jour). */
const revalidate = (cache, request) =>
  fetch(request)
    .then(res => { if (res.ok) cache.put(request, res.clone()); return res; })
    .catch(() => null);

self.addEventListener('fetch', e => {
  const { request } = e;
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) { revalidate(cache, request); return hit; }

    // Pas en cache : réseau, et on garde le résultat pour la prochaine fois.
    const res = await revalidate(cache, request);
    if (res) return res;

    // Hors-ligne : toute navigation retombe sur la coquille du jeu.
    if (request.mode === 'navigate') {
      const shell = await cache.match('index.html') || await cache.match('./');
      if (shell) return shell;
    }
    return new Response('Hors-ligne', { status: 503, statusText: 'Offline' });
  })());
});
