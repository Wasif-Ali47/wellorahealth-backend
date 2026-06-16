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
function buildWelloraContext(user) {
  const dietStyle = [
    user.dietPreferences?.vegetarian ? 'Vegetarian' : null,
    user.dietPreferences?.vegan ? 'Vegan' : null,
    user.dietPreferences?.glutenFree ? 'Gluten-Free' : null,
    user.dietPreferences?.dairyFree ? 'Dairy-Free' : null,
  ].filter(Boolean).join(', ') || 'No restriction';

  const healthConditions = user.healthConditions?.join(', ') || 'None reported';
  const allergies = user.dietPreferences?.allergies?.join(', ') || 'None';
  const meds = (user.medications || [])
    .map(m => `${m.name}${m.dosage ? ' ' + m.dosage : ''}${m.timing ? ' @ ' + m.timing : ''}`)
    .join('; ') || 'None';
  const likes = (user.foodLikes || []).join(', ') || 'No specific likes';
  const dislikes = (user.foodDislikes || []).join(', ') || 'None';
  const localFoods = (user.localFoodPreferences || []).join(', ') || 'No specific local foods';

  // Map from questionnaire data structure:
  // coachProfile.mainGoal, age, targetWeight, preferredCuisine, weightLossPace, dailyRoutine, foodPreparer, weightLossProblems
  const coachProfile = user.coachProfile || {};
  const mainGoal = coachProfile.mainGoalOther || coachProfile.mainGoal || 'Not specified';
  const age = coachProfile.age || 'Not provided';
  const targetWeight = coachProfile.targetWeight || 'Not set';
  const cuisine = coachProfile.preferredCuisine || 'No preference';
  const pace = coachProfile.weightLossPace || 'Not specified';
  const routine = coachProfile.dailyRoutine || 'Not specified';
  const preparer = coachProfile.foodPreparer || 'Not specified';
  const mealsPerDay = coachProfile.mealsPerDay || 'Not specified';
  const mealManagement = coachProfile.mealManagement || 'Not specified';
  const challenges = (coachProfile.weightLossProblems || []).join(', ') || 'None reported';

  return `WELLORA USER DIET PROFILE
- Main Goal: ${mainGoal}
- Age: ${age} | Height: ${user.height?.cm || 'Not recorded'} cm | Weight: ${user.weight || 'Not recorded'} kg | Target: ${targetWeight} kg
- Health goal/context: ${user.diabetesType || 'General diet and wellness'}
- Health conditions to consider: ${healthConditions}
- Fasting blood sugar, if provided: ${user.fastingSugar != null ? user.fastingSugar + ' mg/dL' : 'Not recorded'}
- HbA1c, if provided: ${user.hba1c != null ? user.hba1c + ' %' : 'Not recorded'}
- Medications & timing: ${meds}
- Activity level: ${user.activityLevel || 'Not specified'}
- Weight loss pace: ${pace}
- Diet style: ${dietStyle}
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
- Weight loss challenges: ${challenges}`;
}

