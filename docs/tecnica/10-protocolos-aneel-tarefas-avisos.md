# 10 — Protocolos ANEEL, Tarefas, Sininho e WhatsApp

Módulo criado a partir de 25/10/2026. Acompanha os protocolos abertos na **Ouvidoria da ANEEL**
(Fale Conosco), transforma cada mudança relevante em **tarefa** para um analista e avisa a equipe
pelo **sininho** do topo e pelo **grupo do WhatsApp** do departamento.

## Visão geral

```
 E-mails naoresponda@aneel.gov.br ──┐                      ┌──► Sininho (FT_ALERTAS + SSE)
 (caixas Graph, a cada 15 min)      │                      │
                                    ├──► FT_PROTOCOLO_     ├──► FT_TAREFAS (responsável)
 Site da ANEEL (extensão Chrome, ───┘    EVENTOS  ─────────┤
 sessão aberta pelo usuário)             FT_PROTOCOLOS_    └──► Grupo do WhatsApp
                                         ANEEL (situação)
```

## Fontes de atualização

| Fonte | Como | Quando | Código |
|-------|------|--------|--------|
| **E-mails da ANEEL** (fonte 1) | e-mails `naoresponda@aneel.gov.br` já ingeridos das caixas (Graph) → eventos `registro` / `resposta` (protocolo concluído) / `prazo` (prazo da distribuidora encerrado) | **a cada 15 min** (`main.go`: `s.Every(15).Minutes().Do(protocolos.RodarAgendado)`) + botão "Atualizar agora" | `protocolos/protocolos.go` (`Sincronizar`) |
| **Site da ANEEL** | extensão `extensao_aneel/` lê "Meus Registros" na sessão que **o usuário** abriu e devolve ao SURE (`POST /protocolos-aneel/site/importar`) | só quando alguém clica em **"Consultar no site da ANEEL"** | `protocolos/site.go`, `extensao_aneel/` |

> ⚠️ O site da ANEEL fica atrás de **Cloudflare (desafio anti-robô) + login**. A VPS **não** consulta o
> site sozinha e o sistema **não** digita senha nem passa pelo desafio — isso é sempre do usuário.
> O site acrescenta os estados intermediários ("Em análise na concessionária", "Em análise na ANEEL"),
> que não chegam por e-mail. Consulta automática pela VPS só com acesso oficial da ANEEL.

Na 1ª rodada e para e-mails com mais de 72h **não** se cria tarefa (evita avalanche de histórico).

### Protocolo sem processo → vínculo pela UC do campo "Endereço" (extensão 1.1.0, 29/10)

O detalhe do protocolo no site traz, no campo **Endereço**, empresa + UC + endereço (ex.:
`JACESA -585359105940 - Presidente Dutra - (RJ)`, `CLARO - UC 90569563 - … (PR)`). A extensão manda esse campo;
`protocolos.vincularPorEndereco` (`site.go`) tira os números de 6+ dígitos (sem CEP, sem zeros à esquerda) e procura
a UC em `FT_REQUISICOES.uc` / `FT_PROCESSOS.uc` / `uc_atual`:
- **1 processo** → vincula e cria tarefa `protocolo_vinculo` para **quem fez a última alteração no processo**
  (`UltimoAlterador`: movimentação no histórico ou edição em `FT_AUDIT_EDICAO`, a mais recente; "sistema" não conta),
  com aviso no sininho. Ninguém → tarefa sem responsável (alguém assume).
- **2–3 processos** → vincula a todos como "confirmar" (aba A confirmar), tarefa sem responsável.
- nenhum / mais de 3 → continua sem processo.

A lista que a extensão consulta (`/site/abertos`) passou a incluir também os protocolos **sem processo**, mesmo
concluídos. Em 29/10 a leitura manual dos 19 que estavam sem processo vinculou 11 (backups
`backups/protocolo_12426_18442_luana_20261029.json` e `backups/protocolos_sem_processo_vinculo_20261029.json`).

## Tabelas

| Tabela | Papel |
|--------|-------|
| `FT_PROTOCOLOS_ANEEL` | 1 linha por protocolo × processo: `protocolo_num` (13 dígitos, sem pontuação), `id_processo`, `situacao`, `status_vinculo` (`ok` / `sem_processo` / `confirmar` quando o nº aparece em >1 processo), responsável marcado, `ultima_fonte` (`email`/`site`) |
| `FT_PROTOCOLO_EVENTOS` | linha do tempo do protocolo: `situacao_nova`, `ocorrido_em`, fonte, texto completo do andamento/resposta |
| `FT_TAREFAS` | tarefa gerada pela mudança: `tipo` (`protocolo_registro`, `protocolo_resposta`, `protocolo_prazo`…), `titulo`, `descricao`, `id_processo`, `protocolo_num`, `id_usuario_responsavel`, `direcionado_por`/`direcionado_em`, **`ciente_em`** (29/10), `status` (`aberta`/`em_andamento`/`concluida`), `concluida_em`, `comentario_conclusao` |
| `FT_TAREFAS_REGRAS` | regra tipo→analista (criada, **não usada** desde 27/10) |
| `FT_ALERTAS` | avisos pessoais do sininho (`data_alerta IS NULL`); `lido`, `acknowledged`, **`ciente_em`** |
| `FT_WHATSAPP_CONFIG` / `FT_WHATSAPP_MENSAGENS` | grupo escolhido para avisos (`chave='grupo_avisos'`) e mensagens monitoradas |

