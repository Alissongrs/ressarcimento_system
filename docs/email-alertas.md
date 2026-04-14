# Sistema de E-mail e Alertas

## Provedor de E-mail

**Microsoft Graph API** via Azure AD  
Remetente: `complaint@amee.com.br`

### Credenciais necessárias (backend/.env)
```
AZURE_CLIENT_ID=...
AZURE_CLIENT_SECRET=...
AZURE_TENANT_ID=...
```

### Funções de envio (services/automation_service.go)
```go
SendEmail(to, subject, body string) error
SendEmailDetailed(to, cc, bcc, subject, body string) error
SendEmailDetailedWithAttachments(to, cc, bcc, subject, body string, attachments []EmailAttachment) error
```

---

## Tipos de Alerta

### Alerta Pessoal (para_todos = false)
- Criado pelo usuário para si mesmo
- E-mail enviado **imediatamente** ao criar o alerta
- Destinatário: somente o criador
- Template: "🔔 Lembrete registrado" com badge de urgência

**Badge de urgência:**
| Condição | Label | Cor |
|----------|-------|-----|
| Data passada | Vencido | Vermelho |
| Hoje | Vence hoje | Laranja |
| Amanhã | Vence amanhã | Âmbar |
| +2 dias | Vence em X dias | Azul |

### Alerta da Equipe (para_todos = true)
- Visível para todos os usuários no dia do vencimento
- E-mail enviado **no dia do vencimento** (cron diário às 08:00)
- Destinatários fixos: Alisson (1), Luana (1000), Eliane (1001), Paulo (1003), Eduardo (1004)
- Template: "🔔 Lembretes da equipe" com lista de todos os alertas do dia

---

## Disparo Manual (Admin)

```bash
# Disparo normal — somente alertas que vencem hoje
POST /api/v1/admin/alertas/disparar-agora

# Force — envia todos os pendentes independente de data (para testes)
POST /api/v1/admin/alertas/disparar-agora?force=1
```

**Via console do navegador:**
```js
fetch('/api/v1/admin/alertas/disparar-agora?force=1', {
  method: 'POST',
  headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
}).then(r => r.json()).then(console.log)
```

---

## Cron Automático

O serviço `ChecarAlertasParaTodos()` deve ser chamado diariamente às 08:00.
Configurado em `backend/main.go` via goroutine com ticker.

### Lógica
1. Busca alertas `para_todos=1` onde `DATE(data_alerta) = CURDATE()` e `email_enviado_em IS NULL`
2. Busca e-mails dos 5 membros da equipe em `DM_USUARIOS`
3. Monta e envia e-mail HTML
4. Marca `email_enviado_em = NOW()` nos alertas enviados

---

## Design dos Templates

Ambos os e-mails seguem o mesmo padrão visual:

```
┌─────────────────────────────────────────┐
│  AM Energia · Sistema de Ressarcimento  │ ← azul escuro
│  🔔 [Título]                            │ gradiente → azul
│  Segunda-feira, 13/04/2026              │
├─────────────────────────────────────────┤
│  [Corpo personalizado]                  │
│  [Card com mensagem do alerta]          │
│  [Badge de urgência / lista de alertas] │
│  [Botão CTA]                            │
├─────────────────────────────────────────┤
│  Gerado automaticamente · AM Energia    │ ← cinza claro
└─────────────────────────────────────────┘
```
