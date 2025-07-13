FROM node:18-alpine

# Install PM2 globally
RUN npm install -g pm2

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application code
COPY . .

COPY ecosystem.config.js .

CMD ["pm2-runtime", "start", "ecosystem.config.js"]