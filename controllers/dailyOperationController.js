const db = require("../config/db");
const redis = require('../config/redis');

const fmt = (n) => { const v = parseFloat(n); return isNaN(v) ? 0 : Math.round(v * 100) / 100; };

const invalidateDailyCache = async (branch_id, date) => {
  const keys = [
    `stock:current:${branch_id || 'all'}`,
    `report:last-entry:${branch_id || 'all'}`,
    `report:last-7-days:${branch_id || 'all'}`,
    `report:month-to-date:${branch_id || 'all'}`
  ];
  for (const key of keys) { await redis.del(key); }
};

const verifyBranchAccess = async (firebase_uid, branch_id) => {
  const [rows] = await db.promise().execute(
    `SELECT 1 FROM branches br
      JOIN businesses b ON br.business_id = b.id
      WHERE br.id = ? AND (b.firebase_uid = ? OR br.manager_uid = ?)
      LIMIT 1`,
    [branch_id, firebase_uid, firebase_uid]
  );
  return rows.length > 0;
};

// ─── HELPERS ────────────────────────────────────────────────────────────────

const getDailyExpenses = async (connection, branch_id, date) => {
  const [expRows] = await connection.execute(
    `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE branch_id = ? AND date = ?`,
    [branch_id, date]
  );
  return parseFloat(expRows[0]?.total) || 0;
};

const calculateDateTotals = async (connection, branch_id, date) => {
  const [opsRows] = await connection.execute(
    `SELECT 
      COALESCE(SUM(actual_revenue), 0) as totalActualRevenue,
      COALESCE(SUM(expected_revenue), 0) as totalExpectedRevenue,
      COALESCE(SUM(sold_kg * cost_per_kg), 0) as totalCogs,
      COALESCE(SUM(sold_kg), 0) as totalSoldKg,
      COALESCE(SUM(opening_stock_kg), 0) as totalOpeningStock,
      COALESCE(SUM(closing_stock_kg), 0) as totalClosingStock,
      COUNT(*) as entryCount
    FROM daily_entries 
    WHERE branch_id = ? AND date = ?`,
    [branch_id, date]
  );

  const ops = opsRows[0];
  const totalActualRevenue = parseFloat(ops.totalActualRevenue) || 0;
  const totalExpectedRevenue = parseFloat(ops.totalExpectedRevenue) || 0;
  const totalCogs = parseFloat(ops.totalCogs) || 0;
  const totalExpenses = await getDailyExpenses(connection, branch_id, date);

  // ✅ OPTION B: Profit = Revenue - Expenses only (COGS NOT subtracted)
  const totalProfit = totalActualRevenue - totalExpenses;
  const totalExpectedProfit = totalExpectedRevenue - totalExpenses;

  return {
    totalActualRevenue: fmt(totalActualRevenue),
    totalExpectedRevenue: fmt(totalExpectedRevenue),
    totalCogs: fmt(totalCogs),
    totalCost: fmt(totalExpenses),
    totalExpenses: fmt(totalExpenses),
    totalProfit: fmt(totalProfit),
    totalExpectedProfit: fmt(totalExpectedProfit),
    totalSoldKg: fmt(parseFloat(ops.totalSoldKg) || 0),
    totalOpeningStock: fmt(parseFloat(ops.totalOpeningStock) || 0),
    totalClosingStock: fmt(parseFloat(ops.totalClosingStock) || 0),
    entryCount: parseInt(ops.entryCount) || 0
  };
};

// ─── DAILY OPERATIONS ───────────────────────────────────────────────────────

