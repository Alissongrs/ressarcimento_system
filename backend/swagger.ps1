$ErrorActionPreference = 'Stop'

Write-Host "Installing swag (swagger generator)..." -ForegroundColor Cyan
go install github.com/swaggo/swag/cmd/swag@latest

Write-Host "Generating Swagger docs..." -ForegroundColor Cyan
swag init -g routes/routes.go -o docs --parseDependency --parseInternal

Write-Host "Done." -ForegroundColor Green
