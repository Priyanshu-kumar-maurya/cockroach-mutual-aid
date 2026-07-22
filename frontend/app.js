/* ==========================================================================
   MUTUAL AID BOARD - CLIENT APPLICATION LOGIC
   Fully supports Express+SQLite backend with seamless mock client-side fallback
   ========================================================================== */

const BACKEND_URL = 'https://cockroach-mutual-aid-backend.onrender.com';

// Global Application State
let state = {
  sessionId: localStorage.getItem('mab_session_id') || null,
  userHash: localStorage.getItem('mab_user_hash') || null,
  isMedicalVerified: localStorage.getItem('mab_is_medical') === 'true',
  networkMode: 'online', // 'online' or 'offline'
  needs: [],
  selectedNeed: null,
  userLocation: { lat: 28.6139, lng: 77.2090 }, // Mock center (New Delhi Area)
  tempSelectedCoords: null, // GPS Picker coordinate placeholder
  photoBeforeBase64: null,
  photoAfterBase64: null,
  medicalCertBase64: null
};

// Maps instance holders
let gpsPickerMap = null;
let gpsPickerMarker = null;
let navigationMap = null;
let navigationMarker = null;

// Mock database to run fully client-side if backend server is unreachable
let mockDatabase = {
  needs: [
    {
      need_id: 'mock_need_1',
      category: 'Medical',
      urgency: 'Emergency',
      description: 'Asthma attack, inhaler needed near Main gate.',
      photo_before: null,
      zone: 'Gate 1 Plaza',
      exact_location: { lat: 28.6145, lng: 77.2095 },
      phone_verified: 1,
      email_verified: 0,
      contact_channel: { type: 'phone', value: '+919999988888' },
      report_count: 0,
      status: 'Open',
      posted_at: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      accepted_by: null
    },
    {
      need_id: 'mock_need_2',
      category: 'Water',
      urgency: 'Urgent',
      description: 'relief camp needs clean drinking water packages.',
      photo_before: null,
      zone: 'Tent Area C',
      exact_location: { lat: 28.6130, lng: 77.2080 },
      phone_verified: 0,
      email_verified: 1,
      contact_channel: { type: 'email', value: 'volunteer@gmail.com' },
      report_count: 0,
      status: 'Open',
      posted_at: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      accepted_by: null
    }
  ],
  helpers: [],
  reports: []
};

// --- INITIALIZATION ---
window.addEventListener('DOMContentLoaded', () => {
  initUI();
  checkSessionStatus();
  refreshBoard();
  startRetentionTimerSimulator();
});

// --- CORE UI CONTROLLERS ---
function initUI() {
  // Screen views navigation
  document.getElementById('nav-board-feed').addEventListener('click', () => {
    if (checkAuth()) {
      showScreen('screen-feed');
      refreshBoard();
    }
  });

  document.getElementById('nav-medical-verify').addEventListener('click', () => {
    if (checkAuth()) showScreen('screen-medical-verify');
  });

  document.getElementById('fab-post-need').addEventListener('click', () => {
    if (checkAuth()) {
      showScreen('screen-post-need');
      initGPSPickerMap();
    }
  });

  document.getElementById('btn-back-to-feed').addEventListener('click', () => showScreen('screen-feed'));
  document.getElementById('btn-back-detail-to-feed').addEventListener('click', () => showScreen('screen-feed'));
  document.getElementById('btn-back-medical-to-feed').addEventListener('click', () => showScreen('screen-feed'));

  // Network mode simulator toggle
  document.getElementById('network-toggle').addEventListener('click', function () {
    const status = this.getAttribute('data-status');
    const dot = this.querySelector('.indicator-dot');
    const label = this.querySelector('.status-label');

    if (status === 'online') {
      this.setAttribute('data-status', 'offline');
      state.networkMode = 'offline';
      dot.className = 'indicator-dot offline';
      label.textContent = 'Offline';
      logToConsole('Network state changed: OFFLINE. Offline caching enabled.', 'warn');
      document.getElementById('offline-queue-banner').classList.remove('hidden');
    } else {
      this.setAttribute('data-status', 'online');
      state.networkMode = 'online';
      dot.className = 'indicator-dot online';
      label.textContent = 'Online';
      logToConsole('Network state changed: ONLINE. Syncing local queue...', 'success');
      document.getElementById('offline-queue-banner').classList.add('hidden');
      syncOfflineQueue();
    }
  });

  // Verification actions
  document.getElementById('btn-request-otp').addEventListener('click', requestOTP);
  document.getElementById('btn-confirm-otp').addEventListener('click', confirmOTP);
  document.getElementById('btn-confirm-proxy').addEventListener('click', confirmProxy);

  // Authentication Quick actions
  document.getElementById('kill-sessions-btn').addEventListener('click', killRemoteSessions);
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Post need submit
  document.getElementById('btn-submit-need').addEventListener('click', submitNeed);

  // GPS Map open toggle
  document.getElementById('btn-open-gps-picker').addEventListener('click', () => {
    const mapDiv = document.getElementById('gps-picker-map');
    mapDiv.classList.toggle('hidden');
    if (!mapDiv.classList.contains('hidden')) {
      setTimeout(() => {
        gpsPickerMap.invalidateSize();
      }, 200);
    }
  });

  // Report need click
  document.getElementById('btn-report-post').addEventListener('click', reportPost);

  // Resolve need
  document.getElementById('btn-submit-resolution').addEventListener('click', resolveNeed);

  // Accept need
  document.getElementById('btn-accept-need').addEventListener('click', acceptNeed);

  // Medical registration
  document.getElementById('btn-submit-medical-helper').addEventListener('click', registerMedicalHelper);

  // Image Upload Canvas Blur handlers
  setupCanvasEditor('photo-before-input', 'btn-select-photo', 'face-blur-editor', 'face-blur-canvas', 'btn-save-face-blur', 'photo-before');
  setupCanvasEditor('photo-after-input', 'btn-select-resolve-photo', 'face-blur-editor-after', 'face-blur-canvas-after', 'btn-save-face-blur-after', 'photo-after');
  
  // Medical Certificate setup (no face blur required, direct base64)
  document.getElementById('btn-select-medical-cert').addEventListener('click', () => document.getElementById('medical-cert-input').click());
  document.getElementById('medical-cert-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      document.getElementById('medical-cert-file-name').textContent = file.name;
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.medicalCertBase64 = ev.target.result;
      };
      reader.readAsDataURL(file);
    }
  });

  // Dashboard Tabs controller
  const tabs = document.querySelectorAll('.tab-btn');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.getAttribute('data-tab');
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById(target).classList.add('active');
      if (target === 'tab-needs' || target === 'tab-helpers' || target === 'tab-reports') {
        loadCoordinatorData();
      }
    });
  });

  // Filter chips
  const chips = document.querySelectorAll('.filter-chip');
  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      chips.forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      renderBoard();
    });
  });
}

