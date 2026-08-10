import { defineConfig } from 'vite';

// GitHub Pages: https://leeyohan-sys.github.io/loopton/
export default defineConfig({
  // 안드로이드(예: Capacitor WebView)처럼 "로컬에선 /loopton 경로가 없을 때"
  // 상대 경로로 빌드하려면 VITE_BASE=./ 로 빌드하세요.
  base: process.env.VITE_BASE ?? '/loopton/',
  server: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
  },
});
