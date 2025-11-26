// src/pages/Welcome.jsx
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, Zap, BarChart3, ShieldCheck, FileSpreadsheet, Workflow } from 'lucide-react';

export default function Welcome() {
  const navigate = useNavigate();

  const cards = [
    {
      icon: <Workflow size={22} />,
      title: 'Fluxos Automatizados',
      text: 'Menos tarefas repetitivas e mais tempo para análise. O sistema orquestra etapas, prazos e notificações.',
    },
    {
      icon: <BarChart3 size={22} />,
      title: 'Visão e Métricas',
      text: 'Dashboards, histórico e rastreabilidade em um só lugar — decisões com dados, não suposições.',
    },
    {
      icon: <ShieldCheck size={22} />,
      title: 'Padronização e Segurança',
      text: 'Processos consistentes, permissões por perfil e menos erros humanos que planilhas dispersas.',
    },
  ];

  const compare = [
    {
      icon: <FileSpreadsheet size={18} />,
      bad: true,
      title: 'Controle por Excel',
      bullets: [
        'Versões conflitantes e risco de sobrescrever',
        'Falta de rastreabilidade e histórico pobre',
        'Escala limitada e colaboração frágil',
      ],
    },
    {
      icon: <Bot size={18} />,
      good: true,
      title: 'Sistema de Automação',
      bullets: [
        'Centralização, histórico completo e auditoria',
        'Alertas, SLA e follow-up automáticos',
        'Integração e crescimento sem dores de cabeça',
      ],
    },
  ];

  return (
    <div className="relative min-h-[calc(100vh-80px)] overflow-hidden">
      <div
        className="absolute inset-0 -z-10 opacity-60"
        style={{
          background:
            'radial-gradient(1000px 400px at top left, var(--accent) 0%, transparent 60%), radial-gradient(800px 300px at bottom right, var(--accent-2, #4f46e5) 0%, transparent 60%)',
        }}
      />

      <section className="mx-auto max-w-6xl px-4 py-10">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border panel-border panel-bg-60 text-xs tracking-wide animate-fade-in">
            <Zap size={14} /> Automação para impulsionar o departamento
          </div>

          <h1 className="mt-4 text-3xl md:text-4xl font-extrabold tracking-tight">
            Bem-vindo ao novo jeito de gerir processos
          </h1>

          <p className="mt-3 text-sm md:text-base opacity-80 max-w-3xl mx-auto">
            Um sistema pensado para eliminar o retrabalho, dar visibilidade ponta a ponta e acelerar resultados.
            Centralize informações, padronize fluxos e acompanhe tudo em tempo real — sem dores do Excel.
          </p>

          <div className="mt-6 flex flex-wrap gap-2 justify-center">
            <button
              onClick={() => navigate('/processos')}
              className="px-4 py-2 rounded-lg bg-[var(--accent)] text-[var(--fg)] hover:opacity-90 shadow-sm"
            >
              Ir para Processos
            </button>
            <button
              onClick={() => navigate('/gestao')}
              className="px-4 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90"
            >
              Ver histórico
            </button>
            <button
              onClick={() => navigate('/dashboard')}
              className="px-4 py-2 rounded-lg border panel-border panel-bg-60 hover:opacity-90"
            >
              Abrir Dashboard
            </button>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4 mt-8">
          {cards.map((c, i) => (
            <div
              key={i}
              className="rounded-xl border panel-border panel-bg-60 p-4 shadow-sm hover:shadow-md transition-all animate-pop-in"
              style={{ animationDelay: `${i * 80}ms` }}
            >
              <div className="flex items-center gap-2 text-[var(--accent)] mb-2">
                {c.icon}
                <span className="font-semibold">{c.title}</span>
              </div>
              <p className="text-sm opacity-80 leading-relaxed">{c.text}</p>
            </div>
          ))}
        </div>

        <div className="mt-10 grid md:grid-cols-2 gap-4">
          {compare.map((b, i) => (
            <div
              key={i}
              className={`rounded-xl border p-4 shadow-sm ${
                b.bad ? 'border-red-500/30 bg-red-500/5' : 'border-emerald-500/30 bg-emerald-500/5'
              }`}
            >
              <div
                className={`inline-flex items-center gap-2 px-2 py-1 rounded-md text-xs mb-2 ${
                  b.bad ? 'bg-red-500/10 text-red-400' : 'bg-emerald-500/10 text-emerald-400'
                }`}
              >
                {b.icon}
                <span className="font-semibold">{b.title}</span>
              </div>
              <ul className="list-disc pl-5 space-y-1 text-sm opacity-85">
                {b.bullets.map((t, j) => (
                  <li key={j}>{t}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: translateY(0) } }
        .animate-fade-in { animation: fadeIn .4s ease-out both }
        @keyframes popIn { from { opacity: 0; transform: scale(.98) translateY(6px) } to { opacity: 1; transform: scale(1) translateY(0) } }
        .animate-pop-in { animation: popIn .35s ease-out both }
      `}</style>
    </div>
  );
}
