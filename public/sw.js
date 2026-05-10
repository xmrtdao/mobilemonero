const CACHE_NAME = 'mobilemonero-v1'
const OFFLINE_PAGES = ['/']
const ASSETS_TO_CACHE = [
  '/',
  '/manifest.json',
  '/assets/index.js',
  '/assets/index.css',
]

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS_TO_CACHE))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names =>
      Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      )
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached
      return fetch(e.request)
        .then(response => {
          const clone = response.clone()
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
          return response
        })
        .catch(() => {
          if (e.request.mode === 'navigate') return caches.match('/')
        })
    })
  )
})
