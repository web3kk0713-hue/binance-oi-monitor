'use strict';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { message = { body: '收到新的 OI 告警，请打开监测页面查看。' }; }
  const notification = message.notification || message;
  const assetId = message.event?.assetId || message.assetId || notification.data?.assetId;
  const target = new URL(self.registration.scope);
  if (assetId) target.searchParams.set('asset', String(assetId));
  event.waitUntil(self.registration.showNotification(String(notification.title || 'OI 监测 · 估值告警'), {
    body: String(notification.body || '监测到 OI/FDV 达到提醒阈值，点击查看数据来源。'),
    icon: new URL('favicon.svg', self.registration.scope).href,
    tag: String(notification.tag || message.id || 'oi-monitor-alert'),
    requireInteraction: message.event?.level === 'critical' || message.level === 'critical' || notification.requireInteraction === true,
    data: { url: target.href, assetId },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || self.registration.scope, self.registration.scope);
  // Never follow an external URL supplied in a push payload.
  if (target.origin !== self.location.origin || !target.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
    const client = clients.find((item) => item.url.startsWith(self.registration.scope));
    if (client) {
      await client.focus();
      const data = event.notification.data;
      client.postMessage(data?.marketKey ? { type: 'select-flow-event', marketKey: data.marketKey, eventId: data.eventId } : { type: 'select-asset', assetId: data?.assetId });
      return;
    }
    return self.clients.openWindow(target.href);
  }));
});
