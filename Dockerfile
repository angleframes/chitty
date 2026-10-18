# ANGLE FRAMES CHITTY — Node 24 (built-in node:sqlite) + ffmpeg for MP4 recordings
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server.js recordings.js ./
COPY public ./public
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
# Mount a persistent volume at /data (database + recordings live here)
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
