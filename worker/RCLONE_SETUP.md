# Setup rclone + Google Drive na VPS (anexos dos pedidos → link)

> **Para o Claude da VPS executar.** Objetivo: instalar o `rclone` no host, autenticar um remote
> `gdrive` e deixar o cron subir os anexos dos pedidos pro Google Drive, gravando um **link público
> ("qualquer pessoa com o link")** em `FT_SOLICITACOES_ANEXOS.drive_link`.
>
> Contexto: o backend roda em container; o `rclone` fica **no host**. O upload é feito pelo script
> `worker/drive_sync_anexos.py` (cron do host), que lê o blob do anexo no banco, sobe via rclone e
> salva o link. Decisões já tomadas pelo Alisson: **rclone na VPS** + **link público**.
> Nunca imprimir credenciais do banco.

## 0) Pré-requisitos (conferir)
```bash
python3 -c "import pymysql; print('pymysql ok')"   # já usado pelos outros workers
ls /opt/ressarcimento/ressarcimento_system/worker/drive_sync_anexos.py
```
A coluna `drive_link` é criada sozinha pelo backend (ALTER idempotente) no próximo deploy — não
precisa mexer no banco.

## 1) Instalar o rclone
```bash
curl -fsSL https://rclone.org/install.sh | sudo bash   # OU: sudo apt-get install -y rclone
rclone --version
```

## 2) Autenticar o remote `gdrive` (OAuth headless — a VPS não tem navegador)
O OAuth do Google precisa de um navegador **uma vez**. Na VPS (sem interface) faça o fluxo headless:

```bash
rclone config
#  n) New remote
#  name> gdrive
#  Storage> drive            (Google Drive)
#  client_id>  (ENTER — deixa vazio p/ usar o padrão; OU cole um client_id próprio do Google Cloud)
#  client_secret> (ENTER / ou o secret próprio)
#  scope> 1                  (drive — acesso total; ou 3 = drive.file p/ só o que o app cria)
#  service_account_file> (ENTER)
#  Edit advanced config? > n
#  Use auto config? > n      ← IMPORTANTE (headless)
```
O rclone vai mostrar um comando tipo:
```
rclone authorize "drive" "........"
```
**Rode ESSE comando numa máquina COM navegador** (o PC do Alisson, por ex., que já tem rclone do
projeto Claro). Ele abre o navegador, você faz login na conta Google que vai guardar os arquivos,
e devolve um bloco `{"access_token":...}`. **Cole esse bloco de volta** no prompt da VPS.
Finalize: `y` (ok) → `q` (quit).

> Dica: se preferir, dá pra usar uma **conta de serviço** (service account JSON) em vez de OAuth —
> aí no `rclone config` aponte `service_account_file` para o JSON e pule o `authorize`. (Alisson
> escolheu rclone/OAuth; a conta de serviço é alternativa equivalente.)

## 3) Testar o remote + pasta + link
```bash
rclone mkdir gdrive:SURE/anexos
echo "teste sure $(date)" > /tmp/sure_teste.txt
rclone copyto /tmp/sure_teste.txt gdrive:SURE/anexos/_teste.txt
rclone link gdrive:SURE/anexos/_teste.txt      # deve imprimir um link https://drive.google.com/...
# abra o link anônimo (aba privada) p/ confirmar que é "qualquer um com o link"
rclone deletefile gdrive:SURE/anexos/_teste.txt
rm -f /tmp/sure_teste.txt
```
Se o `rclone link` falhar com erro de permissão, confirme no Google que a conta **permite
compartilhar por link** (políticas de workspace podem bloquear links públicos).

## 4) Rodar o upload uma vez (manual) e conferir
```bash
cd /opt/ressarcimento/ressarcimento_system
python3 worker/drive_sync_anexos.py
```
Esperado: `[drive] N anexo(s)...` e, por anexo, `OK -> https://drive.google.com/...`.
Confere no banco (sem expor senha — usa o DB_APP_URL do backend/.env):
```bash
# deve listar os anexos já com link
python3 - <<'PY'
import os,re,io,sys
sys.path.insert(0,'worker'); from has_work import ler_dsn
import pymysql; u,p,h,port,db=ler_dsn()
c=pymysql.connect(host=h,port=port,user=u,password=p,database=db).cursor()
c.execute("SELECT id,nome,LEFT(drive_link,60) FROM FT_SOLICITACOES_ANEXOS WHERE drive_link IS NOT NULL ORDER BY id DESC LIMIT 10")
[print(r) for r in c.fetchall()]
PY
```

## 5) Ligar no cron
O `worker/crontab.sure` já tem a linha (a cada 5 min):
```
*/5 * * * *  cd /opt/ressarcimento/ressarcimento_system && python3 $W/drive_sync_anexos.py >/dev/null 2>&1
```
Instale/atualize o crontab:
```bash
crontab /opt/ressarcimento/ressarcimento_system/worker/crontab.sure
crontab -l | grep drive_sync
```

## Retenção (20 dias)
O mesmo script, a cada rodada, **expira** anexos com mais de **20 dias** (`criado_em`): apaga o
arquivo do Drive (`rclone deletefile`) **e** remove o anexo do banco. O pedido e o resultado (texto)
continuam; só o arquivo some. Para ter de novo, basta **pedir pra gerar novamente**. Ajuste o prazo
com `SURE_DRIVE_DIAS` (default `20`).

## Variáveis opcionais (env do cron/host)
- `SURE_RCLONE_REMOTE` (default `gdrive`) · `SURE_DRIVE_DIR` (default `SURE/anexos`)
- `SURE_RCLONE_BIN` (default `rclone`) · `SURE_DRIVE_LOTE` (default `20` por rodada)
- `SURE_DRIVE_DIAS` (default `20`) — dias de retenção antes de apagar o arquivo (Drive + banco)

## Resultado
No chat/pedido, cada anexo passa a mostrar, ao lado do botão de download, um botão **"Drive"**
que abre o arquivo pelo link público — pronto pra compartilhar (ex.: com a Light). O download
direto pelo SURE continua funcionando normalmente.
