import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = process.env.PIKA_EDITOR_SERVER_URL ?? 'http://127.0.0.1:3080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/timeline':  SERVER,
      '/comments':  SERVER,
      '/comment':   SERVER,
      '/beats':     SERVER,
      '/asset':     SERVER,
      '/library':   SERVER,
      '/project':   SERVER,
      '/projects':  SERVER,
      '/scenes':    SERVER,
      '/clips':     SERVER,
      '/render':    SERVER,
      '/renders':   SERVER,
      '/versions':  SERVER,
      '/upload':    SERVER,
      '/reveal':    SERVER,
      '/sfx':       SERVER,
      '/music':     SERVER,
      '/workspace': SERVER,
      '/plan':      SERVER,
      '/captions':  { target: SERVER, timeout: 600_000, proxyTimeout: 600_000 },
      '/pika':      SERVER,
      '/chat':      { target: SERVER, ws: false, changeOrigin: false },
      '/oauth':     SERVER,
      '/agent':     SERVER,
      '/presets':   SERVER,
      '/voice':     SERVER,
      '/events':    { target: SERVER, ws: false, changeOrigin: false },
    },
  },
});
