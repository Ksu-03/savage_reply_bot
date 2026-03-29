const { Telegraf, Markup, session } = require('telegraf');
const axios = require('axios');
const moment = require('moment');
const cron = require('node-cron');
require('dotenv').config();

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const API_URL = process.env.BACKEND_URL || 'https://focus-backend.railway.app';

// Session middleware
bot.use(session());

// ================ БАЗА ДАННЫХ (встроенная SQLite для простоты) ================
const Database = require('better-sqlite3');
const db = new Database('focusbot.db');

// Инициализация таблиц
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    telegram_id INTEGER UNIQUE,
    username TEXT,
    first_name TEXT,
    points INTEGER DEFAULT 0,
    total_penalties REAL DEFAULT 0,
    is_premium INTEGER DEFAULT 0,
    premium_until INTEGER,
    referral_code TEXT,
    referred_by INTEGER
  );
  
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    start_time INTEGER,
    end_time INTEGER,
    duration_minutes INTEGER,
    limit_minutes INTEGER,
    penalty REAL DEFAULT 0,
    completed INTEGER DEFAULT 0
  );
  
  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creator_id INTEGER,
    name TEXT,
    deposit_amount REAL,
    start_time INTEGER,
    end_time INTEGER,
    status TEXT DEFAULT 'active',
    prize_pool REAL DEFAULT 0
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
    amount REAL,
    type TEXT,
    status TEXT,
    telegram_star_order_id TEXT,
    created_at INTEGER
  );
