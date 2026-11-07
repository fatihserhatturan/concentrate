#!/bin/sh
cd cmd/server && go build . && cd ../..
node src/index.ts
