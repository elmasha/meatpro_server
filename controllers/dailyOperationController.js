const db = require("../config/db");
const redis = require('../config/redis');

// Helper: invalidate cache keys related to reports/stock
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

// ===== SINGLE DATE TOTALS HELPER =====
const calculateDateTotals = async (date, branch_id = null) => {
  let opsQuery = `
    SELECT 
      COALESCE(SUM(revenue), 0) as totalRevenue,
      COALESCE(SUM(payment_cash + payment_mpesa), 0) as totalActualRevenue,
      COALESCE(SUM(sold_kg * cost_per_kg), 0) as totalCost,
      COALESCE(SUM(profit), 0) as totalProfit
    FROM daily_entries 
    WHERE date = ?
  `;
  const opsParams = [date];

  if (branch_id) {
    opsQuery += ` AND branch_id = ?`;
    opsParams.push(branch_id);
  }

  const [opsRows] = await db.promise().execute(opsQuery, opsParams);
  const ops = opsRows[0];

  let expQuery = `
    SELECT COALESCE(SUM(amount), 0) as totalExpenses 
    FROM expenses 
    WHERE date = ?
  `;
  const expParams = [date];

  if (branch_id) {
    expQuery += ` AND branch_id = ?`;
    expParams.push(branch_id);
  }

  const [expRows] = await db.promise().execute(expQuery, expParams);

  return {
    totalRevenue: parseFloat(ops.totalRevenue),
    totalActualRevenue: parseFloat(ops.totalActualRevenue),
    totalCost: parseFloat(ops.totalCost),
    totalExpenses: parseFloat(expRows[0].totalExpenses),
    totalProfit: parseFloat(ops.totalProfit)
  };
};



