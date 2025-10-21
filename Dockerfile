# Dockerfile
FROM node:20-slim

# Instalar Chromium (necesario para Puppeteer/whatsapp-web.js)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-common \
    chromium-sandbox \
    ca-certificates \
    fonts-liberation \
    libnss3 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libgbm1 \
    wget \
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
