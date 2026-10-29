// src/pages/HistoricoFixed.jsx
// Tela /historico — consome /api/v2/historico (banco refatorado).
// Colunas: Data | Processo | UC | Cliente | Distribuidora | Instância | Etapa | Status | Aprovação | Comentário | Usuário | Ações
import React, { useEffect, useMemo, useState } from 'react';
import { Search as SearchIcon, RefreshCcw, Download } from 'lucide-react';

function getBackendOrigin() {
  const env = (import.meta?.env?.VITE_BACKEND_ORIGIN || '').toString().trim();
  if (env) return env.replace(/\/$/, '');
  try {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:8080`;
  } catch {
    return 'http://localhost:8080';
  }
}

function getAuthToken() {
  try {
    return localStorage.getItem('userToken') || '';
  } catch { return ''; }
}

const extrair = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'String' in v) return v.Valid ? (v.String ?? '') : '';
  if (typeof v === 'object' && 'Value' in v) return v.Value ?? '';
  try { return String(v); } catch { return ''; }
};

// Recebe item do /api/v2/historico (instancia/etapa/status/aprovacao são {id, nome} ou null)
function normalizeHistItem(it) {
  const refNome = (r) => (r && typeof r === 'object') ? (r.nome || '') : '';
  return {
    id: it.id_historico,
    processoId: it.processo_id,
    codigoPublico: it.codigo_publico || '',
    uc: extrair(it.uc),
    cliente: extrair(it.cliente),
    distribuidora: extrair(it.distribuidora),
    instancia: refNome(it.instancia) || '—',
    etapa: refNome(it.etapa) || '—',
    status: refNome(it.status) || '—',
    aprovacao: refNome(it.aprovacao) || '',
    tipoMovimentacao: it.tipo_movimentacao || '',
    comentario: extrair(it.comentario),
    mailGraphMessageId: extrair(it.mail_graph_message_id),
    usuario: it.usuario?.nome || '',
    data: it.data_movimentacao,
  };
}

function openMailShortcut(mailGraphMessageId) {
  const id = String(mailGraphMessageId || '').trim();
  if (!id) return;
  window.location.href = `/caixa-de-email?messageId=${encodeURIComponent(id)}`;
}

function fmtDateBR(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${dd}/${mm}/${yyyy} ${hh}:${mi}`;
  } catch { return iso; }
}

