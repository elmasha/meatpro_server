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
    `report:comparative:${branch_id || 'all'}`,
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

    // ── SOFT LOCK: check if the day is closed, but allow if created today ──
    const [existingEntry] = await connection.execute(
      `SELECT id, created_at FROM daily_entries 
        WHERE branch_id = ? AND date = ? 
        FOR UPDATE`,
      [branch_id, date]
    );

    if (existingEntry.length > 0) {
      const createdAt = new Date(existingEntry[0].created_at);
      const today = new Date();
      
      // If the entry was NOT created today (i.e. it's an old entry), block it.
      if (createdAt.toDateString() !== today.toDateString()) {
        await connection.rollback();
        return res.status(409).json({
          message: `The day ${date} is already closed. Expenses cannot be added.`,
          code: 'ENTRY_LOCKED'
        });
      }
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
// LAST 7 DAYS REPORT
// ─────────────────────────────────────────────────────────────
exports.getLast7DaysReport = async (req, res) => {
  try {
    const { branch_id } = req.query;

    const [rows] = await db.promise().query(`
      SELECT 
        d.date,
        SUM(d.actual_revenue) AS totalActualRevenue,
        SUM(d.revenue) AS totalRevenue,
        SUM(d.cogs) AS totalCogs,
        COALESCE((
          SELECT SUM(amount) 
          FROM expenses e 
          WHERE e.date = d.date AND e.branch_id = ?
        ), 0) AS daily_expenses
      FROM daily_entries d
      WHERE d.branch_id = ? AND d.date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
      GROUP BY d.date
    `, [branch_id, branch_id]);

    let totalActualRevenue = 0;
    let totalRevenue = 0;
    let totalCogs = 0;
    let totalExpenses = 0;

    rows.forEach(row => {
      totalActualRevenue += parseFloat(row.totalActualRevenue) || 0;
      totalRevenue += parseFloat(row.totalRevenue) || 0;
      totalCogs += parseFloat(row.totalCogs) || 0;
      totalExpenses += parseFloat(row.daily_expenses) || 0;
    });

    res.json({
      totalActualRevenue,
      totalRevenue,
      totalCogs,
      totalCost: totalExpenses,
      totalExpenses: totalExpenses,
      data: rows.map(r => ({ ...r, expenses: r.daily_expenses }))
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// MONTH TO DATE REPORT
// ─────────────────────────────────────────────────────────────
exports.getMonthToDateReport = async (req, res) => {
  try {
    const { branch_id } = req.query;

    const [rows] = await db.promise().query(`
      SELECT 
        date,
        SUM(actual_revenue) AS daily_actual_revenue,
        SUM(cogs) AS daily_cogs,
        COALESCE((
          SELECT SUM(amount) 
          FROM expenses e 
          WHERE e.date = daily_entries.date AND e.branch_id = ?
        ), 0) AS daily_expenses
      FROM daily_entries
      WHERE branch_id = ? AND date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
      GROUP BY date
    `, [branch_id, branch_id]);

    let totalActualRevenue = 0;
    let totalCogs = 0;
    let totalExpenses = 0;

    rows.forEach(row => {
      totalActualRevenue += parseFloat(row.daily_actual_revenue) || 0;
      totalCogs += parseFloat(row.daily_cogs) || 0;
      totalExpenses += parseFloat(row.daily_expenses) || 0;
    });

    res.json({
      totalActualRevenue: totalActualRevenue,
      totalCogs: totalCogs,
      totalCost: totalExpenses,
      totalExpenses: totalExpenses,
      data: rows.map(r => ({ ...r, expenses: r.daily_expenses }))
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ─────────────────────────────────────────────────────────────
// DELETE EXPENSE — blocked if the day is already closed
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