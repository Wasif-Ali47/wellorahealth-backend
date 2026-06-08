import FoodLog from '../models/FoodLog.js';
import WaterLog from '../models/WaterLog.js';
import ProgressLog from '../models/ProgressLog.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import { parseNaturalLog, startOfDay } from '../services/naturalLogParserService.js';
import {
  buildFoodLogFields,
  buildPlannedMealLogFields,
  buildClientDayRange,
  formatFoodLogForHistory,
  formatWaterLogForHistory
} from '../utils/foodLogHelpers.js';

function plannedMealKey(mealType, foodName) {
  return `${mealType || 'Snack'}::${String(foodName || '').trim().toLowerCase()}`;
}

async function savePlannedMealLog(req, res) {
  const { foodName, mealType, calories, protein, carbs, fat, status = 'completed' } = req.body;
  if (!foodName?.trim()) {
    return res.status(400).json({ success: false, message: 'foodName is required' });
  }

  const now = new Date();
  const today = startOfDay(now);
  const skipped = status === 'skipped';
  const fields = buildPlannedMealLogFields({
    foodName: skipped ? `Skipped ${foodName.trim()}` : foodName.trim(),
    mealType,
    calories: skipped ? 0 : calories,
    protein: skipped ? 0 : protein,
    carbs: skipped ? 0 : carbs,
    fat: skipped ? 0 : fat,
  });
  const { _display, ...persist } = fields;

  const log = await FoodLog.create({
    userId: req.userId,
    ...persist,
    macros: persist.macros,
    source: 'meal_plan',
    status: skipped ? 'skipped' : 'completed',
    plannedMealKey: plannedMealKey(mealType, foodName),
    date: today,
    timestamp: now,
  });

  return res.status(201).json({
    success: true,
    message: skipped ? 'Meal skipped' : 'Meal logged from your plan',
    source: 'meal_plan',
    organized: [
      {
        type: 'food',
        organizedSummary: persist.organizedSummary,
        displayTitle: _display?.title,
        displaySubtitle: _display?.subtitle,
        items: _display?.items || [],
        calories: persist.calories,
        protein: persist.macros?.protein ?? 0,
        mealType: persist.mealType,
        status: skipped ? 'skipped' : 'completed',
      },
    ],
    saved: { food: [log], water: [], weight: [] },
  });
}

/**
 * POST /api/logs/natural — AI organizes text, OR planned meal (source=meal_plan, no AI).
 */
export const logNatural = async (req, res) => {
  try {
    const {
      text,
      category = 'auto',
      source: logSource,
      foodName,
      mealType,
      calories,
      protein,
      carbs,
      fat,
    } = req.body;

    if (logSource === 'meal_plan' || (foodName && calories != null && !text?.trim())) {
      return await savePlannedMealLog(req, res);
    }

    if (!text?.trim()) {
      return res.status(400).json({ success: false, message: 'Text is required' });
    }

    const { entries, source: parseSource } = await parseNaturalLog(text.trim(), category);
    if (!entries?.length) {
      return res.status(400).json({
        success: false,
        message: 'Could not understand the log. Try being more specific.'
      });
    }

    const now = new Date();
    const today = startOfDay(now);
    const saved = { food: [], water: [], weight: [] };
    const organized = [];

    for (const entry of entries) {
      if (entry.type === 'water' && entry.amountMl > 0) {
        const ml = Math.round(entry.amountMl);
        const glasses = Math.round((ml / 250) * 10) / 10;
        const organizedSummary =
          entry.organizedSummary || `${glasses} glass${glasses === 1 ? '' : 'es'} · ${ml} ml`;

        const log = await WaterLog.create({
          userId: req.userId,
          amountMl: ml,
          rawText: text.trim(),
          organizedSummary,
          parsedDetails: { amountMl: ml, glasses, originalText: text.trim() },
          date: today,
          timestamp: now
        });
        saved.water.push(log);
        organized.push({
          type: 'water',
          organizedSummary,
          originalText: text.trim()
        });
      } else if (entry.type === 'weight' && entry.weightKg > 0) {
        const kg = Math.round(entry.weightKg * 10) / 10;
        const organizedSummary = entry.organizedSummary || `${kg} kg`;
        const log = await ProgressLog.create({
          userId: req.userId,
          weight: kg,
          date: today,
          notes: text.trim()
        });
        await User.findByIdAndUpdate(req.userId, { weight: kg });
        saved.weight.push(log);
        organized.push({
          type: 'weight',
          organizedSummary,
          originalText: text.trim()
        });
      } else if (entry.type === 'food') {
        const fields = buildFoodLogFields(entry, text.trim());
        const { _display, ...persist } = fields;

        const log = await FoodLog.create({
          userId: req.userId,
          ...persist,
          macros: persist.macros,
          date: today,
          timestamp: now
        });
        saved.food.push(log);
        organized.push({
          type: 'food',
          organizedSummary: persist.organizedSummary,
          displayTitle: _display?.title,
          displaySubtitle: _display?.subtitle,
          items: _display?.items || persist.parsedDetails?.items || [],
          calories: persist.calories,
          mealType: persist.mealType,
          originalText: text.trim()
        });
      }
    }

    const totalSaved =
      saved.food.length + saved.water.length + saved.weight.length;
    if (totalSaved === 0) {
      return res.status(400).json({
        success: false,
        message: 'Could not save any log entries. Try rephrasing your input.'
      });
    }

    res.status(201).json({
      success: true,
      message: 'Log saved',
      source: parseSource,
      organized,
      saved
    });
  } catch (error) {
    console.error('[logNatural]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to save log',
      error: error.message
    });
  }
};

