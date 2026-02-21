SHELL := /bin/sh

.PHONY: swagger swagger-install

swagger-install:
	@echo "Installing swag (swagger generator)..."
	@go install github.com/swaggo/swag/cmd/swag@latest

swagger:
	@echo "Generating Swagger docs..."
	@swag init -g routes/routes.go -o docs
