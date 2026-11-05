import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// SURE no celular: servido em https://sure.app.br/m/ (mesma origem do site → mesmo login).
// Em desenvolvimento (npm run dev) as chamadas /api vão para o backend local.
export default defineConfig({
  base: '/m/',
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { '/api': 'http://localhost:8080' },
  },
  build: { outDir: 'dist', sourcemap: false },
});
