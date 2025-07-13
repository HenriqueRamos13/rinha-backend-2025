FROM node:18-alpine
RUN npm install -g pm2
WORKDIR /app

COPY node/ .             

RUN npm i

COPY redis/lua ./redis/lua
EXPOSE 8080
CMD ["pm2-runtime", "start", "ecosystem.config.js"]
