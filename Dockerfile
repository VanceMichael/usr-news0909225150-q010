FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY contracts ./contracts
COPY fixtures ./fixtures
COPY scaffold ./scaffold
RUN npm run domain:check
CMD ["npm", "run", "domain:check"]
