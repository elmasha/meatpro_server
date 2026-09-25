// middleware/adminAuth.js
const db = require('../config/db');
const admin = require('../config/firebaseAdmin');

/**
 * Verify the caller's Firebase ID token, then load their admin row.
 * Reads: Authorization: Bearer <idToken>
 * Sets:  req.admin = { id, uid, name, email, phone, role }
 */
exports.requireAdmin = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      return res.status(401).json({
        error: 'Authentication required. Provide Authorization: Bearer <idToken>.'
      });
    }

    // 1. Verify token with Firebase
    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(token);
    } catch (e) {
      console.warn('[requireAdmin] invalid token:', e.code || e.message);
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const firebaseUid = decoded.uid;

    // 2. Load the user row
    const [rows] = await db.promise().query(
      `SELECT id, firebase_uid, name, email, phone, is_admin, admin_role
         FROM users
        WHERE firebase_uid = ?
        LIMIT 1`,
      [firebaseUid]
    );

    if (!rows.length) {
      return res.status(401).json({ error: 'User not found' });
    }

    const u = rows[0];

    if (!u.is_admin || !u.admin_role) {
      return res.status(403).json({ error: 'Admin access required' });
    }

    // 3. Attach normalised admin object
    req.admin = {
      id: u.id,
      uid: u.firebase_uid,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.admin_role, // 'viewer' | 'admin' | 'super_admin'
    };
    req.firebaseUid = u.firebase_uid;

    next();
  } catch (err) {
    console.error('[requireAdmin]', err);
    res.status(500).json({ error: err.message });
  }
};

/**
 * Role gate. Use after requireAdmin.
 */
exports.requireRole = (...roles) => (req, res, next) => {
  if (!req.admin) {
    return res.status(401).json({ error: 'requireAdmin must run first' });
  }
  if (!roles.includes(req.admin.role)) {
    return res.status(403).json({
      error: `Requires role: ${roles.join(' or ')}. You are: ${req.admin.role}`
    });
  }
  next();
};

/**
 * Write a row into admin_audit_log. Fire-and-forget.
 */
exports.audit = async ({
  admin,
  action,
  targetType,
  targetId,
  payload,
  changeRequestId = null,
  req,
}) => {
  try {
    await db.promise().query(
      `INSERT INTO admin_audit_log
         (admin_uid, admin_email, action, target_type, target_id,
          payload, change_request_id, ip_address, user_agent)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        admin?.uid || 'unknown',
        admin?.email || null,
        action,
        targetType || null,
        targetId != null ? String(targetId) : null,
        payload ? JSON.stringify(payload) : null,
        changeRequestId,
        req?.ip || null,
        (req?.get?.('user-agent') || '').slice(0, 255) || null,
      ]
    );
  } catch (e) {
    console.error('[audit] failed to write log', e.message);
  }
};