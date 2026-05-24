const db = require("../config/db");
const redis = require('../config/redis');
// CREATE EXPENSE
exports.createExpense = async (req, res) => {
  try {
    const { branch_id, title, amount, date } = req.body;

    if (!date || !amount || !branch_id) {
      return res.status(400).json({ message: "Date, amount, and branch_id are required" });
    }

    const query = `INSERT INTO expenses (branch_id, title, amount, date) VALUES (?, ?, ?, ?)`;
    const [result] = await db.promise().execute(query, [
      branch_id, title, parseFloat(amount), date
    ]);

    // Invalidate related caches
    const keys = [
      `expenses:${date}:${branch_id}`,
      `report:last-entry:${branch_id}`,
      `report:last-7-days:${branch_id}`,
      `report:month-to-date:${branch_id}`
    ];
    
    for (const key of keys) {
      await redis.del(key);
    }

    res.status(201).json({
      message: "Expense recorded successfully",
      data: { id: result.insertId, branch_id, title, amount, date }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET EXPENSES BY DATE
exports.getExpensesByDate = async (req, res) => {
  try {
    const { date } = req.params;
    const { branch_id } = req.query;
    const cacheKey = `expenses:${date}:${branch_id || 'all'}`;

    // Check cache
    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    let query = `SELECT * FROM expenses WHERE date = ?`;
    const params = [date];

    if (branch_id) {
      query += ` AND branch_id = ?`;
      params.push(branch_id);
    }

    const [rows] = await db.promise().execute(query, params);
    const totalPaid = rows.reduce((sum, e) => sum + parseFloat(e.amount), 0);

    const result = { date, totalPaid, expenses: rows };

    // Cache for 10 minutes
    await redis.setEx(cacheKey, 600, JSON.stringify(result));

    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};