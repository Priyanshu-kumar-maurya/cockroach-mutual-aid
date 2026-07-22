# Cockroach Mutual Aid Board

A real-time, privacy-first mutual aid board app designed for on-ground gatherings (protests, relief camps, community events). This platform allows attendees to post urgent requests and matches them with nearby volunteers while maintaining strict anonymity, location security, and protection against surveillance.

---

## 🔒 Core Privacy & Security Features
- **Anonymous-First Verification**: Verification via phone OTP, email, or a verbal *On-Ground Coordinator Proxy* (bypasses phone/email databases completely). Raw contact data is purged from the database after 30 days.
- **On-Device Canvas Face Blur**: Photos are drawn into a clean Canvas buffer on the client, allowing manual face-blurring before upload. This process completely strips all EXIF metadata.
- **Two-Tier Location Privacy**: The public board shows coarse zones (e.g. "Near Block B Tents"). Precise GPS coordinate pins are hidden on the server and unlock ONLY for the verified volunteer who accepts the request.
- **Anti-Gaming Spam Score**: Flagged reports from the same IP/subnet cluster are dynamically scaled down in weight to prevent malicious mass reporting. Posts auto-hide only after 5+ distinct user report weights.
- **Emergency Ambulance Bypass**: Emergency requests show a prompt "Call 102/Ambulance" bypass banner first to ensure critical safety.
- **Session Protections**: 15-minute inactivity auto-logout and remote session termination controls.

---

## 📂 Tech Stack & Directory Structure
- **Backend API**: Node.js, Express, and SQLite3 database.
- **Frontend App Simulator**: Plain HTML, Vanilla CSS, and JavaScript. Built-in mockup logic allows testing all features client-side if the server is offline.
- **React Native Expo Template**: Native navigation, AsyncStorage queues, and image formatting via `expo-image-manipulator`.

```
mutual-aid-board/
├── backend/            # Express SQLite Server API
├── frontend/           # HTML/CSS/JS Viewport & Coordinator Simulator
├── mobile_rn/          # React Native Cross-Platform Templates
├── docs/               # Privacy Policies & Startup Guides
└── README.md
```

---

## 🚀 Quick Start Guide

### 1. Run the Backend API Server
```bash
cd backend
npm install
npm start
```
The server will run on `http://localhost:5000` and generate the SQLite database file.

### 2. Run the Verification Tests
To check rate limits, purge loops, and report scoring weights:
```bash
cd backend
node tests.js
```

### 3. Open the Client App
Simply double-click or serve the file:
`frontend/index.html`
*(Toggling the offline button inside the client simulates offline queuing and syncs requests once toggled back online.)*
