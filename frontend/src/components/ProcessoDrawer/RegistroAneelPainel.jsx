// Painel "Registrar na ANEEL" (aba Histórico do processo) — VERSÃO DE TESTE (09/11/2026).
// Mesmos campos do formulário da Ouvidoria (www2.aneel.gov.br/faleconosco/formSolicitacao.asp). Ao clicar em
// "Preencher na ANEEL (teste)", a extensão do SURE abre o site na sessão do usuário, escolhe (ou preenche o
// cadastro do) endereço da UC e preenche o formulário inteiro — mas NÃO envia: no teste o botão "Registrar
// Solicitação" fica bloqueado. Nada é gravado no SURE nem na ANEEL. O "Não sou um robô" é sempre da pessoa.
import React, { useEffect, useMemo, useState } from 'react';

// assuntos (Natureza 2 - Reclamação → "Classificação (assunto)") ligados a ressarcimento; código = value no site
const ASSUNTOS_ANEEL = [
  ['346', 'Faturamento'],
  ['106', 'Variação de Consumo/Consumo Elevado/Erro Leitura'],
  ['351', 'Cobrança'],
  ['210', 'Cobrança por Irregularidades'],
  ['208', 'Débitos Anteriores'],
  ['209', 'Tarifas de Energia Elétrica'],
  ['404', 'Bandeiras Tarifárias'],
  ['405', 'Faturamento de Mini e Microgeração'],
  ['215', 'Classificação da Unidade Consumidora'],
  ['403', 'Defeito/Danos no Medidor'],
  ['363', 'Aferição e Substituição de Medidor'],
];

const LIMITES = {
  nome_consumidor: 150, email_consumidor: 50, tel_consumidor: 15, cpf_consumidor: 18,
  nome_procurador: 150, email_procurador: 50, tel_procurador: 15, cpf_procurador: 18,
  classe_consumo: 50, grupo_tarifario: 4, numero_protocolo_cta: 15, ouvidoria_distribuidora: 15,
  resumo_manifestacao: 1500, numero_protocolo: 32, mensagem: 2400,
  end_identificacao: 20, end_cep: 8, end_bairro: 60, end_rua: 90, end_complemento: 30, end_uc: 30,
};

const CHAVE_PROCURADOR = 'sure.aneel.procurador'; // conveniência deste navegador (dados da AM Energia)

function lerProcurador() {
  try { return JSON.parse(localStorage.getItem(CHAVE_PROCURADOR) || '{}') || {}; } catch (e) { return {}; }
}
function gravarProcurador(p) {
  try { localStorage.setItem(CHAVE_PROCURADOR, JSON.stringify(p)); } catch (e) { /* sem armazenamento: segue */ }
}

const soDig = (s) => String(s || '').replace(/\D/g, '');
const docLimpo = (s) => (/[*•x]/i.test(String(s || '')) ? '' : String(s || '')); // documento mascarado não serve

function inicial(d) {
  const uc = d?.uc || {};
  const proc = lerProcurador();
  const grupo = String(uc.grupo_subgrupo || '').trim().toUpperCase().charAt(0);
  const motivo = [d?.tipo_irregularidade?.nome, d?.subtipo_irregularidade?.nome].filter(Boolean).join(' — ');
  const resumo = [motivo, d?.motivo_objeto].filter(Boolean).join(': ');
  return {
    titular: 'nao',
    nome_consumidor: d?.cliente?.razao_social || '',
    email_consumidor: proc.email_procurador || '',
    tel_consumidor: proc.tel_procurador || '',
    cpf_consumidor: docLimpo(d?.cliente?.cnpj_cpf || d?.cliente?.cnpj_cpf_mascarado),
    nome_procurador: proc.nome_procurador || '',
    email_procurador: proc.email_procurador || '',
    tel_procurador: proc.tel_procurador || '',
    cpf_procurador: proc.cpf_procurador || '',
    classe_consumo: '',
    grupo_tarifario: grupo === 'A' || grupo === 'B' ? grupo : '',
    numero_protocolo_cta: '',
    data_protocolo: '',
    ouvidoria_distribuidora: '',
    data_ouvidoria: '',
    resumo_manifestacao: resumo.slice(0, 1500),
    forma_contato: '4', // 4 = E-mail (a resposta cai na caixa que o monitor de protocolos já lê)
    numero_protocolo: d?.numero_protocolo || '',
    natureza: '2', // 2 = Reclamação
    assunto: '346',
    mensagem: (d?.motivo_objeto || '').slice(0, 2400),
    // endereço da UC (usado só se a UC ainda não estiver cadastrada no site)
    end_uc: uc.codigo_uc || uc.codigo_instalacao || '',
    end_identificacao: `${(d?.cliente?.razao_social || '').split(/\s+/)[0] || 'UC'} ${uc.codigo_uc || ''}`.trim().slice(0, 20),
    end_cep: soDig(uc.cep).slice(0, 8),
    end_uf: String(uc.uf || '').toUpperCase().slice(0, 2),
    end_cidade: uc.municipio || '',
    end_distribuidora: d?.distribuidora?.nome || '',
    end_bairro: '',
    end_rua: uc.endereco || '',
    end_complemento: '',
  };
}

