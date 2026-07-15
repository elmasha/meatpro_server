const db = require('../config/db');
const redis = require('../config/redis');

// ==================== HELPERS ====================

const invalidateBusinessCache = async (firebase_uid, business_id) => {
  const keys = [
    'businesses:all',
    `business:user:${firebase_uid}`,
    `branches:user:${firebase_uid}`
  ];
  if (business_id) {
    keys.push(`branches:business:${business_id}`);
    keys.push(`business:${business_id}`);
  }
  for (const key of keys) {
    await redis.del(key);
  }
};

// ==================== USER CONTROLLERS ====================

// SYNC FIREBASE USER (called after login/register)
exports.syncFirebaseUser = async (req, res) => {
  try {
    const { firebase_uid, name, phone } = req.body;

    if (!firebase_uid) {
      return res.status(400).json({ message: "firebase_uid is required" });
    }

    const [existing] = await db.promise().execute(
      `SELECT * FROM users WHERE firebase_uid = ?`,
      [firebase_uid]
    );

    if (existing.length > 0) {
      await db.promise().execute(
        `UPDATE users SET 
          name = COALESCE(?, name),
          phone = COALESCE(?, phone)
         WHERE firebase_uid = ?`,
        [name, phone, firebase_uid]
      );

      const [updated] = await db.promise().execute(
        `SELECT * FROM users WHERE firebase_uid = ?`,
        [firebase_uid]
      );

      return res.json({
        message: "User updated",
        data: updated[0]
      });
    }

    const [result] = await db.promise().execute(
      `INSERT INTO users (firebase_uid, name, phone, user_type) 
       VALUES (?, ?, ?, 'Retailer')`,
      [firebase_uid, name || 'User', phone || null]
    );

    res.status(201).json({
      message: "User created",
      data: { 
        id: result.insertId, 
        firebase_uid, 
        name: name || 'User',
        phone,
        user_type: 'Retailer'
      }
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
        b.name as business_name,
        b.id as business_id,
        br.name as branch_name,
        br.id as branch_id,
        br.location as branch_location
       FROM users u
       LEFT JOIN businesses b ON u.business_id = b.id
       LEFT JOIN branches br ON u.branch_id = br.id
       WHERE u.firebase_uid = ?`,
      [firebase_uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(rows[0]);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ==================== BUSINESS CONTROLLERS ====================

// CREATE BUSINESS
exports.createBusiness = async (req, res) => {
  try {
    const { name, owner_name, phone, firebase_uid } = req.body;

    if (!name || !firebase_uid) {
      return res.status(400).json({ 
        message: "Business name and firebase_uid are required" 
      });
    }

    // Check if user already owns a business
    const [existing] = await db.promise().execute(
      `SELECT id FROM businesses WHERE firebase_uid = ?`,
      [firebase_uid]
    );

    if (existing.length > 0) {
      return res.status(409).json({ 
        message: "User already has a business" 
      });
    }

    const [result] = await db.promise().execute(
      `INSERT INTO businesses (name, owner_name, firebase_uid, phone) 
       VALUES (?, ?, ?, ?)`,
      [name, owner_name || null, firebase_uid, phone || null]
    );

    const businessId = result.insertId;

    // Link user to this business
    await db.promise().execute(
      `UPDATE users 
       SET business_id = ?, name = COALESCE(?, name), phone = COALESCE(?, phone)
       WHERE firebase_uid = ?`,
      [businessId, owner_name, phone, firebase_uid]
    );

    await invalidateBusinessCache(firebase_uid);

    res.status(201).json({
      message: "Business created",
      data: { 
        id: businessId, 
        name, 
        owner_name,
        firebase_uid,
        phone 
      }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET MY BUSINESS
exports.getMyBusiness = async (req, res) => {
  try {
    const { firebase_uid } = req.query;

    if (!firebase_uid) {
      return res.status(400).json({ message: "firebase_uid is required" });
    }

    const cacheKey = `business:user:${firebase_uid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(
      `SELECT 
        b.id as business_id,
        b.name as business_name,
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
        ) as branches
       FROM businesses b
       LEFT JOIN branches br ON b.id = br.business_id
       WHERE b.firebase_uid = ?
       GROUP BY b.id`,
      [firebase_uid]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "No business found" });
    }

    const result = {
      ...rows[0],
      branches: rows[0].branches 
        ? JSON.parse(rows[0].branches).filter(b => b.id !== null) 
        : []
    };

    await redis.setEx(cacheKey, 300, JSON.stringify(result));
    res.json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET ALL BUSINESSES
exports.getAllBusinesses = async (req, res) => {
  try {
    const cacheKey = 'businesses:all';
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(
      `SELECT b.*, COUNT(br.id) as branch_count 
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

// UPDATE MY BUSINESS
exports.updateMyBusiness = async (req, res) => {
  try {
    const { firebase_uid, name, owner_name, phone } = req.body;

    if (!firebase_uid) {
      return res.status(400).json({ message: "firebase_uid is required" });
    }

    const [result] = await db.promise().execute(
      `UPDATE businesses 
       SET name = ?, owner_name = ?, phone = ? 
       WHERE firebase_uid = ?`,
      [name, owner_name, phone, firebase_uid]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Business not found" });
    }

    await db.promise().execute(
      `UPDATE users SET name = ?, phone = ? WHERE firebase_uid = ?`,
      [owner_name, phone, firebase_uid]
    );

    await invalidateBusinessCache(firebase_uid);

    res.json({ message: "Business updated" });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ==================== BRANCH CONTROLLERS ====================

// CREATE BRANCH
exports.createBranch = async (req, res) => {
  try {
    const { business_id, name, location, firebase_uid } = req.body;


    // Verify user owns this business
    const [business] = await db.promise().execute(
      `SELECT firebase_uid FROM businesses WHERE id = ?`,
      [business_id]
    );

    if (business.length === 0) {
      return res.status(404).json({ message: "Business not found" });
    }

    if (business[0].firebase_uid !== firebase_uid) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const [result] = await db.promise().execute(
      `INSERT INTO branches (business_id, name, location, manager_uid) 
       VALUES (?, ?, ?, ?)`,
      [business_id, name, location || null, firebase_uid]
    );

    const branchId = result.insertId;

    await invalidateBusinessCache(firebase_uid, business_id);

    res.status(201).json({
      message: "Branch created",
      data: { 
        id: branchId, 
        business_id, 
        name, 
        location,
        manager_uid: firebase_uid
      }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET MY BRANCHES
exports.getMyBranches = async (req, res) => {
  try {
    const { firebase_uid } = req.query;

    if (!firebase_uid) {
      return res.status(400).json({ message: "firebase_uid is required" });
    }

    const cacheKey = `branches:user:${firebase_uid}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(
      `SELECT 
        br.*,
        b.name as business_name
       FROM branches br
       JOIN businesses b ON br.business_id = b.id
       WHERE b.firebase_uid = ? OR br.manager_uid = ?
       ORDER BY br.created_at DESC`,
      [firebase_uid, firebase_uid]
    );

    await redis.setEx(cacheKey, 300, JSON.stringify(rows));
    res.json(rows);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET BRANCHES BY BUSINESS
exports.getBranchesByBusiness = async (req, res) => {
  try {
    const { business_id } = req.params;

    const cacheKey = `branches:business:${business_id}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(
      `SELECT br.*, u.name as manager_name 
       FROM branches br
       LEFT JOIN users u ON br.manager_uid = u.firebase_uid
       WHERE br.business_id = ? 
       ORDER BY br.created_at DESC`,
      [business_id]
    );

    await redis.setEx(cacheKey, 300, JSON.stringify(rows));
    res.json(rows);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// UPDATE BRANCH
exports.updateBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, location, firebase_uid } = req.body;

    // Verify ownership
    const [branchCheck] = await db.promise().execute(
      `SELECT br.*, b.firebase_uid as owner_uid 
       FROM branches br
       JOIN businesses b ON br.business_id = b.id
       WHERE br.id = ?`,
      [id]
    );

    if (branchCheck.length === 0) {
      return res.status(404).json({ message: "Branch not found" });
    }

    if (branchCheck[0].owner_uid !== firebase_uid) {
      return res.status(403).json({ message: "Not authorized" });
    }

    await db.promise().execute(
      `UPDATE branches SET name = ?, location = ? WHERE id = ?`,
      [name, location, id]
    );

    await invalidateBusinessCache(firebase_uid, branchCheck[0].business_id);

    res.json({ message: "Branch updated" });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// DELETE BRANCH
exports.deleteBranch = async (req, res) => {
  try {
    const { id } = req.params;
    const { firebase_uid } = req.body;

    // Verify ownership and check for entries
    const [branchCheck] = await db.promise().execute(
      `SELECT br.*, b.firebase_uid as owner_uid 
       FROM branches br
       JOIN businesses b ON br.business_id = b.id
       WHERE br.id = ?`,
      [id]
    );

    if (branchCheck.length === 0) {
      return res.status(404).json({ message: "Branch not found" });
    }

    if (branchCheck[0].owner_uid !== firebase_uid) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Check for entries
    const [entries] = await db.promise().execute(
      `SELECT COUNT(*) as count FROM daily_entries WHERE branch_id = ?`,
      [id]
    );

    if (entries[0].count > 0) {
      return res.status(400).json({ 
        message: "Cannot delete branch with recorded entries" 
      });
    }

    await db.promise().execute(`DELETE FROM branches WHERE id = ?`, [id]);

    await invalidateBusinessCache(firebase_uid, branchCheck[0].business_id);

    res.json({ message: "Branch deleted" });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};