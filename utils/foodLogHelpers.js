const ALLOWED_UNITS = ['g', 'ml', 'cup', 'piece', 'serving'];

const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];

export function normalizePortionUnit(unit) {
  if (!unit) return 'serving';
  const u = String(unit).toLowerCase().trim();
  if (ALLOWED_UNITS.includes(u)) return u;
  if (['gram', 'grams', 'g'].includes(u)) return 'g';
  if (['ml', 'milliliter', 'millilitre'].includes(u)) return 'ml';
  if (['cup', 'cups', 'glass', 'glasses'].includes(u)) return 'cup';
  if (['piece', 'pieces', 'pc', 'slice', 'slices', 'egg', 'eggs', 'roti', 'rotis'].includes(u)) {
    return 'piece';
  }
  return 'serving';
}

export function inferMealTypeFromText(text = '') {
  const lower = text.toLowerCase();
  if (/\b(breakfast|morning)\b/.test(lower)) return 'Breakfast';
  if (/\b(lunch|afternoon|noon)\b/.test(lower)) return 'Lunch';
  if (/\b(dinner|supper|night|evening)\b/.test(lower)) return 'Dinner';
  if (/\b(snack|snacks)\b/.test(lower)) return 'Snack';
  const h = new Date().getHours();
  if (h < 11) return 'Breakfast';
  if (h < 15) return 'Lunch';
  if (h < 18) return 'Snack';
  return 'Dinner';
}

/** Default macro split when only calories are known (30% protein). */
export function estimateMacroGramsFromCalories(calories) {
  const kcal = Math.max(0, Number(calories) || 0);
  return {
    protein: Math.round((kcal * 0.30) / 4),
    carbs: Math.round((kcal * 0.35) / 4),
    fat: Math.round((kcal * 0.35) / 9),
    fibre: 0,
  };
}

export function fillMacrosFromCalories(macros, calories) {
  const est = estimateMacroGramsFromCalories(calories);
  const m = macros || {};
  return {
    protein: m.protein > 0 ? Math.round(m.protein) : est.protein,
    carbs: m.carbs > 0 ? Math.round(m.carbs) : est.carbs,
    fat: m.fat > 0 ? Math.round(m.fat) : est.fat,
    fibre: m.fibre ?? 0,
  };
}

