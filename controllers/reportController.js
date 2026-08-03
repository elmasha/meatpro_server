const db = require('../config/database');
const redisClient = require('../config/redis');

const CACHE_TTL = 300; // 5 minutes

// ─── Helpers ────────────────────────────────────────────────────────────────

const getCacheKey = (prefix, params) => {
  const sorted = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join('&');
  return `${prefix}:${sorted}`;
};

const getCached = async (key) => {
  try {
    const data = await redisClient.get(key);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
};

const setCached = async (key, data) => {
  try {
    await redisClient.setEx(key, CACHE_TTL, JSON.stringify(data));
  } catch (e) {
    // silently fail cache
  }
};

const formatNumber = (num) => {
  const n = Number(num);
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
};

// ─── calculateTotals (used by getLastEntryReport) ───────────────────────────

const calculateTotals = (entries) => {
  let totalRevenue = 0;
  let totalActualRevenue = 0;
  let totalCost = 0;
  let totalSold = 0;
  let totalWaste = 0;
  let totalProfit = 0;
  let totalActualProfit = 0;
  let totalCash = 0;
  let totalMpesa = 0;

  entries.forEach((entry) => {
    const revenue = parseFloat(entry.revenue) || 0;
    const cash = parseFloat(entry.payment_cash) || 0;
    const mpesa = parseFloat(entry.payment_mpesa) || 0;
    const cost = parseFloat(entry.totalCost) || 0;
    const sold = parseFloat(entry.sold_kg) || 0;
    const waste = parseFloat(entry.waste_kg) || 0;
    const profit = parseFloat(entry.profit) || 0;

    const actualRevenue = cash + mpesa;
    const actualProfit = actualRevenue - cost;

    totalRevenue += revenue;
    totalActualRevenue += actualRevenue;
    totalCost += cost;
    totalSold += sold;
    totalWaste += waste;
    totalProfit += profit;
    totalActualProfit += actualProfit;
    totalCash += cash;
    totalMpesa += mpesa;
  });

  return {
    totalRevenue: formatNumber(totalRevenue),
    totalActualRevenue: formatNumber(totalActualRevenue),
    totalCost: formatNumber(totalCost),
    totalSold: formatNumber(totalSold),
    totalWaste: formatNumber(totalWaste),
    totalProfit: formatNumber(totalProfit),
    totalActualProfit: formatNumber(totalActualProfit),
    totalCash: formatNumber(totalCash),
    totalMpesa: formatNumber(totalMpesa),
    avgWaste: totalSold > 0 ? formatNumber((totalWaste / totalSold) * 100) : 0,
    cashPct: totalActualRevenue > 0 ? formatNumber((totalCash / totalActualRevenue) * 100) : 0,
    mpesaPct: totalActualRevenue > 0 ? formatNumber((totalMpesa / totalActualRevenue) * 100) : 0,
  };
};

// ─── Report Controller ──────────────────────────────────────────────────────

const reportController = {

  // ── 1. Comparative (This Month vs Last Month) ─────────────────────────────
  getComparative: async (req, res) => {
    try {
      const branchId = req.query.branch_id || req.user?.branch_id || 1;
      const cacheKey = getCacheKey('comparative', { branchId });
      const cached = await getCached(cacheKey);
      if (cached) return res.json(cached);

      const [thisMonthRows] = await db.execute(`
        SELECT 
          COALESCE(SUM(revenue), 0) as expected_revenue,
          COALESCE(SUM(payment_cash + payment_mpesa), 0) as actual_revenue,
          COALESCE(SUM(totalCost), 0) as total_cost,
          COALESCE(SUM(profit), 0) as expected_profit,
          COALESCE(SUM(sold_kg), 0) as total_sold,
          COALESCE(AVG(CASE WHEN sold_kg > 0 THEN (waste_kg / sold_kg) * 100 ELSE 0 END), 0) as avg_waste_pct
        FROM daily_entries 
        WHERE branch_id = ? 
          AND YEAR(date) = YEAR(CURDATE()) 
          AND MONTH(date) = MONTH(CURDATE())
      `, [branchId]);

      const [lastMonthRows] = await db.execute(`
        SELECT 
          COALESCE(SUM(revenue), 0) as expected_revenue,
          COALESCE(SUM(payment_cash + payment_mpesa), 0) as actual_revenue,
          COALESCE(SUM(totalCost), 0) as total_cost,
          COALESCE(SUM(profit), 0) as expected_profit,
          COALESCE(SUM(sold_kg), 0) as total_sold,
          COALESCE(AVG(CASE WHEN sold_kg > 0 THEN (waste_kg / sold_kg) * 100 ELSE 0 END), 0) as avg_waste_pct
        FROM daily_entries 
        WHERE branch_id = ? 
          AND YEAR(date) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))
          AND MONTH(date) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))
      `, [branchId]);

      const [expenseThisMonth] = await db.execute(`
        SELECT COALESCE(SUM(amount), 0) as total FROM expenses 
        WHERE branch_id = ? 
          AND YEAR(date) = YEAR(CURDATE()) 
          AND MONTH(date) = MONTH(CURDATE())
      `, [branchId]);

      const [expenseLastMonth] = await db.execute(`
        SELECT COALESCE(SUM(amount), 0) as total FROM expenses 
        WHERE branch_id = ? 
          AND YEAR(date) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))
          AND MONTH(date) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH))
      `, [branchId]);

      const thisMonthExpenses = parseFloat(expenseThisMonth[0]?.total) || 0;
      const lastMonthExpenses = parseFloat(expenseLastMonth[0]?.total) || 0;

      const thisMonth = {
        expected_revenue: formatNumber(thisMonthRows[0]?.expected_revenue),
        actual_revenue: formatNumber(thisMonthRows[0]?.actual_revenue),
        total_cost: formatNumber(thisMonthRows[0]?.total_cost),
        expected_profit: formatNumber(thisMonthRows[0]?.expected_profit),
        actual_profit: formatNumber((thisMonthRows[0]?.actual_revenue || 0) - (thisMonthRows[0]?.total_cost || 0) - thisMonthExpenses),
        total_sold: formatNumber(thisMonthRows[0]?.total_sold),
        avg_waste: formatNumber(thisMonthRows[0]?.avg_waste_pct),
        total_expenses: formatNumber(thisMonthExpenses),
      };

      const lastMonth = {
        expected_revenue: formatNumber(lastMonthRows[0]?.expected_revenue),
        actual_revenue: formatNumber(lastMonthRows[0]?.actual_revenue),
        total_cost: formatNumber(lastMonthRows[0]?.total_cost),
        expected_profit: formatNumber(lastMonthRows[0]?.expected_profit),
        actual_profit: formatNumber((lastMonthRows[0]?.actual_revenue || 0) - (lastMonthRows[0]?.total_cost || 0) - lastMonthExpenses),
        total_sold: formatNumber(lastMonthRows[0]?.total_sold),
        avg_waste: formatNumber(lastMonthRows[0]?.avg_waste_pct),
        total_expenses: formatNumber(lastMonthExpenses),
      };

      const pctChange = (curr, prev) => {
        if (!prev || prev === 0) return curr > 0 ? 100 : 0;
        return formatNumber(((curr - prev) / prev) * 100);
      };

      const result = {
        thisMonth,
        lastMonth,
        changes: {
          expected_revenue: pctChange(thisMonth.expected_revenue, lastMonth.expected_revenue),
          actual_revenue: pctChange(thisMonth.actual_revenue, lastMonth.actual_revenue),
          expected_profit: pctChange(thisMonth.expected_profit, lastMonth.expected_profit),
          actual_profit: pctChange(thisMonth.actual_profit, lastMonth.actual_profit),
          total_sold: pctChange(thisMonth.total_sold, lastMonth.total_sold),
          avg_waste: pctChange(thisMonth.avg_waste, lastMonth.avg_waste),
        }
      };

      await setCached(cacheKey, result);
      res.json(result);
    } catch (error) {
      console.error('getComparative error:', error);
      res.status(500).json({ error: 'Failed to load comparative data', details: error.message });
    }
  },

  // ── 2. Profitability (Daily Trend) ────────────────────────────────────────
  getProfitability: async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const branchId = req.query.branch_id || req.user?.branch_id || 1;
      const cacheKey = getCacheKey('profitability', { branchId, days });
      const cached = await getCached(cacheKey);
      if (cached) return res.json(cached);

      const [dailyRows] = await db.execute(`
        SELECT 
          de.date,
          COALESCE(SUM(de.revenue), 0) as expected_revenue,
          COALESCE(SUM(de.payment_cash + de.payment_mpesa), 0) as actual_revenue,
          COALESCE(SUM(de.totalCost), 0) as total_cost,
          COALESCE(SUM(de.profit), 0) as expected_profit,
          COALESCE(SUM(de.sold_kg), 0) as sold_kg,
          COALESCE(SUM(de.waste_kg), 0) as waste_kg,
          COALESCE(SUM(e.amount), 0) as daily_expenses
        FROM daily_entries de
        LEFT JOIN expenses e ON de.date = e.date AND de.branch_id = e.branch_id
        WHERE de.branch_id = ? 
          AND de.date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY de.date
        ORDER BY de.date DESC
      `, [branchId, days]);

      const daily = dailyRows.map(row => {
        const actualRevenue = parseFloat(row.actual_revenue) || 0;
        const totalCost = parseFloat(row.total_cost) || 0;
        const dailyExpenses = parseFloat(row.daily_expenses) || 0;
        const actualProfit = actualRevenue - totalCost - dailyExpenses;
        const expectedRevenue = parseFloat(row.expected_revenue) || 0;
        const expectedProfit = parseFloat(row.expected_profit) || 0;

        return {
          date: row.date,
          expected_revenue: formatNumber(expectedRevenue),
          actual_revenue: formatNumber(actualRevenue),
          total_cost: formatNumber(totalCost),
          daily_expenses: formatNumber(dailyExpenses),
          expected_profit: formatNumber(expectedProfit),
          actual_profit: formatNumber(actualProfit),
          expected_margin_pct: expectedRevenue > 0 ? formatNumber((expectedProfit / expectedRevenue) * 100) : 0,
          actual_margin_pct: actualRevenue > 0 ? formatNumber((actualProfit / actualRevenue) * 100) : 0,
          sold_kg: formatNumber(row.sold_kg),
          waste_kg: formatNumber(row.waste_kg),
        };
      });

      const result = { daily, days, branch_id: branchId };
      await setCached(cacheKey, result);
      res.json(result);
    } catch (error) {
      console.error('getProfitability error:', error);
      res.status(500).json({ error: 'Failed to load profitability data', details: error.message });
    }
  },

  // ── 3. Payment Mix ────────────────────────────────────────────────────────
  getPaymentMix: async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const branchId = req.query.branch_id || req.user?.branch_id || 1;
      const cacheKey = getCacheKey('paymentMix', { branchId, days });
      const cached = await getCached(cacheKey);
      if (cached) return res.json(cached);

      const [rows] = await db.execute(`
        SELECT 
          date,
          COALESCE(payment_cash, 0) as payment_cash,
          COALESCE(payment_mpesa, 0) as payment_mpesa,
          COALESCE(revenue, 0) as expected_revenue,
          COALESCE(payment_cash + payment_mpesa, 0) as actual_revenue
        FROM daily_entries
        WHERE branch_id = ? 
          AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        ORDER BY date DESC
      `, [branchId, days]);

      let totalCash = 0;
      let totalMpesa = 0;
      let totalExpected = 0;
      let totalActual = 0;

      const data = rows.map(row => {
        const cash = parseFloat(row.payment_cash) || 0;
        const mpesa = parseFloat(row.payment_mpesa) || 0;
        const actual = cash + mpesa;
        const expected = parseFloat(row.expected_revenue) || 0;

        totalCash += cash;
        totalMpesa += mpesa;
        totalExpected += expected;
        totalActual += actual;

        return {
          date: row.date,
          payment_cash: formatNumber(cash),
          payment_mpesa: formatNumber(mpesa),
          expected_revenue: formatNumber(expected),
          actual_revenue: formatNumber(actual),
          revenue_variance: formatNumber(expected - actual),
          mpesa_pct: actual > 0 ? formatNumber((mpesa / actual) * 100) : 0,
          cash_pct: actual > 0 ? formatNumber((cash / actual) * 100) : 0,
        };
      });

      const totalActualRevenue = totalCash + totalMpesa;
      const avgMpesaPct = totalActualRevenue > 0 ? formatNumber((totalMpesa / totalActualRevenue) * 100) : 0;

      const result = {
        data,
        totalCash: formatNumber(totalCash),
        totalMpesa: formatNumber(totalMpesa),
        totalExpected: formatNumber(totalExpected),
        totalActual: formatNumber(totalActual),
        totalVariance: formatNumber(totalExpected - totalActual),
        avgMpesaPct,
        avgCashPct: formatNumber(100 - avgMpesaPct),
        days,
        branch_id: branchId,
      };

      await setCached(cacheKey, result);
      res.json(result);
    } catch (error) {
      console.error('getPaymentMix error:', error);
      res.status(500).json({ error: 'Failed to load payment mix', details: error.message });
    }
  },

  // ── 4. Waste Analysis ─────────────────────────────────────────────────────
  getWasteAnalysis: async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const branchId = req.query.branch_id || req.user?.branch_id || 1;
      const cacheKey = getCacheKey('waste', { branchId, days });
      const cached = await getCached(cacheKey);
      if (cached) return res.json(cached);

      const [rows] = await db.execute(`
        SELECT 
          date,
          COALESCE(sold_kg, 0) as sold_kg,
          COALESCE(waste_kg, 0) as waste_kg,
          COALESCE(revenue, 0) as expected_revenue,
          COALESCE(payment_cash + payment_mpesa, 0) as actual_revenue
        FROM daily_entries
        WHERE branch_id = ? 
          AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND (waste_kg > 0 OR sold_kg > 0)
        ORDER BY date DESC
      `, [branchId, days]);

      const data = rows.map(row => {
        const sold = parseFloat(row.sold_kg) || 0;
        const waste = parseFloat(row.waste_kg) || 0;
        const wastePct = sold > 0 ? formatNumber((waste / sold) * 100) : 0;

        return {
          date: row.date,
          sold_kg: formatNumber(sold),
          waste_kg: formatNumber(waste),
          waste_pct: wastePct,
          expected_revenue: formatNumber(row.expected_revenue),
          actual_revenue: formatNumber(row.actual_revenue),
        };
      });

      const totalSold = data.reduce((sum, d) => sum + d.sold_kg, 0);
      const totalWaste = data.reduce((sum, d) => sum + d.waste_kg, 0);
      const avgWaste = totalSold > 0 ? formatNumber((totalWaste / totalSold) * 100) : 0;

      const result = { data, totalSold: formatNumber(totalSold), totalWaste: formatNumber(totalWaste), avgWaste, days };
      await setCached(cacheKey, result);
      res.json(result);
    } catch (error) {
      console.error('getWasteAnalysis error:', error);
      res.status(500).json({ error: 'Failed to load waste analysis', details: error.message });
    }
  },

  // ── 5. Expense Breakdown ──────────────────────────────────────────────────
  getExpenseBreakdown: async (req, res) => {
    try {
      const days = parseInt(req.query.days) || 30;
      const branchId = req.query.branch_id || req.user?.branch_id || 1;
      const cacheKey = getCacheKey('expenses', { branchId, days });
      const cached = await getCached(cacheKey);
      if (cached) return res.json(cached);

      const [categoryRows] = await db.execute(`
        SELECT 
          category,
          COALESCE(SUM(amount), 0) as total
        FROM expenses
        WHERE branch_id = ? 
          AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY category
        ORDER BY total DESC
      `, [branchId, days]);

      const [totalRow] = await db.execute(`
        SELECT COALESCE(SUM(amount), 0) as total FROM expenses
        WHERE branch_id = ? 
          AND date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
      `, [branchId, days]);

      const total = parseFloat(totalRow[0]?.total) || 0;

      const data = categoryRows.map(row => ({
        category: row.category || 'Uncategorized',
        amount: formatNumber(row.total),
        pct: total > 0 ? formatNumber((row.total / total) * 100) : 0,
      }));

      const result = { data, total: formatNumber(total), days };
      await setCached(cacheKey, result);
      res.json(result);
    } catch (error) {
      console.error('getExpenseBreakdown error:', error);
      res.status(500).json({ error: 'Failed to load expense breakdown', details: error.message });
    }
  },

  // ── 6. Last Entry Report (Dashboard) ──────────────────────────────────────
  getLastEntryReport: async (req, res) => {
    try {
      const branchId = req.query.branch_id || req.user?.branch_id || 1;
      const cacheKey = getCacheKey('lastEntry', { branchId });
      const cached = await getCached(cacheKey);
      if (cached) return res.json(cached);

      const [entries] = await db.execute(`
        SELECT * FROM daily_entries 
        WHERE branch_id = ? 
        ORDER BY date DESC, id DESC 
        LIMIT 1
      `, [branchId]);

      if (entries.length === 0) {
        return res.json({ message: 'No entries found', data: null });
      }

      const entry = entries[0];
      const [expenses] = await db.execute(`
        SELECT COALESCE(SUM(amount), 0) as total FROM expenses 
        WHERE branch_id = ? AND date = ?
      `, [branchId, entry.date]);

      const expenseTotal = parseFloat(expenses[0]?.total) || 0;
      const revenue = parseFloat(entry.revenue) || 0;
      const cash = parseFloat(entry.payment_cash) || 0;
      const mpesa = parseFloat(entry.payment_mpesa) || 0;
      const totalCost = parseFloat(entry.totalCost) || 0;
      const actualRevenue = cash + mpesa;
      const actualProfit = actualRevenue - totalCost - expenseTotal;
      const expectedProfit = parseFloat(entry.profit) || 0;

      const result = {
        date: entry.date,
        expectedRevenue: formatNumber(revenue),
        actualRevenue: formatNumber(actualRevenue),
        revenueVariance: formatNumber(revenue - actualRevenue),
        totalCost: formatNumber(totalCost),
        expectedProfit: formatNumber(expectedProfit),
        actualProfit: formatNumber(actualProfit),
        profitVariance: formatNumber(expectedProfit - actualProfit),
        paymentCash: formatNumber(cash),
        paymentMpesa: formatNumber(mpesa),
        soldKg: formatNumber(entry.sold_kg),
        wasteKg: formatNumber(entry.waste_kg),
        wastePct: entry.sold_kg > 0 ? formatNumber((entry.waste_kg / entry.sold_kg) * 100) : 0,
        dailyExpenses: formatNumber(expenseTotal),
      };

      await setCached(cacheKey, result);
      res.json({ data: result });
    } catch (error) {
      console.error('getLastEntryReport error:', error);
      res.status(500).json({ error: 'Failed to load last entry', details: error.message });
    }
  },

  // ── 7. Branch List (for dropdown) ─────────────────────────────────────────
  getBranches: async (req, res) => {
    try {
      const [rows] = await db.execute(`
        SELECT b.id, b.name, bus.name as business_name 
        FROM branches b
        JOIN businesses bus ON b.business_id = bus.id
        ORDER BY b.name
      `);
      res.json({ data: rows });
    } catch (error) {
      console.error('getBranches error:', error);
      res.status(500).json({ error: 'Failed to load branches' });
    }
  },

  // ── 8. Clear Cache ────────────────────────────────────────────────────────
  clearCache: async (req, res) => {
    try {
      await redisClient.flushDb();
      res.json({ message: 'Cache cleared successfully' });
    } catch (error) {
      res.status(500).json({ error: 'Failed to clear cache' });
    }
  },
};

module.exports = reportController;