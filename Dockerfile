FROM node:20-slim

ENV PNPM_HOME=/pnpm
ENV PATH="${PNPM_HOME}:/usr/local/bin:${PATH}"
ENV HIVE_SERVER_MODE=browser
ENV HIVE_SERVER_HOST=0.0.0.0
ENV HIVE_SERVER_PORT=3773
ENV HIVE_SERVER_BASE_DIR=/data
ENV ELECTRON_RUN_AS_NODE=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    openssh-client \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable \
  && corepack prepare pnpm@10.24.0 --activate \
  && npm install -g @anthropic-ai/claude-code

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
RUN pnpm rebuild better-sqlite3 node-pty

COPY . .
RUN pnpm run build:server && pnpm run build:web
RUN chmod +x /app/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 3773

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "out/main/server.js"]
