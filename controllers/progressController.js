import ProgressLog from '../models/ProgressLog.js';
import FoodLog from '../models/FoodLog.js';
import { proteinFromLog, toLocalDateKey } from '../utils/foodLogHelpers.js';
import ActivityLog from '../models/ActivityLog.js';
import MealPlan from '../models/MealPlan.js';
import SymptomLog from '../models/SymptomLog.js';
import User from '../models/User.js';

/**
 * Log weight entry
 */
export const logWeight = async (req, res) => {
  try {
    const { weight, date, notes } = req.body;

    if (!weight || weight <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid weight is required'
      });
    }

    const progressLog = new ProgressLog({
      userId: req.userId,
      weight,
      date: date ? new Date(date) : new Date(),
      notes
    });

    await progressLog.save();

    // Also update user's current weight
    const User = (await import('../models/User.js')).default;
    await User.findByIdAndUpdate(req.userId, { weight });

    res.status(201).json({
      success: true,
      message: 'Weight logged successfully',
      progressLog
    });
  } catch (error) {
    console.error('[logWeight] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to log weight',
      error: error.message
    });
  }
};

/**
 * Get weight progress
 */
export const getWeightProgress = async (req, res) => {
  try {
    const { startDate, endDate, limit = 100 } = req.query;
    
    const query = { userId: req.userId };
    
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const logs = await ProgressLog.find(query)
      .sort({ date: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      count: logs.length,
      logs
    });
  } catch (error) {
    console.error('[getWeightProgress] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get weight progress',
      error: error.message
    });
  }
};

/**
 * Get progress dashboard data (calorie adherence, macro balance, symptom frequency)
 */
function emptyDaySummary(dateKey) {
  return {
    date: dateKey,
    caloriesConsumed: 0,
    caloriesBurned: 0,
    carbs: 0,
    protein: 0,
    fat: 0,
    fibre: 0,
    symptoms: {},
  };
}

