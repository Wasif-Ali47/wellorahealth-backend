import express from 'express';
import { body } from 'express-validator';
import { authenticate } from '../middleware/auth.js';
import * as mealPlanController from '../controllers/mealPlanController.js';

const router = express.Router();

// Generate a 7-day meal plan
router.post('/generate', authenticate, mealPlanController.generateMealPlan);

// Regenerate only today's remaining meals and future days after questionnaire updates
router.post('/regenerate-remaining', authenticate, mealPlanController.regenerateRemainingMealPlan);

// "Can I eat this?" food checker
router.post('/check-food', authenticate, [
  body('food').trim().notEmpty().isLength({ max: 500 }),
  body('portion').trim().optional().isLength({ max: 200 })
], mealPlanController.checkFood);

// Sugar-safe food swaps
router.post('/swap', authenticate, [
  body('food').trim().notEmpty().isLength({ max: 500 })
], mealPlanController.foodSwaps);

// Pro-only Diet Rescue gate
router.post('/diet-rescue', authenticate, mealPlanController.dietRescue);

// Weekly grocery list
router.get('/grocery-list', authenticate, mealPlanController.groceryList);

// Get current active meal plan
router.get('/current', authenticate, mealPlanController.getCurrentMealPlan);

// List all meal plans (must be before `/:id` so `/` is not captured as an id)
router.get('/', authenticate, mealPlanController.getAllMealPlans);

// Get meal plan by ID
router.get('/:id', authenticate, mealPlanController.getMealPlanById);

// Update meal plan day
router.put('/:id/days/:dayNumber', authenticate, mealPlanController.updateMealPlanDay);

export default router;
