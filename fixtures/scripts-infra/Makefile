export GOFLAGS = -mod=readonly
export BUILD_TAGS
VERSION := 1.0
.PHONY: all build test lint

all: build test

build: lint
	go build ./cmd/server
	@echo "building $$TARGET_OS"

test:
	./scripts/migrate.sh
	DB_URL=x go test ./...

lint:
	node scripts/postbuild.js

%.o: %.c
	cc $<
