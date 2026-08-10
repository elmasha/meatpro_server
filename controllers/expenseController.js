const db = require("../config/db");
const redis = require('../config/redis');

const fmt = (n) => {
  const v = parseFloat(n);
  return isNaN(v) ? 0 : Math.round(v * 100) / 100;
};

const invalidateDailyCache = async (branch_id, date) => {
  const keys = [
    `stock:current:${branch_id || 'all'}`,
    `report:last-entry:${branch_id || 'all'}`,
    `report:last-7-days:${branch_id || 'all'}`,
    `report:month-to-date:${branch_id || 'all'}`
  ];
  for (const key of keys) {
    await redis.del(key);
  }
};

const verifyBranchAccess = async (firebase_uid, branch_id) => {
  const [rows] = await db.promise().execute(
    `SELECT 1 FROM branches br
     JOIN businesses b ON br.business_id = b.id
     WHERE br.id = ? AND (b.firebase_uid = ? OR br.manager_uid = ?)
     LIMIT 1`,
    [branch_id, firebase_uid, firebase_uid]
  );
  return rows.length > 0;
};

exports.createExpense = async (req, res) => {
  try {
    const { branch_id, title, amount, date } = req.body;
    const firebase_uid = req.firebase_uid;

    if (!date || !amount || !branch_id) {
      return res.status(400).json({ message: "Date, amount, and branch_id are required" });
    }

    const hasAccess = await verifyBranchAccess(firebase_uid, branch_id);
    if (!hasAccess) {
      return res.status(403).json({ message: "Forbidden — you do not own this branch" });
    }

    const normalizedTitle = title.toLowerCase().trim();

    const query = `INSERT INTO expenses (branch_id, title, amount, date) VALUES (?, ?, ?, ?)`;
    const [result] = await db.promise().execute(query, [
      branch_id, normalizedTitle, parseFloat(amount), date
    ]);

    await invalidateDailyCache(branch_id, date);
    await redis.del(`expenses:${date}:${branch_id}`);

    res.status(201).json({
      message: "Expense recorded successfully",
      data: { id: result.insertId, branch_id, title: normalizedTitle, amount, date }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getExpensesByDate = async (req, res) => {
  try {
    const { date } = req.params;
    let { branch_id } = req.query;
    const firebase_uid = req.firebase_uid;
    
    // FIXED: Require branch_id or auto-resolve from user profile
    if (!branch_id) {
      const [userRows] = await db.promise().execute(
        `SELECT branch_id FROM users WHERE firebase_uid = ? LIMIT 1`,
        [firebase_uid]
      );
      branch_id = userRows[0]?.branch_id;
      
      if (!branch_id) {
        return res.status(400).json({ 
          message: "branch_id is required or user has no default branch" 
        });
      }
    }

    const cacheKey = `expenses:${date}:${branch_id}`;

    // FIXED: Verify access BEFORE cache check — always runs
    const hasAccess = await verifyBranchAccess(firebase_uid, branch_id);
    if (!hasAccess) {
      return res.status(403).json({ message: "Forbidden — you do not own this branch" });
    }

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    const query = `SELECT * FROM expenses WHERE date = ? AND branch_id = ?`;
    const [rows] = await db.promise().execute(query, [date, branch_id]);
    const totalPaid = rows.reduce((sum, e) => sum + parseFloat(e.amount), 0);

    const result = { date, totalPaid, expenses: rows };

    await redis.setEx(cacheKey, 600, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};