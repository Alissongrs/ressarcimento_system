// Botão "Baixar a extensão do SURE" — a mesma extensão faz Protocolos ANEEL e Faturas Claro.
// O zip é gerado por ferramentas/empacotar_extensao.py em public/extensao_sure.zip (servido pelo próprio SURE).
import React, { useState } from 'react';
import { Download } from 'lucide-react';

export default function BaixarExtensao() {
  const [ajuda, setAjuda] = useState(false);
  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-2">
        <a href="/extensao_sure.zip" download="extensao_sure.zip"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-sm" style={{ borderColor: 'var(--border)' }}>
          <Download className="w-4 h-4" /> Baixar a extensão do SURE
        </a>
        <button type="button" onClick={() => setAjuda((v) => !v)} className="text-xs underline opacity-70">
          {ajuda ? 'fechar' : 'como instalar'}
        </button>
      </span>
      {ajuda && (
        <span className="text-xs opacity-80 rounded border p-2 max-w-xl" style={{ borderColor: 'var(--border)' }}>
          Uma extensão só, para ANEEL e Claro. 1) Descompacte o zip (de preferência sempre na mesma pasta).
          2) No Chrome, abra <code>chrome://extensions</code> e ligue o <b>Modo do desenvolvedor</b>.
          3) <b>Carregar sem compactação</b> → escolha a pasta <code>extensao_sure</code>.
          Para atualizar: descompacte o zip novo por cima da mesma pasta e clique no ↻ da extensão.
          Para a Claro, guarde o login do portal em <b>Detalhes → Opções da extensão</b>.
        </span>
      )}
    </span>
  );
}
