BINARY_NAME := muti-metroo-manager
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")

.PHONY: build build-frontend build-go dev clean hooks

build: build-frontend build-go

# Enable the repo's git hooks (Prettier-formats staged JS/TS on commit).
hooks:
	git config core.hooksPath .githooks
	@echo "Git hooks enabled (core.hooksPath=.githooks)."

build-frontend:
	cd frontend && npm ci && npm run build

build-go:
	@mkdir -p build
	go build -ldflags "-s -w -X main.Version=$(VERSION)" -o build/$(BINARY_NAME) ./cmd/manager

dev:
	@echo "Start Go backend:  go run ./cmd/manager -addr :3000 -agent http://127.0.0.1:8080"
	@echo "Start Vite dev:    cd frontend && npm run dev"

clean:
	rm -rf build/ internal/webui/dist/ frontend/node_modules/
