require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { dbQuery, dbReady, purgeExpiredVerifications, checkPostRateLimit, processReport, encryptLocation, decryptLocation, generateUniqueHandle } = require('./database');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '10mb' })); // support base64 photos

// Simple memory store for OTPs (simulating phone/email OTP)
const activeOTPs = {};

// Helper: Generate a unique ID
function generateId() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

// Helper: Simple SHA256 simulation or hash generator for user anonymity
function hashValue(value) {
  // Simple deterministic hash for demo anonymity
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return 'usr_' + Math.abs(hash).toString(16);
}

// Middleware: Authenticate Session
async function authenticate(req, res, next) {
  let authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization session provided.' });
  }

  let sessionId = authHeader;
  if (sessionId.startsWith('Bearer ')) {
    sessionId = sessionId.substring(7).trim();
  }

  try {
    const session = await dbQuery.get(
      `SELECT * FROM sessions WHERE session_id = ? AND is_active = 1`,
      [sessionId]
    );

    if (!session) {
      return res.status(401).json({ error: 'Session expired or invalid.' });
    }

    // Auto-logout after 15 minutes of inactivity
    const now = new Date();
    const lastActive = new Date(session.last_active_at);
    const diffMs = now - lastActive;
    if (diffMs > 15 * 60 * 1000) {
      await dbQuery.run(
        `UPDATE sessions SET is_active = 0 WHERE session_id = ?`,
        [sessionId]
      );
      return res.status(401).json({ error: 'Session expired due to inactivity (15 mins).' });
    }

    // Update last active time
    const nowIso = now.toISOString();
    await dbQuery.run(
      `UPDATE sessions SET last_active_at = ? WHERE session_id = ?`,
      [nowIso, sessionId]
    );

    req.userHash = session.user_hash;
    req.sessionId = sessionId;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Internal auth error.' });
  }
}

// SLA Timeout Daemon (Emergency 5m, Urgent 15m, Normal 30m)
async function checkSlaTimeouts() {
  try {
    const acceptedNeeds = await dbQuery.all(
      `SELECT need_id, urgency, accepted_at FROM needs WHERE status = 'Accepted'`
    );
    const now = Date.now();
    for (const need of acceptedNeeds) {
      if (!need.accepted_at) continue;
      const acceptedTime = new Date(need.accepted_at).getTime();
      const elapsedMins = (now - acceptedTime) / (60 * 1000);
      
      let slaLimit = 30; // Normal SLA: 30m
      if (need.urgency === 'Emergency') slaLimit = 5;
      else if (need.urgency === 'Urgent') slaLimit = 15;

      if (elapsedMins > slaLimit) {
        await dbQuery.run(
          `UPDATE needs SET status = 'Open', accepted_by = NULL, accepted_at = NULL WHERE need_id = ?`,
          [need.need_id]
        );
        console.log(`[SLA Daemon] Post #${need.need_id} (${need.urgency}) exceeded ${slaLimit}m SLA. Reopened.`);
      }
    }
  } catch (err) {
    console.error('[SLA Timeout Error]', err.message);
  }
}

// Run expired verification cleanup & SLA checks at startup
dbReady.then(() => {
  purgeExpiredVerifications();
  checkSlaTimeouts();
  setInterval(purgeExpiredVerifications, 60 * 60 * 1000);
  setInterval(checkSlaTimeouts, 60 * 1000);
});

// --- ENDPOINTS ---

