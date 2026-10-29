# -*- coding: utf-8 -*-
"""Motor de desvio de ÁGUA (FA02) — roda DEPOIS do agua_sync, nas faturas recém-inseridas.
Pico de consumo: consumo POR DIA de leitura >= 1,8x (80% acima de) o consumo por dia das <=12 faturas anteriores da UC
(mín. 4 de base). Histórico por (cod_empresa, cod_uc): cod_uc se repete entre empresas (26/10/2026 — antes
misturava UCs de clientes diferentes e derrubava a média). 'mediana_m3' guarda o consumo esperado para os
dias da fatura (média por dia × dias).
Grava os apontamentos em FATURA_APONTAMENTOS_AGUA_AUDITADOS (aba 💧 Água em /analise-desvio).
ressarcimento = rs_total_fat * (excedente/consumo), excedente = consumo - média.
Backup: lista dos ids inseridos (reversível: DELETE ... WHERE id IN (...)).
NÃO imprime credenciais. Uso: python agua_motor.py <dry|apply> [--desde AAAA-MM-DD] [--empresas 4,14]"""
import os, re, sys, json, datetime
from collections import Counter
import pymysql

MODE = sys.argv[1] if len(sys.argv) > 1 else "dry"
JAN, BASE_MIN, THRESH = 12, 4, 80.0  # régua do gestor (27/10/2026): aponta a partir de 80% acima da média


def _arg(nome):
    if nome in sys.argv:
        i = sys.argv.index(nome)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return ""


DESDE = _arg("--desde") or datetime.date.today().isoformat()
EMPRESAS = [int(x) for x in re.split(r"[\s,;]+", _arg("--empresas") or os.environ.get("AGUA_EMPRESAS", "")) if x.isdigit()]


def _resolve_env():
    here = os.path.dirname(os.path.abspath(__file__))
    cand = [os.environ.get("SURE_ENV"),
            os.path.join(here, "..", "..", "backend", ".env"),
            "/opt/ressarcimento/ressarcimento_system/backend/.env"]
    for p in cand:
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

_HIST = {}


def dias(ant, atu):
    """Dias de leitura da fatura; sem datas confiáveis, 30."""
    if ant and atu:
        d = (atu - ant).days
        if 15 <= d <= 400:
            return d
    return 30


def hist(emp, uc):
    if (emp, uc) not in _HIST:
        cu.execute("""SELECT mes_referencia,consumo_m3,dt_leitura_anterior,dt_leitura_atual FROM FATURA_AGUA_DADOS
                      WHERE cod_empresa=%s AND cod_uc=%s AND COALESCE(consumo_m3,0)>0 ORDER BY mes_referencia""", [emp, uc])
        _HIST[(emp, uc)] = cu.fetchall()
    return _HIST[(emp, uc)]


def calc(emp, uc, mes, consumo, dt_ant, dt_atu):
    ant = [h for h in hist(emp, uc) if h[0] < mes][-JAN:]
    if len(ant) < BASE_MIN:
        return None
    base_dia = sum(float(h[1]) for h in ant) / sum(dias(h[2], h[3]) for h in ant)
    if base_dia <= 0:
        return None
    esperado = base_dia * dias(dt_ant, dt_atu)
    return round(esperado, 2), len(ant), round((float(consumo) - esperado) / esperado * 100.0, 1)


sql = """SELECT cod_empresa,cod_uc,uc,concessionaria,mes_referencia,consumo_m3,rs_total_fat,link_fatura,
       dt_leitura_anterior,dt_leitura_atual
  FROM FATURA_AGUA_DADOS WHERE criado_em>=%s AND COALESCE(consumo_m3,0)>0"""
args = [DESDE]
if EMPRESAS:
    sql += " AND cod_empresa IN (" + ",".join(["%s"] * len(EMPRESAS)) + ")"
    args += EMPRESAS
cu.execute(sql, args)
novas = cu.fetchall()
cu.execute("SELECT cod_empresa,cod_uc,mes_referencia FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS")
ja = set((e, u, str(m)[:10]) for e, u, m in cu.fetchall())

apts = []
for emp, uc, ucn, conc, mes, cons, rs, link, dt_ant, dt_atu in novas:
    if (emp, uc, str(mes)[:10]) in ja:
        continue
    r = calc(emp, uc, mes, cons, dt_ant, dt_atu)
    if not r or r[2] < THRESH:
        continue
    med, n, desv = r
    exced = float(cons) - med
    base = float(rs or 0)
    ress = round(base * (exced / float(cons)), 2) if cons else 0.0
    apts.append((emp, uc, ucn, conc, mes, float(cons), med, n, desv, round(exced, 2), "FA02", round(base, 2), ress, link))

apts.sort(key=lambda a: -a[12])
tot = sum(a[12] for a in apts)
print(f"desde={DESDE} | faturas novas c/ consumo>0={len(novas)} | APONTAMENTOS={len(apts)} | UCs={len(set(a[1] for a in apts))}")
print("apontamentos por empresa:", dict(sorted(Counter(a[0] for a in apts).items())))
print(f"ressarcimento estimado total: R$ {tot:,.2f}")
for a in apts[:10]:
    print(f"  emp{a[0]} uc{a[1]} {str(a[4])[:7]} consumo={a[5]:.0f} m3 media={a[6]:.1f} desvio={a[8]:.0f}% ress=R${a[12]:,.2f}")

if MODE != "apply" or not apts:
    print("\nDRY. nada inserido." if MODE != "apply" else "\nOK. 0 apontamentos de agua inseridos.")
    cx.close()
    sys.exit()

cu.execute("SELECT COALESCE(MAX(id),0) FROM FATURA_APONTAMENTOS_AGUA_AUDITADOS FOR UPDATE")
nid = cu.fetchone()[0] + 1
now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
COLS = "id,cod_empresa,cod_uc,uc,concessionaria,mes_referencia,consumo_m3,mediana_m3,n_meses,desvio_pct,excedente_m3,ficha,base_rs,ressarcimento_estimado,link_fatura,criado_em"
vals = []
for a in apts:
    vals.append((nid,) + a + (now,))
    nid += 1
ids = [v[0] for v in vals]
bakdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "backups")
os.makedirs(bakdir, exist_ok=True)
bak = os.path.join(bakdir, "backup_agua_motor_%s.json" % datetime.datetime.now().strftime("%Y%m%d_%H%M%S"))
json.dump({"tabela": "FATURA_APONTAMENTOS_AGUA_AUDITADOS", "ids_inseridos": ids, "desde": DESDE}, open(bak, "w", encoding="utf-8"))
print("backup ids:", bak)
cu.executemany(f"INSERT INTO FATURA_APONTAMENTOS_AGUA_AUDITADOS ({COLS}) VALUES (" + ",".join(["%s"] * 16) + ")", vals)
cx.commit()
print(f"OK. {len(vals)} apontamentos de agua inseridos.")
cx.close()