function showScreen(screenId) {
  document.querySelectorAll('.mobile-screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  
  // Set title headers based on screens
  const title = document.getElementById('mobile-app-title');
  const sub = document.getElementById('mobile-app-subtitle');
  if (screenId === 'screen-verify') {
    title.textContent = 'Auth verification';
    sub.textContent = 'Anonymous Verification';
  } else if (screenId === 'screen-feed') {
    title.textContent = 'Mutual Aid Board';
    sub.textContent = 'Local Needs Feed';
  } else if (screenId === 'screen-post-need') {
    title.textContent = 'Post request';
    sub.textContent = 'Add Board Ticket';
  } else if (screenId === 'screen-need-detail') {
    title.textContent = 'Need details';
    sub.textContent = 'Action Coordination';
  } else if (screenId === 'screen-medical-verify') {
    title.textContent = 'Helper Verification';
    sub.textContent = 'Medical Routing Credentials';
  }
}

function checkAuth() {
  if (!state.sessionId) {
    showScreen('screen-verify');
    return false;
  }
  return true;
}

// --- LOG CONSOLE HELPERS ---
function logToConsole(message, type = 'info') {
  const consoleEl = document.getElementById('system-log-console');
  const line = document.createElement('div');
  line.className = `log-line ${type}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

// --- RETENTION TIMER SIMULATOR ---
function startRetentionTimerSimulator() {
  // Simulate 30 day verification purging logs
  setInterval(() => {
    logToConsole('[Retention Daemon] Scanning verification store database tables...', 'info');
    // Purge logic runs in SQLite backend, we simulate console message here
    logToConsole('[Retention Daemon] Verified deletion complete. Cleaned all records older than 30 days.', 'success');
  }, 45000);
}

// --- AUTHENTICATION FLOWS ---

// Check session validity at startup
async function checkSessionStatus() {
  if (!state.sessionId) {
    showScreen('screen-verify');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/session/status`, {
      headers: { 'Authorization': state.sessionId }
    });

    if (res.ok) {
      const data = await res.json();
      state.isMedicalVerified = data.isMedicalVerified;
      state.userHash = data.userHash;
      localStorage.setItem('mab_is_medical', state.isMedicalVerified);
      localStorage.setItem('mab_user_hash', state.userHash);
      updateSessionBar();
      showScreen('screen-feed');
      logToConsole(`Active session re-established for user hash: ${state.userHash.substring(0, 10)}...`, 'success');
    } else {
      clearSession();
      showScreen('screen-verify');
    }
  } catch (err) {
    // Server down, run client-side mock auth session checks
    updateSessionBar();
    showScreen('screen-feed');
    logToConsole('Express server unreachable. Loaded local mockup auth session mode.', 'warn');
  }
}

async function requestOTP() {
  const idEl = document.getElementById('verify-identifier');
  const idVal = idEl.value.trim();
  if (!idVal) {
    alert('Please enter a valid phone number or email.');
    return;
  }

  const isEmail = idVal.includes('@');
  const type = isEmail ? 'email' : 'phone';

  try {
    const res = await fetch(`${BACKEND_URL}/api/verify/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, identifier: idVal })
    });

    const data = await res.json();
    document.getElementById('otp-input-area').classList.remove('hidden');
    document.getElementById('demo-otp-code').textContent = data.demoCode || '123456';
    logToConsole(`OTP Requested for ${idVal}. SMS/Email relay logs recorded.`, 'info');
  } catch (e) {
    // Mock OTP Generation offline
    document.getElementById('otp-input-area').classList.remove('hidden');
    const mockCode = Math.floor(100000 + Math.random() * 900000).toString();
    document.getElementById('demo-otp-code').textContent = mockCode;
    // Save locally
    localStorage.setItem('mock_active_otp', JSON.stringify({ id: idVal, code: mockCode }));
    logToConsole(`Backend offline. Generated local mock OTP code: ${mockCode}`, 'warn');
  }
}

async function confirmOTP() {
  const nameVal = document.getElementById('verify-display-name')?.value.trim() || 'Volunteer';
  const idVal = document.getElementById('verify-identifier').value.trim();
  const codeVal = document.getElementById('verify-code').value.trim();

  if (!idVal || !codeVal) return;

  let rawName = nameVal.replace(/ Cockroach$/, '');
  const formattedDisplayName = `${rawName} Cockroach`;

  try {
    const res = await fetch(`${BACKEND_URL}/api/verify/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: idVal.includes('@') ? 'email' : 'phone',
        identifier: idVal,
        code: codeVal,
        deviceinfo: navigator.userAgent
      })
    });

    if (res.ok) {
      const data = await res.json();
      state.sessionId = data.sessionId;
      state.userHash = data.userHash;
      state.isMedicalVerified = false;
      
      localStorage.setItem('mab_user_identifier', formattedDisplayName);
      saveSession();
      updateSessionBar();
      showScreen('screen-feed');
      refreshBoard();
      logToConsole(`OTP verified. Welcome ${formattedDisplayName}! Hash: ${state.userHash}`, 'success');
    } else {
      const err = await res.json();
      alert(err.error);
    }
  } catch (e) {
    const mockData = JSON.parse(localStorage.getItem('mock_active_otp'));
    if (mockData && mockData.id === idVal && mockData.code === codeVal) {
      state.sessionId = 'mock_sess_' + Math.random().toString(36).substring(2, 10);
      
      let hash = 0;
      for (let i = 0; i < idVal.length; i++) {
        hash = (hash << 5) - hash + idVal.charCodeAt(i);
        hash = hash & hash;
      }
      state.userHash = 'usr_mock_' + Math.abs(hash).toString(16);
      state.isMedicalVerified = false;

      localStorage.setItem('mab_user_identifier', formattedDisplayName);
      saveSession();
      updateSessionBar();
      showScreen('screen-feed');
      refreshBoard();
      logToConsole(`[Offline Mock Auth] OTP code verified. Welcome ${formattedDisplayName}!`, 'success');
    } else {
      alert('Invalid OTP code.');
    }
  }
}

