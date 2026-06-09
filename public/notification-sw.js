self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (client.url.includes("/") && "focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow("/");
        }
      }),
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "알림",
    body: "새로운 이벤트가 발생했습니다.",
  };

  if (event.data) {
    try {
      payload = event.data.json();
    } catch (error) {
      payload = {
        title: "알림",
        body: event.data.text() || payload.body,
      };
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon,
      badge: payload.badge,
      vibrate: payload.vibrate || [200, 100, 200],
      requireInteraction: true,
    }),
  );
});
