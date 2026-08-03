const db = require("../config/db");
const redis = require('../config/redis');

// ===== HELPERS =====
const calculateTotals = async (startDate, endDate, branch_id = null) => {
  let opsQuery = `
    SELECT 
      COALESCE(SUM(revenue), 0) as totalRevenue,
      COALESCE(SUM(payment_cash + payment_mpesa), 0) as totalActualRevenue,
      COALESCE(SUM(sold_kg * cost_per_kg), 0) as totalCost,
      COALESCE(SUM(profit), 0) as totalProfit,
      COALESCE(SUM(sold_kg), 0) as totalSold,
      COALESCE(AVG(waste_kg), 0) as avgWaste
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
    totalRevenue: parseFloat(ops.totalRevenue) || 0,
    totalActualRevenue: parseFloat(ops.totalActualRevenue) || 0,
    totalCost: parseFloat(ops.totalCost) || 0,
    totalExpenses: parseFloat(expRows[0].totalExpenses) || 0,
    totalProfit: parseFloat(ops.totalProfit) || 0,
    totalSold: parseFloat(ops.totalSold) || 0,
    avgWaste: parseFloat(ops.avgWaste) || 0
  };
};

const cacheKey = (prefix, branch_id, params = '') => `report:${prefix}:${branch_id || 'all'}:${params}`;

// ===== LAST ENTRY REPORT =====
exports.getLastEntryReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const cacheKeyStr = `report:last-entry:${branch_id || 'all'}`;

    const cached = await redis.get(cacheKeyStr);
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
    const totalExpenses = parseFloat(expRows[0].total) || 0;

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
      expectedRevenue,
      actualRevenue,
      paymentCash,
      paymentMpesa,
      revenueVariance,
      totalCost,
      totalExpenses,
      expectedMargin,
      actualMargin,
      wasteKg: lastEntry.waste_kg,
      closingStockKg: lastEntry.closing_stock_kg,
      soldKg: parseFloat(lastEntry.sold_kg),
      sellingPricePerKg: parseFloat(lastEntry.selling_price_per_kg),
      costPerKg: parseFloat(lastEntry.cost_per_kg)
    };

    await redis.setEx(cacheKeyStr, 300, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// LAST 7 DAYS REPORT
exports.getLast7DaysReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const cacheKeyStr = `report:last-7-days:${branch_id || 'all'}`;

    const cached = await redis.get(cacheKeyStr);
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

    await redis.setEx(cacheKeyStr, 900, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// MONTH TO DATE REPORT
exports.getMonthToDateReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const cacheKeyStr = `report:month-to-date:${branch_id || 'all'}`;

    const cached = await redis.get(cacheKeyStr);
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

    await redis.setEx(cacheKeyStr, 900, JSON.stringify(result));
    res.status(200).json(result);

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ===== WASTE ANALYSIS =====
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

// ===== PAYMENT MIX =====
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
        (payment_cash + payment_mpesa) as actual_revenue,
        revenue as expected_revenue,
        (payment_mpesa / NULLIF(payment_cash + payment_mpesa, 0)) * 100 as mpesa_pct
      FROM daily_entries 
      WHERE branch_id = ? AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY) AND (payment_cash + payment_mpesa) > 0
      ORDER BY date DESC
    `, [branch_id || 1, parseInt(days)]);

    const totals = rows.reduce((acc, r) => ({
      totalCash: acc.totalCash + parseFloat(r.payment_cash || 0),
      totalMpesa: acc.totalMpesa + parseFloat(r.payment_mpesa || 0),
      totalActualRevenue: acc.totalActualRevenue + parseFloat(r.actual_revenue || 0),
      totalExpectedRevenue: acc.totalExpectedRevenue + parseFloat(r.expected_revenue || 0)
    }), { totalCash: 0, totalMpesa: 0, totalActualRevenue: 0, totalExpectedRevenue: 0 });

    const avgMpesaPct = totals.totalActualRevenue ? ((totals.totalMpesa / totals.totalActualRevenue) * 100).toFixed(1) : 0;
    const revenueVariance = totals.totalExpectedRevenue - totals.totalActualRevenue;

    const result = { 
      data: rows, 
      ...totals, 
      avgMpesaPct, 
      revenueVariance,
      days 
    };
    await redis.setEx(key, 600, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ===== PROFITABILITY TREND =====
exports.getProfitability = async (req, res) => {
  try {
    const { branch_id, days = 7 } = req.query;
    const key = cacheKey('profit', branch_id, days);

    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    // First, get daily entries with expenses joined
    const [daily] = await db.promise().execute(`
      SELECT 
        de.date,
        de.revenue as expected_revenue,
        (de.payment_cash + de.payment_mpesa) as actual_revenue,
        de.profit as expected_profit,
        de.sold_kg,
        de.cost_per_kg,
        de.payment_cash,
        de.payment_mpesa,
        COALESCE(e.total_expenses, 0) as daily_expenses
      FROM daily_entries de
      LEFT JOIN (
        SELECT date, SUM(amount) as total_expenses 
        FROM expenses 
        WHERE branch_id = ? 
        GROUP BY date
      ) e ON de.date = e.date
      WHERE de.branch_id = ? AND de.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      ORDER BY de.date
    `, [branch_id || 1, branch_id || 1, parseInt(days)]);

    // Calculate actual profit with expenses
    const dailyWithActual = daily.map(d => {
      const actualRevenue = parseFloat(d.actual_revenue) || 0;
      const cogs = parseFloat(d.sold_kg || 0) * parseFloat(d.cost_per_kg || 0);
      const expenses = parseFloat(d.daily_expenses) || 0;
      const actualProfit = actualRevenue - cogs - expenses;
      const expectedProfit = parseFloat(d.expected_profit) || 0;
      const actualMarginPct = actualRevenue ? ((actualProfit / actualRevenue) * 100) : 0;
      const expectedMarginPct = d.expected_revenue ? ((expectedProfit / d.expected_revenue) * 100) : 0;

      return {
        date: d.date,
        expected_revenue: parseFloat(d.expected_revenue) || 0,
        actual_revenue: actualRevenue,
        expected_profit: expectedProfit,
        actual_profit: actualProfit,
        expected_margin_pct: expectedMarginPct.toFixed(1),
        actual_margin_pct: actualMarginPct.toFixed(1),
        sold_kg: parseFloat(d.sold_kg) || 0,
        payment_cash: parseFloat(d.payment_cash) || 0,
        payment_mpesa: parseFloat(d.payment_mpesa) || 0,
        cogs: cogs,
        expenses: expenses
      };
    });

    // Day of week analysis
    const [dow] = await db.promise().execute(`
      SELECT 
        DAYNAME(date) as day_name,
        AVG(payment_cash + payment_mpesa) as avg_actual_revenue,
        AVG(revenue) as avg_expected_revenue,
        AVG(payment_cash + payment_mpesa - (sold_kg * cost_per_kg)) as avg_actual_profit,
        AVG(profit) as avg_expected_profit,
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

// ===== EXPENSE BREAKDOWN =====
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

// ===== COMPARATIVE (This Month vs Last Month) =====
exports.getComparative = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const key = cacheKey('compare', branch_id);

    const cached = await redis.get(key);
    if (cached) return res.json(JSON.parse(cached));

    // This month
    const [thisMonth] = await db.promise().execute(`
      SELECT 
        COALESCE(SUM(revenue), 0) as expected_revenue,
        COALESCE(SUM(payment_cash + payment_mpesa), 0) as actual_revenue,
        COALESCE(SUM(profit), 0) as expected_profit,
        COALESCE(SUM(payment_cash + payment_mpesa - (sold_kg * cost_per_kg)), 0) as raw_actual_profit,
        COALESCE(SUM(sold_kg), 0) as sold, 
        COALESCE(AVG(waste_kg), 0) as avg_waste
      FROM daily_entries 
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE()) 
        AND MONTH(date) = MONTH(CURDATE())
    `, [branch_id || 1]);

    // Last month
    const [lastMonth] = await db.promise().execute(`
      SELECT 
        COALESCE(SUM(revenue), 0) as expected_revenue,
        COALESCE(SUM(payment_cash + payment_mpesa), 0) as actual_revenue,
        COALESCE(SUM(profit), 0) as expected_profit,
        COALESCE(SUM(payment_cash + payment_mpesa - (sold_kg * cost_per_kg)), 0) as raw_actual_profit,
        COALESCE(SUM(sold_kg), 0) as sold, 
        COALESCE(AVG(waste_kg), 0) as avg_waste
      FROM daily_entries 
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE() - INTERVAL 1 MONTH) 
        AND MONTH(date) = MONTH(CURDATE() - INTERVAL 1 MONTH)
    `, [branch_id || 1]);

    // Expenses for both months
    const [thisMonthExp] = await db.promise().execute(`
      SELECT COALESCE(SUM(amount), 0) as total_expenses
      FROM expenses
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE()) 
        AND MONTH(date) = MONTH(CURDATE())
    `, [branch_id || 1]);

    const [lastMonthExp] = await db.promise().execute(`
      SELECT COALESCE(SUM(amount), 0) as total_expenses
      FROM expenses
      WHERE branch_id = ? 
        AND YEAR(date) = YEAR(CURDATE() - INTERVAL 1 MONTH) 
        AND MONTH(date) = MONTH(CURDATE() - INTERVAL 1 MONTH)
    `, [branch_id || 1]);

    const thisMonthExpenses = parseFloat(thisMonthExp[0].total_expenses) || 0;
    const lastMonthExpenses = parseFloat(lastMonthExp[0].total_expenses) || 0;

    const calcChange = (curr, prev) => {
      const c = parseFloat(curr) || 0;
      const p = parseFloat(prev) || 0;
      return p ? (((c - p) / p) * 100).toFixed(1) : 0;
    };

    const thisRawProfit = parseFloat(thisMonth[0].raw_actual_profit) || 0;
    const lastRawProfit = parseFloat(lastMonth[0].raw_actual_profit) || 0;
    const thisActualProfit = thisRawProfit - thisMonthExpenses;
    const lastActualProfit = lastRawProfit - lastMonthExpenses;

    const result = {
      thisMonth: {
        expected_revenue: parseFloat(thisMonth[0].expected_revenue) || 0,
        actual_revenue: parseFloat(thisMonth[0].actual_revenue) || 0,
        expected_profit: parseFloat(thisMonth[0].expected_profit) || 0,
        actual_profit: thisActualProfit,
        sold: parseFloat(thisMonth[0].sold) || 0,
        avg_waste: parseFloat(thisMonth[0].avg_waste) || 0,
        expenses: thisMonthExpenses
      },
      lastMonth: {
        expected_revenue: parseFloat(lastMonth[0].expected_revenue) || 0,
        actual_revenue: parseFloat(lastMonth[0].actual_revenue) || 0,
        expected_profit: parseFloat(lastMonth[0].expected_profit) || 0,
        actual_profit: lastActualProfit,
        sold: parseFloat(lastMonth[0].sold) || 0,
        avg_waste: parseFloat(lastMonth[0].avg_waste) || 0,
        expenses: lastMonthExpenses
      },
      changes: {
        expected_revenue: calcChange(thisMonth[0].expected_revenue, lastMonth[0].expected_revenue),
        actual_revenue: calcChange(thisMonth[0].actual_revenue, lastMonth[0].actual_revenue),
        expected_profit: calcChange(thisMonth[0].expected_profit, lastMonth[0].expected_profit),
        actual_profit: calcChange(thisActualProfit, lastActualProfit),
        sold: calcChange(thisMonth[0].sold, lastMonth[0].sold),
        waste: calcChange(thisMonth[0].avg_waste, lastMonth[0].avg_waste)
      }
    };

    await redis.setEx(key, 900, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};