const { Pool } = require('pg');
const CryptoJS = require('crypto-js');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

function encryptPassword(password) {
  return CryptoJS.AES.encrypt(password, ENCRYPTION_KEY).toString();
}

function decryptPassword(encryptedPassword) {
  const bytes = CryptoJS.AES.decrypt(encryptedPassword, ENCRYPTION_KEY);
  return bytes.toString(CryptoJS.enc.Utf8);
}

async function initDatabase() {
  const client = await pool.connect();
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id BIGINT PRIMARY KEY,
      username VARCHAR(255),
      balance DECIMAL(10,2) DEFAULT 0,
      total_earned DECIMAL(10,2) DEFAULT 0,
      total_withdrawn DECIMAL(10,2) DEFAULT 0,
      referred_by BIGINT,
      referral_code VARCHAR(50) UNIQUE,
      is_banned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      last_active TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS gmails (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT REFERENCES users(telegram_id),
      email VARCHAR(255),
      password TEXT,
      verification_code VARCHAR(10),
      verified BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT NOW(),
      verified_at TIMESTAMP
    )
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT REFERENCES users(telegram_id),
      amount DECIMAL(10,2),
      wallet_address VARCHAR(255),
      transaction_id VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      processed_at TIMESTAMP
    )
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS referral_bonuses (
      id SERIAL PRIMARY KEY,
      referrer_id BIGINT REFERENCES users(telegram_id),
      referee_id BIGINT REFERENCES users(telegram_id),
      amount DECIMAL(10,2),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id SERIAL PRIMARY KEY,
      telegram_id BIGINT REFERENCES users(telegram_id),
      action VARCHAR(50),
      details TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS daily_limits (
      telegram_id BIGINT,
      date DATE DEFAULT CURRENT_DATE,
      count INTEGER DEFAULT 1,
      PRIMARY KEY (telegram_id, date)
    )
  `);
  
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_sessions (
      telegram_id BIGINT PRIMARY KEY,
      session_data JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  client.release();
  console.log('Database initialized');
}

async function checkDailyLimit(telegramId, maxPerDay) {
  const client = await pool.connect();
  const today = new Date().toISOString().split('T')[0];
  
  const result = await client.query(
    `INSERT INTO daily_limits (telegram_id, date, count) 
     VALUES ($1, $2, 1) 
     ON CONFLICT (telegram_id, date) 
     DO UPDATE SET count = daily_limits.count + 1 
     RETURNING count`,
    [telegramId, today]
  );
  
  const currentCount = result.rows[0].count;
  client.release();
  
  return {
    allowed: currentCount <= maxPerDay,
    currentCount: currentCount,
    remaining: Math.max(0, maxPerDay - currentCount)
  };
}

async function logActivity(telegramId, action, details) {
  const client = await pool.connect();
  await client.query(
    'INSERT INTO activity_logs (telegram_id, action, details) VALUES ($1, $2, $3)',
    [telegramId, action, details]
  );
  client.release();
}

async function getMonthlyActiveUsers() {
  const client = await pool.connect();
  const result = await client.query(
    `SELECT COUNT(DISTINCT telegram_id) as mau 
     FROM activity_logs 
     WHERE created_at > NOW() - INTERVAL \'30 days\'`
  );
  client.release();
  return parseInt(result.rows[0].mau);
}

async function saveSession(telegramId, sessionData) {
  const client = await pool.connect();
  await client.query(
    `INSERT INTO user_sessions (telegram_id, session_data, updated_at) 
     VALUES ($1, $2, NOW()) 
     ON CONFLICT (telegram_id) 
     DO UPDATE SET session_data = $2, updated_at = NOW()`,
    [telegramId, JSON.stringify(sessionData)]
  );
  client.release();
}

async function getSession(telegramId) {
  const client = await pool.connect();
  const result = await client.query(
    'SELECT session_data FROM user_sessions WHERE telegram_id = $1',
    [telegramId]
  );
  client.release();
  return result.rows[0] ? JSON.parse(result.rows[0].session_data) : null;
}

async function deleteSession(telegramId) {
  const client = await pool.connect();
  await client.query('DELETE FROM user_sessions WHERE telegram_id = $1', [telegramId]);
  client.release();
}

async function getUserBalance(telegramId) {
  const client = await pool.connect();
  const result = await client.query('SELECT balance FROM users WHERE telegram_id = $1', [telegramId]);
  client.release();
  return result.rows[0] ? parseFloat(result.rows[0].balance) : 0;
}

module.exports = {
  pool,
  initDatabase,
  encryptPassword,
  decryptPassword,
  checkDailyLimit,
  logActivity,
  getMonthlyActiveUsers,
  saveSession,
  getSession,
  deleteSession,
  getUserBalance
};
