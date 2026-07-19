const CACHE_NAME = 'evening-edition-v1';
const ASSETS = [
  './index.html',
  './manifest.json',
  'https://img.icons8.com/ios-filled/512/8c1d1d/news.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});