# One image shared by migrate/bot/web.
# Dev deps stay in on purpose: drizzle-kit runs the migrations.
FROM node:24-alpine

WORKDIR /app

# Dependency layer first so code changes don't reinstall everything.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Run as the non-root user that ships with the node image.
USER node

CMD ["node", "dist/bot/index.js"]
