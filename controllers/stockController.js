const db = require("../config/db");
const redis = require('../config/redis');

exports.getCurrentStock = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const cacheKey = `stock:current:${branch_id || 'all'}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    let query = `SELECT date, closing_stock_kg, waste_kg, sold_kg FROM daily_entries ORDER BY date DESC, id DESC LIMIT 1`;
    const params = [];

    if (branch_id) {
      query = `SELECT date, closing_stock_kg, waste_kg, sold_kg FROM daily_entries WHERE branch_id = ? ORDER BY date DESC, id DESC LIMIT 1`;
      params.push(branch_id);
    }

    const [rows] = await db.promise().execute(query, params);

    if (rows.length === 0) {
      return res.status(404).json({ message: "No stock data found" });
    }

    // Cache for 5 minutes
    await redis.setEx(cacheKey, 300, JSON.stringify(rows[0]));

    res.status(200).json(rows[0]);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};