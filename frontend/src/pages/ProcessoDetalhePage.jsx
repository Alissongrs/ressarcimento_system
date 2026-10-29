// src/pages/ProcessoDetalhePage.jsx
// Rota dedicada de detalhe do processo (/processos-v2/:id).
// Reaproveita o ProcessoDrawer em modo inline (sem portal/backdrop).

import React, { useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import ProcessoDrawer from '../components/ProcessoDrawer/index.jsx';
import MovimentarModal from '../components/ProcessoDrawer/MovimentarModal.jsx';
import Toast from '../components/Toast.jsx';
import './controleProcessosV2.css';

export default function ProcessoDetalhePage() {
  const { id } = useParams();
  // ?aba=historico (aviso do sininho abre direto no histórico, onde fica o quadro de protocolos ANEEL)
  const [params] = useSearchParams();
  const abaUrl = params.get('aba') || 'resumo';
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const idProcesso = Number(id);
  const [movProc, setMovProc] = useState(null);
  const [toast, setToast] = useState({ open: false, type: 'info', text: '' });

  const voltar = () => {
    if (window.history.length > 1) navigate(-1);
    else navigate('/controle-processos-v2');
  };

  const onMoverSucesso = (idProc) => {
    setMovProc(null);
    setToast({ open: true, type: 'success', text: 'Movimentação salva com sucesso.' });
    queryClient.invalidateQueries({ queryKey: ['v2', 'processo', idProc] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'processos'] });
    // Atualiza automaticamente as abas do drawer (sem precisar recarregar a página).
    queryClient.invalidateQueries({ queryKey: ['v2', 'historico', idProc] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'anexos', idProc] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'deferimento', idProc] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'faturamento', idProc] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'repasse', idProc] });
    queryClient.invalidateQueries({ queryKey: ['v2', 'encerramento', idProc] });
  };
  const onMoverErro = (err) => {
    setToast({
      open: true,
      type: 'error',
      text: err?.message || 'Falha ao movimentar processo.',
    });
  };

  return (
    <div className="cpv2-root">
      <main className="cpv2-page">
        <header className="cpv2-page-header" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            type="button"
            className="cpv2-btn"
            onClick={voltar}
            title="Voltar à lista"
          >
            <ArrowLeft size={14} />
            Voltar
          </button>
          <div>
            <h1 className="cpv2-title" style={{ margin: 0 }}>Processo #{idProcesso}</h1>
            <p className="cpv2-sub" style={{ margin: 0 }}>Detalhe completo</p>
          </div>
        </header>

        <ProcessoDrawer
          key={`${idProcesso}:${abaUrl}`}
          inline
          idProcesso={idProcesso}
          abaInicial={abaUrl}
          onMovimentar={(proc) => setMovProc(proc)}
          onToast={(t) => setToast(t)}
        />
      </main>

      {movProc && (
        <MovimentarModal
          processo={movProc}
          onClose={() => setMovProc(null)}
          onSuccess={onMoverSucesso}
          onError={onMoverErro}
        />
      )}

      <Toast
        open={toast.open}
        type={toast.type}
        message={toast.text}
        onClose={() => setToast((t) => ({ ...t, open: false }))}
      />
    </div>
  );
}