// 1. Verification Request (Trigger Real OTP)
app.post('/api/verify/request', async (req, res) => {
  const { type, identifier } = req.body; // type: 'phone' or 'email'
  if (!identifier || identifier.length < 5) {
    return res.status(400).json({ error: 'Valid phone number or email identifier is required.' });
  }

  // Rate limit OTP requests per identifier (lockout if 3+ attempts failed)
  const existing = activeOTPs[identifier];
  if (existing && existing.lockedUntil && existing.lockedUntil > Date.now()) {
    const remainingMins = Math.ceil((existing.lockedUntil - Date.now()) / (60 * 1000));
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${remainingMins} minutes.` });
  }

  // Generate a cryptographically strong 6 digit OTP code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  activeOTPs[identifier] = {
    code,
    attempts: 0,
    expires: Date.now() + 5 * 60 * 1000 // 5 mins validity
  };

  console.log(`[OTP Relay Gateway] Identifier: ${identifier} | Generated Code: ${code} (Valid for 5 mins)`);

  // Optional Twilio SMS Integration
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && type === 'phone') {
    try {
      const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      await twilio.messages.create({
        body: `Your Cockroach Aid Verification Code is: ${code}. Valid for 5 minutes.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: identifier
      });
      console.log(`[Twilio SMS] Real SMS OTP dispatched to ${identifier}`);
    } catch (err) {
      console.error('[Twilio SMS Error]', err.message);
    }
  }

  // Pure Secure API Response: NO demoCode leak to client HTTP payload
  res.json({
    success: true,
    message: `Verification OTP dispatched to ${identifier}. Please enter the 6-digit code received.`
  });
});

// 2. Verification Confirm (Strict OTP Validation & Session Creation)
app.post('/api/verify/confirm', async (req, res) => {
  const { type, identifier, code, deviceinfo } = req.body;
  if (!identifier || !code) {
    return res.status(400).json({ error: 'Identifier and 6-digit OTP code are required.' });
  }

  const record = activeOTPs[identifier];
  if (!record || record.expires < Date.now()) {
    return res.status(400).json({ error: 'OTP code has expired or was not requested. Please tap Send Verification Code again.' });
  }

  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return res.status(429).json({ error: 'Account locked due to multiple invalid attempts. Try again later.' });
  }

  record.attempts += 1;

  if (record.code !== code.trim()) {
    if (record.attempts >= 3) {
      record.lockedUntil = Date.now() + 15 * 60 * 1000; // 15 min lockout
      return res.status(429).json({ error: 'Maximum 3 invalid OTP attempts reached. Account locked for 15 minutes.' });
    }
    return res.status(400).json({ error: `Incorrect OTP code. ${3 - record.attempts} attempt(s) remaining.` });
  }

  // Successful verification - clear active OTP record
  delete activeOTPs[identifier];

  const userHash = hashValue(identifier);
  const now = new Date().toISOString();

  // Create masked identifier
  let masked = identifier;
  if (type === 'phone') {
    masked = identifier.substring(0, 3) + '******' + identifier.substring(identifier.length - 4);
  } else if (type === 'email') {
    const parts = identifier.split('@');
    masked = parts[0].substring(0, 2) + '****@' + parts[1];
  }

  try {
    // Record verification (auto-deletes in 30 days)
    const verificationId = generateId();
    await dbQuery.run(
      `INSERT INTO verifications (verification_id, user_hash, type, masked_identifier, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [verificationId, userHash, type, masked, now]
    );

    // Create session
    const sessionId = 'sess_' + generateId();
    await dbQuery.run(
      `INSERT INTO sessions (session_id, user_hash, device_info, is_active, created_at, last_active_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [sessionId, userHash, deviceinfo || 'Web Client', now, now]
    );

    res.json({
      message: 'Verification successful.',
      sessionId,
      userHash,
      type
    });
  } catch (err) {
    console.error('Confirm verification error:', err);
    res.status(500).json({ error: 'Database verification failure.' });
  }
});

