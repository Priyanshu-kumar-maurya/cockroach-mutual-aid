const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH ? path.resolve(__dirname, process.env.DB_PATH) : path.join(__dirname, 'mutual_aid.db');

// Ensure database directory exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let dbReadyResolve;
const dbReady = new Promise((resolve) => {
  dbReadyResolve = resolve;
});

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite database at:', dbPath);
    initializeSchema();
  }
});

function initializeSchema() {
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
        exact_location TEXT NOT NULL, -- JSON string: {lat, lng}
        phone_verified INTEGER DEFAULT 0,
        email_verified INTEGER DEFAULT 0,
        contact_channel TEXT, -- JSON string: {type, value}
        report_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'Open' CHECK(status IN ('Open', 'Accepted', 'Resolved', 'Hidden')),
        accepted_by TEXT, -- helper_hash
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
        masked_identifier TEXT NOT NULL, -- e.g. +91******1234 or a***@gmail.com
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
        subnet TEXT, -- first 3 octets
        created_at TEXT NOT NULL,
        FOREIGN KEY (need_id) REFERENCES needs(need_id)
      )
    `);

    // Active Sessions (Allows remote termination and auto-logout tracking)
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

    // Verified Helpers (Medical needs verified helper lookup)
    db.run(`
      CREATE TABLE IF NOT EXISTS helpers (
        helper_hash TEXT PRIMARY KEY,
        is_medical_verified INTEGER DEFAULT 0,
        certificate_photo TEXT,
        approved_by TEXT, -- coordinator user_hash
        created_at TEXT NOT NULL
      )
    `, () => {
      console.log('Database tables initialized successfully.');
      dbReadyResolve();
    });
  });
}

// Wrap db operations in promises
const dbQuery = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }
};

// --- DATA PROTECTION & UTILITIES ---

// Purge verification data older than 30 days
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

// Rate Limiter Check (max 5 posts/hour, 20/day)
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
    hourExceeded: hourCount.count >= 5,
    dayExceeded: dayCount.count >= 20,
    hourCount: hourCount.count,
    dayCount: dayCount.count
  };
}

// Calculate weighted reports and hide if threshold is met
async function processReport(needId, reporterHash, reason, ipAddress) {
  const subnet = ipAddress ? ipAddress.split('.').slice(0, 3).join('.') : '';
  const reportId = Math.random().toString(36).substring(2, 15);
  const now = new Date().toISOString();

  // Check if this reporter already flagged this need
  const existing = await dbQuery.get(
    `SELECT report_id FROM reports WHERE need_id = ? AND reporter_hash = ?`,
    [needId, reporterHash]
  );
  if (existing) {
    throw new Error('You have already reported this post.');
  }

  // Insert report
  await dbQuery.run(
    `INSERT INTO reports (report_id, need_id, reporter_hash, reason, ip_address, subnet, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [reportId, needId, reporterHash, reason, ipAddress, subnet, now]
  );

  // Recalculate weights
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

module.exports = {
  db,
  dbQuery,
  dbReady,
  purgeExpiredVerifications,
  checkPostRateLimit,
  processReport
};
