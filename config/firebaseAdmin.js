// config/firebaseAdmin.js
const admin = require('firebase-admin');

if (!admin.apps.length) {
  // Preferred: provide credentials via env vars
  // Download the service account JSON from Firebase Console →
  //   Project Settings → Service Accounts → Generate new private key
  // Then set these in your .env file:
  //
  //   FIREBASE_PROJECT_ID=your-project-id
  //   FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@your-project.iam.gserviceaccount.com
  //   FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
  //
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Important: replace literal \n with real newlines
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}

module.exports = admin;