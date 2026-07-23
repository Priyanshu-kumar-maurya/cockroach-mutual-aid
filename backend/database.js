const path = require('path');
const fs = require('fs');

let dbReadyResolve;
const dbReady = new Promise((resolve) => {
  dbReadyResolve = resolve;
});

const isPG = !!process.env.DATABASE_URL;
let db = null;
let pgPool = null;

// Convert SQLite query placeholders (?) to PG placeholders ($1, $2...)
function convertQuery(sql) {
  let index = 1;
  return sql.replace(/\?/g, () => `$${index++}`);
}

const dbQuery = {
  run(sql, params = []) {
    if (isPG) {
      const pgSql = convertQuery(sql);
      return pgPool.query(pgSql, params).then(res => ({ lastID: null, changes: res.rowCount }));
    } else {
      return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
          if (err) reject(err);
          else resolve({ lastID: this.lastID, changes: this.changes });
        });
      });
    }
  },
  get(sql, params = []) {
    if (isPG) {
      const pgSql = convertQuery(sql);
      return pgPool.query(pgSql, params).then(res => res.rows[0] || null);
    } else {
      return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      });
    }
  },
  all(sql, params = []) {
    if (isPG) {
      const pgSql = convertQuery(sql);
      return pgPool.query(pgSql, params).then(res => res.rows);
    } else {
      return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });
    }
  }
};

// Database Initialization
if (isPG) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // Required for cloud databases (Neon/Supabase)
  });
  console.log('Connected to PostgreSQL database.');
  initializeSchemaPG();
} else {
  const sqlite3 = require('sqlite3').verbose();
  const dbPath = process.env.DB_PATH ? path.resolve(__dirname, process.env.DB_PATH) : path.join(__dirname, 'mutual_aid.db');
  
  // Ensure database directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening SQLite database:', err.message);
    } else {
      console.log('Connected to SQLite database at:', dbPath);
      initializeSchemaSQLite();
    }
  });
}

function initializeSchemaSQLite() {
  db.serialize(() => {
    // Needs Table
    db.run(`
      CREATE TABLE IF NOT EXISTS needs (
        need_id TEXT PRIMARY KEY,
        category TEXT CHECK(category IN ('Food', 'Water', 'Medical', 'Shelter', 'Other')),
        urgency TEXT CHECK(urgency IN ('Normal', 'Urgent', 'Emergency')),
        description TEXT NOT NULL,
        photo_before TEXT,
        zone TEXT NOT NULL,
        exact_location TEXT NOT NULL,
        phone_verified INTEGER DEFAULT 0,
        email_verified INTEGER DEFAULT 0,
        contact_channel TEXT,
        report_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Open' CHECK(status IN ('Open', 'Accepted', 'Resolved', 'Hidden')),
        accepted_by TEXT,
        photo_after TEXT,
        posted_at TEXT NOT NULL,
        accepted_at TEXT,
        resolved_at TEXT,
        user_hash TEXT NOT NULL,
        ip_address TEXT
      )
    `);

    // Verifications Table (Auto-deletes after 30 days)
    db.run(`
      CREATE TABLE IF NOT EXISTS verifications (
        verification_id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        type TEXT CHECK(type IN ('phone', 'email', 'coordinator')),
        masked_identifier TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    // Reports Table (Anti-gaming reports check)
    db.run(`
      CREATE TABLE IF NOT EXISTS reports (
        report_id TEXT PRIMARY KEY,
        need_id TEXT NOT NULL,
        reporter_hash TEXT NOT NULL,
        reason TEXT CHECK(reason IN ('Fake', 'Spam', 'Wrong location', 'Inappropriate')),
        ip_address TEXT,
        subnet TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (need_id) REFERENCES needs(need_id)
      )
    `);

    // Active Sessions
    db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        device_info TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      )
    `);

    // Verified Helpers
    db.run(`
      CREATE TABLE IF NOT EXISTS helpers (
        helper_hash TEXT PRIMARY KEY,
        is_medical_verified INTEGER DEFAULT 0,
        certificate_photo TEXT,
        approved_by TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // Public Chat Table
    db.run(`
      CREATE TABLE IF NOT EXISTS public_chat (
        chat_id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_icon TEXT DEFAULT '🪳',
        message TEXT NOT NULL,
        linked_need_id TEXT,
        created_at TEXT NOT NULL
      )
    `);

    // 1-on-1 Direct Messages Table (DM)
    db.run(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        dm_id TEXT PRIMARY KEY,
        sender_hash TEXT NOT NULL,
        receiver_hash TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_read INTEGER DEFAULT 0
      )
    `);

    // Location Audit Logs (Tracks who viewed exact GPS pin & when)
    db.run(`
      CREATE TABLE IF NOT EXISTS location_audit_logs (
        log_id TEXT PRIMARY KEY,
        need_id TEXT NOT NULL,
        viewer_hash TEXT NOT NULL,
        viewed_at TEXT NOT NULL,
        action TEXT NOT NULL
      )
    `, () => {
      console.log('SQLite Database tables initialized successfully.');
      dbReadyResolve();
    });
  });
}

