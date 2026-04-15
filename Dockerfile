FROM node:20-alpine

# Cài công cụ build cho better-sqlite3
RUN apk add --no-cache python3 make g++ tzdata
ENV TZ=Asia/Ho_Chi_Minh

WORKDIR /app

# Copy package files và cài dependencies
COPY package*.json ./
RUN npm install --production=false

# Copy source và build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Tạo thư mục data (sẽ mount volume)
RUN mkdir -p /app/data/media /app/data/uploads

EXPOSE 3000

CMD ["node", "dist/index.js"]