function getMealRoutineConfig(user) {
  const routine = user.coachProfile?.mealsPerDay || '';
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
  if (/irregular/i.test(routine)) return {
    instruction: 'CRITICAL: Generate EXACTLY 4 meals: Breakfast, Lunch, Dinner, Snack.',
    mealTypes: ['Breakfast', 'Lunch', 'Dinner', 'Snack'],
    count: 4,
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
  return Math.max(2, Math.min(5, Math.round(litres)));
}

const WELLORA_SYSTEM_PROMPT = `You are Wellora Health's AI nutrition coach for a diet, meal-planning, food logging, and healthy-habit app.
You help users follow realistic nutrition plans for goals such as weight loss, fat loss, muscle gain, maintenance, better energy, healthier eating, and condition-aware wellness.
You specialise in practical, culturally appropriate meals, especially South Asian / Pakistani / Indian foods (roti, rice, daal, salan, qeema, biryani, fruits), while adapting to any cuisine the user prefers.
Core principles you ALWAYS apply:
1. Personalise advice to the user's goal, calorie target, macro targets, preferences, allergies, budget, cooking time, and routine.
2. Keep meals realistic, filling, high in protein when appropriate, rich in fibre, and portion-controlled.
3. Show clear portions in everyday units: "1/2 roti", "1 roti", "1/2 cup cooked rice", "1 small fruit", "1 cup daal".
4. Respect cultural foods instead of forcing generic diet foods.
5. Avoid extreme restriction, crash diets, unsafe fasting, or shaming language.
6. Consider health conditions and medications when provided, but never replace medical advice.
7. For users with health conditions or sugar concerns, include condition-aware guidance; otherwise keep the answer focused on the user's diet goal.
Return ONLY valid JSON when a JSON schema is requested. No markdown, no extra commentary.`;

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
    const routineConfig = getMealRoutineConfig(user);
    const calorieLines = buildMealCalorieLines(routineConfig.mealTypes, dailyCalorieTarget);
    const mealSchema = buildMealJsonSchema(routineConfig.mealTypes);

    const prompt = `${context}

Generate Day ${dayNumber} of a 7-day WELLORA HEALTH diet plan.
MEAL ROUTINE: ${routineConfig.instruction}
Expected meal count: ${routineConfig.count} meals — exactly [${routineConfig.mealTypes.join(', ')}].
Calorie targets:
${calorieLines}

Macro targets per day: Carbs ${dailyMacroTargets.carbs}g, Protein ${dailyMacroTargets.protein}g, Fat ${dailyMacroTargets.fat}g.

RULES:
- Use the user's local foods, likes, budget and cooking time wherever possible.
- Each meal MUST include a clear "portionGuide" in everyday units (e.g. "1 roti + ½ cup daal + salad", "½ cup cooked basmati rice + chicken salan").
- Each meal MUST support the user's main goal and stay near the calorie/macro target.
- Keep "sugarImpact" as "Low", "Moderate", or "Watch" for UI compatibility, but keep the explanation focused on the user's diet goal unless they have sugar-related concerns.
- Avoid sugary drinks, frequent sweets, and oversized portions unless the user's goal allows it.
- Description should explain WHY this meal supports the user's goal (2-3 sentences).
- Include "waterTargetLitres" as a whole number of litres for the day, rounded to the nearest litre.

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

    const expectedCount = getMealRoutineConfig(user).count;
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

    const prompt = `${context}

Generate a 7-DAY Wellora Health diet plan.
MEAL ROUTINE: ${routineConfig.instruction}
Each day's meals array MUST have exactly ${routineConfig.count} entries — [${routineConfig.mealTypes.join(', ')}]. No other meal types.
Calorie targets per day:
${calorieLines}

Macro targets per day: Carbs ${dailyMacroTargets.carbs}g, Protein ${dailyMacroTargets.protein}g, Fat ${dailyMacroTargets.fat}g.

REQUIREMENTS:
- Use the user's local foods, likes, budget and cooking time wherever possible.
- Vary meals across the 7 days (no exact repeats).
- Each meal MUST include "portionGuide" in everyday units (e.g. "1 roti + ½ cup daal + salad", "½ cup cooked basmati rice + chicken salan").
- Each meal MUST support the user's main goal and stay near the calorie/macro target.
- Keep "sugarImpact" as "Low", "Moderate", or "Watch" for UI compatibility, but keep the explanation focused on the user's diet goal unless they have sugar-related concerns.
- Avoid sugary drinks, frequent sweets, and oversized portions unless the user's goal allows it.
- Include "waterTargetLitres" as a whole number of litres for the day, rounded to the nearest litre.

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

    const prompt = `${context}

Suggest 4 SMART MEAL SWAPS for: "${foodName}".
Each swap must be culturally appropriate (use roti, rice, daal, salan, qeema, biryani, fruits etc. when relevant), affordable for the user's budget and quick to prepare.

Return JSON only:
{
  "swaps": [
    {
      "original": "${foodName}",
      "swap": "name of the swap",
      "portion": "everyday-unit portion, e.g. '1 roti + ½ cup daal'",
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
