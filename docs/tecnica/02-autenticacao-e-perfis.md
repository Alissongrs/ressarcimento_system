# 02 — Autenticação e Perfis

## Resumo

- **Login principal: link mágico por e-mail** (sem senha). Senha é fallback de
  emergência. O botão "Microsoft" na tela é só dica visual de e-mail corporativo
  (não é OAuth) — a vinculação Entra ID real fica em "Minha Conta".
- Sessão = **JWT HS256**, 24h, entregue em cookie HttpOnly `auth_token` **e** no corpo
  da resposta (o front guarda em `localStorage['userToken']` como fallback).
- Três papéis: **`solicitante`** (padrão), **`gestor`**, **`admin`**.

## Pacote `auth`

- `auth/jwt.go`: `JwtKey` vem de `JWT_SECRET` — **obrigatório, ≥32 chars em prod**
  (`GO_ENV=production`), senão `log.Fatal`. Em dev há fallback inseguro.
- `Claims`: `UserID int64`, `TipoConta`, `Nome`, `Email`, `UserName`, `Role` +
  `RegisteredClaims`.

## Login por senha (v1) — `handlers/auth_handler.go`

- `Login`: `SELECT ... FROM DM_USUARIO WHERE email=? AND usuario_ativo=TRUE`.
  `verifyPassword` aceita **bcrypt (cost 12)** e SHA256 legado, migrando para bcrypt
  no primeiro login bem-sucedido. Emite JWT 24h, cookie `auth_token` (HttpOnly,
  SameSite=Lax, `Secure` só se `COOKIE_SECURE=true`).
- `Register`: bcrypt, insere `perfil='solicitante'`; restrito a domínios permitidos
  (`EmailDomainAllowed`, default `@amee.com.br`); registro público desligado por
  padrão (`ALLOW_PUBLIC_REGISTER`).

## Login por link mágico (v2) — `handlers/v2/auth_magic.go`

Rotas públicas em `/api/v2`:

| Rota | Função | O que faz |
|------|--------|-----------|
| `GET /auth/magic/config` | `MagicConfig` | diz se o recurso está ligado (`MailSendConfigured`) |
| `POST /auth/magic {email}` | `MagicRequest` | sempre responde 200 genérico (sem enumerar usuário); restrito por domínio; throttle **1/60s por e-mail**; gera token `typ=magic` com `jti` aleatório, **TTL 30 min**; grava `jti/email/expires_at` em `FT_MAGIC_LINKS`; envia link por e-mail (Graph ou SMTP) |
| `GET /auth/magic/verify?token=` | `MagicVerify` | valida o token; **consumo single-use** via `DELETE FROM FT_MAGIC_LINKS WHERE jti=? AND email=? AND expires_at>NOW()` exigindo exatamente 1 linha; `findOrProvisionByEmail` acha ou **cria o usuário** (`senha_hash=NULL, perfil='solicitante', usuario_ativo=1`); emite sessão; redireciona para `/login#mstoken=<token>` (o front lê o token do fragmento) |

> **Por que o link abre no navegador padrão / Edge?** Isso é decisão do SO / do
> Outlook (a Microsoft força o Edge por padrão ao clicar links no Outlook desktop).
> Não há nada no código que escolha o navegador — o backend só gera a URL
> `{APP_PUBLIC_URL}/api/v2/auth/magic/verify?token=...`. Ajuste em
> *Outlook → Opções → Avançado → Manipulação de links* ou no app padrão do Windows.

> ⚠️ Pequeno drift de doc: o comentário no arquivo diz 15 min, mas a constante
> `magicTTL` é **30 min** — vale o código.

## Papéis e autorização

A autorização é **estrutural, por agrupamento de rotas** (ver [01](01-arquitetura-backend.md)):

- `solicitante` só alcança o grupo `authRequired` → cria/gerencia **requisições** e
  **solicitações** (fluxo chat→fila→aprovação→executor), além de leitura de auditoria.
- Mutações de processos, deferimentos, repasse, regras, admin etc. ficam sob
  `GestorMiddleware`/`StrictAdminMiddleware` → **403 para solicitante** no v1.

### Trava do solicitante (read-only) — duas camadas

1. **Camada de rota (v1):** não há middleware dedicado de "write-lock"; a trava é o
   fato de os writes viverem sob `gestorRequired`/`adminOnly`.
2. **Camada de aplicação (chat/solicitações):** em `handlers/solicitacoes.go`, ao
   criar uma solicitação, o backend:
   - classifica o pedido com `procedit.EhLeitura(msg, acao)` — leitura = consulta ou
     relatório;
   - se **não** for leitura e o usuário **não** for gestor/admin (`podeAlterar`),
     responde **403 na origem** com a mensagem "Seu perfil permite apenas consultas e
     relatórios…".

   Isso garante que mesmo via chat o solicitante não dispara escrita no banco.
   Ver [04 — Fluxo](04-fluxo-requisicao-processo.md#solicitações--assistente) e o
   pacote `procedit`.

> ⚠️ **Lacuna conhecida:** as rotas de **escrita do `/api/v2`** estão sob
> `AuthMiddleware()` apenas (sem `GestorMiddleware`). Confirmar se os handlers v2 fazem
> checagem de papel internamente; caso contrário, é um furo em relação à postura
> "nada no banco sem permissão". Registrado em [09](09-seguranca-e-pendencias.md).

## Front — consumo da auth (`context/AuthContext.jsx`)

- Decodifica o JWT de `localStorage['userToken']` (jwt-decode) → `{nome, email,
  tipo_conta, user_id}`.
- Contagem regressiva de expiração (banner ≤120s, modal "Sessão expirada"); escuta o
  evento global `auth:expired` (disparado pelo `apiClient` em 401).
- `logout()` limpa o token e chama `POST /api/v1/logout` (zera o cookie HttpOnly).
- O **menu** é montado por papel: solicitante vê só "Assistente"; gestor/admin veem a
  navegação completa (admin adiciona Métricas e Histórico).
