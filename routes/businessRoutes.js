const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// ── Users ──
router.post('/users/sync', userController.syncFirebaseUser);
router.get('/users/me/role', userController.getMyRole);
router.get('/users/:firebase_uid/profile', userController.getUserProfile);

// ── Businesses ──
router.post('/businesses', userController.createBusiness);
router.get('/businesses/my', userController.getMyBusiness);
router.put('/businesses/my', userController.updateMyBusiness);
router.get('/businesses', userController.getAllBusinesses);   // admin only

// ── Branches ──
router.post('/branches', userController.createBranch);
router.get('/branches/my', userController.getMyBranches);
router.get('/branches/business/:business_id', userController.getBranchesByBusiness);
router.put('/branches/:id', userController.updateBranch);
router.delete('/branches/:id', userController.deleteBranch);

module.exports = router;