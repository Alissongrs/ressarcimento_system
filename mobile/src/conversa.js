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
  const forcado = /^[#@]sistema\b/i.test(q);
  const pedido = q.replace(/^[#@]sistema[\s,:]*/i, '').trim();
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
