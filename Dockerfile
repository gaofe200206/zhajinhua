# 扎金花联机服务器 - Render 免费部署镜像
# 用途：把联机服务器免费托管到 Render（免费层），得到 https/wss 公网域名，
#      朋友网页直接玩；配合微信小程序体验版联机（socket 合法域名填 wss://你的服务名.onrender.com）
# 本地验证：docker build -t zhajinhua . && docker run -p 8080:8080 zhajinhua
FROM node:20-slim
WORKDIR /app
COPY package.json ./
COPY server.js online.html deploy_setup.sh nginx.conf.example ./
RUN npm install --omit=dev --no-audit --no-fund
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
