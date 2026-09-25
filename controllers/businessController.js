const db = require('../config/db');
const redis = require('../config/redis');
const { getUserRole, isBusinessOwner } = require('../utils/roles');

// ==================== HELPERS ====================

const invalidateBusinessCache = async (firebase_uid, business_id) => {
  const keys = [
    'businesses:all',
    `business:user:${firebase_uid}`,
    `branches:user:${firebase_uid}`,
    `user:role:${firebase_uid}`,
  ];
  if (business_id) {
    keys.push(`branches:business:${business_id}`);
    keys.push(`business:${business_id}`);
  }
  for (const key of keys) {
    await redis.del(key);
  }
};

const invalidateRoleCache = async (firebase_uid) => {
  if (!firebase_uid) return;
  await redis.del(`user:role:${firebase_uid}`);
};

// ─── Plan branch limits ─────────────────────────────────────
// Fallback limits keyed by plan name (lowercase).
// These are only used if the plan's `features` JSON array doesn't
// specify a branch limit.
const PLAN_BRANCH_LIMITS = {
  free: 0,
  starter: 1,
  business: 2,
  pro: 3,
};

/**
 * Resolve the branch limit for a given plan row.
 * Priority:
 *   1. Plan's JSON `features` array (e.g. ["2 branch", "5 users"])
 *   2. Hardcoded PLAN_BRANCH_LIMITS fallback
 */
const getPlanBranchLimit = (planRow) => {
  if (!planRow) return 0;

  let features = planRow.features;
  if (typeof features === 'string') {
    try { features = JSON.parse(features); } catch { features = []; }
  }

  if (Array.isArray(features)) {
    for (const f of features) {
      const lower = String(f).toLowerCase();
      if (lower.includes('unlimited') && lower.includes('branch')) return Infinity;
      // Match patterns like "2 branch", "3 branches", "up to 5 branches"
      const match = lower.match(/(\d+)\s*branch/);
      if (match) return parseInt(match[1], 10);
    }
  }

  const name = (planRow.name || '').toLowerCase();
  return PLAN_BRANCH_LIMITS[name] ?? 0;
};

/**
 * Look up the active plan row for a user.
 * Returns null if the user has no active subscription.
 */
const getActivePlanForUser = async (connection, firebase_uid) => {
  const [rows] = await connection.execute(
    `SELECT 
        u.subscription       AS plan_name,
        u.subscription_status,
        p.name               AS plan_slug,
        p.features           AS plan_features
       FROM users u
       LEFT JOIN plans p ON LOWER(p.name) = LOWER(u.subscription)
      WHERE u.firebase_uid = ?
      LIMIT 1`,
    [firebase_uid]
  );

  if (rows.length === 0) return null;

  const row = rows[0];
  const status = (row.subscription_status || '').toLowerCase();

  // Only active subscriptions can create branches
  if (status !== 'active') return null;

  return {
    name: row.plan_slug || row.plan_name || 'free',
    features: row.plan_features,
  };
};

// ==================== USER CONTROLLERS ====================

