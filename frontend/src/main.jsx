// src/main.jsx

import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App.jsx';
import './index.css';
import { AuthProvider } from './context/AuthContext.jsx';
import { Tooltip } from 'react-tooltip'; // 1. IMPORTE O COMPONENTE TOOLTIP

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <App />
        {/* 2. ADICIONE O COMPONENTE TOOLTIP AQUI, FORA DO APP */}
        <Tooltip />
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

