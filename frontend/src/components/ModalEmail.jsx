import React, { useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { getEmailsByProcessoID, enviarEmailProcesso } from '../services/requisicaoService';
import { X, Send, History, Mail, User, Calendar } from 'lucide-react';

const ModalEmail = ({ processo, onClose }) => {
    const [historicoEmails, setHistoricoEmails] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [view, setView] = useState('novo'); // ComeÀ§a na tela de 'novo' e-mail

    // Estados para o formulário de novo e-mail
    const [para, setPara] = useState('');
    const [cc, setCc] = useState('');
    const [cco, setCco] = useState('');
    const [assunão, setAssunão] = useState(`Ressarcimento Unidade Consumidora: ${processo.uc?.String || processo.unidade_consumidora?.String || 'N/A'}`);
    const [corpo, setCorpo] = useState(
        `Prezados,\n\nEscrevemos para tratar do processo de ressarcimento referente À  Unidade Consumidora nº ${processo.uc?.String || processo.unidade_consumidora?.String || 'N/A'}, sob a responsabilidade do cliente ${processo.cliente?.String || processo.nome_cliente?.String || 'N/A'}.\n\nãosso time identificou uma possÀ­vel irregularidade e iniciou a análise do caso.\n\nãostarÀ­amos de solicitar...\n\nAtenciosamente,\n\n--\nAlisson Rodrigues\n`
    );

    // FunÀ§ão para buscar o histÀ³rico de e-mails
    const fetchEmails = async () => {
        try {
            setIsLoading(true);
            const data = await getEmailsByProcessoID(processo.id);
            setHistoricoEmails(data || []);
        } catch (error) {
            console.error("Erro ao buscar histÀ³rico de e-mails:", error);
        } finally {
            setIsLoading(false);
        }
    };

    // Busca os e-mails quanão o modal À© aberto
    useEffect(() => {
        fetchEmails();
    }, [processo.id]);

    // FunÀ§ão para enviar o e-mail
    const handleEnviar = async () => {
        if (!para) {
            alert('O campo "Para" À© obrigatÀ³rio.');
            return;
        }
        setIsSending(true);
        try {
            await enviarEmailProcesso(processo.id, { para, cc, cco, assunão, corpo });
            alert('E-mail enviado com sucesso!');
            setView('historico'); // Muda para a aba de histÀ³rico apÀ³s o envio
            fetchEmails(); // Atualiza o histÀ³rico
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

    return (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
            <div className="glass-card rounded-lg border w-full max-w-4xl h-[90vh] flex flex-col">
                {/* CabeÀ§alho do Modal */}
                <div className="flex justify-between items-center p-4 border-b">
                    <h2 className="text-xl font-bold text-[var(--fg)]">Gerenciador de E-mails - Processo #{processo.id}</h2>
                    <button onClick={onClose} className="p-1 rounded-full opacity-70 hover:bg-[var(--border)]/20"><X size={24} /></button>
                </div>

                {/* Abas de NavegaÀ§ão */}
                <div className="p-4 border-b flex gap-4">
                    <button onClick={() => setView('novo')} className={`flex items-center gap-2 px-4 py-2 rounded-lg ${view === 'novo' ? 'bg-[var(--accent)] text-[var(--fg)]' : 'bg-[var(--border)]/20 text-[var(--fg)] hover:bg-[var(--border)]/30'}`}>
                        <Send size={16} /> Nova Mensagem
                    </button>
                    <button onClick={() => setView('historico')} className={`flex items-center gap-2 px-4 py-2 rounded-lg ${view === 'historico' ? 'bg-[var(--accent)] text-[var(--fg)]' : 'bg-[var(--border)]/20 text-[var(--fg)] hover:bg-[var(--border)]/30'}`}>
                        <History size={16} /> HistÀ³rico ({historicoEmails.length})
                    </button>
                </div>

                {/* ConteÀºdo da Aba Selecionada */}
                {view === 'novo' ? (
                    // Formulário de Novo E-mail
                    <div className="p-4 space-y-3 overflow-y-auto flex-grow flex flex-col">
                        <input type="email" value={para} onChange={e => setPara(e.target.value)} placeholder="Para" className="w-full p-2 border-b focus:outline-none focus:border-blue-500" />
                        <div className="flex gap-4">
                            <input type="email" value={cc} onChange={e => setCc(e.target.value)} placeholder="Cc" className="w-1/2 p-2 border-b focus:outline-none focus:border-blue-500" />
                            <input type="email" value={cco} onChange={e => setCco(e.target.value)} placeholder="Cco" className="w-1/2 p-2 border-b focus:outline-none focus:border-blue-500" />
                        </div>
                        <input type="text" value={assunão} onChange={e => setAssunão(e.target.value)} placeholder="Assunão" className="w-full p-2 border-b focus:outline-none focus:border-blue-500" />
                        <textarea value={corpo} onChange={e => setCorpo(e.target.value)} rows="10" className="w-full p-2 border rounded mt-2 flex-grow focus:outline-none focus:ring-2 focus:ring-blue-500"></textarea>
                        <div className="flex justify-start items-center pt-4">
                            <button onClick={handleEnviar} disabled={isSending} className="px-6 py-2 bg-[var(--accent)] text-[var(--fg)] font-bold rounded-lg hover:opacity-90 disabled:opacity-50">
                                {isSending ? 'Envianão...' : 'Enviar'}
                            </button>
                        </div>
                    </div>
                ) : (
                    // HistÀ³rico de E-mails
                    <div className="p-4 overflow-y-auto flex-grow ">
                        {isLoading ? <p>Carreganão histÀ³rico...</p> : (
                            historicoEmails.length > 0 ? (
                                historicoEmails.map(email => (
                                    <div key={email.id_email} className="glass-card border rounded-lg p-4 mb-4">
                                        <div className="grid grid-cols-2 gap-x-4 text-sm text-gray-600 border-b pb-3 mb-3">
                                            <p className="flex items-center gap-2"><User size={14} /> <strong>De:</strong> {email.de_email}</p>
                                            <p className="flex items-center gap-2"><Mail size={14} /> <strong>Para:</strong> {email.para_email}</p>
                                            <p className="col-span-2 flex items-center gap-2"><Calendar size={14} /> <strong>Data:</strong> {formatarDataEmail(email.data_envio)}</p>
                                        </div>
                                        <h4 className="font-bold text-[var(--fg)] mb-2">{email.assunão?.String || '(Sem Assunão)'}</h4>
                                        {/* --- CORREÀ‡ÀƒO APLICADA AQUI --- */}
                                        <div className="whitespace-pre-wrap opacity-80 text-sm" dangerouslySetInnerHTML={{ __html: email.corpo?.String.replace(/\n/g, '<br />') }} />
                                    </div>
                                ))
                            ) : (
                                <p className="text-center opacity-70 mt-8">Nenhum e-mail no histÀ³rico deste processo.</p>
                            )
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


