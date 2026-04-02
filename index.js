const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const Database = require('better-sqlite3');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const db = new Database('focusbot.db');

// Инициализация таблиц
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    telegram_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT,
    language TEXT DEFAULT 'ru',
    points INTEGER DEFAULT 0,
    is_premium INTEGER DEFAULT 0,
    premium_until INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    start_time INTEGER,
    end_time INTEGER,
    limit_minutes INTEGER,
    actual_minutes INTEGER DEFAULT 0,
    penalty_stars INTEGER DEFAULT 0,
    penalty_paid INTEGER DEFAULT 0,
    screenshot_file_id TEXT,
    verified INTEGER DEFAULT 0,
    status TEXT DEFAULT 'active',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER,
    name TEXT,
    deposit_stars INTEGER,
    start_time INTEGER,
    end_time INTEGER,
    status TEXT DEFAULT 'active',
    prize_pool INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS challenge_participants (
    challenge_id INTEGER,
    user_id INTEGER,
    total_minutes INTEGER DEFAULT 0,
    joined_at INTEGER,
    PRIMARY KEY (challenge_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount_stars INTEGER,
    type TEXT,
    status TEXT,
    created_at INTEGER
  );
`);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ================ ЯЗЫКИ ================

const t = (userId, key, vars = {}) => {
  const user = db.prepare('SELECT language FROM users WHERE telegram_id = ?').get(userId);
  const lang = user?.language || 'ru';
  
  const texts = {
    ru: {
      focus_start: `🎯 Выбери лимит сессии:`,
      session_start: `✅ <b>Фокус-сессия началась!</b>\n\n⏰ Лимит: %minutes% минут\n💰 Штраф: %penalty% ⭐️ (если превысишь)\n⭐ Бонус: +%bonus% баллов\n\nКогда закончишь, отправь СКРИНШОТ экранного времени.`,
      need_screenshot: `📸 Пожалуйста, отправь скриншот экранного времени за эту сессию.\n\nКак сделать скриншот:\n• iOS: Настройки → Экранное время\n• Android: Настройки → Цифровое благополучие`,
      session_verified: `✅ Сессия подтверждена!\n\n📱 Время: %actual% минут\n💰 Штраф: %penalty% ⭐️\n⭐ Получено баллов: +%points%`,
      session_penalty: `⚠️ Ты превысил лимит на %exceeded% минут!\n💰 Штраф: %penalty% ⭐️\nОплати командой /pay_penalty`,
      no_session: `❌ Нет активной сессии. Начни с /focus`,
      time_up: `⏰ Время вышло! Отправь скриншот, чтобы завершить сессию.`,
      stats: `📊 <b>Твоя статистика</b>\n\n⭐ Баллов: %points%\n💎 Статус: %premium%\n📱 Сессий: %sessions%\n⏱ Всего времени: %hours% ч\n💰 Штрафов: %penalties% ⭐️`,
      premium_info: `💎 <b>Premium подписка</b>\n\n• 2x баллов за сессии\n• Неограниченные челленджи\n\n<b>Цена: 50 ⭐️/месяц</b>`,
      premium_success: `🎉 Ты стал Premium пользователем!`,
      penalty_paid: `✅ Штраф оплачен!`,
      no_penalties: `✅ Нет штрафов`,
      challenge_created: `✅ Челлендж создан!\n💰 Депозит: %deposit% ⭐️\n👥 Код: /join_%id%`,
      challenge_joined: `🎉 Ты в игре!`,
      lang_changed: `🌐 Язык: Русский`
    },
    en: {
      focus_start: `🎯 Choose session limit:`,
      session_start: `✅ <b>Focus session started!</b>\n\n⏰ Limit: %minutes% min\n💰 Penalty: %penalty% ⭐️ (if exceeded)\n⭐ Bonus: +%bonus% points\n\nWhen done, send a SCREENSHOT of your screen time.`,
      need_screenshot: `📸 Please send a screenshot of your screen time for this session.\n\nHow to screenshot:\n• iOS: Settings → Screen Time\n• Android: Settings → Digital Wellbeing`,
      session_verified: `✅ Session verified!\n\n📱 Time: %actual% minutes\n💰 Penalty: %penalty% ⭐️\n⭐ Points earned: +%points%`,
      session_penalty: `⚠️ You exceeded the limit by %exceeded% minutes!\n💰 Penalty: %penalty% ⭐️\nPay with /pay_penalty`,
      no_session: `❌ No active session. Start with /focus`,
      time_up: `⏰ Time's up! Send a screenshot to complete the session.`,
      stats: `📊 <b>Your stats</b>\n\n⭐ Points: %points%\n💎 Status: %premium%\n📱 Sessions: %sessions%\n⏱ Total time: %hours% h\n💰 Penalties: %penalties% ⭐️`,
      premium_info: `💎 <b>Premium subscription</b>\n\n• 2x points per session\n• Unlimited challenges\n\n<b>Price: 50 ⭐️/month</b>`,
      premium_success: `🎉 You are now Premium!`,
      penalty_paid: `✅ Penalty paid!`,
      no_penalties: `✅ No penalties`,
      challenge_created: `✅ Challenge created!\n💰 Deposit: %deposit% ⭐️\n👥 Code: /join_%id%`,
      challenge_joined: `🎉 You're in!`,
      lang_changed: `🌐 Language: English`
    }
  };
  
  let text = texts[lang][key] || texts.ru[key];
  for (const [k, v] of Object.entries(vars)) {
    text = text.replace(`%${k}%`, v);
  }
  return text;
};

