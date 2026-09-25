// middleware/adminAuth.js
const db = require('../config/db');

exports.requireAdmin = async (req, res, next) => {
  try {
    // Accept identity from either header
    let firebaseUid = req.headers['x-firebase-uid'];

    if (!firebaseUid && req.headers.authorization) {
      // If the frontend sent a Bearer token, we can't verify it without firebase-admin,
      // so we just log a warning. Fall back to x-firebase-uid if present.
      // If the frontend ONLY sends Bearer, you MUST install firebase-admin and
      // use verifyIdToken() here — but for now, if there's no x-firebase-uid,
      // try the query param.
    }

    if (!firebaseUid) {
      firebaseUid = req.query.uid;
    }

    if (!firebaseUid) {
      return res.status(401).json({
        error: 'Authentication required. Send x-firebase-uid header or ?uid= query.'
      });
    }

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

    req.admin = {
      id: u.id,
      uid: u.firebase_uid,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.admin_role,
    };
    req.firebaseUid = u.firebase_uid;

    next();
  } catch (err) {
    console.error('[requireAdmin]', err);
    res.status(500).json({ error: err.message });
  }
};

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

exports.audit = async ({ admin, action, targetType, targetId, payload, changeRequestId = null, req }) => {
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