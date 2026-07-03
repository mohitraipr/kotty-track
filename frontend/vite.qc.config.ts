import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// Second island: the QC dashboard. Builds to ../public/qc so Express serves it
// via app.use('/public', express.static(...)). base must match that URL prefix.
// Kept in a separate config so the Tasks build (vite.config.ts) is untouched.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  base: '/public/qc/',
  build: {
    outDir: path.resolve(__dirname, '../public/qc'),
    emptyOutDir: true,
    manifest: true, // -> ../public/qc/.vite/manifest.json (read by utils/viteManifest.js qcAssetTags)
    rollupOptions: {
      input: path.resolve(__dirname, 'src/qc/main.tsx'),
    },
  },
  server: {
    port: 5174,
    // Dev only: proxy API calls to the Express app so the session cookie works.
    proxy: { '/qc/api': 'http://localhost:8080' },
  },
})
