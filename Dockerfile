FROM node:24.19.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run check && npm run build && rm -f dist/*.test.js dist/test-fixtures.js

FROM node:24.19.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production WHIM_DATABASE=/data/whim.sqlite WHIM_PORT=8788
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY config.example.json THIRD_PARTY_NOTICES.md ./
USER node
EXPOSE 8788
VOLUME ["/data"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/server.js"]
