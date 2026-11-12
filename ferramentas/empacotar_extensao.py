# -*- coding: utf-8 -*-
"""Empacota a extensão do SURE (pasta extensao_aneel) em frontend/public/extensao_sure.zip.

O zip é servido pelo próprio SURE (botão "Baixar a extensão do SURE" nas telas Tarefas e Protocolos ANEEL).
Rode sempre que mudar algo na extensão, ANTES do deploy:  python ferramentas/empacotar_extensao.py
Dentro do zip a pasta se chama extensao_sure/ — é ela que se escolhe em "Carregar sem compactação".
"""
import json
import os
import zipfile

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ORIGEM = os.path.join(RAIZ, "extensao_aneel")
DESTINO = os.path.join(RAIZ, "frontend", "public", "extensao_sure.zip")
VERSAO = os.path.join(RAIZ, "frontend", "public", "extensao_sure.json")

arquivos = sorted(f for f in os.listdir(ORIGEM)
                  if os.path.isfile(os.path.join(ORIGEM, f)) and not f.endswith((".zip", ".bak")))
with zipfile.ZipFile(DESTINO, "w", zipfile.ZIP_DEFLATED) as z:
    for f in arquivos:
        z.write(os.path.join(ORIGEM, f), "extensao_sure/" + f)
man = json.load(open(os.path.join(ORIGEM, "manifest.json"), encoding="utf-8"))
json.dump({"versao": man["version"], "nome": man["name"]}, open(VERSAO, "w", encoding="utf-8"), ensure_ascii=False)
print(f"{DESTINO}  ({len(arquivos)} arquivos, versão {man['version']})")
