const express = require('express');
const router = express.Router();
const businessController = require('../controllers/businessController');

// User routes
router.post('/users/sync', businessController.syncFirebaseUser);
router.get('/users/:firebase_uid/profile', businessController.getUserProfile);

// Business routes
router.post('/businesses', businessController.createBusiness);
router.get('/businesses/my', businessController.getMyBusiness);
router.get('/businesses', businessController.getAllBusinesses);
router.put('/businesses/my', businessController.updateMyBusiness);

// Branch routes
router.post('/branches', businessController.createBranch);
router.get('/branches/my', businessController.getMyBranches);
router.get('/businesses/:business_id/branches', businessController.getBranchesByBusiness);
router.put('/branches/:id', businessController.updateBranch);
router.delete('/branches/:id', businessController.deleteBranch);

module.exports = router;