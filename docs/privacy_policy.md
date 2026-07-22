# Mutual Aid Board - Privacy & Data Retention Policy

This application is designed specifically for high-risk on-ground environments. Our core architecture prioritizes anonymity, physical safety, and digital tracking resistance.

---

## 1. Anonymous-First Identity Verification
- **Zero Public Identification**: We do not reveal phone numbers, emails, or hardware IDs to any user, coordinator, helper, or database administrator.
- **Hashed Store Lookup**: Verification inputs (phone/email) are converted immediately into a cryptographic user hash. This hash is used to authorize rate limits and trace active sessions.
- **On-Ground Coordinator Verification (Proxy)**: Attendee accounts can be validated by coordinate validation verbal keys. This completely bypasses the need for phone numbers or email relays.

---

## 2. 30-Day Automated Data Purge
- **Automatic Purging Schedule**: A database execution daemon scans the `verifications` table every hour.
- **Verification Expire Rules**: All raw verification linkages matching phone numbers or emails are permanently deleted from database files exactly 30 days after creation. Only the anonymous, unlinkable user hash remains in the system database for history.

---

## 3. Two-Tier Location Protection
- **Public Zone Feed**: General users browsing the feed only see a coarse description of coordinates (e.g. "Near Gate A stage / Area C"). Exact coordinate coordinates are restricted on the server API.
- **Helper Lock Protocol**: The precise GPS coordinate unlocks ONLY for the single volunteer who officially accepts a ticket. 
- **Auto-Lock Restore**: If a task remains unfulfilled or expires, the coordinates lock back on the server database.

---

## 4. Client-Side Image Privacy (Face Blur & EXIF Stripping)
- **Automatic Metadata Scrubbing**: Images are re-drawn into a clean HTML5 Canvas buffer before upload. This process completely strips all EXIF headers (GPS coordinates, camera model, date captured).
- **Manual / Automatic Face Blurring**: Users can touch/click areas of the photo to overlay heavy black privacy blocks on the image, preventing bystander face surveillance.

---

## 5. Masked Communication Proxies
- **In-App Proxy**: Contact URLs (Masked Call / WhatsApp redirect link) route requests through a secure proxy bridge, keeping phone numbers fully private.
- **E2EE Channels**: Communication coordinates are encrypted locally.
