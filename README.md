# Telegram Mini App: Электрологиня

Мини-приложение Telegram для записи к мастеру (mobile-first, iPhone/Android).

## Технологии
- Frontend: Vanilla HTML/CSS/JS
- Backend: Node.js (без внешних зависимостей)
- Хранение: JSON-файл (`data/store.json`)

## Быстрый старт
1. Убедитесь, что установлен Node.js 20+.
2. Запуск:

```bash
node server.mjs
```

3. Откройте:
- `http://localhost:3000/` - клиентская часть
- `http://localhost:3000/?role=master` - мастер/админ интерфейс (локальная разработка)

## Переменные окружения
- `PORT` - порт приложения (по умолчанию `3000`)
- `TELEGRAM_BOT_TOKEN` - токен бота для отправки уведомлений
- `MASTER_TELEGRAM_USERNAME` - username мастера (по умолчанию `idushchaya_a`)
- `MASTER_TELEGRAM_ID` - Telegram ID мастера (предпочтительно для доставки)
- `ADMIN_TELEGRAM_USERNAME` - username администратора (по умолчанию `Tatyana_Yuryeva`)

## Примечания
- Все даты в UI и сообщениях: `дд.мм.гггг`
- Часовой пояс: Москва (`Europe/Moscow`)
- Для гарантированной доставки сообщений боту нужны chat id получателей (бот не может первым писать по username без активного диалога).
