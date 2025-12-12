// src/pages/HomeGestorAdmin.jsx

import React from 'react';
<<<<<<< HEAD
=======
import { Link } from 'react-router-dom';
>>>>>>> 07e4f02 (Fix: alterações de segurança)
import { useAuth } from '../context/AuthContext.jsx';
import Toast from '../components/Toast.jsx';
import { Clock } from 'lucide-react';
import { getProcessosComPrazo } from '../services/requisicaoService';

export default function HomeGestorAdmin() {
  const { user } = useAuth();
<<<<<<< HEAD
  const isAdmin = String(user?.tipo_conta || '').toLowerCase() === 'admin';
=======
  const role = String(user?.tipo_conta || '').toLowerCase();
  const isGestorOuAdmin = role === 'gestor' || role === 'admin';
>>>>>>> 07e4f02 (Fix: alterações de segurança)

  const [prazos, setPrazos] = React.useState({ grupos: {}, rows: [], count: 0 });
  const [errPrazos, setErrPrazos] = React.useState('');
  const [toast, setToast] = React.useState({ open: false, type: 'info', text: '' });

  React.useEffect(() => {
    (async () => {
      try {
        const resp = await getProcessosComPrazo();
        setPrazos(resp || { grupos: {}, rows: [], count: 0 });
        setErrPrazos('');
      } catch (e) {
        setErrPrazos('Falha ao carregar prazos críticos.');
      }
    })();
  }, []);

<<<<<<< HEAD
  if (!isAdmin) {
    return (
      <div className="p-4 md:p-6 bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="rounded-xl border px-4 py-3">
          Acesso restrito ao administrador.
=======
  if (!isGestorOuAdmin) {
    return (
      <div className="p-4 md:p-6 bg-background text-foreground min-h-screen flex items-center justify-center">
        <div className="rounded-xl border px-4 py-3">
          Acesso restrito a gestores ou administradores.
>>>>>>> 07e4f02 (Fix: alterações de segurança)
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 bg-background text-foreground min-h-screen">
<<<<<<< HEAD
      {/* Avisos de manutenção/atualização (hoje) */}
=======
      {/* Avisos */}
>>>>>>> 07e4f02 (Fix: alterações de segurança)
      <div
        className="mb-4 rounded-xl border-2 shadow-elevated"
        style={{ background: 'var(--panel)', borderColor: 'var(--warning)' }}
      >
        <div className="px-4 py-3">
<<<<<<< HEAD
          <div
            className="text-lg font-extrabold"
            style={{ color: 'var(--warning)' }}
          >
=======
          <div className="text-lg font-extrabold" style={{ color: 'var(--warning)' }}>
>>>>>>> 07e4f02 (Fix: alterações de segurança)
            Avisos de Hoje (Horário de Brasília)
          </div>
          <ul className="mt-2 space-y-1 text-sm">
            <li>
<<<<<<< HEAD
              <strong style={{ color: 'var(--accent)' }}>10:20</strong> — Todos
              os dias teremos manutenção da base de consulta. Serviços de
              consulta podem oscilar neste horário.
            </li>
            <li>
              <strong style={{ color: 'var(--accent)' }}>15:00</strong> —
              Atualização de funcionalidades de processos. Novas melhorias serão
              aplicadas.
=======
              <strong style={{ color: 'var(--accent)' }}>10:20</strong> - Manutenção da base de
              consulta. Pode haver oscilações.
            </li>
            <li>
              <strong style={{ color: 'var(--accent)' }}>15:00</strong> - Atualizações de
              funcionalidades de processos.
>>>>>>> 07e4f02 (Fix: alterações de segurança)
            </li>
          </ul>
        </div>
      </div>

      {/* Prazos críticos */}
      <div
        className="rounded-xl shadow-elevated p-4 mb-6 border-2"
        style={{
          background: 'var(--panel)',
          borderColor: 'var(--accent)',
          color: 'var(--fg)',
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-extrabold tracking-tight flex items-center gap-2">
            <Clock size={16} /> Prazos críticos (Distribuidora/Ouvidoria/ANEEL)
          </h2>
          <span className="text-sm opacity-80">Total: {prazos.count}</span>
        </div>

<<<<<<< HEAD
        {errPrazos && (
          <div className="text-red-500 text-sm mb-2">{errPrazos}</div>
        )}

        {prazos.count === 0 ? (
          <div className="opacity-70 text-sm">
            Nenhum processo em prazo crítico no momento.
          </div>
=======
        {errPrazos && <div className="text-red-500 text-sm mb-2">{errPrazos}</div>}

        {prazos.count === 0 ? (
          <div className="opacity-70 text-sm">Nenhum processo em prazo crítico no momento.</div>
>>>>>>> 07e4f02 (Fix: alterações de segurança)
        ) : (
          <div className="space-y-4">
            {Object.entries(prazos.grupos || {}).map(([etapa, arr]) => (
              <div
                key={etapa}
                className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3"
              >
<<<<<<< HEAD
                <div className="font-semibold text-[var(--accent)] mb-2">
                  {etapa}
                </div>
                <div className="space-y-2">
                  {arr
                    .slice()
                    .sort(
                      (a, b) =>
                        (a.deadline_unix || 0) - (b.deadline_unix || 0),
                    )
                    .map((r) => {
                      const hrs = Number(r?.horas_restantes ?? 0);
                      const dias = Number(r?.dias_restantes ?? 0);
                      const atrasado = !!r?.atrasado;
                      return (
                        <div
                          key={r.id_processo}
                          className={`flex flex-wrap items-center gap-3 text-sm rounded border px-3 py-2 ${
                            atrasado
                              ? 'border-red-500 bg-red-500/10'
                              : 'border-[var(--border)]'
                          }`}
                        >
                          <a
                            href={`/processos/${r.id_processo}`}
                            className="font-semibold text-[var(--accent)] underline"
                            target="_self"
                            rel="noreferrer"
                          >
                            Proc #{r.id_processo}
                          </a>
                          <span className="opacity-80">
                            Sub-etapa:{' '}
                            {r.sub_etapa || 'Aguardando retorno'}
                          </span>
                          <span className="opacity-80">
                            Deadline:{' '}
                            {r.deadline
                              ? new Date(
                                  r.deadline,
                                ).toLocaleString('pt-BR')
                              : '-'}
=======
                <div className="font-semibold text-[var(--accent)] mb-2">{etapa}</div>
                <div className="space-y-2">
                  {arr
                    .slice()
                    .sort((a, b) => (a.deadline_unix || 0) - (b.deadline_unix || 0))
                    .map((r, idx) => {
                      const hrs = Number(r?.horas_restantes ?? 0);
                      const dias = Number(r?.dias_restantes ?? 0);
                      const atrasado = !!r?.atrasado;
                      const key = `${etapa}-${r.id_processo}-${r.deadline || ''}-${r.sub_etapa || ''}-${idx}`;
                      return (
                        <div
                          key={key}
                          className={`flex flex-wrap items-center gap-3 text-sm rounded border px-3 py-2 ${
                            atrasado ? 'border-red-500 bg-red-500/10' : 'border-[var(--border)]'
                          }`}
                        >
                          <Link
                            to={`/processos/${r.id_processo}`}
                            className="font-semibold text-[var(--accent)] underline"
                          >
                            Proc #{r.id_processo}
                          </Link>
                          <span className="opacity-80">
                            Sub-etapa: {r.sub_etapa || 'Aguardando retorno'}
                          </span>
                          <span className="opacity-80">
                            Deadline:{' '}
                            {r.deadline ? new Date(r.deadline).toLocaleString('pt-BR') : '-'}
>>>>>>> 07e4f02 (Fix: alterações de segurança)
                          </span>
                          <span
                            className={`px-2 py-1 rounded text-xs ${
                              atrasado
                                ? 'bg-red-600 text-white'
                                : 'bg-amber-500/30 border border-amber-500/60'
                            }`}
                          >
                            {atrasado ? 'Vencido' : 'Restante'}:{' '}
                            {atrasado
                              ? `${Math.abs(Math.round(dias))}d`
<<<<<<< HEAD
                              : `${Math.max(
                                  0,
                                  Math.floor(dias),
                                )}d ${Math.max(
=======
                              : `${Math.max(0, Math.floor(dias))}d ${Math.max(
>>>>>>> 07e4f02 (Fix: alterações de segurança)
                                  0,
                                  Math.floor(hrs % 24),
                                )}h`}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

<<<<<<< HEAD
      <div
        className="rounded-xl shadow-elevated p-4 mb-6 border-2"
        style={{
          background: 'var(--header-bg)',
          borderColor: 'var(--header-border)',
          color: 'var(--header-fg)',
        }}
      >
        <h1 className="text-xl font-extrabold tracking-tight">
          Movimentações (últimas 24h)
        </h1>
        <p className="opacity-90 text-sm">
          Quem fez, em qual processo e o que mudou.
        </p>
      </div>

=======
>>>>>>> 07e4f02 (Fix: alterações de segurança)
      <Toast
        open={toast.open}
        type={toast.type}
        message={toast.text}
        onClose={() =>
          setToast((t) => ({
            ...t,
            open: false,
          }))
        }
      />
    </div>
  );
}
