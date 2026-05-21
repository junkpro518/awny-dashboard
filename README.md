# لوحة محادثات عوني

Dashboard داخلي خفيف لعرض سجل محادثات بوت Telegram من جدول Supabase `public.telegram_conversations`.

## التشغيل المحلي

1. انسخ ملف البيئة:

```bash
cp .env.example .env
```

2. حدّث القيم في `.env`:

```bash
SUPABASE_URL=https://qmriegrrplsqlwcrhcsd.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
ADMIN_USERNAME=admin
ADMIN_PASSWORD=...
SESSION_SECRET=...
COOKIE_SECURE=false
```

3. شغّل التطبيق:

```bash
npm run dev
```

ثم افتح `http://localhost:3000`.

## النشر على VPS

المتطلبات:

- Ubuntu 22.04 أو 24.04
- Node.js 20
- Nginx
- PM2

تشغيل PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

مثال Nginx:

```nginx
server {
    server_name dashboard.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

بعد تفعيل HTTPS، اجعل `COOKIE_SECURE=true` في `.env` وأعد تشغيل التطبيق:

```bash
pm2 restart awny-dashboard
```

## الواجهات

- `POST /login`
- `POST /logout`
- `GET /api/session`
- `GET /api/users?q=`
- `GET /api/users/:telegramUserId/conversations`
- `GET /api/export.json?telegramUserId=`
- `GET /api/export.csv?telegramUserId=`

كل واجهات `/api/*` محمية بجلسة تسجيل دخول.
