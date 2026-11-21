import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './mobile.css'
import { App } from './app'

createRoot(document.getElementById('root')!).render(<App />)
