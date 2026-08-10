const admin = require('firebase-admin');

// Initialize once
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

// Parse admin UIDs from env (comma-separated)
const ADMIN_UIDS = new Set(
  (process.env.ADMIN_UIDS || '').split(',').map(s => s.trim()).filter(Boolean)
);

// Verify Firebase ID token from Authorization header
exports.verifyFirebaseToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: 'Unauthorized: No token provided' });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    // Inject the REAL verified uid into all the places your controllers expect it
    req.firebase_uid = decoded.uid;
    req.body.firebase_uid = decoded.uid;
    req.query.firebase_uid = decoded.uid;

    // Also attach full user info for convenience
    req.user = {
      uid: decoded.uid,
      email: decoded.email || null,
      name: decoded.name || null,
      isAdmin: ADMIN_UIDS.has(decoded.uid),
    };

    next();
  } catch (error) {
    console.error('Auth error:', error.message);
    return res.status(401).json({ message: 'Unauthorized: Invalid token' });
  }
};

// Optional: restrict to admin UIDs only
exports.requireAdmin = (req, res, next) => {
  if (!req.user?.isAdmin) {
    return res.status(403).json({ message: 'Forbidden: Admin access required' });
  }
  next();
};

// For M-Pesa callbacks or webhooks that can't send Firebase tokens
exports.optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (token) {
      const decoded = await admin.auth().verifyIdToken(token);
      req.firebase_uid = decoded.uid;
      req.body.firebase_uid = decoded.uid;
      req.query.firebase_uid = decoded.uid;
      req.user = {
        uid: decoded.uid,
        email: decoded.email || null,
        name: decoded.name || null,
        isAdmin: ADMIN_UIDS.has(decoded.uid),
      };
    }

    next();
  } catch (error) {
    // Token invalid but route allows anonymous — continue without user
    next();
  }
};