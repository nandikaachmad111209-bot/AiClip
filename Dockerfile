FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp terbaru + plugin PO token provider (client HTTP) lewat pip
RUN pip3 install --no-cache-dir --break-system-packages -U yt-dlp bgutil-ytdlp-pot-provider

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
