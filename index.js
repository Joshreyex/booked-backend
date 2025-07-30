// Before anything else, load dotenv:
require('dotenv').config();

const admin = require('firebase-admin');

// Build a service account object from env vars
const serviceAccount = {
  project_id: process.env.FIREBASE_PROJECT_ID,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  // Replace literal "\n" sequences with actual newlines:
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Now you can call Firestore:
const db = admin.firestore();