/** Calendar date key YYYY-MM-DD in client or server local timezone. */
export function toLocalDateKey(date, timezoneOffsetMin) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';

  const offset = parseInt(timezoneOffsetMin, 10);
  if (!Number.isNaN(offset)) {
    const shifted = new Date(d.getTime() + offset * 60 * 1000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Day bounds for a calendar day (client timezone when timezoneOffset is set).
 * query: { today?: 'true', date?: 'YYYY-MM-DD', timezoneOffset?: minutes east of UTC }
 */
export function buildClientDayRange(query = {}) {
  const { date, today, timezoneOffset } = query;
  const offsetMin = parseInt(timezoneOffset, 10);
  const hasOffset = !Number.isNaN(offsetMin);

  let year;
  let month;
  let day;

  if (today === 'true' || today === '1' || today === true) {
    if (hasOffset) {
      const clientNow = new Date(Date.now() + offsetMin * 60 * 1000);
      year = clientNow.getUTCFullYear();
      month = clientNow.getUTCMonth() + 1;
      day = clientNow.getUTCDate();
    } else {
      const now = new Date();
      year = now.getFullYear();
      month = now.getMonth() + 1;
      day = now.getDate();
    }
  } else if (date && /^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    [year, month, day] = String(date).split('-').map((n) => parseInt(n, 10));
  } else {
    return null;
  }

  if (hasOffset) {
    const startMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0) - offsetMin * 60 * 1000;
    return {
      start: new Date(startMs),
      end: new Date(startMs + 24 * 60 * 60 * 1000),
    };
  }

  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { start, end };
}

/** Protein for dashboard totals (macros, parsed details, summary text, or calorie estimate). */
export function proteinFromLog(log) {
  if (!log) return 0;

  const calories = Number(log.calories) || 0;

  const macroProtein = Number(log.macros?.protein);
  if (!Number.isNaN(macroProtein) && macroProtein > 0) {
    return Math.round(macroProtein);
  }

  const details = log.parsedDetails;
  if (details && typeof details === 'object') {
    const totalP = Number(details.totalProtein);
    if (!Number.isNaN(totalP) && totalP > 0) return Math.round(totalP);

    if (Array.isArray(details.items)) {
      const sum = details.items.reduce((s, it) => s + (Number(it.protein) || 0), 0);
      if (sum > 0) return Math.round(sum);
    }
  }

  const summary = String(log.organizedSummary || '');
  const summaryMatch = summary.match(/(\d+)\s*g\s*protein/i);
  if (summaryMatch) return parseInt(summaryMatch[1], 10);

  return estimateMacroGramsFromCalories(calories).protein;
}

function estimateCalories(entry, foodName) {
  if (entry.calories != null && entry.calories > 0) return Math.round(entry.calories);
  const name = (foodName || '').toLowerCase();
  const qty = Number(entry.portionAmount) || 1;
  if (/egg/.test(name)) return Math.round(70 * qty);
  if (/roti|chapati/.test(name)) return Math.round(120 * qty);
  if (/rice|biryani/.test(name)) return Math.round(200 * qty);
  if (/toast|bread/.test(name)) return Math.round(80 * qty);
  return Math.round(200 * qty);
}

function formatPortionLabel(amount, unit, foodName) {
  const n = Number(amount) || 1;
  const u = normalizePortionUnit(unit);
  if (u === 'piece' && n > 1) return `${n} pieces`;
  if (u === 'serving') return n > 1 ? `${n} servings` : '1 serving';
  return `${n} ${u}`;
}

/**
 * Build display fields from AI-parsed entry.
 */
export function buildOrganizedFoodDisplay(entry, originalText) {
  const mealType = entry.mealType && MEAL_TYPES.includes(entry.mealType)
    ? entry.mealType
    : inferMealTypeFromText(`${originalText} ${entry.rawDescription || ''}`);

  const items = Array.isArray(entry.items) && entry.items.length > 0
    ? entry.items.map((it) => ({
        name: String(it.name || it.foodName || 'Item').trim(),
        quantity: it.quantity ?? it.portionAmount ?? 1,
        unit: normalizePortionUnit(it.unit ?? it.portionUnit ?? 'piece'),
        calories: it.calories != null ? Math.round(it.calories) : null,
        protein: it.protein != null ? Math.round(it.protein) : null,
      }))
    : [{
        name: String(entry.foodName || entry.displayName || 'Meal').trim(),
        quantity: entry.portionAmount ?? 1,
        unit: normalizePortionUnit(entry.portionUnit ?? 'serving'),
        calories: entry.calories != null ? Math.round(entry.calories) : null
      }];

  items.forEach((it) => {
    if (it.calories == null || it.calories <= 0) {
      it.calories = estimateCalories({ portionAmount: it.quantity, calories: null }, it.name);
    }
    if (!it.protein || it.protein <= 0) {
      it.protein = estimateMacroGramsFromCalories(it.calories).protein;
    }
  });

  const totalCalories = items.reduce((s, it) => s + (it.calories || 0), 0);
  const totalProtein = items.reduce((s, it) => s + (it.protein || 0), 0);
  const itemLabels = items.map((it) => {
    const portion = it.quantity > 1 ? `${it.quantity} ${it.name}` : it.name;
    return it.calories ? `${portion} (${it.calories} kcal)` : portion;
  });

  const organizedSummary =
    `${itemLabels.join(', ')} · ${mealType} · ~${totalCalories} kcal · ~${totalProtein}g protein`;
  const displayTitle = `${mealType}: ${items.map((i) => i.name).join(', ')}`.slice(0, 80);
  const displaySubtitle = items
    .map((it) => `${it.quantity > 1 ? `${it.quantity}× ` : ''}${it.name}`)
    .join(' · ');

  return {
    mealType,
    items,
    totalCalories,
    organizedSummary,
    displayTitle,
    displaySubtitle,
    parsedDetails: {
      mealType,
      items,
      totalCalories,
      totalProtein,
      originalText: originalText?.slice(0, 500) || null
    }
  };
}

/**
 * Log a meal from today's plan — exact name, type, and calories (no AI).
 */
export function buildPlannedMealLogFields({ foodName, mealType, calories, protein, carbs, fat }) {
  const name = String(foodName || 'Meal').trim();
  const type = MEAL_TYPES.includes(mealType) ? mealType : inferMealTypeFromText(name);
  const kcal = Math.max(0, Math.round(Number(calories) || 0));
  const macros = fillMacrosFromCalories(
    {
      protein: protein != null ? Number(protein) : 0,
      carbs: carbs != null ? Number(carbs) : 0,
      fat: fat != null ? Number(fat) : 0,
      fibre: 0,
    },
    kcal
  );
  const organizedSummary =
    `${name} · ${type} · ${kcal} kcal · ${macros.protein}g protein`;

  const items = [{ name, quantity: 1, unit: 'serving', calories: kcal, protein: macros.protein }];
  const parsedDetails = {
    source: 'meal_plan',
    mealType: type,
    items,
    totalCalories: kcal,
    totalProtein: macros.protein,
  };

  return {
    foodName: name,
    rawDescription: null,
    organizedSummary,
    parsedDetails,
    portionSize: { amount: 1, unit: 'serving' },
    calories: kcal,
    macros,
    mealType: type,
    _display: {
      title: `${type}: ${name}`,
      subtitle: name,
      items,
    },
  };
}

export function buildFoodLogFields(entry, fallbackText) {
  const originalText = (entry.originalText || fallbackText || '').trim();
  const organized = buildOrganizedFoodDisplay(entry, originalText);
  const primary = organized.items[0];

  const foodName = organized.items.length === 1
    ? primary.name
  : organized.items.map((i) => i.name).join(', ').slice(0, 120);

  return {
    foodName,
    rawDescription: originalText || fallbackText || foodName,
    organizedSummary: organized.organizedSummary,
    parsedDetails: organized.parsedDetails,
    portionSize: {
      amount: primary.quantity || 1,
      unit: primary.unit
    },
    calories: organized.totalCalories,
    macros: fillMacrosFromCalories(
      {
        protein: entry.macros?.protein ?? organized.parsedDetails?.totalProtein ?? 0,
        carbs: entry.macros?.carbs ?? 0,
        fat: entry.macros?.fat ?? 0,
        fibre: entry.macros?.fibre ?? 0,
      },
      organized.totalCalories
    ),
    mealType: organized.mealType,
    _display: {
      title: organized.displayTitle,
      subtitle: organized.displaySubtitle,
      items: organized.items
    }
  };
}

export function formatFoodLogForHistory(log) {
  const details = log.parsedDetails || {};
  const items = Array.isArray(details.items) ? details.items : [];
  const mealType = log.source === 'meal_plan' ? log.mealType : 'Extra food';

  return {
    id: log._id,
    title: `${mealType}: ${log.foodName}`,
    subtitle: log.organizedSummary || log.rawDescription || '',
    organizedSummary: log.organizedSummary || null,
    originalText: log.rawDescription || null,
    items: items.map((it) => ({
      name: it.name,
      quantity: it.quantity,
      unit: it.unit,
      calories: it.calories,
      protein: it.protein,
    })),
    calories: log.calories,
    protein: proteinFromLog(log),
    macros: log.macros || null,
    mealType,
    timestamp: log.timestamp
  };
}

export function formatWaterLogForHistory(log) {
  const ml = log.amountMl;
  const glasses = Math.round((ml / 250) * 10) / 10;
  const organizedSummary =
    log.organizedSummary || `${glasses} glass${glasses === 1 ? '' : 'es'} · ${ml} ml`;

  return {
    id: log._id,
    title: 'Water',
    subtitle: organizedSummary,
    organizedSummary,
    originalText: log.rawText || null,
    amountMl: ml,
    timestamp: log.timestamp
  };
}
