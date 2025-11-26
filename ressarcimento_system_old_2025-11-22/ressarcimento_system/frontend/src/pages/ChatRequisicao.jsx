import React, { useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { buscarUC, criarRequisicao, buscarFaturasUC, buscarFaturasPorUnidadeMeses } from '../services/requisicaoService';

const BOT = 'bot';
const USER = 'user';

function BotAvatar({ size = 36 }) {
  const style = { width: size, height: size, fontSize: Math.max(12, Math.floor(size * 0.45)) };
  return (
    <div className="bot-avatar" style={style} title="Sure (Assistente)">
      <span className="bot-avatar__initial">S</span>
      <span className="bot-avatar__badge" aria-hidden>{'\u2640'}</span>
    </div>
  );
}

function Bubble({ role, children }) {
  const isUser = role === USER;
  if (isUser) {
    return (
      <div className="flex justify-end w-full">
        <div className="max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap shadow-sm bg-[var(--accent)] text-[var(--fg)]">
          {children}
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 w-full">
      <BotAvatar size={28} />
      <div className="max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap shadow-sm bg-[var(--panel)] text-[var(--fg)] border border-[var(--panel-border)]">
        {children}
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div className="flex justify-start w-full">
      <div className="max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap shadow-sm bg-[var(--panel)] text-[var(--fg)] border border-[var(--panel-border)]">
        <div className="flex items-center gap-1">
          <span className="typing-dot"></span>
          <span className="typing-dot"></span>
          <span className="typing-dot"></span>
        </div>
      </div>
    </div>
  );
}

export default function ChatRequisicao() {
  const { user } = useAuth();
  const [messages, setMessages] = useState([
    { role: BOT, text: 'Ola! Eu sou a Sure, sua assistente para abrir a requisicao. :)' },
    { role: BOT, text: 'Para comecarmos, voce poderia me enviar o numero da sua UC (apenas digitos)? Se nao tiver agora, tudo bem â€” podemos seguir assim mesmo.' },
  ]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [ucAskConfirm, setUcAskConfirm] = useState(false);
  const [form, setForm] = useState({
    prioridade: 'Baixa',
    uc: '',
    cliente: '',
    razaoSocialFatura: '',
    concessionaria: '',
    cnpj: '',
    enderecoCompleto: '',
    ressarcimentoEstimado: '',
    descricaoIrregularidade: '',
    linkFatura: '',
  });
  const [periodos, setPeriodos] = useState([]);
  const [faturas, setFaturas] = useState([]);
  const fileRef = useRef(null);

  const push = (role, text) => setMessages((m) => [...m, { role, text }]);

  const parseOneMonth = (raw) => {
    let mm = '', aa = '';
    const t = String(raw || '')
      .trim()
      .replace(/\s+/g, '')
      .replace(/\./g, '/')
      .replace(/-/g, '/');
    const seg = t.split('/');
    if (seg.length === 2) {
      if (seg[0].length === 4) { aa = seg[0]; mm = seg[1]; }
      else if (seg[1].length === 4) { mm = seg[0]; aa = seg[1]; }
    }
    if (mm && aa) { const m = String(parseInt(mm, 10)).padStart(2, '0'); return { mes: m, ano: aa }; }
    return null;
  };

  const expandMonths = (start, end) => {
    // start/end: {mes:'MM', ano:'YYYY'} inclusive
    const out = [];
    if (!start || !end) return out;
    let y1 = parseInt(start.ano, 10), m1 = parseInt(start.mes, 10);
    let y2 = parseInt(end.ano, 10), m2 = parseInt(end.mes, 10);
    // swap if inverted
    if (y1 > y2 || (y1 === y2 && m1 > m2)) { [y1, y2] = [y2, y1]; [m1, m2] = [m2, m1]; }
    let y = y1, m = m1;
    while (y < y2 || (y === y2 && m <= m2)) {
      out.push({ mes: String(m).padStart(2, '0'), ano: String(y) });
      m += 1; if (m > 12) { m = 1; y += 1; }
    }
    return out;
  };

  const parseMeses = (s) => {
    const out = [];
    const parts = String(s || '').split(',').map((t) => t.trim()).filter(Boolean);
    for (const part of parts) {
      const pLow = part.toLowerCase();
      // suporta intervalos: "mm-yyyy a mm-yyyy" | "mm/yyyy até mm/yyyy" | "mm/yyyy ate mm/yyyy"
      let token = pLow.replace('até', 'a').replace('ate', 'a');
      if (token.includes(' a ')) {
        const [iniRaw, fimRaw] = part.replace(/até|ate/gi, 'a').split(/\sa\s/);
        const ini = parseOneMonth(iniRaw);
        const fim = parseOneMonth(fimRaw);
        const rng = expandMonths(ini, fim);
        if (rng.length) { out.push(...rng); continue; }
      }
      const single = parseOneMonth(part);
      if (single) out.push(single);
    }
    return out;
  };

  const mesesRefs = (arr) => arr.map((p) => `${p.ano}-${String(p.mes).padStart(2, '0')}`);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    push(USER, text);
    setBusy(true);
    try {
      if (step === 0) {
        const txt = text.toLowerCase();
        const isYes = ['sim','s','isso','e uc','eh uc','isso mesmo'].some((k) => txt.includes(k));
        const isNo = ['nao','nao e','nao eh','nao e uc','nao eh uc','n'].some((k) => txt.includes(k));

        if (ucAskConfirm) {
          if (isYes) {
            push(BOT, 'Perfeito! Pode conferir e me enviar novamente o numero da UC (apenas digitos)?');
            setUcAskConfirm(false);
            setBusy(false);
            return;
          }
          if (isNo) {
            setForm((s) => ({ ...s, uc: '' }));
            push(BOT, 'Sem problemas! Podemos continuar sem a UC. Me diga, por favor, os meses que devemos considerar (ex.: 07/2024, 08/2024).');
            setUcAskConfirm(false);
            setStep(1);
            return;
          }
        }

        const uc = text.replace(/\D/g, '');
        if (!uc) {
          push(BOT, 'Hmm, nao encontrei numeros na sua mensagem. Se preferir, podemos seguir sem a UC por agora. Quer tentar me enviar novamente o numero?');
          setBusy(false);
          return;
        }
        let dados = null;
        try { dados = await buscarUC(uc, []); } catch {}
        if (!dados || Object.keys(dados || {}).length === 0) {
          setUcAskConfirm(true);
          push(BOT, 'Nao localizei essa UC. O numero que voce me passou e de uma unidade de consumo (UC)?');
          setBusy(false);
          return;
        }
        setForm((s) => ({
          ...s,
          uc,
          cliente: (dados?.cliente?.String ?? dados?.cliente) || '',
          razaoSocialFatura: (dados?.razao_social_fatura?.String ?? dados?.razao_social_fatura) || '',
          concessionaria: (dados?.concessionaria?.String ?? dados?.concessionaria) || '',
          cnpj: (dados?.cnpj?.String ?? dados?.cnpj) || '',
          enderecoCompleto: (dados?.endereco_completo?.String ?? dados?.endereco_completo) || '',
          linkFatura: (dados?.link_fatura?.String ?? dados?.link_fatura) || '',
        }));
        push(BOT, 'Perfeito! Para quais meses devemos olhar? Você pode enviar algo como "07/2024, 08/2024" ou um intervalo "07/2024 a 09/2024".');
        setStep(1);
        return;
      }

      if (step === 1) {
        const meses = parseMeses(text);
        if (meses.length === 0) { push(BOT, 'Envie meses válidos (separe por vírgula) ou um intervalo. Ex.: 07/2024, 08/2024 ou 07/2024 a 09/2024'); setBusy(false); return; }
        setPeriodos(meses);
        try {
          // 1) Tenta via alias público /faturas-uc (usa unidade + meses)
          const dados = await buscarFaturasPorUnidadeMeses(form.uc, mesesRefs(meses));
          // Normaliza possíveis formatos de resposta do backend
          let det = [];
          if (Array.isArray(dados?.faturas)) {
            det = dados.faturas.map((f) => ({
              link: f.link ?? f.Link?.String ?? f.Link,
              mes_ref: f.mes_ref ?? f.MesRef?.String ?? f.MesRef,
              dt_vencimento: f.dt_vencimento ?? f.DtVenc ?? f.Dt_Vencimento,
              valor_total: f.valor_total ?? f.ValorTotal,
            }));
          } else if (Array.isArray(dados?.links_faturas_detalhes)) {
            det = dados.links_faturas_detalhes;
          } else if (Array.isArray(dados?.links_faturas)) {
            det = dados.links_faturas.map((l) => ({ link: l, mes_ref: '' }));
          } else if (dados && typeof dados === 'object' && (dados.link || dados.mes_ref)) {
            // Caso singular (quando apenas um mês foi pedido)
            det = [{ link: dados.link ?? '', mes_ref: dados.mes_ref ?? '' }];
          }

          // Se nada veio, tenta rota dedicada /uc/:numero/faturas
          if (!det.length && form.uc) {
            const alt = await buscarFaturasUC(form.uc, mesesRefs(meses));
            if (Array.isArray(alt?.faturas)) {
              det = alt.faturas.map((f) => ({
                link: f.link ?? f.Link?.String ?? f.Link,
                mes_ref: f.mes_ref ?? f.MesRef?.String ?? f.MesRef,
                dt_vencimento: f.dt_vencimento ?? f.DtVencimento ?? f.Dt_Venc,
                valor_total: f.valor_total ?? f.ValorTotal,
              }));
            }
          }

          const lista = Array.isArray(det) ? det.filter(Boolean) : [];
          setFaturas(lista);
          const qtd = lista.length;
          if (qtd > 0) {
            const lines = lista.slice(0, 10).map((f, i) => {
              const mr = (f.mes_ref || '').slice(0, 7);
              const venc = f.dt_vencimento || '-';
              const val = (f.valor_total != null) ? String(f.valor_total) : '-';
              const link = f.link || '';
              return `${i + 1}. ${mr} | Venc: ${venc} | Valor: ${val} | ${link}`;
            }).join('\n');
            push(BOT, `Faturas encontradas:\n${lines}${lista.length > 10 ? '\n... (mostrando 10 de ' + lista.length + ')' : ''}`);
          }
          push(BOT, qtd > 0
            ? `Perfeito! Encontrei ${qtd} fatura(s). Qual o valor estimado do ressarcimento (R$)?`
            : 'Nao localizei faturas nesses meses. Mesmo assim, qual o valor estimado do ressarcimento (R$)?');
        } catch (_) {
          push(BOT, 'Tive um problema ao buscar as faturas. Pode me informar o valor estimado do ressarcimento (R$)?');
        }
        setStep(2);
        return;
      }

      if (step === 2) {
        const val = Number(String(text).replace(/\./g, '').replace(',', '.'));
        if (!Number.isFinite(val) || val <= 0) { push(BOT, 'Informe um valor numerico maior que zero.'); setBusy(false); return; }
        setForm((s) => ({ ...s, ressarcimentoEstimado: String(val) }));
        push(BOT, 'Certo. Agora descreva brevemente a irregularidade (o que aconteceu).');
        setStep(3);
        return;
      }

      if (step === 3) {
        setForm((s) => ({ ...s, descricaoIrregularidade: text }));
        push(BOT, 'Se quiser, anexe arquivos agora (campo abaixo). Quando estiver tudo certo, envie "confirmar" para finalizar.');
        setStep(4);
        return;
      }

      if (step === 4) {
        const ok = text.toLowerCase().includes('confirm');
        if (!ok) { push(BOT, 'Para enviar, digite "confirmar". Se preferir, podemos ajustar alguma informacao antes.'); setBusy(false); return; }
        const fd = new FormData();
        Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
        const periodosForm = periodos.map((p) => ({ mes: Number(p.mes), ano: p.ano }));
        fd.append('periodosIrregularidade', JSON.stringify(periodosForm));
        fd.append('RessarcimentoEstimado', form.ressarcimentoEstimado);
        const files = fileRef.current?.files || [];
        for (let i = 0; i < files.length; i += 1) fd.append('anexos', files[i]);
        try { await criarRequisicao(fd); push(BOT, 'Requisicao enviada com sucesso! Obrigado.'); setStep(5); }
        catch (e) { push(BOT, 'Nao consegui enviar agora. Verifique os dados e tente novamente.'); }
        return;
      }
    } finally { setBusy(false); }
  };

  const resumo = () => (
    'UC: ' + form.uc + '\n' +
    'Cliente: ' + form.cliente + '\n' +
    'Distribuidora: ' + form.concessionaria + '\n' +
    'CNPJ: ' + form.cnpj + '\n' +
    'Endereco: ' + form.enderecoCompleto + '\n' +
    'Meses: ' + (periodos.map((p) => (p.mes + '/' + p.ano)).join(', ') || '-') + '\n' +
    'Faturas: ' + faturas.length + ' encontrada(s)\n' +
    'Valor estimado: ' + (form.ressarcimentoEstimado || '-') + '\n' +
    'Descricao: ' + (form.descricaoIrregularidade || '-')
  );

  const chips = useMemo(() => {
    const arr = [];
    if (step === 0 && ucAskConfirm) {
      arr.push({ label: 'Sim, e UC', value: 'sim' });
      arr.push({ label: 'Nao, nao e UC', value: 'nao' });
    }
    if (step === 1) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const m = (d) => pad(d.getMonth() + 1) + '/' + d.getFullYear();
      const d1 = new Date(now.getFullYear(), now.getMonth(), 1);
      const d2 = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const d3 = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      arr.push({ label: m(d2) + ', ' + m(d3), value: m(d2) + ', ' + m(d3) });
      arr.push({ label: m(d1) + ', ' + m(d2), value: m(d1) + ', ' + m(d2) });
      arr.push({ label: '07/2024, 08/2024', value: '07/2024, 08/2024' });
    } else if (step === 2) {
      ['500', '1000', '2500'].forEach((v) => arr.push({ label: 'R$ ' + v, value: v }));
    } else if (step === 3) {
      ['Oscilacoes de energia', 'Cobranca indevida', 'Falha no medidor'].forEach((v) => arr.push({ label: v, value: v }));
    } else if (step === 4) {
      arr.push({ label: 'Confirmar envio', value: 'confirmar' });
    }
    return arr;
  }, [step, ucAskConfirm]);

  return (
    <div className="max-w-3xl mx-auto p-4 text-[var(--fg)]">
      <div className="glass-card border border-[var(--border)] rounded-xl p-4 flex flex-col gap-3 min-h-[60vh]">
        <div className="flex items-center gap-3 text-sm opacity-90">
          <BotAvatar size={40} />
          <div>
            <div className="font-semibold">Sure</div>
            <div className="opacity-70">Assistente de Requisicao</div>
          </div>
        </div>
        <div className="flex-1 flex flex-col gap-2 overflow-auto">
          {messages.map((m, i) => (
            <Bubble key={i} role={m.role}>{m.text}</Bubble>
          ))}

          {form.uc && (
            <Bubble role={BOT}>
              <div className="text-xs opacity-80">Resumo parcial</div>
              <div className="mt-1 whitespace-pre-wrap">{resumo()}</div>
            </Bubble>
          )}

          {step >= 4 && (
            <div className="mt-2">
              <div className="text-xs mb-1">Anexos (opcional)</div>
              <input ref={fileRef} type="file" multiple className="text-xs" />
            </div>
          )}

          {busy && <Typing />}
        </div>

        <div className="flex items-center gap-2">
          <input
            className="flex-1 px-3 py-2 rounded-md bg-[var(--panel)] border border-[var(--panel-border)]"
            placeholder={busy ? 'Aguarde...' : 'Digite aqui...'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
            disabled={busy || step >= 5}
          />
          <button
            className="px-4 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)] disabled:opacity-50"
            onClick={handleSend}
            disabled={busy || step >= 5}
          >Enviar</button>
        </div>

        <div className="flex flex-wrap gap-2">
          {chips.map((c, idx) => (
            <button key={idx} type="button" onClick={() => setInput(c.value)} className="text-xs px-2 py-1 rounded-full border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20">
              {c.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}


