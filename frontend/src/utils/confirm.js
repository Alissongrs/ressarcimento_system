let styleInjected = false;
let rootEl = null;

const ensureStyles = () => {
  if (styleInjected || typeof document === 'undefined') return;
  styleInjected = true;
  const style = document.createElement('style');
  style.textContent = `
.confirm-overlay {
  position: fixed;
  inset: 0;
  background: rgba(20, 20, 20, 0.55);
  backdrop-filter: blur(2px);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.confirm-dialog {
  width: 100%;
  max-width: 420px;
  background: #f6f6f6;
  color: #111;
  border: 1px solid #9a9a9a;
  border-radius: 6px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.25);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
}
.confirm-title {
  padding: 10px 12px;
  border-bottom: 1px solid #c9c9c9;
  font-weight: 600;
  background: linear-gradient(#ffffff, #eaeaea);
}
.confirm-body {
  padding: 16px 12px;
  font-size: 14px;
  line-height: 1.4;
}
.confirm-actions {
  padding: 12px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid #c9c9c9;
  background: #ededed;
}
.confirm-btn {
  min-width: 88px;
  padding: 6px 14px;
  border: 1px solid #7f7f7f;
  border-radius: 4px;
  background: linear-gradient(#ffffff, #dcdcdc);
  cursor: pointer;
  font-size: 13px;
}
.confirm-btn:hover {
  background: linear-gradient(#ffffff, #cfcfcf);
}
.confirm-btn.primary {
  border-color: #0a5bd7;
  background: linear-gradient(#5aa0ff, #2f6edc);
  color: #fff;
}
.confirm-btn.primary:hover {
  background: linear-gradient(#5aa0ff, #2a64c9);
}
`;
  document.head.appendChild(style);
};

const ensureRoot = () => {
  if (rootEl && document.body.contains(rootEl)) return rootEl;
  rootEl = document.createElement('div');
  rootEl.id = 'confirm-modal-root';
  document.body.appendChild(rootEl);
  return rootEl;
};

export const confirmAction = (message, options = {}) =>
  new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(false);
      return;
    }
    ensureStyles();
    const root = ensureRoot();

    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'confirm-dialog';

    const title = document.createElement('div');
    title.className = 'confirm-title';
    title.textContent = options.title || 'Confirmacao';

    const body = document.createElement('div');
    body.className = 'confirm-body';
    body.textContent = message || 'Deseja continuar?';

    const actions = document.createElement('div');
    actions.className = 'confirm-actions';

    const btnCancel = document.createElement('button');
    btnCancel.type = 'button';
    btnCancel.className = 'confirm-btn';
    btnCancel.textContent = options.cancelText || 'Cancelar';

    const btnOk = document.createElement('button');
    btnOk.type = 'button';
    btnOk.className = 'confirm-btn primary';
    btnOk.textContent = options.okText || 'Ok';

    const cleanup = (value) => {
      overlay.remove();
      resolve(value);
    };

    btnCancel.addEventListener('click', () => cleanup(false));
    btnOk.addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    actions.appendChild(btnCancel);
    actions.appendChild(btnOk);
    dialog.appendChild(title);
    dialog.appendChild(body);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);
    root.appendChild(overlay);

    btnOk.focus();
  });
