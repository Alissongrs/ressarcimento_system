// "Conectar celular": mostra um QR code que abre o SURE no celular JÁ LOGADO (mesmo usuário).
// O código vale uma vez só e por 2 minutos (backend: /api/v2/auth/qr).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Smartphone, X, CheckCircle2, RefreshCw } from 'lucide-react';
import api from '../services/apiClient';

export default function ConectarCelular({ className = 'top-nav-link top-nav-alert relative' }) {
  const [aberto, setAberto] = useState(false);
  const [qr, setQr] = useState(null); // { img, codigo, expira }
  const [estado, setEstado] = useState('gerando'); // gerando | pronto | conectado | expirado | erro
  const [resta, setResta] = useState(0);
  const timer = useRef(null);

  const gerar = useCallback(async () => {
    setEstado('gerando');
    setQr(null);
    try {
      const { data } = await api.post('/api/v2/auth/qr');
      const img = await QRCode.toDataURL(data.url, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
      setQr({ img, codigo: data.codigo, expira: data.expira_em });
      setEstado('pronto');
    } catch {
      setEstado('erro');
    }
  }, []);

  useEffect(() => { if (aberto) gerar(); }, [aberto, gerar]);

  // contagem regressiva + confere se o celular já entrou
  useEffect(() => {
    clearInterval(timer.current);
    if (!aberto || estado !== 'pronto' || !qr) return undefined;
    let n = 0;
    timer.current = setInterval(async () => {
      const s = Math.max(0, Math.round((qr.expira - Date.now()) / 1000));
      setResta(s);
      if (s <= 0) { setEstado('expirado'); return; }
      if (++n % 2 === 0) {
        try {
          const { data } = await api.get(`/api/v2/auth/qr/${qr.codigo}`);
          if (data?.usado) setEstado('conectado');
          else if (data?.expirado) setEstado('expirado');
        } catch { /* tenta de novo */ }
      }
    }, 1000);
    return () => clearInterval(timer.current);
  }, [aberto, estado, qr]);

  const fechar = () => { setAberto(false); setQr(null); clearInterval(timer.current); };

  return (
    <>
      <button type="button" onClick={() => setAberto(true)} className={className} title="Conectar celular (QR code)" aria-label="Conectar celular">
        <Smartphone className="top-nav-icon" />
      </button>
      {aberto && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/60 p-4" onClick={fechar} role="dialog" aria-label="Conectar celular">
          <div className="w-full max-w-sm rounded-xl border p-5 text-center" style={{ background: 'var(--card, var(--bg))', borderColor: 'var(--border)' }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <b className="flex items-center gap-2"><Smartphone className="w-5 h-5" /> Conectar celular</b>
              <button type="button" onClick={fechar} aria-label="Fechar" className="opacity-70 hover:opacity-100"><X className="w-5 h-5" /></button>
            </div>
            {estado === 'gerando' && <div className="py-16 opacity-70">Gerando o QR…</div>}
            {estado === 'erro' && <div className="py-10">Não consegui gerar o QR. <button type="button" className="underline" onClick={gerar}>Tentar de novo</button></div>}
            {estado === 'pronto' && qr && (
              <>
                <img src={qr.img} alt="QR code para entrar no SURE pelo celular" className="mx-auto rounded bg-white p-2" width={280} height={280} />
                <p className="text-sm mt-3">Abra a <b>câmera do celular</b>, aponte para o QR e toque no link. O SURE abre no celular <b>já conectado</b> com a sua conta.</p>
                <p className="text-xs opacity-70 mt-2">Vale uma vez só · expira em {resta || '…'}s · não mostre para outras pessoas</p>
              </>
            )}
            {estado === 'conectado' && (
              <div className="py-10">
                <CheckCircle2 className="w-12 h-12 mx-auto text-emerald-500" />
                <p className="mt-3 font-semibold">Celular conectado!</p>
                <p className="text-sm opacity-80 mt-1">No celular, use o menu ⋮ do Chrome → <b>Instalar app</b> para ter o ícone do SURE.</p>
                <button type="button" className="mt-4 px-4 py-2 rounded border" style={{ borderColor: 'var(--border)' }} onClick={fechar}>Fechar</button>
              </div>
            )}
            {estado === 'expirado' && (
              <div className="py-10">
                <p>O QR expirou.</p>
                <button type="button" className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded border" style={{ borderColor: 'var(--border)' }} onClick={gerar}><RefreshCw className="w-4 h-4" /> Gerar outro</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
