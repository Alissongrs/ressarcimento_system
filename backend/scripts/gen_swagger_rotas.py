"""Gera as anotações do Swagger para as rotas que ainda não têm @Router.

O Swagger (/swagger, gerado no build por `swag init -g main.go -o docs`) só mostra rotas anotadas
nos handlers. Este script lê as rotas registradas em routes/routes.go (/api/v1) e
handlers/v2/routes_v2.go (/api/v2), pula as que já têm @Router em algum arquivo e escreve um bloco
de anotação para cada uma das outras em handlers/zz_swagger_rotas_gen.go (arquivo gerado — não editar
à mão; para descrever melhor uma rota, anote o próprio handler e rode de novo).

Uso (na pasta backend/):
    python scripts/gen_swagger_rotas.py
    swag init -g main.go -o docs        # opcional: o Dockerfile já roda no build
"""
import io
import os
import re
import sys

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SAIDA = os.path.join(BACKEND, 'handlers', 'zz_swagger_rotas_gen.go')

REG = re.compile(r'^\s*(\w+)\.(GET|POST|PUT|PATCH|DELETE)\(\s*"([^"]*)"\s*,(.*)\)\s*(//.*)?$')
HANDLER = re.compile(r'([A-Za-z_][\w.]*)\s*$')

# acesso de cada grupo de rotas (nome da variável do grupo em routes.go)
ACESSO = {
    'apiV1': ('publico', ''),
    'authRequired': ('auth', 'Qualquer usuário autenticado.'),
    'gestorRequired': ('auth', 'Gestor ou admin.'),
    'adminOnly': ('auth', 'Somente admin.'),
    'group': ('auth', 'Gestor ou admin.'),  # registerGestorHistoricoRoutes
}

# descrições à mão para os módulos novos (o resto sai do nome do handler)
RESUMO = {
    'GetAvisos': 'Sininho: meus avisos, não lidos e histórico de tarefas de protocolo',
    'AvisoCiente': 'Sininho: dar ciente em um aviso pessoal',
    'TarefaCiente': 'Sininho: ciente na tarefa (só quem recebeu)',
    'TarefaAssumir': 'Sininho: assumir tarefa sem responsável',
    'ListarProtocolosAneel': 'Lista os protocolos da Ouvidoria ANEEL',
    'ResumoProtocolosPorProcesso': 'Resumo de protocolos ANEEL por processo',
    'ProtocolosDoProcesso': 'Protocolos ANEEL e eventos de um processo',
    'ConsultarProtocoloAneel': 'Consulta um protocolo ANEEL pelo número',
    'AnalistasProtocolosAneel': 'Analistas que podem receber tarefas de protocolo',
    'VincularProtocoloAneel': 'Vincula um protocolo ANEEL a um processo',
    'SincronizarProtocolosAneel': 'Atualizar agora: lê os e-mails da ANEEL e gera eventos/tarefas',
    'AbertosSiteAneel': 'Protocolos abertos para a extensão consultar no site da ANEEL',
    'ImportarSiteAneel': 'Recebe da extensão a situação lida no site da ANEEL',
    'ResponsavelProtocoloAneel': 'Define o responsável de um protocolo',
    'ConfirmarVinculoProtocoloAneel': 'Confirma o processo de um protocolo citado em mais de um',
    'ListarTarefas': 'Lista as tarefas de protocolo',
    'ListarRegrasTarefa': 'Regras tipo de mudança → analista (legado)',
    'SalvarRegraTarefa': 'Salva regra tipo de mudança → analista (legado)',
    'DirecionarTarefa': 'Direciona a tarefa para um analista (admin)',
    'ConcluirTarefa': 'Conclui a tarefa com comentário',
    'WhatsappEstado': 'WhatsApp: estado da conexão / QR code',
    'WhatsappConectar': 'WhatsApp: iniciar conexão por QR code',
    'WhatsappDesconectar': 'WhatsApp: desconectar o aparelho',
    'WhatsappConversas': 'WhatsApp: conversas monitoradas',
    'WhatsappMensagens': 'WhatsApp: mensagens de uma conversa',
    'WhatsappInsights': 'WhatsApp: resumo das conversas',
    'WhatsappEnviar': 'WhatsApp: enviar mensagem',
    'WhatsappGrupos': 'WhatsApp: grupos do número conectado',
    'WhatsappDefinirGrupo': 'WhatsApp: escolher o grupo que recebe os avisos de tarefas',
    'GetTempoRespostaProtocolos': 'Métricas: tempo de resposta aos protocolos ANEEL (só Alisson, Luana e Eduardo)',
}

TAG = {
    'protocolos-aneel': 'Protocolos ANEEL', 'tarefas': 'Tarefas', 'avisos': 'Avisos (sininho)',
    'whatsapp': 'WhatsApp', 'rotinas': 'Rotinas', 'relatorios': 'Relatórios', 'processos': 'Processos',
    'requisicoes': 'Requisições', 'solicitacoes': 'Solicitações', 'faturas': 'Faturas', 'mail': 'E-mail',
    'auth': 'Auth', 'health': 'Health', 'healthz': 'Health', 'alertas': 'Alertas', 'regras': 'Regras',
    'rules': 'Regras', 'agua': 'Água', 'informativo': 'Informativo', 'chat': 'Chat', 'historico': 'Histórico',
}


