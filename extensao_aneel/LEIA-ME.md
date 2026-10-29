# SURE — Consulta ANEEL (extensão do Chrome)

Atualiza no SURE a situação dos protocolos da Ouvidoria da ANEEL lendo o site, na sessão que **você** abre.

## Instalar (uma vez por computador)
1. Copie esta pasta `extensao_aneel` para o computador.
2. No Chrome, abra `chrome://extensions` e ligue o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e escolha a pasta.

## Usar
1. No SURE, em **Protocolos ANEEL**, clique em **Consultar no site da ANEEL**.
2. Abre a janela da Ouvidoria da ANEEL: entre com o login (o Chrome preenche se estiver salvo) e clique em **Entrar**.
   Se aparecer a verificação "não sou robô", resolva.
3. A extensão lê os protocolos ainda não concluídos (e os que estão sem processo no SURE), devolve ao SURE, que grava, e a janela fecha.
   Protocolo sem processo: o SURE pega a UC do campo **Endereço** do detalhe, vincula ao processo dessa UC e manda a tarefa
   para quem fez a última alteração no processo (UC em mais de um processo → fica em "A confirmar").

## O que ela faz e o que não faz
- Não digita senha, não clica em Entrar e não passa pela verificação anti-robô: isso é sempre do usuário.
- Só lê páginas de `www2.aneel.gov.br/faleconosco`, e só na janela que o SURE pediu para abrir.
- Não guarda credencial nenhuma; quem grava no SURE é a própria página do SURE, com o login de quem clicou.
- Se a sessão da ANEEL cair ou a verificação voltar, para e avisa; o que já foi lido é gravado.

## Atualizar
Depois de trocar os arquivos da pasta, em `chrome://extensions` clique no ↻ (recarregar) da extensão.
