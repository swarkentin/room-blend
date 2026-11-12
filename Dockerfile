FROM node:22-alpine
WORKDIR /app
# The only runtime dependency is `pg` (used when DATABASE_URL is set). `npm ci` needs package-lock.json to match package.json.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TRUST_PROXY=1
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
