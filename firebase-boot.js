// ================================================================
// firebase-boot.js
// Drop-in Firebase sync with REAL-TIME updates via onSnapshot.
// - On page load: downloads all data from Firestore into localStorage
// - onSnapshot: ANY change in Firestore → immediately updates localStorage
//               AND fires a 'cps-data-updated' event for dashboards
// - On every localStorage write: pushes to Firestore (background)
// - Existing dashboards do NOT need code changes to receive live updates
// ================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ================================================================
// 1. Firebase config
// ================================================================
const firebaseConfig = {
  apiKey: "AIzaSyCbLaMMyURD7j6l84qnbDi9Eaol9oABiVE",
  authDomain: "student-permissions-web.firebaseapp.com",
  projectId: "student-permissions-web",
  storageBucket: "student-permissions-web.firebasestorage.app",
  messagingSenderId: "717967595505",
  appId: "1:717967595505:web:2c3cc66527b23a6b5c1650"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// ================================================================
// 2. localStorage keys we sync
// ================================================================
const SYNCED_KEYS = [
  'cps_students',
  'cps_teachers',
  'cps_hods',
  'cps_security',
  'cps_permissions',
  'cps_gateLog',
  'cps_auditLog'
];

function keyToCollection(key) {
  return key.replace('cps_', '');
}

// Prevent our own writes from bouncing back as remote updates
let suppressRemoteUntil = 0;
function suppressRemoteFor(ms = 800) {
  suppressRemoteUntil = Date.now() + ms;
}

// ================================================================
// 3. Bootstrap: pull from Firestore into localStorage
// ================================================================
async function bootstrapFromFirestore() {
  console.log('%c🔥 Firebase boot: loading data...', 'color:#f59e0b;font-weight:bold;');

  // ⭐ Load students FIRST (dashboards need for photos)
  try {
    const snap = await getDocs(collection(db, 'students'));
    const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (rows.length > 0) {
      localStorage.setItem('cps_students', JSON.stringify(rows));
    } else if (!localStorage.getItem('cps_students')) {
      localStorage.setItem('cps_students', '[]');
    }
    console.log(`  ✓ cps_students: ${rows.length} records`);
  } catch (err) {
    console.warn('  ⚠️ cps_students load failed:', err.message);
  }

  // ⭐ Load rest in PARALLEL
  const otherKeys = ['cps_teachers', 'cps_hods', 'cps_security', 'cps_permissions', 'cps_gateLog', 'cps_auditLog'];
  await Promise.all(otherKeys.map(async (key) => {
    try {
      const colName = keyToCollection(key);
      const snap = await getDocs(collection(db, colName));
      const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (rows.length > 0) {
        localStorage.setItem(key, JSON.stringify(rows));
      } else if (!localStorage.getItem(key)) {
        localStorage.setItem(key, '[]');
      }
      console.log(`  ✓ ${key}: ${rows.length} records`);
    } catch (err) {
      console.warn(`  ⚠️ ${key} load failed:`, err.message);
    }
  }));

  window.CPS_BOOT_DONE = true;
  window.dispatchEvent(new Event('cps-boot-ready'));
  console.log('%c✅ Firebase boot: ready', 'color:#10b981;font-weight:bold;');

  startRealtimeListeners();
}

// ================================================================
// 4. Push to Firestore (background)
// ================================================================
async function pushToFirestore(key, value) {
  try {
    suppressRemoteFor(1200);
    const colName = keyToCollection(key);
    const rows = JSON.parse(value || '[]');

    const snap = await getDocs(collection(db, colName));
    const existingIds = snap.docs.map(d => d.id);
    const newIds = new Set();

    for (const row of rows) {
      let docId = row.id || makeDocId(row);
      newIds.add(docId);
      const { id, ...dataToSave } = row;
      await setDoc(doc(db, colName, docId), dataToSave, { merge: true });
    }

    for (const id of existingIds) {
      if (!newIds.has(id)) {
        await deleteDoc(doc(db, colName, id));
      }
    }
  } catch (err) {
    console.warn('Firestore push failed for', key, err.message);
  }
}

function makeDocId(row) {
  if (row.permissionId) return row.permissionId;
  if (row.regNo) return row.regNo;
  if (row.teacherId) return row.teacherId;
  if (row.hodId) return row.hodId;
  if (row.securityId) return row.securityId;
  return 'doc_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ================================================================
// 5. Hook localStorage.setItem
// ================================================================
const originalSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function(key, value) {
  originalSetItem(key, value);
  if (SYNCED_KEYS.includes(key)) {
    pushToFirestore(key, value).catch(() => {});
  }
};

const originalRemoveItem = localStorage.removeItem.bind(localStorage);
localStorage.removeItem = function(key) {
  originalRemoveItem(key);
  if (SYNCED_KEYS.includes(key)) {
    pushToFirestore(key, '[]').catch(() => {});
  }
};

// ================================================================
// 6. ⭐ REAL-TIME listeners via onSnapshot
//    When another device writes to Firestore, we update localStorage
//    and fire 'cps-data-updated' so pages can refresh their UI.
// ================================================================
let listenersStarted = false;
function startRealtimeListeners() {
  if (listenersStarted) return;
  listenersStarted = true;

  for (const key of SYNCED_KEYS) {
    const colName = keyToCollection(key);
    try {
      onSnapshot(collection(db, colName), (snap) => {
        // Ignore if we just wrote (avoid loop)
        if (Date.now() < suppressRemoteUntil) return;

        const rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const json = JSON.stringify(rows);

        // Only update localStorage if the data actually differs
        const current = localStorage.getItem(key) || '[]';
        if (current !== json) {
          // Use originalSetItem to avoid re-pushing to Firestore
          originalSetItem(key, json);

          // Dispatch event so dashboards can re-render
          window.dispatchEvent(new CustomEvent('cps-data-updated', {
            detail: { key, colName, count: rows.length }
          }));
        }
      }, (err) => {
        console.warn(`onSnapshot error for ${colName}:`, err.message);
      });
    } catch (err) {
      console.warn(`Failed to start listener for ${colName}:`, err.message);
    }
  }

  console.log('%c📡 Real-time listeners active', 'color:#3b82f6;font-weight:bold;');
}

// ================================================================
// 7. Boot sequence
// ================================================================
onAuthStateChanged(auth, async (user) => {
  if (user) {
    await bootstrapFromFirestore();
  }
});

signInAnonymously(auth).catch(err => {
  console.error('Anonymous auth failed:', err);
  window.CPS_BOOT_DONE = true;
  window.dispatchEvent(new Event('cps-boot-ready'));
});

window.CPS_FIREBASE = { db, auth };