async function initializeSchemaPG() {
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS needs (
        need_id TEXT PRIMARY KEY,
        category TEXT CHECK(category IN ('Food', 'Water', 'Medical', 'Shelter', 'Other')),
        urgency TEXT CHECK(urgency IN ('Normal', 'Urgent', 'Emergency')),
        description TEXT NOT NULL,
        photo_before TEXT,
        zone TEXT NOT NULL,
        exact_location TEXT NOT NULL,
        phone_verified INTEGER DEFAULT 0,
        email_verified INTEGER DEFAULT 0,
        contact_channel TEXT,
        report_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Open' CHECK(status IN ('Open', 'Accepted', 'Resolved', 'Hidden')),
        accepted_by TEXT,
        photo_after TEXT,
        posted_at TEXT NOT NULL,
        accepted_at TEXT,
        resolved_at TEXT,
        user_hash TEXT NOT NULL,
        ip_address TEXT
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS verifications (
        verification_id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        type TEXT CHECK(type IN ('phone', 'email', 'coordinator')),
        masked_identifier TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        report_id TEXT PRIMARY KEY,
        need_id TEXT NOT NULL,
        reporter_hash TEXT NOT NULL,
        reason TEXT CHECK(reason IN ('Fake', 'Spam', 'Wrong location', 'Inappropriate')),
        ip_address TEXT,
        subnet TEXT,
        created_at TEXT NOT NULL
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        device_info TEXT,
        is_active INTEGER DEFAULT 1,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS helpers (
        helper_hash TEXT PRIMARY KEY,
        is_medical_verified INTEGER DEFAULT 0,
        certificate_photo TEXT,
        approved_by TEXT,
        created_at TEXT NOT NULL
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS public_chat (
        chat_id TEXT PRIMARY KEY,
        user_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        avatar_icon TEXT DEFAULT '🪳',
        message TEXT NOT NULL,
        linked_need_id TEXT,
        created_at TEXT NOT NULL
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        dm_id TEXT PRIMARY KEY,
        sender_hash TEXT NOT NULL,
        receiver_hash TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_read INTEGER DEFAULT 0
      )
    `);

    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS location_audit_logs (
        log_id TEXT PRIMARY KEY,
        need_id TEXT NOT NULL,
        viewer_hash TEXT NOT NULL,
        viewed_at TEXT NOT NULL,
        action TEXT NOT NULL
      )
    `);

    console.log('PostgreSQL Database tables initialized successfully.');
    dbReadyResolve();
  } catch (err) {
    console.error('PostgreSQL database initialization failure:', err.message);
  }
}

// --- DATA PROTECTION & UTILITIES ---

async function purgeExpiredVerifications() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await dbQuery.run(
      `DELETE FROM verifications WHERE created_at < ?`,
      [cutoff]
    );
    if (res.changes > 0) {
      console.log(`[CleanUp] Auto-purged ${res.changes} expired verification records (older than 30 days).`);
    }
  } catch (err) {
    console.error('[CleanUp Error] Failed to purge verifications:', err.message);
  }
}

async function checkPostRateLimit(userHash) {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const hourCount = await dbQuery.get(
    `SELECT COUNT(*) as count FROM needs WHERE user_hash = ? AND posted_at > ?`,
    [userHash, oneHourAgo]
  );

  const dayCount = await dbQuery.get(
    `SELECT COUNT(*) as count FROM needs WHERE user_hash = ? AND posted_at > ?`,
    [userHash, oneDayAgo]
  );

  return {
    hourExceeded: (hourCount ? hourCount.count : 0) >= 5,
    dayExceeded: (dayCount ? dayCount.count : 0) >= 20,
    hourCount: hourCount ? hourCount.count : 0,
    dayCount: dayCount ? dayCount.count : 0
  };
}

