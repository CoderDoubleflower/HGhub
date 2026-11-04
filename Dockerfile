FROM node:24-alpine AS base
WORKDIR /app
RUN npm install --global pnpm@10.11.0

FROM base AS build
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY public ./public
RUN pnpm build

FROM base AS production-dependencies
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HGHUB_HOST=0.0.0.0 \
    HGHUB_PORT=3000 \
    HGHUB_DATA_DIR=/app/data
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/app.mjs"]
