import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// The island builds to ../public/tasks so Express serves it via
// app.use('/public', express.static(...)). base must match that URL prefix.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  base: '/public/tasks/',
  build: {
    outDir: path.resolve(__dirname, '../public/tasks'),
    emptyOutDir: true,
    manifest: true, // -> ../public/tasks/.vite/manifest.json (read by utils/viteManifest.js)
    rollupOptions: {
      input: path.resolve(__dirname, 'src/main.tsx'),
    },
  },
  server: {
    port: 5173,
    // Dev only: proxy API calls to the Express app so the session cookie works.
    proxy: { '/tasks/api': 'http://localhost:8080' },
  },
})
