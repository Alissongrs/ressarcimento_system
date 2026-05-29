import { useEffect } from "react";

function resolveOrigin() {
  const raw = (import.meta?.env?.VITE_API_BASE_URL ?? "/api/v1").toString().trim();
  const fixed = raw
    .replace(/^http:(?!\/\/)/, 'http://')
    .replace(/^https:(?!\/\/)/, 'https://');
  if (/^https?:\/\//.test(fixed)) {
    try { return new URL(fixed).origin; } catch { return window.location.origin; }
  }
  return window.location.origin;
}

/**
 * onBoot(unread: number) -> inicial
 * onUnread(unread: number) -> atualizações de contagem
 * onNovo(payload) -> novo alerta
 * onLido() -> marcou como lido em outro lugar
 */
export function useAlertasSSE({ onBoot, onUnread, onNovo, onLido }) {
  useEffect(() => {
    const origin = resolveOrigin();
    const url = new URL('/api/v1/alertas/stream', origin);
    // Cookie auth_token enviado automaticamente via withCredentials
    const es = new EventSource(url.toString(), { withCredentials: true });

    es.addEventListener("alerta_boot", (evt) => {
      try {
        const data = JSON.parse(evt.data || "{}");
        onBoot?.(Number(data.unread || 0));
      } catch {}
    });

    es.addEventListener("alerta", (evt) => {
      try {
        const data = JSON.parse(evt.data || "{}");
        switch (data.type) {
          case "alerta_unread":
            onUnread?.(Number(data.payload?.unread || 0));
            break;
          case "alerta_novo":
            onNovo?.(data.payload || {});
            break;
          case "alerta_lido":
            onLido?.();
            break;
          default:
            break;
        }
      } catch {}
    });

    // keep-alive ":" é ignorado pelo EventSource automaticamente

    es.onerror = () => {
      // o browser reconecta sozinho; não fazer nada
    };

    return () => {
      es.close();
    };
  }, [onBoot, onUnread, onNovo, onLido]);
}
