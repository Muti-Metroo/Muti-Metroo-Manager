BINARY_NAME := muti-metroo-manager
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")

.PHONY: build build-frontend build-go dev clean hooks e2e-fileshare e2e-fileshare-docker

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

# End-to-end test of WebDAV file shares against real agent and manager
# binaries (needs ../Muti-Metroo and a built frontend). The docker variant
# adds the litmus compliance suite and a davfs2 mount.
e2e-fileshare: build
	scripts/e2e-fileshare.sh

e2e-fileshare-docker: build
	scripts/e2e-fileshare-docker.sh

dev:
	@echo "Start Go backend:  go run ./cmd/manager -addr :3000 -agent http://127.0.0.1:8080"
	@echo "Start Vite # End-to-end test of WebDAV file shares against real agent and manager
# binaries (needs ../Muti-Metroo and a built frontend). The docker variant
# adds the litmus compliance suite and a davfs2 mount.
e2e-fileshare: build
	scripts/e2e-fileshare.sh

e2e-fileshare-docker: build
	scripts/e2e-fileshare-docker.sh

dev:    cd frontend && npm run dev"

clean:
	rm -rf build/ internal/webui/dist/ frontend/node_modules/
