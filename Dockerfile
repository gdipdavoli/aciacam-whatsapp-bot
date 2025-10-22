# Imagen con Chromium + dependencias preinstaladas
FROM ghcr.io/puppeteer/puppeteer:22.7.1

WORKDIR /usr/src/app

# Instalar deps primero (cache)
COPY package*.json ./
RUN npm ci --omit=dev

# Copiar el proyecto
COPY . .

# Evita que Puppeteer intente descargar otro Chrome
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
# Ruta del Chrome dentro de esta imagen
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
ENV NODE_ENV=production

EXPOSE 8080
CMD ["node", "server.js"]

