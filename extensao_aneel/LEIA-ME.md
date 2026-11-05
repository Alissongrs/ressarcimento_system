# SURE — ANEEL e Faturas Claro (extensão do Chrome)

Uma extensão só, com duas funções:
- **Protocolos ANEEL** — atualiza no SURE a situação dos protocolos da Ouvidoria da ANEEL lendo o site, na sessão que **você** abre.
- **Faturas Claro** — pega no portal PDP da Claro os lotes (zips) de faturas novos e manda para o servidor do SURE processar.

## Instalar (uma vez por computador)
1. Baixe o zip no SURE (botão **Baixar a extensão do SURE**, nas telas Tarefas do sistema e Protocolos ANEEL) e descompacte.
2. No Chrome, abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta `extensao_sure`.

## Atualizar
Baixe o zip de novo, descompacte **por cima** da mesma pasta e, em `chrome://extensions`, clique no ↻ da extensão.

## Protocolos ANEEL
1. No SURE, em **Protocolos ANEEL**, clique em **Consultar no site da ANEEL**.
2. Abre a janela da Ouvidoria: se a sessão caiu, entre com o login e clique em **Entrar** (a verificação "não sou robô" é sempre sua).
3. A extensão lê os protocolos ainda não concluídos, devolve ao SURE, que grava, e a janela fecha.

## Faturas Claro
1. Uma vez: em `chrome://extensions` → **Detalhes** da extensão → **Opções da extensão**, guarde o usuário e a senha do portal PDP
   (ficam só neste computador). Sem isso, a janela do portal espera você entrar.
2. No SURE, em **Tarefas do sistema**, clique em **Atualizar faturas Claro** (precisa ser administrador). A extensão abre o
   portal, entra (o código de segurança é lido pelo SURE no e-mail que o portal manda) e manda ao servidor o link de cada
   lote novo. O **servidor** baixa o zip, extrai as faturas para o banco, sobe os PDFs para o Google Drive e grava os links
   (worker/job_claro.sh). Não precisa deixar nada ligado no computador — desde a versão 1.3 o `iniciar.ps1` não é mais usado.
   Se o portal recusar o download vindo do servidor, a extensão baixa o zip neste navegador e envia ao servidor em partes.

## O que ela faz e o que não faz
- Só age nas janelas que o SURE pediu para abrir; quem grava no SURE é a página do SURE, com o login de quem clicou.
- ANEEL: não digita senha nem passa pela verificação anti-robô.
- Claro: usa o login do portal guardado nas opções deste computador e o código que chega por e-mail. Para falar com a fila
  da Claro no SURE usa o login da página do SURE que pediu, só durante a atualização (apagado no fim).
