// Serviço de Solicitações ao sistema (chat #sistema -> fila -> gestor aprova).
import api from './apiClient';

export const listarSolicitacoes = (status) =>
  api.get('/solicitacoes', { params: status ? { status } : {} }).then((r) => r.data?.data || []);

// Só os pedidos do próprio usuário — o chat usa p/ avisar quando ficam prontos.
export const minhasSolicitacoes = () =>
  api.get('/solicitacoes', { params: { mine: 1 } }).then((r) => r.data?.data || []);

export const criarSolicitacao = (mensagem, preview) =>
  api.post('/solicitacoes', { mensagem, preview }).then((r) => r.data);

export const aprovarSolicitacao = (id) =>
  api.put(`/solicitacoes/${id}/aprovar`).then((r) => r.data);

// Aprovador(es) designado(s). O backend é a autoridade (barra a aprovação por e-mail);
// no front usamos o próprio JWT (e-mail OU id de usuário) p/ mostrar/ocultar o painel —
// robusto, sem depender de endpoint. Para adicionar alguém, inclua e-mail ou id aqui.
export const APROVADORES = ['alisson.rodrigues@amee.com.br'];
export const APROVADORES_IDS = [1]; // id_usuario do Alisson

export const ehAprovador = (user) => {
  if (!user) return false;
  const email = String(user.email || '').trim().toLowerCase();
  const id = Number(user.user_id ?? user.id ?? user.id_usuario);
  return APROVADORES.includes(email) || APROVADORES_IDS.includes(id);
};

export const deletarSolicitacao = (id) =>
  api.delete(`/solicitacoes/${id}`).then((r) => r.data);

// Protocolo = id da solicitação. Mostra o pedido + log de alterações.
export const getProtocolo = (id) =>
  api.get(`/solicitacoes/${id}/protocolo`).then((r) => r.data);

export const reverterSolicitacao = (id) =>
  api.post(`/solicitacoes/${id}/reverter`).then((r) => r.data);

// O solicitante responde às perguntas simples do worker (status 'preciso_confirmar').
// respostas = array alinhado às perguntas; texto = resposta livre opcional.
export const responderConfirmacao = (id, respostas, texto) =>
  api.post(`/solicitacoes/${id}/responder-confirmacao`, { respostas, texto }).then((r) => r.data);
