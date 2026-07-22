# Mutual Aid Board - Local Running & Deployment Guide

Follow these steps to run the Mutual Aid Board App fullstack prototype locally.

---

## 1. Backend Server Setup

### Prerequisites
- Install **Node.js** (v16.0.0 or higher)

### Installation
1. Open a terminal and navigate to the project directory:
   ```bash
   cd mutual-aid-board/backend
   ```
2. Install npm dependencies:
   ```bash
   npm install
   ```

### Running Backend
1. Start the server:
   ```bash
   npm start
   ```
2. The server will launch on port `5000` and initialize a local SQLite file named `mutual_aid.db`.

---

## 2. Frontend Web Interface

The frontend simulator can run directly inside any standard web browser:
1. Open the file `mutual-aid-board/frontend/index.html` in your browser.
2. If the backend is running, the client will connect automatically and synchronize with the SQLite database.
3. **Mock Fallback Mode**: If the Express server is offline, the interface will automatically switch to client-side mockup mode. You can test all features (verification, maps, face blur, coordinator moderation) using mock database arrays saved in `localStorage`.

---

## 3. Running Automated Tests

A test script is provided to verify the rate limits, database operations, and weighted reports:
1. Navigate to the backend directory:
   ```bash
   cd mutual-aid-board/backend
   ```
2. Run tests:
   ```bash
   node tests.js
   ```

---

## 4. Production Deployment Tips

- **SSL Certificates**: Always run behind HTTPS to ensure base64 image streams and session tokens are encrypted in transit.
- **SQLite Optimization**: For heavy production usage, replace the SQLite backend with a PostgreSQL server or Firebase instance.
- **OTP Gateway**: Replace the mock OTP printing console logs inside `server.js` with a Twilio (for SMS) or SendGrid (for email) API integration.
