# Leitores das faturas das usinas (Thopen)

Robô determinístico que lê as faturas de energia das usinas de geração distribuída (UFV/UTE/CGH) e grava um JSON
por fatura no formato de `ESPECIFICACAO_JSON.md`. Não usa modelo de IA: texto do PDF + um leitor por layout de
distribuidora, conferido pela própria fatura (soma dos itens = total, ICMS, leituras).

## Onde ficam os dados

Os PDFs e os JSONs **não** estão no Git (são documentos de clientes). Os scripts apontam para `C:\usinas_thopen`:

- `faturas_originais\` — PDFs recebidos da Thopen
- `dados\manifesto.csv` — id da fatura (sha256[:16]) → caminho
- `dados\json\` — gabaritos da conferência visual
- `dados\json_robo\` — saída do robô
- `dados\sefaz\` — conferência pela SEFAZ

Para rodar em outro lugar, copie essa pasta e ajuste as constantes `B`/`BASE`/`RAIZ` no topo dos scripts.

## Uso

```
cd worker\usinas\extrator
python -I -X utf8 rodar.py "EDP ES" reservadas         # roda o robô nas faturas da distribuidora
python -I -X utf8 rodar.py "ENEL RJ" <id> [<id>...]     # faturas específicas
python -I -X utf8 comparar.py "EQUATORIAL AL"           # acerto campo a campo contra os gabaritos visuais
python -I -X utf8 sefaz_conferir.py <id> [<id>...]      # confere situação da nota e itens na SEFAZ (nunca altera o JSON)
python -I -X utf8 ..\tools\render.py <id> 150           # páginas em PNG para conferência visual
```

`tools\carregar.py` grava no banco (FATURA_USINA*); as credenciais vêm do módulo do pipeline, fora deste diretório.
Gravar no banco só com aprovação e backup.

## Medição (19/11/2026)

Teste independente com 36 faturas de 18 distribuidoras que nunca foram usadas para ajustar os leitores,
conferidas campo a campo contra a imagem (4.785 campos):
- valores extraídos corretos: 99,96% (2 nomes de titular cortados; nenhum número errado);
- cobertura do que está impresso: 99,2% (sem PIS/COFINS por item e demanda contratada);
- bloco de GD (injetada, compensada, saldo, a expirar, participação, rateio por UC): 98,4%, nenhum número errado.

Pendências conhecidas: CPFL Santa Cruz (consumo nas medições e saldo a expirar), nome do titular cortado na EDP ES,
CNPJ que só aparece completo no boleto, alíquota do ICMS da Light (impressa por item), data de pagamento do relatório FIT.

ARMADILHA: patch de regex via heredoc do bash já gravou `\x08` no lugar de `\b`. Confira com `grep -c $'\x08' *.py`.
