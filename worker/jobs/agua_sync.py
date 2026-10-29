# -*- coding: utf-8 -*-
"""Sync agua: origem sgeeasy_clientes_novo.Faturas_Registradas_Agua_Cache -> db_ressarcimento.FATURA_AGUA_DADOS.
Insere SO faturas novas (Cod_Fatura ainda nao presente no dest) das empresas alvo.
NAO imprime credenciais. Uso: python agua_sync.py <dry|apply>"""
import os,re,sys,datetime
import pymysql
MODE=sys.argv[1] if len(sys.argv)>1 else "dry"
# Lista de empresas: AGUA_EMPRESAS="4,14,32" (env) ou --empresas 4,14,32; sem isso, a lista padrão abaixo.
EMPRESAS=[4,14,32,33,42,69,80,120,144,154,180,183,189,191,202,203,204,205,206,207,208,209,210,212,214,216,217,218,219,223,224,359,362,363,366,367,371,374,375,377]
_emp=os.environ.get("AGUA_EMPRESAS","")
if "--empresas" in sys.argv:
    _i=sys.argv.index("--empresas")
    if _i+1<len(sys.argv): _emp=sys.argv[_i+1]
if _emp.strip():
    EMPRESAS=[int(x) for x in re.split(r"[\s,;]+",_emp.strip()) if x.isdigit()]
print("empresas:",",".join(str(e) for e in EMPRESAS))
def _resolve_env():
    here=os.path.dirname(os.path.abspath(__file__))
    cand=[os.environ.get("SURE_ENV"),
          os.path.join(here,".env"),
          os.path.join(here,"backend",".env"),
          os.path.join(here,"..","..","backend",".env"),   # worker/jobs/ -> backend/.env
          "/opt/ressarcimento/ressarcimento_system/backend/.env",
          r"C:\Users\AlissonGonçalvesRodr\OneDrive - AMEnergia\Área de Trabalho\Docker\ressarcimento_system\backend\.env"]
    for p in cand:
        if p and os.path.exists(p): return p
    raise SystemExit("ERRO: .env nao encontrado (defina SURE_ENV).")
ENV=_resolve_env()
def load_env(p):
    d={}
    for ln in open(p,encoding="utf-8",errors="ignore"):
        ln=ln.strip()
        if ln and not ln.startswith("#") and "=" in ln:
            k,v=ln.split("=",1); d[k.strip()]=v.strip().strip('"').strip("'")
    return d
def go_dsn(dsn):
    m=re.match(r"^(?P<user>[^:/@]+):(?P<password>[^@]*)@tcp\((?P<host>[^:)]+)(?::(?P<port>\d+))?\)/(?P<database>[^?]*)",dsn)
    return dict(host=m.group("host"),port=int(m.group("port") or 3306),user=m.group("user"),password=m.group("password"),database=m.group("database"))
def fixm(s):
    """Acentuação estragada na origem (UTF-8 lido como cp1252: "MauÃ¡" -> "Mauá"); repete enquanto melhorar."""
    for _ in range(3):
        if "Ã" not in s and "Â" not in s: break
        for enc in ("cp1252","latin1"):
            try: s=s.encode(enc).decode("utf-8"); break
            except (UnicodeEncodeError,UnicodeDecodeError): continue
        else: break
    return s
