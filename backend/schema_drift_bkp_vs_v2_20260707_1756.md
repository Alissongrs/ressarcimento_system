# Schema drift — backup pré-V2 (27/06/2026 15:15) × PROD V2

## FT_PROCESSOS

- BKP: 32 colunas · V2: 35 colunas

| Backup | Situação | V2 |
|---|---|---|
| `uc` | IGUAL | `uc` |
| `id_processo` | IGUAL | `id_processo` |
| `cliente` | IGUAL | `cliente` |
| `concessionaria` | IGUAL | `concessionaria` |
| `id_coluna` | RENOMEADA/DERIVADA | (sem equivalente V2 — kanban removido) |
| `nome_coluna` | RENOMEADA/DERIVADA | (sem equivalente V2) |
| `id_etapa_processo` | RENOMEADA/DERIVADA | id_etapa_atual |
| `etapa` | RENOMEADA/DERIVADA | (nome vem de DM_ETAPAS via JOIN) |
| `sub_etapa` | RENOMEADA/DERIVADA | (fragmentado em id_status_atual) |
| `id_responsavel` | IGUAL | `id_responsavel` |
| `id_sub_etapa_processo` | RENOMEADA/DERIVADA | id_status_atual |
| `relevancia` | IGUAL | `relevancia` |
| `data_alerta` | IGUAL | `data_alerta` |
| `ultima_atualizacao` | IGUAL | `ultima_atualizacao` |
| `data_movimentacao` | IGUAL | `data_movimentacao` |
| `ressarcimento_estimado` | IGUAL | `ressarcimento_estimado` |
| `data_procedencia` | IGUAL | `data_procedencia` |
| `credito_simples` | IGUAL | `credito_simples` |
| `credito_dobro` | IGUAL | `credito_dobro` |
| `data_credito_dobro` | IGUAL | `data_credito_dobro` |
| `repasse_simples` | IGUAL | `repasse_simples` |
| `repasse_dobro` | IGUAL | `repasse_dobro` |
| `suspenso` | IGUAL | `suspenso` |
| `periodos_irregularidade` | IGUAL | `periodos_irregularidade` |
| `descricao_irregularidade` | IGUAL | `descricao_irregularidade` |
| `id_tipo_irregularidade` | IGUAL | `id_tipo_irregularidade` |
| `nome_tipo_irregularidade` | IGUAL | `nome_tipo_irregularidade` |
| `id_subtipo_irregularidade` | IGUAL | `id_subtipo_irregularidade` |
| `nome_subtipo_irregularidade` | IGUAL | `nome_subtipo_irregularidade` |
| `data_criacao` | IGUAL | `data_criacao` |
| `score_percentual` | IGUAL | `score_percentual` |
| `instancia_deferimento` | RENOMEADA/DERIVADA | id_instancia (FT_DEFERIMENTOS) / id_instancia_atual (FT_PROCESSOS) |
| — | ✨ NOVA | `codigo_publico` |
| — | ✨ NOVA | `id_instancia_atual` |
| — | ✨ NOVA | `id_etapa_atual` |
| — | ✨ NOVA | `id_status_atual` |
| — | ✨ NOVA | `id_aprovacao_atual` |
| — | ✨ NOVA | `data_proxima_acao` |
| — | ✨ NOVA | `triagem_concluida` |
| — | ✨ NOVA | `cod_empresa` |
| — | ✨ NOVA | `percentual_repasse` |
| — | ✨ NOVA | `uc_atual` |

## FT_REQUISICOES

- BKP: 22 colunas · V2: 26 colunas

