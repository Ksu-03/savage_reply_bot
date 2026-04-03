import os
from dotenv import load_dotenv

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
if not BOT_TOKEN:
    raise ValueError("Токен не найден! Добавь BOT_TOKEN в .env файл")

# Лимиты
FREE_ANSWERS_PER_DAY = 5
PREMIUM_PRICE = 99  # рублей или Telegram Stars

# Дерзкий, но не грязный — фильтр стоп-слов
FORBIDDEN_WORDS = ['иди в жопу', 'ты тупой', 'лох', 'урод', 'сука', 'хуй', 'пизда']
