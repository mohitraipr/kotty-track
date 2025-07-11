self.addEventListener('push', function(event) {
  let data = {};
  try { data = event.data.json(); } catch (e) {}
  const options = {
    body: data.message || 'Inventory alert',
    data: { url: data.url }
  };
  event.waitUntil(self.registration.showNotification('Inventory Alert', options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const url = event.notification.data.url;
  if (url) {
    event.waitUntil(clients.openWindow(url));
  }
});