| Backup | Situação | V2 |
|---|---|---|
| `id_requisicao` | IGUAL | `id_requisicao` |
| `id_usuario` | IGUAL | `id_usuario` |
| `id_prioridade` | IGUAL | `id_prioridade` |
| `id_status` | IGUAL | `id_status` |
| `uc` | IGUAL | `uc` |
| `cliente` | IGUAL | `cliente` |
| `razao_social_fatura` | IGUAL | `razao_social_fatura` |
| `concessionaria` | IGUAL | `concessionaria` |
| `cnpj` | IGUAL | `cnpj` |
| `endereco_completo` | IGUAL | `endereco_completo` |
| `numero_protocolo` | IGUAL | `numero_protocolo` |
| `ressarcimento_estimado` | IGUAL | `ressarcimento_estimado` |
| `periodos_irregularidade` | IGUAL | `periodos_irregularidade` |
| `descricao_irregularidade` | IGUAL | `descricao_irregularidade` |
| `link_fatura` | IGUAL | `link_fatura` |
| `processo_criado` | IGUAL | `processo_criado` |
| `data_criacao` | IGUAL | `data_criacao` |
| `data_mudanca_status` | IGUAL | `data_mudanca_status` |
| `justificativa_atraso_triagem` | IGUAL | `justificativa_atraso_triagem` |
| `id_tipo_irregularidade` | IGUAL | `id_tipo_irregularidade` |
| `id_subtipo_irregularidade` | IGUAL | `id_subtipo_irregularidade` |
| `triagem` | IGUAL | `triagem` |
| — | ✨ NOVA | `id_etapa_atual_v2` |
| — | ✨ NOVA | `id_instancia_atual` |
| — | ✨ NOVA | `id_status_atual_v2` |
| — | ✨ NOVA | `id_aprovacao_atual` |

## FT_DEFERIMENTOS

- BKP: 12 colunas · V2: 15 colunas

| Backup | Situação | V2 |
|---|---|---|
| `id_deferimento` | IGUAL | `id_deferimento` |
| `id_processo` | IGUAL | `id_processo` |
| `status_analise` | IGUAL | `status_analise` |
| `instancia_deferimento` | IGUAL | `instancia_deferimento` |
| `data_procedencia` | IGUAL | `data_procedencia` |
| `credito_simples` | IGUAL | `credito_simples` |
| `credito_dobro` | IGUAL | `credito_dobro` |
| `data_credito_dobro` | IGUAL | `data_credito_dobro` |
| `tipo_irregularidade` | IGUAL | `tipo_irregularidade` |
| `subtipo_irregularidade` | IGUAL | `subtipo_irregularidade` |
| `repasse_simples` | IGUAL | `repasse_simples` |
| `repasse_dobro` | IGUAL | `repasse_dobro` |
| — | ✨ NOVA | `id_aprovacao` |
| — | ✨ NOVA | `id_instancia` |
| — | ✨ NOVA | `observacao` |

## FT_FATURAMENTO

- BKP: 9 colunas · V2: 13 colunas

| Backup | Situação | V2 |
|---|---|---|
| `id_faturamento` | IGUAL | `id_faturamento` |
| `id_processo` | IGUAL | `id_processo` |
| `numero_nf` | IGUAL | `numero_nf` |
| `data_emissao` | IGUAL | `data_emissao` |
| `data_vencimento` | IGUAL | `data_vencimento` |
| `data_pagamento` | IGUAL | `data_pagamento` |
| `valor` | IGUAL | `valor` |
| `created_at` | IGUAL | `created_at` |
| `updated_at` | IGUAL | `updated_at` |
| — | ✨ NOVA | `serie_nf` |
| — | ✨ NOVA | `data_envio_financeiro` |
| — | ✨ NOVA | `status_nf` |
| — | ✨ NOVA | `observacoes` |

## FT_FLUXO_RESSARCIMENTO

- BKP: 11 colunas · V2: 16 colunas

| Backup | Situação | V2 |
|---|---|---|
| `id_fluxo` | IGUAL | `id_fluxo` |
| `id_processo` | IGUAL | `id_processo` |
| `forma_devolucao` | IGUAL | `forma_devolucao` |
| `valor` | IGUAL | `valor` |
| `data_devolucao` | IGUAL | `data_devolucao` |
| `data_envio_financeiro` | IGUAL | `data_envio_financeiro` |
| `created_at` | IGUAL | `created_at` |
| `updated_at` | IGUAL | `updated_at` |
| `simples` | IGUAL | `simples` |
| `dobro` | IGUAL | `dobro` |
| `simples_dobro` | IGUAL | `simples_dobro` |
| — | ✨ NOVA | `id_forma_devolucao` |
| — | ✨ NOVA | `banco_destino` |
| — | ✨ NOVA | `agencia` |
| — | ✨ NOVA | `conta` |
| — | ✨ NOVA | `observacoes` |

## FT_HISTORICO_MOVIMENTACOES

- BKP: 17 colunas · V2: 16 colunas

