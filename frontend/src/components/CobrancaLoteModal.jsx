// Janela "E-mails de SR (sem retorno)" — aberta pelo chat quando o pedido é do tipo
// "veja o que está atrasado da CELESC nos Prazos e o que está sem resposta, escreva o e-mail de SR".
// Lista os processos VENCIDOS (regra da tela Prazos) da distribuidora que estão SEM RETORNO
// (último e-mail enviado sem resposta depois) com o rascunho pronto. "Abrir e-mail" abre o
// modal de cobrança do processo (4 tons, para/cc/assunto já preenchidos) — a pessoa revisa e
// envia; o envio fica registrado no processo. Nada é enviado automaticamente.
import React, { Suspense, lazy, useState } from 'react';
import { Mail, X, CheckCircle2, AlertTriangle, Clock, Loader2 } from 'lucide-react';

const CobrancaEmailModal = lazy(() => import('../pages/HomeGestorAdmin.jsx').then((m) => ({ default: m.CobrancaEmailModal })));

const resumo = (html) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);

export default function CobrancaLoteModal({ dados, onClose }) {
  const [aberto, setAberto] = useState(null); // item com o e-mail aberto
  const [enviados, setEnviados] = useState(new Set());
  const itens = dados?.itens || [];

  return (
    <div onMouseDown={(e) => { if (e.target === e.currentTarget && !aberto) onClose(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ width: 'min(980px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', background: 'var(--card)', color: 'var(--fg)', border: '1px solid var(--panel-border)', borderRadius: 18, boxShadow: 'var(--shadow-elevated)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderBottom: '1px solid var(--panel-border)' }}>
          <div style={{ width: 38, height: 38, borderRadius: 11, display: 'grid', placeItems: 'center', background: 'var(--gradient-primary)', color: '#fff' }}><Mail size={19} /></div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>E-mails de SR (sem retorno){dados?.concessionaria ? ` — ${dados.concessionaria}` : ''}</div>
            <div style={{ fontSize: 12.5, opacity: 0.65 }}>
              {dados?.total_atrasados ?? 0} processo(s) com prazo vencido · {itens.length} sem retorno com e-mail pronto
              {dados?.respondidos ? ` · ${dados.respondidos} já tiveram resposta (fora da lista)` : ''}
              {dados?.truncado ? ` · mostrando os ${dados.analisados} mais atrasados` : ''}
            </div>
          </div>
          <button type="button" onClick={onClose} title="Fechar" style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}><X size={20} /></button>
        </div>

        <div style={{ padding: 16, overflowY: 'auto', display: 'grid', gap: 10 }}>
          {itens.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', opacity: 0.7 }}>
              Nenhum processo vencido sem retorno{dados?.concessionaria ? ` para ${dados.concessionaria}` : ''}. 🎉
            </div>
          )}
          {itens.map((it) => {
            const enviado = enviados.has(it.id_processo);
            const semDest = !it.para;
            return (
              <div key={it.id_processo} style={{ border: '1px solid var(--panel-border)', borderLeft: `5px solid ${enviado ? 'var(--success)' : it.erro ? 'var(--danger)' : 'var(--warning)'}`, borderRadius: 12, padding: '12px 14px', display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 14 }}>{it.codigo_publico || `Processo ${it.id_processo}`}</b>
                  <span style={{ fontSize: 12.5, opacity: 0.75 }}>{it.cliente} · UC {it.uc} · {it.instancia}</span>
                  <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 9px', borderRadius: 20, color: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 11%, transparent)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <Clock size={12} /> {it.dias_atraso} dia(s) de atraso
                  </span>
                  {it.tem_email_enviado && <span style={{ fontSize: 11.5, opacity: 0.7 }}>sem resposta há {it.dias_sem_retorno} dia(s)</span>}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                    {enviado && <span style={{ color: 'var(--success)', fontWeight: 700, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 4 }}><CheckCircle2 size={15} /> Enviado</span>}
                    <button type="button" onClick={() => setAberto(it)}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 700, padding: '7px 12px', borderRadius: 9, cursor: 'pointer', border: 'none', background: 'var(--gradient-primary)', color: '#fff' }}>
                      <Mail size={14} /> {enviado ? 'Abrir de novo' : 'Abrir e-mail'}
                    </button>
                  </div>
                </div>
                {it.erro ? (
                  <div style={{ fontSize: 12.5, color: 'var(--danger)' }}>Não consegui gerar o rascunho ({it.erro}). Abra o e-mail para gerar de novo.</div>
                ) : (
                  <>
                    <div style={{ fontSize: 12.5 }}><b>Para:</b> {it.para || <span style={{ color: 'var(--warning)' }}>sem destinatário (nenhum e-mail enviado antes neste processo) — preencha ao abrir</span>}{it.cc ? <> · <b>Cc:</b> {it.cc}</> : null}</div>
                    <div style={{ fontSize: 12.5 }}><b>Assunto:</b> {it.subject}</div>
                    <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.5 }}>{resumo(it.formal)}…</div>
                  </>
                )}
                {semDest && !it.erro && <div style={{ fontSize: 11.5, display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--warning)' }}><AlertTriangle size={13} /> Confira o destinatário antes de enviar.</div>}
              </div>
            );
          })}
        </div>
        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--panel-border)', fontSize: 12, opacity: 0.7 }}>
          Nada é enviado automaticamente: abra cada e-mail, escolha o tom, revise e envie. O envio fica registrado no processo.
        </div>
      </div>

      {aberto && (
        <Suspense fallback={<div style={{ position: 'fixed', inset: 0, zIndex: 1300, display: 'grid', placeItems: 'center' }}><Loader2 size={28} /></div>}>
          <div style={{ position: 'relative', zIndex: 1300 }}>
            <CobrancaEmailModal
              processo={{ id_processo: aberto.id_processo, uc: aberto.uc, cliente: aberto.cliente, concessionaria: aberto.concessionaria, sub_etapa: aberto.sub_etapa || 'Aguardando retorno' }}
              onClose={() => setAberto(null)}
              onSent={() => { setEnviados((s) => new Set(s).add(aberto.id_processo)); setAberto(null); }}
            />
          </div>
        </Suspense>
      )}
    </div>
  );
}
