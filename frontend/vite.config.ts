import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { defineConfig } from 'vite'

// In development the backend runs separately (cargo run); proxy API calls to it.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9120',
        changeOrigin: true,
        // Container terminals are WebSockets. The backend checks their Origin
        // against the host, which changeOrigin rewrites, so pass the original.
        ws: true,
        configure: (proxy) => proxy.on('proxyReqWs', (req, incoming) => req.setHeader('x-forwarded-host', incoming.headers.host ?? '')),
      },
    },
  },
})
