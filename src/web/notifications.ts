import type { AlertEvent, Thresholds } from '../shared/types';
import { loadPushRegistration, savePushRegistration } from './storage';
import { percent } from './format';

let registration: Promise<ServiceWorkerRegistration> | undefined;
export function registerNotifications(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) return Promise.reject(new Error('此浏览器不支持系统推送，请使用 Chrome 或 Edge。'));
  // A relative URL keeps service workers scoped to this GitHub Pages repository.
  return registration ??= navigator.serviceWorker.register(new URL('sw.js', document.baseURI).href, { scope: './' })
    .then(() => navigator.serviceWorker.ready).catch(error => { registration = undefined; throw error; });
}
export function notificationSupport(): boolean { return 'Notification' in window && 'serviceWorker' in navigator && window.isSecureContext; }
export async function requestNotifications(): Promise<boolean> {
  if (!notificationSupport()) throw new Error('系统通知需要 HTTPS 和受支持的浏览器。');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? '通知权限已被拒绝，请在浏览器的网站权限中开启。' : '未开启通知权限，页内提醒仍然可用。');
  await registerNotifications();
  return true;
}
export async function showAlertNotification(event: AlertEvent, test = false): Promise<void> {
  if (!notificationSupport() || Notification.permission !== 'granted') return;
  const worker = await registerNotifications();
  await worker.showNotification(test ? 'OI 监测 · 测试提醒' : `${event.symbol} · OI/FDV 达到 ${percent(event.ratio)}`, {
    body: test ? '系统通知已就绪。这是一条测试消息，不代表实时行情。' : `已触发${event.level === 'critical' ? '强' : event.level === 'danger' ? '红色' : '黄色'}提醒。点击查看该币种和数据来源。`,
    icon: new URL('favicon.svg', document.baseURI).href,
    tag: test ? 'oi-test-notification' : event.id,
    requireInteraction: !test && event.level === 'critical',
    data: { assetId: test ? undefined : event.assetId, url: new URL(`?asset=${encodeURIComponent(event.assetId)}`, document.baseURI).href },
  });
}
function vapidBytes(base64: string): Uint8Array<ArrayBuffer> {
  const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
export async function connectPush(backendUrl: string, thresholds: Thresholds): Promise<void> {
  await requestNotifications();
  const keyResponse = await fetch(`${backendUrl}/api/v1/push/key`, { signal: AbortSignal.timeout(15_000) });
  if (!keyResponse.ok) throw new Error(`后台推送配置读取失败（${keyResponse.status}）`);
  const key = await keyResponse.json() as { publicKey: string | null };
  if (!key.publicKey) throw new Error('后台尚未配置 Web Push 密钥。');
  const worker = await registerNotifications();
  const old = await loadPushRegistration();
  if (old && old.backendUrl !== backendUrl) throw new Error('请先停用原后台推送，再连接新的后台。');
  const subscription = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidBytes(key.publicKey) });
  const response = await fetch(`${backendUrl}/api/v1/push/subscriptions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(old ? { Authorization: `Bearer ${old.deleteToken}` } : {}) },
    body: JSON.stringify({ subscription: subscription.toJSON(), thresholds }), signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`订阅失败（${response.status}），请检查后台允许的来源。`);
  const data = await response.json() as { id: string; deleteToken: string };
  if (!data.id || !data.deleteToken) throw new Error('后台未返回有效订阅凭证。');
  await savePushRegistration({ ...data, backendUrl });
}
export async function disconnectPush(): Promise<void> {
  const saved = await loadPushRegistration();
  if (saved) {
    const response = await fetch(`${saved.backendUrl}/api/v1/push/subscriptions/${encodeURIComponent(saved.id)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${saved.deleteToken}` }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error('后台订阅停用失败，请重试。');
  }
  const worker = await registerNotifications();
  await (await worker.pushManager.getSubscription())?.unsubscribe();
  await savePushRegistration();
}