function Campo({ label, nome, f, set, req, tipo = 'text', area, linhas = 3, ajuda }) {
  const max = LIMITES[nome];
  const v = f[nome] ?? '';
  const n = String(v).length;
  return (
    <div className="cpv2-form-group" style={area ? { gridColumn: '1 / -1' } : undefined}>
      <label className="cpv2-form-group__label">
        {label}{req && <span style={{ color: 'var(--cpv2-danger, #c0392b)' }}> *</span>}
        {max && (area || n > max * 0.8) ? <span className="cpv2-muted-sm" style={{ marginLeft: 6 }}>{n}/{max}</span> : null}
      </label>
      {area
        ? <textarea rows={linhas} value={v} maxLength={max} onChange={(e) => set(nome, e.target.value)} />
        : <input type={tipo} value={v} maxLength={max} onChange={(e) => set(nome, e.target.value)} />}
      {ajuda && <div className="cpv2-muted-sm" style={{ marginTop: 2 }}>{ajuda}</div>}
    </div>
  );
}

const OBRIGATORIOS = [
  ['nome_consumidor', 'Nome do consumidor'], ['email_consumidor', 'E-mail do consumidor'],
  ['tel_consumidor', 'Telefone do consumidor'], ['cpf_consumidor', 'CPF/CNPJ do consumidor'],
  ['classe_consumo', 'Classe de consumo'], ['grupo_tarifario', 'Grupo tarifário'],
  ['resumo_manifestacao', 'Resumo da manifestação'], ['mensagem', 'Motivo do contato'], ['end_uc', 'UC'],
];
const OBRIG_PROCURADOR = [
  ['nome_procurador', 'Nome do procurador'], ['email_procurador', 'E-mail do procurador'],
  ['tel_procurador', 'Telefone do procurador'], ['cpf_procurador', 'CPF/CNPJ do procurador'],
];