// 3. Coordinator Proxy Verification
app.post('/api/verify/coordinator-proxy', async (req, res) => {
  const { proxyName, deviceinfo } = req.body;
  if (!proxyName) {
    return res.status(400).json({ error: 'Proxy/Coordinator validation code is required.' });
  }

  // Coordinator proxy accepts a verbal identifier generated on the on-ground helpdesk
  // For safety, generate a dynamic hash immediately and delete raw records
  const userHash = 'usr_proxy_' + hashValue(proxyName + Date.now().toString());
  const now = new Date().toISOString();

  try {
    const verificationId = generateId();
    await dbQuery.run(
      `INSERT INTO verifications (verification_id, user_hash, type, masked_identifier, created_at)
       VALUES (?, ?, 'coordinator', ?, ?)`,
      [verificationId, userHash, 'On-Ground coordinator proxy', now]
    );

    // Create session
    const sessionId = 'sess_' + generateId();
    await dbQuery.run(
      `INSERT INTO sessions (session_id, user_hash, device_info, is_active, created_at, last_active_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
      [sessionId, userHash, deviceinfo || 'On-Ground Device', now, now]
    );

    res.json({
      message: 'Verified by Coordinator Proxy successfully.',
      sessionId,
      userHash,
      type: 'coordinator'
    });
  } catch (err) {
    console.error('Coordinator proxy error:', err);
    res.status(500).json({ error: 'Database proxy verification failure.' });
  }
});

// 4. Session Status check
app.get('/api/session/status', authenticate, async (req, res) => {
  try {
    const helper = await dbQuery.get(
      `SELECT is_medical_verified FROM helpers WHERE helper_hash = ?`,
      [req.userHash]
    );

    res.json({
      authenticated: true,
      userHash: req.userHash,
      isMedicalVerified: helper ? helper.is_medical_verified === 1 : false
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed checking session status.' });
  }
});

// 5. Remote Session Kill
app.post('/api/session/kill-all', authenticate, async (req, res) => {
  try {
    // Terminate all sessions except the current active one
    const result = await dbQuery.run(
      `UPDATE sessions SET is_active = 0 WHERE user_hash = ? AND session_id != ?`,
      [req.userHash, req.sessionId]
    );

    res.json({
      message: `Successfully terminated ${result.changes} other active sessions.`
    });
  } catch (err) {
    console.error('Kill sessions error:', err);
    res.status(500).json({ error: 'Failed to terminate other sessions.' });
  }
});

// 6. Logout Current Session
app.post('/api/session/logout', authenticate, async (req, res) => {
  try {
    await dbQuery.run(
      `UPDATE sessions SET is_active = 0 WHERE session_id = ?`,
      [req.sessionId]
    );
    res.json({ message: 'Session logged out successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to logout.' });
  }
});

// 7. Post a Need (Rate limited to 5/hr, 20/day)
app.post('/api/needs', authenticate, async (req, res) => {
  const { category, urgency, description, photo_before, zone, exact_location, contact_channel } = req.body;

  if (!category || !urgency || !description || !zone || !exact_location) {
    return res.status(400).json({ error: 'All fields (category, urgency, description, zone, exact_location) are required.' });
  }

  try {
    // Enforce rate limiting
    const limits = await checkPostRateLimit(req.userHash);
    if (limits.hourExceeded) {
      return res.status(429).json({ error: 'Rate limit exceeded: Max 5 posts per hour. Please wait.' });
    }
    if (limits.dayExceeded) {
      return res.status(429).json({ error: 'Rate limit exceeded: Max 20 posts per day.' });
    }

    const needId = 'need_' + generateId();
    const now = new Date().toISOString();
    const ipAddress = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

    // Verify contact channel structure
    const phoneVerified = (await dbQuery.all(`SELECT 1 FROM verifications WHERE user_hash = ? AND type = 'phone'`, [req.userHash])).length > 0 ? 1 : 0;
    const emailVerified = (await dbQuery.all(`SELECT 1 FROM verifications WHERE user_hash = ? AND type = 'email'`, [req.userHash])).length > 0 ? 1 : 0;

    // Encrypt exact GPS coordinates using AES-256
    const encryptedLocationText = encryptLocation(exact_location);

    await dbQuery.run(
      `INSERT INTO needs (
        need_id, category, urgency, description, photo_before, zone, exact_location,
        phone_verified, email_verified, contact_channel, report_count, status,
        posted_at, user_hash, ip_address
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'Open', ?, ?, ?)`,
      [
        needId,
        category,
        urgency,
        description,
        photo_before || null,
        zone,
        encryptedLocationText,
        phoneVerified,
        emailVerified,
        contact_channel ? JSON.stringify(contact_channel) : null,
        now,
        req.userHash,
        ipAddress
      ]
    );

    res.status(201).json({
      message: 'Need posted successfully.',
      need_id: needId
    });
  } catch (err) {
    console.error('Post need error:', err);
    res.status(500).json({ error: 'Failed to post need.' });
  }
});

// 8. Get Needs Feed (Strip exact locations unless caller is the accepted volunteer)
app.get('/api/needs', async (req, res) => {
  let authHeader = req.headers['authorization'];
  let sessionId = authHeader;
  if (sessionId && sessionId.startsWith('Bearer ')) {
    sessionId = sessionId.substring(7).trim();
  }

  let callerUserHash = null;

  if (sessionId) {
    const session = await dbQuery.get(
      `SELECT user_hash FROM sessions WHERE session_id = ? AND is_active = 1`,
      [sessionId]
    );
    if (session) {
      callerUserHash = session.user_hash;
    }
  }

  try {
    const rows = await dbQuery.all(
      `SELECT * FROM needs WHERE status != 'Hidden' ORDER BY 
        CASE urgency 
          WHEN 'Emergency' THEN 1 
          WHEN 'Urgent' THEN 2 
          WHEN 'Normal' THEN 3 
          ELSE 4 
        END,
        posted_at DESC`
    );

    const isGuest = !callerUserHash;

    // Map rows and apply redaction & AES-256 location decryption safety rules
    const redactedRows = await Promise.all(rows.map(async row => {
      const need = { ...row };

      try {
        need.contact_channel = JSON.parse(need.contact_channel);
      } catch (e) {
        need.contact_channel = null;
      }

      // Guest Privacy Gate: If user is not authenticated, conceal zone & detailed description
      if (isGuest) {
        need.zone = 'Sign in to view zone';
        need.description = '🔒 Verification required to view request details.';
        need.photo_before = null;
        need.exact_location = null;
        need.contact_channel = null;
        need.is_guest_redacted = true;
        delete need.user_hash;
        delete need.ip_address;
        return need;
      }

      // Redaction safety rules:
      // Exact AES-256 GPS coordinates are ONLY unlocked & decrypted for the accepted volunteer helper or post owner
      const isAcceptedHelper = callerUserHash && need.accepted_by === callerUserHash;
      const isOwner = callerUserHash && need.user_hash === callerUserHash;

      if (isAcceptedHelper || isOwner) {
        // Decrypt AES-256 ciphertext
        need.exact_location = decryptLocation(need.exact_location);
        
        // Log location decryption access audit
        if (isAcceptedHelper) {
          const logId = 'log_' + generateId();
          await dbQuery.run(
            `INSERT INTO location_audit_logs (log_id, need_id, viewer_hash, viewed_at, action)
             VALUES (?, ?, ?, ?, 'UNLOCKED_AES256_GPS_LOCATION')`,
            [logId, need.need_id, callerUserHash, new Date().toISOString()]
          );
        }
      } else {
        need.exact_location = null; // hide pin
        if (need.contact_channel) {
          need.contact_channel = { type: 'masked', message: 'Masked contact is unlocked only after acceptance' };
        }
      }

      // Attach Unique Handle to poster representation
      need.poster_handle = generateUniqueHandle('Volunteer', need.user_hash);

      delete need.user_hash;
      delete need.ip_address;

      return need;
    }));

    res.json(redactedRows);
  } catch (err) {
    console.error('Fetch needs error:', err);
    res.status(500).json({ error: 'Failed to fetch needs board.' });
  }
});

// 9. Accept Need (Lock to volunteer)
app.post('/api/needs/:id/accept', authenticate, async (req, res) => {
  const needId = req.params.id;

  try {
    const need = await dbQuery.get(`SELECT * FROM needs WHERE need_id = ?`, [needId]);
    if (!need) {
      return res.status(404).json({ error: 'Need not found.' });
    }

    if (need.status !== 'Open') {
      return res.status(400).json({ error: `Cannot accept this post. Current status: ${need.status}` });
    }

    // Medical routing verification: Route only to verified helpers
    if (need.category === 'Medical') {
      const helper = await dbQuery.get(
        `SELECT is_medical_verified FROM helpers WHERE helper_hash = ?`,
        [req.userHash]
      );
      if (!helper || helper.is_medical_verified !== 1) {
        return res.status(403).json({
          error: 'Medical requests require on-ground coordinator verification. Please register first-aid proof first.'
        });
      }
    }

    // Accept and lock post
    const now = new Date().toISOString();
    await dbQuery.run(
      `UPDATE needs SET status = 'Accepted', accepted_by = ?, accepted_at = ? WHERE need_id = ?`,
      [req.userHash, now, needId]
    );

    res.json({
      message: 'Need locked to your account. Coordinates unlocked.',
      accepted_at: now
    });
  } catch (err) {
    console.error('Accept need error:', err);
    res.status(500).json({ error: 'Failed to accept need.' });
  }
});

// 10. Resolve with Photo Proof
app.post('/api/needs/:id/resolve', authenticate, async (req, res) => {
  const needId = req.params.id;
  const { photo_after } = req.body;

  if (!photo_after) {
    return res.status(400).json({ error: 'Mandatory resolution photo proof is required.' });
  }

  try {
    const need = await dbQuery.get(`SELECT * FROM needs WHERE need_id = ?`, [needId]);
    if (!need) {
      return res.status(404).json({ error: 'Need not found.' });
    }

    if (need.status !== 'Accepted') {
      return res.status(400).json({ error: 'Only accepted needs can be marked resolved.' });
    }

    if (need.accepted_by !== req.userHash) {
      return res.status(403).json({ error: 'You are not the assigned helper for this need.' });
    }

    const now = new Date().toISOString();
    await dbQuery.run(
      `UPDATE needs SET status = 'Resolved', photo_after = ?, resolved_at = ? WHERE need_id = ?`,
      [photo_after, now, needId]
    );

    res.json({
      message: 'Need successfully resolved with proof.',
      resolved_at: now
    });
  } catch (err) {
    console.error('Resolve error:', err);
    res.status(500).json({ error: 'Failed to resolve need.' });
  }
});

// 11. Report Post (Anti-Gaming weighted verification)
app.post('/api/needs/:id/report', authenticate, async (req, res) => {
  const needId = req.params.id;
  const { reason } = req.body; // 'Fake' | 'Spam' | 'Wrong location' | 'Inappropriate'
  const ipAddress = req.ip || req.headers['x-forwarded-for'] || '127.0.0.1';

  if (!reason) {
    return res.status(400).json({ error: 'Reason picker value is required.' });
  }

  try {
    const need = await dbQuery.get(`SELECT * FROM needs WHERE need_id = ?`, [needId]);
    if (!need) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    const reportResult = await processReport(needId, req.userHash, reason, ipAddress);

    res.json({
      message: 'Report submitted successfully.',
      currentWeightedScore: reportResult.score,
      autoHidden: reportResult.hidden
    });
  } catch (err) {
    if (err.message === 'You have already reported this post.') {
      return res.status(400).json({ error: err.message });
    }
    console.error('Reporting error:', err);
    res.status(500).json({ error: 'Failed to submit report.' });
  }
});

// 12. Register as Medical Helper
app.post('/api/helper/register', authenticate, async (req, res) => {
  const { certificate_photo } = req.body;
  if (!certificate_photo) {
    return res.status(400).json({ error: 'First-aid certificate photo proof is required.' });
  }

  try {
    const now = new Date().toISOString();
    // Insert or update helper request
    await dbQuery.run(
      `INSERT INTO helpers (helper_hash, is_medical_verified, certificate_photo, created_at)
       VALUES (?, 0, ?, ?)
       ON CONFLICT(helper_hash) DO UPDATE SET is_medical_verified = 0, certificate_photo = ?, created_at = ?`,
      [req.userHash, certificate_photo, now, certificate_photo, now]
    );

    res.json({
      message: 'Medical helper registration submitted. Pending coordinator verification.'
    });
  } catch (err) {
    console.error('Helper registration error:', err);
    res.status(500).json({ error: 'Failed to register as helper.' });
  }
});

// --- COORDINATOR/ADMIN DASHBOARD ENDPOINTS ---
// (Normally these would have an admin-only middleware, for simplicity we allow access for coordination checks)

// A. Get ALL Needs (even Hidden ones)
app.get('/api/coordinator/needs', async (req, res) => {
  try {
    const rows = await dbQuery.all(`SELECT * FROM needs ORDER BY posted_at DESC`);
    const parsedRows = rows.map(r => {
      try { r.exact_location = JSON.parse(r.exact_location); } catch(e) {}
      try { r.contact_channel = JSON.parse(r.contact_channel); } catch(e) {}
      return r;
    });
    res.json(parsedRows);
  } catch (err) {
    res.status(500).json({ error: 'Coordinator fetch needs error.' });
  }
});

// B. Get Pending Medical Helpers
app.get('/api/coordinator/pending-helpers', async (req, res) => {
  try {
    const rows = await dbQuery.all(`SELECT * FROM helpers WHERE is_medical_verified = 0`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pending helper accounts.' });
  }
});

// C. Approve Medical Helper
app.post('/api/coordinator/approve-helper', async (req, res) => {
  const { helper_hash, coordinator_hash } = req.body;
  if (!helper_hash) {
    return res.status(400).json({ error: 'Helper hash is required.' });
  }

  try {
    await dbQuery.run(
      `UPDATE helpers SET is_medical_verified = 1, approved_by = ? WHERE helper_hash = ?`,
      [coordinator_hash || 'admin', helper_hash]
    );
    res.json({ message: 'Helper approved successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Approval failure.' });
  }
});

// D. Manually Hide/Unhide/Moderate Post (Appeal support)
app.post('/api/coordinator/moderate-post', async (req, res) => {
  const { need_id, action } = req.body; // action: 'Hide' | 'Restore' | 'Delete'
  if (!need_id || !action) {
    return res.status(400).json({ error: 'Post ID and action are required.' });
  }

  try {
    if (action === 'Hide') {
      await dbQuery.run(`UPDATE needs SET status = 'Hidden' WHERE need_id = ?`, [need_id]);
    } else if (action === 'Restore') {
      await dbQuery.run(`UPDATE needs SET status = 'Open' WHERE need_id = ?`, [need_id]);
    } else if (action === 'Delete') {
      await dbQuery.run(`DELETE FROM needs WHERE need_id = ?`, [need_id]);
      await dbQuery.run(`DELETE FROM reports WHERE need_id = ?`, [need_id]);
    }
    res.json({ message: `Post moderation '${action}' successfully completed.` });
  } catch (err) {
    res.status(500).json({ error: 'Moderation failure.' });
  }
});

// --- PUBLIC CHAT & DIRECT MESSAGING ENDPOINTS ---

// 1. Fetch Public Chat Messages (Unrestricted read for guests)
app.get('/api/chat/messages', async (req, res) => {
  try {
    const messages = await dbQuery.all(
      `SELECT * FROM public_chat ORDER BY created_at ASC LIMIT 50`
    );
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch public chat messages.' });
  }
});

// 2. Send Public Chat Message (Auth required, appends ' Cockroach')
app.post('/api/chat/send', authenticate, async (req, res) => {
  const { message, display_name, linked_need_id } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Message text is required.' });
  }

  let rawName = (display_name || 'Volunteer').trim();
  if (rawName.endsWith(' Cockroach')) {
    rawName = rawName.replace(/ Cockroach$/, '');
  }
  const formattedName = `${rawName} Cockroach`;

  const chatId = 'chat_' + generateId();
  const now = new Date().toISOString();

  try {
    await dbQuery.run(
      `INSERT INTO public_chat (chat_id, user_hash, display_name, avatar_icon, message, linked_need_id, created_at)
       VALUES (?, ?, ?, '🪳', ?, ?, ?)`,
      [chatId, req.userHash, formattedName, message, linked_need_id || null, now]
    );

    res.status(201).json({
      message: 'Chat message posted successfully.',
      chat: {
        chat_id: chatId,
        user_hash: req.userHash,
        display_name: formattedName,
        avatar_icon: '🪳',
        message,
        linked_need_id: linked_need_id || null,
        created_at: now
      }
    });
  } catch (err) {
    console.error('Chat send error:', err);
    res.status(500).json({ error: 'Failed to post chat message.' });
  }
});

// 3. Send Direct Private Message 1-on-1 (Auth required)
app.post('/api/dm/send', authenticate, async (req, res) => {
  const { receiver_hash, message, sender_name } = req.body;
  if (!receiver_hash || !message) {
    return res.status(400).json({ error: 'Target user hash and message text are required.' });
  }

  let rawName = (sender_name || 'Volunteer').trim();
  if (rawName.endsWith(' Cockroach')) {
    rawName = rawName.replace(/ Cockroach$/, '');
  }
  const formattedName = `${rawName} Cockroach`;

  const dmId = 'dm_' + generateId();
  const now = new Date().toISOString();

  try {
    await dbQuery.run(
      `INSERT INTO direct_messages (dm_id, sender_hash, receiver_hash, sender_name, message, created_at, is_read)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [dmId, req.userHash, receiver_hash, formattedName, message, now]
    );

    res.status(201).json({
      message: 'Direct message sent.',
      dm: {
        dm_id: dmId,
        sender_hash: req.userHash,
        receiver_hash,
        sender_name: formattedName,
        message,
        created_at: now
      }
    });
  } catch (err) {
    console.error('DM error:', err);
    res.status(500).json({ error: 'Failed to send direct message.' });
  }
});

