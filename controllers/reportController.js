const db = require("../config/db");
const redis = require('../config/redis');

// ===== EXISTING HELPERS (keep as-is) =====
const calculateTotals = async (startDate, endDate, branch_id = null) => {
  let opsQuery = `
    SELECT 
      COALESCE(SUM(revenue), 0) as totalRevenue,
      COALESCE(SUM(sold_kg * cost_per_kg), 0) as totalCost,
      COALESCE(SUM(profit), 0) as totalProfit
    FROM daily_entries 
    WHERE date BETWEEN ? AND ?
  `;
  const opsParams = [startDate, endDate];

  if (branch_id) {
    opsQuery += ` AND branch_id = ?`;
    opsParams.push(branch_id);
  }

  const [opsRows] = await db.promise().execute(opsQuery, opsParams);
  const ops = opsRows[0];

  let expQuery = `
    SELECT COALESCE(SUM(amount), 0) as totalExpenses 
    FROM expenses 
    WHERE date BETWEEN ? AND ?
  `;
  const expParams = [startDate, endDate];

  if (branch_id) {
    expQuery += ` AND branch_id = ?`;
    expParams.push(branch_id);
  }

  const [expRows] = await db.promise().execute(expQuery, expParams);

  return {
    totalRevenue: parseFloat(ops.totalRevenue),
    totalCost: parseFloat(ops.totalCost),
    totalExpenses: parseFloat(expRows[0].totalExpenses),
    totalProfit: parseFloat(ops.totalProfit)
  };
};

// ===== EXISTING ENDPOINTS (keep as-is) =====