// CREATE OR UPDATE DAILY ENTRY — FIXED
exports.createOrUpdateDailyOperation = async (req, res) => {
  try {
    const {
      branch_id,
      date,
      opening_stock_kg,
      supply_kg,
      waste_kg,
      closing_stock_kg,
      cost_per_kg,
      selling_price_per_kg,
      payment_cash,
      payment_mpesa
    } = req.body;

    if (!date || !branch_id) {
      return res.status(400).json({ message: "Date and branch_id are required" });
    }

    const opening = parseFloat(opening_stock_kg) || 0;
    const supply = parseFloat(supply_kg) || 0;
    const waste = parseFloat(waste_kg) || 0;
    const closing = parseFloat(closing_stock_kg) || 0;
    const cost = parseFloat(cost_per_kg) || 0;
    const sellPrice = parseFloat(selling_price_per_kg) || 0;
    const cash = parseFloat(payment_cash) || 0;
    const mpesa = parseFloat(payment_mpesa) || 0;

    const sold_kg = opening + supply - waste - closing;
    const expected_revenue = sold_kg * sellPrice;     // What stock says you should make
    const actual_revenue = cash + mpesa;              // ✅ REAL MONEY you collected
    const cogs = sold_kg * cost;                      // Cost of goods sold

    // Fetch REAL expenses from expenses table for this date
    let total_expenses = 0;
    try {
      const [expRows] = await db.promise().execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date = ? AND branch_id = ?`,
        [date, branch_id]
      );
      total_expenses = parseFloat(expRows[0].total) || 0;
    } catch (e) {
      total_expenses = 0;
    }

    const profit = actual_revenue - cogs - total_expenses;         // ✅ REAL PROFIT
    const expected_profit = expected_revenue - cogs - total_expenses;

    if (sold_kg < 0) {
      return res.status(400).json({ 
        message: "Invalid stock figures: sold kg cannot be negative",
        sold_kg
      });
    }

    const query = `
      INSERT INTO daily_entries 
        (branch_id, date, opening_stock_kg, supply_kg, waste_kg, sold_kg,
         closing_stock_kg, cost_per_kg, selling_price_per_kg, revenue,
         expenses, profit, payment_cash, payment_mpesa)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        opening_stock_kg = VALUES(opening_stock_kg),
        supply_kg = VALUES(supply_kg),
        waste_kg = VALUES(waste_kg),
        sold_kg = VALUES(sold_kg),
        closing_stock_kg = VALUES(closing_stock_kg),
        cost_per_kg = VALUES(cost_per_kg),
        selling_price_per_kg = VALUES(selling_price_per_kg),
        revenue = VALUES(revenue),
        expenses = VALUES(expenses),
        profit = VALUES(profit),
        payment_cash = VALUES(payment_cash),
        payment_mpesa = VALUES(payment_mpesa)
    `;

    await db.promise().execute(query, [
      branch_id, date, opening, supply, waste, sold_kg,
      closing, cost, sellPrice, expected_revenue,
      total_expenses, profit, cash, mpesa
    ]);

    // Invalidate cached reports since data changed
    await invalidateDailyCache(branch_id, date);

    res.status(200).json({
      message: "Daily operation saved successfully",
      data: { 
        branch_id, 
        date, 
        sold_kg, 
        expected_revenue, 
        actual_revenue, 
        cogs, 
        total_expenses, 
        profit,
        expected_profit 
      }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};


// GET LAST ENTRY — FIXED
exports.getLastEntry = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const cacheKey = `daily:last-entry:${branch_id || 'all'}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    let query = `SELECT * FROM daily_entries ORDER BY date DESC, id DESC LIMIT 1`;
    const params = [];

    if (branch_id) {
      query = `SELECT * FROM daily_entries WHERE branch_id = ? ORDER BY date DESC, id DESC LIMIT 1`;
      params.push(branch_id);
    }

    const [rows] = await db.promise().execute(query, params);

    if (rows.length === 0) {
      return res.status(404).json({ message: "No entries found" });
    }

    const entry = rows[0];

    // ===== CALCULATE ACTUAL REVENUE & PROFIT =====
    const expectedRevenue = parseFloat(entry.revenue) || 0;
    const paymentCash = parseFloat(entry.payment_cash) || 0;
    const paymentMpesa = parseFloat(entry.payment_mpesa) || 0;
    const actualRevenue = paymentCash + paymentMpesa;
    const cogs = (parseFloat(entry.sold_kg) || 0) * (parseFloat(entry.cost_per_kg) || 0);

    // Fetch actual expenses for this date from expenses table
    let totalExpenses = 0;
    try {
      const [expRows] = await db.promise().execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date = ? AND branch_id = ?`,
        [entry.date, entry.branch_id]
      );
      totalExpenses = parseFloat(expRows[0].total) || 0;
    } catch (e) {
      totalExpenses = 0;
    }

    const actualProfit = actualRevenue - cogs - totalExpenses;
    const expectedProfit = expectedRevenue - cogs - totalExpenses;
    const revenueVariance = expectedRevenue - actualRevenue;
    const marginPct = actualRevenue > 0 ? ((actualProfit / actualRevenue) * 100).toFixed(1) : 0;

    const result = {
      ...entry,
      // Actual (real money)
      actualRevenue,
      actualProfit,
      marginPct: parseFloat(marginPct),
      // Expected (stock math)
      expectedRevenue,
      expectedProfit,
      // Breakdown
      revenueVariance,
      paymentCash,
      paymentMpesa,
      cogs,
      totalExpenses,
      // Backward compat
      totalRevenue: actualRevenue,
      netMargin: actualProfit,
    };

    await redis.setEx(cacheKey, 300, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET ENTRY BY DATE — FIXED
exports.getEntryByDate = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const { date } = req.params;

    if (!date || !branch_id) {
      return res.status(400).json({ message: "Date and branch_id are required" });
    }

    const query = `SELECT * FROM daily_entries WHERE date = ? AND branch_id = ?`;
    const [rows] = await db.promise().execute(query, [date, branch_id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "No entry found for this date" });
    }

    const entry = rows[0];

    const expectedRevenue = parseFloat(entry.revenue) || 0;
    const paymentCash = parseFloat(entry.payment_cash) || 0;
    const paymentMpesa = parseFloat(entry.payment_mpesa) || 0;
    const actualRevenue = paymentCash + paymentMpesa;
    const cogs = (parseFloat(entry.sold_kg) || 0) * (parseFloat(entry.cost_per_kg) || 0);

    let totalExpenses = 0;
    try {
      const [expRows] = await db.promise().execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date = ? AND branch_id = ?`,
        [date, branch_id]
      );
      totalExpenses = parseFloat(expRows[0].total) || 0;
    } catch (e) {
      totalExpenses = 0;
    }

    const actualProfit = actualRevenue - cogs - totalExpenses;
    const expectedProfit = expectedRevenue - cogs - totalExpenses;
    const revenueVariance = expectedRevenue - actualRevenue;
    const marginPct = actualRevenue > 0 ? ((actualProfit / actualRevenue) * 100).toFixed(1) : 0;

    const result = {
      ...entry,
      actualRevenue,
      actualProfit,
      marginPct: parseFloat(marginPct),
      expectedRevenue,
      expectedProfit,
      revenueVariance,
      paymentCash,
      paymentMpesa,
      cogs,
      totalExpenses,
      totalRevenue: actualRevenue,
      netMargin: actualProfit,
    };

    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET DATE TOTALS
exports.getDateTotals = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const { date } = req.params;

    if (!date || !branch_id) {
      return res.status(400).json({ message: "Date and branch_id are required" });
    }

    const totals = await calculateDateTotals(date, branch_id);

    res.status(200).json(totals);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};