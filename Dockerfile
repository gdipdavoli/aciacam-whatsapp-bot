# Base liviana compatible con Chromium
FROM node:18-slim

# Paquetes que Chromium necesita para correr en serverless
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcairo2 \
    libgbm1 \
    libnss3 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    wget \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Instalar deps primero (aprovecha cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el resto del proyecto
COPY . .

# Fuerza a puppeteer/whatsapp-web.js a usar el Chromium del sistema
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 8080
CMD ["node", "server.js"]


