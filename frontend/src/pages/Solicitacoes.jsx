// src/pages/Solicitacoes.jsx
// Tela de Solicitações ao sistema (pedidos feitos no chat).
// APROVAR é EXCLUSIVO do aprovador designado (Alisson) — quem não é, nem vê a fila.
import React from 'react';
import { Inbox, Lock } from 'lucide-react';
import SolicitacoesPanel from '../components/SolicitacoesPanel';
import { useAuth } from '../context/AuthContext.jsx';
import { ehAprovador as isAprovador } from '../services/solicitacoesService';

export default function Solicitacoes() {
  const { user } = useAuth();

  if (!isAprovador(user)) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <Lock size={28} style={{ color: 'var(--warning)', margin: '0 auto 12px' }} />
        <h1 className="text-lg font-bold mb-2">Acesso restrito</h1>
        <p className="text-sm opacity-70">
          A aprovação de solicitações é exclusiva do aprovador designado. Você pode fazer pedidos
          pelo chat e acompanhá-los nas abas do chat.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full px-4 md:px-6 py-6">
      <div className="flex items-center gap-2 mb-4">
        <Inbox size={20} style={{ color: 'var(--accent)' }} />
        <h1 className="text-xl font-extrabold tracking-tight">Solicitações ao sistema</h1>
      </div>
      <p className="text-sm opacity-70 mb-5">
        Pedidos feitos no chat. Revise e <b>aprove</b> para entrar na fila de execução,
        <b> copie</b> o texto, ou <b>delete</b>. Nada é executado sem sua aprovação.
      </p>
      <SolicitacoesPanel />
    </div>
  );
}
