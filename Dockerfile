# Use an official Node.js image
FROM node:18

# Install system dependencies for Chromium (required by puppeteer/whatsapp-web.js)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    libnss3 \
    libatk-bridge2.0-0 \
    libxss1 \
    libasound2 \
    libatk1.0-0 \
    libgtk-3-0 \
    libdrm2 \
    libxcomposite1 \
    libxrandr2 \
    libgbm1 \
    libnss3-dev \
    libxdamage1 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libxinerama1 \
    libcups2 \
    libxext6 \
    --no-install-recommends \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies
RUN npm install

# Copy the rest of your app
COPY . .

# Expose app port
EXPOSE 3000

# Run your app
CMD ["node", "server.js"]
