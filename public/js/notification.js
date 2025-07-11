if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/public/sw.js').then(async (reg) => {
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = document.querySelector('meta[name="vapid-public"]').content;
      const converted = urlBase64ToUint8Array(key);
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: converted
      });
      await fetch('/webhook/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub)
      });
    }
  }).catch(err => console.error('SW registration failed', err));
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
