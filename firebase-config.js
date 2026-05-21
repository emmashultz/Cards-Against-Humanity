npm install firebase
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

/// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyCThbNxE7wv4RGNz1Ja9X3whdgkxDpSnfM",
  authDomain: "https://horrible-cards-cbbca-default-rtdb.firebaseio.com/",
  projectId: "horrible-cards-cbbca",
  storageBucket: "horrible-cards-cbbca.firebasestorage.app",
  messagingSenderId: "489024099202",
  appId: "1:489024099202:web:c2e61b5724ea89697db59b",
  measurementId: "G-9MZ6P9TZE9"
};