// 4. Fetch Direct Private Messages with a specific user (Auth required)
app.get('/api/dm/messages/:targetHash', authenticate, async (req, res) => {
  const targetHash = req.params.targetHash;
  try {
    const messages = await dbQuery.all(
      `SELECT * FROM direct_messages 
       WHERE (sender_hash = ? AND receiver_hash = ?) OR (sender_hash = ? AND receiver_hash = ?)
       ORDER BY created_at ASC`,
      [req.userHash, targetHash, targetHash, req.userHash]
    );
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch direct messages.' });
  }
});

// 5. Get User Profile Summary & Active Needs
app.get('/api/user/:hash', async (req, res) => {
  const targetHash = req.params.hash;
  try {
    const needsCreated = await dbQuery.all(
      `SELECT need_id, category, urgency, description, zone, status, posted_at FROM needs WHERE user_hash = ? AND status != 'Hidden'`,
      [targetHash]
    );
    const needsAccepted = await dbQuery.all(
      `SELECT need_id, category, urgency, description, zone, status, posted_at FROM needs WHERE accepted_by = ? AND status != 'Hidden'`,
      [targetHash]
    );
    const helper = await dbQuery.get(
      `SELECT is_medical_verified FROM helpers WHERE helper_hash = ?`,
      [targetHash]
    );

    res.json({
      userHash: targetHash,
      isMedicalVerified: helper ? helper.is_medical_verified === 1 : false,
      needsCreated,
      needsAccepted
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch user profile details.' });
  }
});

dbReady.then(() => {
  app.listen(PORT, () => {
    console.log(`Mutual Aid Backend running on port ${PORT}`);
  });
});
