FROM node:22.16.0-slim AS builder
ARG BUILD_DATE
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN echo "build ${BUILD_DATE}" && corepack enable pnpm && NODE_LLAMA_CPP_SKIP_DOWNLOAD=1 pnpm install
COPY . .
RUN pnpm run build

FROM node:22.16.0-slim
RUN useradd -m -s /bin/bash qmd
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
USER qmd
EXPOSE 8183
ENTRYPOINT ["node", "bin/qmd"]
