// src/components/GlobalNewProcessNotifier.jsx
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { subscribeGlobal } from '../services/sseClient';
import NewProcessToast from './NewProcessToast.jsx';

export default function GlobalNewProcessNotifier() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [novoProc, setNovoProc] = useState(null);

  useEffect(() => {
    if (!user || user?.tipo_conta !== 'gestor') return;
    const token = localStorage.getItem('userToken');
    if (!token) return;
    const off = subscribeGlobal(token, (ev) => {
      if (!ev || ev.type !== 'requisicao_nova') return;
      const payload = ev.payload || {};
      setNovoProc({
        id: ev.processo_id,
        uc: payload.uc,
        cliente: payload.cliente,
        concessionaria: payload.concessionaria,
      });
    });
    return () => off && off();
  }, [user]);

  if (!user || user?.tipo_conta !== 'gestor') return null;

  return (
    <NewProcessToast
      open={!!novoProc}
      processo={novoProc}
      onClose={() => setNovoProc(null)}
      onView={() => {
        if (novoProc?.id) {
          navigate('/processos/');
          setNovoProc(null);
        }
      }}
    />
  );
}
