/**
 * Automated test script to verify database constraints, rate limiting, and report weighting rules.
 */
const { dbQuery, dbReady, purgeExpiredVerifications, checkPostRateLimit, processReport } = require('./database');

async function runTests() {
  console.log('--- STARTING MUTUAL AID SYSTEM VERIFICATION TESTS ---');

  try {
    // Wait for the database connection and schema setup to finish
    await dbReady;
    // Test 1: Check Rate Limits logic
    console.log('\n[Test 1] Verifying post rate limit indicators...');
    const userHash = 'test_user_hash_1';

    // Fetch baseline limit check
    let limit = await checkPostRateLimit(userHash);
    console.log(`Baseline Post Counts - Hour: ${limit.hourCount}, Day: ${limit.dayCount}`);
    
    if (limit.hourExceeded || limit.dayExceeded) {
      throw new Error('Baseline rate check should not be exceeded.');
    }
    console.log('✔ Rate limits verified successfully.');

    // Test 2: Purge database cleanup schedules
    console.log('\n[Test 2] Verifying 30-day verification data purging...');
    const now = new Date();
    const oldDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString(); // 31 days ago
    
    // Insert mock expired verification
    await dbQuery.run(
      `INSERT INTO verifications (verification_id, user_hash, type, masked_identifier, created_at)
       VALUES (?, ?, 'phone', '98******12', ?)`
      , ['expired_mock_1', 'user_expired', oldDate]
    );

    // Verify it exists
    let recordBefore = await dbQuery.get(`SELECT * FROM verifications WHERE verification_id = 'expired_mock_1'`);
    if (!recordBefore) throw new Error('Expired mock record failed to insert.');
    console.log('Expired record pre-purge check: Found in database.');

    // Trigger purge
    await purgeExpiredVerifications();

    // Verify it is deleted
    let recordAfter = await dbQuery.get(`SELECT * FROM verifications WHERE verification_id = 'expired_mock_1'`);
    if (recordAfter) throw new Error('Expired verification record was not purged.');
    console.log('✔ 30-day auto-purge rules running successfully.');

    // Test 3: Weighted Anti-Gaming report scoring
    console.log('\n[Test 3] Verifying weighted reporting & gaming resilience...');
    const needId = 'test_reported_post';
    const postTime = new Date().toISOString();

    // Insert mock post to flag
    await dbQuery.run(
      `INSERT INTO needs (need_id, category, urgency, description, zone, exact_location, posted_at, user_hash, status)
       VALUES (?, 'Water', 'Normal', 'Water request test', 'Gate 2', '{"lat":28,"lng":77}', ?, 'owner_hash', 'Open')`,
      [needId, postTime]
    );

    // Submit report 1 (normal user)
    let scoreRes1 = await processReport(needId, 'reporter_1', 'Fake', '192.168.1.10');
    console.log(`Report 1 score (different IP): ${scoreRes1.score}`);

    // Submit report 2 (same subnet as report 1)
    let scoreRes2 = await processReport(needId, 'reporter_2', 'Fake', '192.168.1.15'); // same subnet 192.168.1
    console.log(`Report 2 score (shared subnet cluster 192.168.1): ${scoreRes2.score}`);
    
    // Weight should be shared (1 / 2 reports in subnet = 0.5 each = total score 1.0)
    if (scoreRes2.score > 1.1) {
      throw new Error('Subnet report weight calculation should scale down shared clusters.');
    }
    console.log('Subnet cluster weight scaled down successfully.');

    // Submit reports from distinct IPs to trigger auto-hide threshold (score >= 5)
    await processReport(needId, 'reporter_3', 'Fake', '10.0.0.1');
    await processReport(needId, 'reporter_4', 'Fake', '172.16.0.1');
    await processReport(needId, 'reporter_5', 'Fake', '192.0.2.1');
    let finalScore = await processReport(needId, 'reporter_6', 'Fake', '198.51.100.1');
    
    console.log(`Reports 3-6 score (distinct IPs): ${finalScore.score}`);
    console.log(`Post status after threshold hit: ${finalScore.hidden ? 'Hidden' : 'Open'}`);
    
    // Verify post is now hidden on database
    let postState = await dbQuery.get(`SELECT status FROM needs WHERE need_id = ?`, [needId]);
    if (postState.status !== 'Hidden') {
      throw new Error('Post should be auto-hidden after exceeding weighted threshold.');
    }
    console.log('✔ Weighted reports & automatic hiding verified successfully.');

    // Cleanup mock database entities
    await dbQuery.run(`DELETE FROM needs WHERE need_id = ?`, [needId]);
    await dbQuery.run(`DELETE FROM reports WHERE need_id = ?`, [needId]);

    // TEST 5: Public Chat & Cockroach Name Formatting
    console.log('\n[TEST 5] Testing Public Chat & Cockroach Name Formatting...');
    const chatId = 'chat_test_1';
    const rawName = 'Priyanshu';
    const formattedName = `${rawName} Cockroach`;
    
    await dbQuery.run(
      `INSERT INTO public_chat (chat_id, user_hash, display_name, avatar_icon, message, created_at)
       VALUES (?, ?, ?, '🪳', 'Test message on public chat', ?)`,
      [chatId, 'usr_test_hash', formattedName, new Date().toISOString()]
    );

    const chatRow = await dbQuery.get(`SELECT * FROM public_chat WHERE chat_id = ?`, [chatId]);
    if (!chatRow || chatRow.display_name !== 'Priyanshu Cockroach') {
      throw new Error('Public chat name formatting failed.');
    }
    console.log(`✔ Public Chat verified: Author="${chatRow.display_name}", Avatar="${chatRow.avatar_icon}"`);

    // TEST 6: 1-on-1 Direct Messaging (DM)
    console.log('\n[TEST 6] Testing 1-on-1 Direct Messaging (DM)...');
    const dmId = 'dm_test_1';
    await dbQuery.run(
      `INSERT INTO direct_messages (dm_id, sender_hash, receiver_hash, sender_name, message, created_at)
       VALUES (?, ?, ?, ?, 'Private 1-on-1 help msg', ?)`,
      [dmId, 'usr_sender', 'usr_receiver', 'Volunteer Cockroach', new Date().toISOString()]
    );

    const dmRow = await dbQuery.get(`SELECT * FROM direct_messages WHERE dm_id = ?`, [dmId]);
    if (!dmRow || dmRow.sender_name !== 'Volunteer Cockroach') {
      throw new Error('Direct message storage failed.');
    }
    console.log(`✔ 1-on-1 Direct Message verified: Sender="${dmRow.sender_name}", Receiver="${dmRow.receiver_hash}"`);

    // Clean up test chat data
    await dbQuery.run(`DELETE FROM public_chat WHERE chat_id = ?`, [chatId]);
    await dbQuery.run(`DELETE FROM direct_messages WHERE dm_id = ?`, [dmId]);

    console.log('\n--- ALL VERIFICATION TESTS COMPLETED SUCCESSFULLY ---');
  } catch (err) {
    console.error('\n✖ SYSTEM VERIFICATION FAILED:', err.message);
    process.exit(1);
  }
}

// Run test immediately
runTests();