async function processReport(needId, reporterHash, reason, ipAddress) {
  const subnet = ipAddress ? ipAddress.split('.').slice(0, 3).join('.') : '';
  const reportId = Math.random().toString(36).substring(2, 15);
  const now = new Date().toISOString();

  const existing = await dbQuery.get(
    `SELECT report_id FROM reports WHERE need_id = ? AND reporter_hash = ?`,
    [needId, reporterHash]
  );
  if (existing) {
    throw new Error('You have already reported this post.');
  }

  await dbQuery.run(
    `INSERT INTO reports (report_id, need_id, reporter_hash, reason, ip_address, subnet, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [reportId, needId, reporterHash, reason, ipAddress, subnet, now]
  );

  const allReports = await dbQuery.all(
    `SELECT reporter_hash, ip_address, subnet FROM reports WHERE need_id = ?`,
    [needId]
  );

  let totalScore = 0;
  const subnetCounts = {};
  allReports.forEach(r => {
    if (r.subnet) {
      subnetCounts[r.subnet] = (subnetCounts[r.subnet] || 0) + 1;
    }
  });

  allReports.forEach(r => {
    let weight = 1.0;
    if (r.subnet && subnetCounts[r.subnet] > 1) {
      weight = 1.0 / subnetCounts[r.subnet];
    }
    totalScore += weight;
  });

  totalScore = Math.round(totalScore * 10) / 10;

  await dbQuery.run(
    `UPDATE needs SET report_count = ? WHERE need_id = ?`,
    [allReports.length, needId]
  );

  if (totalScore >= 5) {
    await dbQuery.run(
      `UPDATE needs SET status = 'Hidden' WHERE need_id = ?`,
      [needId]
    );
    return { score: totalScore, hidden: true };
  }

  return { score: totalScore, hidden: false };
}

// --- AES-256 LOCATION ENCRYPTION & UNIQUE HANDLE HELPERS ---
const crypto = require('crypto');
const AES_SECRET_KEY = process.env.LOCATION_AES_KEY || 'cockroach-mutual-aid-aes-key-32b!';
const AES_KEY_BUF = crypto.createHash('sha256').update(AES_SECRET_KEY).digest();

function encryptLocation(locationObj) {
  if (!locationObj) return null;
  const text = typeof locationObj === 'string' ? locationObj : JSON.stringify(locationObj);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', AES_KEY_BUF, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return `enc:${iv.toString('hex')}:${encrypted}`;
}

function decryptLocation(cipherText) {
  if (!cipherText || typeof cipherText !== 'string' || !cipherText.startsWith('enc:')) {
    try {
      return typeof cipherText === 'string' ? JSON.parse(cipherText) : cipherText;
    } catch (e) {
      return cipherText;
    }
  }
  try {
    const parts = cipherText.split(':');
    const iv = Buffer.from(parts[1], 'hex');
    const encryptedText = parts[2];
    const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY_BUF, iv);
    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    try {
      return JSON.parse(decrypted);
    } catch (e) {
      return decrypted;
    }
  } catch (err) {
    console.error('Location decryption failure:', err.message);
    return null;
  }
}

function generateUniqueHandle(rawName, userHash) {
  let cleanName = (rawName || 'Volunteer').trim().replace(/ Cockroach.*$/i, '').replace(/#.*$/, '').trim();
  if (!cleanName) cleanName = 'Volunteer';
  let hashNum = 0;
  const seed = (userHash || 'anon_seed') + cleanName;
  for (let i = 0; i < seed.length; i++) {
    hashNum = (hashNum << 5) - hashNum + seed.charCodeAt(i);
    hashNum = hashNum & hashNum;
  }
  const tag = Math.abs(hashNum).toString(16).toUpperCase().padStart(4, '0').substring(0, 4);
  return `${cleanName}-Cockroach-#${tag}`;
}

module.exports = {
  db,
  dbQuery,
  dbReady,
  purgeExpiredVerifications,
  checkPostRateLimit,
  processReport,
  encryptLocation,
  decryptLocation,
  generateUniqueHandle
};