function computeLoggingStreak(caloriesByDay, timezoneOffset) {
  let streak = 0;
  const cursor = new Date();
  const todayKey = toLocalDateKey(cursor, timezoneOffset);
  const todayLogged = (caloriesByDay[todayKey] || 0) > 0;
  if (!todayLogged) {
    cursor.setDate(cursor.getDate() - 1);
  }
  for (let i = 0; i < 365; i++) {
    const key = toLocalDateKey(cursor, timezoneOffset);
    if ((caloriesByDay[key] || 0) <= 0) break;
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return todayLogged || streak === 0 ? streak : streak + 1;
}

export const getProgressDashboard = async (req, res) => {
  try {
    const { startDate, endDate, granularity, timezoneOffset } = req.query;
    const end = endDate ? new Date(endDate) : new Date();
    let start;
    if (startDate) {
      start = new Date(startDate);
    } else {
      start = new Date();
      start.setDate(start.getDate() - 7);
    }

    const periodFilter = {
      $or: [
        { date: { $gte: start, $lte: end } },
        { timestamp: { $gte: start, $lte: end } },
      ],
    };

    const user = await User.findById(req.userId).select('email subscriptionPlan isPro').lean();
    const isGuest = /^guest_[^@]+@wellorahealth\.app$/i.test(user?.email || '');

    // Get user's meal plan for targets
    const mealPlan = await MealPlan.findOne({
      userId: req.userId,
      isActive: true
    }).sort({ createdAt: -1 });

    const dailyCalorieTarget = mealPlan?.dailyCalorieTarget || 1820;
    const dailyMacroTargets = mealPlan?.dailyMacroTargets || {
      carbs: 182,
      protein: 137,
      fat: 61
    };

    const foodLogs = await FoodLog.find({
      userId: req.userId,
      ...periodFilter,
    }).lean();

    const activityLogs = await ActivityLog.find({
      userId: req.userId,
      ...periodFilter,
    }).lean();

    const symptomLogs = await SymptomLog.find({
      userId: req.userId,
      ...periodFilter,
    }).lean();

    // Streak: consecutive days with food logged (up to 30 days lookback)
    const streakStart = new Date();
    streakStart.setDate(streakStart.getDate() - 30);
    const streakLogs = await FoodLog.find({
      userId: req.userId,
      $or: [
        { date: { $gte: streakStart, $lte: end } },
        { timestamp: { $gte: streakStart, $lte: end } },
      ],
    }).lean();

    const caloriesByDay = {};
    streakLogs.forEach((log) => {
      const dateKey = toLocalDateKey(log.timestamp || log.date, timezoneOffset);
      caloriesByDay[dateKey] = (caloriesByDay[dateKey] || 0) + (Number(log.calories) || 0);
    });
    const loggingStreak = isGuest ? 0 : computeLoggingStreak(caloriesByDay, timezoneOffset);

    // Daily summaries for chart (local calendar days)
    const dailySummaries = {};
    const dateKeys = [];

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateKey = toLocalDateKey(d, timezoneOffset);
      if (!dailySummaries[dateKey]) {
        dateKeys.push(dateKey);
        dailySummaries[dateKey] = emptyDaySummary(dateKey);
      }
    }

    foodLogs.forEach((log) => {
      const dateKey = toLocalDateKey(log.timestamp || log.date, timezoneOffset);
      if (!dailySummaries[dateKey]) {
        dateKeys.push(dateKey);
        dailySummaries[dateKey] = emptyDaySummary(dateKey);
      }
      dailySummaries[dateKey].caloriesConsumed += Number(log.calories) || 0;
      dailySummaries[dateKey].carbs += Number(log.macros?.carbs) || 0;
      dailySummaries[dateKey].protein += proteinFromLog(log);
      dailySummaries[dateKey].fat += Number(log.macros?.fat) || 0;
      dailySummaries[dateKey].fibre += Number(log.macros?.fibre) || 0;
    });

    activityLogs.forEach((log) => {
      const dateKey = toLocalDateKey(log.timestamp || log.date, timezoneOffset);
      if (!dailySummaries[dateKey]) {
        dateKeys.push(dateKey);
        dailySummaries[dateKey] = emptyDaySummary(dateKey);
      }
      dailySummaries[dateKey].caloriesBurned += Number(log.caloriesBurned) || 0;
    });

    symptomLogs.forEach((log) => {
      const dateKey = toLocalDateKey(log.timestamp || log.date, timezoneOffset);
      if (!dailySummaries[dateKey]) {
        dateKeys.push(dateKey);
        dailySummaries[dateKey] = emptyDaySummary(dateKey);
      }
      if (!dailySummaries[dateKey].symptoms[log.symptomType]) {
        dailySummaries[dateKey].symptoms[log.symptomType] = [];
      }
      dailySummaries[dateKey].symptoms[log.symptomType].push(log.rating);
    });

    // Calculate adherence percentages
    const summaries = dateKeys.sort().map((dateKey) => {
      const summary = dailySummaries[dateKey];
      const netCalories = summary.caloriesConsumed - summary.caloriesBurned;
      const adherence = dailyCalorieTarget > 0 
        ? Math.min(100, Math.max(0, (netCalories / dailyCalorieTarget) * 100))
        : 0;

      return {
        ...summary,
        netCalories,
        calorieAdherence: Math.round(adherence),
        macroBalance: {
          carbs: Math.round((summary.carbs / dailyMacroTargets.carbs) * 100),
          protein: Math.round((summary.protein / dailyMacroTargets.protein) * 100),
          fat: Math.round((summary.fat / dailyMacroTargets.fat) * 100)
        }
      };
    });

    let resultSummaries = summaries;
    if (granularity === 'monthly') {
      const monthMap = {};
      for (const s of summaries) {
        const ym = s.date.substring(0, 7);
        if (!monthMap[ym]) {
          monthMap[ym] = {
            date: `${ym}-01`,
            caloriesConsumed: 0,
            caloriesBurned: 0,
            carbs: 0,
            protein: 0,
            fat: 0,
            fibre: 0,
            symptoms: {},
            adherenceSum: 0,
            macroCarbsSum: 0,
            macroProteinSum: 0,
            macroFatSum: 0,
            dayCount: 0
          };
        }
        const m = monthMap[ym];
        m.caloriesConsumed += s.caloriesConsumed || 0;
        m.caloriesBurned += s.caloriesBurned || 0;
        m.carbs += s.carbs || 0;
        m.protein += s.protein || 0;
        m.fat += s.fat || 0;
        m.fibre += s.fibre || 0;
        m.adherenceSum += s.calorieAdherence || 0;
        m.macroCarbsSum += s.macroBalance?.carbs || 0;
        m.macroProteinSum += s.macroBalance?.protein || 0;
        m.macroFatSum += s.macroBalance?.fat || 0;
        m.dayCount += 1;
        for (const [symptomType, ratings] of Object.entries(s.symptoms || {})) {
          if (!m.symptoms[symptomType]) m.symptoms[symptomType] = [];
          m.symptoms[symptomType].push(...ratings);
        }
      }
      resultSummaries = Object.keys(monthMap).sort().map((ym) => {
        const m = monthMap[ym];
        const netCalories = m.caloriesConsumed - m.caloriesBurned;
        const dc = m.dayCount || 1;
        return {
          date: m.date,
          caloriesConsumed: m.caloriesConsumed,
          caloriesBurned: m.caloriesBurned,
          netCalories,
          carbs: m.carbs,
          protein: m.protein,
          fat: m.fat,
          fibre: m.fibre,
          symptoms: m.symptoms,
          calorieAdherence: Math.round(m.adherenceSum / dc),
          macroBalance: {
            carbs: Math.round(m.macroCarbsSum / dc),
            protein: Math.round(m.macroProteinSum / dc),
            fat: Math.round(m.macroFatSum / dc)
          }
        };
      });
    }

    res.json({
      success: true,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      dailyCalorieTarget,
      dailyMacroTargets,
      loggingStreak,
      summaries: resultSummaries
    });
  } catch (error) {
    console.error('[getProgressDashboard] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get progress dashboard',
      error: error.message
    });
  }
};

/**
 * Delete progress log
 */
export const deleteProgressLog = async (req, res) => {
  try {
    const log = await ProgressLog.findOneAndDelete({
      _id: req.params.id,
      userId: req.userId
    });

    if (!log) {
      return res.status(404).json({
        success: false,
        message: 'Progress log not found'
      });
    }

    res.json({
      success: true,
      message: 'Progress log deleted successfully'
    });
  } catch (error) {
    console.error('[deleteProgressLog] Error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete progress log',
      error: error.message
    });
  }
};
