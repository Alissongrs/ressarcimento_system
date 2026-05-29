import DOMPurify from 'dompurify';

const FORBID_ATTR_BASE = [
  'onload', 'onerror', 'onclick', 'onmouseover',
  'onfocus', 'onblur', 'onchange', 'onsubmit',
];

// Para markdown gerado pela IA ou texto interno com estilos inline controlados.
export function sanitizeChat(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'meta', 'link'],
    FORBID_ATTR: FORBID_ATTR_BASE,
  });
}

// Para HTML vindo de e-mails (permite <style>, mantém target/rel, bloqueia execução).
export function sanitizeEmail(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|data):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: FORBID_ATTR_BASE,
  });
}
