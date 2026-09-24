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
    `report:month-to-date:${branch_id || 'all'}`,
    `daily:last:${branch_id || 'all'}`
  ];
  for (const key of keys) {
    await redis.del(key);
  }
};

// ─────────────────────────────────────────────────────────────
// CREATE EXPENSE — blocked if the day is already closed
// ─────────────────────────────────────────────────────────────
exports.createExpense = async (req, res) => {
  const connection = await db.promise().getConnection();
  try {
    const { branch_id, title, amount, date } = req.body;
    const firebase_uid = req.firebase_uid;

    if (!date || !amount || !branch_id) {
      return res.status(400).json({ message: "Date, amount, and branch_id are required" });
    }

    const normalizedTitle = (title || '').toString().toLowerCase().trim();

    await connection.beginTransaction();

    // ── HARD LOCK: check if the day has been closed ──
    const [existingEntry] = await connection.execute(
      `SELECT id FROM daily_entries 
        WHERE branch_id = ? AND date = ? 
        FOR UPDATE`,
      [branch_id, date]
    );

    if (existingEntry.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        message: `The day ${date} is already closed. Expenses cannot be added.`,
        code: 'ENTRY_LOCKED'
      });
    }

    const query = `INSERT INTO expenses (branch_id, title, amount, date) VALUES (?, ?, ?, ?)`;
    const [result] = await connection.execute(query, [
      branch_id, normalizedTitle, parseFloat(amount), date
    ]);

    await connection.commit();

    await invalidateDailyCache(branch_id, date);
    await redis.del(`expenses:${date}:${branch_id}`);

    res.status(201).json({
      message: "Expense recorded successfully",
      data: { id: result.insertId, branch_id, title: normalizedTitle, amount, date }
    });

  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};

// ─────────────────────────────────────────────────────────────
// GET EXPENSES BY DATE
// ─────────────────────────────────────────────────────────────
exports.getExpensesByDate = async (req, res) => {
  try {
    const { date } = req.params;
    let { branch_id } = req.query;
    const firebase_uid = req.firebase_uid;

    // Auto-resolve branch_id from user profile if not provided
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

// ─────────────────────────────────────────────────────────────
// UPDATE EXPENSE — blocked if the day is already closed
// (Optional — only if you have an edit-expense route)
// ─────────────────────────────────────────────────────────────
exports.updateExpense = async (req, res) => {
  const connection = await db.promise().getConnection();
  try {
    const { id } = req.params;
    const { title, amount } = req.body;

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT branch_id, date FROM expenses WHERE id = ? FOR UPDATE`,
      [id]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Expense not found' });
    }

    const { branch_id, date } = rows[0];

    // Check if the day is closed
    const [closed] = await connection.execute(
      `SELECT id FROM daily_entries WHERE branch_id = ? AND date = ? LIMIT 1`,
      [branch_id, date]
    );

    if (closed.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        message: `The day ${date} is already closed. Expenses cannot be modified.`,
        code: 'ENTRY_LOCKED'
      });
    }

    const normalizedTitle = (title || '').toString().toLowerCase().trim();

    await connection.execute(
      `UPDATE expenses SET title = ?, amount = ? WHERE id = ?`,
      [normalizedTitle, fmt(amount), id]
    );

    await connection.commit();

    await invalidateDailyCache(branch_id, date);
    await redis.del(`expenses:${date}:${branch_id}`);

    res.json({ message: 'Expense updated' });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE EXPENSE — blocked if the day is already closed
// (Optional — only if you have a delete-expense route)
// ─────────────────────────────────────────────────────────────
exports.deleteExpense = async (req, res) => {
  const connection = await db.promise().getConnection();
  try {
    const { id } = req.params;

    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT branch_id, date FROM expenses WHERE id = ? FOR UPDATE`,
      [id]
    );

    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: 'Expense not found' });
    }

    const { branch_id, date } = rows[0];

    const [closed] = await connection.execute(
      `SELECT id FROM daily_entries WHERE branch_id = ? AND date = ? LIMIT 1`,
      [branch_id, date]
    );

    if (closed.length > 0) {
      await connection.rollback();
      return res.status(409).json({
        message: `The day ${date} is already closed. Expenses cannot be deleted.`,
        code: 'ENTRY_LOCKED'
      });
    }

    await connection.execute(`DELETE FROM expenses WHERE id = ?`, [id]);
    await connection.commit();

    await invalidateDailyCache(branch_id, date);
    await redis.del(`expenses:${date}:${branch_id}`);

    res.json({ message: 'Expense deleted' });
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    res.status(500).json({ message: error.message });
  } finally {
    connection.release();
  }
};