export default function HistoricoFixed() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [q, setQ] = useState('');
  const [fIni, setFIni] = useState('');
  const [fFim, setFFim] = useState('');
  const [fDist, setFDist] = useState('');
  const [fInstancia, setFInstancia] = useState('');
  const [fEtapa, setFEtapa] = useState('');
  const [fStatus, setFStatus] = useState('');
  const [fUC, setFUC] = useState('');
  const [fProc, setFProc] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const origin = getBackendOrigin();
        const token = getAuthToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const url = `${origin}/api/v2/historico?limit=2000`;
        const r = await fetch(url, { headers });
        if (!r.ok) {
          throw new Error(`HTTP ${r.status}`);
        }
        const j = await r.json();
        const data = Array.isArray(j?.items) ? j.items : [];
        const norm = data.map(normalizeHistItem)
          .sort((a, b) => new Date(b.data || '1970-01-01') - new Date(a.data || '1970-01-01'));
        if (mounted) setRows(norm);
      } catch (e) {
        if (mounted) setError(`Não foi possível carregar o histórico: ${e?.message || e}`);
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const filtered = useMemo(() => {
    const termo = q.trim().toLowerCase();
    const ini = fIni ? new Date(fIni + 'T00:00:00') : null;
    const fim = fFim ? new Date(fFim + 'T23:59:59') : null;
    const lc = (s) => String(s ?? '').toLowerCase();
    return rows.filter((r) => {
      if (ini || fim) {
        const d = r.data ? new Date(r.data) : null;
        if (ini && d && d < ini) return false;
        if (fim && d && d > fim) return false;
      }
      if (fDist && lc(r.distribuidora).indexOf(lc(fDist)) === -1) return false;
      if (fInstancia && lc(r.instancia).indexOf(lc(fInstancia)) === -1) return false;
      if (fEtapa && lc(r.etapa).indexOf(lc(fEtapa)) === -1) return false;
      if (fStatus && lc(r.status).indexOf(lc(fStatus)) === -1) return false;
      if (fUC && lc(r.uc).indexOf(lc(fUC)) === -1) return false;
      if (fProc && lc(r.processoId).indexOf(lc(fProc)) === -1) return false;

      if (!termo) return true;
      const blob = [
        r.processoId, r.codigoPublico, r.uc, r.cliente, r.distribuidora,
        r.instancia, r.etapa, r.status, r.aprovacao, r.comentario, r.usuario,
      ].map((x) => (x == null ? '' : String(x))).join(' ').toLowerCase();
      return blob.includes(termo);
    });
  }, [rows, q, fIni, fFim, fDist, fInstancia, fEtapa, fStatus, fUC, fProc]);

  const handleExportCsv = () => {
    const headers = [
      'Data', 'Processo', 'Código Público', 'UC', 'Cliente', 'Distribuidora',
      'Instância', 'Etapa', 'Status', 'Aprovação', 'Comentário', 'Usuário',
    ];
    const sep = ';';
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(sep)];
    for (const r of filtered) {
      lines.push([
        esc(fmtDateBR(r.data)),
        esc(r.processoId),
        esc(r.codigoPublico),
        esc(r.uc),
        esc(r.cliente),
        esc(r.distribuidora),
        esc(r.instancia),
        esc(r.etapa),
        esc(r.status),
        esc(r.aprovacao),
        esc(r.comentario),
        esc(r.usuario),
      ].join(sep));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `historico_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (loading) return <div className="p-6"><span className="sap-loading">Carregando histórico…</span></div>;
  if (error) return (
    <div className="p-6 text-[var(--danger)]">
      {error}
      <div className="mt-3">
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded border panel-border panel-bg-60"
        >
          <RefreshCcw size={16} /> Tentar novamente
        </button>
      </div>
    </div>
  );

  return (
    <div className="p-4 md:p-6">
      <div className="mb-3 flex flex-col gap-3">
        <h1 className="text-2xl font-extrabold">Histórico</h1>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
          <div className="flex items-center gap-2">
            <SearchIcon size={16} className="opacity-70" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Busca livre… (cliente, UC, comentário, etc.)"
              className="flex-1 px-3 py-2 rounded border panel-border panel-bg-60"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs opacity-70 min-w-16">Data inicial</span>
            <input
              type="date"
              value={fIni}
              onChange={(e) => setFIni(e.target.value)}
              className="flex-1 px-3 py-2 rounded border panel-border panel-bg-60"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs opacity-70 min-w-16">Data final</span>
            <input
              type="date"
              value={fFim}
              onChange={(e) => setFFim(e.target.value)}
              className="flex-1 px-3 py-2 rounded border panel-border panel-bg-60"
            />
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setQ(''); setFIni(''); setFFim(''); setFDist('');
                setFInstancia(''); setFEtapa(''); setFStatus('');
                setFUC(''); setFProc('');
              }}
              className="px-3 py-2 rounded border panel-border panel-bg-60"
              title="Limpar filtros"
            >
              <RefreshCcw size={16} />
            </button>
            <button
              onClick={handleExportCsv}
              className="px-3 py-2 rounded bg-[var(--accent)] text-[var(--fg)] flex items-center gap-2"
              title="Exportar CSV"
            >
              <Download size={16} /> Exportar
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-2">
          <input
            value={fDist}
            onChange={(e) => setFDist(e.target.value)}
            placeholder="Distribuidora…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
          <input
            value={fInstancia}
            onChange={(e) => setFInstancia(e.target.value)}
            placeholder="Instância (Distribuidora/Ouvidoria/ANEEL/SMA)…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
          <input
            value={fEtapa}
            onChange={(e) => setFEtapa(e.target.value)}
            placeholder="Etapa (Reclamação/Conciliação/…)…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
          <input
            value={fStatus}
            onChange={(e) => setFStatus(e.target.value)}
            placeholder="Status…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
          <input
            value={fUC}
            onChange={(e) => setFUC(e.target.value)}
            placeholder="UC…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
          <input
            value={fProc}
            onChange={(e) => setFProc(e.target.value)}
            placeholder="ID do processo…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
        </div>
      </div>

      <div className="border border-dashed border-[var(--border)] rounded-md overflow-auto">
        <table className="min-w-full text-[12px] border-collapse">
          <thead className="bg-[var(--panel-processos)]/60 sticky top-0">
            <tr>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Data</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Processo</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">UC</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Cliente</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Distribuidora</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Instância</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Etapa</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Status</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Aprovação</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Comentário</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Usuário</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Ações</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="odd:bg-[rgba(255,255,255,0.02)]">
                <td className="px-2 py-1 border border-[var(--border)] whitespace-nowrap">{fmtDateBR(r.data) || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.codigoPublico || r.processoId || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.uc || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.cliente || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.distribuidora || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.instancia}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.etapa}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.status}</td>
                <td className="px-2 py-1 border border-[var(--border)]">
                  {r.aprovacao ? (
                    <span className={`px-1.5 py-0.5 rounded text-[11px] ${
                      r.aprovacao === 'Deferido' ? 'bg-[color-mix(in_srgb,var(--success)_20%,transparent)] text-[var(--success)]' :
                      r.aprovacao === 'Indeferido' ? 'bg-[color-mix(in_srgb,var(--danger)_20%,transparent)] text-[var(--danger)]' : ''
                    }`}>
                      {r.aprovacao}
                    </span>
                  ) : '-'}
                </td>
                <td className="px-2 py-1 border border-[var(--border)] max-w-[480px] whitespace-pre-wrap break-words">
                  {r.comentario || '-'}
                </td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.usuario || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">
                  {r.mailGraphMessageId ? (
                    <button
                      type="button"
                      onClick={() => openMailShortcut(r.mailGraphMessageId)}
                      className="px-2 py-1 rounded border panel-border panel-bg-60 hover:bg-[var(--hover)] text-[11px]"
                    >
                      Abrir e-mail
                    </button>
                  ) : (
                    '-'
                  )}
                </td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td className="px-2 py-4 text-center opacity-70" colSpan={12}>
                  Nenhum registro encontrado com os filtros atuais.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