env=load_env(ENV)
cfg=go_dsn(env["DB_FATURAS"])              # ORIGEM (sgeeasy_clientes_novo)
dcfg=go_dsn(env["DB_APP_URL"])            # DESTINO (db_ressarcimento) — lido do .env, sem hardcode
ori=pymysql.connect(host=cfg["host"],port=cfg["port"],user=cfg["user"],password=cfg["password"],database=cfg["database"],charset="utf8mb4",connect_timeout=20,read_timeout=180)
dst=pymysql.connect(host=dcfg["host"],port=dcfg["port"],user=dcfg["user"],password=dcfg["password"],database=dcfg["database"],charset="utf8mb4",connect_timeout=15,read_timeout=300,autocommit=False)
oc=ori.cursor(); dc=dst.cursor()
ph=",".join(["%s"]*len(EMPRESAS))
# chave de fatura = (cod_empresa, cod_uc, mes_referencia) -> UNICA no dest
dc.execute(f"SELECT cod_empresa,cod_uc,mes_referencia FROM FATURA_AGUA_DADOS WHERE cod_empresa IN ({ph})",EMPRESAS)
def k(e,u,m): return (e,u,str(m)[:10] if m else None)
ja=set(k(*r) for r in dc.fetchall())
print(f"dest ja tem {len(ja)} faturas (emp,uc,mes) dessas empresas")
# mapeamento origem->dest
MAP=[("cod_empresa","Cod_Empresa"),("cod_uc","Cod_UC"),("cod_fatura","Cod_Fatura"),("uc","UC"),("apelido","Apelido"),
 ("concessionaria","Concessionaria"),("cnpj_fatura","CNPJ_Fatura"),("cidade","Cidade"),("uf","UF"),("mes_referencia","Mes_Ref"),
 ("consumo_m3","Consumo_M3"),("m3_agua_fat","M3_AGUA_FAT"),("m3_esgoto_fat","M3_ESGOTO_FAT"),("m3_total","M3_TOTAL"),
 ("rs_agua_fat","RS_AGUA_FAT"),("rs_esgoto_fat","RS_ESGOTO_FAT"),("rs_tratesgoto_fat","RS_TRATESGOTO_FAT"),("rs_total_fat","RS_TOTAL_FAT"),
 ("rs_m3","RS_M3"),("valor_total","Valor_Total"),("dt_leitura_anterior","Dt_Leitura_Anterior"),("dt_leitura_atual","Dt_Leitura_Atual"),
 ("hidrometro","Hidrometro"),("link_fatura","Link"),("status","Status")]
src_cols=",".join(f"`{s}`" for _,s in MAP)
# so faturas registradas (Cod_Fatura preenchido) -> exclui placeholders sem fatura
oc.execute(f"SELECT `Cod_Fatura`,{src_cols} FROM Faturas_Registradas_Agua_Cache WHERE Cod_Empresa IN ({ph}) AND Cod_Fatura IS NOT NULL",EMPRESAS)
rows=oc.fetchall()
# key nas colunas do MAP: r[1]=cod_empresa, r[2]=cod_uc, r[10]=mes_referencia
novas=[r for r in rows if k(r[1],r[2],r[10]) not in ja]
from collections import Counter
por_emp=Counter(r[1] for r in novas)
print(f"origem faturas registradas={len(rows)} | JA no dest={len(rows)-len(novas)} | NOVAS={len(novas)}")
print("novas por empresa:",dict(sorted(por_emp.items())))
if novas:
    print("amostra nova (emp, uc, mes, m3_total, valor):")
    for r in novas[:8]: print("  ",r[1],r[4],r[10],r[14],r[20])
if MODE!="apply":
    print("\nDRY. nada inserido."); ori.close(); dst.close(); sys.exit()
# backup das chaves a inserir (reversivel: DELETE por criado_em ou por essas chaves)
import io,json
_bakdir=os.environ.get("SURE_AGUA_BACKUP_DIR") or os.path.dirname(os.path.abspath(__file__))
bak=os.path.join(_bakdir,"backup_agua_sync_%s.json"%datetime.datetime.now().strftime("%Y%m%d_%H%M%S"))
io.open(bak,"w",encoding="utf-8").write(json.dumps([{"emp":r[1],"uc":r[2],"mes":str(r[10])[:10]} for r in novas],ensure_ascii=False,default=str))
print("backup chaves:",bak)
# id NAO e auto_increment -> gerar sequencial a partir de MAX+1
dc.execute("SELECT COALESCE(MAX(id),0) FROM FATURA_AGUA_DADOS"); next_id=dc.fetchone()[0]+1
dest_cols=[d for d,_ in MAP]
cols_sql="id,"+",".join(dest_cols)+",criado_em"
place="(%s,"+",".join(["%s"]*len(dest_cols))+",%s)"
now=datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
n=0
for i in range(0,len(novas),500):
    chunk=novas[i:i+500]
    vals=[]
    for r in chunk:
        vals.append((next_id,)+tuple(fixm(x) if isinstance(x,str) else x for x in r[1:])+(now,)); next_id+=1  # r[1:]=colunas na ordem do MAP
    dc.executemany(f"INSERT INTO FATURA_AGUA_DADOS ({cols_sql}) VALUES {place}",vals)
    dst.commit(); n+=len(chunk); print(f"  inseridas {n}/{len(novas)}",flush=True)
print(f"OK. {n} faturas de agua novas inseridas.")
ori.close(); dst.close()
