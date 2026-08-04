import { defineConfig } from 'vite';

// GitHub Pages: https://leeyohan-sys.github.io/loopton/
export default defineConfig({
  base: '/loopton/',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
  },
});
