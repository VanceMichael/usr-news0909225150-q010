FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY contracts ./contracts
COPY fixtures ./fixtures
COPY scaffold ./scaffold
COPY src ./src
COPY test ./test
COPY scripts ./scripts

RUN npm run domain:check && npm run build

EXPOSE 8080
CMD ["node", "dist/src/server.js"]
