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
    total_penalties REAL DEFAULT 0,
    is_premium INTEGER DEFAULT 0,
    premium_until INTEGER,
    blocked_until INTEGER,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    start_time INTEGER,
    end_time INTEGER,
    duration_minutes INTEGER,
    limit_minutes INTEGER,
    penalty_stars INTEGER DEFAULT 0,
    penalty_paid INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0
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
    total_scroll_time INTEGER DEFAULT 0,
    joined_at INTEGER,
    PRIMARY KEY (challenge_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    amount_stars INTEGER,
    type TEXT,
    status TEXT,
    telegram_star_order_id TEXT,
    created_at INTEGER
  );
`);

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);

// ================ ЯЗЫКОВЫЕ ФАЙЛЫ ================

const translations = {
  ru: {
    welcome: `🧠 <b>FocusBot - перестань листать ленту!</b>\n\nПривет, %name%! Я помогу тебе контролировать время в телефоне.\n\n<b>💰 Как это работает:</b>\n1. /focus - начать сессию с лимитом\n2. Соблюдешь лимит → +баллы\n3. Превысишь → штраф ⭐️\n\n<b>💎 Premium (50⭐/месяц):</b>\n• В 2 раза больше баллов\n\n<b>👥 Челленджи:</b>\n/create_challenge - с друзьями\n\nГотов? /focus 🚀`,
    focus_choose: `🎯 Выбери лимит сессии:`,
    focus_started: `✅ <b>Фокус-сессия началась!</b>\n\n⏰ Лимит: %minutes% минут\n💰 Штраф: %penalty% ⭐️ при превышении\n⭐ Бонус: +%points% баллов\n\nКогда закончишь, нажми /complete`,
    focus_complete_success: `🎉 Отлично! Ты соблюл лимит!\n⭐ Получено баллов: +%points%`,
    focus_complete_penalty: `⚠️ Ты превысил лимит на %exceeded% минут!\n💰 Штраф: %penalty% ⭐️\nОплати командой /pay_penalty`,
    no_active_session: `❌ Нет активной сессии. Начни с /focus`,
    stats: `📊 <b>Твоя статистика</b>\n\n⭐ Баллов: %points%\n💎 Статус: %premium%\n📱 Всего сессий: %sessions%\n⏱ Всего времени: %hours% часов\n💰 Штрафов: %penalties% ⭐️\n\n<i>/challenges - мои челленджи</i>`,
    premium_info: `💎 <b>Premium подписка</b>\n\n• 2x баллов за сессии\n• Неограниченные челленджи\n• Приоритетная поддержка\n\n<b>Цена: 50 ⭐️/месяц</b>`,
    premium_success: `🎉 Ты стал Premium пользователем!\n✅ Активен до %date%`,
    penalty_paid: `✅ Штраф оплачен! Спасибо за честность!`,
    no_penalties: `✅ У тебя нет штрафов!`,
    challenge_created: `✅ <b>Челлендж создан!</b>\n\n📛 %name%\n💰 Депозит: %deposit% ⭐️\n👥 Пригласи друзей: /join_%id%`,
    challenge_joined: `🎉 Ты присоединился к челленджу "%name%"!`,
    language_changed: `🌐 Язык изменен на русский`,
    select_language: `🌐 Выберите язык / Choose language:`
  },
  en: {
    welcome: `🧠 <b>FocusBot - Stop scrolling!</b>\n\nHi %name%! I'll help you control your phone time.\n\n<b>💰 How it works:</b>\n1. /focus - start a session with limit\n2. Keep limit → +points\n3. Exceed → ⭐️ penalty\n\n<b>💎 Premium (50⭐/month):</b>\n• 2x points\n\n<b>👥 Challenges:</b>\n/create_challenge - with friends\n\nReady? /focus 🚀`,
    focus_choose: `🎯 Choose session limit:`,
    focus_started: `✅ <b>Focus session started!</b>\n\n⏰ Limit: %minutes% minutes\n💰 Penalty: %penalty% ⭐️ if exceeded\n⭐ Bonus: +%points% points\n\nWhen done, press /complete`,
    focus_complete_success: `🎉 Great! You kept the limit!\n⭐ Points earned: +%points%`,
    focus_complete_penalty: `⚠️ You exceeded the limit by %exceeded% minutes!\n💰 Penalty: %penalty% ⭐️\nPay with /pay_penalty`,
    no_active_session: `❌ No active session. Start with /focus`,
    stats: `📊 <b>Your stats</b>\n\n⭐ Points: %points%\n💎 Status: %premium%\n📱 Total sessions: %sessions%\n⏱ Total time: %hours% hours\n💰 Penalties: %penalties% ⭐️\n\n<i>/challenges - my challenges</i>`,
    premium_info: `💎 <b>Premium subscription</b>\n\n• 2x points per session\n• Unlimited challenges\n• Priority support\n\n<b>Price: 50 ⭐️/month</b>`,
    premium_success: `🎉 You are now Premium!\n✅ Active until %date%`,
    penalty_paid: `✅ Penalty paid! Thanks for being honest!`,
    no_penalties: `✅ No penalties!`,
    challenge_created: `✅ <b>Challenge created!</b>\n\n📛 %name%\n💰 Deposit: %deposit% ⭐️\n👥 Invite friends: /join_%id%`,
    challenge_joined: `🎉 You joined challenge "%name%"!`,
    language_changed: `🌐 Language changed to English`,
    select_language: `🌐 Select language / Выберите язык:`
  }
};

