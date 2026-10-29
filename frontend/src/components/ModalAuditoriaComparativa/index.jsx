// src/components/ModalAuditoriaComparativa/index.jsx
//
// Modal "Auditoria comparativa" (fullscreen) — 3 colunas FDE / Sgeeasy / IA
// + validação por coluna + input manual + PDF + rejeitar apontamento.
// Grava decisões diretas na FATURA_DADOS_EXTRAIDOS via /validar-comparativo.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, FileText, Database, Bot, AlertTriangle, CheckCircle, HelpCircle, Save, ExternalLink,
} from 'lucide-react';
import apiClient from '../../services/apiClient';

const fmtNum = (v, dec = 0) => {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString('pt-BR', { minimumFractionDigits: dec, maximumFractionDigits: dec });
};
const fmtBRL = (v) => (v == null || v === '' ? '—' : `R$ ${fmtNum(v, 2)}`);
const macroCor = (m) => (m === 'SEM ERRO' ? 'var(--cpv2-success)' : m === 'ERRO CONFIRMADO' ? 'var(--cpv2-danger)' : 'var(--cpv2-warning)');
const statusIcone = (s) => {
  if (s === 'ok') return <CheckCircle size={14} style={{ color: 'var(--cpv2-success)' }} />;
  if (s === 'diverge') return <AlertTriangle size={14} style={{ color: 'var(--cpv2-danger)' }} />;
  return <HelpCircle size={14} style={{ color: 'var(--cpv2-warning)' }} />;
};

// Mapeia rótulos do modal para as colunas reais da FATURA_DADOS_EXTRAIDOS (usado
// pelo endpoint /validar-comparativo — colunas com whitelist no backend).
const CAMPOS = [
  { label: 'Consumo ponta',      col: 'consumo_ativo_ponta_kwh',     tipo: 'kwh', fde: 'consumo_ativo_ponta_kwh',     sge: 'KWH_Ponta',       ia: 'consumo_ponta_kwh' },
  { label: 'Consumo f-ponta',    col: 'consumo_ativo_fponta_kwh',    tipo: 'kwh', fde: 'consumo_ativo_fponta_kwh',    sge: 'KWH_FPonta',      ia: 'consumo_fponta_kwh' },
  { label: 'Consumo reservado',  col: 'consumo_ativo_reservado_kwh', tipo: 'kwh', fde: 'consumo_ativo_reservado_kwh', sge: 'KWH_Reservado',   ia: 'consumo_reservado_kwh' },
  { label: 'Valor total',        col: 'valor_total_fatura',          tipo: 'brl', fde: 'valor_total_fatura',          sge: 'RS_Total_Fatura', ia: 'valor_total_brl' },
  { label: 'ICMS',               col: 'icms_valor',                  tipo: 'brl', fde: 'icms_valor',                  sge: 'ICMS_RS',         ia: 'icms_brl' },
  { label: 'PIS',                col: 'pis_valor',                   tipo: 'brl', fde: 'pis_valor',                   sge: 'PIS_RS',          ia: 'pis_brl' },
  { label: 'COFINS',             col: 'cofins_valor',                tipo: 'brl', fde: 'cofins_valor',                sge: 'COFINS_RS',       ia: 'cofins_brl' },
  { label: 'Modalidade',         col: 'modalidade_tarifaria',        tipo: 'str', fde: 'modalidade_tarifaria',        sge: 'Modalidade_Tarifaria', ia: 'modalidade_tarifaria' },
  { label: 'Nº medidor',         col: 'numero_medidor',              tipo: 'str', fde: 'numero_medidor',              sge: 'NroMedidor',      ia: 'numero_medidor' },
];

const fmtCampo = (v, tipo, decs = 0) => {
  if (v == null || v === '') return '—';
  if (tipo === 'kwh') return fmtNum(v, decs) + ' kWh';
  if (tipo === 'brl') return fmtBRL(v);
  return String(v);
};