exports.createOrUpdateDailyOperation = async (req, res) => {
  try {
    const { branch_id, date, opening_stock_kg, supply_kg, waste_kg, closing_stock_kg, cost_per_kg, selling_price_per_kg, payment_cash, payment_mpesa } = req.body;
    const firebase_uid = req.firebase_uid;

    if (!date || !branch_id) {
      return res.status(400).json({ message: "Date and branch_id are required" });
    }

    const hasAccess = await verifyBranchAccess(firebase_uid, branch_id);
    if (!hasAccess) {
      return res.status(403).json({ message: "Forbidden — you do not own this branch" });
    }

    const opening = parseFloat(opening_stock_kg) || 0;
    const supply = parseFloat(supply_kg) || 0;
    const waste = parseFloat(waste_kg) || 0;
    const close = parseFloat(closing_stock_kg) || 0;
    const cost = parseFloat(cost_per_kg) || 0;
    const price = parseFloat(selling_price_per_kg) || 0;
    const cash = parseFloat(payment_cash) || 0;
    const mpesa = parseFloat(payment_mpesa) || 0;

    // ✅ CALCULATE sold_kg from stock fields (not from req.body)
    const sold = Math.max(0, opening + supply - waste - close);

    const expectedRevenue = sold * price;
    const actualRevenue = cash + mpesa;
    const revenueVariance = expectedRevenue - actualRevenue;
    const cogs = sold * cost;

    // Get live expenses
    const connection = await db.promise().getConnection();
    try {
      const totalExpenses = await getDailyExpenses(connection, branch_id, date);

      // ✅ OPTION B: Profit = Revenue - Expenses only (COGS NOT subtracted)
      const profit = actualRevenue - totalExpenses;
      const expectedProfit = expectedRevenue - totalExpenses;

      const [existing] = await connection.execute(
        `SELECT id FROM daily_entries WHERE branch_id = ? AND date = ?`,
        [branch_id, date]
      );

      if (existing.length > 0) {
        await connection.execute(
          `UPDATE daily_entries SET
            opening_stock_kg = ?, supply_kg = ?, sold_kg = ?, waste_kg = ?,
            cost_per_kg = ?, selling_price_per_kg = ?, revenue = ?,
            actual_revenue = ?, payment_cash = ?, payment_mpesa = ?,
            profit = ?, expected_profit = ?, revenue_variance = ?,
            closing_stock_kg = ?, expenses = ?
          WHERE branch_id = ? AND date = ?`,
          [opening, supply, sold, waste, cost, price, expectedRevenue,
           actualRevenue, cash, mpesa, profit, expectedProfit, revenueVariance,
           close, totalExpenses, branch_id, date]
        );
      } else {
        await connection.execute(
          `INSERT INTO daily_entries
            (branch_id, date, opening_stock_kg, supply_kg, sold_kg, waste_kg,
             cost_per_kg, selling_price_per_kg, revenue, actual_revenue,
             payment_cash, payment_mpesa, profit, expected_profit,
             revenue_variance, closing_stock_kg, expenses)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [branch_id, date, opening, supply, sold, waste, cost, price,
           expectedRevenue, actualRevenue, cash, mpesa, profit, expectedProfit,
           revenueVariance, close, totalExpenses]
        );
      }

      await invalidateDailyCache(branch_id, date);

      res.status(200).json({
        message: existing.length > 0 ? "Entry updated" : "Entry created",
        data: {
          date, opening_stock_kg: opening, supply_kg: supply, sold_kg: sold, waste_kg: waste,
          cost_per_kg: cost, selling_price_per_kg: price,
          expectedRevenue, actualRevenue, payment_cash: cash, payment_mpesa: mpesa,
          cogs, totalCost: totalExpenses, totalExpenses, profit, expectedProfit,
          revenueVariance, closing_stock_kg: close
        }
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('createOrUpdateDailyOperation ERROR:', error);
    res.status(500).json({ message: error.message });
  }
};

exports.getLastEntry = async (req, res) => {
  try {
    const { branch_id } = req.query;

    if (!branch_id) {
      return res.status(400).json({ message: "branch_id is required" });
    }

    const cacheKey = `daily:last:${branch_id}`;
    const cached = await redis.get(cacheKey);
    if (cached) return res.status(200).json(JSON.parse(cached));

    const connection = await db.promise().getConnection();
    try {
      const [rows] = await connection.execute(
        `SELECT * FROM daily_entries WHERE branch_id = ? ORDER BY date DESC LIMIT 1`,
        [branch_id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ message: "No entries found" });
      }

      const entry = rows[0];
      const date = entry.date;
      const liveExpenses = await getDailyExpenses(connection, branch_id, date);
      const cogs = parseFloat(entry.sold_kg) * parseFloat(entry.cost_per_kg) || 0;
      const actualRevenue = parseFloat(entry.actual_revenue) || 0;

      // ✅ OPTION B: Profit = Revenue - Expenses only
      const actualProfit = actualRevenue - liveExpenses;
      const marginPct = actualRevenue > 0 ? ((actualProfit / actualRevenue) * 100).toFixed(1) : 0;

      const result = {
        ...entry,
        actualRevenue: fmt(actualRevenue),
        cogs: fmt(cogs),
        totalCost: fmt(liveExpenses),
        totalExpenses: fmt(liveExpenses),
        actualProfit: fmt(actualProfit),
        marginPct: fmt(marginPct)
      };

      await redis.setEx(cacheKey, 300, JSON.stringify(result));
      res.status(200).json(result);
    } finally {
      connection.release();
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getEntryByDate = async (req, res) => {
  try {
    const { branch_id, date } = req.query;

    if (!branch_id || !date) {
      return res.status(400).json({ message: "branch_id and date are required" });
    }

    const connection = await db.promise().getConnection();
    try {
      const [rows] = await connection.execute(
        `SELECT * FROM daily_entries WHERE branch_id = ? AND date = ?`,
        [branch_id, date]
      );

      if (rows.length === 0) {
        return res.status(404).json({ message: "No entry found for this date" });
      }

      const entry = rows[0];
      const liveExpenses = await getDailyExpenses(connection, branch_id, date);
      const cogs = parseFloat(entry.sold_kg) * parseFloat(entry.cost_per_kg) || 0;
      const actualRevenue = parseFloat(entry.actual_revenue) || 0;

      // ✅ OPTION B: Profit = Revenue - Expenses only
      const actualProfit = actualRevenue - liveExpenses;

      res.status(200).json({
        ...entry,
        actualRevenue: fmt(actualRevenue),
        cogs: fmt(cogs),
        totalCost: fmt(liveExpenses),
        totalExpenses: fmt(liveExpenses),
        actualProfit: fmt(actualProfit)
      });
    } finally {
      connection.release();
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.getDailyOperationsByDateRange = async (req, res) => {
  try {
    const { branch_id, start_date, end_date } = req.query;

    if (!branch_id || !start_date || !end_date) {
      return res.status(400).json({ message: "branch_id, start_date, and end_date are required" });
    }

    const connection = await db.promise().getConnection();
    try {
      const [rows] = await connection.execute(
        `SELECT * FROM daily_entries WHERE branch_id = ? AND date BETWEEN ? AND ? ORDER BY date DESC`,
        [branch_id, start_date, end_date]
      );

      const results = [];
      for (const entry of rows) {
        const liveExpenses = await getDailyExpenses(connection, branch_id, entry.date);
        const cogs = parseFloat(entry.sold_kg) * parseFloat(entry.cost_per_kg) || 0;
        const actualRevenue = parseFloat(entry.actual_revenue) || 0;

        // ✅ OPTION B: Profit = Revenue - Expenses only
        const actualProfit = actualRevenue - liveExpenses;

        results.push({
          ...entry,
          cogs: fmt(cogs),
          totalCost: fmt(liveExpenses),
          totalExpenses: fmt(liveExpenses),
          actualProfit: fmt(actualProfit)
        });
      }

      res.status(200).json(results);
    } finally {
      connection.release();
    }
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};