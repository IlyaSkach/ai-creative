# Пошаговый деплой AI Creative на сервер

## Что нужно

- VPS с Ubuntu 22.04 (или Debian 12)
- Домен (опционально, можно по IP)
- SSH-доступ к серверу

---

## Шаг 0. Firewall (если включён ufw)

```bash
sudo ufw allow 80
sudo ufw allow 443
sudo ufw allow 22
sudo ufw enable
```

---

## Шаг 1. Подготовка сервера

```bash
# Подключиться по SSH
ssh user@your-server-ip

# Обновить систему
sudo apt update && sudo apt upgrade -y

# Установить Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Проверить
node -v   # v20.x.x
npm -v
```

---

## Шаг 2. Клонирование и сборка

```bash
# Создать папку для приложения
sudo mkdir -p /var/www/ai-creative
sudo chown $USER:$USER /var/www/ai-creative
cd /var/www/ai-creative

# Клонировать репозиторий (или загрузить файлы через scp/rsync)
git clone https://github.com/YOUR_USER/ai-creative.git .
# или: scp -r ./ai-creative/* user@server:/var/www/ai-creative/

# Установить зависимости и собрать
npm install
npm run build
```

---

## Шаг 3. Создание .env

```bash
cd /var/www/ai-creative

# Вариант 1: скопировать с локальной машины
# scp .env user@server:/var/www/ai-creative/

# Вариант 2: создать вручную
nano .env
# Заполнить все ключи (см. ниже)
```

**Обязательные переменные в `.env`:**

```env
# Telegram
TELEGRAM_BOT_TOKEN=ваш_токен_от_BotFather

# AI (хотя бы один для текста)
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_BASE_URL=https://api.deepseek.com

# Bothub (для GPT и Claude, и для картинок)
BOTHUB_API_KEY=ваш_ключ
BOTHUB_GPT_MODEL=gpt-4o
BOTHUB_CLAUDE_MODEL=claude-3.7-sonnet

# Приложение
API_PORT=3002
WEB_ORIGIN=https://ваш-домен.com
API_JSON_LIMIT=120mb
```

**Опционально (анализ постов канала):**

```env
TELEGRAM_API_ID=...
TELEGRAM_API_HASH=...
TELEGRAM_SESSION_STRING=...
```

---

## Шаг 4. Проверка сборки

После `npm run build` API автоматически раздаёт статику из `apps/web/dist`. Один процесс — и фронт, и API.

```bash
ls apps/web/dist    # должны быть index.html, assets/
ls apps/api/dist    # должен быть index.js
```

---

## Шаг 5. Запуск через PM2 (рекомендуется)

```bash
# Установить PM2
sudo npm install -g pm2

# Запустить приложение (из корня проекта)
cd /var/www/ai-creative
pm2 start ecosystem.config.cjs

# Автозапуск при перезагрузке
pm2 startup
pm2 save

# Полезные команды
pm2 status
pm2 logs ai-creative
pm2 restart ai-creative
```

---

## Шаг 6. Nginx как reverse proxy

```bash
# Установить nginx
sudo apt install -y nginx

# Создать конфиг
sudo nano /etc/nginx/sites-available/ai-creative
```

**Содержимое конфига (с SSL через Let's Encrypt):**

```nginx
server {
    listen 80;
    server_name ваш-домен.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ваш-домен.com;

    ssl_certificate /etc/letsencrypt/live/ваш-домен.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ваш-домен.com/privkey.pem;

    ssl_protocols TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
```

**Если без SSL (только для теста):**

```nginx
server {
    listen 80;
    server_name ваш-домен.com;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }
}
```

```bash
# Активировать сайт
sudo ln -s /etc/nginx/sites-available/ai-creative /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## Шаг 7. SSL (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d ваш-домен.com

# Автообновление
sudo certbot renew --dry-run
```

---

## Шаг 8. Обновление приложения

```bash
cd /var/www/ai-creative
git pull
npm install
npm run build
pm2 restart ai-creative
```

---

## Краткий чеклист

| Шаг | Действие |
|-----|----------|
| 1 | Node.js 20, `npm install`, `npm run build` |
| 2 | Создать `.env` с ключами |
| 3 | `WEB_ORIGIN=https://ваш-домен.com` в .env |
| 4 | PM2: `pm2 start ecosystem.config.cjs` |
| 5 | Nginx: proxy на `http://127.0.0.1:3002` |
| 6 | SSL: `certbot --nginx -d домен` |

---

## Без домена (только IP)

В `.env`:
```env
WEB_ORIGIN=http://ВАШ_IP
```

Nginx — `server_name` можно оставить пустым или указать IP. SSL не получится (certbot требует домен).
