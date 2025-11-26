import React from 'react';
import { MessageSquare } from 'lucide-react';

export default function FeedbackButton({ onClick }) {
  return (
    <button
      type="button"
      title="Enviar feedback"
      onClick={onClick}
      className="w-full flex px-4 py-3 rounded-md transition-colors items-center justify-center hover:text-[var(--accent)] hover:bg-[var(--border)]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40"
    >
      <MessageSquare size={32} className="w-8 h-8 shrink-0" />
    </button>
  );
}
