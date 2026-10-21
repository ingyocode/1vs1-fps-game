import { defineConfig } from 'vite';

// base: './' keeps every asset path relative so the build can be dropped on any
// free static host (GitHub Pages, Cloudflare Pages, Netlify, itch.io) as-is.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: {
    host: true,
    port: 5173,
  },
});