/** POST /api/logs/planned-meal — alias for planned meal logging */
export const logPlannedMeal = async (req, res) => {
  try {
    return await savePlannedMealLog(req, res);
  } catch (error) {
    console.error('[logPlannedMeal]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to log planned meal',
      error: error.message,
    });
  }
};

/** DELETE /api/logs/planned-meal/:id — undo planned meal completion/skip */
export const undoPlannedMeal = async (req, res) => {
  try {
    const { plannedMealKey: fallbackKey } = req.body || {};
    const filters = [];
    if (mongoose.Types.ObjectId.isValid(req.params.id)) {
      filters.push({ _id: req.params.id });
    }
    if (fallbackKey) {
      filters.push({ plannedMealKey: fallbackKey });
    }
    if (filters.length === 0) {
      return res.status(400).json({ success: false, message: 'Meal log id is required' });
    }

    const deleted = await FoodLog.findOneAndDelete({
      userId: req.userId,
      source: 'meal_plan',
      $or: filters,
    });
    if (!deleted) {
      return res.status(404).json({ success: false, message: 'Planned meal log not found' });
    }
    res.json({ success: true, message: 'Meal status undone' });
  } catch (error) {
    console.error('[undoPlannedMeal]', error);
    res.status(500).json({
      success: false,
      message: 'Failed to undo meal status',
      error: error.message,
    });
  }
};

/**
 * GET /api/logs/history?category=food|water|weight&limit=50&today=true|date=YYYY-MM-DD
 */
export const getLogHistory = async (req, res) => {
  try {
    const { category = 'food', limit = 50 } = req.query;
    const cap = Math.min(parseInt(limit, 10) || 50, 100);
    const userId = req.userId;
    const range = buildClientDayRange(req.query);

    if (category === 'water') {
      const filter = { userId };
      if (range) {
        filter.$or = [
          { timestamp: { $gte: range.start, $lt: range.end } },
          { date: { $gte: range.start, $lt: range.end } },
        ];
      }
      const logs = await WaterLog.find(filter).sort({ timestamp: -1 }).limit(cap);
      return res.json({
        success: true,
        logs: logs.map(formatWaterLogForHistory)
      });
    }

    if (category === 'weight') {
      const filter = { userId };
      if (range) {
        filter.date = { $gte: range.start, $lt: range.end };
      }
      const logs = await ProgressLog.find(filter).sort({ date: -1 }).limit(cap);
      return res.json({
        success: true,
        logs: logs.map((l) => ({
          id: l._id,
          title: 'Weight',
          subtitle: l.notes || `${l.weight} kg`,
          organizedSummary: `${l.weight} kg`,
          originalText: l.notes || null,
          weight: l.weight,
          timestamp: l.date
        }))
      });
    }

    const filter = { userId };
    if (range) {
      filter.$or = [
        { timestamp: { $gte: range.start, $lt: range.end } },
        { date: { $gte: range.start, $lt: range.end } },
      ];
    }
    const logs = await FoodLog.find(filter).sort({ timestamp: -1 }).limit(cap);
    res.json({
      success: true,
      logs: logs.map(formatFoodLogForHistory)
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to load log history',
      error: error.message
    });
  }
};
