import { pushApi } from './api'

export async function getDeviceSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null
  // Unlike ready, this resolves even when no service worker is installed.
  const registration = await navigator.serviceWorker.getRegistration()
  return registration?.pushManager ? registration.pushManager.getSubscription() : null
}

export async function reconcileDevicePush(): Promise<boolean> {
  const sub = await getDeviceSubscription()
  if (!sub) return false
  const { data } = await pushApi.status(sub.endpoint)
  if (!data.subscribed) await sub.unsubscribe()
  return data.subscribed
}