Todas entram no banco pelas **migrações aditivas** (`database/migrations_additive.go`).
⚠️ Fuso: `criado_em`, `direcionado_em`, `concluida_em`, `ciente_em` são DATETIME em **horário de
Brasília**; `FT_ALERTAS.data_criacao` é TIMESTAMP. Ao gravar por fora (script Python em UTC), usar
`NOW() - INTERVAL 3 HOUR` nas DATETIME.

## Quem recebe a tarefa

`protocolos.ResponsavelDoProtocolo` (regra do usuário: **só quem cuida do protocolo**):

1. responsável marcado no protocolo (`POST /protocolos-aneel/:id/responsavel`);
2. senão, quem fez a última movimentação do histórico do processo que **cita o nº** do protocolo;
3. o usuário `sistema` (id 999) nunca conta;
4. ninguém → tarefa **sem responsável** + aviso a todos os admins ("Tarefa sem responsável para direcionar").

Depois disso a tarefa pode mudar de mão por:
- **Direcionar** (admin, tela Tarefas) — `POST /tarefas/:id/direcionar` → zera `ciente_em`, avisa o novo
  responsável e o grupo do WhatsApp ("Tarefa direcionada para *Nome*").
- **Assumir** (qualquer usuário, sininho) — `POST /avisos/tarefas/:id/assumir`, só se não tem
  responsável; quem clicar vira responsável com ciente já dado; os avisos "sem responsável" daquele
  protocolo param de alertar; grupo do WhatsApp recebe "Tarefa assumida por *Nome*". O `UPDATE` só
  pega se ainda estiver sem dono (o segundo clique recebe 409).
- **Concluir** — `POST /tarefas/:id/concluir {comentario}` (responsável ou admin).

## Sininho (`components/AvisosBell.jsx` + `handlers/avisos_handler.go`)

Painel em portal (`document.body`, `position: fixed`, por cima de tudo). Abre na aba **Histórico de
protocolos**. Fecha com clique fora ou Esc. Atualiza a cada 60s e no evento SSE.

| Aba | Conteúdo | Ações |
|-----|----------|-------|
| **Histórico de protocolos** (todos veem) | todas as tarefas `protocolo_*` (100 últimas); **nome de quem recebeu em negrito** ("Para Fulano", "Para você (Fulano)", ou "Sem responsável" em vermelho); processo, status, "Ciente em …" | **Ciente** (só o responsável, tarefa aberta e sem ciente) · **Assumir** (tarefa sem responsável) |
| **Meus avisos** | `FT_ALERTAS` do próprio usuário; bolinha vermelha até dar ciente | **Ciente** um por vez (não existe "marcar todos") |

Rotas: `GET /avisos` → `{meus, nao_lidos, historico, eu}` · `POST /avisos/:id/ciente` ·
`POST /avisos/tarefas/:id/ciente` · `POST /avisos/tarefas/:id/assumir`.
Ciente na tarefa também apaga a bolinha dos avisos pessoais que citam o mesmo protocolo.