`);

// ================ ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ================

// Начисление баллов пользователю
function addPoints(userId, points) {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId);
  if (!user) return;
  
  const newPoints = user.points + points;
  db.prepare('UPDATE users SET points = ? WHERE telegram_id = ?').run(newPoints, userId);
  
  // Проверка на новые достижения
  checkAchievements(userId, newPoints);
  return newPoints;
}

// Проверка достижений
function checkAchievements(userId, points) {
  const achievements = [];
  if (points >= 100) achievements.push('🏅 Новичок');
  if (points >= 500) achievements.push('⭐ Фокус-мастер');
  if (points >= 1000) achievements.push('💎 Легенда фокуса');
  if (points >= 5000) achievements.push('👑 Бог продуктивности');
  
  if (achievements.length > 0) {
    bot.telegram.sendMessage(userId, 
      `🎉 Новое достижение: ${achievements.join(', ')}!\nПродолжай в том же духе!`
    );
  }
}

// Списание штрафа
async function applyPenalty(userId, sessionId, penaltyAmount) {
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId);
  if (!user) return;
  
  // Обновляем сессию
  db.prepare('UPDATE sessions SET penalty = ?, completed = 1 WHERE id = ?').run(penaltyAmount, sessionId);
  db.prepare('UPDATE users SET total_penalties = total_penalties + ? WHERE telegram_id = ?').run(penaltyAmount, userId);
  
  // Создаем непогашенный штраф
  db.prepare(`
    INSERT INTO payments (user_id, amount, type, status, created_at)
    VALUES (?, ?, 'penalty', 'pending', ?)
  `).run(userId, penaltyAmount, Date.now());
  
  await bot.telegram.sendMessage(userId, 
    `⚠️ Штраф $${penaltyAmount} начислен!\n` +
    `Оплатите в течение 24 часов командой /pay_penalty\n` +
    `Иначе временная блокировка на 3 дня.`
  );
  
  // Запускаем таймер на блокировку
  setTimeout(async () => {
    const payment = db.prepare(`
      SELECT * FROM payments WHERE user_id = ? AND type = 'penalty' AND status = 'pending'
    `).get(userId);
    
    if (payment) {
      db.prepare('UPDATE users SET is_premium = 0 WHERE telegram_id = ?').run(userId);
      await bot.telegram.sendMessage(userId,
        `❌ Штраф не оплачен! Вы заблокированы на 3 дня.\n` +
        `Оплатите штраф для разблокировки.`
      );
    }
  }, 24 * 60 * 60 * 1000);
}

// ================ ФУНКЦИЯ 1: ШТРАФЫ И БАЛЛЫ ================

// Начать фокус-сессию
bot.command('focus', async (ctx) => {
  const userId = ctx.from.id;
  
  const buttons = [
    [Markup.button.callback('⏱ 30 мин (штраф $0.5)', 'focus_30')],
    [Markup.button.callback('⏱ 1 час (штраф $1)', 'focus_60')],
    [Markup.button.callback('⏱ 2 часа (штраф $2)', 'focus_120')],
    [Markup.button.callback('🎯 Свой лимит', 'focus_custom')]
  ];
  
  await ctx.reply(
    `🎯 <b>Новая фокус-сессия</b>\n\n` +
    `Выбери лимит времени:\n` +
    `• Соблюдешь лимит → получишь баллы\n` +
    `• Превысишь → штраф $0.5/час\n\n` +
    `💰 Баллы за сессию: ${ctx.session?.isPremium ? 2 : 1}x от минут фокуса`,
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(buttons) }
  );
});

// Обработка выбора лимита
bot.action(/focus_(\d+)/, async (ctx) => {
  const minutes = parseInt(ctx.match[1]);
  const userId = ctx.from.id;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId);
  
  // Проверка блокировки
  if (user?.blocked_until && user.blocked_until > Date.now()) {
    await ctx.reply(`❌ Вы заблокированы до ${new Date(user.blocked_until).toLocaleString()}`);
    return;
  }
  
  // Создаем сессию
  const startTime = Date.now();
  const result = db.prepare(`
    INSERT INTO sessions (user_id, start_time, limit_minutes, completed)
    VALUES (?, ?, ?, 0)
  `).run(userId, startTime, minutes);
  
  ctx.session.activeSession = {
    id: result.lastInsertRowid,
    limit: minutes,
    startTime: startTime
  };
  
  await ctx.reply(
    `✅ <b>Фокус-сессия началась!</b>\n\n` +
    `⏰ Лимит: ${minutes} минут\n` +
    `💰 Штраф: $${(minutes/60 * 0.5).toFixed(2)} за превышение\n` +
    `⭐ Бонус за соблюдение: +${minutes} баллов\n\n` +
    `Я напомню тебе, когда время выйдет. Удачи! 🍀`,
    { parse_mode: 'HTML' }
  );
  
  // Таймер окончания сессии
  setTimeout(async () => {
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(ctx.session.activeSession.id);
    if (session && !session.completed) {
      const actualMinutes = Math.floor((Date.now() - session.start_time) / 60000);
      const exceeded = Math.max(0, actualMinutes - session.limit_minutes);
      const penalty = (exceeded / 60) * 0.5;
      
      if (penalty > 0) {
        await applyPenalty(userId, session.id, penalty);
        await ctx.reply(
          `⚠️ <b>Время вышло!</b>\n\n` +
          `Вы превысили лимит на ${exceeded} минут\n` +
          `Штраф: $${penalty.toFixed(2)}\n\n` +
          `Оплатите командой /pay_penalty`,
          { parse_mode: 'HTML' }
        );
      } else {
        // Начисляем баллы
        const points = actualMinutes * (user?.is_premium ? 2 : 1);
        addPoints(userId, points);
        
        await ctx.reply(
          `🎉 <b>Отлично!</b>\n\n` +
          `✅ Вы соблюли лимит!\n` +
          `⭐ Получено баллов: +${points}\n` +
          `📊 Общий счет: ${(db.prepare('SELECT points FROM users WHERE telegram_id = ?').get(userId)?.points || 0)} баллов`,
          { parse_mode: 'HTML' }
        );
      }
      
      db.prepare('UPDATE sessions SET end_time = ?, completed = 1, duration_minutes = ? WHERE id = ?')
        .run(Date.now(), actualMinutes, session.id);
      
      ctx.session.activeSession = null;
    }
  }, minutes * 60 * 1000);
  
  await ctx.answerCbQuery();
});

// Ручное завершение сессии
bot.command('complete', async (ctx) => {
  if (!ctx.session.activeSession) {
    await ctx.reply('❌ Нет активной сессии. Начни командой /focus');
    return;
  }
  
  const actualMinutes = Math.floor((Date.now() - ctx.session.activeSession.startTime) / 60000);
  const limit = ctx.session.activeSession.limit;
  const exceeded = Math.max(0, actualMinutes - limit);
  const penalty = (exceeded / 60) * 0.5;
  
  if (penalty > 0) {
    await applyPenalty(ctx.from.id, ctx.session.activeSession.id, penalty);
    await ctx.reply(
      `⚠️ Сессия завершена с превышением!\n` +
      `Штраф: $${penalty.toFixed(2)}\n` +
      `Оплатите командой /pay_penalty`
    );
  } else {
    const points = actualMinutes;
    addPoints(ctx.from.id, points);
    await ctx.reply(
      `🎉 Отлично! Сессия завершена вовремя!\n` +
      `⭐ Получено баллов: +${points}`
    );
  }
  
  db.prepare('UPDATE sessions SET end_time = ?, completed = 1, duration_minutes = ? WHERE id = ?')
    .run(Date.now(), actualMinutes, ctx.session.activeSession.id);
  
  ctx.session.activeSession = null;
});

// Оплата штрафа
bot.command('pay_penalty', async (ctx) => {
  const userId = ctx.from.id;
  const penalties = db.prepare(`
    SELECT * FROM payments WHERE user_id = ? AND type = 'penalty' AND status = 'pending'
  `).all(userId);
  
  if (penalties.length === 0) {
    await ctx.reply('✅ У вас нет непогашенных штрафов!');
    return;
  }
  
  const totalPenalty = penalties.reduce((sum, p) => sum + p.amount, 0);
  
  await ctx.replyWithHTML(
    `<b>💰 Неоплаченные штрафы</b>\n\n` +
    `Сумма: $${totalPenalty.toFixed(2)}\n` +
    `Количество: ${penalties.length}\n\n` +
    `Выберите способ оплаты:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⭐ Оплатить Telegram Stars', 'pay_stars_penalty')],
      [Markup.button.callback('💳 Оплатить криптовалютой', 'pay_crypto_penalty')]
    ])
  );
});

