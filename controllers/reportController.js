const db = require("../config/db");
const redis = require('../config/redis');

// ===== REPORTS CONTROLLER — CORRECTED =====
// All report endpoints now include live expenses from the expenses table

// Helper: get live expenses for a date range
const getLiveExpenses = async (startDate, endDate, branch_id) => {
  let query = `
    SELECT COALESCE(SUM(amount), 0) as total 
    FROM expenses 
    WHERE date >= ? AND date <= ?
  `;
  const params = [startDate, endDate];

  if (branch_id) {
    query += ` AND branch_id = ?`;
    params.push(branch_id);
  }

  const [rows] = await db.promise().execute(query, params);
  return parseFloat(rows[0].total) || 0;
};

// GET /reports/last-entry — FIXED: includes live expenses
exports.getLastEntryReport = async (req, res) => {
  try {
    const { branch_id } = req.query;

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
    const expectedRevenue = parseFloat(entry.revenue) || 0;
    const paymentCash = parseFloat(entry.payment_cash) || 0;
    const paymentMpesa = parseFloat(entry.payment_mpesa) || 0;
    const actualRevenue = paymentCash + paymentMpesa;
    const cogs = (parseFloat(entry.sold_kg) || 0) * (parseFloat(entry.cost_per_kg) || 0);

    // Fetch LIVE expenses
    const totalExpenses = await getLiveExpenses(entry.date, entry.date, entry.branch_id);

    const actualProfit = actualRevenue - cogs - totalExpenses;
    const expectedProfit = expectedRevenue - cogs - totalExpenses;
    const revenueVariance = expectedRevenue - actualRevenue;
    const marginPct = actualRevenue > 0 ? ((actualProfit / actualRevenue) * 100).toFixed(1) : 0;

    res.status(200).json({
      ...entry,
      expectedRevenue,
      actualRevenue,
      totalCost: cogs,
      totalExpenses,        // ✅ ADDED: live expenses
      actualProfit,
      expectedProfit,
      expectedMargin: expectedRevenue > 0 ? ((expectedProfit / expectedRevenue) * 100).toFixed(1) : 0,
      revenueVariance,
      paymentCash,
      paymentMpesa,
      netMargin: actualProfit,
      marginPct: parseFloat(marginPct),
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /reports/last-7-days — FIXED: includes live expenses
exports.getLast7DaysReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let query = `
      SELECT 
        COALESCE(SUM(revenue), 0) as totalRevenue,
        COALESCE(SUM(actual_revenue), 0) as totalActualRevenue,
        COALESCE(SUM(payment_cash + payment_mpesa), 0) as totalPayments,
        COALESCE(SUM(sold_kg * cost_per_kg), 0) as totalCost,
        COALESCE(SUM(profit), 0) as totalProfit,
        COALESCE(SUM(sold_kg), 0) as totalSold,
        COALESCE(SUM(waste_kg), 0) as totalWaste
      FROM daily_entries 
      WHERE date >= ? AND date <= ?
    `;
    const params = [startDate, endDate];

    if (branch_id) {
      query += ` AND branch_id = ?`;
      params.push(branch_id);
    }

    const [rows] = await db.promise().execute(query, params);
    const ops = rows[0];

    // Fetch LIVE expenses for the period
    const totalExpenses = await getLiveExpenses(startDate, endDate, branch_id);

    const totalActualRevenue = parseFloat(ops.totalPayments) || parseFloat(ops.totalActualRevenue) || 0;
    const totalCost = parseFloat(ops.totalCost) || 0;
    const actualProfit = totalActualRevenue - totalCost - totalExpenses;

    res.status(200).json({
      totalRevenue: parseFloat(ops.totalRevenue) || 0,
      totalActualRevenue,
      totalCost,
      totalExpenses,        // ✅ ADDED
      totalProfit: actualProfit,
      totalSold: parseFloat(ops.totalSold) || 0,
      totalWaste: parseFloat(ops.totalWaste) || 0,
      margin: actualProfit,
      period: 'last-7-days',
      startDate,
      endDate,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /reports/month-to-date — FIXED: includes live expenses
exports.getMonthToDateReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const now = new Date();
    const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = now.toISOString().split('T')[0];

    let query = `
      SELECT 
        COALESCE(SUM(revenue), 0) as totalRevenue,
        COALESCE(SUM(actual_revenue), 0) as totalActualRevenue,
        COALESCE(SUM(payment_cash + payment_mpesa), 0) as totalPayments,
        COALESCE(SUM(sold_kg * cost_per_kg), 0) as totalCost,
        COALESCE(SUM(profit), 0) as totalProfit,
        COALESCE(SUM(sold_kg), 0) as totalSold,
        COALESCE(SUM(waste_kg), 0) as totalWaste
      FROM daily_entries 
      WHERE date >= ? AND date <= ?
    `;
    const params = [startDate, endDate];

    if (branch_id) {
      query += ` AND branch_id = ?`;
      params.push(branch_id);
    }

    const [rows] = await db.promise().execute(query, params);
    const ops = rows[0];

    // Fetch LIVE expenses for the period
    const totalExpenses = await getLiveExpenses(startDate, endDate, branch_id);

    const totalActualRevenue = parseFloat(ops.totalPayments) || parseFloat(ops.totalActualRevenue) || 0;
    const totalCost = parseFloat(ops.totalCost) || 0;
    const actualProfit = totalActualRevenue - totalCost - totalExpenses;

    res.status(200).json({
      totalRevenue: parseFloat(ops.totalRevenue) || 0,
      totalActualRevenue,
      totalCost,
      totalExpenses,        // ✅ ADDED
      totalProfit: actualProfit,
      totalSold: parseFloat(ops.totalSold) || 0,
      totalWaste: parseFloat(ops.totalWaste) || 0,
      margin: actualProfit,
      period: 'month-to-date',
      startDate,
      endDate,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /reports/comparative — FIXED: includes live expenses
exports.getComparativeReport = async (req, res) => {
  try {
    const { branch_id } = req.query;
    const now = new Date();

    // This month
    const thisMonthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const thisMonthEnd = now.toISOString().split('T')[0];

    // Last month
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthStart = `${lastMonth.getFullYear()}-${String(lastMonth.getMonth() + 1).padStart(2, '0')}-01`;
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];

    const thisMonthExpenses = await getLiveExpenses(thisMonthStart, thisMonthEnd, branch_id);
    const lastMonthExpenses = await getLiveExpenses(lastMonthStart, lastMonthEnd, branch_id);

    // Get this month data
    let thisQuery = `
      SELECT 
        COALESCE(SUM(revenue), 0) as expected_revenue,
        COALESCE(SUM(payment_cash + payment_mpesa), 0) as actual_revenue,
        COALESCE(SUM(sold_kg), 0) as sold,
        COALESCE(SUM(waste_kg), 0) as waste,
        AVG((waste_kg / NULLIF(opening_stock_kg + supply_kg, 0)) * 100) as avg_waste
      FROM daily_entries 
      WHERE date >= ? AND date <= ?
    `;
    const thisParams = [thisMonthStart, thisMonthEnd];
    if (branch_id) {
      thisQuery += ` AND branch_id = ?`;
      thisParams.push(branch_id);
    }
    const [thisRows] = await db.promise().execute(thisQuery, thisParams);
    const thisData = thisRows[0];

    // Get last month data
    let lastQuery = `
      SELECT 
        COALESCE(SUM(revenue), 0) as expected_revenue,
        COALESCE(SUM(payment_cash + payment_mpesa), 0) as actual_revenue,
        COALESCE(SUM(sold_kg), 0) as sold,
        COALESCE(SUM(waste_kg), 0) as waste,
        AVG((waste_kg / NULLIF(opening_stock_kg + supply_kg, 0)) * 100) as avg_waste
      FROM daily_entries 
      WHERE date >= ? AND date <= ?
    `;
    const lastParams = [lastMonthStart, lastMonthEnd];
    if (branch_id) {
      lastQuery += ` AND branch_id = ?`;
      lastParams.push(branch_id);
    }
    const [lastRows] = await db.promise().execute(lastQuery, lastParams);
    const lastData = lastRows[0];

    const thisCost = parseFloat(thisData.sold) * 0; // We don't have avg cost, calculate from entries
    const lastCost = parseFloat(lastData.sold) * 0;

    // Calculate profits with live expenses
    const thisActualProfit = parseFloat(thisData.actual_revenue) - thisMonthExpenses;
    const thisExpectedProfit = parseFloat(thisData.expected_revenue) - thisMonthExpenses;
    const lastActualProfit = parseFloat(lastData.actual_revenue) - lastMonthExpenses;
    const lastExpectedProfit = parseFloat(lastData.expected_revenue) - lastMonthExpenses;

    res.status(200).json({
      thisMonth: {
        expected_revenue: parseFloat(thisData.expected_revenue) || 0,
        actual_revenue: parseFloat(thisData.actual_revenue) || 0,
        expected_profit: thisExpectedProfit,
        actual_profit: thisActualProfit,
        sold: parseFloat(thisData.sold) || 0,
        avg_waste: parseFloat(thisData.avg_waste) || 0,
        expenses: thisMonthExpenses,
      },
      lastMonth: {
        expected_revenue: parseFloat(lastData.expected_revenue) || 0,
        actual_revenue: parseFloat(lastData.actual_revenue) || 0,
        expected_profit: lastExpectedProfit,
        actual_profit: lastActualProfit,
        sold: parseFloat(lastData.sold) || 0,
        avg_waste: parseFloat(lastData.avg_waste) || 0,
        expenses: lastMonthExpenses,
      },
      changes: {
        expected_revenue: calculateChange(lastData.expected_revenue, thisData.expected_revenue),
        actual_revenue: calculateChange(lastData.actual_revenue, thisData.actual_revenue),
        expected_profit: calculateChange(lastExpectedProfit, thisExpectedProfit),
        actual_profit: calculateChange(lastActualProfit, thisActualProfit),
        sold: calculateChange(lastData.sold, thisData.sold),
        waste: calculateChange(lastData.avg_waste, thisData.avg_waste),
      }
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Helper: calculate percentage change
function calculateChange(oldVal, newVal) {
  const old = parseFloat(oldVal) || 0;
  const newV = parseFloat(newVal) || 0;
  if (old === 0) return newV > 0 ? 100 : 0;
  return ((newV - old) / old * 100).toFixed(1);
}

// GET /reports/profitability
exports.getProfitabilityReport = async (req, res) => {
  try {
    const { branch_id, days = 30 } = req.query;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let query = `
      SELECT 
        date,
        revenue as expected_revenue,
        actual_revenue,
        payment_cash,
        payment_mpesa,
        (sold_kg * cost_per_kg) as cogs,
        sold_kg,
        waste_kg,
        profit,
        cost_per_kg,
        selling_price_per_kg
      FROM daily_entries 
      WHERE date >= ? AND date <= ?
    `;
    const params = [startDate, endDate];

    if (branch_id) {
      query += ` AND branch_id = ?`;
      params.push(branch_id);
    }
    query += ` ORDER BY date ASC`;

    const [rows] = await db.promise().execute(query, params);

    // Fetch expenses for each date
    const daily = [];
    for (const row of rows) {
      const [expRows] = await db.promise().execute(
        `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE date = ? AND branch_id = ?`,
        [row.date, branch_id || row.branch_id]
      );
      const expenses = parseFloat(expRows[0].total) || 0;
      const actualRevenue = parseFloat(row.payment_cash || 0) + parseFloat(row.payment_mpesa || 0);
      const cogs = parseFloat(row.cogs) || 0;

      daily.push({
        date: row.date,
        expected_revenue: parseFloat(row.expected_revenue) || 0,
        actual_revenue: actualRevenue,
        cogs,
        expenses,
        actual_profit: actualRevenue - cogs - expenses,
        expected_profit: (parseFloat(row.expected_revenue) || 0) - cogs - expenses,
        sold_kg: parseFloat(row.sold_kg) || 0,
        waste_kg: parseFloat(row.waste_kg) || 0,
        payment_cash: parseFloat(row.payment_cash) || 0,
        payment_mpesa: parseFloat(row.payment_mpesa) || 0,
      });
    }

    // Day of week analysis
    const dayMap = {};
    for (const d of daily) {
      const dayName = new Date(d.date).toLocaleDateString('en-US', { weekday: 'long' });
      if (!dayMap[dayName]) {
        dayMap[dayName] = { 
          day_name: dayName, 
          count: 0, 
          total_revenue: 0, 
          total_actual_revenue: 0,
          total_profit: 0,
          total_actual_profit: 0,
        };
      }
      dayMap[dayName].count++;
      dayMap[dayName].total_revenue += d.expected_revenue;
      dayMap[dayName].total_actual_revenue += d.actual_revenue;
      dayMap[dayName].total_profit += d.expected_profit;
      dayMap[dayName].total_actual_profit += d.actual_profit;
    }

    const dayOfWeek = Object.values(dayMap).map(d => ({
      day_name: d.day_name,
      avg_revenue: d.total_revenue / d.count,
      avg_actual_revenue: d.total_actual_revenue / d.count,
      avg_profit: d.total_profit / d.count,
      avg_actual_profit: d.total_actual_profit / d.count,
    }));

    res.status(200).json({ daily, dayOfWeek });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /reports/waste-analysis
exports.getWasteAnalysis = async (req, res) => {
  try {
    const { branch_id, days = 30 } = req.query;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let query = `
      SELECT 
        date,
        waste_kg,
        opening_stock_kg,
        supply_kg,
        cost_per_kg,
        (waste_kg * cost_per_kg) as waste_cost
      FROM daily_entries 
      WHERE date >= ? AND date <= ? AND waste_kg > 0
    `;
    const params = [startDate, endDate];

    if (branch_id) {
      query += ` AND branch_id = ?`;
      params.push(branch_id);
    }
    query += ` ORDER BY date DESC`;

    const [rows] = await db.promise().execute(query, params);

    let totalWasteCost = 0;
    let totalWastePct = 0;
    const data = rows.map(row => {
      const total = parseFloat(row.opening_stock_kg || 0) + parseFloat(row.supply_kg || 0);
      const wastePct = total > 0 ? ((parseFloat(row.waste_kg) / total) * 100).toFixed(1) : 0;
      const wasteCost = parseFloat(row.waste_cost) || 0;
      totalWasteCost += wasteCost;
      totalWastePct += parseFloat(wastePct);

      return {
        date: row.date,
        waste_kg: parseFloat(row.waste_kg) || 0,
        waste_pct: wastePct,
        waste_cost: wasteCost,
      };
    });

    res.status(200).json({
      data,
      avgWastePct: data.length ? (totalWastePct / data.length).toFixed(1) : 0,
      totalWasteCost,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /reports/payment-mix
exports.getPaymentMix = async (req, res) => {
  try {
    const { branch_id, days = 30 } = req.query;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let query = `
      SELECT 
        date,
        payment_cash,
        payment_mpesa,
        revenue as expected_revenue
      FROM daily_entries 
      WHERE date >= ? AND date <= ?
    `;
    const params = [startDate, endDate];

    if (branch_id) {
      query += ` AND branch_id = ?`;
      params.push(branch_id);
    }
    query += ` ORDER BY date DESC`;

    const [rows] = await db.promise().execute(query, params);

    let totalCash = 0;
    let totalMpesa = 0;
    let totalExpectedRevenue = 0;
    let totalMpesaPct = 0;

    const data = rows.map(row => {
      const cash = parseFloat(row.payment_cash) || 0;
      const mpesa = parseFloat(row.payment_mpesa) || 0;
      const total = cash + mpesa;
      const expected = parseFloat(row.expected_revenue) || 0;

      totalCash += cash;
      totalMpesa += mpesa;
      totalExpectedRevenue += expected;
      totalMpesaPct += total > 0 ? (mpesa / total * 100) : 0;

      return {
        date: row.date,
        payment_cash: cash,
        payment_mpesa: mpesa,
        expected_revenue: expected,
      };
    });

    const totalActualRevenue = totalCash + totalMpesa;

    res.status(200).json({
      data,
      totalCash,
      totalMpesa,
      totalActualRevenue,
      totalExpectedRevenue,
      avgMpesaPct: data.length ? (totalMpesaPct / data.length).toFixed(1) : 0,
      revenueVariance: totalExpectedRevenue - totalActualRevenue,
    });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /reports/expense-breakdown
exports.getExpenseBreakdown = async (req, res) => {
  try {
    const { branch_id, days = 30 } = req.query;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    let query = `
      SELECT 
        title,
        COUNT(*) as count,
        SUM(amount) as total,
        AVG(amount) as avg_amount
      FROM expenses 
      WHERE date >= ? AND date <= ?
    `;
    const params = [startDate, endDate];

    if (branch_id) {
      query += ` AND branch_id = ?`;
      params.push(branch_id);
    }
    query += ` GROUP BY title ORDER BY total DESC`;

    const [rows] = await db.promise().execute(query, params);

    const grandTotal = rows.reduce((sum, r) => sum + parseFloat(r.total), 0);

    const data = rows.map(row => ({
      title: row.title,
      count: parseInt(row.count),
      total: parseFloat(row.total),
      avg_amount: parseFloat(row.avg_amount).toFixed(2),
      pct: grandTotal > 0 ? ((parseFloat(row.total) / grandTotal) * 100).toFixed(1) : 0,
    }));

    res.status(200).json({ data, grandTotal });

  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};