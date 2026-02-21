import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { getEmailsByProcessoID, enviarEmailProcesso, marcarEmailProcessoLido } from '../services/requisicaoService';
import { X, Send, History, Mail, User, Calendar, Paperclip } from 'lucide-react';
import ReactQuill from 'react-quill';
import 'react-quill/dist/quill.snow.css';

const EMAIL_EDITOR_MODULES = {
  toolbar: [
    ['bold', 'italic', 'underline', 'strike'],
    [{ list: 'ordered' }, { list: 'bullet' }],
    [{ align: [] }],
    ['link'],
    ['clean'],
  ],
};

const ModalEmail = ({ processo, onClose }) => {
  const [historicoEmails, setHistoricoEmails] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [view, setView] = useState('novo');

  const [para, setPara] = useState('');
  const [cc, setCc] = useState('');
  const [cco, setCco] = useState('');
  const [assunto, setAssunto] = useState(
    `Ressarcimento Unidade Consumidora: ${processo.uc?.String || processo.unidade_consumidora?.String || 'N/A'}`,
  );
  const [corpo, setCorpo] = useState(
    `Prezados,<br/><br/>Escrevemos para tratar do processo de ressarcimento referente à Unidade Consumidora nº ${processo.uc?.String || processo.unidade_consumidora?.String || 'N/A'}, sob a responsabilidade do cliente ${processo.cliente?.String || processo.nome_cliente?.String || 'N/A'}.<br/><br/>Nosso time identificou uma possível irregularidade e iniciou a análise do caso.<br/><br/>Gostaríamos de solicitar...<br/><br/>Atenciosamente,`,
  );
  const [anexos, setAnexos] = useState([]);

  const fetchEmails = async () => {
    try {
      setIsLoading(true);
      const data = await getEmailsByProcessoID(processo.id);
      const list = data || [];
      setHistoricoEmails(list);
      const ids = list.map((e) => e?.id_email ?? e?.ID ?? e?.id).filter(Boolean);
      if (ids.length) {
        await Promise.all(
          ids.map((id) =>
            marcarEmailProcessoLido(processo.id, id).catch(() => null),
          ),
        );
      }
    } catch (error) {
      console.error('Erro ao buscar histórico de e-mails:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchEmails();
  }, [processo.id]);

  const handleEnviar = async () => {
    if (!para) {
      alert('O campo "Para" é obrigatório.');
      return;
    }
    setIsSending(true);
    try {
      const fd = new FormData();
      fd.append('para', para);
      if (cc) fd.append('cc', cc);
      if (cco) fd.append('cco', cco);
      fd.append('assunto', assunto);
      const signatureHtml =
        '<br/><br/><img src="/assinatura_complaint.png" alt="assinatura" style="max-width:260px;height:auto;" />';
      const bodyWithSignature = corpo.includes('assinatura_complaint.png')
        ? corpo
        : `${corpo || ''}${signatureHtml}`;
      fd.append('corpo', bodyWithSignature);
      Array.from(anexos || []).forEach((f) => fd.append('anexos', f));
      await enviarEmailProcesso(processo.id, fd);
      alert('E-mail enviado com sucesso!');
      setView('historico');
      setAnexos([]);
      fetchEmails();
    } catch (error) {
      alert('Falha ao enviar o e-mail.');
    } finally {
      setIsSending(false);
    }
  };

  const formatarDataEmail = (dataISO) => {
    if (!dataISO) return '';
    return new Date(dataISO).toLocaleString('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'America/Sao_Paulo',
    });
  };
  const pickStr = (v) => (v && typeof v === 'object' && 'String' in v ? v.String : v) || '';

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
      <div className="glass-card rounded-lg border w-full max-w-6xl h-[90vh] flex flex-col">
        <div className="flex justify-between items-center p-4 border-b">
          <h2 className="text-xl font-bold text-[var(--fg)]">
            Gerenciador de E-mails - Processo #{processo.id}
          </h2>
          <button onClick={onClose} className="p-1 rounded-full opacity-70 hover:bg-[var(--border)]/20">
            <X size={24} />
          </button>
        </div>

        <div className="p-4 border-b flex gap-4">
          <button
            onClick={() => setView('novo')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
              view === 'novo'
                ? 'bg-[var(--accent)] text-[var(--fg)]'
                : 'bg-[var(--border)]/20 text-[var(--fg)] hover:bg-[var(--border)]/30'
            }`}
          >
            <Send size={16} /> Nova Mensagem
          </button>
          <button
            onClick={() => setView('historico')}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg ${
              view === 'historico'
                ? 'bg-[var(--accent)] text-[var(--fg)]'
                : 'bg-[var(--border)]/20 text-[var(--fg)] hover:bg-[var(--border)]/30'
            }`}
          >
            <History size={16} /> Histórico ({historicoEmails.length})
          </button>
        </div>

        {view === 'novo' ? (
          <div className="p-4 space-y-3 overflow-y-auto flex-grow flex flex-col">
            <input
              type="text"
              value={para}
              onChange={(e) => setPara(e.target.value)}
              placeholder="Para (use ; para múltiplos)"
              className="w-full p-2 border-b focus:outline-none focus:border-blue-500"
            />
            <div className="flex gap-4">
              <input
                type="text"
                value={cc}
                onChange={(e) => setCc(e.target.value)}
                placeholder="Cc (use ; para múltiplos)"
                className="w-1/2 p-2 border-b focus:outline-none focus:border-blue-500"
              />
              <input
                type="text"
                value={cco}
                onChange={(e) => setCco(e.target.value)}
                placeholder="Cco (use ; para múltiplos)"
                className="w-1/2 p-2 border-b focus:outline-none focus:border-blue-500"
              />
            </div>
            <input
              type="text"
              value={assunto}
              onChange={(e) => setAssunto(e.target.value)}
              placeholder="Assunto"
              className="w-full p-2 border-b focus:outline-none focus:border-blue-500"
            />
            <ReactQuill
              theme="snow"
              value={corpo}
              onChange={setCorpo}
              modules={EMAIL_EDITOR_MODULES}
              className="bg-[var(--panel)] text-[var(--fg)] rounded border panel-border min-h-[320px]"
            />
            <div className="rounded border panel-border bg-[var(--panel)]/20 p-2 text-xs">
              <div className="text-[11px] uppercase font-semibold opacity-70 mb-1">Assinatura fixa</div>
              <img src="/assinatura_complaint.png" alt="assinatura" className="max-w-[260px] h-auto" />
            </div>
            <div className="rounded border panel-border bg-[var(--panel)]/20 p-2 text-xs">
              <div className="text-[11px] uppercase font-semibold opacity-70 mb-1">Assinatura fixa</div>
              <img src="/assinatura_complaint.png" alt="assinatura" className="max-w-[260px] h-auto" />
            </div>
            <label className="flex items-center gap-2 text-sm opacity-80 cursor-pointer">
              <Paperclip size={16} />
              <span>Adicionar anexos (até 10MB cada)</span>
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => setAnexos(Array.from(e.target.files || []))}
              />
            </label>
            {anexos?.length > 0 && (
              <div className="text-xs opacity-70">
                {anexos.map((f) => f.name).join(', ')}
              </div>
            )}
            <div className="flex justify-start items-center pt-4">
              <button
                onClick={handleEnviar}
                disabled={isSending}
                className="px-6 py-2 bg-[var(--accent)] text-[var(--fg)] font-bold rounded-lg hover:opacity-90 disabled:opacity-50"
              >
                {isSending ? 'Enviando...' : 'Enviar'}
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 overflow-y-auto flex-grow ">
            {isLoading ? (
              <p>Carregando histórico...</p>
            ) : historicoEmails.length > 0 ? (
              historicoEmails.map((email) => (
                <div key={email.id_email} className="glass-card border rounded-lg p-4 mb-4">
                  <div className="grid grid-cols-2 gap-x-4 text-sm text-gray-600 border-b pb-3 mb-3">
                    <p className="flex items-center gap-2">
                      <User size={14} /> <strong>De:</strong> {email.de_email}
                    </p>
                    <p className="flex items-center gap-2">
                      <Mail size={14} /> <strong>Para:</strong> {email.para_email}
                    </p>
                    <p className="flex items-center gap-2">
                      <User size={14} /> <strong>Enviado por:</strong>{' '}
                      {pickStr(email.usuario_remetente) || 'Sistema'}
                    </p>
                    <p className="col-span-2 flex items-center gap-2">
                      <Calendar size={14} /> <strong>Data:</strong> {formatarDataEmail(email.data_envio)}
                    </p>
                    {Array.isArray(email.read_by) && email.read_by.length > 0 && (
                      <p className="col-span-2 flex items-center gap-2">
                        <User size={14} /> <strong>Lido por:</strong> {email.read_by.join(', ')}
                      </p>
                    )}
                  </div>
                  <h4 className="font-bold text-[var(--fg)] mb-2">
                    {pickStr(email.assunto) || pickStr(email.Assunto) || '(Sem Assunto)'}
                  </h4>
                  <div
                    className="whitespace-pre-wrap opacity-80 text-sm"
                    dangerouslySetInnerHTML={{
                      __html: pickStr(email.corpo).replace(/\n/g, '<br />'),
                    }}
                  />
                </div>
              ))
            ) : (
              <p className="text-center opacity-70 mt-8">Nenhum e-mail no histórico deste processo.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

ModalEmail.propTypes = {
  processo: PropTypes.object.isRequired,
  onClose: PropTypes.func.isRequired,
};

export default ModalEmail;