// ================ ФУНКЦИЯ 2: TELEGRAM STARS ОПЛАТА ================

// Премиум подписка за Stars
bot.command('premium', async (ctx) => {
  await ctx.replyWithHTML(
    `<b>💎 Premium подписка</b>\n\n` +
    `<b>Что дает Premium:</b>\n` +
    `✅ В 2 раза больше баллов за сессии\n` +
    `✅ Неограниченные челленджи\n` +
    `✅ Детальная аналитика\n` +
    `✅ Приоритетная поддержка\n` +
    `✅ Эксклюзивные достижения\n\n` +
    `<b>Цены (Telegram Stars ⭐️):</b>\n` +
    `• 1 месяц — 50 ⭐️ ($4.99)\n` +
    `• 3 месяца — 140 ⭐️ ($13.99, скидка 5%)\n` +
    `• 12 месяцев — 500 ⭐️ ($49.99, скидка 17%)\n\n` +
    `<b>Криптовалюта:</b>\n` +
    `• 1 месяц — $4.99 (USDT/BTC/ETH)`,
    Markup.inlineKeyboard([
      [Markup.button.callback('⭐ 1 месяц (50 ⭐️)', 'premium_1month_stars')],
      [Markup.button.callback('⭐ 3 месяца (140 ⭐️)', 'premium_3months_stars')],
      [Markup.button.callback('⭐ 12 месяцев (500 ⭐️)', 'premium_12months_stars')],
      [Markup.button.callback('💳 Оплатить криптой', 'premium_crypto')]
    ])
  );
});

// Обработка оплаты Stars
bot.action(/premium_(\d+months?)_stars/, async (ctx) => {
  const period = ctx.match[1];
  let stars = 50;
  let months = 1;
  
  if (period === '3months') {
    stars = 140;
    months = 3;
  } else if (period === '12months') {
    stars = 500;
    months = 12;
  }
  
  const invoiceLink = await createTelegramStarsInvoice(ctx.from.id, stars, `Premium ${months} months`);
  
  await ctx.reply(
    `💎 Для оплаты нажмите на кнопку ниже:`,
    Markup.inlineKeyboard([
      [Markup.button.url('⭐ Оплатить Telegram Stars', invoiceLink)]
    ])
  );
  
  await ctx.answerCbQuery();
});

// Создание инвойса Telegram Stars
async function createTelegramStarsInvoice(userId, stars, description) {
  // В реальном проекте здесь API Telegram Bot для создания инвойса
  // Пока возвращаем тестовую ссылку
  const invoiceLink = `https://t.me/${
    process.env.BOT_USERNAME
  }/invoice?start=premium_${userId}_${Date.now()}`;
  
  // Сохраняем платеж в БД
  db.prepare(`
    INSERT INTO payments (user_id, amount, type, status, created_at)
    VALUES (?, ?, 'premium_stars', 'pending', ?)
  `).run(userId, stars, Date.now());
  
  return invoiceLink;
}

