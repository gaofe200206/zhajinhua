#!/bin/bash
# 扎金花联机服务器 - 云服务器一键部署脚本（Ubuntu/Debian/CentOS 均可）
# 用法：把本脚本和 server.js、online.html 放在同一目录，执行：
#   chmod +x deploy_setup.sh && sudo ./deploy_setup.sh
# 装完默认跑在 8080 端口，浏览器访问 http://服务器IP:8080 即可玩。
set -e

echo "== 1/4 安装 Node.js（若已安装会自动跳过） =="
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs 2>/dev/null || yum install -y nodejs 2>/dev/null
fi
node -v

echo "== 2/4 安装依赖 (ws) =="
cd "$(dirname "$0")"
npm install ws --no-audit --no-fund

echo "== 3/4 安装 pm2（守护进程，服务器重启自动拉起） =="
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo "== 4/4 启动服务 =="
pm2 start server.js --name zhajinhua
pm2 save
pm2 startup   # 按提示执行它输出的那条命令，实现开机自启

echo ""
echo "部署完成！"
echo "  本机测试:    curl http://localhost:8080/api/room -X POST -d '{\"name\":\"t\",\"max\":4}'"
echo "  浏览器访问:  http://$(hostname -I | awk '{print $1}'):8080"
echo "  想用域名:    把域名 A 记录解析到本机 IP，然后配置 nginx 反代（见 nginx.conf.example）"
echo "  改端口:      环境变量 PORT=8081 node server.js 或 pm2 restart zhajinhua --update-env"
