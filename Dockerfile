FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data TRUST_PROXY=1
VOLUME /data
EXPOSE 8080
USER node
CMD ["node", "server.js"]