Mensagens: tarefa automática → "Nova tarefa para você: Protocolo ANEEL … concluído pela ANEEL
(processo #N)"; direcionada → "Nova tarefa para você: …". Exemplo visual em
`docs/exemplo_notificacao_tarefa.html`.

### Clicar no aviso → processo, na aba Histórico (29/10)

Cada item das duas abas mostra o nº do protocolo e um link **"Abrir processo #N →"** (ou "Abrir protocolo →").
Clicar no item:

| Tem processo? | Vai para | O que aparece |
|---------------|----------|---------------|
| sim | `/processos/{id}?aba=historico&protocolo=010.xxx.xxxxx-xx` | página do processo **já na aba Histórico**; no quadro "Protocolos ANEEL deste processo" a linha do protocolo do aviso fica **destacada** (fundo amarelo + marca "aviso") e a página rola até ela; abaixo, o histórico de movimentações |
| não | `/protocolos-aneel?protocolo=…` | página Protocolos ANEEL com o protocolo já consultado |

- **Histórico de protocolos**: usa `id_processo` e `protocolo_num` da própria tarefa.
- **Meus avisos**: `FT_ALERTAS` não guarda processo; o destino sai do texto do aviso — `processo #N` /
  `processos #N / #M` (pega o primeiro) e o nº `010.xxx.xxxxx-xx`. Aviso sem nenhum dos dois não é clicável.
  Por isso as mensagens de tarefa devem sempre trazer "processo #N" e o nº do protocolo formatado.
- Clicar **não** dá ciente — ciente só no botão. O botão (Ciente / Assumir) é separado da área clicável.

Código: `components/AvisosBell.jsx` (`abrir`, `destinoDoTexto`, `fmtProtocolo`); `pages/ProcessoDetalhePage.jsx` lê
`?aba=` e passa `abaInicial` ao `ProcessoDrawer` (`components/ProcessoDrawer/index.jsx`);
`ProcessoDrawer/ProtocolosAneelProcesso.jsx` lê `?protocolo=`, destaca e rola (classe `cpv2-aneel-row--destaque`
em `pages/controleProcessosV2.css`). A rota `/processos/:id` é de gestor/admin.

## WhatsApp do departamento (`backend/whatsapp/`, página `/whatsapp`)

- Um número só, conectado por **QR code** (biblioteca whatsmeow = mesma conexão do WhatsApp Web, não a
  API oficial). Sessão em SQLite no volume `whatsapp_data` (`WHATSAPP_DIR=/app/whatsapp_sessao`).
  `WHATSAPP_DESLIGADO=1` desliga (usar em backend local apontado para o banco de produção).
- Página `/whatsapp` (admin): QR, monitor de conversas, responder, escolher o **grupo de avisos**.
- Avisos enviados ao grupo (`whatsapp.AvisarGrupo`): conclusão de protocolo ("— para *Nome*" ou
  "— *sem responsável* (admin direciona)"), tarefa direcionada, tarefa assumida.
- ⚠️ Enquanto nenhum grupo for escolhido, nada sai pelo WhatsApp (só sininho).
- Não existe aviso de tarefa por e-mail.

## Página Protocolos ANEEL (`pages/ProtocolosAneel.jsx`)

Abas Consultar / Tarefas / Todos / A confirmar; botão "Consultar no site da ANEEL" (extensão);
quadro de protocolos e eventos na gaveta do processo (`ProtocolosAneelProcesso.jsx`, aba Histórico);
coluna/filtro "Concluído na ANEEL" no Controle de Processos. Texto de andamento/resposta da ANEEL é
sempre exibido **completo**.

## Métricas — tempo de resposta aos protocolos

`GET /relatorios/tempo-resposta-protocolos` (`handlers/tempo_resposta_protocolos_handler.go`,
componente `TempoRespostaProtocolos.jsx`, fim da página Métricas): para cada e-mail da ANEEL que pede
ação, mede o tempo até (a) a 1ª movimentação humana no processo, (b) o "Ciente" no sininho e (c) a
conclusão da tarefa; compara antes × depois do marco da tela de protocolos (25/10).

⚠️ **Acesso restrito por usuário** (29/10): toda a equipe é `admin`, então a rota `adminOnly` não
basta. O handler aceita só `id_usuario` **1 (Alisson), 1000 (Luana), 1004 (Eduardo)**
(`podeVerTempoRespostaProtocolos`); os demais recebem 403 e a seção some da tela.

## Relatórios de protocolos no chat (`procedit/relatorios_protocolos.go`)

| Relatório | Disparado por | Abas |
|-----------|---------------|------|
| `conclusoes_aneel` | "aneel" + "conclu" + (por dia/mês, tempo, média, quantidade, prazo…); entende "2024 a 2026" | Resumo, Concluídos por dia, por mês, Detalhe por protocolo |
| `protocolos_aneel_lista` | "aneel" + "protocolo" + (lista, todos, situação, tela…), sem "mais de N" | Resumo por situação + lista (filtros situação/vínculo) |
| `protocolos_aneel` (antigo) | "protocolos com mais de N dias" | — |

Data de conclusão = 1º evento "Concluída na ANEEL"; abertura = e-mail "Registrado na ANEEL" ou, sem ele,
o histórico do processo. Resultado até 3000 linhas (`FT_SOLICITACOES.resultado` virou `MEDIUMTEXT`).

## Arquivos

`backend/protocolos/{protocolos,site}.go` · `handlers/protocolos_aneel_handler.go` ·
`handlers/avisos_handler.go` · `handlers/tempo_resposta_protocolos_handler.go` ·
`backend/whatsapp/whatsapp.go` · `procedit/relatorios_protocolos.go` · `cmd/protocolos_aneel` ·
front: `pages/ProtocolosAneel.jsx`, `pages/WhatsappEmpresa.jsx`, `components/AvisosBell.jsx`,
`components/TempoRespostaProtocolos.jsx`, `components/ProcessoDrawer/ProtocolosAneelProcesso.jsx` ·
`extensao_aneel/`.
