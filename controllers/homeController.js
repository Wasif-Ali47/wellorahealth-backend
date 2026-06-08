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

    const calorieTarget = mealPlan?.dailyCalorieTarget || 2000;
    const macroTargets = mealPlan?.dailyMacroTargets || { protein: 120, carbs: 150, fat: 65 };
    const estimatedWaterLitres = Math.max(
      2,
      Math.min(5, Math.round(((Number(user?.weight) || 70) * 35) / 1000))
    );
    const waterTargetMl = estimatedWaterLitres * 1000;

    const foodLogs = await FoodLog.find({ userId, ...dayFilter }).lean();

    const waterLogs = await WaterLog.find({ userId, ...dayFilter }).lean();

    const caloriesConsumed = foodLogs.reduce((s, l) => s + (Number(l.calories) || 0), 0);
    let proteinConsumed = foodLogs.reduce((s, l) => s + proteinFromLog(l), 0);

    if (proteinConsumed === 0 && caloriesConsumed > 0) {
      proteinConsumed = Math.round((caloriesConsumed * 0.30) / 4);
    }
    const waterMl = waterLogs.reduce((s, l) => s + (l.amountMl || 0), 0);

    const todayDayNumber = mealPlan?.days?.length
      ? Math.min(
          Math.floor((Date.now() - new Date(mealPlan.createdAt).getTime()) / 86400000) + 1,
          mealPlan.days.length
        )
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
          target: macroTargets.protein || 120
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
