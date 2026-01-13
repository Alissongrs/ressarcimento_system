// src/pages/HistoricoFixed.jsx
import React, { useEffect, useMemo, useState } from 'react';
import { Search as SearchIcon, RefreshCcw, Download } from 'lucide-react';
import api from '../services/api';

// Resolve base absoluto para evitar URLs malformadas em dev
function getBackendOrigin() {
  // 1) Preferir variável explícita
  const env = (import.meta?.env?.VITE_BACKEND_ORIGIN || '').toString().trim();
  if (env) return env.replace(/\/$/, '');
  // 2) Usar mesmo host, porta 8080
  try {
    const { protocol, hostname } = window.location;
    return `${protocol}//${hostname}:8080`;
  } catch {
    return 'http://localhost:8080';
  }
}

function getAuthToken() {
  try {
    return (
      localStorage.getItem('userToken') ||
      localStorage.getItem('token') ||
      localStorage.getItem('auth_token') ||
      ''
    );
  } catch { return ''; }
}

// Helper seguro para strings de campos vindos do Go/DB
const extrair = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'String' in v) return v.Valid ? (v.String ?? '') : '';
  if (typeof v === 'object' && 'Value' in v) return v.Value ?? '';
  try { return String(v); } catch { return ''; }
};

// Normaliza um item do histórico em shape estável
function normalizeHistItem(it) {
  const data =
    it.data_movimentacao || it.data || it.created_at || it.updated_at || it.dt || null;

  return {
    id: it.id || it.historico_id || it.ID || `${Math.random()}`,
    processoId:
      it.processo_id || it.id_processo || it.requisicao_id || it.req_id || null,
    uc: extrair(it.uc) || extrair(it.unidade_consumidora) || '',
    cliente: extrair(it.cliente) || '',
    concessionaria: extrair(it.concessionaria) || extrair(it.dist) || '',
    etapa: extrair(it.etapa_atual) || extrair(it.etapa) || '',
    subEtapa: extrair(it.sub_etapa) || '',
    canais:
      Array.isArray(it.canais) ? it.canais.join(', ')
        : typeof it.canais === 'string' ? it.canais
        : '',
    comentario: extrair(it.comentario) || extrair(it.obs) || '',
    usuario: extrair(it.usuario) || extrair(it.usuario_nome) || '',
    data,
  };
}

