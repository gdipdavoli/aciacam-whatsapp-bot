# Dockerfile
FROM node:20-slim

# Instalar dependencias del sistema que requiere Chromium/Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 \
    libc6 libnspr4 libnss3 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 \
    libxext6 libxfixes3 libxrandr2 libgbm1 libgtk-3-0 libpango-1.0-0 libcairo2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Importante: ejecutar server.js (que a su vez requiere ./whatsapp)
CMD ["node", "server.js"]