// ================ ФУНКЦИИ ================

function getOrCreateUser(telegramId, username, firstName) {
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user) {
    db.prepare(`INSERT INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)`)
      .run(telegramId, username, firstName);
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  }
  return user;
}

function addPoints(telegramId, points) {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  const multiplier = user?.is_premium ? 2 : 1;
  const earned = points * multiplier;
  db.prepare('UPDATE users SET points = points + ? WHERE telegram_id = ?').run(earned, telegramId);
  return earned;
}

// ================ КОМАНДЫ ================

// Старт
bot.start(async (ctx) => {
  getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  
  await ctx.replyWithHTML(
    `🧠 <b>FocusBot</b> - перестань листать ленту!\n\n` +
    `/focus - начать сессию\n` +
    `/stats - статистика\n` +
    `/premium - премиум\n` +
    `/challenge - создать челлендж\n` +
    `/language - сменить язык`,
    Markup.keyboard([
      ['🎯 /focus', '📊 /stats'],
      ['💎 /premium', '🏆 /challenge'],
      ['🌐 /language']
    ]).resize()
  );
});

// Язык
bot.command('language', async (ctx) => {
  await ctx.reply('🌐 Выберите язык:', Markup.inlineKeyboard([
    [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
    [Markup.button.callback('🇬🇧 English', 'lang_en')]
  ]));
});

bot.action(/lang_(ru|en)/, async (ctx) => {
  db.prepare('UPDATE users SET language = ? WHERE telegram_id = ?').run(ctx.match[1], ctx.from.id);
  await ctx.reply(t(ctx.from.id, 'lang_changed'));
  await ctx.answerCbQuery();
});

// Начать сессию
bot.command('focus', async (ctx) => {
  await ctx.reply(t(ctx.from.id, 'focus_start'), Markup.inlineKeyboard([
    [Markup.button.callback('⏱ 30 мин', 'focus_30')],
    [Markup.button.callback('⏱ 1 час', 'focus_60')],
    [Markup.button.callback('⏱ 2 часа', 'focus_120')],
    [Markup.button.callback('⏱ 4 часа', 'focus_240')]
  ]));
});

bot.action(/focus_(\d+)/, async (ctx) => {
  const minutes = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const penaltyStars = Math.ceil(minutes / 60) * 50; // 50 Stars per hour
  
  // Закрываем старые активные сессии
  db.prepare(`UPDATE sessions SET status = 'cancelled' WHERE user_id = ? AND status = 'active'`).run(userId);
  
  const result = db.prepare(`
    INSERT INTO sessions (user_id, start_time, limit_minutes, penalty_stars, status)
    VALUES (?, ?, ?, ?, 'active')
  `).run(userId, Math.floor(Date.now() / 1000), minutes, penaltyStars);
  
  ctx.session = ctx.session || {};
  ctx.session.activeSession = {
    id: result.lastInsertRowid,
    limit: minutes,
    startTime: Math.floor(Date.now() / 1000)
  };
  
  await ctx.replyWithHTML(t(userId, 'session_start', {
    minutes: minutes,
    penalty: penaltyStars,
    bonus: minutes
  }));
  
  // Таймер напоминания
  setTimeout(async () => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ? AND status = "active"').get(result.lastInsertRowid);
    if (session) {
      await ctx.reply(t(userId, 'time_up'));
    }
  }, minutes * 60 * 1000);
  
  await ctx.answerCbQuery();
});

