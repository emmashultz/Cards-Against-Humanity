// =============================================================
// FIREBASE CONFIG  —  SETUP REQUIRED (5 minutes, free)
// =============================================================
//
// Before the game can work across networks, you need to plug in your
// own Firebase project's config. Full walkthrough in README.md, quick
// version here:
//
//   1. Go to https://console.firebase.google.com
//   2. Click "Add project", name it anything (e.g. "horrible-cards"),
//      disable Google Analytics, click Create.
//   3. In the project: Build → Realtime Database → Create Database.
//      Pick a location, choose "Start in test mode", Enable.
//   4. Project Settings (gear icon) → scroll to "Your apps" → click
//      the </> (Web) icon. Give it a nickname, skip Hosting, Register.
//   5. Firebase shows you a `firebaseConfig = { ... }` object — copy
//      everything inside the braces.
//   6. Paste it below, replacing the REPLACE_ME object.
//   7. Push to GitHub. Done.
//
// If `databaseURL` isn't in the snippet Firebase shows you, it's:
//   https://<projectId>-default-rtdb.firebaseio.com
//   (or for non-US regions: https://<projectId>-default-rtdb.<region>.firebasedatabase.app)
//
// After 30 days, test-mode rules expire. To keep it working, go to
// Realtime Database → Rules and set them to:
//   { "rules": { ".read": true, ".write": true } }
// (Open access is fine here — data is just ephemeral game state, no PII.)
//
// =============================================================

window.FIREBASE_CONFIG = {
  apiKey: "REPLACE_ME",
  authDomain: "REPLACE_ME.firebaseapp.com",
  databaseURL: "https://REPLACE_ME-default-rtdb.firebaseio.com",
  projectId: "REPLACE_ME",
  storageBucket: "REPLACE_ME.appspot.com",
  messagingSenderId: "REPLACE_ME",
  appId: "REPLACE_ME",
};
