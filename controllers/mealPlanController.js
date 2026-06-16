import MealPlan from '../models/MealPlan.js';
import User from '../models/User.js';
import FoodLog from '../models/FoodLog.js';
import { validationResult } from 'express-validator';
import {
  generateMealPlanWithAI,
  generateMealPlanDayWithAI,
  checkFoodSafetyWithAI,
  generateFoodSwapsWithAI,
  generateGroceryListWithAI
} from '../services/openaiService.js';
import { buildClientDayRange } from '../utils/foodLogHelpers.js';
import { recordOpenAiUsage } from '../utils/trackUsage.js';

/**
 * Calculate daily calorie target
 */
// Helper function to convert feet and inches to cm
function feetInchesToCm(feet, inches) {
  if (!feet && !inches) return 170; // Default 5'7"
  const totalInches = (feet || 0) * 12 + (inches || 0);
  return Math.round(totalInches * 2.54);
}

function calculateCalorieTarget(user) {
  let bmr;
  const weight = user.weight || 70;
  
  // Convert height to cm - handle both formats
  let heightCm;
  if (user.height) {
    if (user.height.cm !== undefined && user.height.cm !== null) {
      // User provided height in cm
      heightCm = user.height.cm;
    } else if (user.height.feet !== undefined || user.height.inches !== undefined) {
      // User provided height in feet/inches
      heightCm = feetInchesToCm(user.height.feet, user.height.inches);
    } else {
      heightCm = 170; // Default 5'7"
    }
  } else {
    heightCm = 170; // Default 5'7"
  }
  
  const age = user.dateOfBirth 
    ? Math.floor((new Date() - new Date(user.dateOfBirth)) / (365.25 * 24 * 60 * 60 * 1000))
    : 30;

  if (user.biologicalSex === 'Male') {
    bmr = 10 * weight + 6.25 * heightCm - 5 * age + 5;
  } else {
    bmr = 10 * weight + 6.25 * heightCm - 5 * age - 161;
  }

  const activityMultipliers = {
    'Sedentary': 1.2,
    'Lightly Active': 1.375,
    'Moderately Active': 1.55,
    'Very Active': 1.725,
    'Extremely Active': 1.9
  };

  const activityLevel = user.activityLevel || 'Moderately Active';
  const tdee = bmr * (activityMultipliers[activityLevel] || 1.55);

  return Math.round(tdee) || 1820;
}

/**
 * Calculate macro targets for a diabetic user.
 * Diabetic guideline: carbs are LOWERED (≈ 35 %) and replaced with protein
 * and healthy fats to flatten the glucose curve.
 */
function calculateMacroTargets(calories) {
  return {
    carbs: Math.round((calories * 0.35) / 4),
    protein: Math.round((calories * 0.30) / 4),
    fat: Math.round((calories * 0.35) / 9)
  };
}

function isGuestUser(user) {
  return /^guest_[^@]+@wellorahealth\.app$/i.test(String(user?.email || ''));
}

function waterTargetLitresForUser(user) {
  const weight = Number(user?.weight) || 70;
  return Math.max(2, Math.min(5, Math.round((weight * 35) / 1000)));
}

function expectedMealCountForUser(user) {
  const routine = String(user?.coachProfile?.mealsPerDay || '');
  if (/2 meals \+ 1 snack/i.test(routine)) return 3;
  if (/2 meals/i.test(routine)) return 2;
  if (/3 meals \+ 1 snack/i.test(routine)) return 4;
  if (/3 meals/i.test(routine)) return 3;
  return 4;
}

function isProUser(user) {
  return user?.isPro === true || String(user?.subscriptionPlan || '').toLowerCase() === 'premium';
}

