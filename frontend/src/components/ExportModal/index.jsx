// ExportModal — escolhe formato (xlsx/csv) e escopo (com/sem histórico)
// antes de disparar o export no Controle de Processos v2.
import React, { useState } from 'react';
import { X, Download, FileSpreadsheet, FileText } from 'lucide-react';

export default function ExportModal({ open, onClose, totalProcessos, onExportar }) {
  const [formato, setFormato] = useState('xlsx'); // 'xlsx' | 'csv'
  const [conjunto, setConjunto] = useState('auditoria'); // 'filtrados' | 'auditoria' (padrão: TODOS)
  const [escopo, setEscopo] = useState('sem_historico'); // 'sem_historico' | 'com_historico'
  const [gerando, setGerando] = useState(false);
  const [progresso, setProgresso] = useState('');

  if (!open) return null;

  const handleExportar = async () => {
    setGerando(true);
    setProgresso('Preparando…');
    try {
      await onExportar({
        formato,
        conjunto,
        comHistorico: escopo === 'com_historico',
        onProgresso: setProgresso,
      });
      onClose();
    } catch (err) {
      alert(err?.message || 'Falha ao exportar.');
    } finally {
      setGerando(false);
      setProgresso('');
    }
  };

  return (
    <div
      className="cpv2-modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="cpv2-modal" style={{ width: 'min(520px, 95vw)' }}>
        <div className="cpv2-modal__head">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} /> Exportar {totalProcessos} processo(s)
          </h3>
          <button
            type="button"
            className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
            onClick={onClose}
            disabled={gerando}
          >
            <X size={12} />
          </button>
        </div>
        <div className="cpv2-modal__body cpv2-export-body">
          {/* Conjunto de dados */}
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>
              Conjunto de dados
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label
                className={`cpv2-radio-card cpv2-radio-card--wide ${conjunto === 'auditoria' ? 'cpv2-radio-card--sel' : ''}`}
              >
                <input type="radio" name="conjunto" value="auditoria" checked={conjunto === 'auditoria'} onChange={() => setConjunto('auditoria')} />
                <div>
                  <div style={{ fontWeight: 600 }}>Todos os processos (relatório completo)</div>
                  <div style={{ fontSize: 10.5, color: 'var(--cpv2-text-muted)' }}>
                    TODOS os processos do sistema, ignorando a etapa/filtros da tela. Gera 3 abas:
                    Resumo, Financeiro (devoluções) e Detalhado (todos os campos do banco).
                  </div>
                </div>
              </label>
              <label
                className={`cpv2-radio-card cpv2-radio-card--wide ${conjunto === 'filtrados' ? 'cpv2-radio-card--sel' : ''}`}
              >
                <input type="radio" name="conjunto" value="filtrados" checked={conjunto === 'filtrados'} onChange={() => setConjunto('filtrados')} />
                <div>
                  <div style={{ fontWeight: 600 }}>Somente a tela atual (etapa/filtros)</div>
                  <div style={{ fontSize: 10.5, color: 'var(--cpv2-text-muted)' }}>
                    Só os processos da etapa/filtros abertos agora — não é o relatório geral.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Formato */}
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>
              Formato do arquivo
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <label
                className={`cpv2-radio-card ${formato === 'xlsx' ? 'cpv2-radio-card--sel' : ''}`}
              >
                <input
                  type="radio"
                  name="formato"
                  value="xlsx"
                  checked={formato === 'xlsx'}
                  onChange={() => setFormato('xlsx')}
                />
                <FileSpreadsheet size={16} />
                <span>Excel (.xlsx)</span>
              </label>
              <label
                className={`cpv2-radio-card ${formato === 'csv' ? 'cpv2-radio-card--sel' : ''}`}
              >
                <input
                  type="radio"
                  name="formato"
                  value="csv"
                  checked={formato === 'csv'}
                  onChange={() => setFormato('csv')}
                />
                <FileText size={16} />
                <span>CSV (.csv)</span>
              </label>
            </div>
          </div>

          {/* Escopo */}
          <div>
            <div style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 6 }}>
              Incluir histórico do processo?
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <label
                className={`cpv2-radio-card cpv2-radio-card--wide ${escopo === 'sem_historico' ? 'cpv2-radio-card--sel' : ''}`}
              >
                <input
                  type="radio"
                  name="escopo"
                  value="sem_historico"
                  checked={escopo === 'sem_historico'}
                  onChange={() => setEscopo('sem_historico')}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>Sem histórico</div>
                  <div style={{ fontSize: 10.5, color: 'var(--cpv2-text-muted)' }}>
                    1 linha por processo (mais rápido)
                  </div>
                </div>
              </label>
              <label
                className={`cpv2-radio-card cpv2-radio-card--wide ${escopo === 'com_historico' ? 'cpv2-radio-card--sel' : ''}`}
              >
                <input
                  type="radio"
                  name="escopo"
                  value="com_historico"
                  checked={escopo === 'com_historico'}
                  onChange={() => setEscopo('com_historico')}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>Com histórico completo</div>
                  <div style={{ fontSize: 10.5, color: 'var(--cpv2-text-muted)' }}>
                    2 abas/arquivos: processos + todas as movimentações
                  </div>
                </div>
              </label>
            </div>
          </div>

          {gerando && (
            <div style={{ fontSize: 11, color: 'var(--cpv2-text-muted)', fontStyle: 'italic' }}>
              {progresso || 'Gerando arquivo…'}
            </div>
          )}
        </div>
        <div className="cpv2-modal__footer">
          <button
            type="button"
            className="cpv2-btn cpv2-btn--ghost cpv2-btn--sm"
            onClick={onClose}
            disabled={gerando}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="cpv2-btn cpv2-btn--primary cpv2-btn--sm"
            onClick={handleExportar}
            disabled={gerando}
          >
            {gerando ? 'Gerando…' : 'Gerar arquivo'}
          </button>
        </div>
      </div>
    </div>
  );
}