async function confirmProxy() {
  const proxyCode = document.getElementById('verify-proxy-name').value.trim();
  if (!proxyCode) return;

  try {
    const res = await fetch(`${BACKEND_URL}/api/verify/coordinator-proxy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proxyName: proxyCode, deviceinfo: navigator.userAgent })
    });

    if (res.ok) {
      const data = await res.json();
      state.sessionId = data.sessionId;
      state.userHash = data.userHash;
      state.isMedicalVerified = false;

      saveSession();
      updateSessionBar();
      showScreen('screen-feed');
      refreshBoard();
      logToConsole(`Coordinator verification proxy confirmed. Hash: ${state.userHash}`, 'success');
    } else {
      alert('Proxy validation failed.');
    }
  } catch (e) {
    // Mock Coordinator proxy
    state.sessionId = 'mock_sess_proxy_' + Math.random().toString(36).substring(2, 10);
    state.userHash = 'usr_mock_proxy_' + Math.random().toString(36).substring(2, 8);
    state.isMedicalVerified = false;

    saveSession();
    updateSessionBar();
    showScreen('screen-feed');
    refreshBoard();
    logToConsole(`[Offline Mock Auth] Coordinator Proxy approved. Hash: ${state.userHash}`, 'success');
  }
}

function saveSession() {
  localStorage.setItem('mab_session_id', state.sessionId);
  localStorage.setItem('mab_user_hash', state.userHash);
  localStorage.setItem('mab_is_medical', state.isMedicalVerified);
}

function clearSession() {
  state.sessionId = null;
  state.userHash = null;
  state.isMedicalVerified = false;
  localStorage.removeItem('mab_session_id');
  localStorage.removeItem('mab_user_hash');
  localStorage.removeItem('mab_is_medical');
  updateSessionBar();
}

function updateSessionBar() {
  const bar = document.getElementById('session-info-bar');
  const badge = document.getElementById('session-user-badge');

  if (state.sessionId) {
    bar.classList.remove('hidden');
    const name = localStorage.getItem('mab_user_identifier') || 'Volunteer Cockroach';
    badge.textContent = `🪳 ${name}`;
  } else {
    bar.classList.add('hidden');
  }
}

async function logout() {
  try {
    await fetch(`${BACKEND_URL}/api/session/logout`, {
      method: 'POST',
      headers: { 'Authorization': state.sessionId }
    });
  } catch (e) {}

  clearSession();
  showScreen('screen-verify');
  logToConsole('Session closed. Local cache authorization credentials cleared.', 'info');
}

async function killRemoteSessions() {
  if (!confirm('Are you sure you want to terminate all other active devices/sessions?')) return;

  try {
    const res = await fetch(`${BACKEND_URL}/api/session/kill-all`, {
      method: 'POST',
      headers: { 'Authorization': state.sessionId }
    });
    const data = await res.json();
    alert(data.message);
    logToConsole('Remote session kill command dispatched to SQLite sessions manager.', 'warn');
  } catch (e) {
    alert('Remote kill successfully simulated. All other active local database handles closed.');
  }
}

// --- GPS PICKER MAP IMPLEMENTATION ---
function initGPSPickerMap() {
  if (gpsPickerMap) return;

  // Set up Leaflet map inside need form picker widget
  // Initialize map centered at current coordinates
  gpsPickerMap = L.map('gps-picker-map').setView([state.userLocation.lat, state.userLocation.lng], 15);
  
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(gpsPickerMap);

  gpsPickerMarker = L.marker([state.userLocation.lat, state.userLocation.lng], { draggable: true }).addTo(gpsPickerMap);
  state.tempSelectedCoords = { lat: state.userLocation.lat, lng: state.userLocation.lng };

  // Update coords status label
  gpsPickerMarker.on('dragend', function (event) {
    const marker = event.target;
    const position = marker.getLatLng();
    state.tempSelectedCoords = { lat: position.lat, lng: position.lng };
    document.getElementById('gps-coords-label').textContent = `📍 Lat: ${position.lat.toFixed(4)}, Lng: ${position.lng.toFixed(4)}`;
  });

  gpsPickerMap.on('click', function(e) {
    gpsPickerMarker.setLatLng(e.latlng);
    state.tempSelectedCoords = { lat: e.latlng.lat, lng: e.latlng.lng };
    document.getElementById('gps-coords-label').textContent = `📍 Lat: ${e.latlng.lat.toFixed(4)}, Lng: ${e.latlng.lng.toFixed(4)}`;
  });
}

// --- NEED RESOLUTION NAVIGATION MAP ---
function initNavigationMap(destination) {
  if (navigationMap) {
    navigationMap.remove();
  }

  document.getElementById('navigation-map').innerHTML = "";
  
  navigationMap = L.map('navigation-map').setView([state.userLocation.lat, state.userLocation.lng], 15);
  
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(navigationMap);

  // Mark volunteer location (Blue Circle)
  L.circleMarker([state.userLocation.lat, state.userLocation.lng], {
    radius: 8,
    color: '#2196F3',
    fillColor: '#2196F3',
    fillOpacity: 1
  }).addTo(navigationMap).bindPopup("You (Helper)");

  // Mark target destination (Red Pin)
  navigationMarker = L.marker([destination.lat, destination.lng]).addTo(navigationMap).bindPopup("Need Location");

  // Draw simple direct connecting route line to simulate routing coordinates
  const latlngs = [
    [state.userLocation.lat, state.userLocation.lng],
    [destination.lat, destination.lng]
  ];
  L.polyline(latlngs, { color: '#e056fd', weight: 4, dashArray: '5, 10' }).addTo(navigationMap);

  // Zoom map to show both markers
  const bounds = L.latLngBounds(latlngs);
  navigationMap.fitBounds(bounds, { padding: [30, 30] });
}

// --- CLIENT-SIDE CANVAS FACE BLUR EDITOR ---
function setupCanvasEditor(fileInputId, selectBtnId, editorWrapperId, canvasId, saveBtnId, stateKey) {
  const fileInput = document.getElementById(fileInputId);
  const selectBtn = document.getElementById(selectBtnId);
  const editorWrapper = document.getElementById(editorWrapperId);
  const canvas = document.getElementById(canvasId);
  const saveBtn = document.getElementById(saveBtnId);
  const ctx = canvas.getContext('2d');
  
  let originalImage = null;

  selectBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Display file name label
    const fileNameEl = document.getElementById(fileInputId === 'photo-before-input' ? 'photo-file-name' : 'photo-after-file-name');
    if (fileNameEl) fileNameEl.textContent = file.name;

    const reader = new FileReader();
    reader.onload = (ev) => {
      originalImage = new Image();
      originalImage.onload = () => {
        // Set canvas constraints
        const maxW = 500;
        const scale = maxW / originalImage.width;
        canvas.width = maxW;
        canvas.height = originalImage.height * scale;
        
        // Draw the image which also strips EXIF metadata immediately by writing to clean canvas buffer
        ctx.drawImage(originalImage, 0, 0, canvas.width, canvas.height);
        
        // Open Editor interface
        editorWrapper.classList.remove('hidden');
      };
      originalImage.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  // Canvas click listener to apply circle blur (simulated TF-Lite face blur selector)
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // Circle parameters
    const blurRadius = 25;

    // Canvas blurring using a radial gradient clip and box-blur simulation
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, blurRadius, 0, Math.PI * 2);
    ctx.clip();
    
    // Draw pixelated or blurred version of the region inside circular clip
    // Simply fetch region, scale it down, scale it back up to get a pixelated censorship effect
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = blurRadius * 2;
    tempCanvas.height = blurRadius * 2;
    const tempCtx = tempCanvas.getContext('2d');
    
    // Draw raw clip area into helper canvas
    tempCtx.drawImage(canvas, x - blurRadius, y - blurRadius, blurRadius * 2, blurRadius * 2, 0, 0, blurRadius * 2, blurRadius * 2);
    
    // Blur style: overlay a dark semi-transparent circle, draw heavy filter
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)'; // Heavy black privacy mask
    ctx.fillRect(x - blurRadius, y - blurRadius, blurRadius * 2, blurRadius * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff9800';
    ctx.stroke();
    
    ctx.restore();
    
    logToConsole(`Privacy Blur applied at canvas coordinate: x=${Math.round(x)}, y=${Math.round(y)}.`, 'info');
  });

  // Save changes
  saveBtn.addEventListener('click', () => {
    // Generate clean base64 image data URL (strips all EXIF headers automatically)
    const filteredBase64 = canvas.toDataURL('image/jpeg', 0.8);
    if (stateKey === 'photo-before') {
      state.photoBeforeBase64 = filteredBase64;
      logToConsole('Need photo verified, EXIF stripped and saved to memory.', 'success');
    } else {
      state.photoAfterBase64 = filteredBase64;
      logToConsole('Resolution proof photo verified, EXIF stripped.', 'success');
    }
    
    editorWrapper.classList.add('hidden');
    alert('Privacy filters applied successfully. Image metadata (EXIF) has been fully stripped.');
  });
}

// --- SUBMIT NEED REQUEST ---
async function submitNeed() {
  const categoryVal = document.querySelector('input[name="category"]:checked').value;
  const urgencyVal = document.querySelector('input[name="urgency"]:checked').value;
  const descVal = document.getElementById('need-description').value.trim();
  const zoneVal = document.getElementById('need-zone').value.trim();

  if (!descVal || !zoneVal) {
    alert('Please enter a description and zone location.');
    return;
  }

  const locationCoords = state.tempSelectedCoords || state.userLocation;

  // Masked contact detail details based on current credentials
  const contactVal = {
    type: 'whatsapp_masked',
    value: state.userHash
  };

  const payload = {
    category: categoryVal,
    urgency: urgencyVal,
    description: descVal,
    photo_before: state.photoBeforeBase64,
    zone: zoneVal,
    exact_location: locationCoords,
    contact_channel: contactVal
  };

  // If network is OFFLINE: Queue request in Local Storage
  if (state.networkMode === 'offline') {
    queueOfflineRequest(payload);
    alert('Post queued locally! The request will sync automatically when network returns.');
    resetPostForm();
    showScreen('screen-feed');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/needs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': state.sessionId
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      logToConsole(`New need request registered on board. Category: ${categoryVal}.`, 'success');
      resetPostForm();
      showScreen('screen-feed');
      refreshBoard();
    } else {
      const err = await res.json();
      alert(`Submission failed: ${err.error}`);
      logToConsole(`Rate limit check blocked post. Count limit exceeded.`, 'danger');
    }
  } catch (err) {
    // Fallback Mock write
    logToConsole('Express Server offline. Writing to mock database.', 'warn');
    const mockPost = {
      need_id: 'mock_need_' + Math.random().toString(36).substring(2, 10),
      category: categoryVal,
      urgency: urgencyVal,
      description: descVal,
      photo_before: state.photoBeforeBase64,
      zone: zoneVal,
      exact_location: locationCoords,
      phone_verified: 1,
      email_verified: 0,
      contact_channel: contactVal,
      report_count: 0,
      status: 'Open',
      posted_at: new Date().toISOString(),
      accepted_by: null,
      user_hash: state.userHash
    };
    mockDatabase.needs.unshift(mockPost);
    resetPostForm();
    showScreen('screen-feed');
    renderBoard();
  }
}

function resetPostForm() {
  document.getElementById('post-need-form').reset();
  document.getElementById('photo-file-name').textContent = "No photo attached";
  document.getElementById('face-blur-editor').classList.add('hidden');
  document.getElementById('gps-picker-map').classList.add('hidden');
  state.photoBeforeBase64 = null;
  state.tempSelectedCoords = null;
}

// --- OFFLINE QUEUE MANAGER ---
function queueOfflineRequest(payload) {
  const queue = JSON.parse(localStorage.getItem('mab_offline_queue')) || [];
  payload.need_id = 'queue_' + Math.random().toString(36).substring(2, 10);
  payload.posted_at = new Date().toISOString();
  payload.status = 'Open';
  queue.push(payload);
  localStorage.setItem('mab_offline_queue', JSON.stringify(queue));
  
  // Show in Banner
  updateOfflineBanner();
  
  // Add to active state so it displays immediately on feed (marked as pending offline)
  state.needs.unshift(payload);
  renderBoard();
}

function updateOfflineBanner() {
  const queue = JSON.parse(localStorage.getItem('mab_offline_queue')) || [];
  const banner = document.getElementById('offline-queue-banner');
  const text = document.getElementById('queue-banner-text');

  if (queue.length > 0) {
    banner.classList.remove('hidden');
    text.textContent = `${queue.length} posts pending sync queue.`;
  } else {
    if (state.networkMode === 'online') {
      banner.classList.add('hidden');
    } else {
      banner.classList.remove('hidden');
      text.textContent = 'Connected Offline. Caching active board.';
    }
  }
}

async function syncOfflineQueue() {
  const queue = JSON.parse(localStorage.getItem('mab_offline_queue')) || [];
  if (queue.length === 0) return;

  logToConsole(`[Offline Sync] Attempting to sync ${queue.length} local posts...`, 'info');
  let successCount = 0;

  for (let i = 0; i < queue.length; i++) {
    const post = queue[i];
    try {
      const res = await fetch(`${BACKEND_URL}/api/needs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': state.sessionId
        },
        body: JSON.stringify(post)
      });
      if (res.ok) successCount++;
    } catch (e) {
      break; // stop trying if backend still fails
    }
  }

  // Remove successful posts from queue
  const remaining = queue.slice(successCount);
  localStorage.setItem('mab_offline_queue', JSON.stringify(remaining));
  updateOfflineBanner();
  refreshBoard();
  
  logToConsole(`[Offline Sync] Successfully synced ${successCount} queued needs to network.`, 'success');
}

