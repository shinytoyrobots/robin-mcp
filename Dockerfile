FROM node:22-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Download google-mcp-server binary
RUN curl -L -o /usr/local/bin/google-mcp-server \
    https://github.com/ngs/google-mcp-server/releases/download/v0.3.0/google-mcp-server-linux-amd64 \
    && chmod +x /usr/local/bin/google-mcp-server

FROM node:22-slim

RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY --from=builder /usr/local/bin/google-mcp-server /usr/local/bin/google-mcp-server
COPY entrypoint.sh ./entrypoint.sh

EXPOSE 3001
CMD ["./entrypoint.sh"]
