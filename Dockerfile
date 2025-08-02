FROM node:18

# Установка libvips для sharp
RUN apt-get update && apt-get install -y \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
EXPOSE 10000
CMD ["node", "server.js"]
