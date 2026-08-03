const db = require("../config/db");
const redis = require('../config/redis');

// ===== EXISTING HELPERS (keep as-is) =====
const calculateTotals = async (startDate, endDate, branch_id = null) => {
  let opsQuery = `
    SELECT 
      COALESCE(SUM(revenue), 0) as totalRevenue,
      COALESCE(SUM(payment_cash + payment_mpesa), 0) as totalActualRevenue,
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
    totalActualRevenue: parseFloat(ops.totalActualRevenue),
    totalCost: parseFloat(ops.totalCost),
    totalExpenses: parseFloat(expRows[0].totalExpenses),
    totalProfit: parseFloat(ops.totalProfit)
  };
};

// ===== FORMATTER =====
const fmt = (n) => {
  const v = parseFloat(n);
  return isNaN(v) ? 0 : Math.round(v * 100) / 100;
};

// Cache helper
const cacheKey = (prefix, branch_id, params = '') => `report:${prefix}:${branch_id || 'all'}:${params}`;

// ===== EXISTING ENDPOINTS (UPDATED WITH ACTUAL/EXPECTED) =====

// LAST ENTRY REPORT — KEEP EXACTLY AS-IS (already working)
exports.getLastEntryReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const key = `report:last-entry:${branch_id || 'all'}`;

    const cached = await redis.get(key);
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

    const expectedRevenue = parseFloat(lastEntry.revenue) || 0;
    const paymentCash = parseFloat(lastEntry.payment_cash) || 0;
    const paymentMpesa = parseFloat(lastEntry.payment_mpesa) || 0;
    const actualRevenue = paymentCash + paymentMpesa;
    const totalCost = parseFloat(lastEntry.sold_kg) * parseFloat(lastEntry.cost_per_kg);
    const expectedMargin = expectedRevenue - totalCost - totalExpenses;
    const actualMargin = actualRevenue - totalCost - totalExpenses;
    const revenueVariance = expectedRevenue - actualRevenue;

    const result = {
      date: lastEntry.date,
      expectedRevenue: fmt(expectedRevenue),
      actualRevenue: fmt(actualRevenue),
      paymentCash: fmt(paymentCash),
      paymentMpesa: fmt(paymentMpesa),
      revenueVariance: fmt(revenueVariance),
      totalCost: fmt(totalCost),
      totalExpenses: fmt(totalExpenses),
      expectedMargin: fmt(expectedMargin),
      actualMargin: fmt(actualMargin),
      wasteKg: lastEntry.waste_kg,
      closingStockKg: lastEntry.closing_stock_kg,
      soldKg: fmt(lastEntry.sold_kg),
      sellingPricePerKg: fmt(lastEntry.selling_price_per_kg),
      costPerKg: fmt(lastEntry.cost_per_kg)
    };

    await redis.setEx(key, 300, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// LAST 7 DAYS REPORT
exports.getLast7DaysReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const key = `report:last-7-days:${branch_id || 'all'}`;

    const cached = await redis.get(key);
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

    await redis.setEx(key, 900, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// MONTH TO DATE REPORT
exports.getMonthToDateReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const key = `report:month-to-date:${branch_id || 'all'}`;

    const cached = await redis.get(key);
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

    await redis.setEx(key, 900, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ===== NEW / UPDATED ANALYTICS ENDPOINTS =====

// WASTE ANALYSIS
exports.getWasteAnalysis = async (req, res) => {
  try {
    const { branch_id, days = 7 } = req.query;
    const key = cacheKey('waste', branch_id, days);

    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    const [rows] = await db.promise().execute(`
      SELECT 
        de.date,
        de.waste_kg,
        (de.waste_kg / NULLIF(de.opening_stock_kg + de.supply_kg, 0)) * 100 as waste_pct,
        de.waste_kg * de.cost_per_kg as waste_cost,
        de.opening_stock_kg + de.supply_kg as total_stock,
        COALESCE(de.payment_cash + de.payment_mpesa, 0) as actual_revenue,
        de.revenue as expected_revenue
      FROM daily_entries de
      WHERE de.branch_id = ? AND de.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY de.date DESC
    `, [branch_id || 1, parseInt(days)]);

    const avgWastePct = rows.length ? (rows.reduce((s, r) => s + parseFloat(r.waste_pct || 0), 0) / rows.length).toFixed(2) : 0;
    const totalWasteCost = rows.reduce((s, r) => s + parseFloat(r.waste_cost || 0), 0);

    const result = { 
      data: rows.map(r => ({...r, actual_revenue: fmt(r.actual_revenue), expected_revenue: fmt(r.expected_revenue)})), 
      avgWastePct, 
      totalWasteCost, 
      days 
    };
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
        COALESCE(payment_cash, 0) as payment_cash,
        COALESCE(payment_mpesa, 0) as payment_mpesa,
        COALESCE(revenue, 0) as expected_revenue,
        COALESCE(payment_cash + payment_mpesa, 0) as actual_revenue
      FROM daily_entries 
      WHERE branch_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND (revenue > 0 OR payment_cash > 0 OR payment_mpesa > 0)
      ORDER BY date DESC
    `, [branch_id || 1, parseInt(days)]);

    let totalCash = 0;
    let totalMpesa = 0;
    let totalExpected = 0;
    let totalActual = 0;

    const data = rows.map(r => {
      const cash = parseFloat(r.payment_cash) || 0;
      const mpesa = parseFloat(r.payment_mpesa) || 0;
      const actual = cash + mpesa;
      const expected = parseFloat(r.expected_revenue) || 0;
      totalCash += cash;
      totalMpesa += mpesa;
      totalExpected += expected;
      totalActual += actual;

      return {
        date: r.date,
        payment_cash: fmt(cash),
        payment_mpesa: fmt(mpesa),
        expected_revenue: fmt(expected),
        actual_revenue: fmt(actual),
        revenue_variance: fmt(expected - actual),
        mpesa_pct: actual > 0 ? fmt((mpesa / actual) * 100) : 0,
        cash_pct: actual > 0 ? fmt((cash / actual) * 100) : 0,
      };
    });

    const avgMpesaPct = totalActual > 0 ? fmt((totalMpesa / totalActual) * 100) : 0;

    const result = {
      data,
      totalCash: fmt(totalCash),
      totalMpesa: fmt(totalMpesa),
      totalRevenue: fmt(totalExpected),        // backward compat
      totalActualRevenue: fmt(totalActual),
      totalExpectedRevenue: fmt(totalExpected),
      revenueVariance: fmt(totalExpected - totalActual),
      avgMpesaPct,
      days
    };
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
        de.date,
        COALESCE(de.revenue, 0) as expected_revenue,
        COALESCE(de.payment_cash + de.payment_mpesa, 0) as actual_revenue,
        COALESCE(de.profit, 0) as expected_profit,
        COALESCE(de.sold_kg * de.cost_per_kg, 0) as total_cost,
        COALESCE(de.sold_kg, 0) as sold_kg,
        COALESCE(de.waste_kg, 0) as waste_kg,
        COALESCE(e.daily_expenses, 0) as daily_expenses
      FROM daily_entries de
      LEFT JOIN (
        SELECT date, COALESCE(SUM(amount), 0) as daily_expenses
        FROM expenses
        WHERE branch_id = ?
        GROUP BY date
      ) e ON de.date = e.date
      WHERE de.branch_id = ? AND de.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY de.date DESC
    `, [branch_id || 1, branch_id || 1, parseInt(days)]);

    const dailyWithActual = daily.map(r => {
      const actualRevenue = parseFloat(r.actual_revenue) || 0;
      const totalCost = parseFloat(r.total_cost) || 0;
      const dailyExpenses = parseFloat(r.daily_expenses) || 0;
      const actualProfit = actualRevenue - totalCost - dailyExpenses;
      const expectedRevenue = parseFloat(r.expected_revenue) || 0;
      const expectedProfit = parseFloat(r.expected_profit) || 0;

      return {
        date: r.date,
        expected_revenue: fmt(expectedRevenue),
        actual_revenue: fmt(actualRevenue),
        total_cost: fmt(totalCost),
        daily_expenses: fmt(dailyExpenses),
        expected_profit: fmt(expectedProfit),
        actual_profit: fmt(actualProfit),
        expected_margin_pct: expectedRevenue > 0 ? fmt((expectedProfit / expectedRevenue) * 100) : 0,
        actual_margin_pct: actualRevenue > 0 ? fmt((actualProfit / actualRevenue) * 100) : 0,
        sold_kg: fmt(r.sold_kg),
        waste_kg: fmt(r.waste_kg),
        // backward compat
        revenue: fmt(expectedRevenue),
        profit: fmt(expectedProfit),
        margin_pct: expectedRevenue > 0 ? fmt((expectedProfit / expectedRevenue) * 100) : 0,
      };
    });

    const [dow] = await db.promise().execute(`
      SELECT 
        DAYNAME(date) as day_name,
        AVG(revenue) as avg_revenue,
        AVG(payment_cash + payment_mpesa) as avg_actual_revenue,
        AVG(profit) as avg_profit,
        AVG(profit + (payment_cash + payment_mpesa - revenue)) as avg_actual_profit,
        AVG(sold_kg) as avg_sold,
        COUNT(*) as entry_count
      FROM daily_entries 
      WHERE branch_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      GROUP BY DAYOFWEEK(date), DAYNAME(date)
      ORDER BY DAYOFWEEK(date)
    `, [branch_id || 1, parseInt(days)]);

    const result = { daily: dailyWithActual, dayOfWeek: dow, days };
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
      pct: grandTotal ? fmt((r.total / grandTotal) * 100) : 0
    }));

    const result = { data: withPct, grandTotal: fmt(grandTotal), days };
    await redis.setEx(key, 600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// COMPARATIVE (This Month vs Last Month) — FULLY UPDATED
exports.getComparative = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const key = cacheKey('compare', branch_id);

    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    // This month
    const [thisMonthRows] = await db.promise().execute(`
      SELECT 
        COALESCE(SUM(revenue), 0) as expected_revenue, 
        COALESCE(SUM(payment_cash + payment_mpesa), 0) as actual_revenue,
        COALESCE(SUM(profit), 0) as expected_profit, 
        COALESCE(SUM(sold_kg * cost_per_kg), 0) as total_cost,
        COALESCE(SUM(sold_kg), 0) as sold, 
        COALESCE(AVG(waste_kg), 0) as avg_waste
      FROM daily_entries 
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE()) 
        AND MONTH(date) = MONTH(CURDATE())
    `, [branch_id || 1]);

    // Last month
    const [lastMonthRows] = await db.promise().execute(`
      SELECT 
        COALESCE(SUM(revenue), 0) as expected_revenue, 
        COALESCE(SUM(payment_cash + payment_mpesa), 0) as actual_revenue,
        COALESCE(SUM(profit), 0) as expected_profit, 
        COALESCE(SUM(sold_kg * cost_per_kg), 0) as total_cost,
        COALESCE(SUM(sold_kg), 0) as sold, 
        COALESCE(AVG(waste_kg), 0) as avg_waste
      FROM daily_entries 
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE() - INTERVAL 1 MONTH) 
        AND MONTH(date) = MONTH(CURDATE() - INTERVAL 1 MONTH)
    `, [branch_id || 1]);

    // Expenses for actual profit calculation
    const [thisMonthExp] = await db.promise().execute(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE()) 
        AND MONTH(date) = MONTH(CURDATE())
    `, [branch_id || 1]);

    const [lastMonthExp] = await db.promise().execute(`
      SELECT COALESCE(SUM(amount), 0) as total FROM expenses
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE() - INTERVAL 1 MONTH) 
        AND MONTH(date) = MONTH(CURDATE() - INTERVAL 1 MONTH)
    `, [branch_id || 1]);

    const thisExp = parseFloat(thisMonthExp[0]?.total) || 0;
    const lastExp = parseFloat(lastMonthExp[0]?.total) || 0;

    const thisMonth = {
      expected_revenue: fmt(thisMonthRows[0].expected_revenue),
      actual_revenue: fmt(thisMonthRows[0].actual_revenue),
      total_cost: fmt(thisMonthRows[0].total_cost),
      expected_profit: fmt(thisMonthRows[0].expected_profit),
      actual_profit: fmt(parseFloat(thisMonthRows[0].actual_revenue) - parseFloat(thisMonthRows[0].total_cost) - thisExp),
      sold: fmt(thisMonthRows[0].sold),
      avg_waste: fmt(thisMonthRows[0].avg_waste),
      expenses: fmt(thisExp),
      // backward compatibility
      revenue: fmt(thisMonthRows[0].expected_revenue),
      profit: fmt(thisMonthRows[0].expected_profit),
    };

    const lastMonth = {
      expected_revenue: fmt(lastMonthRows[0].expected_revenue),
      actual_revenue: fmt(lastMonthRows[0].actual_revenue),
      total_cost: fmt(lastMonthRows[0].total_cost),
      expected_profit: fmt(lastMonthRows[0].expected_profit),
      actual_profit: fmt(parseFloat(lastMonthRows[0].actual_revenue) - parseFloat(lastMonthRows[0].total_cost) - lastExp),
      sold: fmt(lastMonthRows[0].sold),
      avg_waste: fmt(lastMonthRows[0].avg_waste),
      expenses: fmt(lastExp),
      // backward compatibility
      revenue: fmt(lastMonthRows[0].expected_revenue),
      profit: fmt(lastMonthRows[0].expected_profit),
    };

    const calcChange = (curr, prev) => prev ? fmt(((curr - prev) / prev) * 100) : 0;

    const result = {
      thisMonth,
      lastMonth,
      changes: {
        expected_revenue: calcChange(thisMonth.expected_revenue, lastMonth.expected_revenue),
        actual_revenue: calcChange(thisMonth.actual_revenue, lastMonth.actual_revenue),
        expected_profit: calcChange(thisMonth.expected_profit, lastMonth.expected_profit),
        actual_profit: calcChange(thisMonth.actual_profit, lastMonth.actual_profit),
        sold: calcChange(thisMonth.sold, lastMonth.sold),
        waste: calcChange(thisMonth.avg_waste, lastMonth.avg_waste),
        // backward compatibility
        revenue: calcChange(thisMonth.revenue, lastMonth.revenue),
        profit: calcChange(thisMonth.profit, lastMonth.profit),
      }
    };
    await redis.setEx(key, 900, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ===== BRANCHES LIST =====
exports.getBranches = async (req, res) => {
  try {
    const [rows] = await db.promise().execute(`
      SELECT b.id, b.name, bus.name as business_name 
      FROM branches b
      JOIN businesses bus ON b.business_id = bus.id
      ORDER BY b.name
    `);
    res.json({ data: rows });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ===== CLEAR CACHE =====
exports.clearCache = async (req, res) => {
  try {
    await redis.flushDb();
    res.json({ message: 'Cache cleared' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};