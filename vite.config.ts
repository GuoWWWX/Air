import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwind()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'ui-vendor',
              test: /node_modules[\\/](?:react|react-dom|scheduler|@base-ui[\\/]react)[\\/]/,
            },
            {
              name: 'motion-icons',
              test: /node_modules[\\/](?:motion|framer-motion|motion-dom|motion-utils|lucide-react)[\\/]/,
            },
          ],
        },
      },
    },
  },
  clearScreen: false,
})