function t(userId, key, replacements = {}) {
  const user = db.prepare('SELECT language FROM users WHERE telegram_id = ?').get(userId);
  const lang = user?.language === 'en' ? 'en' : 'ru';
  let text = translations[lang][key] || translations.ru[key];
  
  for (const [k, v] of Object.entries(replacements)) {
    text = text.replace(`%${k}%`, v);
  }
  return text;
}

// ================ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ================

function getOrCreateUser(telegramId, username, firstName) {
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  
  if (!user) {
    db.prepare(`
      INSERT INTO users (telegram_id, username, first_name) 
      VALUES (?, ?, ?)
    `).run(telegramId, username, firstName);
    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  }
  
  return user;
}

function addPoints(telegramId, points) {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId);
  if (!user) return 0;
  
  const multiplier = user.is_premium ? 2 : 1;
  const earned = points * multiplier;
  db.prepare('UPDATE users SET points = points + ? WHERE telegram_id = ?').run(earned, telegramId);
  return earned;
}

// ================ API ENDPOINTS ================

app.get('/', (req, res) => {
  res.json({ status: 'running', message: 'Focus Bot API', time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', port: PORT });
});

// ================ КОМАНДЫ БОТА ================

// Языковое меню
bot.command('language', async (ctx) => {
  await ctx.reply(
    `🌐 Select language / Выберите язык:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🇷🇺 Русский', 'lang_ru')],
      [Markup.button.callback('🇬🇧 English', 'lang_en')]
    ])
  );
});

bot.action(/lang_(ru|en)/, async (ctx) => {
  const lang = ctx.match[1];
  db.prepare('UPDATE users SET language = ? WHERE telegram_id = ?').run(lang, ctx.from.id);
  
  const msg = lang === 'ru' ? '🌐 Язык изменен на русский' : '🌐 Language changed to English';
  await ctx.reply(msg);
  await ctx.answerCbQuery();
});

// Старт
bot.start(async (ctx) => {
  const user = getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
  const welcomeText = t(ctx.from.id, 'welcome', { name: ctx.from.first_name });
  
  await ctx.replyWithHTML(welcomeText, Markup.keyboard([
    ['🎯 /focus', '📊 /stats'],
    ['💎 /premium', '👥 /challenges'],
    ['🌐 /language']
  ]).resize());
});

// Фокус-сессия
bot.command('focus', async (ctx) => {
  const userId = ctx.from.id;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId);
  
  if (user?.blocked_until && user.blocked_until > Date.now() / 1000) {
    await ctx.reply(`❌ ${user.language === 'ru' ? 'Вы заблокированы' : 'You are blocked'}`);
    return;
  }
  
  await ctx.reply(t(userId, 'focus_choose'), Markup.inlineKeyboard([
    [Markup.button.callback('⏱ 30 min', 'focus_30')],
    [Markup.button.callback('⏱ 1 hour', 'focus_60')],
    [Markup.button.callback('⏱ 2 hours', 'focus_120')],
    [Markup.button.callback('⏱ 4 hours', 'focus_240')]
  ]));
});

bot.action(/focus_(\d+)/, async (ctx) => {
  const minutes = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const penaltyStars = Math.floor(minutes / 60) * 25; // 25 Stars per hour
  
  const startTime = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO sessions (user_id, start_time, limit_minutes, penalty_stars)
    VALUES (?, ?, ?, ?)
  `).run(userId, startTime, minutes, penaltyStars);
  
  ctx.session = ctx.session || {};
  ctx.session.activeSession = {
    id: result.lastInsertRowid,
    limit: minutes,
    startTime: startTime,
    penaltyStars: penaltyStars
  };
  
  const pointsBonus = minutes;
  await ctx.replyWithHTML(t(userId, 'focus_started', {
    minutes: minutes,
    penalty: penaltyStars,
    points: pointsBonus
  }));
  
  setTimeout(async () => {
    if (ctx.session?.activeSession?.id === result.lastInsertRowid) {
      await ctx.reply(`⏰ ${t(userId, 'time_up') || 'Time is up! Press /complete'}`);
    }
  }, minutes * 60 * 1000);
  
  await ctx.answerCbQuery();
});

// Завершение сессии
bot.command('complete', async (ctx) => {
  if (!ctx.session?.activeSession) {
    await ctx.reply(t(ctx.from.id, 'no_active_session'));
    return;
  }
  
  const session = ctx.session.activeSession;
  const actualSeconds = Math.floor(Date.now() / 1000) - session.startTime;
  const actualMinutes = Math.floor(actualSeconds / 60);
  const exceeded = Math.max(0, actualMinutes - session.limit);
  const penaltyStars = Math.floor(exceeded / 60) * 25;
  
  db.prepare(`
    UPDATE sessions 
    SET end_time = ?, duration_minutes = ?, penalty_stars = ?, completed = 1
    WHERE id = ?
  `).run(Math.floor(Date.now() / 1000), actualMinutes, penaltyStars, session.id);
  
  if (penaltyStars > 0) {
    await ctx.replyWithHTML(t(ctx.from.id, 'focus_complete_penalty', {
      exceeded: exceeded,
      penalty: penaltyStars
    }));
  } else {
    const earned = addPoints(ctx.from.id, session.limit);
    await ctx.replyWithHTML(t(ctx.from.id, 'focus_complete_success', { points: earned }));
  }
  
  ctx.session.activeSession = null;
});

// Оплата штрафа через Stars
bot.command('pay_penalty', async (ctx) => {
  const userId = ctx.from.id;
  const penalties = db.prepare(`
    SELECT * FROM sessions WHERE user_id = ? AND penalty_stars > 0 AND penalty_paid = 0 AND completed = 1
  `).all(userId);
  
  const totalPenalty = penalties.reduce((sum, p) => sum + p.penalty_stars, 0);
  
  if (totalPenalty === 0) {
    await ctx.reply(t(userId, 'no_penalties'));
    return;
  }
  
  // Создаем инвойс на оплату Stars
  const invoiceLink = `https://t.me/${process.env.BOT_USERNAME}?start=pay_${Date.now()}`;
  
  await ctx.replyWithHTML(
    `💰 <b>${t(userId, 'penalty_amount') || 'Penalty amount'}:</b> ${totalPenalty} ⭐️\n\n` +
    `Нажмите кнопку для оплаты:`,
    Markup.inlineKeyboard([
      [Markup.button.url('⭐ Оплатить Stars', invoiceLink)]
    ])
  );
});

// Премиум
bot.command('premium', async (ctx) => {
  const userId = ctx.from.id;
  await ctx.replyWithHTML(t(userId, 'premium_info'), Markup.inlineKeyboard([
    [Markup.button.callback('⭐ 50 Stars / month', 'buy_premium')]
  ]));
});

bot.action('buy_premium', async (ctx) => {
  const userId = ctx.from.id;
  const invoiceLink = `https://t.me/${process.env.BOT_USERNAME}?start=premium_${Date.now()}`;
  
  await ctx.reply(
    `💎 ${t(userId, 'premium_payment') || 'Click to pay:'}`,
    Markup.inlineKeyboard([[Markup.button.url('⭐ Pay with Stars', invoiceLink)]])
  );
  await ctx.answerCbQuery();
});

// Статистика
bot.command('stats', async (ctx) => {
  const userId = ctx.from.id;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId);
  
  const sessions = db.prepare(`
    SELECT COUNT(*) as total, SUM(duration_minutes) as total_time, SUM(penalty_stars) as total_penalties
    FROM sessions WHERE user_id = ? AND completed = 1
  `).get(userId);
  
  await ctx.replyWithHTML(t(userId, 'stats', {
    points: user?.points || 0,
    premium: user?.is_premium ? 'PREMIUM' : 'FREE',
    sessions: sessions?.total || 0,
    hours: Math.floor((sessions?.total_time || 0) / 60),
    penalties: sessions?.total_penalties || 0
  }));
});

// Челленджи
bot.command('challenges', async (ctx) => {
  const userId = ctx.from.id;
  const challenges = db.prepare(`
    SELECT c.* FROM challenges c
    JOIN challenge_participants cp ON c.id = cp.challenge_id
    WHERE cp.user_id = ? AND c.status = 'active'
  `).all(userId);
  
  if (challenges.length === 0) {
    await ctx.reply(`📭 ${t(userId, 'no_challenges') || 'No active challenges. Create one with /create_challenge'}`);
  } else {
    let msg = `🏆 <b>${t(userId, 'my_challenges') || 'My challenges'}</b>\n\n`;
    challenges.forEach(c => {
      msg += `📛 ${c.name} | 💰 ${c.deposit_stars}⭐\n`;
    });
    await ctx.replyWithHTML(msg);
  }
});

bot.command('create_challenge', async (ctx) => {
  ctx.session.creatingChallenge = true;
  await ctx.reply(`💰 ${t(ctx.from.id, 'enter_deposit') || 'Enter deposit amount (Stars, 50-500):'}`);
});

// Обработка текстовых сообщений
bot.on('text', async (ctx) => {
  if (ctx.session?.creatingChallenge) {
    const deposit = parseInt(ctx.message.text);
    if (isNaN(deposit) || deposit < 50 || deposit > 500) {
      await ctx.reply(`❌ ${t(ctx.from.id, 'invalid_deposit') || 'Deposit must be 50-500 Stars'}`);
      return;
    }
    
    const challengeName = `Challenge_${Date.now()}`;
    const result = db.prepare(`
      INSERT INTO challenges (creator_id, name, deposit_stars, start_time, end_time, prize_pool)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ctx.from.id, challengeName, deposit, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000) + 7*24*60*60, deposit);
    
    db.prepare(`INSERT INTO challenge_participants (challenge_id, user_id, joined_at) VALUES (?, ?, ?)`)
      .run(result.lastInsertRowid, ctx.from.id, Math.floor(Date.now() / 1000));
    
    await ctx.replyWithHTML(t(ctx.from.id, 'challenge_created', {
      name: challengeName,
      deposit: deposit,
      id: result.lastInsertRowid
    }));
    
    ctx.session.creatingChallenge = false;
  }
});

// Health check для бота
bot.telegram.getMe().then(info => {
  console.log(`🤖 Bot @${info.username} is ready`);
});

// ================ ЗАПУСК ================

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🤖 FocusBot started with:`);
  console.log(`   • Penalties via Telegram Stars`);
  console.log(`   • Russian/English languages`);
  console.log(`   • Group challenges`);
});

// Запуск бота в polling режиме
bot.launch().catch(err => {
  console.error('Bot launch error:', err);
});

process.on('SIGTERM', () => {
  bot.stop('SIGTERM');
  process.exit(0);
});
