// ModalPercentuaisEmpresa — engrenagem ⚙️ no Controle de Processos.
// Lista empresas com vigência atual + abre painel lateral com timeline de vigências.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Percent, Calendar, Plus, AlertCircle } from 'lucide-react';
import {
  listEmpresasPercentual,
  getHistoricoEmpresa,
  criarVigencia,
  atualizarVigencia,
} from '../../services/empresaPercentualService.js';
import './modal-percentuais-empresa.css';

function fmtPct(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `${Number(v).toFixed(2).replace('.', ',')}%`;
}

function fmtData(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function ModalPercentuaisEmpresa({ onClose, onToast }) {
  const [empresas, setEmpresas] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busca, setBusca] = useState('');
  const [empresaSel, setEmpresaSel] = useState(null);
  const [historico, setHistorico] = useState(null);
  const [carregandoHist, setCarregandoHist] = useState(false);
  const [erro, setErro] = useState('');

  // form de nova vigência
  const [novoForm, setNovoForm] = useState(null); // { data_inicio, ps, pd, motivo, observacao }

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  const carregarLista = async () => {
    setLoading(true);
    setErro('');
    try {
      const r = await listEmpresasPercentual();
      setEmpresas(r.items || []);
    } catch (e) {
      setErro(e?.message || 'Falha ao carregar empresas');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    carregarLista();
  }, []);

  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return empresas;
    return empresas.filter(
      (e) =>
        (e.nome_empresa || '').toLowerCase().includes(q) ||
        String(e.cod_empresa).includes(q) ||
        (e.cnpj || '').toLowerCase().includes(q),
    );
  }, [empresas, busca]);

  const abrirEmpresa = async (emp) => {
    setEmpresaSel(emp);
    setHistorico(null);
    setNovoForm(null);
    setCarregandoHist(true);
    try {
      const h = await getHistoricoEmpresa(emp.cod_empresa);
      setHistorico(h);
    } catch (e) {
      onToast?.({ open: true, type: 'error', text: 'Falha ao carregar histórico: ' + (e?.message || '') });
    } finally {
      setCarregandoHist(false);
    }
  };

  const iniciarNovaVigencia = () => {
    setNovoForm({
      data_vigencia_inicio: todayISO(),
      percentual_simples: '',
      percentual_dobro: '',
      motivo_alteracao: '',
      observacao: '',
      nome_empresa: empresaSel?.nome_empresa || '',
      cnpj: empresaSel?.cnpj || '',
    });
  };

  const salvarNovaVigencia = async () => {
    if (!novoForm?.data_vigencia_inicio) {
      onToast?.({ open: true, type: 'error', text: 'Data de início é obrigatória.' });
      return;
    }
    try {
      await criarVigencia(empresaSel.cod_empresa, {
        nome_empresa: novoForm.nome_empresa || null,
        cnpj: novoForm.cnpj || null,
        data_vigencia_inicio: novoForm.data_vigencia_inicio,
        percentual_simples: novoForm.percentual_simples === '' ? null : Number(novoForm.percentual_simples),
        percentual_dobro: novoForm.percentual_dobro === '' ? null : Number(novoForm.percentual_dobro),
        motivo_alteracao: novoForm.motivo_alteracao || null,
        observacao: novoForm.observacao || null,
      });
      onToast?.({ open: true, type: 'success', text: 'Vigência criada.' });
      setNovoForm(null);
      // recarrega histórico e lista
      await abrirEmpresa(empresaSel);
      await carregarLista();
    } catch (e) {
      onToast?.({
        open: true,
        type: 'error',
        text: e?.response?.data?.error?.message || e?.message || 'Falha ao salvar vigência',
      });
    }
  };

  const corrigirVigente = async (vig) => {
    const ps = window.prompt(`Corrigir % simples (atual: ${fmtPct(vig.percentual_simples)})`, vig.percentual_simples ?? '');
    if (ps === null) return;
    const pd = window.prompt(`Corrigir % dobro (atual: ${fmtPct(vig.percentual_dobro)})`, vig.percentual_dobro ?? '');
    if (pd === null) return;
    try {
      await atualizarVigencia(vig.id_empresa_percentual, {
        percentual_simples: ps === '' ? null : Number(ps),
        percentual_dobro: pd === '' ? null : Number(pd),
      });
      onToast?.({ open: true, type: 'success', text: 'Vigência corrigida.' });
      await abrirEmpresa(empresaSel);
      await carregarLista();
    } catch (e) {
      onToast?.({ open: true, type: 'error', text: e?.message || 'Falha ao corrigir.' });
    }
  };

  const content = (
    <div className="cpv2-root cpv2-modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className="cpv2-modal mpe-modal">
        <div className="cpv2-modal__head">
          <div>
            <h3>
              <Percent size={16} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
              Percentuais de ganho por empresa
            </h3>
            <p>Configure o % aplicado sobre o crédito deferido (simples e dobro), com histórico de vigências.</p>
          </div>
          <button type="button" className="cpv2-modal__close" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="mpe-body">
          {/* ─── coluna esquerda: lista de empresas ──────────────── */}
          <div className="mpe-left">
            <div className="mpe-search">
              <Search size={14} />
              <input
                type="text"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar empresa / cod / CNPJ"
              />
            </div>

            {loading && <div className="cpv2-empty"><h4>Carregando…</h4></div>}
            {erro && (
              <div className="cpv2-empty cpv2-empty--error">
                <AlertCircle size={18} />
                <p>{erro}</p>
              </div>
            )}
            {!loading && !erro && filtradas.length === 0 && (
              <div className="cpv2-empty">
                <h4>Nenhuma empresa</h4>
                <p>Selecione uma empresa do PROD para começar.</p>
              </div>
            )}

            <div className="mpe-lista">
              {filtradas.map((e) => (
                <div
                  key={e.cod_empresa}
                  className={`mpe-empresa-card ${empresaSel?.cod_empresa === e.cod_empresa ? 'is-active' : ''}`}
                  onClick={() => abrirEmpresa(e)}
                >
                  <div className="mpe-empresa-card__head">
                    <span className="mpe-empresa-card__cod">#{e.cod_empresa}</span>
                    <span className="mpe-empresa-card__nome">{e.nome_empresa || `Empresa ${e.cod_empresa}`}</span>
                  </div>
                  <div className="mpe-empresa-card__pcts">
                    <span>S: <strong>{fmtPct(e.percentual_simples)}</strong></span>
                    <span>D: <strong>{fmtPct(e.percentual_dobro)}</strong></span>
                  </div>
                  <div className="mpe-empresa-card__meta">
                    <Calendar size={11} /> desde {fmtData(e.data_vigencia_inicio)}
                    {e.qtd_vigencias_anteriores > 0 && (
                      <span className="mpe-badge-hist"> · {e.qtd_vigencias_anteriores} ver. ant.</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ─── coluna direita: timeline da empresa selecionada ─── */}
          <div className="mpe-right">
            {!empresaSel && (
              <div className="cpv2-empty">
                <Percent size={22} />
                <h4>Selecione uma empresa</h4>
                <p>Clique numa empresa à esquerda para ver/editar suas vigências.</p>
              </div>
            )}

            {empresaSel && (
              <>
                <div className="mpe-right__head">
                  <h4>
                    {empresaSel.nome_empresa || `Empresa ${empresaSel.cod_empresa}`}{' '}
                    <span className="mpe-cod">#{empresaSel.cod_empresa}</span>
                  </h4>
                  {empresaSel.cnpj && <p className="mpe-cnpj">CNPJ: {empresaSel.cnpj}</p>}
                </div>

                {carregandoHist && <div className="cpv2-empty"><h4>Carregando histórico…</h4></div>}

                {!carregandoHist && historico && (
                  <>
                    <div className="mpe-section-title">
                      <Calendar size={13} /> Linha do tempo
                    </div>
                    <div className="mpe-timeline">
                      {historico.vigencias.length === 0 && (
                        <div className="cpv2-empty">
                          <p>Empresa ainda sem cadastro. Crie a primeira vigência.</p>
                        </div>
                      )}
                      {historico.vigencias.map((v) => (
                        <div
                          key={v.id_empresa_percentual}
                          className={`mpe-vig-card ${v.vigente ? 'is-vigente' : 'is-fechada'} ${!v.ativo ? 'is-inativa' : ''}`}
                        >
                          <div className="mpe-vig-card__periodo">
                            <strong>{fmtData(v.data_vigencia_inicio)}</strong>
                            <span> → </span>
                            <strong>{v.data_vigencia_fim ? fmtData(v.data_vigencia_fim) : 'presente'}</strong>
                            {v.vigente && <span className="mpe-badge-vigente">★ VIGENTE</span>}
                          </div>
                          <div className="mpe-vig-card__pcts">
                            <div>Simples: <strong>{fmtPct(v.percentual_simples)}</strong></div>
                            <div>Dobro: <strong>{fmtPct(v.percentual_dobro)}</strong></div>
                          </div>
                          {v.motivo_alteracao && (
                            <div className="mpe-vig-card__motivo">{v.motivo_alteracao}</div>
                          )}
                          {v.vigente && (
                            <div className="mpe-vig-card__actions">
                              <button type="button" className="cpv2-btn cpv2-btn--sm" onClick={() => corrigirVigente(v)}>
                                ✏ Corrigir vigente
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>

                    {!novoForm && (
                      <div className="mpe-right__actions">
                        <button type="button" className="cpv2-btn cpv2-btn--primary" onClick={iniciarNovaVigencia}>
                          <Plus size={13} /> Nova vigência
                        </button>
                      </div>
                    )}

                    {novoForm && (
                      <div className="mpe-form-novo">
                        <div className="mpe-section-title">Nova vigência</div>
                        <div className="cpv2-form-group">
                          <label>Data início *</label>
                          <input
                            type="date"
                            value={novoForm.data_vigencia_inicio}
                            onChange={(e) => setNovoForm({ ...novoForm, data_vigencia_inicio: e.target.value })}
                          />
                        </div>
                        <div className="mpe-row">
                          <div className="cpv2-form-group">
                            <label>% simples</label>
                            <input
                              type="number" step="0.01" min="0" max="100"
                              value={novoForm.percentual_simples}
                              onChange={(e) => setNovoForm({ ...novoForm, percentual_simples: e.target.value })}
                              placeholder="ex: 30.00"
                            />
                          </div>
                          <div className="cpv2-form-group">
                            <label>% dobro</label>
                            <input
                              type="number" step="0.01" min="0" max="100"
                              value={novoForm.percentual_dobro}
                              onChange={(e) => setNovoForm({ ...novoForm, percentual_dobro: e.target.value })}
                              placeholder="ex: 40.00"
                            />
                          </div>
                        </div>
                        <div className="cpv2-form-group">
                          <label>Motivo</label>
                          <input
                            type="text"
                            value={novoForm.motivo_alteracao}
                            onChange={(e) => setNovoForm({ ...novoForm, motivo_alteracao: e.target.value })}
                            placeholder="Renegociação 2026"
                          />
                        </div>
                        <div className="cpv2-form-group">
                          <label>Observação</label>
                          <textarea
                            rows={2}
                            value={novoForm.observacao}
                            onChange={(e) => setNovoForm({ ...novoForm, observacao: e.target.value })}
                          />
                        </div>
                        <div className="mpe-form-novo__actions">
                          <button type="button" className="cpv2-btn" onClick={() => setNovoForm(null)}>Cancelar</button>
                          <button type="button" className="cpv2-btn cpv2-btn--primary" onClick={salvarNovaVigencia}>
                            Salvar vigência
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div className="cpv2-modal__footer">
          <button type="button" className="cpv2-btn" onClick={onClose}>Fechar</button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
