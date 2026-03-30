import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  Wand2,
  Save,
  FileDown,
  Mail,
  Loader2,
  CheckCircle,
  AlertTriangle,
  Send,
  Sparkles,
  FileText,
} from 'lucide-react';
import {
  getTese,
  gerarTese,
  salvarTese,
  downloadTesePDF,
  getTesePDFBlob,
  enviarEmailTese,
  gerarEmailTese,
} from '../services/teseService';

const ModalTese = ({ processo, onClose }) => {
  const processoId = processo?.id;

  // Estado da tese
  const [conteudo, setConteudo] = useState('');
  const [teseExiste, setTeseExiste] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [gerando, setGerando] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [convertendo, setConvertendo] = useState(false);

  // Aba ativa
  const [aba, setAba] = useState('editor'); // 'editor' | 'email'

  // Estado do email
  const [emailPara, setEmailPara] = useState('');
  const [emailCc, setEmailCc] = useState('');
  const [emailAssunto, setEmailAssunto] = useState('');
  const [emailCorpo, setEmailCorpo] = useState('');
  const [gerandoEmail, setGerandoEmail] = useState(false);
  const [enviandoEmail, setEnviandoEmail] = useState(false);

  // Feedback
  const [msg, setMsg] = useState(null); // { tipo: 'ok'|'erro', texto }

  const editorRef = useRef(null);

  /* ── carrega tese existente ─────────────────────────────────────── */
  useEffect(() => {
    if (!processoId) return;
    setCarregando(true);
    getTese(processoId)
      .then((data) => {
        if (data.existe) {
          setConteudo(data.conteudo);
          setTeseExiste(true);
        }
      })
      .catch(() => {})
      .finally(() => setCarregando(false));
  }, [processoId]);

  /* ── helpers ────────────────────────────────────────────────────── */
  const flash = (tipo, texto, ms = 4000) => {
    setMsg({ tipo, texto });
    setTimeout(() => setMsg(null), ms);
  };

  /* ── ações da tese ──────────────────────────────────────────────── */
  const handleGerar = async () => {
    if (
      teseExiste &&
      !window.confirm('Já existe uma tese salva. Deseja substituí-la com uma nova gerada pela IA?')
    )
      return;
    setGerando(true);
    setMsg(null);
    try {
      const data = await gerarTese(processoId);
      setConteudo(data.conteudo || '');
      flash('ok', 'Tese gerada pela IA. Revise e salve quando estiver pronto.');
    } catch (e) {
      flash('erro', 'Erro ao gerar tese: ' + (e?.response?.data?.error || e.message));
    } finally {
      setGerando(false);
    }
  };

  const handleSalvar = async () => {
    if (!conteudo.trim()) {
      flash('erro', 'O conteúdo está vazio.');
      return;
    }
    setSalvando(true);
    try {
      await salvarTese(processoId, conteudo);
      setTeseExiste(true);
      flash('ok', 'Tese salva com sucesso.');
    } catch (e) {
      flash('erro', 'Erro ao salvar: ' + (e?.response?.data?.error || e.message));
    } finally {
      setSalvando(false);
    }
  };

  const handleDownloadPDF = async () => {
    if (!teseExiste) {
      flash('erro', 'Salve a tese antes de converter em PDF.');
      return;
    }
    setConvertendo(true);
    try {
      await downloadTesePDF(processoId);
    } catch (e) {
      flash('erro', 'Erro ao gerar PDF: ' + (e?.response?.data?.error || e.message));
    } finally {
      setConvertendo(false);
    }
  };

  /* ── ações do email ─────────────────────────────────────────────── */
  const handleGerarEmail = async () => {
    setGerandoEmail(true);
    try {
      const data = await gerarEmailTese(processoId);
      setEmailAssunto(data.assunto || '');
      setEmailCorpo(data.corpo || '');
      flash('ok', 'E-mail gerado pela IA. Revise antes de enviar.');
    } catch (e) {
      flash('erro', 'Erro ao gerar e-mail: ' + (e?.response?.data?.error || e.message));
    } finally {
      setGerandoEmail(false);
    }
  };

  const handleEnviarEmail = async () => {
    if (!emailPara.trim()) {
      flash('erro', 'Informe o destinatário.');
      return;
    }
    if (!teseExiste) {
      flash('erro', 'Salve a tese antes de enviar por e-mail.');
      return;
    }
    setEnviandoEmail(true);
    try {
      await enviarEmailTese(processoId, {
        para: emailPara,
        cc: emailCc,
        assunto: emailAssunto,
        corpo: emailCorpo,
      });
      flash('ok', 'E-mail enviado com sucesso! A tese em PDF foi anexada automaticamente.');
    } catch (e) {
      flash('erro', 'Erro ao enviar: ' + (e?.response?.data?.error || e.message));
    } finally {
      setEnviandoEmail(false);
    }
  };

  const handleConverterEnviar = async () => {
    if (!teseExiste) {
      flash('erro', 'Salve a tese antes de enviar por e-mail.');
      return;
    }
    setAba('email');
    if (!emailAssunto) {
      setEmailAssunto(`Pedido de Ressarcimento — Processo ${processoId}`);
    }
  };

  /* ── render ─────────────────────────────────────────────────────── */
  return (
    <div className="fixed inset-0 bg-black/60 flex justify-center items-start z-50 p-4 overflow-y-auto">
      <div className="glass-card rounded-xl border border-[var(--border)] w-full max-w-5xl my-4 flex flex-col">
        {/* Cabeçalho */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <FileText size={20} className="text-[var(--accent)]" />
            <div>
              <h2 className="text-lg font-bold text-[var(--header-fg)]">
                Tese Técnico-Jurídica
              </h2>
              <p className="text-xs opacity-60">
                Processo #{processoId}
                {processo?.cliente && ` — ${processo.cliente}`}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-full hover:bg-[var(--border)]/30 transition"
          >
            <X size={22} />
          </button>
        </div>

        {/* Abas */}
        <div className="flex gap-1 px-4 pt-3 border-b border-[var(--border)]">
          <button
            onClick={() => setAba('editor')}
            className={[
              'px-4 py-2 text-sm rounded-t-md font-medium transition',
              aba === 'editor'
                ? 'bg-[var(--accent)] text-white'
                : 'opacity-60 hover:opacity-90 hover:bg-[var(--border)]/20',
            ].join(' ')}
          >
            Editor da Tese
          </button>
          <button
            onClick={() => setAba('email')}
            className={[
              'px-4 py-2 text-sm rounded-t-md font-medium transition flex items-center gap-2',
              aba === 'email'
                ? 'bg-[var(--accent)] text-white'
                : 'opacity-60 hover:opacity-90 hover:bg-[var(--border)]/20',
            ].join(' ')}
          >
            <Mail size={14} />
            Enviar por E-mail
          </button>
        </div>

        {/* Mensagem de feedback */}
        {msg && (
          <div
            className={[
              'mx-4 mt-3 px-4 py-3 rounded-lg text-sm flex items-center gap-2',
              msg.tipo === 'ok'
                ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
                : 'bg-red-500/15 text-red-400 border border-red-500/30',
            ].join(' ')}
          >
            {msg.tipo === 'ok' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            {msg.texto}
          </div>
        )}

        {/* ── ABA EDITOR ──────────────────────────────────────────── */}
        {aba === 'editor' && (
          <>
            {/* Barra de ações */}
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
              <button
                onClick={handleGerar}
                disabled={gerando}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition disabled:opacity-50"
                title="Gera a tese completa com IA usando os dados do processo"
              >
                {gerando ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Wand2 size={15} />
                )}
                {gerando ? 'Gerando…' : 'Gerar com IA'}
              </button>

              <button
                onClick={handleSalvar}
                disabled={salvando || !conteudo.trim()}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition disabled:opacity-50"
              >
                {salvando ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Save size={15} />
                )}
                {salvando ? 'Salvando…' : 'Salvar'}
              </button>

              <div className="h-6 w-px bg-[var(--border)] mx-1" />

              <button
                onClick={handleDownloadPDF}
                disabled={convertendo || !teseExiste}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--border)] panel-bg-60 hover:opacity-90 text-sm font-medium transition disabled:opacity-40"
                title={!teseExiste ? 'Salve a tese primeiro' : 'Baixar PDF'}
              >
                {convertendo ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <FileDown size={15} />
                )}
                Converter para PDF
              </button>

              <button
                onClick={handleConverterEnviar}
                disabled={!teseExiste}
                className="flex items-center gap-2 px-4 py-2 rounded-lg border border-[var(--border)] panel-bg-60 hover:opacity-90 text-sm font-medium transition disabled:opacity-40"
                title={!teseExiste ? 'Salve a tese primeiro' : 'Converter e enviar por e-mail'}
              >
                <Mail size={15} />
                Converter + Enviar E-mail
              </button>

              {teseExiste && (
                <span className="ml-auto text-xs opacity-50 flex items-center gap-1">
                  <CheckCircle size={12} className="text-emerald-400" />
                  Tese salva
                </span>
              )}
            </div>

            {/* Área do editor */}
            <div className="p-4 flex-1">
              {carregando ? (
                <div className="flex items-center justify-center h-64 opacity-60">
                  <Loader2 size={24} className="animate-spin mr-2" />
                  Carregando…
                </div>
              ) : (
                <textarea
                  ref={editorRef}
                  value={conteudo}
                  onChange={(e) => setConteudo(e.target.value)}
                  className="w-full h-[55vh] rounded-lg border border-[var(--border)] bg-[var(--input-bg,var(--bg))] text-[var(--fg)] p-4 font-mono text-sm leading-relaxed resize-none focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
                  placeholder={
                    gerando
                      ? 'Aguardando resposta da IA…'
                      : 'Clique em "Gerar com IA" para criar a tese automaticamente, ou escreva/cole o conteúdo aqui.'
                  }
                  spellCheck={false}
                />
              )}
              <p className="text-xs opacity-40 mt-2">
                {conteudo.length > 0
                  ? `${conteudo.length} caracteres · ${conteudo.split('\n').length} linhas`
                  : 'Editor vazio'}
              </p>
            </div>
          </>
        )}

        {/* ── ABA EMAIL ───────────────────────────────────────────── */}
        {aba === 'email' && (
          <div className="p-4 space-y-4">
            {!teseExiste && (
              <div className="px-4 py-3 rounded-lg bg-amber-500/15 text-amber-400 border border-amber-500/30 text-sm flex items-center gap-2">
                <AlertTriangle size={15} />
                Você precisa salvar a tese antes de enviar por e-mail. Vá para a aba
                "Editor", salve e volte aqui.
              </div>
            )}

            <div className="flex items-center justify-between">
              <p className="text-sm opacity-70">
                O PDF da tese será gerado automaticamente e anexado ao e-mail.
              </p>
              <button
                onClick={handleGerarEmail}
                disabled={gerandoEmail || !teseExiste}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition disabled:opacity-50"
              >
                {gerandoEmail ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                {gerandoEmail ? 'Gerando…' : 'Gerar e-mail com IA'}
              </button>
            </div>

            {/* Campos do email */}
            <div className="grid gap-3">
              <div>
                <label className="block text-xs font-medium opacity-70 mb-1">
                  Para <span className="text-red-400">*</span>
                </label>
                <input
                  type="email"
                  value={emailPara}
                  onChange={(e) => setEmailPara(e.target.value)}
                  placeholder="destinatario@distribuidora.com.br"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--input-bg,var(--bg))] text-[var(--fg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
                />
              </div>

              <div>
                <label className="block text-xs font-medium opacity-70 mb-1">CC</label>
                <input
                  type="text"
                  value={emailCc}
                  onChange={(e) => setEmailCc(e.target.value)}
                  placeholder="copia@empresa.com.br"
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--input-bg,var(--bg))] text-[var(--fg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
                />
              </div>

              <div>
                <label className="block text-xs font-medium opacity-70 mb-1">Assunto</label>
                <input
                  type="text"
                  value={emailAssunto}
                  onChange={(e) => setEmailAssunto(e.target.value)}
                  placeholder={`Pedido de Ressarcimento — Processo ${processoId}`}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--input-bg,var(--bg))] text-[var(--fg)] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
                />
              </div>

              <div>
                <label className="block text-xs font-medium opacity-70 mb-1">
                  Corpo do E-mail
                </label>
                <textarea
                  value={emailCorpo}
                  onChange={(e) => setEmailCorpo(e.target.value)}
                  placeholder="Conteúdo do e-mail (suporta HTML simples)"
                  rows={8}
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--input-bg,var(--bg))] text-[var(--fg)] px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50"
                />
              </div>
            </div>

            {/* Rodapé do email */}
            <div className="flex items-center justify-between pt-2 border-t border-[var(--border)]">
              <p className="text-xs opacity-50 flex items-center gap-1">
                <FileDown size={12} />
                PDF anexado automaticamente: tese-processo-{processoId}.pdf
              </p>
              <button
                onClick={handleEnviarEmail}
                disabled={enviandoEmail || !emailPara.trim() || !teseExiste}
                className="flex items-center gap-2 px-5 py-2 rounded-lg bg-[var(--accent)] hover:opacity-90 text-white text-sm font-medium transition disabled:opacity-40"
              >
                {enviandoEmail ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <Send size={15} />
                )}
                {enviandoEmail ? 'Enviando…' : 'Enviar E-mail com PDF'}
              </button>
            </div>
          </div>
        )}

        {/* Rodapé */}
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-[var(--border)] text-sm hover:opacity-80 transition"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};

export default ModalTese;
