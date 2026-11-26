// Página "Relatórios" (/relatorios): lista os relatórios do SURE; cada um abre em tela inteira.
import React, { useState } from 'react';
import { FileSpreadsheet, ChevronRight } from 'lucide-react';
import RelatorioPriorizacaoModal from '../components/RelatorioPriorizacaoModal.jsx';
import './controleProcessosV2.css';

const RELATORIOS = [
  {
    id: 'priorizacao',
    titulo: 'Priorização de casos deferidos',
    descricao: 'Todos os deferidos com prioridade (estrelas), comprovante de depósito, data estimada e data prevista. Enviado no fim de cada mês.',
  },
];

export default function RelatoriosLista() {
  // a rota /relatorios só existe para gestor e admin (App.jsx), que são quem marca estrelas e datas
  const podeEditar = true;
  const [aberto, setAberto] = useState(null);

  return (
    <div className="cpv2-root" style={{ padding: '20px 24px', minHeight: 'auto' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>Relatórios</h2>
      <p style={{ margin: '0 0 16px', color: 'var(--cpv2-text-muted)' }}>Clique em um relatório para abrir.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {RELATORIOS.map((r) => (
          <button key={r.id} type="button" onClick={() => setAberto(r.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 14, textAlign: 'left', cursor: 'pointer',
              background: 'var(--cpv2-surface)', border: '1px solid var(--cpv2-border)', borderRadius: 10,
              padding: '14px 16px', color: 'var(--cpv2-text)',
            }}>
            <FileSpreadsheet size={22} color="var(--cpv2-brand)" />
            <span style={{ flex: 1 }}>
              <span style={{ display: 'block', fontWeight: 600, fontSize: 14 }}>{r.titulo}</span>
              <span style={{ display: 'block', fontSize: 12, color: 'var(--cpv2-text-muted)' }}>{r.descricao}</span>
            </span>
            <ChevronRight size={18} />
          </button>
        ))}
      </div>
      <RelatorioPriorizacaoModal isOpen={aberto === 'priorizacao'} onClose={() => setAberto(null)} podeEditar={podeEditar} />
    </div>
  );
}
