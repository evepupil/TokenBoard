FROM node:24-bookworm-slim

ENV PNPM_HOME=/pnpm
ENV COREPACK_HOME=/pnpm/corepack
ENV PATH=/pnpm:$PATH
ENV NODE_ENV=production
ENV PORT=7860

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends sqlite3 \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.21.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/usage-core/package.json packages/usage-core/package.json

RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm --filter @tokenboard/web build
RUN mkdir -p /data/wrangler && chown -R node:node /app /data /pnpm

EXPOSE 7860

USER node

CMD ["./deploy/huggingface-space/entrypoint.sh"]
