import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './style.css'

createRoot(document.getElementById('app')!).render(<App />)