// Webhook для подтверждения оплаты Stars
bot.on('pre_checkout_query', async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on('successful_payment', async (ctx) => {
  const payment = ctx.message.successful_payment;
  const userId = ctx.from.id;
  const stars = payment.total_amount / 100; // Telegram передает в копейках
  
  // Активируем премиум
  let months = 1;
  if (stars === 140) months = 3;
  if (stars === 500) months = 12;
  
  const premiumUntil = Date.now() + (months * 30 * 24 * 60 * 60 * 1000);
  db.prepare('UPDATE users SET is_premium = 1, premium_until = ? WHERE telegram_id = ?')
    .run(premiumUntil, userId);
  
  // Обновляем статус платежа
  db.prepare(`
    UPDATE payments SET status = 'completed' 
    WHERE user_id = ? AND type = 'premium_stars' AND status = 'pending'
  `).run(userId);
  
  await ctx.reply(
    `🎉 <b>Поздравляем! Вы стали Premium пользователем!</b>\n\n` +
    `✅ Подписка активна до ${new Date(premiumUntil).toLocaleDateString()}\n` +
    `⭐ Теперь вы получаете в 2 раза больше баллов!\n` +
    `🔥 Доступны эксклюзивные челленджи!`,
    { parse_mode: 'HTML' }
  );
});

// ================ ФУНКЦИЯ 3: ГРУППОВЫЕ ЧЕЛЛЕНДЖИ ================

// Создание челленджа
bot.command('create_challenge', async (ctx) => {
  ctx.session.creatingChallenge = true;
  await ctx.reply(
    `🏆 <b>Создание группового челленджа</b>\n\n` +
    `Отправьте название челленджа (до 30 символов):`,
    { parse_mode: 'HTML' }
  );
});

bot.on('text', async (ctx) => {
  if (ctx.session.creatingChallenge) {
    ctx.session.challengeName = ctx.message.text;
    ctx.session.creatingChallenge = false;
    ctx.session.awaitingDeposit = true;
    
    await ctx.reply(
      `💰 Введите сумму депозита для участников (от $5 до $50):\n\n` +
      `Эта сумма будет заблокирована и вернется победителям!`
    );
    return;
  }
  
  if (ctx.session.awaitingDeposit) {
    const deposit = parseFloat(ctx.message.text);
    if (isNaN(deposit) || deposit < 5 || deposit > 50) {
      await ctx.reply('❌ Сумма должна быть от $5 до $50. Попробуйте еще раз:');
      return;
    }
    
    ctx.session.challengeDeposit = deposit;
    ctx.session.awaitingDeposit = false;
    
    // Создаем челлендж
    const result = db.prepare(`
      INSERT INTO challenges (creator_id, name, deposit_amount, start_time, end_time, prize_pool)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ctx.from.id, ctx.session.challengeName, deposit, Date.now(), Date.now() + 7*24*60*60*1000, 0);
    
    const challengeId = result.lastInsertRowid;
    
    // Добавляем создателя как участника
    db.prepare(`
      INSERT INTO challenge_participants (challenge_id, user_id, joined_at)
      VALUES (?, ?, ?)
    `).run(challengeId, ctx.from.id, Date.now());
    
    // Генерируем ссылку для приглашения
    const inviteLink = `https://t.me/${ctx.botInfo.username}?start=challenge_${challengeId}`;
    
    await ctx.replyWithHTML(
      `✅ <b>Челлендж создан!</b>\n\n` +
      `📛 Название: ${ctx.session.challengeName}\n` +
      `💰 Депозит: $${deposit}\n` +
      `⏱ Длительность: 7 дней\n` +
      `👥 Участников: 1\n\n` +
      `<b>Пригласи друзей:</b>\n` +
      `<code>${inviteLink}</code>\n\n` +
      `🏆 Победитель получит 70% призового фонда!\n` +
      `30% идет в общий фонд платформы.`,
      Markup.inlineKeyboard([
        [Markup.button.url('📤 Поделиться', `https://t.me/share/url?url=${inviteLink}&text=Присоединяйся к челленджу ${ctx.session.challengeName}!`)]
      ])
    );
    
    ctx.session.challengeName = null;
  }
});

// Присоединение к челленджу по ссылке
bot.start(async (ctx) => {
  const startParam = ctx.startPayload;
  
  if (startParam && startParam.startsWith('challenge_')) {
    const challengeId = parseInt(startParam.split('_')[1]);
    const userId = ctx.from.id;
    
    // Проверяем существует ли челлендж
    const challenge = db.prepare('SELECT * FROM challenges WHERE id = ? AND status = "active"').get(challengeId);
    if (!challenge) {
      await ctx.reply('❌ Челлендж не найден или уже завершен');
      return;
    }
    
    // Проверяем не участвует ли уже
    const existing = db.prepare(`
      SELECT * FROM challenge_participants WHERE challenge_id = ? AND user_id = ?
    `).get(challengeId, userId);
    
    if (existing) {
      await ctx.reply('✅ Вы уже участвуете в этом челлендже!');
      return;
    }
    
    // Добавляем участника
    db.prepare(`
      INSERT INTO challenge_participants (challenge_id, user_id, joined_at)
      VALUES (?, ?, ?)
    `).run(challengeId, userId, Date.now());
    
    // Обновляем призовой фонд
    const newPool = challenge.prize_pool + challenge.deposit_amount;
    db.prepare('UPDATE challenges SET prize_pool = ? WHERE id = ?').run(newPool, challengeId);
    
    await ctx.replyWithHTML(
      `🎉 <b>Вы присоединились к челленджу!</b>\n\n` +
      `📛 ${challenge.name}\n` +
      `💰 Ваш депозит: $${challenge.deposit_amount}\n` +
      `🏆 Призовой фонд: $${newPool}\n\n` +
      `Соревнуйтесь 7 дней, кто меньше скроллит!\n` +
      `Победитель получит 70% фонда!`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📊 Статистика челленджа', `challenge_stats_${challengeId}`)]
      ])
    );
  }
});