export default function HistoricoFixed() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // filtros
  const [q, setQ] = useState('');
  const [fIni, setFIni] = useState('');
  const [fFim, setFFim] = useState('');
  const [fConcess, setFConcess] = useState('');
  const [fEtapa, setFEtapa] = useState('');
  const [fUC, setFUC] = useState('');
  const [fProc, setFProc] = useState('');

  useEffect(() => {
    let mounted = true;
    (async () => {
      setLoading(true);
      setError('');
      try {
        // tenta endpoint principal
        let data = [];
        const origin = getBackendOrigin();
        const token = getAuthToken();
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        // Tenta backend direto (evita problemas de proxy do Vite)
        try {
          const url = `${origin}/api/v1/historico?limit=2000`;
          const r = await fetch(url, { headers });
          if (r.ok) {
            const j = await r.json();
            data = Array.isArray(j) ? j : (Array.isArray(j?.data) ? j.data : []);
          } else {
            throw new Error(String(r.status));
          }
        } catch {
          // Fallback por alias de compat
          const url2 = `${origin}/api/v1/requisicoes/historico?limit=2000`;
          const r2 = await fetch(url2, { headers });
          if (r2.ok) {
            const j2 = await r2.json();
            data = Array.isArray(j2) ? j2 : (Array.isArray(j2?.data) ? j2.data : []);
          } else {
            // Último fallback: usar axios (caso proxy esteja correto)
            try {
              const ax = await api.get('/historico', { params: { limit: 2000 } });
              data = Array.isArray(ax?.data) ? ax.data : (Array.isArray(ax?.data?.data) ? ax.data.data : []);
            } catch {}
          }
        }
        const norm = (data || []).map(normalizeHistItem)
          .sort((a, b) => new Date(b.data || '1970-01-01') - new Date(a.data || '1970-01-01'));
        if (mounted) setRows(norm);
      } catch (e) {
        if (mounted) setError('Não foi possível carregar o histórico.');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Filtro aplicado em memória
  const filtered = useMemo(() => {
    const termo = q.trim().toLowerCase();
    const ini = fIni ? new Date(fIni + 'T00:00:00') : null;
    const fim = fFim ? new Date(fFim + 'T23:59:59') : null;
    return rows.filter((r) => {
      if (ini || fim) {
        const d = r.data ? new Date(r.data) : null;
        if (ini && d && d < ini) return false;
        if (fim && d && d > fim) return false;
      }
      if (fConcess && r.concessionaria.toLowerCase().indexOf(fConcess.trim().toLowerCase()) === -1) return false;
      if (fEtapa && r.etapa.toLowerCase().indexOf(fEtapa.trim().toLowerCase()) === -1) return false;
      if (fUC && String(r.uc).toLowerCase().indexOf(fUC.trim().toLowerCase()) === -1) return false;
      if (fProc && String(r.processoId || '').toLowerCase().indexOf(fProc.trim().toLowerCase()) === -1) return false;

      if (!termo) return true;
      const blob = [
        r.processoId, r.uc, r.cliente, r.concessionaria, r.etapa, r.subEtapa,
        r.canais, r.comentario, r.usuario, r.data,
      ].map((x) => (x == null ? '' : String(x))).join(' ').toLowerCase();
      return blob.includes(termo);
    });
  }, [rows, q, fIni, fFim, fConcess, fEtapa, fUC, fProc]);

  // Export CSV (itens filtrados)
  const handleExportCsv = () => {
    const headers = [
      'Processo ID', 'UC', 'Cliente', 'Concessionária', 'Etapa', 'Sub-etapa',
      'Canais', 'Comentário', 'Usuário', 'Data',
    ];
    const sep = ';';
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [headers.join(sep)];
    for (const r of filtered) {
      lines.push([
        esc(r.processoId),
        esc(r.uc),
        esc(r.cliente),
        esc(r.concessionaria),
        esc(r.etapa),
        esc(r.subEtapa),
        esc(r.canais),
        esc(r.comentario),
        esc(r.usuario),
        esc(r.data),
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
    <div className="p-6 text-red-400">
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
              placeholder="Busca livre… (comentário, cliente, UC, etapa, etc.)"
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
              onClick={() => { setQ(''); setFIni(''); setFFim(''); setFConcess(''); setFEtapa(''); setFUC(''); setFProc(''); }}
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

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-2">
          <input
            value={fConcess}
            onChange={(e) => setFConcess(e.target.value)}
            placeholder="Filtrar por concessionária…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
          <input
            value={fEtapa}
            onChange={(e) => setFEtapa(e.target.value)}
            placeholder="Filtrar por etapa…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
          <input
            value={fUC}
            onChange={(e) => setFUC(e.target.value)}
            placeholder="Filtrar por UC…"
            className="px-3 py-2 rounded border panel-border panel-bg-60"
          />
          <input
            value={fProc}
            onChange={(e) => setFProc(e.target.value)}
            placeholder="Filtrar por ID do processo…"
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
              <th className="px-2 py-2 border border-[var(--border)] text-left">Concessionária</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Etapa</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Sub-etapa</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Canais</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Comentário</th>
              <th className="px-2 py-2 border border-[var(--border)] text-left">Usuário</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <tr key={r.id} className="odd:bg-[rgba(255,255,255,0.02)]">
                <td className="px-2 py-1 border border-[var(--border)]">{r.data || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.processoId ?? '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.uc || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.cliente || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.concessionaria || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.etapa || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.subEtapa || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.canais || '-'}</td>
                <td className="px-2 py-1 border border-[var(--border)] max-w-[520px] whitespace-pre-wrap break-words">
                  {r.comentario || '-'}
                </td>
                <td className="px-2 py-1 border border-[var(--border)]">{r.usuario || '-'}</td>
              </tr>
            ))}
            {!filtered.length && (
              <tr>
                <td className="px-2 py-4 text-center opacity-70" colSpan={10}>
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

