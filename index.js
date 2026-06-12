const express = require('express');
const { Telegraf, Markup } = require('telegraf');
require('dotenv').config();
const database = require('./database');
const mailer = require('./mailer');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = process.env.ADMIN_IDS.split(',').map(id => parseInt(id));
const PRICE_PER_GMAIL = 0.30;
const REFERRAL_BONUS = 0.10;
const MIN_WITHDRAWAL = 5.00;
const MAX_GMAILS_PER_DAY = 5;

function generateReferralCode(telegramId) {
  return crypto.createHash('md5').update(`${telegramId}${Date.now()}`).digest('hex').substring(0, 8);
}

function generateRandomString(length, includeSpecial = false) {
  let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  if (includeSpecial) chars += '!@#$%^&*';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

bot.start(async (ctx) => {
  const user = ctx.from;
  const telegramId = user.id;
  const username = user.username || `${user.first_name} ${user.last_name || ''}`.trim();
  
  let referrerId = null;
  if (ctx.startPayload && ctx.startPayload.startsWith('ref_')) {
    const refCode = ctx.startPayload.substring(4);
    const client = await database.pool.connect();
    const result = await client.query('SELECT telegram_id FROM users WHERE referral_code = $1', [refCode]);
    if (result.rows.length > 0 && result.rows[0].telegram_id !== telegramId) {
      referrerId = result.rows[0].telegram_id;
    }
    client.release();
  }
  
  const client = await database.pool.connect();
  const userExists = await client.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  
  if (userExists.rows.length === 0) {
    const referralCode = generateReferralCode(telegramId);
    await client.query(
      'INSERT INTO users (telegram_id, username, referred_by, referral_code) VALUES ($1, $2, $3, $4)',
      [telegramId, username, referrerId, referralCode]
    );
    
    if (referrerId) {
      await client.query(
        'UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE telegram_id = $2',
        [REFERRAL_BONUS, referrerId]
      );
      await client.query(
        'INSERT INTO referral_bonuses (referrer_id, referee_id, amount) VALUES ($1, $2, $3)',
        [referrerId, telegramId, REFERRAL_BONUS]
      );
      await database.logActivity(referrerId, 'referral_bonus', `Referred user ${telegramId}`);
      
      try {
        await bot.telegram.sendMessage(referrerId, `🎉 Someone used your referral link! +$${REFERRAL_BONUS} added.`);
      } catch(e) {}
    }
  }
  
  client.release();
  
  const mau = await database.getMonthlyActiveUsers();
  const balance = await database.getUserBalance(telegramId);
  
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📧 CREATE GMAIL', 'create_gmail')],
    [Markup.button.callback('💰 BALANCE', 'check_balance')],
    [Markup.button.callback('👥 REFERRAL', 'referral_info')],
    [Markup.button.callback('💸 WITHDRAW', 'withdraw_menu')],
    [Markup.button.callback('📊 STATS', 'user_stats')],
    [Markup.button.callback('❓ HELP', 'help_info')]
  ]);
  
  await ctx.reply(
    `🚀 WELCOME ${username.toUpperCase()}!\n\n` +
    `💵 EARN $${PRICE_PER_GMAIL} PER VERIFIED GMAIL\n` +
    `👥 REFERRAL BONUS: $${REFERRAL_BONUS} PER FRIEND\n` +
    `💰 MINIMUM WITHDRAWAL: $${MIN_WITHDRAWAL}\n` +
    `💎 YOUR BALANCE: $${balance.toFixed(2)}\n\n` +
    `📈 ${mau} ACTIVE USERS THIS MONTH\n\n` +
    `⬇️ SELECT OPTION ⬇️`,
    keyboard
  );
});

