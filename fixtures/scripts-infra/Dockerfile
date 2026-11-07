FROM node:${NODE_VERSION}
ARG NODE_VERSION=22
ARG BUILD_ID
ENV APP_ENV=production PORT=3000
ENV LEGACY_VAR legacy
WORKDIR /app
COPY . .
RUN npm ci && echo "$BUILD_ID" && LOCAL_X=1 && echo $LOCAL_X
EXPOSE ${PORT}
ENTRYPOINT ["./scripts/deploy.sh"]
CMD ["node", "src/index.ts"]
