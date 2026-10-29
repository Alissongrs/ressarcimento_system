# -*- coding: utf-8 -*-
"""Regra de ÁGUA "cobrança sem medição" (FA05) — roda DEPOIS do agua_motor, no job de água.
Sinal: a UC cobrada com EXATAMENTE o mesmo m³ por >= 3 faturas seguidas, >= 1,5x o normal da UC (mediana dos
outros meses, mín. 4) e >= 5 m³ acima — típico de cobrança pela média/estimativa/mínimo com o hidrômetro parado,
quebrado, imóvel fechado ou leitura impedida. É só o SINAL: a prova (leituras e avisos impressos) é conferida na
fatura antes da requisição.
Grava UM apontamento por sequência em FATURA_APONTAMENTOS_AGUA_AUDITADOS (ficha FA05, mes_referencia = último mês
da sequência, n_meses = meses da sequência, ressarcimento = soma do valor cobrado acima do normal). Se a
sequência cresce (mais um mês igual), atualiza o mesmo apontamento. Backup dos ids inseridos/atualizados.
NÃO imprime credenciais. Uso: python agua_sem_medicao.py <dry|apply> [--empresas 4,14]"""
import os, re, sys, json, datetime, statistics
import pymysql

MODE = sys.argv[1] if len(sys.argv) > 1 else "dry"
MIN_MESES, FATOR, MIN_DIF = 3, 1.5, 5.0


def _arg(nome):
    if nome in sys.argv:
        i = sys.argv.index(nome)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return ""


EMPRESAS = [int(x) for x in re.split(r"[\s,;]+", _arg("--empresas") or os.environ.get("AGUA_EMPRESAS", "")) if x.isdigit()]


def _resolve_env():
    here = os.path.dirname(os.path.abspath(__file__))
    for p in [os.environ.get("SURE_ENV"), os.path.join(here, "..", "..", "backend", ".env"),
              "/opt/ressarcimento/ressarcimento_system/backend/.env"]:
        if p and os.path.exists(p):
            return p
    raise SystemExit("ERRO: .env nao encontrado (defina SURE_ENV).")


def _dsn():
    env = {}
    for ln in open(_resolve_env(), encoding="utf-8", errors="ignore"):
        ln = ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k, v = ln.split("=", 1)
            env[k.strip()] = v.strip().strip('"').strip("'")
    m = re.match(r"^(?P<user>[^:/@]+):(?P<password>[^@]*)@tcp\((?P<host>[^:)]+)(?::(?P<port>\d+))?\)/(?P<database>[^?]*)", env["DB_APP_URL"])
    return dict(host=m.group("host"), port=int(m.group("port") or 3306), user=m.group("user"),
                password=m.group("password"), database=m.group("database"))


cx = pymysql.connect(**_dsn(), charset="utf8mb4", connect_timeout=15, read_timeout=300, autocommit=False)
cu = cx.cursor()
sql = """SELECT cod_empresa, cod_uc, uc, concessionaria, mes_referencia, consumo_m3, rs_total_fat, link_fatura
         FROM FATURA_AGUA_DADOS WHERE COALESCE(consumo_m3,0) > 0"""
args = []
if EMPRESAS:
    sql += " AND cod_empresa IN (" + ",".join(["%s"] * len(EMPRESAS)) + ")"
    args = EMPRESAS
cu.execute(sql + " ORDER BY cod_empresa, cod_uc, mes_referencia", args)
by = {}
for r in cu.fetchall():
    by.setdefault((r[0], r[1]), []).append(r)

seqs = []
for (emp, uc), rows in by.items():
    i = 0
    while i < len(rows):
        j = i
        while j + 1 < len(rows) and float(rows[j + 1][5]) == float(rows[i][5]):
            j += 1
        n = j - i + 1
        if n >= MIN_MESES:
            v = float(rows[i][5])
            outros = [float(r[5]) for r in rows if float(r[5]) != v]
            if len(outros) >= 4:
                med = statistics.median(outros)
                if v >= FATOR * med and v - med >= MIN_DIF:
                    seq = rows[i:j + 1]
                    base = sum(float(r[6] or 0) for r in seq)
                    ress = sum((v - med) / v * float(r[6] or 0) for r in seq)
                    seqs.append((emp, uc, seq[-1][2], seq[-1][3], seq[0][4], seq[-1][4], v, round(med, 2), n,
                                 round((v - med) / med * 100, 1) if med else 0.0, round((v - med) * n, 2), round(base, 2), round(ress, 2), seq[-1][7]))
        i = j + 1