// --- FEED RENDERING ---
async function refreshBoard() {
  updateOfflineBanner();
  
  try {
    const headers = {};
    if (state.sessionId) headers['Authorization'] = state.sessionId;

    const res = await fetch(`${BACKEND_URL}/api/needs`, { headers });
    if (res.ok) {
      state.needs = await res.json();
      logToConsole('Board feeds synchronized with Express SQLite backend.', 'success');
    }
  } catch (err) {
    // Backend offline: load mock database feed combined with offline queue
    const queue = JSON.parse(localStorage.getItem('mab_offline_queue')) || [];
    state.needs = [...queue, ...mockDatabase.needs];
    logToConsole('Loading board feed from local indexed cache (offline mockup mode).', 'warn');
  }

  renderBoard();
}

function renderBoard() {
  const listEl = document.getElementById('needs-feed-list');
  listEl.innerHTML = "";

  // Get filter category
  const activeFilter = document.querySelector('.filter-chip.active').getAttribute('data-filter');

  let filtered = state.needs;
  if (activeFilter !== 'all') {
    filtered = state.needs.filter(n => n.category === activeFilter);
  }

  if (filtered.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <p>No active needs found for "${activeFilter}".</p>
      </div>
    `;
    return;
  }

  filtered.forEach(need => {
    const card = document.createElement('div');
    card.className = `feed-card urgency-${need.urgency}`;
    
    // Distance indicator simulation
    let distance = 'Nearby';
    if (need.exact_location) {
      // rough distance calculator logic
      const d = Math.sqrt(Math.pow(need.exact_location.lat - state.userLocation.lat, 2) + Math.pow(need.exact_location.lng - state.userLocation.lng, 2)) * 111;
      distance = `${d.toFixed(2)} km`;
    }

    card.innerHTML = `
      <div class="card-header">
        <span class="card-category">${need.category}</span>
        <span class="card-urgency-badge ${need.urgency.toLowerCase()}">${need.urgency}</span>
      </div>
      <p class="card-body-text">${need.description}</p>
      <div class="card-footer">
        <span>📍 ${need.zone} (${distance})</span>
        <span class="card-status ${need.status}">${need.status}</span>
      </div>
    `;

    card.addEventListener('click', () => openNeedDetails(need.need_id));
    listEl.appendChild(card);
  });
}

// --- OPEN NEED DETAILS ---
function openNeedDetails(needId) {
  // Find need item
  const need = state.needs.find(n => n.need_id === needId);
  if (!need) return;

  state.selectedNeed = need;
  showScreen('screen-need-detail');

  // Fill details
  document.getElementById('detail-category-title').textContent = `${need.category} Request`;
  
  const urgBadge = document.getElementById('detail-urgency-badge');
  urgBadge.className = `detail-urgency-badge ${need.urgency}`;
  urgBadge.textContent = need.urgency;

  document.getElementById('detail-description').textContent = need.description;
  document.getElementById('detail-zone').textContent = need.zone;

  const timestamp = new Date(need.posted_at);
  document.getElementById('detail-timestamp').textContent = `Posted: ${timestamp.toLocaleTimeString()}`;

  // Image Before
  const beforeWrapper = document.getElementById('detail-photo-before-wrapper');
  const beforeImg = document.getElementById('detail-photo-before');
  if (need.photo_before) {
    beforeImg.src = need.photo_before;
    beforeImg.classList.remove('hidden');
  } else {
    beforeImg.classList.add('hidden');
  }

  // Emergency Ambulance Bypass logic
  const bypass = document.getElementById('emergency-bypass-banner');
  if (need.urgency === 'Emergency') {
    bypass.classList.remove('hidden');
  } else {
    bypass.classList.add('hidden');
  }

  // Actions states visibility toggles
  const actOpen = document.getElementById('action-state-open');
  const actAccepted = document.getElementById('action-state-accepted');
  const actResolved = document.getElementById('action-state-resolved');

  actOpen.classList.add('hidden');
  actAccepted.classList.add('hidden');
  actResolved.classList.add('hidden');

  if (need.status === 'Open') {
    actOpen.classList.remove('hidden');
  } else if (need.status === 'Accepted') {
    actAccepted.classList.remove('hidden');
    
    // Initialize Leaflet Routing Map
    // Leaflet requires container to be visible during map load
    setTimeout(() => {
      // Fetch coordinates (could be mock data or real backend redacted)
      const targetCoords = need.exact_location || state.userLocation;
      initNavigationMap(targetCoords);
    }, 100);

    // Setup navigation button coordinates redirect
    const navBtn = document.getElementById('btn-external-navigation');
    if (need.exact_location) {
      navBtn.classList.remove('hidden');
      navBtn.onclick = () => {
        window.open(`https://www.google.com/maps/dir/?api=1&destination=${need.exact_location.lat},${need.exact_location.lng}`, '_blank');
      };
    } else {
      navBtn.classList.add('hidden');
    }

    // Contact Masking button redirect simulations
    const callBtn = document.getElementById('btn-masked-call');
    const waBtn = document.getElementById('btn-masked-whatsapp');
    
    callBtn.onclick = (e) => {
      e.preventDefault();
      alert('Secure call connection started! Calling server proxy at +1 (555) 019-2831. Neither side sees real details.');
      logToConsole('Masked outbound session created. Proxy relay code active.', 'info');
    };

    waBtn.onclick = (e) => {
      e.preventDefault();
      alert('Routing E2EE WhatsApp message via server gateway bridge.');
      logToConsole('Encrypted proxy WhatsApp link created.', 'info');
    };

    // Reset resolution uploads
    document.getElementById('photo-after-file-name').textContent = "No photo attached";
    document.getElementById('face-blur-editor-after').classList.add('hidden');
    state.photoAfterBase64 = null;

  } else if (need.status === 'Resolved') {
    actResolved.classList.remove('hidden');
    document.getElementById('detail-resolved-time').textContent = `Resolved: ${new Date(need.resolved_at).toLocaleTimeString()}`;
    const afterImg = document.getElementById('detail-photo-after');
    if (need.photo_after) {
      afterImg.src = need.photo_after;
      afterImg.classList.remove('hidden');
    } else {
      afterImg.classList.add('hidden');
    }
  }
}

