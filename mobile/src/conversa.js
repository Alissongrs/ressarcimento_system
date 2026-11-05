// Cérebro da conversa — o MESMO para o chat escrito e para o modo voz:
//  1) há um pedido esperando "sim/não"? → envia ou cancela;
//  2) a frase é um COMANDO (alterar, relatório, rodar…)? → prévia + pergunta "posso enviar?";
//  3) senão é PERGUNTA → /chat/processos (IA com os dados do banco, só leitura).
import { api } from './api';

export const CHAT_KEY = 'sure_m_chat';
export const carregarChat = () => { try { return JSON.parse(localStorage.getItem(CHAT_KEY) || '[]'); } catch { return []; } };
export const salvarChat = (msgs) => { try { localStorage.setItem(CHAT_KEY, JSON.stringify(msgs.slice(-60))); } catch { /* ignore */ } };

let SEQ = 0;
export const mid = () => `${Date.now().toString(36)}-${++SEQ}`;

const SIM = /^\s*(sim|pode|pode sim|isso|confirmo|confirma|manda|envia|ok|okay|beleza|claro)\b/i;
const NAO = /^\s*(n[ãa]o|cancela\w*|esquece|deixa|para)\b/i;

// devolve { msgs: [novas mensagens do assistente], pendente, fala }
// fala = o que dizer em voz alta (modo voz)
export async function responder(q, { historico, pendente, voz = false }) {
  if (pendente) {
    if (SIM.test(q)) return enviarPedido(pendente.pedido);
    if (NAO.test(q)) return { msgs: [{ role: 'assistant', content: 'Pedido cancelado — nada foi enviado.' }], pendente: null, fala: 'Tudo bem, cancelei. Nada foi enviado.' };
    // falou outra coisa: o pedido anterior fica de lado e a frase nova segue normal
  }
  const { forcado, pedido } = montarPedido(q, historico);
  let it = null;
  try { it = await api('/solicitacoes/interpretar', { method: 'POST', body: { mensagem: pedido } }); } catch { it = null; }
  if (it && (it.comando || forcado)) {
    const consulta = !!it.leitura;
    let cab = consulta ? `🔎 **Consulta ao sistema** (sem aprovação):\n\n"${pedido}"\n` : `📋 **Pedido ao sistema** (vai para aprovação):\n\n"${pedido}"\n`;
    if (it.pode_executar && it.preview) cab += consulta ? `\n**O que vou levantar:**\n${it.preview}\n` : `\n**Prévia:**\n${it.preview}\n\n_Depois da aprovação o sistema executa, com backup._\n`;
    else if (!consulta) cab += `\nVai para **execução manual** depois da aprovação${it.motivo ? ` (${it.motivo})` : ''}.\n`;
    if (!consulta) cab += `\n⚠️ Nada é alterado sem aprovação.`;
    const fala = consulta
      ? `Entendi: é uma consulta ao sistema, ${pedido}. Não precisa de aprovação. Posso enviar? Diga sim ou não.`
      : `Entendi o pedido: ${pedido}. Ele vai para aprovação antes de executar. Posso enviar? Diga sim ou não.`;
    return { msgs: [{ role: 'assistant', content: cab, confirmar: true }], pendente: { pedido, consulta }, fala };
  }
  const d = await api('/chat/processos', { method: 'POST', body: { question: q, history: historico, modo: voz ? 'voz' : undefined } });
  const ans = d?.answer || 'Sem resposta.';
  return { msgs: [{ role: 'assistant', content: ans }], pendente: null, fala: paraFala(ans) };
}

// "nova tarefa: …", "coloque/registre/crie um pedido…", "quero que você altere…" → pedido ao
// sistema (sem depender da IA de perguntas, que não registra nada). "Isso que eu te pedi" leva
// junto o que a pessoa tinha falado antes.
const RE_PEDIR = new RegExp([
  '^\\s*(?:por favor,?\\s*)?(?:[#@]sistema\\b|nova\\s+tarefa\\b)',
  '\\b(?:quero|preciso|gostaria)\\s+(?:que\\s+(?:voc[êe]|vc)\\s+)?(?:coloque|registre|crie|abra|lance|cadastre|altere|mude|atualize|mova|rode|execute)\\b',
  '\\b(?:coloque|coloca|colocar|registre|registra|registrar|crie|cria|criar|abra|abre|abrir|lance|lan[çc]a|lan[çc]ar|cadastre|cadastra|cadastrar|fa[çc]a|faz)\\s+(?:um|uma|o|a|esse|essa|isso|l[áa])?\\s*(?:um\\s+|uma\\s+)?(?:pedido|tarefa|solicita[çc][ãa]o|chamado)\\b',
  '\\b(?:pode|consegue)\\s+(?:colocar|registrar|criar|abrir|lan[çc]ar)\\s+(?:um|uma|o|a|esse|essa|isso)?\\s*(?:pedido|tarefa|solicita[çc][ãa]o)\\b',
].join('|'), 'i');
const RE_REFERE = /\b(isso|isto|esse pedido|essa tarefa|o que (eu )?(te )?(pedi|falei|disse)|que eu (te )?(pedi|falei|disse)|como (eu )?(te )?(pedi|falei))\b/i;

export function montarPedido(q, historico = []) {
  if (!RE_PEDIR.test(q)) return { forcado: false, pedido: q.trim() };
  let pedido = q.replace(/^\s*(?:por favor,?\s*)?(?:[#@]sistema|nova\s+tarefa)[\s,:-]*/i, '').trim() || q.trim();
  if (RE_REFERE.test(q)) {
    const antes = historico.filter((m) => m.role === 'user').slice(-3).map((m) => m.content).filter((t) => t && t !== q);
    if (antes.length) pedido = `${pedido}\n\nContexto (o que eu tinha falado antes): ${antes.map((t) => `"${t}"`).join(' / ')}`;
  }
  return { forcado: true, pedido };
}

export async function enviarPedido(pedido) {
  const d = await api('/solicitacoes', { method: 'POST', body: { mensagem: pedido } });
  const consulta = d?.precisa_aprovacao === false;
  return {
    msgs: [{
      role: 'assistant',
      content: consulta
        ? `🔎 Pedido **#${d?.id || ''}** é uma consulta — já estou levantando. O resultado aparece em **Pedidos**.`
        : `✅ Pedido **#${d?.id || ''}** registrado e enviado para aprovação. Acompanhe em **Pedidos**.`,
      pedido: d?.id,
    }],
    pendente: null,
    fala: consulta
      ? `Pronto, enviei. É o pedido ${d?.id || ''}; o resultado vai aparecer na aba Pedidos.`
      : `Pronto, o pedido ${d?.id || ''} foi para aprovação. Você acompanha na aba Pedidos.`,
  };
}

// Markdown → texto bom de ouvir: sem tabelas, links, símbolos; corta respostas longas.
export function paraFala(md) {
  let t = String(md || '');
  const temTabela = /^\s*\|.*\|\s*$/m.test(t);
  t = t.replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/([.,]){2,}/g, '$1')
    .trim();
  if (t.length > 700) {
    const corte = t.slice(0, 700);
    t = corte.slice(0, Math.max(corte.lastIndexOf('. '), 400) + 1) + ' O restante está no chat.';
  } else if (temTabela) t += ' Os detalhes estão na tabela do chat.';
  return t || 'Pronto.';
}
