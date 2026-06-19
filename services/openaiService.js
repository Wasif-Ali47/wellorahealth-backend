import OpenAI from 'openai';

// Lazily construct the OpenAI client so we read process.env AFTER dotenv has
// finished loading, regardless of which module is evaluated first.
let _openai = null;
let _warnedMissing = false;

function getOpenAI() {
  if (_openai) return _openai;
  const key = process.env.OPENAI_API_KEY;
  if (key && key.trim().length > 0) {
    _openai = new OpenAI({ apiKey: key });
    console.log('🤖 OpenAI client initialised (key …' + key.slice(-6) + ')');
    return _openai;
  }
  if (!_warnedMissing) {
    console.warn('⚠️  OPENAI_API_KEY not set. AI features will use fallback responses.');
    _warnedMissing = true;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helper: Build a compact "user health & diet profile" from questionnaire data
// Data sources:
// - user.coachProfile.* (from questionnaire steps 0-10)
// - user.health* fields (diabetesType, fastingSugar, hba1c, healthConditions, medications)
// - user.dietPreferences.* (dietary restrictions mapped from food restrictions)
// - user.foodLikes/Dislikes/localFoodPreferences (liked foods questionnaire)
// - user.budget, cookingTime (lifestyle preferences)
// - user.activityLevel, height, weight (physical info)
// ---------------------------------------------------------------------------
function listText(value, fallback = 'None') {
  if (Array.isArray(value)) {
    const cleaned = value.map((item) => String(item || '').trim()).filter(Boolean);
    return cleaned.length ? cleaned.join(', ') : fallback;
  }
  const text = String(value || '').trim();
  return text || fallback;
}

function mergedList(...values) {
  const items = [];
  values.forEach((value) => {
    if (Array.isArray(value)) {
      value.forEach((item) => {
        const text = String(item || '').trim();
        if (text) items.push(text);
      });
    } else {
      const text = String(value || '').trim();
      if (text) items.push(text);
    }
  });
  return Array.from(new Set(items));
}

function labelFromKey(value) {
  return String(value || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function buildMealManagementInstruction(user) {
  const style = String(user?.coachProfile?.mealManagement || '').toLowerCase();
  if (style === 'mixed') {
    return 'Mixed routine: combine meal styles in the plan. When meal count allows, include at least one home-cooked/prepped meal and at least one restaurant, cafeteria, or ordered-food style meal each day. Keep ordered/outside meals realistic, portion-controlled, and aligned with the user profile.';
  }
  if (style === 'eat_outside') {
    return 'Mostly outside meals: make meals restaurant/cafeteria friendly with practical ordering guidance, portion control, and healthier swaps.';
  }
  if (style === 'order_food') {
    return 'Order-food routine: suggest delivery-friendly meals that can be ordered easily, with clear portion control and healthier options.';
  }
  if (style === 'meal_prep') {
    return 'Meal prep routine: favor meals that can be cooked in batches and stored safely for a few days.';
  }
  if (style === 'home_cooked') {
    return 'Home-cooked routine: favor simple home meals with familiar ingredients and practical cooking steps.';
  }
  return 'Meal management not specified: use realistic meals that are easy to follow.';
}

function buildCuisineInstruction(user) {
  const cuisine = String(user?.coachProfile?.preferredCuisine || '').trim();
  if (!cuisine || /no preference|mixed|any/i.test(cuisine)) {
    return 'Cuisine rule: no single cuisine is required; still use the user\'s local foods, likes, dislikes, and restrictions.';
  }
  const nonSouthAsianGuard = /italian|continental|chinese|middle\s*eastern|arab|mediterranean/i.test(cuisine)
    ? ' Do NOT use South Asian/Indian/Pakistani dish names or staples such as roti, chapati, paratha, daal/dal, besan cheela/chilla, sabzi, salan, qeema, tikka, chana, raita, biryani, pulao, atta, chutney, pakora, paneer, dosa, idli, or curry unless the selected cuisine itself is South Asian.'
    : '';
  return `Cuisine rule: the plan MUST be recognisably ${cuisine}. Do not insert meals from another cuisine unless the user explicitly listed that food as a like/local preference. Use ${cuisine}-appropriate ingredients, dish names, portions, and cooking styles while keeping the plan goal-friendly.${nonSouthAsianGuard}`;
}

function buildWelloraContext(user) {
  const dietStyle = [
    user.dietPreferences?.vegetarian ? 'Vegetarian' : null,
    user.dietPreferences?.vegan ? 'Vegan' : null,
    user.dietPreferences?.glutenFree ? 'Gluten-Free' : null,
    user.dietPreferences?.dairyFree ? 'Dairy-Free' : null,
  ].filter(Boolean).join(', ') || 'No restriction';

  const coachProfile = user.coachProfile || {};
  const healthConditions = listText(
    mergedList(user.healthConditions, coachProfile.healthConditions, coachProfile.healthConditionsOther),
    'None reported'
  );
  const allergies = listText(
    mergedList(user.dietPreferences?.allergies, coachProfile.foodAllergies, coachProfile.foodAllergiesOther),
    'None'
  );
  const meds = (user.medications || [])
    .map(m => `${m.name}${m.dosage ? ' ' + m.dosage : ''}${m.timing ? ' @ ' + m.timing : ''}`)
    .join('; ') || 'None';
  const likes = listText(mergedList(user.foodLikes, coachProfile.likedFoods, coachProfile.likedFoodsOther), 'No specific likes');
  const dislikes = listText(mergedList(user.foodDislikes, coachProfile.foodsToAvoid, coachProfile.foodsToAvoidOther), 'None');
  const restrictions = listText(mergedList(coachProfile.foodRestrictions, coachProfile.foodRestrictionsOther), 'None');
  const localFoods = listText(mergedList(user.localFoodPreferences, coachProfile.localFoodPreferences), 'No specific local foods');

  // Map from questionnaire data structure:
  // coachProfile.mainGoal, age, targetWeight, preferredCuisine, weightLossPace, dailyRoutine, foodPreparer, weightLossProblems
  const mainGoal = coachProfile.mainGoalOther || coachProfile.mainGoal || 'Not specified';
  const age = coachProfile.age || 'Not provided';
  const gender = labelFromKey(coachProfile.gender || user.gender || user.biologicalSex || 'Not provided');
  const targetWeight = coachProfile.targetWeight || 'Not set';
  const cuisine = coachProfile.preferredCuisine || 'No preference';
  const pace = coachProfile.weightLossPace || 'Not specified';
  const routine = coachProfile.dailyRoutine || 'Not specified';
  const preparer = coachProfile.foodPreparer || 'Not specified';
  const mealsPerDay = coachProfile.mealsPerDay || 'Not specified';
  const mealManagement = coachProfile.mealManagement || 'Not specified';
  const challenges = listText(mergedList(coachProfile.weightLossProblems, coachProfile.weightLossProblemsOther), 'None reported');
  const mealManagementInstruction = buildMealManagementInstruction(user);

  return `WELLORA HEALTH USER DIET PROFILE
- Main Goal: ${mainGoal}
- Age: ${age} | Gender: ${gender} | Height: ${user.height?.cm || 'Not recorded'} cm | Weight: ${user.weight || 'Not recorded'} kg | Target: ${targetWeight} kg
- Health goal/context: ${user.diabetesType || 'General diet and wellness'}
- Health conditions to consider: ${healthConditions}
- Fasting blood sugar, if provided: ${user.fastingSugar != null ? user.fastingSugar + ' mg/dL' : 'Not recorded'}
- HbA1c, if provided: ${user.hba1c != null ? user.hba1c + ' %' : 'Not recorded'}
- Medications & timing: ${meds}
- Activity level: ${user.activityLevel || 'Not specified'}
- Weight loss pace: ${pace}
- Diet style: ${dietStyle}
- Food restrictions: ${restrictions}
- Allergies: ${allergies}
- Preferred cuisine: ${cuisine}
- Likes: ${likes}
- Dislikes: ${dislikes}
- Local food preferences: ${localFoods}
- Budget: ${user.budget || 'Medium'}
- Cooking time available: ${user.cookingTime || 'Moderate (20-40 min)'}
- Daily routine: ${routine}
- Food preparer: ${preparer}
- Preferred meal routine: ${mealsPerDay}
- Meal management style: ${mealManagement}
- Meal management guidance: ${mealManagementInstruction}
- Weight loss challenges: ${challenges}`;
}

function irregularMealTypesForDay(dayNumber) {
  const patterns = [
    ['Breakfast', 'Lunch', 'Dinner'],
    ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    ['Breakfast', 'Dinner'],
    ['Breakfast', 'Snack', 'Dinner'],
    ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    ['Breakfast', 'Dinner'],
    ['Breakfast', 'Lunch', 'Dinner'],
  ];
  return patterns[Math.max(0, (Number(dayNumber) || 1) - 1) % patterns.length];
}

function getMealRoutineConfig(user, dayNumber = 1) {
  const routine = user.coachProfile?.mealsPerDay || '';
  if (/irregular/i.test(routine)) {
    const mealTypes = irregularMealTypesForDay(dayNumber);
    return {
      instruction: `IRREGULAR ROUTINE: Generate exactly ${mealTypes.length} meals for Day ${dayNumber}. The meals array MUST contain exactly these entries in this order: ${mealTypes.join(', ')}. Across a 7-day plan, vary meal count between 2, 3, and 4 meals instead of using the same count every day.`,
      mealTypes,
      count: mealTypes.length,
    };
  }
  if (/2 meals \+ 1 snack/i.test(routine)) return {
    instruction: 'CRITICAL: Generate EXACTLY 3 meals. The meals array MUST contain exactly these 3 entries in this order: Breakfast, Snack, Dinner. DO NOT include Lunch.',
    mealTypes: ['Breakfast', 'Snack', 'Dinner'],
    count: 3,
  };
  if (/2 meals/i.test(routine)) return {
    instruction: 'CRITICAL: Generate EXACTLY 2 meals. The meals array MUST contain exactly these 2 entries in this order: Breakfast, Dinner. DO NOT include Lunch or Snack.',
    mealTypes: ['Breakfast', 'Dinner'],
    count: 2,
  };
  if (/3 meals \+ 1 snack/i.test(routine)) return {
    instruction: 'CRITICAL: Generate EXACTLY 4 meals. The meals array MUST contain exactly these 4 entries in this order: Breakfast, Lunch, Dinner, Snack.',
    mealTypes: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    count: 4,
  };
  if (/3 meals/i.test(routine)) return {
    instruction: 'CRITICAL: Generate EXACTLY 3 meals. The meals array MUST contain exactly these 3 entries in this order: Breakfast, Lunch, Dinner. DO NOT include Snack.',
    mealTypes: ['Breakfast', 'Lunch', 'Dinner'],
    count: 3,
  };
  return {
    instruction: 'CRITICAL: Generate EXACTLY 4 meals: Breakfast, Lunch, Dinner, Snack.',
    mealTypes: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    count: 4,
  };
}

function buildMealCalorieLines(mealTypes, dailyCalorieTarget) {
  const splits = {
    Breakfast: 0.25,
    Lunch: 0.35,
    Dinner: mealTypes.includes('Lunch') ? 0.30 : (mealTypes.includes('Snack') ? 0.55 : 0.75),
    Snack: 0.10,
  };
  // For 2 meals: split 40/60 between Breakfast and Dinner
  if (mealTypes.length === 2) {
    return [
      ` - Breakfast ~${Math.round(dailyCalorieTarget * 0.40)}kcal`,
      ` - Dinner ~${Math.round(dailyCalorieTarget * 0.60)}kcal`,
    ].join('\n');
  }
  return mealTypes.map(t => ` - ${t} ~${Math.round(dailyCalorieTarget * (splits[t] || 0.25))}kcal`).join('\n');
}

function buildMealJsonSchema(mealTypes) {
  return mealTypes.map(t =>
    `  {"mealType":"${t}","name":"...","description":"Why this meal supports the user's diet goal (2-3 sentences)","portionGuide":"...","sugarImpact":"Low","calories":0,"macros":{"carbs":0,"protein":0,"fat":0},"tags":["Balanced","Goal-friendly"],"ingredients":["..."]}`
  ).join(',\n');
}

function mealRoutineInstruction(user) {
  return getMealRoutineConfig(user).instruction;
}

function normalizeWaterTargetLitres(value, fallback = 3) {
  const litres = Number(value);
  if (!Number.isFinite(litres) || litres <= 0) return fallback;
  const clamped = Math.max(2, Math.min(5, litres));
  return Math.round((clamped * 1000) / 250) * 0.25;
}

const WELLORA_SYSTEM_PROMPT = `You are Wellora Health's AI nutrition assistant for a diet planning, meal tracking, grocery, and healthy habit app.
Create practical, realistic, culturally suitable, and goal-focused nutrition guidance from the user's profile, preferences, restrictions, and targets.
You are not a doctor, dietitian, emergency service, or medical provider. Give general wellness and nutrition guidance only.

Core rules:
1. Personalize every answer to the user's goal, age, gender, height, weight, activity, meal routine, meal management style, cuisine, food likes/dislikes, allergies, restrictions, health context, budget, and cooking time.
2. Safety overrides preferences. Never include foods that conflict with allergies, intolerances, health conditions, food restrictions, halal/vegetarian/vegan rules, or disliked foods.
3. Keep foods realistic, familiar, affordable, and easy to follow. Use everyday portions like "1 roti", "1/2 cup daal", "1/2 cup cooked rice", "1 palm-sized chicken piece", "1 small fruit", "1 cup yogurt", or "1 tsp oil".
4. Respect preferred cuisine, including South Asian, Pakistani, Indian, Middle Eastern, Chinese, Italian, Continental, or mixed meals when selected.
5. Support the user's goal: weight loss uses filling portion-controlled meals; gain weight uses nutrient-dense surplus meals; muscle gain prioritizes protein; maintenance and healthier eating use balanced meals.
6. Avoid crash diets, extreme fasting, detoxes, miracle claims, guilt, punishment, and unsafe very-low-calorie advice.
7. Be condition-aware but not medical. Recommend qualified professional help for medical diets, medication changes, pregnancy, diabetes management, hypertension, cholesterol, thyroid issues, eating disorders, or serious symptoms.
8. Be specific. Do not say "eat healthy food" without naming foods and portions.
9. CRITICAL: Use maximum variety in meals. Rotate proteins (chicken, fish, lentils, beans, eggs, paneer, mutton, tofu), cooking methods (grilled, stir-fried, steamed, curried, baked, boiled), vegetables, and grains. Minimize repetition — avoid using the same meal more than once per week, and avoid overusing salads, oats, boiled eggs, or grilled chicken unless it matches the user's cuisine and preferences.
10. STRICT DAILY TARGETS: When generating meal plans, EVERY DAY must hit the EXACT same daily calorie and macro targets provided. No day can have different totals. Each day must be consistent in total calories, protein, carbs, and fat targets.
11. When JSON is requested, return one valid JSON object only: double-quoted keys/strings, no markdown, no comments, no trailing commas, no NaN/undefined, no extra text.`;

// ---------------------------------------------------------------------------
// 1) Daily / weekly Wellora meal plan
// ---------------------------------------------------------------------------

/**
 * Generate a single day's meal plan optimised for the user's Wellora goals.
 */
export async function generateMealPlanDayWithAI(user, dailyCalorieTarget, dailyMacroTargets, dayNumber) {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 15000;

  try {
    const context = buildWelloraContext(user);
    const routineConfig = getMealRoutineConfig(user, dayNumber);
    const calorieLines = buildMealCalorieLines(routineConfig.mealTypes, dailyCalorieTarget);
    const mealSchema = buildMealJsonSchema(routineConfig.mealTypes);
    const mealManagementInstruction = buildMealManagementInstruction(user);
    const cuisineInstruction = buildCuisineInstruction(user);

    const prompt = `${context}

Generate Day ${dayNumber} of a 7-day WELLORA HEALTH diet plan.
MEAL ROUTINE: ${routineConfig.instruction}
Expected meal count: ${routineConfig.count} meals — exactly [${routineConfig.mealTypes.join(', ')}].
Calorie targets:
${calorieLines}

Macro targets per day: Carbs ${dailyMacroTargets.carbs}g, Protein ${dailyMacroTargets.protein}g, Fat ${dailyMacroTargets.fat}g.

RULES:
- Use the user's likes, budget and cooking time wherever possible, but never override the selected cuisine.
- ${cuisineInstruction}
- Meal management rule: ${mealManagementInstruction}
- If the user selected mixed routine, make the day feel genuinely mixed: include both a home/prepped option and an outside/ordered/cafeteria-friendly option when ${routineConfig.count} meals allows it.
- Completely exclude allergies, intolerances, restricted foods, and disliked foods from every meal and ingredient.
- Use only these meal types, in this order: [${routineConfig.mealTypes.join(', ')}].
- Maximize variety: use diverse proteins (chicken, fish, lentils, beans, eggs, paneer, etc.), varied vegetables, different cooking methods (grilled, stir-fried, steamed, curried, baked), and varied grains/bases (rice, roti, quinoa, oats, bread).
- Each meal MUST include a clear "portionGuide" in everyday units that match the selected cuisine.
- Each meal MUST support the user's main goal and stay near the calorie/macro target.
- Keep "sugarImpact" as "Low", "Moderate", or "Watch" for UI compatibility, but keep the explanation focused on the user's diet goal unless they have sugar-related concerns.
- Avoid sugary drinks, frequent sweets, and oversized portions unless the user's goal allows it.
- Description should explain WHY this meal supports the user's goal in 1-2 short sentences.
- Include "waterTargetLitres" as a personalized litre target based on the user's weight, activity level, climate/routine context, and health profile. Use 0.25L steps, for example 2.5, 2.75, 3.25, or 3.5.
- Before returning, internally verify exact meal count, valid JSON, realistic calories/protein, clear portions, good protein/veggie/method variety, and no restricted foods.

Return JSON only — the meals array MUST have exactly ${routineConfig.count} entries:
{"waterTargetLitres":3,"meals":[
${mealSchema}
]}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: WELLORA_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 2000
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OpenAI request timeout')), timeout)
    );

    const response = await Promise.race([responsePromise, timeoutPromise]);
    const content = response.choices[0].message.content.trim();

    let mealData;
    try {
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
      const jsonString = jsonMatch ? jsonMatch[1] : content;
      mealData = JSON.parse(jsonString);
    } catch (parseError) {
      console.error(`Failed to parse OpenAI response for day ${dayNumber}:`, parseError);
      throw new Error('Failed to parse meal plan response');
    }

    const meals = (mealData.meals || mealData.days?.[0]?.meals || []).map(meal => ({
      mealType: meal.mealType || '',
      name: meal.name || '',
      description: meal.description || '',
      portionGuide: meal.portionGuide || '',
      sugarImpact: meal.sugarImpact || 'Low',
      calories: typeof meal.calories === 'number' ? meal.calories : 0,
      macros: {
        carbs: meal.macros?.carbs || 0,
        protein: meal.macros?.protein || 0,
        fat: meal.macros?.fat || 0
      },
      tags: meal.tags || [],
      ingredients: meal.ingredients || []
    }));

    const expectedCount = getMealRoutineConfig(user, dayNumber).count;
    if (meals.length !== expectedCount || !meals.every(m => m.name && m.mealType && m.calories > 0)) {
      throw new Error(`Invalid meal structure: expected ${expectedCount} meals, got ${meals.length}`);
    }

    return {
      meals,
      waterTargetLitres: normalizeWaterTargetLitres(mealData.waterTargetLitres),
      usage: response.usage || null
    };
  } catch (error) {
    console.error(`OpenAI meal plan generation error for day ${dayNumber}:`, error.message);
    throw error;
  }
}

/**
 * Generate the full 7-day Wellora meal plan in one OpenAI call.
 */
export async function generateMealPlanWithAI(user, dailyCalorieTarget, dailyMacroTargets) {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 35000;

  try {
    const context = buildWelloraContext(user);
    const routineConfig = getMealRoutineConfig(user);
    const calorieLines = buildMealCalorieLines(routineConfig.mealTypes, dailyCalorieTarget);
    const mealSchema = buildMealJsonSchema(routineConfig.mealTypes);
    const mealManagementInstruction = buildMealManagementInstruction(user);
    const cuisineInstruction = buildCuisineInstruction(user);

    const prompt = `${context}

Generate a 7-DAY Wellora Health diet plan.
MEAL ROUTINE: ${routineConfig.instruction}
Each day's meals array MUST have exactly ${routineConfig.count} entries — [${routineConfig.mealTypes.join(', ')}]. No other meal types.
Calorie targets per day:
${calorieLines}

Macro targets per day: Carbs ${dailyMacroTargets.carbs}g, Protein ${dailyMacroTargets.protein}g, Fat ${dailyMacroTargets.fat}g.

STRICT REQUIREMENTS:
- EVERY SINGLE DAY must have the SAME total daily calories and the SAME daily macro targets (${dailyMacroTargets.carbs}g carbs, ${dailyMacroTargets.protein}g protein, ${dailyMacroTargets.fat}g fat). No exceptions. Verify total calories and macros for each day before returning.
- Use the user's likes, budget and cooking time wherever possible, but never override the selected cuisine.
- ${cuisineInstruction}
- Meal management rule: ${mealManagementInstruction}
- If the user selected mixed routine, vary each day across home-cooked/prepped meals and outside/ordered/cafeteria-friendly meals. When meal count allows, include at least one of each style per day.
- Completely exclude allergies, intolerances, restricted foods, and disliked foods from every meal and ingredient.
- Use only these meal types, in this order: [${routineConfig.mealTypes.join(', ')}].
- CRITICAL VARIETY - NO REPETITION: Across the 7 days, NO meal can have the exact same name on multiple days. Each day must have completely different meals with different names. Use diverse proteins (chicken, fish, lentils, beans, eggs, paneer, mutton, etc.), varied vegetables, different cooking methods (grilled, stir-fried, steamed, curried, baked, boiled), and varied grains/bases (rice, roti, quinoa, oats, bread). Maximum 1 similar concept (e.g., "Chicken Curry" and "Chicken Fry") but with genuinely different preparation, ingredients, or sauce across the 7 days.
- Each meal MUST include "portionGuide" in everyday units that match the selected cuisine.
- Each meal MUST support the user's main goal and stay near the calorie/macro target.
- Keep "sugarImpact" as "Low", "Moderate", or "Watch" for UI compatibility, but keep the explanation focused on the user's diet goal unless they have sugar-related concerns.
- Avoid sugary drinks, frequent sweets, and oversized portions unless the user's goal allows it.
- Include "waterTargetLitres" as a personalized litre target based on the user's weight, activity level, climate/routine context, and health profile. Use 0.25L steps, for example 2.5, 2.75, 3.25, or 3.5.
- Before returning, internally verify: 7 days, exact meal count per day, valid JSON, ALL DAYS have identical total calories and macros, realistic calories/protein, clear portions, strong variety across proteins/vegetables/cooking methods, and no restricted foods.

Return JSON only — each day's meals array MUST have exactly ${routineConfig.count} entries:
{"waterTargetLitres":3,"days":[{"meals":[
${mealSchema}
]}, ... 7 days total ...]}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: WELLORA_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 6000
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OpenAI request timeout')), timeout)
    );

    const response = await Promise.race([responsePromise, timeoutPromise]);
    const content = response.choices[0].message.content.trim();

    let mealPlanData;
    try {
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
      const jsonString = jsonMatch ? jsonMatch[1] : content;
      mealPlanData = JSON.parse(jsonString);
    } catch (parseError) {
      console.error('Failed to parse OpenAI response:', parseError);
      throw new Error('Failed to parse meal plan response');
    }

    const days = (mealPlanData.days || []).map(day => ({
      meals: (day.meals || []).map(meal => ({
        mealType: meal.mealType || '',
        name: meal.name || '',
        description: meal.description || '',
        portionGuide: meal.portionGuide || '',
        sugarImpact: meal.sugarImpact || 'Low',
        calories: typeof meal.calories === 'number' ? meal.calories : 0,
        macros: {
          carbs: meal.macros?.carbs || 0,
          protein: meal.macros?.protein || 0,
          fat: meal.macros?.fat || 0
        },
        tags: meal.tags || [],
        ingredients: meal.ingredients || []
      }))
    }));

    return {
      days,
      waterTargetLitres: normalizeWaterTargetLitres(mealPlanData.waterTargetLitres),
      usage: response.usage || null
    };
  } catch (error) {
    console.error('OpenAI meal plan generation error:', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 2) "Can I eat this?" food checker
// ---------------------------------------------------------------------------

/**
 * Decide whether a specific food/dish fits the user's diet goal.
 */
export async function checkFoodSafetyWithAI(user, foodName, portion = '') {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 12000;

  try {
    const context = buildWelloraContext(user);

    const prompt = `${context}

The user is asking: "Can I eat ${foodName}${portion ? ' (' + portion + ')' : ''}?"

Decide based on the user's main goal, calorie/macro targets, health conditions, medications, allergies, preferences and diet style.

Return JSON only:
{
  "verdict": "Fits your plan" | "Have with care" | "Limit/avoid",
  "reason": "Short 1-2 sentence reason in plain language.",
  "safePortion": "Specific goal-friendly portion the user may eat, e.g. '1 roti with lean protein and salad' or '1 small serving after a balanced meal'",
  "sugarImpact": "Low" | "Moderate" | "Watch",
  "betterAlternatives": ["alt 1", "alt 2", "alt 3"],
  "tips": ["practical tip 1", "tip 2"]
}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: WELLORA_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0.5,
      max_tokens: 600
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OpenAI request timeout')), timeout)
    );

    const response = await Promise.race([responsePromise, timeoutPromise]);
    const content = response.choices[0].message.content.trim();

    try {
      const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
      const jsonString = jsonMatch ? jsonMatch[1] : content;
      const parsed = JSON.parse(jsonString);
      return {
        verdict: parsed.verdict || 'Have with care',
        reason: parsed.reason || '',
        safePortion: parsed.safePortion || '',
        sugarImpact: parsed.sugarImpact || 'Moderate',
        betterAlternatives: Array.isArray(parsed.betterAlternatives) ? parsed.betterAlternatives : [],
        tips: Array.isArray(parsed.tips) ? parsed.tips : [],
        usage: response.usage || null,
      };
    } catch (parseError) {
      console.error('checkFoodSafetyWithAI parse error:', parseError);
      throw new Error('Failed to parse food check response');
    }
  } catch (error) {
    console.error('checkFoodSafetyWithAI error:', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 3) Smart meal swaps
// ---------------------------------------------------------------------------

/**
 * Suggest goal-friendly smart meal swaps for a food / craving.
 */
export async function generateFoodSwapsWithAI(user, foodName) {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 12000;

  try {
    const context = buildWelloraContext(user);
    const cuisineInstruction = buildCuisineInstruction(user);

    const prompt = `${context}

Suggest 4 SMART MEAL SWAPS for: "${foodName}".
${cuisineInstruction}
Each swap must match the user's preferred cuisine, full profile, allergies, restrictions, meal routine, budget, and cooking time. Do not use foods from another cuisine just because they are common locally.
The swaps must feel like realistic alternatives with similar meal purpose and similar nutritional benefits, not random low-calorie snacks.
Do not include allergies, restricted foods, or disliked foods. Keep portions specific and goal-friendly.

Return JSON only:
{
  "swaps": [
    {
      "original": "${foodName}",
      "swap": "name of the swap",
      "portion": "everyday-unit portion that matches the selected cuisine",
      "sugarImpact": "Low" | "Moderate",
      "why": "1 sentence why this better supports the user's goal"
    }
  ]
}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: WELLORA_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 700
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OpenAI request timeout')), timeout)
    );

    const response = await Promise.race([responsePromise, timeoutPromise]);
    const content = response.choices[0].message.content.trim();

    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
    const jsonString = jsonMatch ? jsonMatch[1] : content;
    const parsed = JSON.parse(jsonString);

    return {
      swaps: Array.isArray(parsed.swaps) ? parsed.swaps : [],
      usage: response.usage || null,
    };
  } catch (error) {
    console.error('generateFoodSwapsWithAI error:', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 4) Weekly grocery list
// ---------------------------------------------------------------------------

/**
 * Build a weekly grocery list based on the user's profile (and an
 * optional list of meal names already planned).
 */
export async function generateGroceryListWithAI(user, plannedMeals = []) {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 15000;

  try {
    const context = buildWelloraContext(user);
    const mealsHint = plannedMeals.length
      ? `Planned meals this week: ${plannedMeals.slice(0, 28).join('; ')}.`
      : 'No specific meals planned yet - assume a typical balanced Wellora Health week.';

    const prompt = `${context}

Build a WEEKLY GROCERY LIST that is goal-friendly, culturally appropriate (South Asian / Pakistani / Indian friendly) and matches the user's budget & cooking time.
${mealsHint}

STRICT RULES:
1. If planned meals are provided, derive every item STRICTLY from the ingredients those specific meals and portion guides require. There is no fixed list of categories to fill in — do not include a category or item that isn't needed for the listed meals.
2. Do NOT add extra healthy staples, snacks, fruits, pantry items, or "just in case" ingredients unless a listed meal actually calls for them.
3. Combine duplicate ingredients across the whole week into ONE line with a single total quantity (e.g. if 3 meals use onion, output one "Onion" line sized for all 3, not 3 separate onion lines).
4. Estimate conservative, realistic quantities for ONE person for the week — do not round up generously or pad quantities.
5. Use everyday units (kg, g, packs, pieces, dozen, cups).
6. Only include the "avoid" list if there are real allergy/restriction conflicts to flag; otherwise return an empty array.
7. Respect the user's allergies, restrictions, dislikes, cuisine, budget, and meal management style.
8. Keep the list practical for Wellora Health meal prep and everyday cooking; do not add generic diet items that are not connected to the plan.

Return JSON only, with only as many categories as are actually needed (omit any category with no items):
{
  "categories": [
    {
      "name": "Vegetables",
      "items": [
        { "name": "Spinach", "quantity": "500 g", "note": "for daal palak" }
      ]
    }
  ],
  "avoid": []
}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: WELLORA_SYSTEM_PROMPT },
        { role: 'user', content: prompt }
      ],
      temperature: 0.6,
      max_tokens: 1500
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OpenAI request timeout')), timeout)
    );

    const response = await Promise.race([responsePromise, timeoutPromise]);
    const content = response.choices[0].message.content.trim();

    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/```\n([\s\S]*?)\n```/);
    const jsonString = jsonMatch ? jsonMatch[1] : content;
    const parsed = JSON.parse(jsonString);

    return {
      categories: Array.isArray(parsed.categories) ? parsed.categories : [],
      avoid: Array.isArray(parsed.avoid) ? parsed.avoid : [],
      usage: response.usage || null,
    };
  } catch (error) {
    console.error('generateGroceryListWithAI error:', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 5) Wellora AI chat coach
// ---------------------------------------------------------------------------

export async function generateChatResponse(userMessage, user, chatHistory = []) {
  const openai = getOpenAI();
  if (!openai) {
    console.warn('OpenAI not initialized, returning null to use fallback response');
    return null;
  }

  try {
    const context = buildWelloraContext(user);

    const systemPrompt = `${WELLORA_SYSTEM_PROMPT}

You are chatting with the user inside the app. Be empathetic, short (2-3 short paragraphs max) and practical.
When asked "can I eat X" always give: verdict (Fits your plan / Have with care / Limit or avoid), a goal-friendly portion, and a quick reason tied to calories, protein, fibre, and the user's goal.
When the user feels discouraged after overeating, missing a meal, weight changes, or low motivation, calm them first, then give 1-2 concrete next steps.
Use the user's plan context, routine, restrictions, and preferences. Give specific food and portion suggestions instead of generic advice.
Never replace medical advice. Mention consulting a doctor or dietitian for medical conditions, medication changes, pregnancy, eating-disorder concerns, or very aggressive weight goals.

${context}`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...chatHistory.slice(-10).map(msg => ({
        role: msg.isUser ? 'user' : 'assistant',
        content: msg.message
      })),
      { role: 'user', content: userMessage }
    ];

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.7,
      max_tokens: 500
    });

    const aiResponse = response.choices[0].message.content.trim();

    const lowerMessage = userMessage.toLowerCase();
    let responseType = 'general';
    let confidence = 0.85;

    if (lowerMessage.includes('sugar') || lowerMessage.includes('glucose') ||
        lowerMessage.includes('hba1c') || lowerMessage.includes('diabetes')) {
      responseType = 'health_context';
      confidence = 0.92;
    } else if (lowerMessage.includes('eat') || lowerMessage.includes('can i have') ||
               lowerMessage.includes('food') || lowerMessage.includes('meal') ||
               lowerMessage.includes('roti') || lowerMessage.includes('rice') ||
               lowerMessage.includes('biryani') || lowerMessage.includes('fruit')) {
      responseType = 'meal_plan';
      confidence = 0.92;
    } else if (lowerMessage.includes('medicine') || lowerMessage.includes('medication') ||
               lowerMessage.includes('insulin') || lowerMessage.includes('metformin') ||
               lowerMessage.includes('pill')) {
      responseType = 'medication';
      confidence = 0.88;
    } else if (lowerMessage.includes('symptom') || lowerMessage.includes('dizzy') ||
               lowerMessage.includes('tired') || lowerMessage.includes('thirsty')) {
      responseType = 'symptoms';
      confidence = 0.88;
    }

    return {
      text: aiResponse,
      confidence,
      type: responseType,
      usage: response.usage || null,
    };
  } catch (error) {
    console.error('OpenAI chat error:', error);
    throw error;
  }
}
// df
