const db = require('../config/db');

/**
 * Determine a user's role for a given business/branch context.
 * 
 * Returns one of:
 *   - { role: 'owner',   business_id, primary_branch_id: null, managed_branches: [] }
 *   - { role: 'manager', business_id, primary_branch_id, managed_branches: [ids] }
 *   - { role: 'none',    business_id: null, primary_branch_id: null, managed_branches: [] }
 * 
 * @param {string} firebase_uid
 * @param {object} [scope] - optional { business_id?, branch_id? } to narrow the check
 */
exports.getUserRole = async (firebase_uid, scope = {}) => {
  if (!firebase_uid) {
    return { role: 'none', business_id: null, primary_branch_id: null, managed_branches: [] };
  }

  const { business_id, branch_id } = scope;

  // ── 1) Business Owner? ─────────────────────────────────────
  if (business_id) {
    const [owned] = await db.promise().execute(
      `SELECT id FROM businesses WHERE id = ? AND firebase_uid = ? LIMIT 1`,
      [business_id, firebase_uid]
    );
    if (owned.length > 0) {
      return { role: 'owner', business_id, primary_branch_id: null, managed_branches: [] };
    }
  } else {
    const [owned] = await db.promise().execute(
      `SELECT id FROM businesses WHERE firebase_uid = ? LIMIT 1`,
      [firebase_uid]
    );
    if (owned.length > 0) {
      return { role: 'owner', business_id: owned[0].id, primary_branch_id: null, managed_branches: [] };
    }
  }

  // ── 2) Branch Manager of the specific branch? ───────────────
  if (branch_id) {
    const [managed] = await db.promise().execute(
      `SELECT br.id, br.business_id 
         FROM branches br 
        WHERE br.id = ? AND br.manager_uid = ? LIMIT 1`,
      [branch_id, firebase_uid]
    );
    if (managed.length > 0) {
      return {
        role: 'manager',
        business_id: managed[0].business_id,
        primary_branch_id: managed[0].id,
        managed_branches: [managed[0].id],
      };
    }
  }

  // ── 3) Manager of any branch under the business? ────────────
  if (business_id) {
    const [managedList] = await db.promise().execute(
      `SELECT id FROM branches WHERE business_id = ? AND manager_uid = ?`,
      [business_id, firebase_uid]
    );
    if (managedList.length > 0) {
      return {
        role: 'manager',
        business_id,
        primary_branch_id: managedList[0].id,
        managed_branches: managedList.map((r) => r.id),
      };
    }
  }

  // ── 4) Manager of any branch anywhere? ──────────────────────
  const [anyManaged] = await db.promise().execute(
    `SELECT br.id, br.business_id 
       FROM branches br 
      WHERE br.manager_uid = ?`,
    [firebase_uid]
  );
  if (anyManaged.length > 0) {
    return {
      role: 'manager',
      business_id: anyManaged[0].business_id,
      primary_branch_id: anyManaged[0].id,
      managed_branches: anyManaged.map((r) => r.id),
    };
  }

  return { role: 'none', business_id: null, primary_branch_id: null, managed_branches: [] };
};

/**
 * Can this user access this branch?
 * Owners (of the parent business) and the branch's own manager can.
 */
exports.canAccessBranch = async (firebase_uid, branch_id) => {
  const [rows] = await db.promise().execute(
    `SELECT br.id 
       FROM branches br
       JOIN businesses b ON br.business_id = b.id
      WHERE br.id = ? AND (b.firebase_uid = ? OR br.manager_uid = ?)
      LIMIT 1`,
    [branch_id, firebase_uid, firebase_uid]
  );
  return rows.length > 0;
};

/**
 * Is this user the owner of the given business?
 */
exports.isBusinessOwner = async (firebase_uid, business_id) => {
  if (!firebase_uid || !business_id) return false;
  const [rows] = await db.promise().execute(
    `SELECT id FROM businesses WHERE id = ? AND firebase_uid = ? LIMIT 1`,
    [business_id, firebase_uid]
  );
  return rows.length > 0;
};

/**
 * Is this user a manager (of any branch)?
 */
exports.isManager = async (firebase_uid) => {
  if (!firebase_uid) return false;
  const [rows] = await db.promise().execute(
    `SELECT id FROM branches WHERE manager_uid = ? LIMIT 1`,
    [firebase_uid]
  );
  return rows.length > 0;
};