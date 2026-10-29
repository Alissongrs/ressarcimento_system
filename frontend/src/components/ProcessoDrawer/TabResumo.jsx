// TabResumo — aba "Resumo" (read-only sempre, é leitura+upload)
import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Star, TrendingUp } from 'lucide-react';
import { setRelevancia } from '../../services/processoV2Service.js';
import { calcularGanho } from '../../services/empresaPercentualService.js';
import { useDimensoesV2 } from '../../hooks/useDimensoesV2.js';
import { fmtDataBR as fmtData } from '../../utils/dateBR.js';

function brl(v) {
  if (v == null) return '—';
  return Number(v).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
function diasDesde(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
}

function Detail({ label, value, big = false, muted = false }) {
  return (
    <div className="cpv2-detail">
      <div className="cpv2-detail__label">{label}</div>
      <div className={`cpv2-detail__value ${big ? 'big' : ''} ${muted ? 'muted' : ''}`}>
        {value ?? '—'}
      </div>
    </div>
  );
}

export default function TabResumo({ detalhe }) {
  const qc = useQueryClient();
  const [relevante, setRelevanteLocal] = useState(!!detalhe?.relevante);
  const [savingRel, setSavingRel] = useState(false);

  useEffect(() => {
    setRelevanteLocal(!!detalhe?.relevante);
  }, [detalhe?.relevante]);

  // Dimensões (carrega vigências de percentual de repasse por empresa)
  const { data: dimensoes } = useDimensoesV2();

  if (!detalhe) return null;
  const dias = diasDesde(detalhe.data_ultima_movimentacao);
  // Valores distintos:
  //  - valor estimado: o que o cliente informou na requisição
  //  - crédito simples / dobro: o que foi efetivamente deferido (do deferimento)
  const valorEstimado = detalhe.ressarcimento_estimado;
  const creditoSimples = detalhe.credito_simples;
  const creditoDobro = detalhe.credito_dobro;

  // Calcula o REPASSE da AMEE (% sobre o valor deferido / estimado)
  const vigenciasEmpresa = (() => {
    if (!detalhe.cod_empresa || !dimensoes?.percentuais_empresa) return null;
    const emp = dimensoes.percentuais_empresa.find(
      (e) => e.cod_empresa === detalhe.cod_empresa,
    );
    return emp?.vigencias || null;
  })();
  // Passa [] quando não há vigência de empresa pra que o override manual (percentual_repasse)
  // do processo ainda seja calculado.
  const ganho = calcularGanho(detalhe, vigenciasEmpresa || []);

  const onToggleRelevante = async () => {
    const novo = !relevante;
    setRelevanteLocal(novo); // otimista
    setSavingRel(true);
    try {
      await setRelevancia(detalhe.id_processo, novo);
      qc.invalidateQueries({ queryKey: ['v2', 'processo', detalhe.id_processo] });
      qc.invalidateQueries({ queryKey: ['v2', 'processos'] });
    } catch {
      setRelevanteLocal(!novo); // rollback
    } finally {
      setSavingRel(false);
    }
  };

  return (
    <div>
      <div className="cpv2-section-title">Identificação</div>
      <div className="cpv2-detail-grid">
        <Detail label="Cliente" value={detalhe.cliente?.razao_social} />
        <Detail
          label="CNPJ/CPF"
          value={detalhe.cliente?.cnpj_cpf_mascarado}
          muted
        />
        <Detail
          label="Distribuidora · UF"
          value={(() => {
            // Backend V2 retorna `distribuidora` como STRING (legacy do FT_PROCESSOS.concessionaria)
            // — aceita tanto string quanto {nome:...} pra robustez.
            const nome =
              typeof detalhe.distribuidora === 'string'
                ? detalhe.distribuidora
                : detalhe.distribuidora?.nome;
            if (!nome) return null;
            return `${nome}${detalhe.uc?.uf ? ' · ' + detalhe.uc.uf : ''}`;
          })()}
        />
        <Detail
          label="UC / Instalação"
          value={
            detalhe.uc?.codigo_uc
              ? `${detalhe.uc.codigo_uc}${detalhe.uc.codigo_instalacao && detalhe.uc.codigo_instalacao !== detalhe.uc.codigo_uc ? ' / ' + detalhe.uc.codigo_instalacao : ''}`
              : null
          }
          muted
        />
        {detalhe.uc?.endereco && (
          <Detail label="Endereço" value={detalhe.uc.endereco} muted />
        )}
        {detalhe.uc?.municipio && (
          <Detail label="Município" value={detalhe.uc.municipio} muted />
        )}
        {detalhe.uc?.grupo_subgrupo && (
          <Detail label="Subgrupo" value={detalhe.uc.grupo_subgrupo} />
        )}
        {detalhe.uc?.modalidade_tarifaria && (
          <Detail
            label="Modalidade tarifária"
            value={detalhe.uc.modalidade_tarifaria}
          />
        )}
      </div>

      <div className="cpv2-section-title">Posicionamento atual</div>
      <div className="cpv2-detail-grid cpv2-detail-grid--3">
        <Detail label="Etapa" value={detalhe.etapa_atual?.nome} />
        <Detail
          label="Instância"
          value={detalhe.instancia_atual?.nome || 'Pós-Deferimento'}
        />
        <Detail label="Status" value={detalhe.status_atual?.nome} />
      </div>

      <div className="cpv2-section-title">Datas · valores · responsabilidade</div>
      <div className="cpv2-detail-grid">
        <Detail label="Abertura" value={fmtData(detalhe.data_abertura)} muted />
        <Detail
          label="Última movimentação"
          value={fmtData(detalhe.data_ultima_movimentacao)}
          muted
        />
        <Detail
          label="Dias na etapa"
          value={dias != null ? `${dias} dias` : '—'}
        />
        <div className="cpv2-detail">
          <div className="cpv2-detail__label">Prioridade</div>
          <button
            type="button"
            disabled={savingRel}
            onClick={onToggleRelevante}
            className={`cpv2-chip cpv2-chip--lg ${
              relevante ? 'cpv2-chip--danger' : 'cpv2-chip--neutral'
            }`}
            style={{
              border: 'none',
              cursor: savingRel ? 'wait' : 'pointer',
              opacity: savingRel ? 0.6 : 1,
            }}
            title={relevante ? 'Clique para desmarcar' : 'Marcar como relevante'}
          >
            <Star
              size={12}
              fill={relevante ? 'currentColor' : 'none'}
            />
            {relevante ? 'Relevante' : 'Marcar como relevante'}
          </button>
        </div>
        <Detail
          label="Próxima ação (alerta)"
          value={fmtData(detalhe.data_alerta)}
          muted
        />
        <Detail
          label="Valor estimado"
          value={brl(valorEstimado)}
          big
        />
        <Detail
          label="Crédito simples"
          value={brl(creditoSimples)}
          big
        />
        <Detail
          label="Crédito em dobro"
          value={brl(creditoDobro)}
          big
        />
        <Detail
          label="Total deferido (simples + dobro)"
          value={creditoSimples == null && creditoDobro == null ? '—' : brl(Number(creditoSimples || 0) + Number(creditoDobro || 0))}
          big
        />
      </div>

      {/* Card Repasse — placeholder quando processo não tem empresa vinculada */}
      {!ganho && (
        <div
          className="cpv2-detail"
          style={{
            marginTop: 8,
            padding: '12px 14px',
            background: 'var(--cpv2-surface-2)',
            border: '1px dashed var(--cpv2-border)',
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
          }}
          title={
            detalhe.cod_empresa
              ? 'Empresa vinculada mas sem vigência cadastrada — abra o modal ⚙ Repasse e cadastre uma'
              : 'Processo sem cod_empresa — vincule a empresa via Requisições ou backfill'
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TrendingUp size={18} color="var(--cpv2-text-muted)" />
            <div>
              <div className="cpv2-detail__label" style={{ marginBottom: 2 }}>
                Repasse — não calculável
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--cpv2-text-muted)',
                  fontStyle: 'italic',
                }}
              >
                {detalhe.cod_empresa
                  ? 'Empresa vinculada não tem vigência ativa em DM_EMPRESA_PERCENTUAL.'
                  : 'Processo sem empresa vinculada (cod_empresa = NULL).'}
              </div>
            </div>
          </div>
          <div
            className="cpv2-detail__value"
            style={{
              color: 'var(--cpv2-text-muted)',
              fontSize: 13,
            }}
          >
            —
          </div>
        </div>
      )}

      {/* Card Repasse — % sobre o valor deferido (ou estimado, antes de deferir) */}
      {ganho && (
        <div
          className="cpv2-detail"
          style={{
            marginTop: 8,
            padding: '12px 14px',
            background:
              ganho.cor === 'verde'
                ? 'var(--cpv2-success-soft)'
                : 'var(--cpv2-brand-soft)',
            border: `1px solid ${ganho.cor === 'verde' ? 'var(--cpv2-success)' : 'var(--cpv2-brand)'}`,
            borderRadius: 8,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 14,
          }}
          title={ganho.detalhe + '\nVigência aplicada: ' + ganho.vigencia_aplicada}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <TrendingUp
              size={18}
              color={ganho.cor === 'verde' ? 'var(--cpv2-success)' : 'var(--cpv2-brand)'}
            />
            <div>
              <div
                className="cpv2-detail__label"
                style={{ marginBottom: 2 }}
              >
                Repasse {ganho.tipo === 'deferido' ? '✓ deferido' : '📊 estimado'}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--cpv2-text-muted)',
                  fontStyle: 'italic',
                }}
              >
                {ganho.detalhe}
              </div>
            </div>
          </div>
          {ganho.tipo === 'deferido' ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                alignItems: 'flex-end',
                minWidth: 150,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, width: '100%', fontSize: 12.5 }}>
                <span style={{ color: 'var(--cpv2-text-muted)' }}>Simples</span>
                <span style={{ fontWeight: 600 }}>{brl(ganho.simples)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, width: '100%', fontSize: 12.5 }}>
                <span style={{ color: 'var(--cpv2-text-muted)' }}>Dobro</span>
                <span style={{ fontWeight: 600 }}>{brl(ganho.dobro)}</span>
              </div>
              <div
                style={{
                  display: 'flex', justifyContent: 'space-between', gap: 16, width: '100%',
                  fontSize: 14, fontWeight: 700, paddingTop: 3, marginTop: 1,
                  borderTop: '1px solid var(--cpv2-border)',
                  color: ganho.cor === 'verde' ? 'var(--cpv2-success)' : 'var(--cpv2-brand)',
                }}
              >
                <span>Simples + Dobro</span>
                <span>{brl(ganho.valor)}</span>
              </div>
            </div>
          ) : (
            <div
              className="cpv2-detail__value big"
              style={{
                color:
                  ganho.cor === 'verde'
                    ? 'var(--cpv2-success)'
                    : 'var(--cpv2-brand)',
                fontWeight: 700,
              }}
            >
              {brl(ganho.valor)}
            </div>
          )}
        </div>
      )}

      {(detalhe.tipo_irregularidade || detalhe.subtipo_irregularidade || detalhe.meses_referencia) && (
        <>
          <div className="cpv2-section-title">Irregularidade</div>
          <div className="cpv2-detail-grid">
            <Detail label="Tipo" value={detalhe.tipo_irregularidade?.nome} />
            <Detail
              label="Subtipo"
              value={detalhe.subtipo_irregularidade?.nome}
            />
            {detalhe.meses_referencia && (
              <Detail
                label="Meses de referência"
                value={detalhe.meses_referencia}
              />
            )}
          </div>
        </>
      )}

      {detalhe.tese_juridica && (
        <>
          <div className="cpv2-section-title">Tese · motivo</div>
          <div
            className="cpv2-detail"
            style={{ padding: '11px 13px', marginBottom: 8 }}
          >
            <div className="cpv2-detail__label">Tese jurídica</div>
            <div className="cpv2-detail__value">{detalhe.tese_juridica}</div>
          </div>
        </>
      )}

      {detalhe.motivo_objeto && (
        <div className="cpv2-detail" style={{ padding: '11px 13px' }}>
          <div className="cpv2-detail__label">Resumo / objeto</div>
          <div
            style={{
              fontSize: 12.5,
              lineHeight: 1.55,
              color: 'var(--cpv2-text)',
              marginTop: 4,
            }}
          >
            {detalhe.motivo_objeto}
          </div>
        </div>
      )}

      {detalhe.numero_protocolo && (
        <div className="cpv2-detail" style={{ padding: '11px 13px', marginTop: 8 }}>
          <div className="cpv2-detail__label">Número de protocolo</div>
          <div className="cpv2-detail__value">{detalhe.numero_protocolo}</div>
        </div>
      )}
    </div>
  );
}
