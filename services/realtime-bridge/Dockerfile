FROM node:22-alpine

WORKDIR /app

COPY services/realtime-bridge/package.json services/realtime-bridge/package-lock.json* ./
RUN npm install

COPY services/realtime-bridge/tsconfig.json ./
COPY services/realtime-bridge/src ./src
COPY lib ./lib

RUN npm run build

ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