| Backup | Situação | V2 |
|---|---|---|
| `id_historico` | IGUAL | `id_historico` |
| `id_requisicao` | ❌ SUMIU | — |
| `id_usuario_gestor` | IGUAL | `id_usuario_gestor` |
| `status_anterior` | ❌ SUMIU | — |
| `status_novo` | ❌ SUMIU | — |
| `etapa_anterior` | ❌ SUMIU | — |
| `etapa_nova` | ❌ SUMIU | — |
| `sub_etapa` | RENOMEADA/DERIVADA | (fragmentado em id_status_atual) |
| `relevancia_anterior` | ❌ SUMIU | — |
| `relevancia_nova` | ❌ SUMIU | — |
| `comentario` | IGUAL | `comentario` |
| `justificativa_atraso` | IGUAL | `justificativa_atraso` |
| `tipo_movimentacao` | IGUAL | `tipo_movimentacao` |
| `data_movimentacao` | IGUAL | `data_movimentacao` |
| `tipo_irregularidade` | ❌ SUMIU | — |
| `subtipo_irregularidade` | ❌ SUMIU | — |
| `mail_graph_message_id` | IGUAL | `mail_graph_message_id` |
| — | ✨ NOVA | `id_processo` |
| — | ✨ NOVA | `id_etapa_anterior` |
| — | ✨ NOVA | `id_etapa_nova` |
| — | ✨ NOVA | `id_instancia_anterior` |
| — | ✨ NOVA | `id_instancia_nova` |
| — | ✨ NOVA | `id_status_anterior` |
| — | ✨ NOVA | `id_status_novo` |
| — | ✨ NOVA | `id_aprovacao_anterior` |
| — | ✨ NOVA | `id_aprovacao_nova` |

## FT_ANEXOS

- BKP: 9 colunas · V2: 9 colunas

| Backup | Situação | V2 |
|---|---|---|
| `id_anexo` | IGUAL | `id_anexo` |
| `id_requisicao` | ❌ SUMIU | — |
| `nome_arquivo` | IGUAL | `nome_arquivo` |
| `caminho_arquivo` | IGUAL | `caminho_arquivo` |
| `enviado_por` | IGUAL | `enviado_por` |
| `data_upload` | IGUAL | `data_upload` |
| `mime_type` | IGUAL | `mime_type` |
| `tamanho_bytes` | IGUAL | `tamanho_bytes` |
| `arquivo_blob` | IGUAL | `arquivo_blob` |
| — | ✨ NOVA | `id_processo` |

## DM_USUARIO

- BKP: 8 colunas · V2: 9 colunas

| Backup | Situação | V2 |
|---|---|---|
| `id_usuario` | IGUAL | `id_usuario` |
| `id_departamento` | IGUAL | `id_departamento` |
| `nome_usuario` | IGUAL | `nome_usuario` |
| `email` | IGUAL | `email` |
| `senha_hash` | IGUAL | `senha_hash` |
| `perfil` | IGUAL | `perfil` |
| `usuario_ativo` | IGUAL | `usuario_ativo` |
| `data_criacao` | IGUAL | `data_criacao` |
| — | ✨ NOVA | `id_usuario_origem` |

## FT_REQUISICOES_FATURAS

- BKP: 7 colunas · V2: 7 colunas

| Backup | Situação | V2 |
|---|---|---|
| `id` | IGUAL | `id` |
| `id_requisicao` | ❌ SUMIU | — |
| `link` | IGUAL | `link` |
| `mes_ref` | IGUAL | `mes_ref` |
| `dt_vencimento` | IGUAL | `dt_vencimento` |
| `valor_total` | IGUAL | `valor_total` |
| `created_at` | IGUAL | `created_at` |
| — | ✨ NOVA | `id_processo` |

## Tabelas NOVAS no V2 (não existiam no backup)

- `DM_EMPRESA_PERCENTUAL`
- `DM_ETAPAS`
- `DM_FORMAS_DEVOLUCAO`
- `DM_INSTANCIAS`
- `DM_STATUS_APROVACAO`
- `DM_STATUS_PROCESSO`
- `DM_STATUS_REQUISICAO`
- `FT_AUDIT_EDICAO`
- `FT_ENCERRAMENTO`
- `FT_FATURAMENTO_ITEM`
- `MAIL_MESSAGE_READS`
- `_LOG_MIGRACAO_V2`
- `schema_migrations`
