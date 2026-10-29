// Quadro "Protocolos ANEEL deste processo" no topo do histórico: situação e data de cada protocolo
// (só a data — o site da ANEEL não informa horário) e campo para vincular um protocolo novo.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import api from '../../services/apiClient.js';
import { fmtDataBR } from '../../utils/dateBR.js';
import { chipSituacaoAneel, protocoloValido } from '../../utils/protocolosAneel.js';

export function useProtocolosAneelProcesso(idProcesso) {
  return useQuery({
    queryKey: ['protocolos-aneel', 'processo', idProcesso],
    queryFn: () => api.get(`/protocolos-aneel/processo/${idProcesso}`).then((r) => r.data),
    enabled: !!idProcesso,
  });
}

export default function ProtocolosAneelProcesso({ idProcesso, onToast }) {
  const qc = useQueryClient();
  const { data } = useProtocolosAneelProcesso(idProcesso);
  const [novo, setNovo] = useState('');
  const [salvando, setSalvando] = useState(false);
  const itens = data?.itens || [];

  const recarregar = () => {
    qc.invalidateQueries({ queryKey: ['protocolos-aneel'] });
  };

  const vincular = async () => {
    if (!protocoloValido(novo)) {
      onToast?.({ open: true, type: 'error', text: 'Protocolo ANEEL tem 13 números começando com 010 (ex.: 010.665.84026-55).' });
      return;
    }
    setSalvando(true);
    try {
      await api.post('/protocolos-aneel/vincular', { protocolo: novo, id_processo: Number(idProcesso) });
      setNovo('');
      recarregar();
      onToast?.({ open: true, type: 'success', text: 'Protocolo vinculado ao processo.' });
    } catch (e) {
      onToast?.({ open: true, type: 'error', text: e?.response?.data?.error || 'Não foi possível vincular.' });
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div className="cpv2-aneel-box">
      <div className="cpv2-section-title">🏛️ Protocolos ANEEL deste processo</div>
      {itens.length === 0 && (
        <div className="cpv2-muted-sm" style={{ marginBottom: 8 }}>
          Nenhum protocolo ANEEL ainda. Quando alguém escreve "Protocolo 010.…" numa movimentação, ele aparece aqui sozinho.
        </div>
      )}
      {itens.map((p) => (
        <div key={p.id} className="cpv2-aneel-row">
          <Link to={`/protocolos-aneel?protocolo=${encodeURIComponent(p.protocolo)}`} className="cpv2-mono">
            {p.protocolo}
          </Link>
          {p.situacao ? (
            <span className={chipSituacaoAneel(p.situacao)}>
              <span className="cpv2-chip__dot" />
              {p.situacao}
            </span>
          ) : (
            <span className="cpv2-muted-sm">nenhum e-mail da ANEEL ainda</span>
          )}
          {p.ultima_mudanca_em && <span className="cpv2-muted-sm">{fmtDataBR(p.ultima_mudanca_em)}</span>}
          {p.status_vinculo === 'confirmar' && (
            <span className="cpv2-chip cpv2-chip--danger" title="Este protocolo também aparece em outro processo — o administrador confirma qual vale">
              a confirmar
            </span>
          )}
        </div>
      ))}
      <div className="cpv2-aneel-row">
        <input
          className="cpv2-mono"
          value={novo}
          onChange={(e) => setNovo(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && vincular()}
          placeholder="010.000.00000-00"
          style={{ width: 170 }}
        />
        <button type="button" className="cpv2-btn cpv2-btn--sm" disabled={salvando || !novo.trim()} onClick={vincular}>
          Vincular protocolo
        </button>
      </div>
    </div>
  );
}