// Обработка скриншотов
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  
  // Проверяем активную сессию
  const session = db.prepare(`
    SELECT * FROM sessions WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1
  `).get(userId);
  
  if (!session) {
    await ctx.reply(t(userId, 'no_session'));
    return;
  }
  
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const actualSeconds = Math.floor(Date.now() / 1000) - session.start_time;
  const actualMinutes = Math.floor(actualSeconds / 60);
  const exceeded = Math.max(0, actualMinutes - session.limit_minutes);
  const penaltyStars = Math.ceil(exceeded / 60) * 50;
  
  // Обновляем сессию
  db.prepare(`
    UPDATE sessions 
    SET end_time = ?, actual_minutes = ?, penalty_stars = ?, screenshot_file_id = ?, status = 'completed', verified = 1
    WHERE id = ?
  `).run(Math.floor(Date.now() / 1000), actualMinutes, penaltyStars, photo.file_id, session.id);
  
  if (penaltyStars > 0) {
    // Записываем штраф
    db.prepare(`
      INSERT INTO payments (user_id, amount_stars, type, status, created_at)
      VALUES (?, ?, 'penalty', 'pending', ?)
    `).run(userId, penaltyStars, Math.floor(Date.now() / 1000));
    
    await ctx.replyWithHTML(t(userId, 'session_penalty', {
      exceeded: exceeded,
      penalty: penaltyStars
    }));
  } else {
    const earned = addPoints(userId, session.limit_minutes);
    await ctx.replyWithHTML(t(userId, 'session_verified', {
      actual: actualMinutes,
      penalty: 0,
      points: earned
    }));
  }
  
  ctx.session.activeSession = null;
});

// Статистика
bot.command('stats', async (ctx) => {
  const userId = ctx.from.id;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId);
  
  const stats = db.prepare(`
    SELECT COUNT(*) as total, SUM(actual_minutes) as total_time, SUM(penalty_stars) as total_penalties
    FROM sessions WHERE user_id = ? AND status = 'completed'
  `).get(userId);
  
  await ctx.replyWithHTML(t(userId, 'stats', {
    points: user?.points || 0,
    premium: user?.is_premium ? 'PREMIUM' : 'FREE',
    sessions: stats?.total || 0,
    hours: Math.floor((stats?.total_time || 0) / 60),
    penalties: stats?.total_penalties || 0
  }));
});

// Оплата штрафа
bot.command('pay_penalty', async (ctx) => {
  const userId = ctx.from.id;
  const penalties = db.prepare(`
    SELECT SUM(amount_stars) as total FROM payments 
    WHERE user_id = ? AND type = 'penalty' AND status = 'pending'
  `).get(userId);
  
  if (!penalties?.total) {
    await ctx.reply(t(userId, 'no_penalties'));
    return;
  }
  
  // Здесь должна быть интеграция с Telegram Stars
  await ctx.reply(
    `💰 Штраф: ${penalties.total} ⭐️\n\n` +
    `Оплатите и отправьте чек в поддержку.`
  );
});

// Премиум
bot.command('premium', async (ctx) => {
  await ctx.replyWithHTML(t(ctx.from.id, 'premium_info'), Markup.inlineKeyboard([
    [Markup.button.callback('⭐ Купить за 50 Stars', 'buy_premium')]
  ]));
});

bot.action('buy_premium', async (ctx) => {
  const userId = ctx.from.id;
  const premiumUntil = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  
  db.prepare('UPDATE users SET is_premium = 1, premium_until = ? WHERE telegram_id = ?')
    .run(premiumUntil, userId);
  
  await ctx.reply(t(userId, 'premium_success'));
  await ctx.answerCbQuery();
});

// Челленджи
bot.command('challenge', async (ctx) => {
  ctx.session.creatingChallenge = true;
  await ctx.reply(`💰 Введите сумму депозита (50-500 Stars):`);
});

// API endpoint для Railway
app.get('/', (req, res) => {
  res.json({ status: 'running', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Запуск
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server on port ${PORT}`);
});

bot.launch().then(() => {
  console.log('🤖 Bot started');
});

process.on('SIGTERM', () => {
  bot.stop('SIGTERM');
  process.exit(0);
});