// LAST ENTRY REPORT
exports.getLastEntryReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const cacheKey = `report:last-entry:${branch_id || 'all'}`;

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
      return res.status(404).json({ message: "No data available" });
    }

    const lastEntry = rows[0];

    let expQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date = ?`;
    const expParams = [lastEntry.date];

    if (branch_id) {
      expQuery += ` AND branch_id = ?`;
      expParams.push(branch_id);
    }

    const [expRows] = await db.promise().execute(expQuery, expParams);
    const totalExpenses = parseFloat(expRows[0].total);
    const netMargin = parseFloat(lastEntry.revenue) - (parseFloat(lastEntry.sold_kg) * parseFloat(lastEntry.cost_per_kg)) - totalExpenses;

    const result = {
      date: lastEntry.date,
      totalRevenue: lastEntry.revenue,
      totalCost: parseFloat(lastEntry.sold_kg) * parseFloat(lastEntry.cost_per_kg),
      totalExpenses,
      netMargin,
      wasteKg: lastEntry.waste_kg,
      closingStockKg: lastEntry.closing_stock_kg
    };

    await redis.setEx(cacheKey, 300, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// LAST 7 DAYS REPORT
exports.getLast7DaysReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const cacheKey = `report:last-7-days:${branch_id || 'all'}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const totals = await calculateTotals(startDate, endDate, branch_id);

    const result = {
      period: "Last 7 Days",
      startDate,
      endDate,
      ...totals
    };

    await redis.setEx(cacheKey, 900, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// MONTH TO DATE REPORT
exports.getMonthToDateReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const cacheKey = `report:month-to-date:${branch_id || 'all'}`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return res.status(200).json(JSON.parse(cached));
    }

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1)
      .toISOString().split('T')[0];

    const totals = await calculateTotals(startDate, endDate, branch_id);

    const result = {
      period: "Month To Date",
      startDate,
      endDate,
      ...totals
    };

    await redis.setEx(cacheKey, 900, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ===== NEW ANALYTICS ENDPOINTS =====

// Cache helper
const cacheKey = (prefix, branch_id, params = '') => `report:${prefix}:${branch_id || 'all'}:${params}`;

// WASTE ANALYSIS
exports.getWasteAnalysis = async (req, res) => {
  try {
    const { branch_id, days = 7 } = req.query;
    const key = cacheKey('waste', branch_id, days);
    
    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(`
      SELECT 
        date,
        waste_kg,
        (waste_kg / NULLIF(opening_stock_kg + supply_kg, 0)) * 100 as waste_pct,
        waste_kg * cost_per_kg as waste_cost,
        opening_stock_kg + supply_kg as total_stock
      FROM daily_entries 
      WHERE branch_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY date DESC
    `, [branch_id || 1, parseInt(days)]);

    const avgWastePct = rows.length ? (rows.reduce((s, r) => s + parseFloat(r.waste_pct || 0), 0) / rows.length).toFixed(2) : 0;
    const totalWasteCost = rows.reduce((s, r) => s + parseFloat(r.waste_cost || 0), 0);
    
    const result = { data: rows, avgWastePct, totalWasteCost, days };
    await redis.setEx(key, 600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PAYMENT MIX
exports.getPaymentMix = async (req, res) => {
  try {
    const { branch_id, days = 7 } = req.query;
    const key = cacheKey('payment', branch_id, days);
    
    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(`
      SELECT 
        date,
        payment_cash,
        payment_mpesa,
        revenue,
        (payment_mpesa / NULLIF(revenue, 0)) * 100 as mpesa_pct
      FROM daily_entries 
      WHERE branch_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND revenue > 0
      ORDER BY date DESC
    `, [branch_id || 1, parseInt(days)]);

    const totals = rows.reduce((acc, r) => ({
      totalCash: acc.totalCash + parseFloat(r.payment_cash || 0),
      totalMpesa: acc.totalMpesa + parseFloat(r.payment_mpesa || 0),
      totalRevenue: acc.totalRevenue + parseFloat(r.revenue || 0)
    }), { totalCash: 0, totalMpesa: 0, totalRevenue: 0 });

    const avgMpesaPct = totals.totalRevenue ? ((totals.totalMpesa / totals.totalRevenue) * 100).toFixed(1) : 0;
    
    const result = { data: rows, ...totals, avgMpesaPct, days };
    await redis.setEx(key, 600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// PROFITABILITY TREND
exports.getProfitability = async (req, res) => {
  try {
    const { branch_id, days = 7 } = req.query;
    const key = cacheKey('profit', branch_id, days);
    
    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    const [daily] = await db.promise().execute(`
      SELECT 
        date,
        revenue,
        profit,
        (profit / NULLIF(revenue, 0)) * 100 as margin_pct,
        sold_kg
      FROM daily_entries 
      WHERE branch_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY date
    `, [branch_id || 1, parseInt(days)]);

    const [dow] = await db.promise().execute(`
      SELECT 
        DAYNAME(date) as day_name,
        AVG(revenue) as avg_revenue,
        AVG(profit) as avg_profit,
        AVG(sold_kg) as avg_sold,
        COUNT(*) as entry_count
      FROM daily_entries 
      WHERE branch_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DAYOFWEEK(date), DAYNAME(date)
      ORDER BY DAYOFWEEK(date)
    `, [branch_id || 1, parseInt(days)]);

    const result = { daily, dayOfWeek: dow, days };
    await redis.setEx(key, 600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// EXPENSE BREAKDOWN
exports.getExpenseBreakdown = async (req, res) => {
  try {
    const { branch_id, days = 7 } = req.query;
    const key = cacheKey('expense', branch_id, days);
    
    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(`
      SELECT 
        title,
        SUM(amount) as total,
        COUNT(*) as count,
        AVG(amount) as avg_amount
      FROM expenses 
      WHERE branch_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY title
      ORDER BY total DESC
    `, [branch_id || 1, parseInt(days)]);

    const grandTotal = rows.reduce((s, r) => s + parseFloat(r.total), 0);
    const withPct = rows.map(r => ({
      ...r,
      pct: grandTotal ? ((r.total / grandTotal) * 100).toFixed(1) : 0
    }));

    const result = { data: withPct, grandTotal, days };
    await redis.setEx(key, 600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// COMPARATIVE (This Month vs Last Month)
exports.getComparative = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const key = cacheKey('compare', branch_id);

    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    const [thisMonth] = await db.promise().execute(`
      SELECT 
        COALESCE(SUM(revenue), 0) as revenue, 
        COALESCE(SUM(profit), 0) as profit, 
        COALESCE(SUM(sold_kg), 0) as sold, 
        COALESCE(AVG(waste_kg), 0) as avg_waste
      FROM daily_entries 
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE()) 
        AND MONTH(date) = MONTH(CURDATE())
    `, [branch_id || 1]);

    const [lastMonth] = await db.promise().execute(`
      SELECT 
        COALESCE(SUM(revenue), 0) as revenue, 
        COALESCE(SUM(profit), 0) as profit, 
        COALESCE(SUM(sold_kg), 0) as sold, 
        COALESCE(AVG(waste_kg), 0) as avg_waste
      FROM daily_entries 
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE() - INTERVAL 1 MONTH) 
        AND MONTH(date) = MONTH(CURDATE() - INTERVAL 1 MONTH)
    `, [branch_id || 1]);

    const calcChange = (curr, prev) => prev ? (((curr - prev) / prev) * 100).toFixed(1) : 0;

    const result = {
      thisMonth: thisMonth[0],
      lastMonth: lastMonth[0],
      changes: {
        revenue: calcChange(parseFloat(thisMonth[0].revenue), parseFloat(lastMonth[0].revenue)),
        profit: calcChange(parseFloat(thisMonth[0].profit), parseFloat(lastMonth[0].profit)),
        sold: calcChange(parseFloat(thisMonth[0].sold), parseFloat(lastMonth[0].sold)),
        waste: calcChange(parseFloat(thisMonth[0].avg_waste), parseFloat(lastMonth[0].avg_waste))
      }
    };
    await redis.setEx(key, 900, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};