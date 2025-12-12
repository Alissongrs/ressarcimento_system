// src/services/ocrService.js
import api from './apiClient';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wrapAxiosError(err, fallbackMsg = 'Falha na requisição') {
  const status = err?.response?.status || 0;
  const data = err?.response?.data;
  const headers = err?.response?.headers || {};
  const serverMsg =
    (typeof data === 'string' && data) ||
    data?.message ||
    data?.error ||
    data?.error?.message ||
    fallbackMsg;

  const e = new Error(serverMsg);
  e.status = status;
  e.data = data;

  if (status === 429) {
    e.code = 'rate_limited';
    e.retryAfter = headers['retry-after'] ? Number(headers['retry-after']) : undefined;
    e.limit = headers['x-ratelimit-limit'] ? Number(headers['x-ratelimit-limit']) : undefined;
    e.remaining = headers['x-ratelimit-remaining'] ? Number(headers['x-ratelimit-remaining']) : undefined;
    e.resetAt = headers['x-ratelimit-reset'] ? Number(headers['x-ratelimit-reset']) : undefined;
  }
  if (status === 401) e.code = 'unauthorized';
  if (status === 403) e.code = 'forbidden';
  if (status === 413) {
    e.code = 'payload_too_large';
    if (!e.message) e.message = 'Arquivo muito grande (413).';
  }
  if (!status && err?.message) e.message = err.message;
  return e;
}

export async function ocrAnalyze(files, instruction, opts = {}) {
  const fd = new FormData();
  for (const f of files || []) if (f) fd.append('files', f);
  if (instruction) fd.append('instruction', instruction);
  if (opts.useLocalRules) fd.append('apply_rules', '1');
  if (opts.rules?.length) fd.append('rules', JSON.stringify(opts.rules));
  if (opts.lang) fd.append('lang', opts.lang);
  if (opts.max_pages) fd.append('max_pages', String(opts.max_pages));

  try {
    const { data } = await api.post('/ocr/analyze', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  } catch (err) {
    throw wrapAxiosError(err, 'Falha ao enviar arquivos para OCR');
  }
}

/**
 * OCR Rápido (Stage 1): Apenas extração de texto sem IA
 * Retorna { request_id, results: [{ file_name, raw_text, pages_used, status }] }
 */
export async function ocrQuick(files, opts = {}) {
  const fd = new FormData();
  for (const f of files || []) if (f) fd.append('files', f);

  try {
    const { data } = await api.post('/ocr/quick', fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return data;
  } catch (err) {
    throw wrapAxiosError(err, 'Falha ao enviar arquivos para OCR rápido');
  }
}

/**
 * Interpretação com IA (Stage 2): Aplica regras ao texto OCR salvo
 * @param {string} requestId - ID retornado pelo /ocr/quick
 * @param {string} filename - Nome do arquivo
 * @param {string[]} rules - Lista de regras a aplicar (ex: ['BANDEIRA_ENEL_SP_GB', 'ICMS'])
 * @param {boolean} useLLM - Se true, também chama LLM para interpretação adicional
 */
export async function ocrInterpret(requestId, filename, rules = [], useLLM = false) {
  try {
    const { data } = await api.post('/ocr/interpret', {
      request_id: requestId,
      filename: filename,
      rules: rules,
      use_llm: useLLM,
    });
    return data;
  } catch (err) {
    throw wrapAxiosError(err, 'Falha ao interpretar OCR com IA');
  }
}

/**
 * Chat de IA: tenta com header Authorization e, se vier 401,
 * refaz automaticamente com ?token=<jwt> na URL (fallback).
 */
export async function ocrChat(messages, model, { retryOnceOn429 = true } = {}) {
  const token = (function() {
    try {
      return (
        localStorage.getItem('userToken') ||
        localStorage.getItem('token') ||
        localStorage.getItem('auth_token') ||
        localStorage.getItem('access_token') ||
        sessionStorage.getItem('token') ||
        ''
      );
    } catch { return ''; }
  })();

  const attempt = async (useQueryToken = false) => {
    const bases = ['/api/v1/ocr/chat', '/api/ocr/chat'];
    let lastErr;
    for (const basePath of bases) {
      const url = useQueryToken && token
        ? `${basePath}?token=${encodeURIComponent(token)}`
        : basePath;
      try {
        const { data } = await api.post(url, { messages, model });
        return data?.message ?? '';
      } catch (e) {
        lastErr = e; // tenta próxima base
      }
    }
    throw lastErr;
  };

  try {
    return await attempt(false);
  } catch (err) {
    const e = wrapAxiosError(err, 'Falha ao consultar IA (OCRChat)');

    // Se 401, tenta fallback por query token:
    if (e.status === 401 && token) {
      try {
        return await attempt(true);
      } catch (err2) {
        throw wrapAxiosError(err2, 'Falha no fallback com token na query (?token=)');
      }
    }

    // Retry único para 429
    if (e.status === 429 && retryOnceOn429) {
      const waitSec = Math.min(Math.max(Number(e.retryAfter || 2), 1), 10);
      await sleep(waitSec * 1000);
      try {
        return await attempt(false);
      } catch (err2) {
        throw wrapAxiosError(err2, 'Falha após retry (rate limit)');
      }
    }

    if (e.status === 401 && !e.message) e.message = 'Não autorizado (401). Faça login novamente.';
    if (e.status === 403 && !e.message) e.message = 'Acesso negado (403). Permissão insuficiente.';
    throw e;
  }
}
