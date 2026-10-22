FROM node:22-alpine

ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app

# The repository contains both the extension and the API. Build only the API.
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/src ./src

EXPOSE 8080
CMD ["npm", "start"]
