import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  base: process.env.PIXELGATE_BASE || './',
  plugins: [
    react(),
    {
      name: 'pixelgate-signaling-policy',
      transformIndexHtml(html) {
        const configured = process.env.VITE_PIXELGATE_SIGNAL_URL;
        if (!configured) return html;
        const url = new URL(configured);
        if (
          url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(url.hostname)
          )
        )
          throw new Error('Pairing service must use HTTPS.');
        const socketOrigin = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
        return html.replace(
          "connect-src 'self' https://0.peerjs.com wss://0.peerjs.com",
          `connect-src 'self' ${url.origin} ${socketOrigin}`,
        );
      },
    },
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('.', import.meta.url)) } },
  build: { target: 'es2022' },
});