bot.action('create_gmail', async (ctx) => {
  const telegramId = ctx.from.id;
  
  const client = await database.pool.connect();
  const banned = await client.query('SELECT is_banned FROM users WHERE telegram_id = $1', [telegramId]);
  if (banned.rows[0]?.is_banned) {
    client.release();
    await ctx.answerCbQuery();
    await ctx.reply('❌ YOUR ACCOUNT IS BANNED. CONTACT ADMIN.');
    return;
  }
  client.release();
  
  const limitCheck = await database.checkDailyLimit(telegramId, MAX_GMAILS_PER_DAY);
  
  if (!limitCheck.allowed) {
    await ctx.answerCbQuery();
    await ctx.reply(
      `⏰ DAILY LIMIT REACHED\n\n` +
      `📊 TODAY: ${limitCheck.currentCount}/${MAX_GMAILS_PER_DAY} GMAILS\n` +
      `⏳ RESETS AT MIDNIGHT UTC\n\n` +
      `💡 TRY AGAIN TOMORROW`
    );
    return;
  }
  
  const randomSuffix = generateRandomString(6, false);
  const generatedEmail = `user${telegramId % 10000}${randomSuffix}@gmail.com`;
  const generatedPassword = generateRandomString(14, true);
  const verificationCode = generateRandomString(8, false);
  
  const dbClient = await database.pool.connect();
  const result = await dbClient.query(
    `INSERT INTO gmails (telegram_id, email, password, verification_code) 
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [telegramId, generatedEmail, database.encryptPassword(generatedPassword), verificationCode]
  );
  const gmailId = result.rows[0].id;
  dbClient.release();
  
  await database.saveSession(telegramId, { gmailId, email: generatedEmail });
  
  await ctx.answerCbQuery();
  await ctx.reply(
    `📧 GMAIL ACCOUNT DETAILS\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📧 EMAIL:\n${generatedEmail}\n\n` +
    `🔑 PASSWORD:\n${generatedPassword}\n\n` +
    `🔐 VERIFICATION CODE:\n${verificationCode}\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚠️ INSTRUCTIONS:\n` +
    `1️⃣ GO TO GMAIL.COM\n` +
    `2️⃣ CLICK "CREATE ACCOUNT"\n` +
    `3️⃣ USE THE EXACT EMAIL AND PASSWORD ABOVE\n` +
    `4️⃣ COMPLETE PHONE VERIFICATION\n` +
    `5️⃣ AFTER CREATING, CLICK THE BUTTON BELOW\n\n` +
    `💡 WE WILL SEND A CODE TO YOUR NEW GMAIL`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ I CREATED THE GMAIL', `verify_gmail_${gmailId}`)]
    ])
  );
});

bot.action(/verify_gmail_(\d+)/, async (ctx) => {
  const telegramId = ctx.from.id;
  const gmailId = parseInt(ctx.match[1]);
  
  const client = await database.pool.connect();
  const gmail = await client.query(
    `SELECT email, verification_code FROM gmails 
     WHERE id = $1 AND telegram_id = $2 AND verified = FALSE`,
    [gmailId, telegramId]
  );
  
  if (gmail.rows.length === 0) {
    client.release();
    await ctx.answerCbQuery();
    await ctx.reply('❌ GMAIL NOT FOUND OR ALREADY VERIFIED');
    return;
  }
  
  const email = gmail.rows[0].email;
  const verificationCode = gmail.rows[0].verification_code;
  
  try {
    await mailer.sendVerificationEmail(email, verificationCode);
    await database.saveSession(telegramId, { awaitingCode: gmailId, email, attempts: 0 });
    
    await ctx.answerCbQuery();
    await ctx.reply(
      `✅ VERIFICATION EMAIL SENT!\n\n` +
      `📧 TO: ${email}\n` +
      `🔑 CODE: ${verificationCode}\n\n` +
      `📬 CHECK INBOX OR SPAM FOLDER\n` +
      `⏰ CODE EXPIRES IN 10 MINUTES\n\n` +
      `➡️ TYPE THE 8-DIGIT CODE HERE`
    );
  } catch (error) {
    await ctx.reply(`❌ FAILED TO SEND EMAIL\nERROR: ${error.message}`);
  }
  
  client.release();
});

bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const messageText = ctx.message.text.trim();
  
  const session = await database.getSession(telegramId);
  
  if (session && session.awaitingCode) {
    const gmailId = session.awaitingCode;
    
    const dbClient = await database.pool.connect();
    const gmail = await dbClient.query(
      'SELECT verification_code, email FROM gmails WHERE id = $1',
      [gmailId]
    );
    
    if (gmail.rows.length === 0) {
      await database.deleteSession(telegramId);
      await ctx.reply('❌ SESSION EXPIRED. USE /start');
      dbClient.release();
      return;
    }
    
    if (messageText === gmail.rows[0].verification_code) {
      await dbClient.query(
        'UPDATE gmails SET verified = TRUE, verified_at = NOW() WHERE id = $1',
        [gmailId]
      );
      
      await dbClient.query(
        'UPDATE users SET balance = balance + $1, total_earned = total_earned + $1 WHERE telegram_id = $2',
        [PRICE_PER_GMAIL, telegramId]
      );
      
      await database.logActivity(telegramId, 'gmail_verified', `Email: ${gmail.rows[0].email}`);
      await database.deleteSession(telegramId);
      
      const newBalance = await database.getUserBalance(telegramId);
      
      await ctx.reply(
        `✅ VERIFICATION SUCCESSFUL!\n\n` +
        `💰 +$${PRICE_PER_GMAIL} ADDED\n` +
        `💎 NEW BALANCE: $${newBalance.toFixed(2)}\n\n` +
        `🎯 NEXT WITHDRAWAL: $${(MIN_WITHDRAWAL - newBalance).toFixed(2)} MORE\n\n` +
        `➡️ USE /start TO CREATE MORE`
      );
    } else {
      session.attempts = (session.attempts || 0) + 1;
      
      if (session.attempts >= 3) {
        await database.deleteSession(telegramId);
        await ctx.reply(`❌ TOO MANY FAILED ATTEMPTS (3/3)\n\nUSE /start TO TRY AGAIN`);
      } else {
        await database.saveSession(telegramId, session);
        await ctx.reply(
          `❌ INCORRECT CODE\n\n` +
          `📝 YOU ENTERED: ${messageText}\n` +
          `✅ EXPECTED: ${gmail.rows[0].verification_code}\n\n` +
          `⚠️ ${session.attempts}/3 ATTEMPTS USED`
        );
      }
    }
    
    dbClient.release();
    return;
  }
  
  if (session && session.awaitingWithdraw) {
    const walletRegex = /^[A-Za-z0-9]{34,42}$/;
    if (walletRegex.test(messageText)) {
      const dbClient = await database.pool.connect();
      const balance = await dbClient.query('SELECT balance FROM users WHERE telegram_id = $1', [telegramId]);
      const currentBalance = parseFloat(balance.rows[0].balance);
      
      if (currentBalance >= MIN_WITHDRAWAL) {
        await dbClient.query(
          `INSERT INTO withdrawals (telegram_id, amount, wallet_address, status) 
           VALUES ($1, $2, $3, 'pending')`,
          [telegramId, currentBalance, messageText]
        );
        
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.telegram.sendMessage(adminId, `💰 NEW WITHDRAWAL\nUser: ${telegramId}\nAmount: $${currentBalance.toFixed(2)}\nWallet: ${messageText}`);
          } catch(e) {}
        }
        
        await ctx.reply(
          `✅ WITHDRAWAL REQUEST SUBMITTED\n\n` +
          `💰 AMOUNT: $${currentBalance.toFixed(2)}\n` +
          `📬 WALLET: ${messageText}\n\n` +
          `⏰ PROCESSING: 24-48 HOURS`
        );
      } else {
        await ctx.reply(`❌ INSUFFICIENT BALANCE\nMINIMUM: $${MIN_WITHDRAWAL}\nYOUR BALANCE: $${currentBalance.toFixed(2)}`);
      }
      
      dbClient.release();
      await database.deleteSession(telegramId);
    } else {
      await ctx.reply(
        `❌ INVALID WALLET ADDRESS\n\n` +
        `✅ TRC20 USDT ADDRESS MUST BE:\n` +
        `• 34-42 CHARACTERS\n` +
        `• LETTERS AND NUMBERS ONLY\n\n` +
        `TYPE /start TO CANCEL`
      );
    }
    return;
  }
  
  await ctx.reply('❓ USE /start TO BEGIN');
});

bot.action('check_balance', async (ctx) => {
  const telegramId = ctx.from.id;
  const client = await database.pool.connect();
  const user = await client.query(
    'SELECT balance, total_earned, total_withdrawn FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  client.release();
  
  const balance = parseFloat(user.rows[0].balance);
  
  await ctx.answerCbQuery();
  await ctx.reply(
    `💰 YOUR BALANCE\n\n` +
    `💵 AVAILABLE: $${balance.toFixed(2)}\n` +
    `📈 TOTAL EARNED: $${parseFloat(user.rows[0].total_earned).toFixed(2)}\n` +
    `💸 TOTAL WITHDRAWN: $${parseFloat(user.rows[0].total_withdrawn).toFixed(2)}\n\n` +
    `${balance >= MIN_WITHDRAWAL ? '✅ YOU CAN WITHDRAW NOW!' : `🎯 NEED $${(MIN_WITHDRAWAL - balance).toFixed(2)} MORE`}`,
    Markup.inlineKeyboard([
      [Markup.button.callback('💸 WITHDRAW', 'withdraw_menu')],
      [Markup.button.callback('◀️ BACK', 'back_to_main')]
    ])
  );
});

bot.action('referral_info', async (ctx) => {
  const telegramId = ctx.from.id;
  const client = await database.pool.connect();
  const user = await client.query('SELECT referral_code FROM users WHERE telegram_id = $1', [telegramId]);
  const referrals = await client.query('SELECT COUNT(*) FROM users WHERE referred_by = $1', [telegramId]);
  const bonus = await client.query('SELECT COALESCE(SUM(amount), 0) as total FROM referral_bonuses WHERE referrer_id = $1', [telegramId]);
  client.release();
  
  const refLink = `https://t.me/${ctx.bot.botInfo.username}?start=ref_${user.rows[0].referral_code}`;
  
  await ctx.answerCbQuery();
  await ctx.reply(
    `👥 REFERRAL PROGRAM\n\n` +
    `🔗 YOUR LINK:\n${refLink}\n\n` +
    `👥 REFERRALS: ${referrals.rows[0].count}\n` +
    `💰 TOTAL BONUS: $${parseFloat(bonus.rows[0].total).toFixed(2)}\n` +
    `💵 BONUS PER REFERRAL: $${REFERRAL_BONUS}`,
    Markup.inlineKeyboard([
      [Markup.button.url('📤 SHARE LINK', `https://t.me/share/url?url=${refLink}&text=Join%20this%20bot%20to%20earn%20money%20by%20creating%20Gmail%20accounts%21`)],
      [Markup.button.callback('◀️ BACK', 'back_to_main')]
    ])
  );
});

bot.action('withdraw_menu', async (ctx) => {
  const telegramId = ctx.from.id;
  const balance = await database.getUserBalance(telegramId);
  
  if (balance < MIN_WITHDRAWAL) {
    await ctx.answerCbQuery();
    await ctx.reply(
      `❌ INSUFFICIENT BALANCE\n\n` +
      `💰 YOUR BALANCE: $${balance.toFixed(2)}\n` +
      `🎯 MINIMUM: $${MIN_WITHDRAWAL}\n` +
      `✅ NEEDED: $${(MIN_WITHDRAWAL - balance).toFixed(2)}\n\n` +
      `📧 CREATE ${Math.ceil((MIN_WITHDRAWAL - balance) / PRICE_PER_GMAIL)} MORE GMAILS`,
      Markup.inlineKeyboard([[Markup.button.callback('◀️ BACK', 'back_to_main')]])
    );
  } else {
    await database.saveSession(telegramId, { awaitingWithdraw: true });
    await ctx.answerCbQuery();
    await ctx.reply(
      `💸 WITHDRAWAL REQUEST\n\n` +
      `💵 AVAILABLE: $${balance.toFixed(2)}\n` +
      `💸 WILL WITHDRAW: $${balance.toFixed(2)}\n\n` +
      `⚠️ SEND YOUR TRC20 USDT ADDRESS\n` +
      `📍 ADDRESS: 34-42 CHARACTERS\n` +
      `⏰ PROCESSING: 24-48 HOURS\n\n` +
      `➡️ TYPE YOUR WALLET ADDRESS NOW`
    );
  }
});

bot.action('user_stats', async (ctx) => {
  const telegramId = ctx.from.id;
  const client = await database.pool.connect();
  
  const gmails = await client.query('SELECT COUNT(*) FROM gmails WHERE telegram_id = $1 AND verified = TRUE', [telegramId]);
  const referrals = await client.query('SELECT COUNT(*) FROM users WHERE referred_by = $1', [telegramId]);
  const weekly = await client.query(
    `SELECT DATE(verified_at) as date, COUNT(*) as count
     FROM gmails
     WHERE telegram_id = $1 AND verified = TRUE AND verified_at > NOW() - INTERVAL '7 days'
     GROUP BY DATE(verified_at)
     ORDER BY date DESC`,
    [telegramId]
  );
  const user = await client.query('SELECT balance, total_earned FROM users WHERE telegram_id = $1', [telegramId]);
  
  client.release();
  
  const weeklyText = weekly.rows.map(r => `📅 ${new Date(r.date).toLocaleDateString()}: ${r.count} GMAILS`).join('\n') || '📭 NO ACTIVITY';
  
  await ctx.answerCbQuery();
  await ctx.reply(
    `📊 YOUR STATISTICS\n\n` +
    `✅ TOTAL GMAILS: ${gmails.rows[0].count}\n` +
    `👥 TOTAL REFERRALS: ${referrals.rows[0].count}\n` +
    `💰 BALANCE: $${parseFloat(user.rows[0].balance).toFixed(2)}\n` +
    `📈 TOTAL EARNED: $${parseFloat(user.rows[0].total_earned).toFixed(2)}\n\n` +
    `📆 LAST 7 DAYS:\n${weeklyText}`,
    Markup.inlineKeyboard([[Markup.button.callback('◀️ BACK', 'back_to_main')]])
  );
});

bot.action('help_info', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `❓ HELP & FAQ\n\n` +
    `📧 HOW TO CREATE GMAIL?\n` +
    `1. CLICK "CREATE GMAIL"\n` +
    `2. COPY EMAIL & PASSWORD\n` +
    `3. GO TO GMAIL.COM\n` +
    `4. CREATE ACCOUNT\n` +
    `5. CLICK "I CREATED THE GMAIL"\n` +
    `6. ENTER CODE SENT TO THAT GMAIL\n\n` +
    `💰 PAYMENT: $${PRICE_PER_GMAIL} PER GMAIL\n` +
    `💸 WITHDRAWAL: $${MIN_WITHDRAWAL} MINIMUM\n` +
    `⚠️ LIMIT: ${MAX_GMAILS_PER_DAY} GMAILS PER DAY`,
    Markup.inlineKeyboard([[Markup.button.callback('◀️ BACK', 'back_to_main')]])
  );
});

bot.action('back_to_main', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.start();
});

app.post('/webhook', async (req, res) => {
  try {
    await bot.handleUpdate(req.body);
    res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).send('Error');
  }
});

app.get('/health', (req, res) => {
  res.send('Bot is running');
});

async function startBot() {
  await database.initDatabase();
  await bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}/webhook`);
  console.log(`Webhook set to: ${process.env.WEBHOOK_URL}/webhook`);
  console.log(`Bot started! Price: $${PRICE_PER_GMAIL}/Gmail`);
}

startBot();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
