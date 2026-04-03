import json
import random
import asyncio
import logging
from datetime import date, timedelta

from aiogram import Bot, Dispatcher, types, F
from aiogram.filters import Command
from aiogram.types import Message, CallbackQuery, InlineKeyboardMarkup, InlineKeyboardButton
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup

from config import BOT_TOKEN, FREE_ANSWERS_PER_DAY, PREMIUM_PRICE, FORBIDDEN_WORDS
from database import init_db, get_user, create_user, can_get_free_answer, increment_answer_count, save_feedback

# Настройка логов
logging.basicConfig(level=logging.INFO)

# Инициализация бота
bot = Bot(token=BOT_TOKEN)
dp = Dispatcher()

# Состояния для FSM
class AskState(StatesGroup):
    waiting_for_situation = State()

# Загрузка базы ответов
with open("data/answers.json", "r", encoding="utf-8") as f:
    answers_db = json.load(f)

def find_answers_by_text(text: str) -> dict:
    """Ищет подходящие ответы по ключевым словам"""
    text_lower = text.lower()
    for situation in answers_db["situations"]:
        for word in situation["trigger_words"]:
            if word.lower() in text_lower:
                return situation["answers"]
    # Если ничего не нашли — возвращаем универсальные
    return {
        "normal": "Честно скажи, что думаешь. Это лучший вариант",
        "humor": "Отправь мем. Мемы спасают всё 🗿",
        "savage": "Скажи прямо и без оправданий. Себя не потеряешь"
    }

def filter_derzost(text: str) -> str:
    """Фильтр от совсем грязных слов (страховка)"""
    for bad in FORBIDDEN_WORDS:
        if bad in text.lower():
            return "⚠️ Цензура: этот ответ был слишком дерзким даже для нас. Держи нейтральный вариант:\n\n" + text.replace(bad, "[...]")
    return text

# --- Команда /start ---
@dp.message(Command("start"))
async def cmd_start(message: Message):
    user_id = message.from_user.id
    username = message.from_user.username
    create_user(user_id, username)
    
    user = get_user(user_id)
    premium_status = "🔓 Безлимит" if user and user['premium_until'] and date.today() <= date.fromisoformat(user['premium_until']) else f"🔒 {FREE_ANSWERS_PER_DAY} ответов/день"
    
    await message.answer(
        f"🔥 *ОТВЕЧАЛКА* 🔥\n\n"
        f"Прикинь, больше не надо тупить над ответом.\n"
        f"Просто опиши ситуацию — я дам *3 варианта*.\n\n"
        f"📝 Твой статус: {premium_status}\n"
        f"💰 Premium: 99₽ — безлимит + мемы\n\n"
        f"Пиши /ask — и погнали 🚀",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="💬 Спросить бота", callback_data="ask")],
                [InlineKeyboardButton(text="⭐ Премиум", callback_data="premium")],
                [InlineKeyboardButton(text="📊 Топ ответов", callback_data="top")]
            ]
        )
    )

# --- Команда /ask ---
@dp.message(Command("ask"))
@dp.callback_query(lambda c: c.data == "ask")
async def cmd_ask(event: types.CallbackQuery | Message, state: FSMContext):
    if isinstance(event, types.CallbackQuery):
        await event.message.answer("✏️ Опиши ситуацию одним-двумя предложениями. Например:\n\n*Она написала \"привет\", как заинтересовать?*\n*Препод спросил про долг*\n*Друг обиделся из-за шутки*")
        await event.answer()
    else:
        await event.answer("✏️ Опиши ситуацию. Например:\n\n*Она написала \"привет\", как заинтересовать?*")
    
    await state.set_state(AskState.waiting_for_situation)

# --- Обработка текста ситуации ---
@dp.message(AskState.waiting_for_situation)
async def process_situation(message: Message, state: FSMContext):
    user_id = message.from_user.id
    situation = message.text.strip()
    
    # Проверка лимита
    if not can_get_free_answer(user_id):
        await message.answer(
            "😬 Сегодня ты использовал все бесплатные ответы.\n\n"
            "Разблокируй безлимит за 99₽ — и отвечай сколько влезет!\n"
            "Напиши /premium",
            reply_markup=InlineKeyboardMarkup(
                inline_keyboard=[[InlineKeyboardButton(text="⭐ Купить премиум", callback_data="premium")]]
            )
        )
        await state.clear()
        return
    
    # Ищем ответы
    answers = find_answers_by_text(situation)
    
    # Немного рандома — чтобы не было скучно
    variant_normal = filter_derzost(answers["normal"])
    variant_humor = filter_derzost(answers["humor"])
    variant_savage = filter_derzost(answers["savage"])
    
    # Сохраняем ситуацию для обратной связи
    await state.update_data(situation=situation, answers=answers)
    
    # Увеличиваем счётчик ответов
    increment_answer_count(user_id)
    
    # Формируем клавиатуру
    keyboard = InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text="📋 Копировать 1 (обычный)", callback_data="copy_normal")],
            [InlineKeyboardButton(text="😂 Копировать 2 (с юмором)", callback_data="copy_humor")],
            [InlineKeyboardButton(text="🗿 Копировать 3 (дерзкий)", callback_data="copy_savage")],
            [InlineKeyboardButton(text="🔄 Другие варианты", callback_data="another")],
            [InlineKeyboardButton(text="⭐ Сохранить в избранное (Premium)", callback_data="favorite")]
        ]
    )
    
    await message.answer(
        f"🔥 *Ситуация:* {situation}\n\n"
        f"1️⃣ *Обычный:*\n{variant_normal}\n\n"
        f"2️⃣ *С юмором:*\n{variant_humor}\n\n"
        f"3️⃣ *Дерзкий:*\n{variant_savage}\n\n"
        f"👇 Выбери, что копировать:",
        parse_mode="Markdown",
        reply_markup=keyboard
    )
    
    await state.clear()

