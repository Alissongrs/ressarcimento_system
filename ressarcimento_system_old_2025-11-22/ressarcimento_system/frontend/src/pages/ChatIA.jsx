import React from 'react';
import { Wrench } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function ChatIA() {
  return (
    <div className="flex items-center justify-center h-[calc(100vh-100px)] p-4 md:p-8 bg-background text-foreground">
      <div className="max-w-lg w-full text-center glass-card gradient-card shadow-medium border rounded-xl p-8">
        <div className="mx-auto mb-4 w-14 h-14 rounded-full bg-[var(--border)]/30 flex items-center justify-center text-[var(--accent)]">
          <Wrench size={28} />
        </div>
        <h1 className="text-2xl font-semibold mb-2">Chat IA em construção</h1>
        <p className="opacity-70 mb-6">
          Estou preparando uma experiência de assistência inteligente.
          Em breve você poderá fazer perguntas em linguagem natural sobre os dados do sistema.
        </p>
        <div className="text-sm opacity-60 mb-6">
          Dica: Fique ligado!
        </div>
        <div className="flex items-center justify-center">
          <Link
            to="/"
            className="inline-flex items-center justify-center px-4 py-2 rounded-md bg-[var(--accent)] text-[var(--fg)] hover:opacity-90"
            title="Voltar ao início"
          >
            Voltar ao início
          </Link>
        </div>
      </div>
    </div>
  );
}