// Просмотр статистики челленджа
bot.action(/challenge_stats_(\d+)/, async (ctx) => {
  const challengeId = parseInt(ctx.match[1]);
  
  const challenge = db.prepare('SELECT * FROM challenges WHERE id = ?').get(challengeId);
  if (!challenge) {
    await ctx.reply('❌ Челлендж не найден');
    return;
  }
  
  const participants = db.prepare(`
    SELECT u.user_id, u.username, u.first_name, cp.total_scroll_time
    FROM challenge_participants cp
    JOIN users u ON cp.user_id = u.telegram_id
    WHERE cp.challenge_id = ?
    ORDER BY cp.total_scroll_time ASC
  `).all(challengeId);
  
  let leaderboard = `<b>🏆 ${challenge.name}</b>\n\n`;
  leaderboard += `💰 Призовой фонд: $${challenge.prize_pool}\n`;
  leaderboard += `⏱ Осталось: ${getTimeRemaining(challenge.end_time)}\n\n`;
  leaderboard += `<b>📊 Топ участников:</b>\n`;
  
  participants.forEach((p, index) => {
    const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '📱';
    const timeHours = (p.total_scroll_time / 60).toFixed(1);
    leaderboard += `${medal} ${p.first_name || p.username} — ${timeHours} часов\n`;
  });
  
  await ctx.replyWithHTML(leaderboard, Markup.inlineKeyboard([
    [Markup.button.callback('🔄 Обновить', `challenge_stats_${challengeId}`)]
  ]));
  
  await ctx.answerCbQuery();
});

// Обновление скролл-тайма для челленджа (интеграция с сессиями)
function updateChallengeScrollTime(userId, minutes) {
  const activeChallenges = db.prepare(`
    SELECT c.id FROM challenges c
    JOIN challenge_participants cp ON c.id = cp.challenge_id
    WHERE cp.user_id = ? AND c.status = 'active' AND c.end_time > ?
  `).all(userId, Date.now());
  
  activeChallenges.forEach(challenge => {
    db.prepare(`
      UPDATE challenge_participants 
      SET total_scroll_time = total_scroll_time + ? 
      WHERE challenge_id = ? AND user_id = ?
    `).run(minutes, challenge.id, userId);
  });
}

