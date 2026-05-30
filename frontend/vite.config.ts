import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // SPA ルーティング用：/dashboard や /account-config など任意のパスへの
    // 直アクセス・リフレッシュ時も index.html を返してクライアントルーターに委譲する
    historyApiFallback: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true
      }
    }
  },
  build: {
    target: 'es2020',
    // Wasm バイナリをインライン化せず別ファイルとして配置する
    assetsInlineLimit: 0
  }
});
