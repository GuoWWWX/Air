(() => {
  try {
    const saved = localStorage.getItem('air.bootTheme')
    const followSystem = !saved || saved === 'system'
    const dark = saved === 'dark' || (followSystem && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  } catch {}
})()
