import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './estilo.css';

createRoot(document.getElementById('root')).render(<App />);

// service worker: deixa o SURE instalável ("Adicionar à tela inicial") e abre sem internet
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).catch(() => {}); });
}
