# Deploy do SURE pela linha de comando (PowerShell do PC, com o gh logado).
#
#   .\deploy.ps1
#
# 0) mostra os arquivos alterados/novos, pergunta quais enviar e a mensagem, e faz commit + push
#    (lista = arquivos ja versionados que mudaram + arquivos novos de codigo .go/.jsx/.js/.css/.sh/.sql/.yml;
#     apagados, scripts "_*", OCR local, .py/.exe/.xlsx/.bak novos ficam de fora - esses so com git add manual);
# 1) dispara o workflow "CI/CD Pipeline" no branch dev;
# 2) acompanha os testes e o build (~10 min);
# 3) quando o deploy pede aprovacao, mostra o commit e pergunta aqui se aprova (s/n);
# 4) acompanha o deploy na VPS ate o fim (healthcheck / rollback).
# A aprovacao continua sendo sua: o script so aprova se voce digitar "s".
# (texto sem acento de proposito: o PowerShell 5.1 le .ps1 sem BOM como ANSI)

param([string]$Branch = 'dev')

$ErrorActionPreference = 'Stop'
$Repo = 'Alissongrs/ressarcimento_system'

function Get-DeployJobStatus($runId) {
    # JSON tratado aqui (o PowerShell 5.1 estraga aspas dentro de argumentos de programas externos)
    # falha de rede passageira: devolve "sem resposta" e o laco tenta de novo na proxima rodada
    try { $r = (gh run view $runId -R $Repo --json status,conclusion,jobs 2>$null) -join "`n" | ConvertFrom-Json } catch { $r = $null }
    if (-not $r) { return @('', '', '') }
    $deploy = @($r.jobs | Where-Object { $_.name -like '*Deploy*' } | ForEach-Object { $_.status }) -join ','
    return @($r.status, [string]$r.conclusion, $deploy)
}

# ---- 0) enviar as alteracoes locais (commit + push) ----
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot
$atual = (git rev-parse --abbrev-ref HEAD).Trim()
if ($atual -ne $Branch) { Write-Host "Voce esta no branch '$atual', nao em '$Branch'. Troque de branch antes." -ForegroundColor Red; exit 1 }

# lista com -z: caminhos com espaco/acento vem inteiros; renomeado = "R  novo\0antigo\0"
$partes = ((git -c core.quotepath=false status --porcelain -z -uall) -join '') -split "`0"
$cand = @(); $fora = 0
for ($i = 0; $i -lt $partes.Count; $i++) {
    $p = $partes[$i]
    if ($p.Length -lt 4) { continue }
    $xy = $p.Substring(0, 2); $arq = $p.Substring(3)
    if ($xy[0] -eq 'R') { $i++ }
    $nome = Split-Path $arq -Leaf
    if ($xy -match 'D' -or $nome -like '_*' -or $arq -match '\.(log|tmp)(\.json)?$' -or $arq -like 'Conferencia/*') { $fora++; continue }
    # arquivo novo: so codigo do sistema (Go/React/shell/SQL/config); OCR local, exe, planilhas, .bak etc. ficam de fora
    if ($xy -eq '??' -and ($arq -notmatch '\.(go|jsx?|tsx?|css|sh|sql|ya?ml)$' -or $arq -match '^backend/(ocr_prod|ocr_service|_tmp|cmd/tmp_)')) { $fora++; continue }
    $cand += [pscustomobject]@{ Tipo = $(if ($xy -eq '??') { 'novo' } else { 'alterado' }); Arquivo = $arq }
}

if ($cand.Count -gt 0) {
    Write-Host 'Arquivos alterados/novos:' -ForegroundColor Cyan
    for ($i = 0; $i -lt $cand.Count; $i++) { Write-Host ('  {0,3}) {1,-9} {2}' -f ($i + 1), $cand[$i].Tipo, $cand[$i].Arquivo) }
    if ($fora -gt 0) { Write-Host "  ($fora arquivo(s) fora da lista: apagados, scripts '_*', OCR local, .py/.exe/.xlsx/.bak novos... para enviar um deles: git add <arquivo> antes)" -ForegroundColor DarkGray }
    $esc = Read-Host 'Enviar quais? (s = todos, n = nenhum, ou os numeros: 1,3,5)'
    $sel = @()
    if ($esc -match '^[sS]') { $sel = $cand }
    elseif ($esc -match '\d') {
        foreach ($n in ($esc -split '[,; ]+' | Where-Object { $_ -match '^\d+$' })) {
            $k = [int]$n - 1
            if ($k -ge 0 -and $k -lt $cand.Count) { $sel += $cand[$k] }
        }
    }
    if ($sel.Count -gt 0) {
        $m = ''
        while (-not $m.Trim()) { $m = Read-Host 'Mensagem do commit (o que mudou)' }
        git add -- @($sel | ForEach-Object { $_.Arquivo })
        if ($LASTEXITCODE -ne 0) { Write-Host 'git add falhou.' -ForegroundColor Red; exit 1 }
        git commit -q -m $m
        if ($LASTEXITCODE -ne 0) { Write-Host 'git commit falhou.' -ForegroundColor Red; exit 1 }
        Write-Host "Commit feito com $($sel.Count) arquivo(s)." -ForegroundColor Green
    } else {
        Write-Host 'Nenhum arquivo enviado; segue com o que ja esta no GitHub.'
    }
}