// --- ACCEPT ACTION ---
async function acceptNeed() {
  const need = state.selectedNeed;
  if (!need) return;

  // Medical requirements gate checks
  if (need.category === 'Medical' && !state.isMedicalVerified) {
    alert('Medical requests route exclusively to helpers approved by coordinators. Please submit First-Aid credentials under Register tab first.');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/needs/${need.need_id}/accept`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': state.sessionId
      }
    });

    if (res.ok) {
      logToConsole(`Accepted assist task for Need ID: ${need.need_id.substring(0, 8)}...`, 'success');
      refreshBoard();
      // Reload details view to open map coordinates
      setTimeout(() => {
        openNeedDetails(need.need_id);
      }, 500);
    } else {
      const err = await res.json();
      alert(`Acceptance failed: ${err.error}`);
    }
  } catch (err) {
    // Offline acceptance simulation
    const mockPost = mockDatabase.needs.find(n => n.need_id === need.need_id);
    if (mockPost) {
      mockPost.status = 'Accepted';
      mockPost.accepted_by = state.userHash;
      mockPost.accepted_at = new Date().toISOString();
      logToConsole(`[Offline Mode] Accepted task locally. Pin coordinates unlocked.`, 'success');
      refreshBoard();
      setTimeout(() => {
        openNeedDetails(need.need_id);
      }, 500);
    }
  }
}

// --- RESOLVE NEED WITH PROOF ---
async function resolveNeed() {
  const need = state.selectedNeed;
  if (!need) return;

  if (!state.photoAfterBase64) {
    alert('Mandatory photo proof of resolution is required.');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/needs/${need.need_id}/resolve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': state.sessionId
      },
      body: JSON.stringify({ photo_after: state.photoAfterBase64 })
    });

    if (res.ok) {
      logToConsole(`Resolved task successfully. Verification proof logged.`, 'success');
      refreshBoard();
      showScreen('screen-feed');
    } else {
      const err = await res.json();
      alert(`Resolution failed: ${err.error}`);
    }
  } catch (err) {
    // Offline Resolve mock
    const mockPost = mockDatabase.needs.find(n => n.need_id === need.need_id);
    if (mockPost) {
      mockPost.status = 'Resolved';
      mockPost.photo_after = state.photoAfterBase64;
      mockPost.resolved_at = new Date().toISOString();
      logToConsole(`[Offline Mode] Resolved task locally. Verification saved to client buffer.`, 'success');
      refreshBoard();
      showScreen('screen-feed');
    }
  }
}

// --- REPORT / FLAG METHOD ---
async function reportPost() {
  const need = state.selectedNeed;
  const reasonVal = document.getElementById('report-reason').value;

  if (!need || !reasonVal) {
    alert('Please pick a report reason.');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/needs/${need.need_id}/report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': state.sessionId
      },
      body: JSON.stringify({ reason: reasonVal })
    });

    if (res.ok) {
      const data = await res.json();
      alert(data.autoHidden ? 'Post has been auto-hidden pending coordinator approval.' : 'Post reported successfully.');
      logToConsole(`Flagged report submitted. Weighted index score: ${data.currentWeightedScore}.`, 'warn');
      refreshBoard();
      showScreen('screen-feed');
    } else {
      const err = await res.json();
      alert(err.error);
    }
  } catch (e) {
    // Mock report
    const mockPost = mockDatabase.needs.find(n => n.need_id === need.need_id);
    if (mockPost) {
      mockDatabase.reports.push({
        report_id: 'rep_' + Math.random().toString(36).substring(2, 8),
        need_id: need.need_id,
        reporter_hash: state.userHash,
        reason: reasonVal,
        ip_address: '192.168.1.15',
        subnet: '192.168.1',
        created_at: new Date().toISOString()
      });
      
      const count = mockDatabase.reports.filter(r => r.need_id === need.need_id).length;
      mockPost.report_count = count;

      let score = count; // offline count simple weight
      if (score >= 5) {
        mockPost.status = 'Hidden';
        logToConsole(`[Offline Anti-gaming Check] Post auto-hidden. Distinct reports: ${count}`, 'danger');
        alert('Post auto-hidden after 5 distinct user flags.');
      } else {
        alert('Report logged successfully.');
      }

      refreshBoard();
      showScreen('screen-feed');
    }
  }
}

// --- REGISTER MEDICAL HELPER ---
async function registerMedicalHelper() {
  if (!state.medicalCertBase64) {
    alert('Please attach your first-aid/medical certificate photo proof.');
    return;
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/helper/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': state.sessionId
      },
      body: JSON.stringify({ certificate_photo: state.medicalCertBase64 })
    });

    if (res.ok) {
      alert('Certificate submitted! Coordinator review pending.');
      document.getElementById('medical-status-box').innerHTML = 'Current Status: <strong>Review Pending Approval</strong>';
      logToConsole('Uploaded helper certificate hash. Pending on-ground approval.', 'info');
    } else {
      const err = await res.json();
      alert(err.error);
    }
  } catch (e) {
    // Mock Helper registration
    const existing = mockDatabase.helpers.find(h => h.helper_hash === state.userHash);
    if (!existing) {
      mockDatabase.helpers.push({
        helper_hash: state.userHash,
        is_medical_verified: 0,
        certificate_photo: state.medicalCertBase64,
        created_at: new Date().toISOString()
      });
    }
    alert('Mock submission recorded. You can approve this account in the Admin console tabs.');
    document.getElementById('medical-status-box').innerHTML = 'Current Status: <strong>Review Pending Approval</strong>';
    logToConsole('[Offline Mock helper] Uploaded credentials cache.', 'info');
  }
}

// --- COORDINATOR DASHBOARD METHODS ---
async function loadCoordinatorData() {
  // Update Need and Helper counters
  try {
    const resNeeds = await fetch(`${BACKEND_URL}/api/coordinator/needs`);
    const resHelpers = await fetch(`${BACKEND_URL}/api/coordinator/pending-helpers`);

    if (resNeeds.ok && resHelpers.ok) {
      const needs = await resNeeds.json();
      const helpers = await resHelpers.json();

      document.getElementById('dash-need-count').textContent = needs.length;
      document.getElementById('dash-helper-count').textContent = helpers.length;

      renderDashNeeds(needs);
      renderDashHelpers(helpers);
      renderDashReports(needs);
    }
  } catch (e) {
    // Fallback Mock Coordinator data
    const openCount = mockDatabase.needs.length;
    const helpersCount = mockDatabase.helpers.filter(h => h.is_medical_verified === 0).length;

    document.getElementById('dash-need-count').textContent = openCount;
    document.getElementById('dash-helper-count').textContent = helpersCount;

    renderDashNeeds(mockDatabase.needs);
    renderDashHelpers(mockDatabase.helpers.filter(h => h.is_medical_verified === 0));
    renderDashReports(mockDatabase.needs);
  }
}

function renderDashNeeds(needsList) {
  const tbody = document.getElementById('dash-needs-table-body');
  tbody.innerHTML = "";

  if (needsList.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center">No posts active.</td></tr>';
    return;
  }

  needsList.forEach(need => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${need.category}</strong></td>
      <td><span class="card-urgency-badge ${need.urgency.toLowerCase()}">${need.urgency}</span></td>
      <td>${need.zone}</td>
      <td>${need.report_count || 0}</td>
      <td><span class="card-status ${need.status}">${need.status}</span></td>
      <td>${new Date(need.posted_at).toLocaleTimeString()}</td>
      <td>
        ${need.status === 'Hidden' ? 
          `<button class="btn btn-xs btn-success btn-action" onclick="moderatePost('${need.need_id}', 'Restore')">Restore (Appeal)</button>` : 
          `<button class="btn btn-xs btn-danger btn-action" onclick="moderatePost('${need.need_id}', 'Hide')">Force Hide</button>`
        }
        <button class="btn btn-xs btn-outline-danger btn-action" onclick="moderatePost('${need.need_id}', 'Delete')">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderDashHelpers(helpersList) {
  const list = document.getElementById('pending-helpers-list');
  list.innerHTML = "";

  if (helpersList.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <p>No helper certificates pending coordinator review.</p>
      </div>
    `;
    return;
  }

  helpersList.forEach(helper => {
    const card = document.createElement('div');
    card.className = 'helper-approval-card';
    card.innerHTML = `
      <div class="helper-card-header">Helper: ${helper.helper_hash}</div>
      <img src="${helper.certificate_photo}" class="cert-image-preview" alt="Credential proof photo">
      <div class="comms-buttons">
        <button class="btn btn-success btn-sm btn-block" onclick="approveHelper('${helper.helper_hash}')">Approve Helper</button>
      </div>
    `;
    list.appendChild(card);
  });
}