# apontamentos FA05 que já existem (a sequência pode ter crescido desde a última rodada)
cu.execute("SELECT id, cod_empresa, cod_uc, mes_referencia, n_meses FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS WHERE ficha = 'FA05'")
existentes = {}
for i, e, u, m, n in cu.fetchall():
    existentes.setdefault((e, u), []).append((i, m, n))
novos, atualizar = [], []
for s in seqs:
    emp, uc, inicio, fim = s[0], s[1], s[4], s[5]
    achou = None
    for i, m, n in existentes.get((emp, uc), []):
        if inicio <= m <= fim:  # mesmo período (o apontamento antigo cai dentro da sequência)
            achou = (i, m, n)
    if achou is None:
        novos.append(s)
    elif achou[1] != fim or achou[2] != s[8]:
        atualizar.append((achou[0], s))

print(f"sequências={len(seqs)} | novas={len(novos)} | a atualizar={len(atualizar)} | "
      f"cobrado acima do normal (novas) R$ {sum(s[12] for s in novos):,.2f}")
for s in sorted(novos, key=lambda x: -x[12])[:10]:
    print(f"  emp{s[0]} uc{s[2]} {str(s[4])[:7]}..{str(s[5])[:7]} ({s[8]} meses) {s[6]:.0f} m3 x normal {s[7]:.1f} R${s[12]:,.2f}")
if MODE != "apply" or not (novos or atualizar):
    print("\nDRY. nada gravado." if MODE != "apply" else "\nOK. nada a gravar.")
    cx.close()
    sys.exit()

cu.execute("SELECT COALESCE(MAX(id),0) FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS FOR UPDATE")
nid = cu.fetchone()[0] + 1
agora = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
vals = []
for s in novos:
    emp, uc, ucn, conc, ini, fim, v, med, n, desv, exc, base, ress, link = s
    vals.append((nid, emp, uc, ucn, conc, fim, v, med, n, desv, exc, "FA05", base, ress, link, agora))
    nid += 1
bakdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backups")
os.makedirs(bakdir, exist_ok=True)
cu.execute("SELECT * FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS WHERE id IN (" + ",".join(str(a[0]) for a in atualizar) + ")" if atualizar else "SELECT 1 LIMIT 0")
antes = [list(map(str, r)) for r in cu.fetchall()]
bak = os.path.join(bakdir, "backup_agua_sem_medicao_%s.json" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S"))
json.dump({"ids_inseridos": [v[0] for v in vals], "atualizados_antes": antes}, open(bak, "w", encoding="utf-8"))
COLS = "id,cod_empresa,cod_uc,uc,concessionaria,mes_referencia,consumo_m3,mediana_m3,n_meses,desvio_pct,excedente_m3,ficha,base_rs,ressarcimento_estimado,link_fatura,criado_em"
if vals:
    cu.executemany(f"INSERT INTO FATURA_APONTAMENTOS_AGUA_AUDITADOS ({COLS}) VALUES (" + ",".join(["%s"] * 16) + ")", vals)
for i, s in atualizar:
    cu.execute("""UPDATE FATURA_APONTAMENTOS_AGUA_AUDITADOS SET mes_referencia=%s, consumo_m3=%s, mediana_m3=%s, n_meses=%s,
                  desvio_pct=%s, excedente_m3=%s, base_rs=%s, ressarcimento_estimado=%s, link_fatura=%s WHERE id=%s""",
               (s[5], s[6], s[7], s[8], s[9], s[10], s[11], s[12], s[13], i))
cx.commit()
print(f"OK. {len(vals)} inseridos, {len(atualizar)} atualizados | backup {bak}")
cx.close()
