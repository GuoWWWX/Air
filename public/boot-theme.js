(() => {
  try {
    const native = window.airBootTheme
    const saved = native?.preference ?? localStorage.getItem('air.bootTheme')
    const systemDark = native?.systemDark ?? matchMedia('(prefers-color-scheme: dark)').matches
    const dark = saved === 'dark' || (saved === 'system' && systemDark)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
    document.documentElement.classList.toggle('dark', dark)
  } catch {}

  let scheduled = false
  const reveal = () => {
    if (window.__airSplashRevealed) return
    window.__airSplashRevealed = true
    window.__airSplashShownAt = performance.now()
    try {
      window.__TAURI_INTERNALS__?.invoke('reveal_startup_window')?.catch?.(() => {})
    } catch {}
  }
  const onReady = () => {
    if (scheduled || document.readyState === 'loading') return
    scheduled = true
    document.removeEventListener('readystatechange', onReady)
    window.removeEventListener('DOMContentLoaded', onReady)
    try { void document.body?.offsetHeight } catch {}
    requestAnimationFrame(() => requestAnimationFrame(reveal))
    setTimeout(reveal, 60)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('readystatechange', onReady)
    window.addEventListener('DOMContentLoaded', onReady)
  } else {
    onReady()
  }
})()
