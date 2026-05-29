import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            // ローカル開発では Cookie をバックエンドに転送しない
            // （認証テストのため意図的に未認証で通す場合があるため）
            proxyReq.removeHeader('cookie');
          });
        }
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.removeHeader('cookie');
          });
          proxy.on('proxyReqWs', (proxyReq) => {
            proxyReq.removeHeader('cookie');
          });
        }
      }
    }
  },
  build: {
    target: 'es2020',
    // Wasm バイナリをインライン化せず別ファイルとして配置する
    assetsInlineLimit: 0
  }
});