// Завершение челленджа и выплата призов
cron.schedule('0 0 * * *', () => {
  const now = Date.now();
  const completedChallenges = db.prepare(`
    SELECT * FROM challenges WHERE status = 'active' AND end_time < ?
  `).all(now);
  
  completedChallenges.forEach(challenge => {
    // Находим победителя
    const winner = db.prepare(`
      SELECT user_id FROM challenge_participants
      WHERE challenge_id = ?
      ORDER BY total_scroll_time ASC
      LIMIT 1
    `).get(challenge.id);
    
    if (winner) {
      const winnerPrize = challenge.prize_pool * 0.7;
      const platformFee = challenge.prize_pool * 0.3;
      
      // Начисляем приз победителю
      addPoints(winner.user_id, winnerPrize * 100); // 1$ = 100 баллов
      
      // Уведомляем победителя
      bot.telegram.sendMessage(winner.user_id,
        `🏆 <b>Поздравляем! Вы выиграли челлендж "${challenge.name}"!</b>\n\n` +
        `💰 Выигрыш: $${winnerPrize.toFixed(2)} (${winnerPrize * 100} баллов)\n` +
        `⭐ Баллы зачислены на ваш счет!`,
        { parse_mode: 'HTML' }
      );
      
      // Уведомляем всех участников
      const participants = db.prepare(`
        SELECT user_id FROM challenge_participants WHERE challenge_id = ?
      `).all(challenge.id);
      
      participants.forEach(p => {
        if (p.user_id !== winner.user_id) {
          bot.telegram.sendMessage(p.user_id,
            `🏁 Челлендж "${challenge.name}" завершен!\n` +
            `Победитель: ${winner.user_id}\n` +
            `Призовой фонд: $${challenge.prize_pool}\n\n` +
            `Не расстраивайтесь! Создайте новый челлендж и попробуйте снова!`
          );
        }
      });
    }
    
    // Обновляем статус челленджа
    db.prepare('UPDATE challenges SET status = "completed" WHERE id = ?').run(challenge.id);
  });
});

// ================ СТАТИСТИКА ================

bot.command('stats', async (ctx) => {
  const userId = ctx.from.id;
  const user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(userId);
  
  if (!user) {
    await ctx.reply('❌ Вы еще не начинали сессий. Начните с /focus');
    return;
  }
  
  const sessions = db.prepare(`
    SELECT COUNT(*) as total, SUM(duration_minutes) as total_time, SUM(penalty) as total_penalties
    FROM sessions WHERE user_id = ? AND completed = 1
  `).get(userId);
  
  const activeChallenges = db.prepare(`
    SELECT COUNT(*) as count FROM challenge_participants cp
    JOIN challenges c ON cp.challenge_id = c.id
    WHERE cp.user_id = ? AND c.status = 'active'
  `).get(userId);
  
  await ctx.replyWithHTML(
    `<b>📊 Ваша статистика</b>\n\n` +
    `⭐ Баллов: ${user.points}\n` +
    `💎 Статус: ${user.is_premium ? 'PREMIUM' : 'FREE'}\n` +
    `🏆 Всего сессий: ${sessions.total || 0}\n` +
    `⏱ Всего времени: ${Math.floor((sessions.total_time || 0) / 60)} часов\n` +
    `💰 Избежано штрафов: $${(sessions.total_penalties || 0).toFixed(2)}\n` +
    `👥 Активных челленджей: ${activeChallenges.count || 0}\n\n` +
    `<b>🏅 Достижения:</b>\n${getAchievementsList(user.points)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('🏆 Лидерборд', 'global_leaderboard')],
      [Markup.button.callback('👥 Мои челленджи', 'my_challenges')]
    ])
  );
});

// Глобальный лидерборд
bot.action('global_leaderboard', async (ctx) => {
  const topUsers = db.prepare(`
    SELECT first_name, username, points FROM users 
    ORDER BY points DESC LIMIT 10
  `).all();
  
  let leaderboard = '<b>🏆 Глобальный рейтинг</b>\n\n';
  topUsers.forEach((user, index) => {
    const medal = index === 0 ? '👑' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index+1}.`;
    leaderboard += `${medal} ${user.first_name || user.username} — ${user.points} ⭐\n`;
  });
  
  await ctx.replyWithHTML(leaderboard);
  await ctx.answerCbQuery();
});

// Вспомогательные функции
function getTimeRemaining(timestamp) {
  const remaining = timestamp - Date.now();
  const days = Math.floor(remaining / (24*60*60*1000));
  const hours = Math.floor((remaining % (24*60*60*1000)) / (60*60*1000));
  return `${days}д ${hours}ч`;
}

function getAchievementsList(points) {
  const achievements = [];
  if (points >= 100) achievements.push('🏅 Новичок');
  if (points >= 500) achievements.push('⭐ Фокус-мастер');
  if (points >= 1000) achievements.push('💎 Легенда фокуса');
  if (points >= 5000) achievements.push('👑 Бог продуктивности');
  return achievements.length ? achievements.join('\n') : 'Пока нет достижений';
}

// ================ ЗАПУСК БОТА ================

bot.launch().then(() => {
  console.log('🤖 FocusBot запущен со всеми функциями!');
  console.log('✅ Штрафы и баллы');
  console.log('✅ Telegram Stars оплата');
  console.log('✅ Групповые челленджи');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