export default function RegistroAneelPainel({ detalhe, onFechar }) {
  const [f, setF] = useState(() => inicial(detalhe));
  const [temExt, setTemExt] = useState(() => !!document.documentElement.dataset.sureAneelExt);
  const [versaoExt, setVersaoExt] = useState(() => document.documentElement.dataset.sureExtVersao || '');
  const [estado, setEstado] = useState(null); // { tipo: 'info'|'ok'|'erro', texto, detalhes? }
  const [rodando, setRodando] = useState(false);
  const set = (k, v) => setF((o) => ({ ...o, [k]: v }));

  const faltando = useMemo(() => {
    const lista = [...OBRIGATORIOS, ...(f.titular === 'nao' ? OBRIG_PROCURADOR : [])];
    return lista.filter(([k]) => !String(f[k] || '').trim()).map(([, n]) => n);
  }, [f]);

  useEffect(() => {
    const ouvir = (ev) => {
      if (ev.source !== window || ev.origin !== window.location.origin) return;
      const d = ev.data || {};
      if (d.origem !== 'sure-aneel-ext') return;
      if (d.tipo === 'pronta') { setTemExt(true); setVersaoExt(document.documentElement.dataset.sureExtVersao || ''); }
      if (d.tipo !== 'reg_estado') return;
      if (d.fim) setRodando(false);
      setEstado({ tipo: d.erro ? 'erro' : d.fim ? 'ok' : 'info', texto: d.erro || d.texto || '', detalhes: d.detalhes });
    };
    window.addEventListener('message', ouvir);
    window.postMessage({ origem: 'sure-pagina', tipo: 'ping' }, window.location.origin);
    return () => window.removeEventListener('message', ouvir);
  }, []);

  // modo: 'endereco' (cadastro da UC no site) ou 'solicitacao' (protocolar)
  const preencher = (modo) => {
    if (f.titular === 'nao') {
      gravarProcurador({
        nome_procurador: f.nome_procurador, email_procurador: f.email_procurador,
        tel_procurador: f.tel_procurador, cpf_procurador: f.cpf_procurador,
      });
    }
    setRodando(true);
    setEstado({ tipo: 'info', texto: 'Abrindo o site da ANEEL…' });
    window.postMessage({ origem: 'sure-pagina', tipo: 'aneel_registro', modo, teste: true, dados: f }, window.location.origin);
  };
  const faltandoEnd = [['end_cep', 'CEP'], ['end_uf', 'UF'], ['end_cidade', 'Município'], ['end_bairro', 'Bairro'], ['end_rua', 'Endereço'], ['end_uc', 'UC']]
    .filter(([k]) => !String(f[k] || '').trim()).map(([, n]) => n);

  const versaoOk = versaoExt && versaoExt.localeCompare('1.4.0', undefined, { numeric: true }) >= 0;

  return (
    <div className="cpv2-aneel-box" style={{ marginTop: 10, border: '1px dashed var(--cpv2-warning, #d4a017)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div className="cpv2-section-title" style={{ margin: 0 }}>🏛️ Registrar na ANEEL <span className="cpv2-chip cpv2-chip--warning">TESTE — não envia</span></div>
        <button type="button" className="cpv2-btn cpv2-btn--sm" onClick={onFechar}>Fechar</button>
      </div>
      <p className="cpv2-muted-sm" style={{ margin: '6px 0 10px' }}>
        A extensão abre o site da ANEEL e preenche o cadastro do endereço da UC ("Registrar endereço") ou o
        formulário da solicitação ("Protocolar"). Neste teste <strong>nada é enviado</strong>: os botões de registrar do site ficam bloqueados e
        nada é gravado no SURE. Confira na janela da ANEEL se cada campo caiu no lugar certo.
      </p>

      <div className="cpv2-section-title">Quem registra</div>
      <div style={{ display: 'flex', gap: 16, fontSize: 13, marginBottom: 8 }}>
        <label><input type="radio" checked={f.titular === 'nao'} onChange={() => set('titular', 'nao')} /> Procurador/representante (AM Energia)</label>
        <label><input type="radio" checked={f.titular === 'sim'} onChange={() => set('titular', 'sim')} /> O próprio titular</label>
      </div>

      <div className="cpv2-section-title">Titular (representado)</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Campo label="Nome do consumidor" nome="nome_consumidor" f={f} set={set} req />
        <Campo label="CPF/CNPJ do consumidor" nome="cpf_consumidor" f={f} set={set} req ajuda={!f.cpf_consumidor ? 'O SURE só tem o documento mascarado: digite completo.' : null} />
        <Campo label="E-mail do consumidor" nome="email_consumidor" f={f} set={set} req />
        <Campo label="Telefone do consumidor" nome="tel_consumidor" f={f} set={set} req />
      </div>

      {f.titular === 'nao' && (
        <>
          <div className="cpv2-section-title" style={{ marginTop: 10 }}>Procurador (fica guardado neste navegador)</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <Campo label="Nome do procurador" nome="nome_procurador" f={f} set={set} req />
            <Campo label="CPF/CNPJ do procurador" nome="cpf_procurador" f={f} set={set} req />
            <Campo label="E-mail do procurador" nome="email_procurador" f={f} set={set} req />
            <Campo label="Telefone do procurador" nome="tel_procurador" f={f} set={set} req />
          </div>
        </>
      )}

      <div className="cpv2-section-title" style={{ marginTop: 10 }}>Unidade consumidora</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <Campo label="UC (número da instalação)" nome="end_uc" f={f} set={set} req ajuda="Usada para achar o endereço já cadastrado no site." />
        <Campo label="Classe de consumo" nome="classe_consumo" f={f} set={set} req ajuda="Ex.: Comercial, Industrial, Rural" />
        <Campo label="Grupo tarifário (A/B)" nome="grupo_tarifario" f={f} set={set} req />
      </div>

      <div className="cpv2-section-title" style={{ marginTop: 10 }}>Endereço da UC (para o botão "Registrar endereço")</div>
      <div className="cpv2-muted-sm" style={{ marginBottom: 4 }}>
        O site só aceita protocolar para uma UC cujo endereço já esteja cadastrado na conta. Se a UC não aparecer no site, registre o endereço primeiro.
      </div>
      <div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginTop: 8 }}>
          <Campo label="Identificação do local" nome="end_identificacao" f={f} set={set} />
          <Campo label="CEP (só números)" nome="end_cep" f={f} set={set} />
          <Campo label="UF" nome="end_uf" f={f} set={set} />
          <Campo label="Município" nome="end_cidade" f={f} set={set} />
          <Campo label="Distribuidora" nome="end_distribuidora" f={f} set={set} />
          <Campo label="Bairro" nome="end_bairro" f={f} set={set} />
          <Campo label="Endereço" nome="end_rua" f={f} set={set} />
          <Campo label="Complemento" nome="end_complemento" f={f} set={set} />
        </div>
      </div>

      <div className="cpv2-section-title">Registros anteriores na distribuidora</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10 }}>
        <Campo label="Protocolo na CTA" nome="numero_protocolo_cta" f={f} set={set} />
        <Campo label="Data (CTA)" nome="data_protocolo" f={f} set={set} tipo="date" />
        <Campo label="Protocolo na Ouvidoria" nome="ouvidoria_distribuidora" f={f} set={set} />
        <Campo label="Data (Ouvidoria)" nome="data_ouvidoria" f={f} set={set} tipo="date" />
        <Campo label="Nº do protocolo junto ao concessionário" nome="numero_protocolo" f={f} set={set} />
      </div>

      <div className="cpv2-section-title" style={{ marginTop: 10 }}>Manifestação</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div className="cpv2-form-group">
          <label className="cpv2-form-group__label">Natureza do contato</label>
          <select value={f.natureza} onChange={(e) => set('natureza', e.target.value)}>
            <option value="2">2 - Reclamação</option>
            <option value="1">1 - Informação</option>
            <option value="3">3 - Denúncia</option>
          </select>
        </div>
        <div className="cpv2-form-group">
          <label className="cpv2-form-group__label">Classificação (assunto)</label>
          <select value={f.assunto} onChange={(e) => set('assunto', e.target.value)}>
            {ASSUNTOS_ANEEL.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
          </select>
        </div>
        <div className="cpv2-form-group">
          <label className="cpv2-form-group__label">Receber a resposta por</label>
          <select value={f.forma_contato} onChange={(e) => set('forma_contato', e.target.value)}>
            <option value="4">E-mail</option>
            <option value="3">Carta</option>
          </select>
        </div>
        <Campo label="Resumo da manifestação" nome="resumo_manifestacao" f={f} set={set} req area linhas={3} />
        <Campo label="Motivo do contato com a ANEEL" nome="mensagem" f={f} set={set} req area linhas={8} />
      </div>
      <p className="cpv2-muted-sm">Anexos ainda não entram neste teste (no site: até 10 arquivos, PDF/JPG/PNG, 5 MB somados).</p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        <button type="button" className="cpv2-btn" disabled={rodando || !temExt || !versaoOk} onClick={() => preencher('endereco')}
          title={faltandoEnd.length ? `Em branco: ${faltandoEnd.join(', ')}` : 'Preenche o cadastro do endereço da UC no site (teste: não salva)'}>
          Registrar endereço (teste)
        </button>
        <button type="button" className="cpv2-btn cpv2-btn--primary" disabled={rodando || !temExt || !versaoOk} onClick={() => preencher('solicitacao')}
          title="Preenche o formulário da solicitação no site (teste: não envia)">
          {rodando ? 'Preenchendo…' : 'Protocolar (teste)'}
        </button>
        {!temExt && <span className="cpv2-muted-sm">Precisa da extensão do SURE instalada neste Chrome.</span>}
        {temExt && !versaoOk && <span className="cpv2-muted-sm">Atualize a extensão do SURE para a versão 1.4.0 ou mais nova (está {versaoExt || 'antiga'}).</span>}
        {faltando.length > 0 && (
          <span className="cpv2-muted-sm">Em branco (o site exige): {faltando.join(', ')}. Dá para testar mesmo assim.</span>
        )}
      </div>
      {estado && (
        <div className={`cpv2-muted-sm`} style={{ marginTop: 8, color: estado.tipo === 'erro' ? 'var(--cpv2-danger, #c0392b)' : estado.tipo === 'ok' ? 'var(--cpv2-success, #1f9d6b)' : undefined }}>
          {estado.texto}
          {Array.isArray(estado.detalhes) && estado.detalhes.length > 0 && (
            <ul style={{ margin: '4px 0 0 16px' }}>{estado.detalhes.map((x, i) => <li key={i}>{x}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  );
}
