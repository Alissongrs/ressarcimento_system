import React, { useEffect, useState } from 'react';

export default function Toast({ open, type = 'info', message = '', onClose, timeout = 3000 }) {
  const [visible, setVisible] = useState(!!open);

  useEffect(() => {
    setVisible(!!open);
    if (open) {
      const id = setTimeout(() => { setVisible(false); onClose?.(); }, timeout);
      return () => clearTimeout(id);
    }
  }, [open, timeout, onClose]);

  if (!visible || !message) return null;

  const bg = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#2563eb';

  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div className="rounded-md shadow-lg px-4 py-2 text-white text-sm" style={{ background: bg }}>
        {message}
      </div>
    </div>
  );
}

