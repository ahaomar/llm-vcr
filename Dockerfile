FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY studio ./studio
RUN mkdir -p /app/cassettes
ENV VCR_CASSETTES=/app/cassettes \
    VCR_PORT=9090 \
    NODE_ENV=production
EXPOSE 9090
HEALTHCHECK --interval=5s --timeout=3s --retries=12 \
  CMD wget -qO- http://127.0.0.1:9090/__vcr/health || exit 1
ENTRYPOINT ["node", "bin/vcr.js"]
