# Concentrate UI in a container: scan a mounted workspace and browse the graph.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
COPY vendor ./vendor
RUN npm run build
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui/server ./server
COPY ui/shared ./shared
COPY ui/web ./web
COPY ui/tsconfig.json ./
RUN npx vite build web

FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173 NO_OPEN=1 HOME=/workspace
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/vendor ./vendor
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --omit=dev && npm install -g tsx@4
COPY ui/server ./server
COPY ui/shared ./shared
COPY --from=build /app/ui/web/dist ./web/dist
USER node
EXPOSE 4173
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["tsx", "server/index.ts"]
