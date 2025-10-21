# Imagen base ligera compatible con Puppeteer
FROM node:18-slim

# Instalar dependencias mínimas que necesita Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcairo2 \
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
    libgbm1 \
    wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

# Copiar package.json primero para aprovechar cache
COPY package*.json ./

# Descargar Puppeteer con Chromium incluido
RUN npm install puppeteer@22.15.0 --save \
    && npm install --production

# Copiar el resto del proyecto
COPY . .

# Variables para Puppeteer dentro de Cloud Run
ENV PUPPETEER_SKIP_DOWNLOAD=false
ENV PUPPETEER_EXECUTABLE_PATH=/usr/src/app/node_modules/puppeteer/.local-chromium/linux-127.0.6533.88/chrome-linux64/chrome

# Exponer puerto
EXPOSE 8080

CMD ["node", "server.js"]

