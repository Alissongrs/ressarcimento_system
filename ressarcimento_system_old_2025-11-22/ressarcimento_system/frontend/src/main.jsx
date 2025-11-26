// src/main.jsx

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './index.css';
import { AuthProvider } from './context/AuthContext.jsx';
import { Tooltip } from 'react-tooltip'; // 1. IMPORTE O COMPONENTE TOOLTIP

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
      {/* 2. ADICIONE O COMPONENTE TOOLTIP AQUI, FORA DO APP */}
      <Tooltip /> 
    </AuthProvider>
  </React.StrictMode>,
);

