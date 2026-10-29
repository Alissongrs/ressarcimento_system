// TabAnexos — lista + upload, com seção separada de Fatura
import React, { useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, FileText, ExternalLink, Trash2 } from 'lucide-react';
import { uploadAnexo, deleteAnexo } from '../../services/processoV2Service.js';
import { fmtDataBR as fmtData } from '../../utils/dateBR.js';

function fmtBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function extIcon(mime, nome) {
  const ext = (nome || '').split('.').pop()?.toUpperCase().slice(0, 4) || '';
  if (mime?.includes('pdf')) return 'PDF';
  if (mime?.includes('sheet') || ext === 'XLSX' || ext === 'CSV') return 'XLS';
  if (mime?.includes('word') || ext === 'DOC' || ext === 'DOCX') return 'DOC';
  if (mime?.includes('image')) return 'IMG';
  return ext || 'FILE';
}

export default function TabAnexos({ itens, isLoading, idProcesso, linkFatura, onToast }) {
  const qc = useQueryClient();
  const fileRef = useRef(null);

  const onPickFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      await uploadAnexo(idProcesso, file, '');
      onToast?.({
        open: true,
        type: 'success',
        text: 'Anexo enviado com sucesso.',
      });
      qc.invalidateQueries({ queryKey: ['v2', 'anexos', idProcesso] });
      qc.invalidateQueries({ queryKey: ['v2', 'processo', idProcesso] });
    } catch (err) {
      onToast?.({
        open: true,
        type: 'error',
        text: err?.message || 'Falha ao enviar anexo.',
      });
    }
  };

  const onDelete = async (anexoId) => {
    if (!window.confirm('Excluir este anexo?')) return;
    try {
      await deleteAnexo(idProcesso, anexoId);
      onToast?.({ open: true, type: 'success', text: 'Anexo excluído.' });
      qc.invalidateQueries({ queryKey: ['v2', 'anexos', idProcesso] });
      qc.invalidateQueries({ queryKey: ['v2', 'processo', idProcesso] });
    } catch (err) {
      onToast?.({
        open: true,
        type: 'error',
        text: err?.message || 'Falha ao excluir anexo.',
      });
    }
  };

  return (
    <>
      {/* ─── Fatura ─────────────────────────────────────────── */}
      <div className="cpv2-section-title">Fatura</div>
      {linkFatura ? (
        <div className="cpv2-anexo-list">
          <div className="cpv2-anexo">
            <div className="cpv2-anexo__icon">
              <FileText size={14} />
            </div>
            <div className="cpv2-anexo__info">
              <div className="cpv2-anexo__name">Fatura da unidade</div>
              <div className="cpv2-anexo__meta" style={{ wordBreak: 'break-all' }}>
                {linkFatura}
              </div>
            </div>
            <a
              className="cpv2-btn cpv2-btn--sm cpv2-btn--ghost"
              href={linkFatura}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={11} /> Abrir
            </a>
          </div>
        </div>
      ) : (
        <div className="cpv2-empty">
          <p>Nenhuma fatura vinculada a esta requisição.</p>
        </div>
      )}

      {/* ─── Anexos do processo ─────────────────────────────── */}
      <div className="cpv2-section-title" style={{ marginTop: 18 }}>Anexos do processo</div>
      {isLoading && (
        <div className="cpv2-empty">
          <h4>Carregando…</h4>
        </div>
      )}
      {!isLoading && itens.length === 0 && (
        <div className="cpv2-empty">
          <h4>Nenhum anexo</h4>
          <p>Adicione documentos vinculados ao processo.</p>
        </div>
      )}
      {!isLoading && itens.length > 0 && (
        <div className="cpv2-anexo-list">
          {itens.map((a) => (
            <div className="cpv2-anexo" key={a.id_anexo}>
              <div className="cpv2-anexo__icon">
                {extIcon(a.mime_type, a.nome_arquivo)}
              </div>
              <div className="cpv2-anexo__info">
                <div className="cpv2-anexo__name">{a.nome_arquivo}</div>
                <div className="cpv2-anexo__meta">
                  {fmtBytes(a.tamanho_bytes)} · {fmtData(a.uploaded_at)}
                  {a.uploaded_by?.nome ? ` · ${a.uploaded_by.nome}` : ''}
                </div>
              </div>
              {a.url_download && a.url_download !== '#' && (
                <a
                  className="cpv2-btn cpv2-btn--sm cpv2-btn--ghost"
                  href={a.url_download}
                  target="_blank"
                  rel="noreferrer"
                >
                  Abrir
                </a>
              )}
              <button
                type="button"
                className="cpv2-btn cpv2-btn--sm cpv2-btn--ghost"
                onClick={() => onDelete(a.id_anexo)}
                title="Excluir anexo"
                style={{ color: 'var(--cpv2-danger)' }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 14, textAlign: 'center' }}>
        <input
          ref={fileRef}
          type="file"
          style={{ display: 'none' }}
          onChange={onPickFile}
        />
        <button
          type="button"
          className="cpv2-btn"
          onClick={() => fileRef.current?.click()}
        >
          <Plus size={13} /> Adicionar anexo
        </button>
      </div>
    </>
  );
}
