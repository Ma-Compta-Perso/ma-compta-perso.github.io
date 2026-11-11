// sw.js — v1.00 — création : le « service worker ».
// Il garde l'appli en mémoire sur l'appareil pour qu'elle marche SANS réseau, et gère les mises à jour.
// ⚠️ Le n° de CACHE change à CHAQUE livraison (même si rien d'autre ne bouge ici) :
// c'est ce changement qui prévient le téléphone qu'une nouvelle version existe.

const CACHE = "ma-compta-v1.01"; // v1.01 — nouveau n° : c'est lui qui signale la nouvelle version aux téléphones
const FICHIERS = [
  "./",
  "index.html",
  "style.css",
  "app.js",
  "calcul.js",
  "stockage.js",
  "manifest.webmanifest",
  "icones/icone-192.png",
  "icones/icone-512.png",
  "icones/icone-maskable-512.png",
  "icones/icone-180.png",
  "icones/raccourci-depense-96.png",
  "icones/raccourci-entree-96.png",
  "icones/qr-ma-compta.svg", // v1.01 — le QR code de l'écran « Partager l'appli », visible même hors ligne
];

self.addEventListener("install", (e) => {
  // PIÈGE 6 : « reload » = on contourne le cache HTTP (GitHub Pages garde ses fichiers jusqu'à 10 min).
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FICHIERS.map((f) => new Request(f, { cache: "reload" })))));
  // Pas de skipWaiting() ici : la nouvelle version attend votre clic sur « Mettre à jour », jamais au milieu d'une saisie.
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      for (const nom of await caches.keys()) {
        if (nom !== CACHE && nom.startsWith("ma-compta-")) await caches.delete(nom); // l'ancienne version ne sert plus
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "MISE_A_JOUR") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // rien d'extérieur de toute façon (la page l'interdit)
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (req.mode === "navigate") {
        // Ouvrir l'appli (même avec ?saisie=depense) : la page en cache, sans attendre le réseau.
        return (await cache.match("index.html")) || fetch(req);
      }
      return (await cache.match(req, { ignoreSearch: true })) || fetch(req);
    })()
  );
});