function renderDashReports(needsList) {
  const tbody = document.getElementById('dash-reports-table-body');
  tbody.innerHTML = "";

  // Combine reports from database mock
  const reports = mockDatabase.reports;
  if (reports.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">No reports flagged recently.</td></tr>';
    return;
  }

  reports.forEach(rep => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rep.need_id.substring(0, 10)}...</td>
      <td><span class="user-badge">${rep.reporter_hash.substring(0, 10)}...</span></td>
      <td><span class="card-urgency-badge emergency">${rep.reason}</span></td>
      <td>${rep.ip_address}</td>
      <td>${rep.subnet}</td>
      <td>${new Date(rep.created_at).toLocaleTimeString()}</td>
    `;
    tbody.appendChild(tr);
  });
}

// Global actions tied to window for inline onclick execution
window.moderatePost = async (needId, action) => {
  try {
    const res = await fetch(`${BACKEND_URL}/api/coordinator/moderate-post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ need_id: needId, action })
    });
    if (res.ok) {
      logToConsole(`Coordinator moderate action successfully completed: ${action} for post ID: ${needId}`, 'success');
      loadCoordinatorData();
      refreshBoard();
    }
  } catch (e) {
    // Mock moderate
    const mockPost = mockDatabase.needs.find(n => n.need_id === needId);
    if (mockPost) {
      if (action === 'Hide') mockPost.status = 'Hidden';
      if (action === 'Restore') mockPost.status = 'Open';
      if (action === 'Delete') {
        mockDatabase.needs = mockDatabase.needs.filter(n => n.need_id !== needId);
      }
      logToConsole(`[Offline Mock Moderator] Action: ${action} performed on post ID: ${needId}`, 'success');
      loadCoordinatorData();
      refreshBoard();
    }
  }
};

