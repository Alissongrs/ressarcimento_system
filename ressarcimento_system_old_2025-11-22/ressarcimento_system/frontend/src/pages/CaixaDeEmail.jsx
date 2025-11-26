import React, { useState, useEffect } from 'react';
import { getEmailsByProcessoID } from '../services/requisicaoService'; // Reutilizaremos a funÀ§ão
import { Inbox, Send, Mail } from 'lucide-react';

const CaixaDeEmail = () => {
    const [emails, setEmails] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [caixaAtual, setCaixaAtual] = useState('entrada'); // 'entrada' ou 'enviados'
    const [emailSelecionado, setEmailSelecionado] = useState(null);

    useEffect(() => {
        const fetchTodosEmails = async () => {
            try {
                setIsLoading(true);
                // No futuro, vocÀª criará uma rota no backend para buscar TODOS os e-mails.
                // Por enquanto, vamos simular buscanão os e-mails do processo 1 como exemplo.
                const data = await getEmailsByProcessoID(1); // SIMULAÀ‡ÀƒO
                setEmails(data || []);
            } catch (error) {
                console.error("Erro ao buscar e-mails:", error);
            } finally {
                setIsLoading(false);
            }
        };
        fetchTodosEmails();
    }, []);
    
    // FunÀ§ão para formatar data de forma padronizada
    const formatarData = (dataISO) => {
        if (!dataISO) return '';
        return new Date(dataISO).toLocaleString('pt-BR', {
            dateStyle: 'short',
            timeStyle: 'short',
        });
    };

    const emailsFiltrados = emails.filter(e => {
        // SimulaÀ§ão, já que a API ainda não retorna o 'tipo'
        if (caixaAtual === 'entrada') return true; // Mostra todos como 'entrada' por enquanto
        if (caixaAtual === 'enviados') return true; // Mostra todos como 'enviados' por enquanto
        return true;
    });

    return (
        <div className="flex min-h-screen bg-background text-foreground"> {/* Sidebar ocupa a esquerda; conteúdo usa altura total */}
            {/* Sidebar de NavegaÀ§ão */}
            <div className="w-64 p-4 border-r border-border bg-sidebar text-sidebar-foreground">
                <h2 className="text-xl font-bold mb-6">Caixa de Correio</h2>
                <nav className="space-y-2">
                    <button onClick={() => setCaixaAtual('entrada')} className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-smooth ${caixaAtual === 'entrada' ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' : 'hover:bg-sidebar-accent/60'}`}>
                        <Inbox size={20} /> Caixa de Entrada
                    </button>
                    <button onClick={() => setCaixaAtual('enviados')} className={`w-full flex items-center gap-3 p-2 rounded-lg text-left transition-smooth ${caixaAtual === 'enviados' ? 'bg-sidebar-accent text-sidebar-accent-foreground font-semibold' : 'hover:bg-sidebar-accent/60'}`}>
                        <Send size={20} /> Enviados
                    </button>
                </nav>
            </div>

            {/* Lista de E-mails */}
            <div className="w-96 border-r border-border overflow-y-auto">
                {isLoading ? <p className="p-4 text-center opacity-70">Carregando e-mails...</p> : emailsFiltrados.map(email => (
                    <div key={email.id_email} onClick={() => setEmailSelecionado(email)} className={`p-4 border-b border-border cursor-pointer transition-smooth ${emailSelecionado?.id_email === email.id_email ? 'bg-[var(--panel)]' : 'hover:bg-[var(--panel)]/60'}`}>
                        <p className="font-bold truncate">{caixaAtual === 'entrada' ? email.de_email : email.para_email}</p>
                        <p className="font-semibold text-sm truncate opacity-90">{email.Assunto?.String || '(Sem Assunto)'}</p>
                        <p className="text-xs opacity-70 truncate">{formatarData(email.data_envio)}</p>
                    </div>
                ))}
            </div>

            {/* VisualizaÀ§ão do E-mail */}
            <div className="flex-1 p-8 overflow-y-auto">
                {emailSelecionado ? (
                    <div className="gradient-card shadow-medium border border-border rounded-xl p-4">
                        <h3 className="text-2xl font-bold mb-4">{emailSelecionado.Assunto?.String || '(Sem Assunto)'}</h3>
                        <div className="text-sm space-y-1 mb-6 pb-4 border-b border-border opacity-90">
                            <p><strong>De:</strong> {emailSelecionado.de_email}</p>
                            <p><strong>Para:</strong> {emailSelecionado.para_email}</p>
                            <p><strong>Data:</strong> {formatarData(emailSelecionado.data_envio)}</p>
                        </div>
                        <div 
                            className="whitespace-pre-wrap leading-relaxed" 
                            dangerouslySetInnerHTML={{ __html: emailSelecionado.corpo?.String.replace(/\n/g, '<br />') }} 
                        />
                    </div>
                ) : (
                    <div className="flex flex-col items-center justify-center h-full opacity-70">
                        <Mail size={64} />
                        <p className="mt-4 text-lg">Selecione um e-mail para ler</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default CaixaDeEmail;