# push do que estiver local e ainda nao foi para o GitHub (inclui commits anteriores)
# (sem 2>$null: no PowerShell 5.1 redirecionar stderr de programa externo vira erro com 'Stop')
git fetch -q origin $Branch
$aFrente = 0
try { $aFrente = [int](git rev-list --count "origin/$Branch..HEAD") } catch {}
if ($aFrente -gt 0) {
    Write-Host "Enviando $aFrente commit(s) para o GitHub..." -ForegroundColor Cyan
    git push -q origin $Branch
    if ($LASTEXITCODE -ne 0) { Write-Host 'git push falhou (talvez o GitHub tenha commits que voce nao tem: rode git pull).' -ForegroundColor Red; exit 1 }
}

# ---- 1) disparar o deploy ----
$ultimo = gh run list -R $Repo --workflow ci.yml --event workflow_dispatch -L 1 --json databaseId --jq '.[0].databaseId'

Write-Host "Disparando o deploy do branch $Branch..." -ForegroundColor Cyan
gh workflow run ci.yml --ref $Branch -R $Repo | Out-Null

# espera a execucao nova aparecer (diferente da ultima que ja existia)
$runId = $null
for ($i = 0; $i -lt 30 -and -not $runId; $i++) {
    Start-Sleep -Seconds 4
    $id = gh run list -R $Repo --workflow ci.yml --event workflow_dispatch -L 1 --json databaseId --jq '.[0].databaseId'
    if ($id -and $id -ne $ultimo) { $runId = $id }
}
if (-not $runId) { Write-Host 'Nao achei a execucao nova no GitHub.' -ForegroundColor Red; exit 1 }

$info = (gh run view $runId -R $Repo --json headSha,url) -join "`n" | ConvertFrom-Json
$sha = $info.headSha.Substring(0, 7)
$url = $info.url
$msg = git log -1 --format=%s $sha 2>$null
Write-Host "Execucao $runId  (commit $sha $msg)"
Write-Host $url
Write-Host 'Rodando testes e build (~10 min)...' -ForegroundColor Cyan

# espera o deploy pedir aprovacao (ou a execucao terminar com erro)
while ($true) {
    Start-Sleep -Seconds 20
    $st = Get-DeployJobStatus $runId
    if ($st[0] -eq 'completed') {
        Write-Host "A execucao terminou antes do deploy: $($st[1]). Veja: $url" -ForegroundColor Red
        exit 1
    }
    if ($st[2] -eq 'waiting') { break }
}

Write-Host ''
Write-Host 'Testes OK. O deploy esta esperando a sua aprovacao.' -ForegroundColor Yellow
Write-Host "Commit: $sha  $msg"
$r = Read-Host 'Aprovar o deploy em producao? (s/n)'
if ($r -notmatch '^[sS]') {
    gh run cancel $runId -R $Repo | Out-Null
    Write-Host 'Deploy cancelado. Nada foi alterado na VPS.'
    exit 0
}

$envId = gh api "repos/$Repo/environments/production" --jq .id
gh api -X POST "repos/$Repo/actions/runs/$runId/pending_deployments" -F "environment_ids[]=$envId" -f state=approved -f comment='aprovado pelo deploy.ps1' | Out-Null
Write-Host 'Aprovado. Fazendo o deploy na VPS (build + subir containers, ~5 min)...' -ForegroundColor Cyan

while ($true) {
    Start-Sleep -Seconds 15
    $st = Get-DeployJobStatus $runId
    if ($st[0] -eq 'completed') { break }
}
if ($st[1] -eq 'success') {
    Write-Host "Deploy concluido e saudavel (commit $sha)." -ForegroundColor Green
} else {
    Write-Host "Deploy falhou ($($st[1])). Se o healthcheck falhou, a VPS voltou sozinha para a versao anterior." -ForegroundColor Red
    gh run view $runId -R $Repo --log-failed | Select-String -Pattern 'error|HEALTHCHECK|rollback|restaurado' | Select-Object -Last 15
    Write-Host $url
    exit 1
}