export const generateMealPlan = async (req, res) => {
  const startTime = Date.now();
  try {
    // days=1 (single-day plan, fast generation right after questionnaire)
    // days=7 (full-week plan, user-initiated from Plan tab)
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const rawRequestedDays = parseInt(req.body?.days, 10) === 1 ? 1 : 7;
    const requestedDays = isGuestUser(user) ? 1 : rawRequestedDays;
    console.log(`[generateMealPlan] Starting meal plan generation (days=${requestedDays})...`);

    const dailyCalorieTarget = calculateCalorieTarget(user);
    const dailyMacroTargets = calculateMacroTargets(dailyCalorieTarget);
    let waterTargetLitres = waterTargetLitresForUser(user);
    const expectedMealCount = expectedMealCountForUser(user);
    console.log(`[generateMealPlan] User profile loaded. Calorie target: ${dailyCalorieTarget}kcal`);

    // Anchor day 1 to the client's local calendar date, not the server's —
    // otherwise a plan generated late at night in a timezone ahead of the
    // server's clock lands on "yesterday" and day 1 is already in the past.
    const clientRange = buildClientDayRange({
      today: true,
      timezoneOffset: req.body?.timezoneOffset,
    });
    const startDate = clientRange
      ? clientRange.start
      : (() => {
          const d = new Date();
          d.setHours(0, 0, 0, 0);
          return d;
        })();
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + (requestedDays - 1));

    // Deactivate existing active plans
    await MealPlan.updateMany({ userId: req.userId, isActive: true }, { isActive: false });

    const days = [];
    let aiDays = null;

    if (requestedDays === 1) {
      // Single-day path: one OpenAI call only
      console.log('[generateMealPlan] Generating single-day plan...');
      try {
        const result = await generateMealPlanDayWithAI(
          user,
          dailyCalorieTarget,
          dailyMacroTargets,
          1
        );
        recordOpenAiUsage(req.userId, result?.usage, 'meal-plan-day', 'gpt-4o-mini').catch(() => {});
        aiDays = [{ meals: result?.meals || [] }];
        if (result?.waterTargetLitres) waterTargetLitres = result.waterTargetLitres;
      } catch (err) {
        console.warn('[generateMealPlan] Single-day AI generation failed, will use fallback:', err.message);
        aiDays = [{ meals: [] }];
      }
    } else {
      // Try to generate all 7 days in one API call (faster)
      try {
        console.log('[generateMealPlan] Attempting to generate full 7-day plan in one API call...');
        const result = await generateMealPlanWithAI(user, dailyCalorieTarget, dailyMacroTargets);
        recordOpenAiUsage(req.userId, result?.usage, 'meal-plan', 'gpt-4o-mini').catch(() => {});
        if (result?.waterTargetLitres) waterTargetLitres = result.waterTargetLitres;

        if (result?.days && Array.isArray(result.days) && result.days.length >= 7) {
          console.log('[generateMealPlan] ✅ Successfully generated full 7-day plan in one call');
          aiDays = result.days;
        } else {
          throw new Error('Incomplete 7-day plan received');
        }
      } catch (err) {
        console.warn('[generateMealPlan] Full plan generation failed, falling back to parallel per-day generation:', err.message);
        aiDays = null;
      }

      // If full plan failed, generate days in parallel (much faster than sequential)
      if (!aiDays) {
        console.log('[generateMealPlan] Generating days in parallel...');
        const dayPromises = [];

        for (let i = 0; i < 7; i++) {
          dayPromises.push(
            generateMealPlanDayWithAI(user, dailyCalorieTarget, dailyMacroTargets, i + 1)
              .catch(err => {
                console.warn(`[generateMealPlan] Day ${i + 1} AI generation failed, will use fallback:`, err.message);
                return null;
              })
          );
        }

        const dayResults = await Promise.all(dayPromises);
        dayResults.forEach((result) => {
          recordOpenAiUsage(req.userId, result?.usage, 'meal-plan-day', 'gpt-4o-mini').catch(() => {});
        });
        const firstWaterTarget = dayResults.find((result) => result?.waterTargetLitres)?.waterTargetLitres;
        if (firstWaterTarget) waterTargetLitres = firstWaterTarget;

        aiDays = dayResults.map((result) => ({
          meals: result?.meals || []
        }));
      }
    }

    // Process each day
    for (let i = 0; i < requestedDays; i++) {
      const dayDate = new Date(startDate);
      dayDate.setDate(dayDate.getDate() + i);

      let meals = aiDays[i]?.meals || [];

      // Validate meals or use fallback
      const hasValidMeals =
        Array.isArray(meals) &&
        meals.length >= expectedMealCount &&
        meals.every(
          (m) =>
            m &&
            typeof m.name === 'string' &&
            m.name.trim().length > 0 &&
            typeof m.mealType === 'string' &&
            m.mealType.trim().length > 0 &&
            typeof m.calories === 'number' &&
            !Number.isNaN(m.calories) &&
            m.calories > 0
        );

      if (!hasValidMeals) {
        console.warn(`[generateMealPlan] Day ${i + 1} meals invalid, using fallback`);
        meals = getFallbackMeals(i, dailyCalorieTarget).slice(0, expectedMealCount);
      }

      // Normalise diabetes-specific fields so they are always saved.
      meals = meals.map((m) => ({
        ...m,
        portionGuide: m.portionGuide || '',
        sugarImpact: m.sugarImpact || 'Low',
      }));

      const totalCalories = meals.reduce((sum, meal) => sum + (meal.calories || 0), 0);
      const totalMacros = meals.reduce(
        (acc, meal) => ({
          carbs: acc.carbs + (meal.macros?.carbs || 0),
          protein: acc.protein + (meal.macros?.protein || 0),
          fat: acc.fat + (meal.macros?.fat || 0),
        }),
        { carbs: 0, protein: 0, fat: 0 }
      );

      days.push({
        dayNumber: i + 1,
        date: dayDate,
        meals,
        totalCalories,
        totalMacros,
      });
    }

    const mealPlan = new MealPlan({
      userId: req.userId,
      startDate,
      endDate,
      dailyCalorieTarget,
      dailyMacroTargets,
      waterTargetLitres,
      days,
      isActive: true,
    });

    await mealPlan.save();

    const totalTime = Date.now() - startTime;
    console.log(`[generateMealPlan] ✅ Meal plan generated successfully (${requestedDays} day${requestedDays === 1 ? '' : 's'}) in ${totalTime}ms`);

    res.status(201).json({
      success: true,
      message: `Meal plan generated successfully (${requestedDays}-day)`,
      mealPlan,
    });
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[generateMealPlan] ❌ Error after ${totalTime}ms:`, error);
    res.status(500).json({
      success: false,
      message: "Failed to generate meal plan",
      error: error.message,
    });
  }
};

export const regenerateRemainingMealPlan = async (req, res) => {
  const startTime = Date.now();
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const activePlan = await MealPlan.findOne({ userId: req.userId, isActive: true }).sort({ createdAt: -1 });
    if (!activePlan) {
      return res.status(404).json({ success: false, message: 'Meal plan not found' });
    }

    const clientRange = buildClientDayRange({
      today: true,
      timezoneOffset: req.body?.timezoneOffset,
    });
    const todayStart = clientRange?.start || (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d;
    })();
    const tomorrowStart = clientRange?.end || (() => {
      const d = new Date(todayStart);
      d.setDate(d.getDate() + 1);
      return d;
    })();

    const planStart = new Date(activePlan.startDate);
    const dayIndex = Math.min(
      Math.max(Math.round((todayStart.getTime() - planStart.getTime()) / 86400000), 0),
      Math.max((activePlan.days?.length || 1) - 1, 0)
    );
    const remainingDays = (activePlan.days || []).slice(dayIndex);
    if (remainingDays.length === 0) {
      return res.json({
        success: true,
        message: 'No remaining plan days to update.',
        mealPlan: activePlan,
        updatedDays: 0,
      });
    }

    const dailyCalorieTarget = calculateCalorieTarget(user);
    const dailyMacroTargets = calculateMacroTargets(dailyCalorieTarget);
    const expectedMealCount = expectedMealCountForUser(user);
    const todayLogs = await FoodLog.find({
      userId: req.userId,
      $or: [
        { date: { $gte: todayStart, $lt: tomorrowStart } },
        { timestamp: { $gte: todayStart, $lt: tomorrowStart } },
      ],
      source: 'meal_plan',
      status: { $in: ['completed', 'skipped'] },
      plannedMealKey: { $exists: true, $ne: null },
    }).lean();
    const lockedTodayKeys = new Set(todayLogs.map((log) => String(log.plannedMealKey)));

    const dayResults = await Promise.all(
      remainingDays.map((day) =>
        generateMealPlanDayWithAI(user, dailyCalorieTarget, dailyMacroTargets, day.dayNumber)
          .catch((err) => {
            console.warn(`[regenerateRemainingMealPlan] Day ${day.dayNumber} AI generation failed, using fallback:`, err.message);
            return null;
          })
      )
    );
    dayResults.forEach((result) => {
      recordOpenAiUsage(req.userId, result?.usage, 'meal-plan-day', 'gpt-4o-mini').catch(() => {});
    });

    for (let i = 0; i < remainingDays.length; i++) {
      const day = remainingDays[i];
      let newMeals = dayResults[i]?.meals || [];
      const hasValidMeals =
        Array.isArray(newMeals) &&
        newMeals.length >= expectedMealCount &&
        newMeals.every((m) => m?.name && m?.mealType && Number(m.calories) > 0);

      if (!hasValidMeals) {
        newMeals = getFallbackMeals((day.dayNumber || (dayIndex + i + 1)) - 1, dailyCalorieTarget)
          .slice(0, expectedMealCount);
      }

      newMeals = newMeals.map((m) => ({
        ...m,
        portionGuide: m.portionGuide || '',
        sugarImpact: m.sugarImpact || 'Low',
      }));

      if (i === 0 && lockedTodayKeys.size > 0) {
        const replacementsByType = new Map(
          newMeals.map((meal) => [String(meal.mealType || '').toLowerCase(), meal])
        );
        day.meals = (day.meals || []).map((meal) => {
          const key = `${meal.mealType || 'Snack'}::${String(meal.name || '').trim().toLowerCase()}`;
          if (lockedTodayKeys.has(key)) return meal;
          return replacementsByType.get(String(meal.mealType || '').toLowerCase()) || meal;
        });
      } else {
        day.meals = newMeals;
      }

      day.totalCalories = (day.meals || []).reduce((sum, meal) => sum + (Number(meal.calories) || 0), 0);
      day.totalMacros = (day.meals || []).reduce(
        (sum, meal) => ({
          carbs: sum.carbs + (Number(meal.macros?.carbs) || 0),
          protein: sum.protein + (Number(meal.macros?.protein) || 0),
          fat: sum.fat + (Number(meal.macros?.fat) || 0),
        }),
        { carbs: 0, protein: 0, fat: 0 }
      );
    }

    activePlan.dailyCalorieTarget = dailyCalorieTarget;
    activePlan.dailyMacroTargets = dailyMacroTargets;
    activePlan.groceryList = null;
    activePlan.groceryListGeneratedAt = null;
    activePlan.markModified('days');
    await activePlan.save();

    const totalTime = Date.now() - startTime;
    console.log(`[regenerateRemainingMealPlan] Updated ${remainingDays.length} remaining day(s) in ${totalTime}ms`);

    return res.json({
      success: true,
      message: `Updated ${remainingDays.length} remaining plan day${remainingDays.length === 1 ? '' : 's'} with your new questionnaire answers.`,
      mealPlan: activePlan,
      updatedDays: remainingDays.length,
    });
  } catch (error) {
    const totalTime = Date.now() - startTime;
    console.error(`[regenerateRemainingMealPlan] Error after ${totalTime}ms:`, error);
    return res.status(500).json({
      success: false,
      message: 'Failed to update remaining meal plan',
      error: error.message,
    });
  }
};
// export const generateMealPlan = async (req, res) => {
//   try {
//     const user = await User.findById(req.userId);
//     if (!user) {
//       return res.status(404).json({
//         success: false,
//         message: 'User not found'
//       });
//     }

//     // Calculate daily calorie target
//     const dailyCalorieTarget = calculateCalorieTarget(user);
//     const dailyMacroTargets = calculateMacroTargets(dailyCalorieTarget);

//     // Generate 7-day meal plan
//     const startDate = new Date();
//     startDate.setHours(0, 0, 0, 0);
//     const endDate = new Date(startDate);
//     endDate.setDate(endDate.getDate() + 6);

//     // Deactivate existing active plans
//     await MealPlan.updateMany(
//       { userId: req.userId, isActive: true },
//       { isActive: false }
//     );

//     const days = [];
    
//     // Generate meals for each day using OpenAI
//     for (let i = 0; i < 7; i++) {
//       const dayDate = new Date(startDate);
//       dayDate.setDate(dayDate.getDate() + i);
      
//       try {
//         // Use OpenAI to generate meals for this day
//         const meals = await generateMealPlanWithAI(user, dailyCalorieTarget, dailyMacroTargets, i + 1);
        
//         const totalCalories = meals.reduce((sum, meal) => sum + meal.calories, 0);
//         const totalMacros = meals.reduce((acc, meal) => ({
//           carbs: acc.carbs + meal.macros.carbs,
//           protein: acc.protein + meal.macros.protein,
//           fat: acc.fat + meal.macros.fat
//         }), { carbs: 0, protein: 0, fat: 0 });

//         days.push({
//           dayNumber: i + 1,
//           date: dayDate,
//           meals,
//           totalCalories,
//           totalMacros
//         });
//       } catch (error) {
//         console.error(`Error generating meals for day ${i + 1}:`, error);
//         // Fallback to default meals if OpenAI fails
//         const meals = getFallbackMeals(i, dailyCalorieTarget);
//         const totalCalories = meals.reduce((sum, meal) => sum + meal.calories, 0);
//         const totalMacros = meals.reduce((acc, meal) => ({
//           carbs: acc.carbs + meal.macros.carbs,
//           protein: acc.protein + meal.macros.protein,
//           fat: acc.fat + meal.macros.fat
//         }), { carbs: 0, protein: 0, fat: 0 });

//         days.push({
//           dayNumber: i + 1,
//           date: dayDate,
//           meals,
//           totalCalories,
//           totalMacros
//         });
//       }
//     }

//     const mealPlan = new MealPlan({
//       userId: req.userId,
//       startDate,
//       endDate,
//       dailyCalorieTarget,
//       dailyMacroTargets,
//       days,
//       isActive: true
//     });

//     await mealPlan.save();

//     res.status(201).json({
//       success: true,
//       message: 'Meal plan generated successfully',
//       mealPlan
//     });
//   } catch (error) {
//     console.error('Generate meal plan error:', error);
//     res.status(500).json({
//       success: false,
//       message: 'Failed to generate meal plan',
//       error: error.message
//     });
//   }
// };

/**
 * Get current active meal plan
 */
export const getCurrentMealPlan = async (req, res) => {
  try {
    const mealPlan = await MealPlan.findOne({
      userId: req.userId,
      isActive: true
    }).sort({ createdAt: -1 });

    if (!mealPlan) {
      return res.status(404).json({
        success: false,
        message: 'No active meal plan found'
      });
    }

    res.json({
      success: true,
      mealPlan
    });
  } catch (error) {
    console.error('Get current meal plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get meal plan',
      error: error.message
    });
  }
};

/**
 * Get meal plan by ID
 */
export const getMealPlanById = async (req, res) => {
  try {
    const mealPlan = await MealPlan.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!mealPlan) {
      return res.status(404).json({
        success: false,
        message: 'Meal plan not found'
      });
    }

    res.json({
      success: true,
      mealPlan
    });
  } catch (error) {
    console.error('Get meal plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get meal plan',
      error: error.message
    });
  }
};

/**
 * Get all meal plans
 */
export const getAllMealPlans = async (req, res) => {
  try {
    const mealPlans = await MealPlan.find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      count: mealPlans.length,
      mealPlans
    });
  } catch (error) {
    console.error('Get meal plans error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get meal plans',
      error: error.message
    });
  }
};

/**
 * Update meal plan day
 */
export const updateMealPlanDay = async (req, res) => {
  try {
    const { meals } = req.body;
    const mealPlan = await MealPlan.findOne({
      _id: req.params.id,
      userId: req.userId
    });

    if (!mealPlan) {
      return res.status(404).json({
        success: false,
        message: 'Meal plan not found'
      });
    }

    const dayIndex = mealPlan.days.findIndex(
      d => d.dayNumber === parseInt(req.params.dayNumber)
    );

    if (dayIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Day not found in meal plan'
      });
    }

    if (meals) {
      mealPlan.days[dayIndex].meals = meals;
      mealPlan.days[dayIndex].totalCalories = meals.reduce((sum, meal) => sum + meal.calories, 0);
      mealPlan.days[dayIndex].totalMacros = meals.reduce((acc, meal) => ({
        carbs: acc.carbs + meal.macros.carbs,
        protein: acc.protein + meal.macros.protein,
        fat: acc.fat + meal.macros.fat
      }), { carbs: 0, protein: 0, fat: 0 });
    }

    await mealPlan.save();

    res.json({
      success: true,
      message: 'Meal plan updated successfully',
      mealPlan
    });
  } catch (error) {
    console.error('Update meal plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update meal plan',
      error: error.message
    });
  }
};

/**
 * Diabetic-safe fallback meals (used when the AI call fails).
 * All meals use everyday portion units and lean towards local / South Asian
 * staples with controlled carbs.
 */
function getFallbackMeals(dayIndex, calorieTarget) {
  const breakfastCal = Math.round(calorieTarget * 0.25);
  const lunchCal = Math.round(calorieTarget * 0.35);
  const dinnerCal = Math.round(calorieTarget * 0.30);
  const snackCal = Math.round(calorieTarget * 0.10);

  const mealTemplates = [
    {
      breakfast: { mealType: 'Breakfast', name: 'Vegetable Omelette + ½ Roti', portionGuide: '2-egg vegetable omelette + ½ whole-wheat roti + 1 cup green tea', sugarImpact: 'Low', description: 'Eggs give slow-digesting protein that keeps blood sugar steady. Half a whole-wheat roti adds just enough fibre-rich carbs without spiking glucose. Green tea supports insulin sensitivity.', calories: breakfastCal, macros: { carbs: Math.round(breakfastCal * 0.35 / 4), protein: Math.round(breakfastCal * 0.30 / 4), fat: Math.round(breakfastCal * 0.35 / 9) }, tags: ['Low GI', 'Diabetes-friendly'], ingredients: ['Eggs', 'Tomato', 'Onion', 'Whole-wheat atta'] },
      lunch: { mealType: 'Lunch', name: 'Chicken Salan with 1 Roti', portionGuide: '1 whole-wheat roti + 1 cup chicken salan (low-oil) + salad', sugarImpact: 'Low', description: 'Lean chicken provides high-quality protein and the salan uses tomato-onion gravy instead of heavy cream. A single whole-wheat roti and a fresh salad slow glucose absorption.', calories: lunchCal, macros: { carbs: Math.round(lunchCal * 0.35 / 4), protein: Math.round(lunchCal * 0.35 / 4), fat: Math.round(lunchCal * 0.30 / 9) }, tags: ['High Protein', 'Diabetes-friendly'], ingredients: ['Chicken', 'Tomato', 'Onion', 'Whole-wheat roti', 'Cucumber'] },
      dinner: { mealType: 'Dinner', name: 'Daal Palak with ½ Cup Brown Rice', portionGuide: '1 cup daal palak + ½ cup brown rice + cucumber raita', sugarImpact: 'Low', description: 'Lentils and spinach are loaded with fibre and plant protein, keeping sugar release slow. Brown rice has a lower GI than white rice. Plain yoghurt raita aids digestion.', calories: dinnerCal, macros: { carbs: Math.round(dinnerCal * 0.40 / 4), protein: Math.round(dinnerCal * 0.25 / 4), fat: Math.round(dinnerCal * 0.35 / 9) }, tags: ['High Fibre', 'Diabetes-friendly'], ingredients: ['Masoor daal', 'Spinach', 'Brown rice', 'Yoghurt'] },
      snack: { mealType: 'Snack', name: 'Apple + 6 Almonds', portionGuide: '1 small apple + 6 almonds', sugarImpact: 'Low', description: 'A small apple gives gentle natural sweetness with fibre. Almonds add healthy fat and protein that flatten the sugar curve.', calories: snackCal, macros: { carbs: Math.round(snackCal * 0.50 / 4), protein: Math.round(snackCal * 0.10 / 4), fat: Math.round(snackCal * 0.40 / 9) }, tags: ['Low GI'], ingredients: ['Apple', 'Almonds'] }
    },
    {
      breakfast: { mealType: 'Breakfast', name: 'Plain Yoghurt + Chia + Berries', portionGuide: '1 cup plain yoghurt + 1 tbsp chia + ½ cup berries', sugarImpact: 'Low', description: 'Plain yoghurt is protein-rich with no added sugar. Chia seeds add omega-3 and fibre that slow glucose. Berries give natural sweetness with a very low GI.', calories: breakfastCal, macros: { carbs: Math.round(breakfastCal * 0.35 / 4), protein: Math.round(breakfastCal * 0.30 / 4), fat: Math.round(breakfastCal * 0.35 / 9) }, tags: ['High Protein', 'Low GI'], ingredients: ['Plain yoghurt', 'Chia seeds', 'Berries'] },
      lunch: { mealType: 'Lunch', name: 'Qeema with 1 Roti + Salad', portionGuide: '1 cup lean beef qeema + 1 whole-wheat roti + cucumber/tomato salad', sugarImpact: 'Low', description: 'Lean qeema is high in protein and iron and pairs well with a single whole-wheat roti. The salad delivers fibre and water that further smooth out blood-sugar response.', calories: lunchCal, macros: { carbs: Math.round(lunchCal * 0.30 / 4), protein: Math.round(lunchCal * 0.40 / 4), fat: Math.round(lunchCal * 0.30 / 9) }, tags: ['High Protein'], ingredients: ['Lean beef qeema', 'Onion', 'Whole-wheat roti', 'Cucumber'] },
      dinner: { mealType: 'Dinner', name: 'Grilled Fish + Sautéed Veggies', portionGuide: '120 g grilled fish + 1 cup sautéed seasonal veggies + lemon', sugarImpact: 'Low', description: 'Fish provides omega-3 and protein with almost zero impact on glucose. A generous serving of non-starchy veggies adds volume, fibre and micronutrients.', calories: dinnerCal, macros: { carbs: Math.round(dinnerCal * 0.20 / 4), protein: Math.round(dinnerCal * 0.45 / 4), fat: Math.round(dinnerCal * 0.35 / 9) }, tags: ['Omega-3', 'Low Carb'], ingredients: ['White fish', 'Olive oil', 'Mixed vegetables'] },
      snack: { mealType: 'Snack', name: 'Roasted Chana + Green Tea', portionGuide: '½ cup roasted chana + 1 cup green tea', sugarImpact: 'Low', description: 'Roasted chickpeas (chana) are crunchy, high in fibre and plant protein and absolutely budget-friendly. Green tea adds antioxidants that may help insulin sensitivity.', calories: snackCal, macros: { carbs: Math.round(snackCal * 0.45 / 4), protein: Math.round(snackCal * 0.25 / 4), fat: Math.round(snackCal * 0.30 / 9) }, tags: ['Budget'], ingredients: ['Roasted chana', 'Green tea'] }
    },
    {
      breakfast: { mealType: 'Breakfast', name: 'Daal Chilla (Lentil Pancake)', portionGuide: '2 small daal chilla + 1 boiled egg + mint chutney', sugarImpact: 'Low', description: 'Daal chilla replaces refined flour with lentils — far higher fibre and protein. A boiled egg keeps you full for hours and prevents mid-morning sugar dips.', calories: breakfastCal, macros: { carbs: Math.round(breakfastCal * 0.40 / 4), protein: Math.round(breakfastCal * 0.30 / 4), fat: Math.round(breakfastCal * 0.30 / 9) }, tags: ['Low GI', 'Vegetarian'], ingredients: ['Moong daal', 'Egg', 'Mint', 'Onion'] },
      lunch: { mealType: 'Lunch', name: 'Mixed Vegetable Sabzi + 1 Roti', portionGuide: '1 cup mixed sabzi + 1 whole-wheat roti + plain yoghurt', sugarImpact: 'Low', description: 'A medley of seasonal vegetables in light oil delivers fibre, vitamins and slow carbs. Plain yoghurt provides probiotics and protein.', calories: lunchCal, macros: { carbs: Math.round(lunchCal * 0.45 / 4), protein: Math.round(lunchCal * 0.20 / 4), fat: Math.round(lunchCal * 0.35 / 9) }, tags: ['Vegetarian', 'High Fibre'], ingredients: ['Seasonal veg', 'Whole-wheat roti', 'Plain yoghurt'] },
      dinner: { mealType: 'Dinner', name: 'Chicken & Vegetable Soup', portionGuide: '1 large bowl chicken-vegetable soup + 1 small whole-wheat roti', sugarImpact: 'Low', description: 'A protein-rich soup is light on the stomach in the evening, easy on blood sugar, and perfect with one small roti for slow-release energy through the night.', calories: dinnerCal, macros: { carbs: Math.round(dinnerCal * 0.30 / 4), protein: Math.round(dinnerCal * 0.40 / 4), fat: Math.round(dinnerCal * 0.30 / 9) }, tags: ['High Protein', 'Low GI'], ingredients: ['Chicken', 'Carrot', 'Beans', 'Whole-wheat roti'] },
      snack: { mealType: 'Snack', name: 'Guava + Walnuts', portionGuide: '1 small guava + 4 walnut halves', sugarImpact: 'Low', description: 'Guava is one of the best low-GI fruits for diabetics — rich in fibre and vitamin C. Walnuts add omega-3 and slow the sugar release.', calories: snackCal, macros: { carbs: Math.round(snackCal * 0.50 / 4), protein: Math.round(snackCal * 0.10 / 4), fat: Math.round(snackCal * 0.40 / 9) }, tags: ['Low GI'], ingredients: ['Guava', 'Walnuts'] }
    }
  ];

  const template = mealTemplates[dayIndex % mealTemplates.length];
  return [template.breakfast, template.lunch, template.dinner, template.snack];
}

// ---------------------------------------------------------------------------
// "Can I eat this?" food checker
// ---------------------------------------------------------------------------
export const checkFood = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }

    const { food, portion } = req.body;

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    try {
      const result = await checkFoodSafetyWithAI(user, food.trim(), portion || '');
      if (!result) throw new Error('No AI result');
      recordOpenAiUsage(req.userId, result.usage, 'food-safety-check', 'gpt-4o-mini').catch(() => {});
      const { usage, ...foodCheckResult } = result;
      return res.json({ success: true, food: food.trim(), portion: portion || '', result: foodCheckResult });
    } catch (err) {
      console.warn('[checkFood] AI failed, using fallback:', err.message);
      const lower = food.toLowerCase();
      const watchList = ['sugar', 'mithai', 'gulab jamun', 'jalebi', 'soft drink', 'coke', 'pepsi', 'fruit juice', 'white rice', 'biryani', 'naan'];
      const safeList = ['vegetable', 'salad', 'cucumber', 'spinach', 'daal', 'lentil', 'chicken', 'fish', 'egg', 'yoghurt', 'almond', 'walnut', 'apple', 'pear', 'guava', 'berry'];
      const isWatch = watchList.some(w => lower.includes(w));
      const isSafe = safeList.some(w => lower.includes(w));
      const verdict = isWatch ? 'Eat with care' : (isSafe ? 'Safe' : 'Eat with care');
      return res.json({
        success: true,
        food: food.trim(),
        portion: portion || '',
        result: {
          verdict,
          reason: verdict === 'Safe'
            ? 'This food is generally low impact on blood sugar.'
            : 'This food can raise blood sugar — keep the portion small and pair with protein or fibre.',
          safePortion: verdict === 'Safe' ? '1 normal serving' : 'A very small portion (e.g. ½ cup)',
          sugarImpact: verdict === 'Safe' ? 'Low' : 'Watch',
          betterAlternatives: ['Vegetable salad', 'Plain yoghurt', 'Boiled egg'],
          tips: ['Pair carbs with protein or fibre', 'Walk 10 minutes after eating']
        }
      });
    }
  } catch (error) {
    console.error('[checkFood] error:', error);
    res.status(500).json({ success: false, message: 'Failed to check food', error: error.message });
  }
};

// ---------------------------------------------------------------------------
// Sugar-safe food swaps
// ---------------------------------------------------------------------------
export const foodSwaps = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation error', errors: errors.array() });
    }

    const { food } = req.body;

    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!isProUser(user)) {
      return res.status(403).json({
        success: false,
        message: 'Swap Meal Pro is available for Pro users.',
        code: 'PRO_REQUIRED'
      });
    }

    try {
      const result = await generateFoodSwapsWithAI(user, food.trim());
      const swaps = Array.isArray(result) ? result : result?.swaps;
      if (!swaps || !swaps.length) throw new Error('No swaps returned');
      recordOpenAiUsage(req.userId, result?.usage, 'food-swap', 'gpt-4o-mini').catch(() => {});
      return res.json({ success: true, food: food.trim(), swaps });
    } catch (err) {
      console.warn('[foodSwaps] AI failed, using fallback:', err.message);
      const fallback = [
        { original: food.trim(), swap: 'Vegetable salad with lemon', portion: '1 bowl', sugarImpact: 'Low', why: 'High fibre, very low GI.' },
        { original: food.trim(), swap: 'Plain yoghurt with chia', portion: '1 cup', sugarImpact: 'Low', why: 'High protein, no added sugar.' },
        { original: food.trim(), swap: 'Boiled chana chaat (no chutney sugar)', portion: '½ cup', sugarImpact: 'Low', why: 'Plant protein + fibre, slow digestion.' },
        { original: food.trim(), swap: 'Apple + 6 almonds', portion: '1 small apple', sugarImpact: 'Low', why: 'Natural sweetness balanced by fat & protein.' }
      ];
      return res.json({ success: true, food: food.trim(), swaps: fallback });
    }
  } catch (error) {
    console.error('[foodSwaps] error:', error);
    res.status(500).json({ success: false, message: 'Failed to get swaps', error: error.message });
  }
};

// ---------------------------------------------------------------------------
// Diet Rescue
// ---------------------------------------------------------------------------
const rescueMealTemplates = {
  breakfast: {
    name: 'Diet Rescue Veggie Egg Plate',
    portionGuide: '2 boiled egg whites + cucumber-tomato salad + unsweetened tea',
    description: 'A very light protein-focused breakfast with fresh vegetables to keep the rest of the day steady after extra food.',
    ingredients: ['Egg whites', 'Cucumber', 'Tomato', 'Green tea'],
  },
  lunch: {
    name: 'Diet Rescue Grilled Chicken Salad',
    portionGuide: '1 large salad bowl + 90 g grilled chicken + lemon dressing, no sugary sauces',
    description: 'Lean protein and high-volume vegetables replace heavier lunch items so the remaining day stays lighter.',
    ingredients: ['Chicken breast', 'Lettuce', 'Cucumber', 'Tomato', 'Lemon'],
  },
  dinner: {
    name: 'Diet Rescue Clear Soup + Salad',
    portionGuide: '1 large bowl vegetable clear soup + side cucumber salad',
    description: 'A low-calorie dinner built around broth and non-starchy vegetables to compensate for overeating earlier.',
    ingredients: ['Vegetable broth', 'Spinach', 'Carrot', 'Cucumber', 'Lemon'],
  },
  snack: {
    name: 'Diet Rescue Cucumber Raita',
    portionGuide: '1 small bowl plain yoghurt cucumber raita, no added sugar',
    description: 'A small cooling snack with protein and water-rich cucumber, designed to avoid pushing calories higher.',
    ingredients: ['Plain yoghurt', 'Cucumber', 'Mint'],
  },
};

const rescueMacroSplit = (calories, mealType, proteinGrams = null) => {
  const type = String(mealType || '').toLowerCase();
  const fallbackProteinRatio = type.includes('snack') ? 0.22 : 0.38;
  const maxProteinFromCalories = Math.floor((calories * 0.48) / 4);
  const protein = proteinGrams == null
    ? Math.round((calories * fallbackProteinRatio) / 4)
    : Math.max(0, Math.min(maxProteinFromCalories, Math.round(proteinGrams)));
  const carbRatio = type.includes('dinner') ? 0.25 : 0.32;
  const proteinCalories = protein * 4;
  const remainingCalories = Math.max(0, calories - proteinCalories);
  const carbs = Math.max(0, Math.round((calories * carbRatio) / 4));
  const fat = Math.max(0, Math.round(Math.max(0, remainingCalories - (carbs * 4)) / 9));
  return {
    carbs,
    protein,
    fat,
  };
};

const dietRescueMealTitle = (name) => {
  const originalName = String(name || 'Meal')
    .replace(/^Diet Rescue Meal:\s*/i, '')
    .replace(/^Diet Rescue\s+/i, '')
    .trim();
  return `Diet Rescue Meal: ${originalName || 'Meal'}`;
};

const buildRescueMeal = (meal, calories, proteinGrams) => {
  const originalName = meal.name;
  const mealType = meal.mealType || 'Snack';
  const key = String(mealType).toLowerCase();
  const template =
    (key.includes('breakfast') && rescueMealTemplates.breakfast) ||
    (key.includes('lunch') && rescueMealTemplates.lunch) ||
    (key.includes('dinner') && rescueMealTemplates.dinner) ||
    rescueMealTemplates.snack;

  meal.name = dietRescueMealTitle(originalName);
  meal.description = template.description;
  meal.portionGuide = template.portionGuide;
  meal.sugarImpact = 'Low';
  meal.calories = calories;
  meal.macros = rescueMacroSplit(calories, mealType, proteinGrams);
  meal.tags = Array.from(new Set([...(meal.tags || []), 'Diet Rescue', 'Light meal', 'Low calorie']));
  meal.ingredients = template.ingredients;
};

export const dietRescue = async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!isProUser(user)) {
      return res.status(403).json({
        success: false,
        message: 'Diet Rescue Mode is available for Pro users.',
        code: 'PRO_REQUIRED'
      });
    }

    const activePlan = await MealPlan.findOne({ userId: req.userId, isActive: true }).sort({ createdAt: -1 });
    if (!activePlan) {
      return res.status(404).json({ success: false, message: 'Meal plan not found' });
    }

    const today = new Date();
    const todayDate = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startDate = new Date(activePlan.startDate);
    const planStartDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
    const diffDays = Math.max(0, Math.floor((todayDate.getTime() - planStartDate.getTime()) / 86400000));
    const dayIndex = Math.min(diffDays, Math.max(0, (activePlan.days?.length || 1) - 1));
    const dayPlan = activePlan.days?.[dayIndex];
    if (!dayPlan || !Array.isArray(dayPlan.meals) || dayPlan.meals.length === 0) {
      return res.status(404).json({ success: false, message: 'No meals found for today.' });
    }
    const preservedDayTotalCalories = Number(dayPlan.totalCalories) || Number(activePlan.dailyCalorieTarget || 0);
    const preservedDayTotalMacros = {
      carbs: Number(dayPlan.totalMacros?.carbs ?? activePlan.dailyMacroTargets?.carbs ?? 0),
      protein: Number(dayPlan.totalMacros?.protein ?? activePlan.dailyMacroTargets?.protein ?? 0),
      fat: Number(dayPlan.totalMacros?.fat ?? activePlan.dailyMacroTargets?.fat ?? 0),
    };

    const tomorrowDate = new Date(todayDate);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const foodLogs = await FoodLog.find({
      userId: req.userId,
      $or: [
        { date: { $gte: todayDate, $lt: tomorrowDate } },
        { timestamp: { $gte: todayDate, $lt: tomorrowDate } },
      ],
    }).lean();
    const consumed = foodLogs.reduce((sum, log) => sum + (Number(log.calories) || 0), 0);
    const consumedProtein = foodLogs.reduce(
      (sum, log) => sum + (Number(log.macros?.protein) || Number(log.protein) || 0),
      0
    );
    const dailyCalorieTarget = Number(activePlan.dailyCalorieTarget || dayPlan.totalCalories || 0);
    const dailyProteinTarget = Number(activePlan.dailyMacroTargets?.protein || dayPlan.totalMacros?.protein || 0);
    const remainingBudget = Math.max(0, dailyCalorieTarget - consumed);
    const completedKeys = new Set(
      foodLogs
        .filter((log) => log.source === 'meal_plan' && log.status === 'completed' && log.plannedMealKey)
        .map((log) => String(log.plannedMealKey))
    );
    const skippedKeys = new Set(
      foodLogs
        .filter((log) => log.source === 'meal_plan' && log.status === 'skipped' && log.plannedMealKey)
        .map((log) => String(log.plannedMealKey))
    );
    const remainingMeals = dayPlan.meals.filter((meal) => {
      const key = `${meal.mealType || 'Snack'}::${String(meal.name || '').trim().toLowerCase()}`;
      return !completedKeys.has(key) && !skippedKeys.has(key);
    });

    if (remainingMeals.length === 0) {
      return res.json({
        success: true,
        message: 'All planned meals for today are already logged. No remaining meals to adjust.',
        adjustedMeals: 0,
      });
    }

    const originalRemainingCalories = remainingMeals.reduce(
      (sum, meal) => sum + (Number(meal.calories) || 0),
      0
    );
    const originalRemainingProtein = remainingMeals.reduce(
      (sum, meal) => sum + (Number(meal.macros?.protein) || 0),
      0
    );
    const minRemainingCalories = remainingMeals.reduce((sum, meal) => {
      const type = String(meal.mealType || '').toLowerCase();
      return sum + (type.includes('snack') ? 140 : 260);
    }, 0);
    const minRemainingProtein = remainingMeals.reduce((sum, meal) => {
      const type = String(meal.mealType || '').toLowerCase();
      return sum + (type.includes('snack') ? 8 : 18);
    }, 0);
    const rescueBudget = Math.max(
      minRemainingCalories,
      Math.min(
        originalRemainingCalories || minRemainingCalories,
        remainingBudget || minRemainingCalories
      )
    );
    const remainingProteinBudget = Math.max(
      minRemainingProtein,
      Math.min(
        originalRemainingProtein || minRemainingProtein,
        Math.max(0, dailyProteinTarget - consumedProtein)
      )
    );
    const originalBudget = originalRemainingCalories || remainingMeals.length;
    const originalProteinBudget = originalRemainingProtein || remainingMeals.length;

    for (const meal of remainingMeals) {
      const originalCalories = Number(meal.calories) || (originalBudget / remainingMeals.length);
      const share = originalBudget > 0 ? originalCalories / originalBudget : 1 / remainingMeals.length;
      const proteinShare = originalProteinBudget > 0
        ? (Number(meal.macros?.protein) || 0) / originalProteinBudget
        : share;
      const type = String(meal.mealType || '').toLowerCase();
      const minCalories = type.includes('snack') ? 140 : 260;
      const maxCalories = Math.max(minCalories, originalCalories);
      const rescueCalories = Math.round(rescueBudget * share);
      const newCalories = Math.max(minCalories, Math.min(maxCalories, rescueCalories));
      const minProtein = type.includes('snack') ? 8 : 18;
      const rescueProtein = Math.round(remainingProteinBudget * proteinShare);
      const maxProtein = Math.max(minProtein, Math.floor((newCalories * 0.48) / 4));
      const newProtein = Math.max(minProtein, Math.min(maxProtein, rescueProtein));
      buildRescueMeal(meal, newCalories, newProtein);
    }

    dayPlan.totalCalories = preservedDayTotalCalories;
    dayPlan.totalMacros = preservedDayTotalMacros;
    await activePlan.save();

    return res.json({
      success: true,
      message: `Diet Rescue updated ${remainingMeals.length} remaining meal${remainingMeals.length === 1 ? '' : 's'} for today.`,
      adjustedMeals: remainingMeals.length,
      remainingBudget,
    });
  } catch (error) {
    console.error('[dietRescue] error:', error);
    res.status(500).json({ success: false, message: 'Failed to start Diet Rescue Mode', error: error.message });
  }
};

// ---------------------------------------------------------------------------
// Weekly grocery list
// ---------------------------------------------------------------------------
export const groceryList = async (req, res) => {
  try {
    const { mealPlanId, generate } = req.query;
    const shouldGenerate = generate === 'true' || generate === true;
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const planQuery = mealPlanId
      ? { _id: mealPlanId, userId: req.userId }
      : { userId: req.userId, isActive: true };
    const activePlan = await MealPlan.findOne(planQuery).sort({ createdAt: -1 });
    if (!activePlan) return res.status(404).json({ success: false, message: 'Meal plan not found' });

    if (activePlan.groceryList && !shouldGenerate) {
      return res.json({
        success: true,
        hasList: true,
        generatedAt: activePlan.groceryListGeneratedAt,
        list: activePlan.groceryList
      });
    }

    if (!shouldGenerate) {
      return res.json({
        success: true,
        hasList: false,
        generatedAt: null,
        list: null
      });
    }

    const plannedMeals = [];
    if (activePlan && Array.isArray(activePlan.days)) {
      for (const day of activePlan.days) {
        for (const m of day.meals || []) {
          if (m?.name) {
            plannedMeals.push([m.mealType, m.name, m.portionGuide].filter(Boolean).join(': '));
          }
        }
      }
    }

    try {
      const result = await generateGroceryListWithAI(user, plannedMeals);
      if (!result || !result.categories || !result.categories.length) throw new Error('Empty grocery list');
      recordOpenAiUsage(req.userId, result.usage, 'grocery-list', 'gpt-4o-mini').catch(() => {});
      const { usage, ...list } = result;
      activePlan.groceryList = list;
      activePlan.groceryListGeneratedAt = new Date();
      await activePlan.save();
      return res.json({
        success: true,
        hasList: true,
        generatedAt: activePlan.groceryListGeneratedAt,
        list
      });
    } catch (err) {
      console.warn('[groceryList] AI failed, using fallback:', err.message);
      const fallback = {
        categories: [
          { name: 'Vegetables', items: [
            { name: 'Spinach', quantity: '500 g', note: 'For daal palak' },
            { name: 'Tomato', quantity: '1 kg', note: '' },
            { name: 'Onion', quantity: '1 kg', note: '' },
            { name: 'Cucumber', quantity: '500 g', note: 'Salad' },
            { name: 'Mixed seasonal veg', quantity: '1 kg', note: 'For sabzi' }
          ]},
          { name: 'Fruits (low sugar)', items: [
            { name: 'Apple', quantity: '5 pieces', note: '' },
            { name: 'Guava', quantity: '5 pieces', note: '' },
            { name: 'Berries (any)', quantity: '250 g', note: 'Optional' }
          ]},
          { name: 'Grains & Pulses', items: [
            { name: 'Whole-wheat atta', quantity: '2 kg', note: 'For roti' },
            { name: 'Brown rice', quantity: '1 kg', note: 'Replaces white rice' },
            { name: 'Masoor daal', quantity: '500 g', note: '' },
            { name: 'Moong daal', quantity: '500 g', note: '' }
          ]},
          { name: 'Protein', items: [
            { name: 'Chicken breast', quantity: '1 kg', note: '' },
            { name: 'Eggs', quantity: '1 dozen', note: '' },
            { name: 'White fish', quantity: '500 g', note: 'Optional' }
          ]},
          { name: 'Dairy & Eggs', items: [
            { name: 'Plain yoghurt', quantity: '1 kg', note: 'No added sugar' }
          ]},
          { name: 'Pantry / Spices', items: [
            { name: 'Olive / mustard oil', quantity: '500 ml', note: '' },
            { name: 'Cumin, turmeric, coriander', quantity: 'as needed', note: '' },
            { name: 'Chia seeds', quantity: '100 g', note: '' },
            { name: 'Green tea', quantity: '1 pack', note: '' }
          ]},
          { name: 'Snacks (diabetic-safe)', items: [
            { name: 'Almonds', quantity: '250 g', note: '' },
            { name: 'Walnuts', quantity: '200 g', note: '' },
            { name: 'Roasted chana', quantity: '250 g', note: '' }
          ]}
        ],
        avoid: ['White sugar', 'Soft drinks', 'Fruit juice', 'Sweets / mithai', 'Naan / refined-flour breads']
      };
      activePlan.groceryList = fallback;
      activePlan.groceryListGeneratedAt = new Date();
      await activePlan.save();
      return res.json({
        success: true,
        hasList: true,
        generatedAt: activePlan.groceryListGeneratedAt,
        list: fallback,
        fallback: true
      });
    }
  } catch (error) {
    console.error('[groceryList] error:', error);
    res.status(500).json({ success: false, message: 'Failed to build grocery list', error: error.message });
  }
};
