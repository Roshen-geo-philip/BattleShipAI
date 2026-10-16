import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.VITE_DEV_SERVER_PROXY ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/socket.io': { target: server, ws: true },
      '/api': { target: server },
    },
  },
});
