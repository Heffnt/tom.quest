// Service worker for web push on tom.quest: it turns a pushed message into a
// notification and opens the message's URL on tap. It has no fetch handler
// and caches nothing, so the site's own loading is untouched. It is
// registered only by /push (app/push/push-client.tsx).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = null;
  }
  const title = payload && typeof payload.title === "string" ? payload.title : "tom.Quest";
  const body = payload && typeof payload.body === "string" ? payload.body : undefined;
  const url = payload && typeof payload.url === "string" ? payload.url : "/";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      data: { url },
      icon: "/apple-icon",
      badge: "/apple-icon",
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && typeof event.notification.data.url === "string"
    ? event.notification.data.url
    : "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) {
            return client
              .focus()
              .then((focused) => focused.navigate(url))
              .catch(() => self.clients.openWindow(url));
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