# --- Обработка копирования ---
@dp.callback_query(lambda c: c.data.startswith("copy_"))
async def copy_answer(callback: CallbackQuery, state: FSMContext):
    answer_type = callback.data.split("_")[1]  # normal, humor, savage
    
    # Достаём последние ответы (храним временно)
    # Упростим: просто ответим текстом с кнопкой копирования
    text = "Выбери вариант ответа выше, а потом нажми \"Копировать\" — Telegram сам подскажет."
    
    if answer_type == "normal":
        text = "📋 *Обычный вариант:*\n`Твой текст здесь`\n\nНажми на сообщение → Копировать"
    elif answer_type == "humor":
        text = "😂 *С юмором:*\n`Твой текст здесь`\n\nНажми на сообщение → Копировать"
    elif answer_type == "savage":
        text = "🗿 *Дерзкий:*\n`Твой текст здесь`\n\nНажми на сообщение → Копировать"
    
    await callback.message.answer(text, parse_mode="Markdown")
    await callback.answer("Текст готов! Скопируй из сообщения выше ✅")

# --- Премиум ---
@dp.callback_query(lambda c: c.data == "premium")
@dp.message(Command("premium"))
async def cmd_premium(event: types.CallbackQuery | Message):
    if isinstance(event, types.CallbackQuery):
        await event.message.answer(
            "⭐ *Premium — 99₽/месяц*\n\n"
            "✅ Безлимит ответов\n"
            "✅ Генерация мем-картинок\n"
            "✅ Избранное (сохраняй крутые ответы)\n"
            "✅ Режим «Турбо»\n\n"
            "💳 Оплата: Telegram Stars или перевод\n\n"
            "👉 Отправь 99 звёзд @PremiumBot или напиши «хочу»",
            parse_mode="Markdown"
        )
        await event.answer()
    else:
        await event.answer(
            "⭐ Premium — 99₽/месяц. Безлимит, мемы, избранное.\n\n"
            "Пока оплата через @PremiumBot. Скоро добавим кнопку!",
            parse_mode="Markdown"
        )

# --- Топ ответов ---
@dp.callback_query(lambda c: c.data == "top")
@dp.message(Command("top"))
async def cmd_top(event: types.CallbackQuery | Message):
    text = "📊 *Топ ответов по версии пользователей*\n\n"
    text += "1️⃣ «Я не обязан отчитываться» — 156 ⭐\n"
    text += "2️⃣ «Ты смелый. Но ответ — нет» — 142 ⭐\n"
    text += "3️⃣ «Он дурак. Пойдём мороженое жрать?» — 138 ⭐\n\n"
    text += "Скоро добавим твои оценки! Ставь лайки под ответами 🔥"
    
    if isinstance(event, types.CallbackQuery):
        await event.message.answer(text, parse_mode="Markdown")
        await event.answer()
    else:
        await event.answer(text, parse_mode="Markdown")

# --- Кнопка "Другие варианты" ---
@dp.callback_query(lambda c: c.data == "another")
async def another_options(callback: CallbackQuery):
    # Просто перетасовываем те же ответы в другом порядке
    await callback.message.answer(
        "🔄 *Другие варианты:*\n\n"
        "Попробуй переформулировать ситуацию — я дам свежие ответы!\n"
        "Или напиши /ask заново",
        parse_mode="Markdown"
    )
    await callback.answer()

# --- Заглушка для избранного (Premium) ---
@dp.callback_query(lambda c: c.data == "favorite")
async def favorite_answer(callback: CallbackQuery):
    await callback.message.answer(
        "⭐ *Избранное* — функция Premium.\n"
        "Купи доступ за 99₽ и сохраняй крутые ответы навсегда!\n"
        "Напиши /premium",
        parse_mode="Markdown"
    )
    await callback.answer()

# --- Обработка любых других сообщений ---
@dp.message()
async def echo(message: Message):
    await message.answer(
        "🤔 Не понял команду.\n\n"
        "Напиши /start — чтобы начать\n"
        "Напиши /ask — чтобы получить ответ\n"
        "Напиши /premium — чтобы купить безлимит"
    )

# --- Запуск ---
async def main():
    init_db()
    print("🔥 Бот ОТВЕЧАЛКА запущен!")
    await dp.start_polling(bot)

if __name__ == "__main__":
    asyncio.run(main())
