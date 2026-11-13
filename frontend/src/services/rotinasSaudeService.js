// src/services/rotinasSaudeService.js
// Saúde das rotinas (cron da VPS + agendador do backend). Só administradores.
// Backend: handlers/v2/rotinas_saude.go + pacote saude.
import apiV2 from './apiV2';

// GET /rotinas/saude → { agora, itens, aviso, whatsapp_conectado, usuarios }
export async function obterSaude() {
  const { data } = await apiV2.get('/rotinas/saude');
  return data;
}

// GET /rotinas/saude/execucoes?rotina=&n= → { itens }
export async function listarExecucoes(rotina = '', n = 30) {
  const { data } = await apiV2.get('/rotinas/saude/execucoes', { params: { rotina, n } });
  return data?.itens || [];
}

// POST /rotinas/saude/aviso { id_usuario, celular } → { ok, aviso }
export async function definirAviso(idUsuario, celular) {
  const { data } = await apiV2.post('/rotinas/saude/aviso', { id_usuario: Number(idUsuario) || 0, celular: celular || '' });
  return data;
}

// POST /rotinas/saude/aviso/testar → { ok, canais }
export async function testarAviso() {
  const { data } = await apiV2.post('/rotinas/saude/aviso/testar');
  return data;
}
