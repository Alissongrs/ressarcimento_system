import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'

export default defineConfig({
  plugins: [react()],
  cacheDir: 'node_modules/.vite_theme_fix',
  build: {
    rollupOptions: {
      input: 'index.html'
    }
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        secure: false,
      },
      '/api/v1': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        secure: false,
      },
      '/bi': {
        target: 'http://localhost:5001',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/bi/, ''),
      },
    },
  },
  resolve: {
    alias: [
      // Project aliases
      { find: '@components', replacement: path.resolve(__dirname, 'src/components') },
      { find: '@hooks', replacement: path.resolve(__dirname, 'src/hooks') },
      { find: '@lib', replacement: path.resolve(__dirname, 'src/lib') },
      { find: '@context', replacement: path.resolve(__dirname, 'src/context') },
      { find: '@services', replacement: path.resolve(__dirname, 'src/services') },
      // Garantir que qualquer referência a 'api' aponte para apiClient
      { find: '@services/api', replacement: path.resolve(__dirname, 'src/services/apiClient.js') },
      { find: '@/services/api', replacement: path.resolve(__dirname, 'src/services/apiClient.js') },
      { find: 'src/services/api', replacement: path.resolve(__dirname, 'src/services/apiClient.js') },
      { find: '@', replacement: path.resolve(__dirname, 'src') },
    ],
    // Ensure single React instance if libraries import it
    dedupe: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  },
  css: {
    postcss: {
      plugins: [
        tailwindcss(),
        autoprefixer(),
      ]
    }
  }
  ,
  optimizeDeps: {
    force: true
  }
})