def ler(p):
    return io.open(os.path.join(BACKEND, p), encoding='utf-8', errors='replace').read()


def ja_anotadas():
    feitas = set()
    for raiz, dirs, arqs in os.walk(BACKEND):
        dirs[:] = [d for d in dirs if d not in ('vendor', 'docs', 'node_modules', '.git') and not d.startswith('_')]
        for a in arqs:
            if not a.endswith('.go') or a == os.path.basename(SAIDA):
                continue
            for m in re.finditer(r'@Router\s+(\S+)\s+\[(\w+)\]', io.open(os.path.join(raiz, a), encoding='utf-8', errors='replace').read()):
                feitas.add((m.group(1), m.group(2).upper()))
    return feitas


def rotas_v1():
    linhas = ler('routes/routes.go').splitlines()
    fim_v1 = next(i for i, l in enumerate(linhas) if 'apiV2 := r.Group("/api/v2")' in l)
    out = []
    for i, l in enumerate(linhas[:fim_v1]):
        m = REG.match(l)
        if not m or m.group(1) not in ACESSO:
            continue
        h = HANDLER.search(m.group(4).strip())
        if not h or 'func(' in m.group(4):
            continue
        out.append(('/api/v1', m.group(1), m.group(2), m.group(3), h.group(1)))
    return out


def rotas_v2():
    out, grupo = [], None
    for l in ler('handlers/v2/routes_v2.go').splitlines():
        f = re.match(r'^func (\w+)\(', l)
        if f:
            grupo = 'apiV1' if f.group(1) == 'RegisterAuthRoutesPublic' else 'authRequired'
            continue
        m = REG.match(l)
        if m and grupo:
            h = HANDLER.search(m.group(4).strip())
            if h:
                out.append(('/api/v2', grupo, m.group(2), m.group(3), 'v2.' + h.group(1)))
    return out


def resumo(handler):
    nome = handler.split('.')[-1]
    if nome in RESUMO:
        return RESUMO[nome]
    palavras = re.findall(r'[A-Z]+(?=[A-Z][a-z]|\d|$)|[A-Z]?[a-z]+|\d+', nome)
    txt = ' '.join(palavras).lower()
    return (txt[:1].upper() + txt[1:]) if txt else nome


def main():
    feitas = ja_anotadas()
    rotas = rotas_v1() + rotas_v2()
    blocos, vistos = [], set()
    for prefixo, grupo, metodo, caminho, handler in rotas:
        swag = (prefixo + '/' + caminho.lstrip('/')).rstrip('/') or prefixo
        swag = re.sub(r':(\w+)', r'{\1}', swag)
        swag = re.sub(r'\*(\w+)', r'{\1}', swag)
        chave = (swag, metodo)
        if chave in feitas or chave in vistos:
            continue
        vistos.add(chave)
        seg = [s for s in swag.split('/')[3:] if s and not s.startswith('{')]
        tag = TAG.get(seg[0], seg[0]) if seg else ('v2' if prefixo == '/api/v2' else 'Geral')
        if prefixo == '/api/v2':
            tag = 'v2 · ' + tag
        seguranca, acesso = ACESSO[grupo]
        linhas = [f'// @Summary {resumo(handler)}']
        desc = (acesso + ' ' if acesso else 'Pública. ') + f'Handler: {handler}.'
        linhas.append(f'// @Description {desc}')
        linhas.append(f'// @Tags {tag}')
        if metodo in ('POST', 'PUT', 'PATCH'):
            linhas.append('// @Accept json')
        linhas.append('// @Produce json')
        for p in re.findall(r'\{(\w+)\}', swag):
            linhas.append(f'// @Param {p} path string true "{p}"')
        if metodo in ('POST', 'PUT', 'PATCH'):
            linhas.append('// @Param body body object false "Corpo da requisição (JSON)"')
        if seguranca == 'auth':
            linhas.append('// @Security BearerAuth')
        linhas.append('// @Success 200 {object} map[string]interface{}')
        if seguranca == 'auth':
            linhas.append('// @Failure 401 {object} map[string]string')
        linhas.append(f'// @Router {swag} [{metodo.lower()}]')
        fn = 'swaggerRota' + re.sub(r'\W', '_', metodo.title() + swag)
        blocos.append('\n'.join(linhas) + f'\nfunc {fn}() {{}}\n')

    cab = ('// Code generated by scripts/gen_swagger_rotas.py; DO NOT EDIT.\n'
           '// Anotações do Swagger das rotas que não têm @Router no próprio handler.\n'
           '// Para melhorar a descrição de uma rota: anote o handler e rode o script de novo.\n\n'
           'package handlers\n\n'
           '//nolint:unused // só existem para o swag ler as anotações\n')
    io.open(SAIDA, 'w', encoding='utf-8', newline='\n').write(cab + '\n' + '\n'.join(blocos))
    print(f'{len(rotas)} rotas lidas, {len(feitas)} já anotadas, {len(blocos)} geradas em {os.path.relpath(SAIDA, BACKEND)}')


if __name__ == '__main__':
    sys.exit(main())
