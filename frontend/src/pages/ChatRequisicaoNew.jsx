// src/pages/ChatRequisicaoNew.jsx
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import RequisicaoForm from './RequisicaoForm.jsx';
import {
  buscarUC,
  criarRequisicao,
  buscarFaturasUC,               // fallback legado
  getUCOpcoes,
  contarFaturasPorIdUc,          // NOVO
  buscarFaturasPorIdUcMeses,     // NOVO
  getMesesPorIdUc,               // NOVO (atualmente não utilizado)
  listarTodasFaturasPorIdUc,     // NOVO (lista completa por combinação)
} from '../services/requisicaoService';

const BOT = 'bot';
const USER = 'user';

// Mensagem de contato para dúvidas (pode ser definida por env VITE_SUPPORT_TEXT)
const SUPPORT_TEXT = (import.meta?.env?.VITE_SUPPORT_TEXT || '').trim();
const DEFAULT_SUPPORT = 'Dúvidas? complaint@amee.com.br | WhatsApp +55 15 99747-7277.';
const CONTACT_TEXT = SUPPORT_TEXT || DEFAULT_SUPPORT;

/* ====================== UI AUXILIARES ====================== */
function BotAvatar({ size = 36 }) {
  const style = { width: size, height: size, fontSize: Math.max(12, Math.floor(size * 0.45)) };
  return (
    <div className="bot-avatar" style={style} title="Sure (Assistente)">
      <span className="bot-avatar__initial">S</span>
    </div>
  );
}

