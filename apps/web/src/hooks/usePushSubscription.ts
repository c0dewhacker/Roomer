import { useState, useEffect, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { pushApi } from '../lib/api'

// pushManager.subscribe() needs the VAPID public key as a raw Uint8Array,
// not the base64url string the backend hands out.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  const bytes = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; i++) bytes[i] = rawData.charCodeAt(i)
  return bytes
}

export type PushStatus = 'unsupported' | 'unconfigured' | 'checking' | 'subscribed' | 'unsubscribed'

export function usePushSubscription() {
  const supported = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window

  // staleTime: Infinity — the VAPID keypair is deployment-wide and static; no
  // need to ever refetch it within a session.
  const { data: vapidData, isLoading: vapidLoading } = useQuery({
    queryKey: ['push', 'vapid-public-key'],
    queryFn: () => pushApi.vapidPublicKey(),
    select: (res) => res.data.publicKey,
    staleTime: Infinity,
    enabled: supported,
  })

  const [status, setStatus] = useState<PushStatus>('checking')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!supported) {
      setStatus('unsupported')
      return
    }
    if (vapidLoading) return
    if (!vapidData) {
      setStatus('unconfigured')
      return
    }
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    setStatus(sub ? 'subscribed' : 'unsubscribed')
  }, [supported, vapidLoading, vapidData])

  useEffect(() => {
    refresh()
  }, [refresh])

  const subscribe = useCallback(async () => {
    if (!vapidData) return
    setBusy(true)
    // Tracked outside the try block so the catch can tell whether the
    // browser/OS-level subscription was actually created before whatever
    // failed — see the rollback comment below.
    let sub: PushSubscription | null = null
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        toast.error('Notification permission was not granted')
        return
      }
      const reg = await navigator.serviceWorker.ready
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidData),
      })
      const json = sub.toJSON()
      if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
        throw new Error('Browser returned an incomplete push subscription')
      }
      await pushApi.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } })
      setStatus('subscribed')
      toast.success('Push notifications enabled on this device')
    } catch (err) {
      // reg.pushManager.subscribe() can succeed (the browser now has a live
      // push endpoint registered with FCM/etc.) even when the subsequent
      // pushApi.subscribe() call fails — a network drop right after
      // subscribing, a transient 5xx. Left as-is, the next refresh() would
      // find that orphaned browser-side subscription via getSubscription()
      // and report "subscribed" even though the server has no record of it
      // and will never deliver to it — a silent, durable break the user has
      // no way to notice or recover from short of manually toggling it off
      // and back on. Roll the browser-side subscription back so status
      // correctly reflects reality and a retry starts clean.
      if (sub) {
        await sub.unsubscribe().catch(() => {})
        setStatus('unsubscribed')
      }
      toast.error(err instanceof Error ? err.message : 'Failed to enable push notifications')
    } finally {
      setBusy(false)
    }
  }, [vapidData])

  const unsubscribe = useCallback(async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await pushApi.unsubscribe(sub.endpoint)
        await sub.unsubscribe()
      }
      setStatus('unsubscribed')
      toast.success('Push notifications disabled on this device')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to disable push notifications')
    } finally {
      setBusy(false)
    }
  }, [])

  return { status, busy, subscribe, unsubscribe }
}
