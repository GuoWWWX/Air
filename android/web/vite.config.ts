import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwind from '@tailwindcss/vite'

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url))

export default defineConfig({
  root: path('./'),
  base: './',
  plugins: [react(), tailwind()],
  resolve: { alias: { '@/shared': path('../../src/shared'), '@/assets': path('../../src/assets') } },
  build: {
    outDir: path('../app/build/generated/webAssets/web'),
    emptyOutDir: true,
    target: 'chrome105',
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'yaml-editor', test: /node_modules[\\/].*(?:@codemirror|@lezer)/ },
            { name: 'ui-vendor', test: /node_modules[\\/].*(?:react|scheduler)/ },
          ],
        },
      },
    },
    license: { fileName: 'frontend-licenses.md' },
  },
})
