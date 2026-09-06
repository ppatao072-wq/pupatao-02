/* global self, clients */
// Push-notification handlers, imported into the Workbox-generated service
// worker via `workbox.importScripts` in vite.config.ts.
//
// Payload shape (sent from app/lib/push.server.ts):
//   { title, body, url?, icon?, tag? }

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Pupatao', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'Pupatao'
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: '/icon-192.png',
    // Same tag → a new notification replaces the previous one instead of stacking.
    tag: data.tag || 'pupatao-live',
    renotify: true,
    data: { url: data.url || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

// Focus an existing tab if the app is already open; otherwise open a new one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = (event.notification.data && event.notification.data.url) || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ('focus' in client) {
          client.focus()
          if ('navigate' in client) client.navigate(targetUrl).catch(() => {})
          return
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl)
    })
  )
})
