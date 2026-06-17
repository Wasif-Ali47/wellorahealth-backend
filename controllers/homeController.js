import FoodLog from '../models/FoodLog.js';
import WaterLog from '../models/WaterLog.js';
import MealPlan from '../models/MealPlan.js';
import User from '../models/User.js';
import { startOfDay } from '../services/naturalLogParserService.js';
import { buildClientDayRange, proteinFromLog } from '../utils/foodLogHelpers.js';

/**
 * GET /api/home/dashboard — today's summary for the home screen.
 */
export const getHomeDashboard = async (req, res) => {
  try {
    const userId = req.userId;

    // Match how logs are saved (server startOfDay on `date`) + widen for client timezone
    const today = startOfDay();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const ranges = [{ start: today, end: tomorrow }];
    const clientRange = buildClientDayRange({
      today: true,
      timezoneOffset: req.query.timezoneOffset,
    });
    if (clientRange) ranges.push(clientRange);

    const rangeStart = new Date(Math.min(...ranges.map((r) => r.start.getTime())));
    const rangeEnd = new Date(Math.max(...ranges.map((r) => r.end.getTime())));

    const dayFilter = {
      $or: [
        { date: { $gte: rangeStart, $lt: rangeEnd } },
        { timestamp: { $gte: rangeStart, $lt: rangeEnd } },
      ],
    };

    const user = await User.findById(userId).select('firstName weight coachProfile');
    const mealPlan = await MealPlan.findOne({ userId, isActive: true }).sort({ createdAt: -1 });

    const macroTargets = mealPlan?.dailyMacroTargets || { protein: 120, carbs: 150, fat: 65 };
    // Water target must only change when the meal plan changes (regeneration),
    // never just because the user's weight was logged. Use the plan's stored
    // value; fall back to a fixed default (not a live recalculation from
    // current weight) for legacy plans that predate this field.
    const planWaterLitres = Number(mealPlan?.waterTargetLitres);
    const estimatedWaterLitres = Number.isFinite(planWaterLitres) && planWaterLitres > 0
      ? Math.round(planWaterLitres)
      : 3;
    const waterTargetMl = estimatedWaterLitres * 1000;

    const foodLogs = await FoodLog.find({ userId, ...dayFilter }).lean();

    const waterLogs = await WaterLog.find({ userId, ...dayFilter }).lean();

    const caloriesConsumed = foodLogs.reduce((s, l) => s + (Number(l.calories) || 0), 0);
    let proteinConsumed = foodLogs.reduce((s, l) => s + proteinFromLog(l), 0);

    if (proteinConsumed === 0 && caloriesConsumed > 0) {
      proteinConsumed = Math.round((caloriesConsumed * 0.30) / 4);
    }
    const waterMl = waterLogs.reduce((s, l) => s + (l.amountMl || 0), 0);

    // Calendar-day diff from the plan's startDate (client-local "today" vs
    // the client-local day the plan started on) — NOT elapsed milliseconds
    // since createdAt, which drifts a day off whenever the user is in a
    // timezone ahead of the server and generates/opens the app near midnight.
    const todayDayNumber = mealPlan?.days?.length
      ? (() => {
          const todayStart = clientRange ? clientRange.start : today;
          const planStart = new Date(mealPlan.startDate);
          const diffDays = Math.round((todayStart.getTime() - planStart.getTime()) / 86400000);
          return Math.min(Math.max(diffDays + 1, 1), mealPlan.days.length);
        })()
      : 1;

    const todayPlanDay = mealPlan?.days?.find((d) => d.dayNumber === todayDayNumber)
      || mealPlan?.days?.[0];

    const plannedLogsByKey = new Map();
    for (const log of foodLogs) {
      if (log.source === 'meal_plan' && log.plannedMealKey) {
        plannedLogsByKey.set(log.plannedMealKey, log);
      }
    }

    const meals = (todayPlanDay?.meals || []).map((m) => {
      const macros = m.macros || {};
      const key = `${m.mealType || 'Snack'}::${String(m.name || '').trim().toLowerCase()}`;
      const plannedLog = plannedLogsByKey.get(key);
      return {
        name: m.name,
        mealType: m.mealType,
        calories: m.calories,
        portionGuide: m.portionGuide || '',
        macros: {
          protein: Number(macros.protein || 0),
          carbs: Number(macros.carbs || 0),
          fat: Number(macros.fat || 0),
        },
        protein: Number(macros.protein || 0),
        time: mealTimeLabel(m.mealType),
        eaten: plannedLog?.status === 'completed',
        skipped: plannedLog?.status === 'skipped',
        logId: plannedLog?._id?.toString(),
        plannedMealKey: key,
      };
    });

    const plannedMealCalories = (todayPlanDay?.meals || [])
      .reduce((sum, meal) => sum + (Number(meal.calories) || 0), 0);
    const plannedMealProtein = (todayPlanDay?.meals || [])
      .reduce((sum, meal) => sum + (Number(meal.macros?.protein) || Number(meal.protein) || 0), 0);

    // Keep daily goals aligned with the exact meals shown for the current plan day.
    const calorieTarget = Math.round(
      Number(todayPlanDay?.totalCalories) || plannedMealCalories || Number(mealPlan?.dailyCalorieTarget) || 1820
    );
    const effectiveProteinTarget = Math.round(
      Number(todayPlanDay?.totalMacros?.protein) || plannedMealProtein || Number(macroTargets.protein) || 120
    );

    // Append extra food logs (not from meal plan) as additional meal entries
    const extraFoodLogs = foodLogs.filter((l) => l.source !== 'meal_plan');
    for (const log of extraFoodLogs) {
      const macros = log.macros || {};
      meals.push({
        name: log.foodName || log.displayTitle || 'Extra food',
        mealType: 'Extra food',
        calories: Number(log.calories) || 0,
        portionGuide: '',
        macros: {
          protein: Number(macros.protein || 0),
          carbs: Number(macros.carbs || 0),
          fat: Number(macros.fat || 0),
        },
        protein: Number(macros.protein || 0),
        time: '',
        eaten: true,
        skipped: false,
        logId: log._id?.toString(),
        isExtraLog: true,
      });
    }

    res.json({
      success: true,
      dashboard: {
        greetingName: user?.firstName || 'there',
        planDay: todayDayNumber,
        calories: {
          consumed: caloriesConsumed,
          target: calorieTarget,
          remaining: Math.max(0, calorieTarget - caloriesConsumed)
        },
        water: {
          consumedMl: waterMl,
          targetMl: waterTargetMl,
          displayL: waterMl / 1000,
          targetL: waterTargetMl / 1000
        },
        protein: {
          consumed: proteinConsumed,
          target: effectiveProteinTarget,
        },
        macroTargets,
        todaysMeals: meals,
        currentWeight: user?.weight,
        targetWeight: user?.coachProfile?.targetWeight
      }
    });
  } catch (error) {
    console.error('[getHomeDashboard]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to load home dashboard',
      error: error.message
    });
  }
};

function mealTimeLabel(mealType) {
  const map = {
    Breakfast: '8:00 AM',
    Lunch: '1:00 PM',
    Snack: '4:00 PM',
    Dinner: '7:30 PM'
  };
  return map[mealType] || '';
}