// SYNC FIREBASE USER (called after login/register)
exports.syncFirebaseUser = async (req, res) => {
  try {
    const firebase_uid = req.firebase_uid || req.body.firebase_uid;
    const { name, phone, email } = req.body;

    if (!firebase_uid) {
      return res.status(400).json({ message: 'firebase_uid is required' });
    }

    const [existing] = await db.promise().execute(
      `SELECT * FROM users WHERE firebase_uid = ?`,
      [firebase_uid]
    );

    if (existing.length > 0) {
      await db.promise().execute(
        `UPDATE users SET 
          name  = COALESCE(?, name),
          phone = COALESCE(?, phone),
          email = COALESCE(?, email)
         WHERE firebase_uid = ?`,
        [name, phone, email, firebase_uid]
      );

      const [updated] = await db.promise().execute(
        `SELECT * FROM users WHERE firebase_uid = ?`,
        [firebase_uid]
      );

      return res.json({ message: 'User updated', data: updated[0] });
    }

    const [result] = await db.promise().execute(
      `INSERT INTO users (firebase_uid, name, phone, email, user_type) 
       VALUES (?, ?, ?, ?, 'Retailer')`,
      [firebase_uid, name || 'User', phone || null, email || null]
    );

    res.status(201).json({
      message: 'User created',
      data: {
        id: result.insertId,
        firebase_uid,
        name: name || 'User',
        phone,
        email,
        user_type: 'Retailer',
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET USER PROFILE
exports.getUserProfile = async (req, res) => {
  try {
    const { firebase_uid } = req.params;

    const [rows] = await db.promise().execute(
      `SELECT 
        u.*,
        b.name AS business_name,
        b.id AS business_id,
        br.name AS branch_name,
        br.id AS branch_id,
        br.location AS branch_location
       FROM users u
       LEFT JOIN businesses b ON u.business_id = b.id
       LEFT JOIN branches br ON u.branch_id = br.id
       WHERE u.firebase_uid = ?`,
      [firebase_uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const roleInfo = await getUserRole(firebase_uid);

    res.json({ ...rows[0], role: roleInfo.role, managed_branches: roleInfo.managed_branches });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET MY ROLE
exports.getMyRole = async (req, res) => {
  try {
    const firebase_uid = req.firebase_uid || req.query.firebase_uid;

    if (!firebase_uid) {
      return res.status(400).json({ message: 'firebase_uid is required' });
    }

    const cacheKey = `user:role:${firebase_uid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const roleInfo = await getUserRole(firebase_uid);

    let branches = [];
    if (roleInfo.role === 'owner') {
      const [rows] = await db.promise().execute(
        `SELECT br.id, br.name, br.location 
           FROM branches br
           JOIN businesses b ON br.business_id = b.id
          WHERE b.firebase_uid = ?
          ORDER BY br.created_at DESC`,
        [firebase_uid]
      );
      branches = rows;
    } else if (roleInfo.role === 'manager' && roleInfo.managed_branches.length > 0) {
      const placeholders = roleInfo.managed_branches.map(() => '?').join(',');
      const [rows] = await db.promise().execute(
        `SELECT id, name, location 
           FROM branches 
          WHERE id IN (${placeholders})
          ORDER BY created_at DESC`,
        roleInfo.managed_branches
      );
      branches = rows;
    }

    const result = {
      role: roleInfo.role,
      business_id: roleInfo.business_id,
      primary_branch_id: roleInfo.primary_branch_id,
      accessible_branch_ids:
        roleInfo.role === 'owner'
          ? branches.map((b) => b.id)
          : roleInfo.managed_branches,
      branches,
    };

    await redis.setEx(cacheKey, 300, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ==================== BUSINESS CONTROLLERS ====================

// CREATE BUSINESS
exports.createBusiness = async (req, res) => {
  const connection = await db.promise().getConnection();
  try {
    const firebase_uid = req.firebase_uid || req.body.firebase_uid;
    const { name, owner_name, phone } = req.body;

    if (!name || !firebase_uid) {
      return res.status(400).json({ message: 'Business name and firebase_uid are required' });
    }

    await connection.beginTransaction();

    // Row-lock to prevent race condition on double-create
    const [existing] = await connection.execute(
      `SELECT id FROM businesses WHERE firebase_uid = ? FOR UPDATE`,
      [firebase_uid]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(409).json({ message: 'User already has a business' });
    }

    const [result] = await connection.execute(
      `INSERT INTO businesses (name, owner_name, firebase_uid, phone) VALUES (?, ?, ?, ?)`,
      [name, owner_name || null, firebase_uid, phone || null]
    );

    const businessId = result.insertId;

    await connection.execute(
      `UPDATE users 
          SET business_id = ?, 
              name  = COALESCE(?, name), 
              phone = COALESCE(?, phone)
        WHERE firebase_uid = ?`,
      [businessId, owner_name, phone, firebase_uid]
    );

    await connection.commit();

    await invalidateBusinessCache(firebase_uid, businessId);
    await invalidateRoleCache(firebase_uid);

    res.status(201).json({
      message: 'Business created',
      data: { id: businessId, name, owner_name, firebase_uid, phone },
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};

// GET MY BUSINESS
exports.getMyBusiness = async (req, res) => {
  try {
    const { firebase_uid } = req.query;

    if (!firebase_uid) {
      return res.status(400).json({ message: 'firebase_uid is required' });
    }

    const cacheKey = `business:user:${firebase_uid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(
      `SELECT 
        b.id AS business_id,
        b.name AS business_name,
        b.owner_name,
        b.phone,
        b.firebase_uid,
        b.created_at,
        JSON_ARRAYAGG(
          JSON_OBJECT(
            'id', br.id,
            'name', br.name,
            'location', br.location,
            'created_at', br.created_at
          )
        ) AS branches
       FROM businesses b
       LEFT JOIN branches br ON b.id = br.business_id
       WHERE b.firebase_uid = ?
       GROUP BY b.id`,
      [firebase_uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'No business found' });
    }

    const result = {
      ...rows[0],
      branches: rows[0].branches
        ? JSON.parse(rows[0].branches).filter((b) => b.id !== null)
        : [],
    };

    await redis.setEx(cacheKey, 300, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET ALL BUSINESSES — restricted to admins
exports.getAllBusinesses = async (req, res) => {
  try {
    const firebase_uid = req.firebase_uid || req.query.firebase_uid;

    const [adminCheck] = await db.promise().execute(
      `SELECT is_admin FROM users WHERE firebase_uid = ? LIMIT 1`,
      [firebase_uid]
    );

    if (adminCheck.length === 0 || !adminCheck[0].is_admin) {
      return res.status(403).json({ message: 'Admin only' });
    }

    const cacheKey = 'businesses:all';
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(
      `SELECT b.*, COUNT(br.id) AS branch_count 
         FROM businesses b 
         LEFT JOIN branches br ON b.id = br.business_id 
         GROUP BY b.id 
         ORDER BY b.created_at DESC`
    );

    await redis.setEx(cacheKey, 600, JSON.stringify(rows));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UPDATE MY BUSINESS — owner only (WHERE clause enforces it)
exports.updateMyBusiness = async (req, res) => {
  try {
    const firebase_uid = req.firebase_uid || req.body.firebase_uid;
    const { name, owner_name, phone } = req.body;

    if (!firebase_uid) {
      return res.status(400).json({ message: 'firebase_uid is required' });
    }

    const [result] = await db.promise().execute(
      `UPDATE businesses 
          SET name       = COALESCE(?, name),
              owner_name = COALESCE(?, owner_name),
              phone      = COALESCE(?, phone)
        WHERE firebase_uid = ?`,
      [name, owner_name, phone, firebase_uid]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Business not found' });
    }

    await db.promise().execute(
      `UPDATE users 
          SET name  = COALESCE(?, name),
              phone = COALESCE(?, phone)
        WHERE firebase_uid = ?`,
      [owner_name, phone, firebase_uid]
    );

    await invalidateBusinessCache(firebase_uid);

    res.json({ message: 'Business updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ==================== BRANCH CONTROLLERS ====================

// CREATE BRANCH — owner only, enforces plan branch limit
exports.createBranch = async (req, res) => {
  const connection = await db.promise().getConnection();
  try {
    const firebase_uid = req.firebase_uid || req.body.firebase_uid;
    const { business_id, name, location } = req.body;

    if (!business_id || !name) {
      return res.status(400).json({ message: 'business_id and name are required' });
    }

    if (!(await isBusinessOwner(firebase_uid, business_id))) {
      return res.status(403).json({ message: 'Only the business owner can create branches' });
    }

    // ── Plan limit check ────────────────────────────────────
    const plan = await getActivePlanForUser(connection, firebase_uid);

    if (!plan) {
      return res.status(403).json({
        message: 'An active subscription is required to create branches',
        code: 'NO_ACTIVE_SUBSCRIPTION',
      });
    }

    const limit = getPlanBranchLimit(plan);

    if (limit === 0) {
      return res.status(403).json({
        message: 'Your current plan does not allow branch creation. Upgrade to continue.',
        code: 'PLAN_LIMIT_REACHED',
      });
    }

    if (limit !== Infinity) {
      const [countRows] = await connection.execute(
        `SELECT COUNT(*) AS count FROM branches WHERE business_id = ?`,
        [business_id]
      );

      if (countRows[0].count >= limit) {
        return res.status(403).json({
          message: `Your ${plan.name} plan allows only ${limit} branch${limit === 1 ? '' : 'es'}. Upgrade to add more.`,
          code: 'PLAN_LIMIT_REACHED',
          limit,
          current: countRows[0].count,
        });
      }
    }

    // ── Create branch ───────────────────────────────────────
    await connection.beginTransaction();

    const [result] = await connection.execute(
      `INSERT INTO branches (business_id, name, location, manager_uid) 
       VALUES (?, ?, ?, ?)`,
      [business_id, name, location || null, firebase_uid]  // default manager = owner
    );

    const branchId = result.insertId;

    // Set as primary only if user has no branch yet
    await connection.execute(
      `UPDATE users SET branch_id = COALESCE(branch_id, ?) WHERE firebase_uid = ?`,
      [branchId, firebase_uid]
    );

    await connection.commit();

    await invalidateBusinessCache(firebase_uid, business_id);

    res.status(201).json({
      message: 'Branch created',
      data: {
        id: branchId,
        business_id,
        name,
        location,
        manager_uid: firebase_uid,
      },
    });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    console.error('createBranch ERROR:', error);
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};

// GET MY BRANCHES — owner sees all under their business; manager sees only managed
exports.getMyBranches = async (req, res) => {
  try {
    const firebase_uid = req.firebase_uid || req.query.firebase_uid;

    if (!firebase_uid) {
      return res.status(400).json({ message: 'firebase_uid is required' });
    }

    const cacheKey = `branches:user:${firebase_uid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    // Determine role first
    const [ownedBusiness] = await db.promise().execute(
      `SELECT id FROM businesses WHERE firebase_uid = ? LIMIT 1`,
      [firebase_uid]
    );
    const isOwner = ownedBusiness.length > 0;

    let rows;
    if (isOwner) {
      [rows] = await db.promise().execute(
        `SELECT br.*, b.name AS business_name, 'owner' AS role
           FROM branches br
           JOIN businesses b ON br.business_id = b.id
          WHERE b.firebase_uid = ?
          ORDER BY br.created_at DESC`,
        [firebase_uid]
      );
    } else {
      [rows] = await db.promise().execute(
        `SELECT br.*, b.name AS business_name, 'manager' AS role
           FROM branches br
           JOIN businesses b ON br.business_id = b.id
          WHERE br.manager_uid = ?
          ORDER BY br.created_at DESC`,
        [firebase_uid]
      );
    }

    await redis.setEx(cacheKey, 300, JSON.stringify(rows));
    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET BRANCHES BY BUSINESS — owner OR manager of a branch in this business
exports.getBranchesByBusiness = async (req, res) => {
  try {
    const { business_id } = req.params;
    const firebase_uid = req.firebase_uid || req.query.firebase_uid;

    if (!firebase_uid) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    // Access check
    const [access] = await db.promise().execute(
      `SELECT 1 FROM businesses b
        WHERE b.id = ? AND (
          b.firebase_uid = ?
          OR EXISTS (
            SELECT 1 FROM branches br
             WHERE br.business_id = b.id AND br.manager_uid = ?
          )
        ) LIMIT 1`,
      [business_id, firebase_uid, firebase_uid]
    );

    if (access.length === 0) {
      return res.status(403).json({ message: 'Not authorized' });
    }

    // Determine if owner or manager to decide which rows to return
    const [ownerCheck] = await db.promise().execute(
      `SELECT 1 FROM businesses WHERE id = ? AND firebase_uid = ? LIMIT 1`,
      [business_id, firebase_uid]
    );
    const isOwner = ownerCheck.length > 0;

    let rows;
    if (isOwner) {
      [rows] = await db.promise().execute(
        `SELECT br.*, u.name AS manager_name 
           FROM branches br
           LEFT JOIN users u ON br.manager_uid = u.firebase_uid
          WHERE br.business_id = ?
          ORDER BY br.created_at DESC`,
        [business_id]
      );
    } else {
      [rows] = await db.promise().execute(
        `SELECT br.*, u.name AS manager_name 
           FROM branches br
           LEFT JOIN users u ON br.manager_uid = u.firebase_uid
          WHERE br.business_id = ? AND br.manager_uid = ?
          ORDER BY br.created_at DESC`,
        [business_id, firebase_uid]
      );
    }

    res.json(rows);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UPDATE BRANCH — owner only, and owner can reassign manager
exports.updateBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const firebase_uid = req.firebase_uid || req.body.firebase_uid;
    const { name, location, manager_uid } = req.body;

    const [rows] = await db.promise().execute(
      `SELECT br.business_id, br.manager_uid AS old_manager, b.firebase_uid AS owner_uid 
         FROM branches br
         JOIN businesses b ON br.business_id = b.id
        WHERE br.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: 'Branch not found' });
    }

    const { business_id, old_manager, owner_uid } = rows[0];

    if (owner_uid !== firebase_uid) {
      return res.status(403).json({ message: 'Only the business owner can edit branches' });
    }

    // If reassigning manager, verify the target user exists
    let newManager = old_manager;
    if (manager_uid !== undefined && manager_uid !== null && manager_uid !== '') {
      const [target] = await db.promise().execute(
        `SELECT firebase_uid FROM users WHERE firebase_uid = ? LIMIT 1`,
        [manager_uid]
      );
      if (target.length === 0) {
        return res.status(404).json({ message: 'Target manager user not found' });
      }
      newManager = manager_uid;
    }

    await db.promise().execute(
      `UPDATE branches 
          SET name        = COALESCE(?, name),
              location    = COALESCE(?, location),
              manager_uid = ?
        WHERE id = ?`,
      [name, location, newManager, id]
    );

    // Invalidate caches for owner, old manager, new manager
    await invalidateBusinessCache(firebase_uid, business_id);
    if (old_manager) await invalidateRoleCache(old_manager);
    if (newManager && newManager !== old_manager) await invalidateRoleCache(newManager);

    res.json({ message: 'Branch updated' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE BRANCH — owner only, transactional
exports.deleteBranch = async (req, res) => {
  const connection = await db.promise().getConnection();
  try {
    const { id } = req.params;
    const firebase_uid = req.firebase_uid || req.body.firebase_uid;

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT br.business_id, b.firebase_uid AS owner_uid 
         FROM branches br
         JOIN businesses b ON br.business_id = b.id
        WHERE br.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Branch not found' });
    }

    if (rows[0].owner_uid !== firebase_uid) {
      await connection.rollback();
      return res.status(403).json({ message: 'Only the business owner can delete branches' });
    }

    const [entries] = await connection.execute(
      `SELECT COUNT(*) AS count FROM daily_entries WHERE branch_id = ?`,
      [id]
    );

    if (entries[0].count > 0) {
      await connection.rollback();
      return res.status(400).json({ message: 'Cannot delete branch with recorded entries' });
    }

    await connection.execute(`DELETE FROM branches WHERE id = ?`, [id]);

    await connection.commit();

    await invalidateBusinessCache(firebase_uid, rows[0].business_id);

    res.json({ message: 'Branch deleted' });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};