window.approveHelper = async (helperHash) => {
  try {
    const res = await fetch(`${BACKEND_URL}/api/coordinator/approve-helper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ helper_hash: helperHash, coordinator_hash: state.userHash })
    });
    if (res.ok) {
      logToConsole(`Helper credentials approved: ${helperHash}`, 'success');
      loadCoordinatorData();
      
      // Update client state if the approved helper is us
      if (state.userHash === helperHash) {
        state.isMedicalVerified = true;
        localStorage.setItem('mab_is_medical', 'true');
        document.getElementById('medical-status-box').innerHTML = 'Current Status: <strong>Verified Helper</strong>';
      }
    }
  } catch (e) {
    // Mock approve
    const mockHelper = mockDatabase.helpers.find(h => h.helper_hash === helperHash);
    if (mockHelper) {
      mockHelper.is_medical_verified = 1;
    }
    logToConsole(`[Offline Mock Moderator] Helper approved: ${helperHash}`, 'success');
    
    if (state.userHash === helperHash) {
      state.isMedicalVerified = true;
      localStorage.setItem('mab_is_medical', 'true');
      document.getElementById('medical-status-box').className = 'alert-box info';
      document.getElementById('medical-status-box').innerHTML = 'Current Status: <strong>Verified Helper</strong>';
    }
    
    loadCoordinatorData();
  }
};

// HTML Sanitizer Helper
function escapeHTML(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// --- PUBLIC CHAT & DIRECT MESSAGING LOGIC ---

// Extended mockDatabase for Chat & DMs
mockDatabase.chat = [
  {
    chat_id: 'chat_mock_1',
    user_hash: 'usr_volunteer_1',
    display_name: 'Priyanshu Cockroach',
    avatar_icon: '🪳',
    message: 'Welcome everyone! Stay safe near the relief camps.',
    linked_need_id: null,
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString()
  },
  {
    chat_id: 'chat_mock_2',
    user_hash: 'usr_volunteer_2',
    display_name: 'Coordinator Cockroach',
    avatar_icon: '🪳',
    message: 'Water packages available at Tent C. Contact if needed.',
    linked_need_id: 'mock_need_2',
    created_at: new Date(Date.now() - 15 * 60 * 1000).toISOString()
  }
];

mockDatabase.dms = [];

let chatPollInterval = null;

// Require authentication check
function requireAuthAction(actionName, callback) {
  if (!state.sessionId || !state.userHash) {
    alert(`🔒 Registration Required!\n\nYou must verify/register via phone or email to ${actionName}. Guest mode is read-only.`);
    showScreen('screen-welcome');
    return false;
  }
  if (callback) callback();
  return true;
}

// Navigation to Public Chat
document.getElementById('nav-public-chat-btn')?.addEventListener('click', () => {
  showScreen('screen-chat');
  initChatView();
});

document.getElementById('btn-back-chat-to-feed')?.addEventListener('click', () => {
  showScreen('screen-feed');
  if (chatPollInterval) clearInterval(chatPollInterval);
});

document.getElementById('btn-back-dm-to-chat')?.addEventListener('click', () => {
  showScreen('screen-chat');
});

document.getElementById('btn-guest-register-chat')?.addEventListener('click', () => {
  showScreen('screen-welcome');
});

function initChatView() {
  const guestBanner = document.getElementById('guest-chat-banner');
  if (!state.sessionId || !state.userHash) {
    guestBanner?.classList.remove('hidden');
  } else {
    guestBanner?.classList.add('hidden');
  }

  fetchChatMessages();
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(fetchChatMessages, 4000);
}

let chatBackendAvailable = true;

async function fetchChatMessages() {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;

  let messages = [];
  if (chatBackendAvailable) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/chat/messages`);
      if (res.ok) {
        messages = await res.json();
      } else if (res.status === 404) {
        chatBackendAvailable = false;
        messages = mockDatabase.chat;
      } else {
        messages = mockDatabase.chat;
      }
    } catch (e) {
      chatBackendAvailable = false;
      messages = mockDatabase.chat;
    }
  } else {
    messages = mockDatabase.chat;
  }

  renderChatMessages(messages);
}

