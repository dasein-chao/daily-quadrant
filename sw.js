self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (e) {
  e.waitUntil((async function () {
    var items = [];
    try {
      var response = await fetch('/api/push/messages', { credentials: 'same-origin' });
      if (response.ok) items = await response.json();
    } catch (err) {
      items = [];
    }
    if (!items.length) {
      await self.registration.showNotification('四象限提醒', {
        body: '有任务临近截止，打开看看。',
        tag: 'dq-generic-' + Date.now()
      });
      return;
    }
    for (var i = 0; i < items.length; i++) {
      var m = items[i];
      await self.registration.showNotification(m.title || '四象限提醒', {
        body: m.body || '',
        tag: 'dq-' + Date.now() + '-' + i,
        data: { url: m.url || '/' }
      });
    }
  })());
});

self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windows) {
    for (var i = 0; i < windows.length; i++) {
      if (windows[i].url.indexOf(url) !== -1) return windows[i].focus();
    }
    return self.clients.openWindow(url);
  }));
});
