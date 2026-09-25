FROM node:22-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY src ./src

ENV BUS_HOST=0.0.0.0 \
    BUS_PORT=47830 \
    BUS_DATA=/data/bus.jsonl

EXPOSE 47830
CMD ["node", "src/server.mjs"]