function Linkified({ text }) {
  const parts = [];
  const lines = String(text || '').split('\n');
  const re = /(https?:\/\/[^\s]+)|([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})|(\+?\d{0,2}\s?\(?\d{2}\)?\s?\d{4,5}-?\d{4})/g;
  const toWa = (raw) => {
    const d = String(raw || '').replace(/\s+/g, '').toUpperCase();
    if (!d) return null;
    if (d.startsWith('55')) return `https://wa.me/${d}`;
    return `https://wa.me/55${d}`;
  };
  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    let last = 0;
    let m; let idx = 0;
    // eslint-disable-next-line no-cond-assign
    while ((m = re.exec(line)) !== null) {
      const [full, url, email, phone] = m;
      if (m.index > last) parts.push(line.slice(last, m.index));
      if (url) {
        parts.push(
          <a
            key={`u-${li}-${idx++}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[var(--accent)] break-all"
          >
            {url}
          </a>
        );
      } else if (email) {
        parts.push(
          <a
            key={`e-${li}-${idx++}`}
            href={`mailto:${email}`}
            className="underline text-[var(--accent)]"
          >
            {email}
          </a>
        );
      } else if (phone) {
        const wa = toWa(phone);
        parts.push(
          <a
            key={`p-${li}-${idx++}`}
            href={wa || '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="underline text-[var(--accent)]"
          >
            {phone}
          </a>
        );
      }
      last = m.index + full.length;
    }
    if (last < line.length) parts.push(line.slice(last));
    if (li < lines.length - 1) parts.push(<br key={`br-${li}`} />);
  }
  return <>{parts}</>;
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
        {typeof children === 'string' ? <Linkified text={children} /> : children}
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div className="flex justify-start w-full">
      <div className="max-w-[85%] md:max-w-[70%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap shadow-sm bg-[var(--panel)] text-[var(--fg)] border border-[var(--panel-border)]">
        <div className="flex items-center gap-1">
          <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
        </div>
      </div>
    </div>
  );
}

/* ====================== FUNÇÕES DE NORMALIZAÇÃO ====================== */
const safe = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if ('String' in v) return v.String || '';
    if ('Value' in v) {
      try { return String(v.Value); } catch { return ''; }
    }
    try { return String(v); } catch { return ''; }
  }
  try { return String(v); } catch { return ''; }
};

// normalizadores (usados no fallback legado buscarUC):
const extractEmpresas = (obj) => {
  const pools = [
    obj?.empresas,
    obj?.Empresas,
    obj?.empresas_uc,
    obj?.empresas_da_uc,
    obj?.lista_empresas,
    obj?.EmpresasUC,
  ].filter(Array.isArray);
  const arr = pools.length ? pools[0] : [];
  const extra = [];
  if (!arr.length && obj && typeof obj === 'object') {
    Object.values(obj).forEach((v) => {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') {
        const f = v[0] || {};
        if ('id_empresa' in f || 'razao_social' in f || 'nome' in f || 'nome_fantasia' in f || 'razaoSocial' in f) {
          extra.push(...v);
        }
      }
    });
  }
  const list = arr.length ? arr : extra;
  return list
    .map((e) => ({
      id: safe(e.id_empresa || e.id || e.cod_empresa || e.codigo || e.cod),
      nome: safe(e.nome || e.razao || e.razao_social || e.razaoSocial || e.nome_fantasia),
    }))
    .filter((x) => x.id || x.nome);
};

const extractConcessionarias = (obj) => {
  const pools = [
    obj?.concessionarias,
    obj?.Concessionarias,
    obj?.lista_concessionarias,
    obj?.concess,
  ].filter(Array.isArray);
  const arr = pools.length ? pools[0] : [];
  const extra = [];
  if (!arr.length && obj && typeof obj === 'object') {
    Object.values(obj).forEach((v) => {
      if (Array.isArray(v) && v.length) {
        const first = v[0];
        if (typeof first === 'object') {
          if (('sigla' in first) || ('nome' in first) || ('id_concessionaria' in first)) extra.push(...v);
        } else if (typeof first === 'string') {
          extra.push(...v);
        }
      }
    });
  }
  const list = arr.length ? arr : extra;
  return list
    .map((c) => ({
      id: safe(c.id_concessionaria || c.id || ''),
      sigla: safe(c.sigla || c.Sigla || ''),
      nome: safe(c.nome || ''),
    }))
    .filter((x) => x.sigla || x.id);
};

/* ====================== PARSERS DE MESES ====================== */
const parseOneMonth = (raw) => {
  let mm = ''; let aa = '';
  const t = String(raw || '').trim().replace(/\s+/g, '').replace(/\./g, '/').replace(/-/g, '/');
  const seg = t.split('/');
  if (seg.length === 2) {
    if (seg[0].length === 4) { aa = seg[0]; mm = seg[1]; }
    else if (seg[1].length === 4) { mm = seg[0]; aa = seg[1]; }
  }
  if (mm && aa) return { mes: String(parseInt(mm, 10)).padStart(2, '0'), ano: aa };
  return null;
};

const expandMonths = (start, end) => {
  const out = [];
  if (!start || !end) return out;
  let y1 = parseInt(start.ano, 10), m1 = parseInt(start.mes, 10);
  let y2 = parseInt(end.ano, 10), m2 = parseInt(end.mes, 10);
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
    const token = part.toLowerCase().replace('ate', 'a');
    if (token.includes(' a ')) {
      const [iniRaw, fimRaw] = part.replace(/ate/gi, 'a').split(/\sa\s/);
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

/* ====================== COMPONENTE PRINCIPAL ====================== */
export default function ChatRequisicaoNew() {
  const { user } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState(0);
  const [awaitingInvoiceConfirm, setAwaitingInvoiceConfirm] = useState(false);

  // fluxo de confirmação
  const [ucConfirmStep, setUcConfirmStep] = useState(null); // 'chooseEmpresa' | 'chooseConcessionaria' | 'chooseOpcao' | 'chooseOrType' | 'chooseInvoiceList' | null
  const ucChoicesRef = useRef({ opcoes: [], empresas: [], concessionarias: [], months: [], invoices: [] });
  const ucEmpresaRowsRef = useRef([]); // linhas filtradas para resolver id_uc após escolher concessionária

  const [form, setForm] = useState({
    prioridade: 'Baixa',
    uc: '',                 // número que o usuário digitou (unidade)
    id_uc: '',              // id_uc resolvido (ex.: 2549)
    id_empresa: '',
    cliente: '',
    concessionaria: '',     // nome ou sigla
    ressarcimentoEstimado: '',
    descricaoIrregularidade: '',
    linkFatura: '',
  });
  const [periodos, setPeriodos] = useState([]);
  const [faturas, setFaturas] = useState([]);
  const [pickedIdxs, setPickedIdxs] = useState([]);               // meses (lista) – hoje não usado, mas mantido
  const [pickedInvoiceIdxs, setPickedInvoiceIdxs] = useState([]); // seleção de faturas individuais
  const [manualPromptActive, setManualPromptActive] = useState(false);
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [manualInitialUc, setManualInitialUc] = useState('');

  const fileRef = useRef(null);
  const bootRef = useRef(false);
  const mountedRef = useRef(true);

  const ucResolved = useRef({ id_uc: '', id_empresa: '', id_concessionaria: '' });
  // Removido fluxo de seleção de ano para evitar chamada ao backend que gerava 500
  const yearChoicesRef = useRef([]); // legado (não utilizado)
  const ucDisplayRef = useRef({ unidade: '', empresa: '', conc: '', ano: '' });

  const push = (role, text) => setMessages((m) => [...m, { role, text }]);
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const botSay = async (text, ms = 900) => { await sleep(ms); push(BOT, text); };
  const showTypingPause = async (ms = 1000) => { setBusy(true); await sleep(ms); setBusy(false); };

  // ciclo de vida
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // mensagem inicial
  useEffect(() => {
    if (messages.length > 0 || bootRef.current) return;
    bootRef.current = true;
    (async () => {
      const first = (user?.nome ? String(user.nome).split(' ')[0] : '').trim();
      const h = new Date().getHours();
      const hi = h < 12 ? 'bom dia' : (h < 18 ? 'boa tarde' : 'boa noite');
      await botSay(`Olá, ${hi}${first ? ' ' + first : ''}! Eu sou a Sure, sua assistente na abertura de requisições.`);
      await showTypingPause(700);
      await botSay('Trabalhamos somente com número de unidade consumidora (UC).');
      if (CONTACT_TEXT) await botSay(CONTACT_TEXT, 400);
      await botSay('Para começar, envie o número da sua UC (apenas dígitos).');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ============ helpers/handlers ============ */

  // pede período já mostrando a contagem por id_uc
  const perguntarPeriodoComContagem = useCallback(async () => {
    const idUc = form.id_uc || ucResolved.current.id_uc;
    if (idUc) {
      try {
        const total = await contarFaturasPorIdUc(idUc);
        if (Number(total) > 0) await botSay(`Para esta combinação, encontrei ${total} fatura(s) cadastrada(s).`, 500);
      } catch { /* ignore */ }
    }
    await botSay('Agora informe o período das faturas que deseja analisar. Ex.: "07-2024, 08-2024" ou "07-2024 a 09-2024".', 900);
  }, [form.id_uc]);

  // fluxo "lista": mostrar todas as faturas da combinação (checkboxes)
  const abrirListaDeFaturas = useCallback(async () => {
    // Evita reabrir o painel se já estamos na seleção de faturas
    if (ucConfirmStep === 'chooseInvoiceList') return;
    const iduc = ucResolved.current.id_uc || form.id_uc;
    const emp = ucResolved.current.id_empresa || form.id_empresa;
    // "cli" pode representar id_concess (cliente) OU id_concessionaria (fallback)
    const cli =
      ucResolved.current.id_concess ||
      form.id_concess ||
      ucResolved.current.id_concessionaria ||
      form.id_concessionaria;

    if (!iduc || !emp || !cli) {
      await botSay('Antes, selecione o CLIENTE e a CONCESSIONÁRIA.');
      return;
    }
    try {
      const dados = await listarTodasFaturasPorIdUc(iduc, emp, cli);
      const lista = Array.isArray(dados?.faturas) ? dados.faturas : [];
      if (!lista.length) {
        await botSay('Não encontrei faturas para esta combinação.');
        return;
      }
      ucChoicesRef.current.invoices = lista;
      setPickedInvoiceIdxs([]);
      setUcConfirmStep('chooseInvoiceList');
      // Não enviar mensagem extra aqui para não duplicar visualmente a lista
      setAwaitingInvoiceConfirm(false);
    } catch {
      await botSay('Não consegui listar as faturas agora.');
    }
  }, [form.id_uc, form.id_empresa, form.id_concess, form.id_concessionaria, ucConfirmStep]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    push(USER, text);
    setBusy(true);
    try {
      const lower = text.toLowerCase();

      // Confirmação de faturas selecionadas: aguarda "confirmar" ou "voltar"
      if (awaitingInvoiceConfirm) {
        if (lower.includes('voltar')) {
          setAwaitingInvoiceConfirm(false);
          setUcConfirmStep('chooseInvoiceList');
          await botSay('Ok, ajuste a seleção e clique em "Confirmar faturas" novamente.');
          return;
        }
        if (lower.includes('confirmar')) {
          setAwaitingInvoiceConfirm(false);
          setUcConfirmStep(null);
          // Avança no fluxo: pedir valor estimado
          await botSay('Perfeito! Qual o valor estimado do ressarcimento (R$)?');
          setStep(2);
          return;
        }
        await botSay('Digite "confirmar" para seguir ou "voltar" para ajustar a seleção.');
        return;
      }

      /* =================== Fluxos de confirmação pendentes =================== */

      if (ucConfirmStep === 'chooseEmpresa') {
        const n = parseInt(text, 10);
        const escolhido = (ucChoicesRef.current.empresas || []).find((x) => x.idx === n);
        if (!escolhido) { await botSay('Informe um número válido da lista.'); return; }

        const base = (ucChoicesRef.current.opcoes || []).filter((r) => String(r.id_empresa) === String(escolhido.id));
        ucEmpresaRowsRef.current = base;

        // concessionárias únicas
        const concMap = new Map();
        (base || []).forEach((r) => {
          const id = String(r.id_concessionaria || '').trim();
          const sigla = String(r.conc_sigla || '').trim();
          const nome = String(r.conc_nome || '').trim();
          const id_uc = String(r.id_uc || '').trim();
          const key = (id || '') + '::' + (sigla ? sigla.toLowerCase() : nome.toLowerCase());
          if (!concMap.has(key)) concMap.set(key, { id, nome, sigla, id_uc });
        });
        const concessList = Array.from(concMap.values());
        ucChoicesRef.current.concessionarias = concessList.map((c, i) => ({
          idx: i + 1,
          id: c.id,
          nome: c.nome,
          sigla: c.sigla,
          id_uc: c.id_uc,
        }));

        // Cliente selecionado → no banco é id_empresa
        setForm((s) => ({ ...s, id_empresa: escolhido.id, cliente: escolhido.nome }));
        ucResolved.current.id_empresa = String(escolhido.id);
        ucDisplayRef.current.empresa = escolhido.nome;
        ucDisplayRef.current.unidade = form.uc;

        await botSay(
          [
            'Selecione a concessionária digitando o número:',
            ...ucChoicesRef.current.concessionarias.map(
              (x) => `${x.idx}) ${x.nome || '-'}${x.sigla ? ` (${x.sigla})` : ''}`,
            ),
          ].join('\n')
        );
        setUcConfirmStep('chooseConcessionaria');
        return;
      }

      if (ucConfirmStep === 'chooseConcessionaria') {
        const n = parseInt(text, 10);
        const escolhido = (ucChoicesRef.current.concessionarias || []).find((x) => x.idx === n);
        if (!escolhido) { await botSay('Informe um número válido da lista.'); return; }

        const match = (ucEmpresaRowsRef.current || []).find(
          (r) =>
            String(r.id_concessionaria) === String(escolhido.id) ||
            String(r.conc_sigla || '').toLowerCase() === String(escolhido.sigla || '').toLowerCase(),
        );

        const idUcFinal = String(
          match?.id_uc ||
          escolhido.id_uc ||
          ucResolved.current.id_uc ||
          form.id_uc ||
          ''
        );
        const idConcFinal = String(match?.id_concessionaria || escolhido.id || ''); // no banco: concessionária

        setForm((s) => ({
          ...s,
          concessionaria: escolhido.nome || escolhido.sigla || s.concessionaria,
          id_uc: idUcFinal,
          id_concessionaria: idConcFinal || s.id_concessionaria,
        }));

        ucResolved.current.id_uc = idUcFinal;
        ucResolved.current.id_concessionaria = idConcFinal;
        ucDisplayRef.current.conc = escolhido.nome || escolhido.sigla || '';

        await botSay(
          [
            'Concessionária selecionada:',
            `Unidade: ${form.uc || ucDisplayRef.current.unidade || '-'}`,
            `Cliente: ${form.cliente || ucDisplayRef.current.empresa || '-'}`,
            `Concessionária: ${escolhido.nome || '-'}${escolhido.sigla ? ` (${escolhido.sigla})` : ''}`,
          ].join('\n'),
          600
        );

        // Oferecer diretamente "lista" (faturas) ou digitar período (sem etapa de ano)
        await botSay(
          'Deseja selecionar meses em uma lista (digite "lista") ou digitar o período?\n' +
          'Dica: ao abrir a lista, marque as faturas desejadas e clique em "Confirmar faturas" para continuar.',
        );
        setUcConfirmStep('chooseOrType');
        return;
      }

      // Etapa de ano removida (não usada)

      if (ucConfirmStep === 'chooseOpcao') {
        const n = parseInt(text, 10);
        const escolhido = (ucChoicesRef.current.opcoes || []).find((x) => x.idx === n);
        if (!escolhido) { await botSay('Informe um número válido da lista.'); return; }

        setForm((s) => ({
          ...s,
          uc: s.uc || escolhido.id_uc,
          id_empresa: escolhido.id_empresa,
          cliente: escolhido.cliente || s.cliente,
        }));
        ucResolved.current.id_empresa = String(escolhido.id_empresa);
        ucDisplayRef.current.unidade = form.uc || escolhido.id_uc;
        ucDisplayRef.current.empresa = escolhido.cliente || '';

        const base = (ucChoicesRef.current.opcoes || []).filter(
          (r) => String(r.id_empresa) === String(escolhido.id_empresa),
        );
        ucEmpresaRowsRef.current = base;
        const concMap = new Map();
        base.forEach((r) => {
          const id = String(r.id_concessionaria || '').trim();
          const sigla = String(r.conc_sigla || '').trim();
          const nome = String(r.conc_nome || '').trim();
          const key = id || (sigla ? ('sigla:' + sigla.toLowerCase()) : ('nome:' + nome.toLowerCase()));
          if (!concMap.has(key)) concMap.set(key, { id, nome, sigla });
        });

        await botSay(
          [
            'Selecione a concessionária digitando o número:',
            ...ucChoicesRef.current.concessionarias.map(
              (x) =>
                `${x.idx}) ${x.nome || '-'}${
                  (x.sigla && !/\s/.test(x.sigla) && x.sigla.length <= 8) ? ` (${x.sigla})` : ''
                }`,
            ),
          ].join('\n')
        );
        setUcConfirmStep('chooseConcessionaria');
        return;
      }

      if (ucConfirmStep === 'chooseOrType') {
        if (lower.includes('lista')) {
          // Por pedido do usuário, "lista" abre a lista de faturas (checkboxes), não de meses
          await abrirListaDeFaturas();
          return;
        }
        // Se não digitou "lista", tentamos interpretar como período
        const meses = parseMeses(text);
        if (meses.length === 0) {
          await botSay('Digite meses válidos (ex.: 07-2024, 08-2024 ou 07-2024 a 09-2024) ou escreva "lista".');
          return;
        }
        setPeriodos(meses);
        const refs = mesesRefs(meses);
        let det = [];
        try {
          const dados = await buscarFaturasPorIdUcMeses(
            ucResolved.current.id_uc || form.id_uc,
            refs,
            ucResolved.current.id_empresa || form.id_empresa || '',
            ucResolved.current.id_concessionaria || form.id_concessionaria || '',
          );
          if (Array.isArray(dados?.faturas)) {
            det = dados.faturas.map((f) => ({
              link: f.link ?? f.Link?.String ?? f.Link,
              mes_ref: f.mes_ref ?? f.MesRef?.String ?? f.MesRef,
              dt_vencimento: f.dt_vencimento ?? f.DtVenc ?? f.Dt_Vencimento,
              valor_total: f.valor_total ?? f.ValorTotal,
            }));
          }
        } catch { /* ignore */ }
        const lista = Array.isArray(det) ? det.filter(Boolean) : [];
        setFaturas(lista);
        await botSay(
          lista.length
            ? `Perfeito! Encontrei ${lista.length} fatura(s). Qual o valor estimado do ressarcimento (R$)?`
            : 'Não localizei faturas nesses meses. Mesmo assim, qual o valor estimado do ressarcimento (R$)?',
        );
        setStep(2);
        setUcConfirmStep(null);
        return;
      }

      /* =================== Fluxo principal por passos =================== */

      // STEP 0: usuário digitou a UC
      if (step === 0) {
        const uc = text.replace(/\s+/g, '').toUpperCase();
        if (!uc) { await botSay('Não encontrei nenhum número. Para prosseguir, informe a UC (apenas dígitos).'); return; }
        setForm((s) => ({ ...s, uc }));
        ucDisplayRef.current.unidade = uc;

        // tenta endpoint dedicado de opções
        let opcoes = [];
        try { opcoes = await getUCOpcoes(uc); } catch {}

        if (Array.isArray(opcoes) && opcoes.length) {
          // normaliza linhas (cada linha é uma combinação UC/Empresa/Concessionária com id_uc específico)
          const norm = opcoes.map((o, i) => ({
            idx: i + 1,
            id_uc: String(o.id_uc || o.idUc || ''),
            id_empresa: String(o.id_empresa || o.empresa_id || o.idEmpresa || ''),
            id_concessionaria: String(o.id_concessionaria || o.id_concess || o.idConcessionaria || ''),
            cliente: safe(o.cliente || o.nome_cliente || o.razao_social || o.razaoSocial || o.nome || o.nome_fantasia),
            conc_nome: safe(o.concessionaria || o.Rz_Social || ''),
            conc_sigla: safe(o.sigla || o.Sigla || ''),
          }));

          // agrupa empresas (id + nome)
          const keySet = new Set();
          const empresas = [];
          norm.forEach((r) => {
            const nomeLimpo = (r.cliente || '').trim();
            if (!nomeLimpo) return; // ignora entradas sem nome de cliente
            const key = `${r.id_empresa}::${nomeLimpo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()}`;
            if (!keySet.has(key)) {
              keySet.add(key);
              empresas.push({ id: r.id_empresa, nome: nomeLimpo });
            }
          });

          ucChoicesRef.current.opcoes = norm;
          ucChoicesRef.current.empresas = empresas.map((e, i) => ({ idx: i + 1, id: e.id, nome: e.nome }));

          await botSay(
            [
              'Encontrei mais de uma combinação para esta UC. Primeiro, escolha o CLIENTE digitando o número:',
              ...ucChoicesRef.current.empresas.map((x) => `${x.idx}) ${x.nome}`),
            ].join('\n')
          );
          setUcConfirmStep('chooseEmpresa');
          return;
        }

        // Fallback legado: buscarUC
        let dados = null;
        try { dados = await buscarUC(uc, []); } catch {}

        if (!dados || Object.keys(dados).length === 0) {
          await botSay('UC não encontrada. Verifique o número e tente novamente.');
          setManualPromptActive(true);
          setManualInitialUc(uc);
          return;
        }

        // Se a API já devolver id_uc/id_empresa direto, pula escolhas
        const idUcDirect = dados.id_uc || dados.IDUC;
        const idEmpDirect = dados.id_empresa || dados.IDEmpresa;
        const idConcDirect = dados.id_concessionaria || dados.IDConcessionaria;

        if (idUcDirect && idEmpDirect) {
          setForm((s) => ({
            ...s,
            id_uc: String(idUcDirect),
            id_empresa: String(idEmpDirect),
            uc: s.uc || uc,
          }));
          setManualPromptActive(false);
          setManualInitialUc('');
          ucResolved.current = {
            id_uc: String(idUcDirect),
            id_empresa: String(idEmpDirect),
            id_concessionaria: idConcDirect ? String(idConcDirect) : (ucResolved.current.id_concessionaria || ''),
          };
          ucDisplayRef.current.unidade = uc;

          try {
            const total = await contarFaturasPorIdUc(String(idUcDirect));
            if (Number.isFinite(total)) await botSay(`${total} faturas encontradas.`, 500);
          } catch { /* ignore */ }

          await botSay('Deseja selecionar meses em uma lista (digite "lista") ou digitar o período?');
          setUcConfirmStep('chooseOrType');
          return;
        }


        // monta empresas e concessionárias (fallback)
        const empresas = extractEmpresas(dados);
      
        const concess = extractConcessionarias(dados);

        if (empresas.length > 1) {
          ucChoicesRef.current.empresas = empresas.map((e, i) => ({ idx: i + 1, id: e.id, nome: e.nome }));
          await botSay(
            [
              'Encontrei mais de um CLIENTE para esta UC. Escolha digitando o número:',
              ...ucChoicesRef.current.empresas.map((x) => `${x.idx}) ${x.nome}`),
            ].join('\n')
          );
          setUcConfirmStep('chooseEmpresa');
          return;
        }

        // se só houver uma empresa válida, preenchê-la e pedir concessionária
        if (empresas[0] && empresas[0].nome) {
          setForm((s) => ({
            ...s,
            id_empresa: empresas[0].id || s.id_empresa,
            cliente: empresas[0].nome || s.cliente,
          }));
          ucResolved.current.id_empresa = String(empresas[0].id || '');
          ucDisplayRef.current.empresa = empresas[0].nome || '';
        }

        if (concess.length >= 1) {
          ucChoicesRef.current.concessionarias = concess.map((c, i) => ({
            idx: i + 1,
            id: c.id || '',
            nome: c.nome || c.sigla,
            sigla: c.sigla,
          }));
          await botSay(
            [
              'Selecione a concessionária:',
              ...ucChoicesRef.current.concessionarias.map((x) => `${x.idx}) ${x.nome}`),
            ].join('\n')
          );
          setUcConfirmStep('chooseConcessionaria');
          return;
        }

        // Sem concessões -> vai direto pedir período
        await perguntarPeriodoComContagem();
        setStep(1);
        return;
      }

      // STEP 1: recebe meses, busca faturas por id_uc (com fallback)
      if (step === 1) {
        // Comando rápido: "ver faturas" (sem informar meses)
        if (lower.includes('ver') && lower.includes('fatura')) {
          try {
            const iduc = ucResolved.current.id_uc || form.id_uc || '';
            const unidade = form.uc || '';
            let arr = [];
            try {
              if (iduc) {
                const dadosId = await buscarFaturasPorIdUcMeses(
                  iduc,
                  [],
                  ucResolved.current.id_empresa || form.id_empresa || '',
                  ucResolved.current.id_concessionaria || form.id_concessionaria || '',
                );
                if (dadosId && Array.isArray(dadosId.faturas)) arr = dadosId.faturas;
              }
              if (!arr.length && unidade) {
                const dadosUc2 = await buscarFaturasUC(unidade, []);
                if (dadosUc2 && Array.isArray(dadosUc2.faturas)) arr = dadosUc2.faturas;
              }
            } catch { /* ignore */ }
            if (arr.length) {
              const lines = arr.slice(0, 10).map((f, i) => {
                const mr = String(f.mes_ref || '').slice(0, 7);
                const venc = f.dt_vencimento || '-';
                const val = (f.valor_total != null) ? String(f.valor_total) : '-';
                const link = f.link || '';
                return `${i + 1}. ${mr} | Venc: ${venc} | Valor: ${val} | ${link}`;
              }).join('\n');
              await botSay(
                `Faturas disponíveis (recentes):\n${lines}${arr.length > 10 ? `\n... (mostrando 10 de ${arr.length})` : ''}`,
              );
            } else {
              await botSay('Não encontrei faturas recentes para esta UC.');
            }
          } catch { /* ignore */ }
          await botSay('Qual o valor estimado do ressarcimento (R$)?');
          setStep(2);
          return;
        }

        const meses = parseMeses(text);
        if (meses.length === 0) {
          await botSay(
            'Envie meses válidos (separe por vírgula) ou um intervalo. Ex.: 07-2024, 08-2024 ou 07-2024 a 09-2024.',
          );
          return;
        }
        setPeriodos(meses);
        const refs = mesesRefs(meses);

        let det = [];
        try {
          // 1) por id_uc + id_empresa + id_concessionaria na Faturas_Implantadas
          const dados = await buscarFaturasPorIdUcMeses(
            ucResolved.current.id_uc || form.id_uc,
            refs,
            ucResolved.current.id_empresa || form.id_empresa || '',
            ucResolved.current.id_concessionaria || form.id_concessionaria || '',
          );
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
            det = [{ link: dados.link ?? '', mes_ref: dados.mes_ref ?? '' }];
          }

          // 2) fallback por UC (string) se nada veio
          if (!det.length && (form.id_uc || form.uc)) {
            const alt = await buscarFaturasUC(form.uc, refs);
            if (Array.isArray(alt?.faturas)) {
              det = alt.faturas.map((f) => ({
                link: f.link ?? f.Link?.String ?? f.Link,
                mes_ref: f.mes_ref ?? f.MesRef?.String ?? f.MesRef,
                dt_vencimento: f.dt_vencimento ?? f.DtVencimento ?? f.Dt_Venc,
                valor_total: f.valor_total ?? f.ValorTotal,
              }));
            }
            if (!det.length && (form.uc || ucResolved.current.id_uc)) {
              try {
                const alt2 = await buscarFaturasUC(form.uc || ucResolved.current.id_uc, []);
                if (Array.isArray(alt2?.faturas)) {
                  det = alt2.faturas.map((f) => ({
                    link: f.link ?? f.Link?.String ?? f.Link,
                    mes_ref: f.mes_ref ?? f.MesRef?.String ?? f.MesRef,
                    dt_vencimento: f.dt_vencimento ?? f.DtVencimento ?? f.Dt_Venc,
                    valor_total: f.valor_total ?? f.ValorTotal,
                  }));
                }
              } catch { /* ignore */ }
            }
          }
        } catch { /* ignore */ }

        const lista = Array.isArray(det) ? det.filter(Boolean) : [];
        setFaturas(lista);
        const qtd = lista.length;

        if (qtd > 0) {
          const lines = lista.slice(0, 10).map((f, i) => {
            const mr = (f.mes_ref || '').slice(0, 7);
            const venc = f.dt_vencimento || '-';
            const val = f.valor_total != null ? String(f.valor_total) : '-';
            const link = f.link || '';
            return `${i + 1}. ${mr} | Venc: ${venc} | Valor: ${val} | ${link}`;
          }).join('\n');
          await botSay(
            `Faturas encontradas:\n${lines}${lista.length > 10 ? `\n... (mostrando 10 de ${lista.length})` : ''}`,
          );
          await botSay(`Perfeito! Encontrei ${qtd} fatura(s). Qual o valor estimado do ressarcimento (R$)?`, 700);
        } else {
          await botSay(
            'Não localizei faturas nesses meses. Mesmo assim, qual o valor estimado do ressarcimento (R$)?',
            700,
          );
        }
        setStep(2);
        return;
      }

      // STEP 2: valor estimado
      if (step === 2) {
        const val = Number(String(text).replace(/\./g, '').replace(',', '.'));
        if (!Number.isFinite(val) || val <= 0) { push(BOT, 'Informe um valor numérico maior que zero.'); return; }
        setForm((s) => ({ ...s, ressarcimentoEstimado: String(val) }));
        await botSay('Certo. Agora descreva brevemente a irregularidade.');
        setStep(3);
        return;
      }

      // STEP 3: descrição
      if (step === 3) {
        setForm((s) => ({ ...s, descricaoIrregularidade: text }));
        await botSay(
          'Se quiser, anexe arquivos agora (campo abaixo). Quando estiver tudo certo, envie "confirmar" para finalizar.',
        );
        setStep(4);
        return;
      }

      // STEP 4: confirmar envio
      if (step === 4) {
        if (!lower.includes('confirm')) {
          push(
            BOT,
            'Para enviar, digite "confirmar". Se preferir, podemos ajustar alguma informação antes.',
          );
          return;
        }
        const fd = new FormData();
        Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
        const periodosForm = periodos.map((p) => ({ mes: Number(p.mes), ano: p.ano }));
        fd.append('periodosIrregularidade', JSON.stringify(periodosForm));
        fd.append('RessarcimentoEstimado', form.ressarcimentoEstimado);
        fd.append('comentario', form.descricaoIrregularidade || '');
        // Anexa faturas selecionadas (se houver)
        try {
          const itens = Array.isArray(faturas) ? faturas : [];
          if (itens.length > 0) {
            const payload = itens.map((f) => ({
              link: String(f?.link || f?.link_fatura || f?.Link?.String || f?.Link || ''),
              mes_ref: String(f?.mes_ref || f?.MesRef?.String || f?.MesRef || ''),
              dt_vencimento: String(f?.dt_vencimento || f?.DtVenc || f?.Dt_Vencimento || ''),
              valor_total: (f?.valor_total ?? f?.ValorTotal ?? null),
            })).filter((x) => x.link || x.mes_ref);
            if (payload.length > 0) fd.append('faturas', JSON.stringify(payload));
          }
        } catch {}
        const files = fileRef.current?.files || [];
        for (let i = 0; i < files.length; i += 1) fd.append('anexos', files[i]);
        try {
          await criarRequisicao(fd);
          await botSay('Requisição enviada com sucesso!', 600);
          if (CONTACT_TEXT) { await botSay(CONTACT_TEXT, 700); }
          setStep(5);
        } catch {
          await botSay('Não consegui enviar agora. Verifique os dados e tente novamente.', 700);
        }
        return;
      }
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    input,
    step,
    form,
    periodos,
    awaitingInvoiceConfirm,
    ucConfirmStep,
    abrirListaDeFaturas,
    perguntarPeriodoComContagem,
  ]);

  /* ============ UI derivada ============ */
  const chips = useMemo(() => {
    const arr = [];
    // Atalho: botão "Lista" quando o assistente pergunta lista vs digitar
    if (ucConfirmStep === 'chooseOrType') {
      arr.push({ label: 'Lista', value: 'lista' });
    }
    if (step === 2) {
      ['500', '1000', '2500'].forEach((v) => arr.push({ label: 'R$ ' + v, value: v }));
    } else if (step === 3) {
      ['Oscilações de energia', 'Cobrança indevida', 'Falha no medidor'].forEach((v) =>
        arr.push({ label: v, value: v }),
      );
    } else if (step === 4) {
      arr.push({ label: 'Confirmar envio', value: 'confirmar' });
    }
    return arr;
  }, [step, ucConfirmStep]);

  const ResumoBox = () => (
    <div className="w-full md:w-80 border border-[var(--panel-border)] bg-[var(--panel)] text-[var(--fg)] rounded-lg p-3">
      <div className="text-sm font-semibold mb-2">Resumo</div>
      <div className="text-xs space-y-1">
        <div><span className="opacity-70">Unidade:</span> {form.uc || '-'}</div>
        <div><span className="opacity-70">Cliente:</span> {form.cliente || '-'}</div>
        <div><span className="opacity-70">Concessionária:</span> {form.concessionaria || '-'}</div>
        <div>
          <span className="opacity-70">Meses:</span>{' '}
          {periodos.length ? periodos.map((p) => `${p.mes}/${p.ano}`).join(', ') : '-'}
        </div>
        <div><span className="opacity-70">Faturas:</span> {faturas.length || 0}</div>
        <div><span className="opacity-70">Valor estimado:</span> {form.ressarcimentoEstimado || '-'}</div>
        <div><span className="opacity-70">Descrição:</span> {form.descricaoIrregularidade || '-'}</div>
      </div>
    </div>
  );

  /* ============ RENDER ============ */
  return (
    <>
      <div className="max-w-3xl mx-auto p-4 bg-background text-foreground min-h-screen">
        <div className="glass-card gradient-card shadow-medium border border-[var(--border)] rounded-xl p-4 flex flex-col gap-3 min-h-[60vh]">
          <div className="flex items-center gap-3 text-sm opacity-90">
            <BotAvatar size={40} />
            <div>
              <div className="font-semibold">Sure</div>
              <div className="opacity-70">Assistente de Requisição</div>
            </div>
          </div>

          <div className="flex flex-col md:flex-row md:items-start md:gap-4">
            <div className="flex-1 min-w-0 flex flex-col gap-2 overflow-auto pb-32">
              {messages.map((m, i) => (
                <Bubble key={i} role={m.role}>
                  {m.text}
                </Bubble>
              ))}

              {step >= 4 && (
                <div className="mt-2">
                  <div className="text-xs mb-1">Anexos (opcional)</div>
                  <input ref={fileRef} type="file" multiple className="text-xs" />
                </div>
              )}

              {busy && <Typing />}
            </div>
          </div>

          {/* Lista de faturas (checkboxes) */}
          {ucConfirmStep === 'chooseInvoiceList' && (
            <div className="mt-3 p-3 rounded-md border border-[var(--panel-border)] bg-[var(--panel)] text-sm">
              <div className="font-semibold mb-2">Selecione as faturas</div>
              <div className="text-xs opacity-80 mb-2">
                Marque as faturas desejadas e clique em <strong>Confirmar faturas</strong>.
              </div>
              <div className="max-h-48 overflow-auto space-y-1 mb-3">
                {(() => {
                  const raw = Array.isArray(ucChoicesRef.current.invoices)
                    ? ucChoicesRef.current.invoices
                    : [];
                  const map = new Map();
                  for (const f of raw) {
                    const k = `${String(f?.mes_ref || '')}-${String(f?.dt_vencimento || '')}-${String(
                      f?.link || '',
                    )}`;
                    if (!map.has(k)) map.set(k, f);
                  }
                  return Array.from(map.values());
                })().map((f, i) => (
                  <label key={i} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={pickedInvoiceIdxs.includes(i)}
                      onChange={(e) => {
                        const checked = !!e.target.checked;
                        setPickedInvoiceIdxs((arr) =>
                          checked
                            ? Array.from(new Set([...(arr || []), i]))
                            : (arr || []).filter((x) => x !== i),
                        );
                      }}
                    />
                    <span>
                      {String(f.mes_ref || '').slice(0, 7)} | Venc: {f.dt_vencimento || '-'} | Valor:{' '}
                      {f.valor_total ?? '-'}
                    </span>
                  </label>
                ))}
              </div>
              {!awaitingInvoiceConfirm && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-2 py-1 text-xs rounded border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20"
                  onClick={() => {
                    const inv = Array.isArray(ucChoicesRef.current.invoices)
                      ? ucChoicesRef.current.invoices
                      : [];
                    // Selecionar todos
                    setPickedInvoiceIdxs(inv.map((_, idx) => idx));
                  }}
                >
                  Selecionar todos
                </button>
                <button
                  type="button"
                  className="px-3 py-1 text-xs rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                  onClick={async () => {
                    const inv = Array.isArray(ucChoicesRef.current.invoices)
                      ? ucChoicesRef.current.invoices
                      : [];
                    const picks = pickedInvoiceIdxs.filter(
                      (n) => Number.isFinite(n) && n >= 0 && n < inv.length,
                    );
                    if (!picks.length) { await botSay('Nenhuma fatura selecionada.'); return; }
                    const itens = picks.map((n) => inv[n]).filter(Boolean);
                    setFaturas(itens);
                    setAwaitingInvoiceConfirm(true);
                  }}
                >
                  Confirmar faturas
                </button>
                <button
                  type="button"
                  className="px-2 py-1 text-xs rounded border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20"
                  onClick={() => {
                    setUcConfirmStep(null);
                    setPickedInvoiceIdxs([]);
                  }}
                >
                  Cancelar
                </button>
              </div>
              )}
              {awaitingInvoiceConfirm && (
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    className="px-3 py-1 text-xs rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold"
                    onClick={async () => {
                      // Finaliza confirmação via botão (equivalente a digitar "confirmar")
                      setAwaitingInvoiceConfirm(false);
                      setUcConfirmStep(null);
                      await botSay('Perfeito! Qual o valor estimado do ressarcimento (R$)?');
                      setStep(2);
                    }}
                  >
                    Confirmar
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1 text-xs rounded border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20"
                    onClick={async () => {
                      // Volta para a lista para ajustar seleção
                      setAwaitingInvoiceConfirm(false);
                      await botSay('Ok, ajuste a seleção e clique em "Confirmar faturas" novamente.');
                      setUcConfirmStep('chooseInvoiceList');
                    }}
                  >
                    Voltar
                  </button>
                </div>
              )}
            </div>
          )}

          {manualPromptActive && (
            <div className="mt-3 p-3 rounded-md border border-dashed border-amber-500 bg-amber-50 text-sm text-amber-900 space-y-2">
              <p>UC não encontrada. Deseja tentar novamente ou preencher manualmente?</p>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="px-3 py-1 text-xs rounded border border-[var(--panel-border)]"
                  onClick={() => {
                    setManualPromptActive(false);
                  }}
                >
                  Tentar novamente
                </button>
                <button
                  type="button"
                  className="px-3 py-1 text-xs rounded border bg-[var(--accent)] text-[var(--fg)]"
                  onClick={() => {
                    setManualModalOpen(true);
                    setManualPromptActive(false);
                    setManualInitialUc(form.uc);
                  }}
                >
                  Preencher manualmente
                </button>
              </div>
            </div>
          )}
          {step >= 5 && (
            <div className="mt-3 p-3 rounded-md border border-[var(--panel-border)] bg-[var(--panel)] text-sm">
              <div className="mb-2">Caso queira iniciar uma nova requisição, clique abaixo.</div>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-3 py-2 rounded-md bg-[var(--accent)] text-white hover:opacity-90"
              >
                Reiniciar conversa
              </button>
            </div>
          )}

          <div className="flex flex-wrap gap-2 mt-3">
            {chips.map((c, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setInput(c.value)}
                className="text-xs px-2 py-1 rounded-full border border-[var(--panel-border)] hover:bg-[var(--panel-border)]/20"
              >
                {c.label}
              </button>
            ))}
          </div>

          <div className="h-40" />

          {/* Barra de entrada fixa */}
          <div className="fixed left-0 right-0 bottom-4 z-[100]">
            <div className="max-w-3xl mx-auto px-3">
              <div className="flex items-center gap-2 rounded-xl border border-[var(--panel-border)] bg-[var(--card)]/90 backdrop-blur shadow-lg px-4 py-2">
                <input
                  className="flex-1 px-3 py-2 rounded-lg bg-[var(--panel)] border border-[var(--panel-border)]"
                  placeholder={busy ? 'Aguarde...' : 'Digite aqui...'}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSend(); }}
                  disabled={busy || step >= 5}
                />
                <button
                  className="px-4 py-2 rounded-lg bg-[var(--accent)] text-[var(--fg)] disabled:opacity-50"
                  onClick={handleSend}
                  disabled={busy || step >= 5}
                >
                  Enviar
                </button>
              </div>
            </div>
          </div>

        </div>
      </div>

      {/* Resumo lateral */}
      <div className="hidden lg:block fixed right-4 top-24 z-[6000] w-80 max-w-[90vw]">
        <ResumoBox />
      </div>
      {manualModalOpen && (
        <div className="fixed inset-0 bg-black/60 z-[7000] flex items-center justify-center px-4">
          <div className="bg-[var(--bg)] border border-[var(--border)] rounded-xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-auto">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[var(--border)]">
              <div className="text-lg font-semibold">Requisição manual</div>
              <button
                type="button"
                className="px-3 py-1 rounded border text-xs"
                onClick={() => {
                  setManualModalOpen(false);
                  setManualPromptActive(false);
                }}
              >
                Fechar
              </button>
            </div>
            <div className="p-4">
              <RequisicaoForm
                initialUc={manualInitialUc}
                manualMode
                onClose={() => {
                  setManualModalOpen(false);
                  setManualPromptActive(false);
                  setManualInitialUc('');
                }}
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