function renderChatMessages(messages) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;

  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No messages yet. Be the first to talk!</p></div>';
    return;
  }

  container.innerHTML = messages.map(msg => {
    const isOwn = msg.user_hash === state.userHash;
    const formattedTime = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    let rawName = (msg.display_name || 'Volunteer').trim();
    if (rawName.endsWith(' Cockroach')) {
      rawName = rawName.replace(/ Cockroach$/, '');
    }
    const displayName = `${rawName} Cockroach`;

    const linkedTag = msg.linked_need_id ? `<a class="linked-need-tag" onclick="viewLinkedNeed('${msg.linked_need_id}')">📍 Linked Need #${msg.linked_need_id.substring(0, 6)}</a>` : '';

    return `
      <div class="chat-bubble ${isOwn ? 'own-message' : ''}">
        <div class="chat-avatar-badge" onclick="openUserProfileModal('${msg.user_hash}', '${displayName.replace(/'/g, "\\'")}')" title="Inspect Cockroach Profile">
          ${msg.avatar_icon || '🪳'}
        </div>
        <div class="chat-bubble-content">
          <div class="chat-author-row">
            <span class="chat-author-name" onclick="openUserProfileModal('${msg.user_hash}', '${displayName.replace(/'/g, "\\'")}')">${displayName}</span>
            <span class="chat-time">${formattedTime}</span>
          </div>
          <div class="chat-message-body">${escapeHTML(msg.message)}</div>
          ${linkedTag}
        </div>
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

document.getElementById('btn-send-chat')?.addEventListener('click', () => {
  sendChatMessage();
});

document.getElementById('chat-input-message')?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

async function sendChatMessage() {
  if (!requireAuthAction('post chat messages')) return;

  const input = document.getElementById('chat-input-message');
  const messageText = input.value.trim();
  if (!messageText) return;

  let rawName = (localStorage.getItem('mab_user_identifier') || 'Volunteer').split('@')[0];
  rawName = rawName.replace(/ Cockroach$/, '');
  const displayName = `${rawName} Cockroach`;

  try {
    const res = await fetch(`${BACKEND_URL}/api/chat/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.sessionId}`
      },
      body: JSON.stringify({
        message: messageText,
        display_name: displayName
      })
    });

    if (res.ok) {
      input.value = '';
      fetchChatMessages();
    } else {
      throw new Error('Failed to send chat');
    }
  } catch (e) {
    const newChat = {
      chat_id: 'chat_' + Math.random().toString(36).substring(2, 9),
      user_hash: state.userHash,
      display_name: displayName,
      avatar_icon: '🪳',
      message: messageText,
      linked_need_id: null,
      created_at: new Date().toISOString()
    };
    mockDatabase.chat.push(newChat);
    input.value = '';
    renderChatMessages(mockDatabase.chat);
  }
}

window.openUserProfileModal = async (targetHash, targetDisplayName) => {
  const modal = document.getElementById('user-profile-modal');
  const nameEl = document.getElementById('profile-display-name');
  const hashEl = document.getElementById('profile-user-hash');

  let rawName = (targetDisplayName || 'Volunteer').trim();
  if (rawName.endsWith(' Cockroach')) {
    rawName = rawName.replace(/ Cockroach$/, '');
  }
  const formattedName = `${rawName} Cockroach`;

  nameEl.innerText = formattedName;
  hashEl.innerText = targetHash ? `${targetHash.substring(0, 14)}...` : 'usr_anon';
  
  modal.classList.remove('hidden');

  const btnStartDm = document.getElementById('btn-start-dm-profile');
  if (btnStartDm) {
    btnStartDm.onclick = () => {
      closeUserProfileModal();
      openDirectMessageScreen(targetHash, formattedName);
    };
  }

  try {
    const res = await fetch(`${BACKEND_URL}/api/user/${targetHash}`);
    if (res.ok) {
      const data = await res.json();
      renderProfileNeeds(data.needsCreated);
    } else {
      renderProfileNeeds(mockDatabase.needs.filter(n => n.user_hash === targetHash));
    }
  } catch (e) {
    renderProfileNeeds(mockDatabase.needs.filter(n => n.user_hash === targetHash));
  }
};

function renderProfileNeeds(needs) {
  const needsListEl = document.getElementById('profile-needs-list');
  if (!needs || needs.length === 0) {
    needsListEl.innerHTML = '<p class="empty-text">No active requests posted.</p>';
    return;
  }
  needsListEl.innerHTML = needs.map(n => `
    <div class="profile-need-item" onclick="closeUserProfileModal(); viewLinkedNeed('${n.need_id}')">
      📍 [${n.urgency}] ${n.category}: ${escapeHTML(n.description.substring(0, 45))}...
    </div>
  `).join('');
}

window.closeUserProfileModal = () => {
  document.getElementById('user-profile-modal')?.classList.add('hidden');
};

document.getElementById('btn-close-profile-modal')?.addEventListener('click', closeUserProfileModal);

let currentDmTargetHash = null;
let currentDmTargetName = null;

function openDirectMessageScreen(targetHash, targetName) {
  if (!requireAuthAction('send direct private messages')) return;

  currentDmTargetHash = targetHash;
  currentDmTargetName = targetName;

  document.getElementById('dm-recipient-title').innerText = `💬 1-on-1 with ${targetName}`;
  showScreen('screen-dm');
  fetchDirectMessages();
}

let dmBackendAvailable = true;

async function fetchDirectMessages() {
  if (!currentDmTargetHash) return;

  let dms = [];
  if (dmBackendAvailable) {
    try {
      const res = await fetch(`${BACKEND_URL}/api/dm/messages/${currentDmTargetHash}`, {
        headers: { 'Authorization': `Bearer ${state.sessionId}` }
      });
      if (res.ok) {
        dms = await res.json();
      } else if (res.status === 404) {
        dmBackendAvailable = false;
        dms = mockDatabase.dms.filter(d => 
          (d.sender_hash === state.userHash && d.receiver_hash === currentDmTargetHash) ||
          (d.sender_hash === currentDmTargetHash && d.receiver_hash === state.userHash)
        );
      } else {
        dms = mockDatabase.dms.filter(d => 
          (d.sender_hash === state.userHash && d.receiver_hash === currentDmTargetHash) ||
          (d.sender_hash === currentDmTargetHash && d.receiver_hash === state.userHash)
        );
      }
    } catch (e) {
      dmBackendAvailable = false;
      dms = mockDatabase.dms.filter(d => 
        (d.sender_hash === state.userHash && d.receiver_hash === currentDmTargetHash) ||
        (d.sender_hash === currentDmTargetHash && d.receiver_hash === state.userHash)
      );
    }
  } else {
    dms = mockDatabase.dms.filter(d => 
      (d.sender_hash === state.userHash && d.receiver_hash === currentDmTargetHash) ||
      (d.sender_hash === currentDmTargetHash && d.receiver_hash === state.userHash)
    );
  }

  renderDirectMessages(dms);
}

function renderDirectMessages(dms) {
  const container = document.getElementById('dm-messages-container');
  if (!container) return;

  if (!dms || dms.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No private messages yet. Send a message to start conversing!</p></div>';
    return;
  }

  container.innerHTML = dms.map(d => {
    const isOwn = d.sender_hash === state.userHash;
    const formattedTime = new Date(d.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="chat-bubble ${isOwn ? 'own-message' : ''}">
        <div class="chat-avatar-badge">🪳</div>
        <div class="chat-bubble-content">
          <div class="chat-author-row">
            <span class="chat-author-name">${d.sender_name || 'Cockroach'}</span>
            <span class="chat-time">${formattedTime}</span>
          </div>
          <div class="chat-message-body">${escapeHTML(d.message)}</div>
        </div>
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

document.getElementById('btn-send-dm')?.addEventListener('click', sendDirectMessage);
document.getElementById('dm-input-message')?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendDirectMessage();
});

async function sendDirectMessage() {
  if (!requireAuthAction('send direct private messages')) return;
  const input = document.getElementById('dm-input-message');
  const text = input.value.trim();
  if (!text || !currentDmTargetHash) return;

  let rawName = (localStorage.getItem('mab_user_identifier') || 'Volunteer').split('@')[0];
  rawName = rawName.replace(/ Cockroach$/, '');
  const senderName = `${rawName} Cockroach`;

  try {
    const res = await fetch(`${BACKEND_URL}/api/dm/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${state.sessionId}`
      },
      body: JSON.stringify({
        receiver_hash: currentDmTargetHash,
        message: text,
        sender_name: senderName
      })
    });

    if (res.ok) {
      input.value = '';
      fetchDirectMessages();
    } else {
      throw new Error('Failed to send DM');
    }
  } catch (e) {
    const newDm = {
      dm_id: 'dm_' + Math.random().toString(36).substring(2, 9),
      sender_hash: state.userHash,
      receiver_hash: currentDmTargetHash,
      sender_name: senderName,
      message: text,
      created_at: new Date().toISOString()
    };
    mockDatabase.dms.push(newDm);
    input.value = '';
    renderDirectMessages(mockDatabase.dms.filter(d => 
      (d.sender_hash === state.userHash && d.receiver_hash === currentDmTargetHash) ||
      (d.sender_hash === currentDmTargetHash && d.receiver_hash === state.userHash)
    ));
  }
}

window.viewLinkedNeed = (needId) => {
  const need = state.needs.find(n => n.need_id === needId) || mockDatabase.needs.find(n => n.need_id === needId);
  if (need) {
    showNeedDetailsModal(need);
  } else {
    alert(`Need #${needId} could not be located.`);
  }
};
