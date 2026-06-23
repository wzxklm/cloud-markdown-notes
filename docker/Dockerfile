FROM node:24-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global user.email "notes@example.local" \
  && git config --global user.name "Notes App"

WORKDIR /app

FROM base AS development

COPY package*.json ./
RUN npm install
RUN npx playwright install --with-deps chromium

COPY . .
COPY docker/entrypoint.sh /usr/local/bin/notes-entrypoint
COPY docker/notes.sh /usr/local/bin/notes
RUN chmod +x /usr/local/bin/notes-entrypoint /usr/local/bin/notes

ENV PATH="/app/node_modules/.bin:${PATH}"

ENTRYPOINT ["notes-entrypoint"]
CMD ["npm", "run", "dev"]

FROM development AS build

RUN npm run build

FROM base AS production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-node ./dist-node
COPY src/server/migrations ./src/server/migrations
COPY docker/entrypoint.sh /usr/local/bin/notes-entrypoint
COPY docker/notes.sh /usr/local/bin/notes
RUN chmod +x /usr/local/bin/notes-entrypoint /usr/local/bin/notes

ENV NODE_ENV=production

ENTRYPOINT ["notes-entrypoint"]
CMD ["sh", "-c", "node dist-node/scripts/migrate.js && node dist-node/scripts/start-prod.js"]
