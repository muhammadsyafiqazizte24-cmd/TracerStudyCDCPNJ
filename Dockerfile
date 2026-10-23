FROM node:20-bookworm-slim
# git diperlukan karena salah satu dependensi Baileys diambil dari GitHub
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/index.js"]
