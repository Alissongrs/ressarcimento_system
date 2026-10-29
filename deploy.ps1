# Deploy do SURE pela linha de comando (PowerShell do PC, com o gh logado).
#
#   .\deploy.ps1
#
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
