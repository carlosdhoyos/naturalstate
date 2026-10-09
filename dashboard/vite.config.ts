import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// `npm run build` produces ONE self-contained file: standalone/index.html.
// JS, CSS, fonts and every CSV are inlined, so it opens from disk (file://) with no server.
// The CSVs are read from ../Data Birds and ../Data Vegetation at build time — never copied or edited.
export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true })],
  server: { fs: { allow: ['..'] } },
  build: {
    outDir: 'standalone',
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 20000,
    reportCompressedSize: false,
  },
})