export default function ModalAuditoriaComparativa({
  isOpen, onClose, faturaId, onGerarRequisicao,
  ressarcimentoEstimado, desvioPctMax, valorEnergiaAtiva, linkFatura,
}) {
  const [loading, setLoading] = useState(false);
  const [erro, setErro] = useState('');
  const [data, setData] = useState(null);

  // Estado de validação — por campo, guarda qual fonte foi escolhida ('FDE'|'SGE'|'IA'|'MANUAL')
  const [escolhas, setEscolhas] = useState({}); // { col: 'SGE' }
  const [manuais, setManuais] = useState({});   // { col: '22922' }
  const [observacao, setObservacao] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [salvarErro, setSalvarErro] = useState('');
  const [salvarOk, setSalvarOk] = useState('');
  const [rejeitando, setRejeitando] = useState(false);

  useEffect(() => {
    if (!isOpen || !faturaId) return;
    setLoading(true);
    setErro(''); setData(null);
    setEscolhas({}); setManuais({}); setObservacao('');
    setSalvarErro(''); setSalvarOk('');
    const body = {
      ressarcimento_estimado: Number.isFinite(ressarcimentoEstimado) ? ressarcimentoEstimado : undefined,
      desvio_pct_max: Number.isFinite(desvioPctMax) ? desvioPctMax : undefined,
      valor_energia_ativa: Number.isFinite(valorEnergiaAtiva) ? valorEnergiaAtiva : undefined,
    };
    apiClient
      .post(`/api/v1/faturas/${faturaId}/auditar-comparativo`, body)
      .then((res) => setData(res.data))
      .catch((e) => setErro(e?.response?.data?.error || e?.message || 'Falha ao auditar.'))
      .finally(() => setLoading(false));
  }, [isOpen, faturaId, ressarcimentoEstimado, desvioPctMax, valorEnergiaAtiva]);

  const valorPor = (campo, fonte) => {
    if (!data) return null;
    if (fonte === 'FDE') return data.fde?.[campo.fde];
    if (fonte === 'SGE') return data.sgeeasy?.[campo.sge];
    if (fonte === 'IA')  return data.ia?.[campo.ia];
    if (fonte === 'MANUAL') return manuais[campo.col];
    return null;
  };

  const marcarEscolha = (campo, fonte) => setEscolhas((p) => ({ ...p, [campo.col]: fonte }));

  const nValidados = useMemo(() => Object.keys(escolhas).length, [escolhas]);

  const salvarValidacao = () => {
    if (salvando || !nValidados) return;
    setSalvando(true); setSalvarErro(''); setSalvarOk('');
    const campos_validados = Object.entries(escolhas).map(([col, fonte]) => {
      const campo = CAMPOS.find((c) => c.col === col);
      const valor_escolhido = valorPor(campo, fonte);
      return { campo: col, valor_escolhido, fonte };
    }).filter((x) => x.valor_escolhido !== null && x.valor_escolhido !== '' && x.valor_escolhido !== undefined);
    apiClient
      .post(`/api/v1/faturas/${faturaId}/validar-comparativo`, { campos_validados, observacao })
      .then((res) => {
        setSalvarOk(`✓ ${res.data?.campos_aplicados || campos_validados.length} campo(s) atualizado(s) na FDE.`);
        setEscolhas({});
      })
      .catch((e) => setSalvarErro(e?.response?.data?.error || e?.message || 'Falha ao salvar.'))
      .finally(() => setSalvando(false));
  };

  const rejeitarApontamento = () => {
    const motivo = window.prompt('Motivo da rejeição (falso positivo):');
    if (motivo == null) return;
    setRejeitando(true);
    apiClient.post(`/api/v1/faturas/${faturaId}/rejeitar-apontamento`, { motivo })
      .then(() => { onClose(); })
      .catch((e) => window.alert(e?.response?.data?.error || 'Falha ao rejeitar.'))
      .finally(() => setRejeitando(false));
  };

  if (!isOpen) return null;

  const linkPDF = linkFatura || data?.fde?.link_fatura || data?.fde?.link || null;

  const modal = (
    <div className="cpv2-root">
      <div
        className="cpv2-modal-backdrop"
        onClick={onClose}
        style={{ zIndex: 200, padding: 0, alignItems: 'stretch', justifyContent: 'stretch' }}
      >
        <div
          className="cpv2-modal"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
          style={{
            width: '100vw', maxWidth: '100vw', height: '100vh', maxHeight: '100vh',
            borderRadius: 0, margin: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }}
        >
          <div className="cpv2-modal__head">
            <div>
              <h3>🔍 Auditoria comparativa</h3>
              <p>
                {data
                  ? `Fatura #${data.fatura_id} · UC ${data.uc || '—'} · ${data.mes_referencia || '—'} · ${data.concessionaria || '—'}`
                  : `Fatura #${faturaId}`}
              </p>
            </div>
            <button className="cpv2-modal__close" onClick={onClose} title="Fechar (Esc)">
              <X size={18} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
            {loading && <div className="cpv2-empty" style={{ padding: 30 }}><span className="sap-loading">Consultando FDE + sgeeasy + IA…</span></div>}
            {erro && <div className="cpv2-empty cpv2-empty--error">{erro}</div>}

            {data && (
              <>
                {/* Header das 3 colunas + tabela de campos */}
                <div style={{
                  border: '1px solid var(--cpv2-border)', borderRadius: 10, overflow: 'hidden',
                  background: 'var(--cpv2-surface)', marginBottom: 14,
                }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1.2fr', gap: 0, background: 'var(--cpv2-surface-2)', padding: '10px 12px', fontSize: 12, fontWeight: 700, borderBottom: '1px solid var(--cpv2-border)' }}>
                    <div>Campo</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent)' }}>
                      <FileText size={14} /> FDE (fatura)
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent-2)' }}>
                      <Database size={14} /> Sgeeasy
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent-3)' }}>
                      <Bot size={14} /> IA {data.ia?.modelo ? `(${data.ia.modelo})` : ''}
                    </div>
                    <div style={{ opacity: 0.7 }}>Manual (opcional)</div>
                  </div>
                  {CAMPOS.map((c) => {
                    const vFDE = data.fde?.[c.fde];
                    const vSGE = data.sgeeasy?.[c.sge];
                    const vIA = data.ia?.[c.ia];
                    const escolha = escolhas[c.col];
                    return (
                      <div
                        key={c.col}
                        style={{
                          display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr 1.2fr', gap: 0,
                          padding: '8px 12px', borderBottom: '1px solid var(--cpv2-border)',
                          fontSize: 12, alignItems: 'center',
                          background: escolha ? 'color-mix(in srgb, var(--cpv2-success) 6%, transparent)' : 'transparent',
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{c.label}</div>
                        <CelulaFonte valor={fmtCampo(vFDE, c.tipo)} ativo={escolha === 'FDE'} onClick={() => marcarEscolha(c, 'FDE')} bruto={vFDE} />
                        <CelulaFonte valor={fmtCampo(vSGE, c.tipo)} ativo={escolha === 'SGE'} onClick={() => marcarEscolha(c, 'SGE')} bruto={vSGE} />
                        <CelulaFonte valor={fmtCampo(vIA, c.tipo)} ativo={escolha === 'IA'} onClick={() => marcarEscolha(c, 'IA')} bruto={vIA} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <input
                            type={c.tipo === 'str' ? 'text' : 'number'}
                            step={c.tipo === 'brl' ? '0.01' : '1'}
                            className="cpv2-input"
                            placeholder="digitar…"
                            value={manuais[c.col] ?? ''}
                            onChange={(e) => setManuais((p) => ({ ...p, [c.col]: e.target.value }))}
                            onFocus={() => manuais[c.col] && marcarEscolha(c, 'MANUAL')}
                            style={{ flex: 1, padding: '3px 6px', fontSize: 11.5 }}
                          />
                          <button
                            type="button"
                            title="Marcar valor manual como correto"
                            onClick={() => marcarEscolha(c, 'MANUAL')}
                            disabled={!manuais[c.col]}
                            style={{
                              padding: '3px 6px', fontSize: 11, borderRadius: 4,
                              border: '1px solid ' + (escolha === 'MANUAL' ? 'var(--cpv2-success)' : 'var(--cpv2-border)'),
                              background: escolha === 'MANUAL' ? 'var(--cpv2-success)' : 'transparent',
                              color: escolha === 'MANUAL' ? '#fff' : 'var(--cpv2-text)',
                              cursor: manuais[c.col] ? 'pointer' : 'not-allowed',
                              opacity: manuais[c.col] ? 1 : 0.4,
                            }}
                          >✓</button>
                        </div>
                      </div>
                    );
                  })}
                  <div style={{ padding: '8px 12px', background: 'var(--cpv2-surface-2)', fontSize: 11, opacity: 0.75 }}>
                    Clique no valor da fonte que você validou como <b>correto</b>. As decisões são gravadas direto na FATURA_DADOS_EXTRAIDOS.
                  </div>
                </div>

                {/* Observação */}
                <div style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, opacity: 0.8 }}>📝 Observação (opcional)</label>
                  <textarea
                    className="cpv2-input"
                    rows={2}
                    placeholder="Ex.: conferido no PDF; consumo real 22.922 kWh"
                    value={observacao}
                    onChange={(e) => setObservacao(e.target.value)}
                    style={{ width: '100%', marginTop: 4 }}
                  />
                </div>

                {/* Divergências detalhadas (compact) */}
                {data.divergencias?.some((d) => d.status === 'diverge') && (
                  <div style={{
                    border: '1px solid var(--cpv2-border)', borderRadius: 10,
                    padding: 10, marginBottom: 14, background: 'var(--cpv2-surface-2)',
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, opacity: 0.8 }}>⚖️ Divergências (auto-detectadas)</div>
                    {data.divergencias.filter((d) => d.status === 'diverge').map((d, i) => (
                      <div key={i} style={{ fontSize: 12, marginBottom: 2 }}>
                        {statusIcone(d.status)} <b>{d.campo}</b>: FDE={d.tipo === 'str' ? d.fde : fmtNum(d.fde, d.tipo === 'brl' ? 2 : 0)} × Sgeeasy={d.tipo === 'str' ? d.sgeeasy : fmtNum(d.sgeeasy, d.tipo === 'brl' ? 2 : 0)} {d.delta_pct != null && <span style={{ color: 'var(--cpv2-danger)', marginLeft: 6 }}>Δ {d.delta_pct.toFixed(1)}%</span>}
                      </div>
                    ))}
                  </div>
                )}

                {/* Ressarcimento */}
                <div style={{
                  border: '1px solid var(--cpv2-border)', borderRadius: 10,
                  padding: 12, marginBottom: 14,
                  background: data.ressarcimento?.valor_sugerido_brl > 0
                    ? 'color-mix(in srgb, var(--cpv2-warning) 8%, var(--cpv2-surface-2))'
                    : 'var(--cpv2-surface-2)',
                }}>
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, opacity: 0.8 }}>💰 Ressarcimento estimado</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: data.ressarcimento?.valor_sugerido_brl > 0 ? 'var(--cpv2-warning)' : 'var(--cpv2-text)' }}>
                    {fmtBRL(data.ressarcimento?.valor_sugerido_brl)}
                    {data.ressarcimento?.fonte_valor && (
                      <span style={{ marginLeft: 8, fontSize: 10, opacity: 0.6, fontWeight: 400 }}>
                        · fonte: {data.ressarcimento.fonte_valor === 'motor_f02' ? 'motor F02 (tabela)' : data.ressarcimento.fonte_valor}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4, lineHeight: 1.4 }}>
                    {data.ressarcimento?.explicacao}
                  </div>
                </div>

                {/* Veredito */}
                {data.veredito && (
                  <div style={{
                    border: `2px solid ${macroCor(data.veredito.macro)}`,
                    borderRadius: 10, padding: 12,
                    background: `color-mix(in srgb, ${macroCor(data.veredito.macro)} 8%, var(--cpv2-surface))`,
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 4, opacity: 0.8 }}>🔍 Veredito da IA</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: macroCor(data.veredito.macro), marginBottom: 4 }}>
                      {data.veredito.macro}
                      <span style={{ marginLeft: 10, fontSize: 11, fontWeight: 600, opacity: 0.75, textTransform: 'uppercase' }}>· {data.veredito.tipo}</span>
                    </div>
                    <div style={{ fontSize: 12, marginBottom: 6 }}>{data.veredito.justificativa}</div>
                    <div style={{ fontSize: 11, padding: '4px 8px', background: 'var(--cpv2-surface-2)', borderRadius: 6, display: 'inline-block' }}>
                      <b>Ação:</b> {data.veredito.acao_sugerida}
                      <span style={{ marginLeft: 6, opacity: 0.6 }}>· conf {data.veredito.confianca}</span>
                    </div>
                    {data.veredito.analise_grafico && (
                      <div style={{
                        marginTop: 8, paddingTop: 8, borderTop: '1px dashed var(--cpv2-border)',
                        fontSize: 12, lineHeight: 1.5,
                      }}>
                        <div style={{ fontWeight: 700, marginBottom: 3, opacity: 0.85 }}>📈 Análise do gráfico de consumo</div>
                        {data.veredito.analise_grafico}
                      </div>
                    )}
                  </div>
                )}

                {salvarErro && <div className="cpv2-empty cpv2-empty--error" style={{ marginTop: 10 }}>{salvarErro}</div>}
                {salvarOk && (
                  <div style={{ marginTop: 10, padding: 10, background: 'color-mix(in srgb, var(--cpv2-success) 12%, transparent)', border: '1px solid var(--cpv2-success)', borderRadius: 8, fontSize: 12, color: 'var(--cpv2-success)' }}>
                    {salvarOk}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="cpv2-modal__footer" style={{ gap: 8, flexWrap: 'wrap' }}>
            {linkPDF && (
              <a
                className="cpv2-btn"
                href={linkPDF}
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <ExternalLink size={14} /> 📄 Abrir fatura (PDF)
              </a>
            )}
            <button
              className="cpv2-btn"
              onClick={rejeitarApontamento}
              disabled={rejeitando || !faturaId}
              style={{ background: 'var(--cpv2-danger)', borderColor: 'var(--cpv2-danger)', color: '#fff' }}
              title="Marcar como falso positivo"
            >
              {rejeitando ? '⏳ Rejeitando…' : '✕ Rejeitar apontamento'}
            </button>
            <div style={{ flex: 1 }} />
            {nValidados > 0 && (
              <button
                className="cpv2-btn cpv2-btn--primary"
                onClick={salvarValidacao}
                disabled={salvando}
                style={{ background: 'var(--cpv2-success)', borderColor: 'var(--cpv2-success)', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Save size={14} /> {salvando ? 'Salvando…' : `Salvar validação (${nValidados})`}
              </button>
            )}
            {data?.ressarcimento?.valor_sugerido_brl > 0 && onGerarRequisicao && (
              <button
                className="cpv2-btn cpv2-btn--primary"
                onClick={() => onGerarRequisicao(data)}
              >
                Gerar requisição ({fmtBRL(data.ressarcimento.valor_sugerido_brl)})
              </button>
            )}
            <button className="cpv2-btn" onClick={onClose}>Fechar</button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

// CelulaFonte — cada valor das colunas FDE/SGE/IA vira um botão-célula clicável.
// Clicar seleciona aquela fonte como "correta" para o campo da linha.
function CelulaFonte({ valor, ativo, onClick, bruto }) {
  const disabled = bruto == null || bruto === '' || bruto === '—';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? 'Sem valor nessa fonte' : 'Marcar como correto'}
      style={{
        textAlign: 'left', border: '1px solid ' + (ativo ? 'var(--cpv2-success)' : 'transparent'),
        background: ativo ? 'color-mix(in srgb, var(--cpv2-success) 18%, transparent)' : 'transparent',
        borderRadius: 6, padding: '4px 8px', cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit', fontSize: 12, opacity: disabled ? 0.4 : 1,
        display: 'flex', alignItems: 'center', gap: 6,
        color: ativo ? 'var(--cpv2-success)' : 'inherit', fontWeight: ativo ? 700 : 500,
      }}
    >
      {ativo && <CheckCircle size={12} />}
      {valor}
    </button>
  );
}
