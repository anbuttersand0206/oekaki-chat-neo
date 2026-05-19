FROM node:20-alpine
WORKDIR /app
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/src ./src
EXPOSE 3001
CMD ["node", "src/server.js"]
