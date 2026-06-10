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
function buildDiabeticContext(user) {
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

  return `USER HEALTH & DIET PROFILE
- Main Goal: ${mainGoal}
- Age: ${age} | Height: ${user.height?.cm || 'Not recorded'} cm | Weight: ${user.weight || 'Not recorded'} kg | Target: ${targetWeight} kg
- Diabetes status: ${user.diabetesType || 'Not specified'}
- Other health conditions: ${healthConditions}
- Latest fasting blood sugar: ${user.fastingSugar != null ? user.fastingSugar + ' mg/dL' : 'Not recorded'}
- Latest HbA1c: ${user.hba1c != null ? user.hba1c + ' %' : 'Not recorded'}
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

function mealRoutineInstruction(user) {
  const routine = user.coachProfile?.mealsPerDay || '';
  if (/2 meals \+ 1 snack/i.test(routine)) return 'Provide exactly 2 main meals and 1 snack. Do not add extra meals.';
  if (/2 meals/i.test(routine)) return 'Provide exactly 2 main meals. Do not include snacks unless medically necessary.';
  if (/3 meals \+ 1 snack/i.test(routine)) return 'Provide exactly 3 main meals and 1 snack.';
  if (/3 meals/i.test(routine)) return 'Provide exactly 3 main meals. Do not include snacks.';
  if (/irregular/i.test(routine)) return 'Provide flexible meal timing with 3 practical meal options and 1 optional snack.';
  return 'Provide 3 main meals and 1 snack.';
}

function normalizeWaterTargetLitres(value, fallback = 3) {
  const litres = Number(value);
  if (!Number.isFinite(litres) || litres <= 0) return fallback;
  return Math.max(2, Math.min(5, Math.round(litres)));
}

const DIABETIC_SYSTEM_PROMPT = `You are a certified nutrition coach for the "AI Diet Coach" app.
You specialise in blood sugar control, low glycaemic index (low-GI) eating, and culturally appropriate health-conscious meals — especially South Asian / Pakistani / Indian foods (roti, rice, daal, salan, qeema, biryani, fruits).
Core principles you ALWAYS apply:
1. Prioritise low-GI, high-fibre carbs. Limit refined sugar and white-flour foods.
2. Show clear PORTIONS in everyday units: "½ roti", "1 roti", "½ cup cooked rice", "1 small fruit", "1 cup daal".
3. Pair carbs with protein, fibre, or healthy fat to slow glucose spikes.
4. Respect cultural foods, the user's budget and cooking time.
5. Flag anything that may spike blood sugar (white sugar, sugary drinks, mithai, white rice in large portions, fruit juice, etc.).
6. Never replace medical advice — remind the user to consult their doctor for medication changes.
Return ONLY valid JSON when a JSON schema is requested. No markdown, no extra commentary.`;

// ---------------------------------------------------------------------------
// 1) Daily / weekly diabetic meal plan
// ---------------------------------------------------------------------------

/**
 * Generate a single day's meal plan optimised for diabetic users.
 */
export async function generateMealPlanDayWithAI(user, dailyCalorieTarget, dailyMacroTargets, dayNumber) {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 15000;

  try {
    const context = buildDiabeticContext(user);
    const mealRoutine = mealRoutineInstruction(user);

    const prompt = `${context}

Generate Day ${dayNumber} of a 7-day DIABETIC meal plan.
Meal routine requirement: ${mealRoutine}
 - Breakfast ~${Math.round(dailyCalorieTarget * 0.25)}kcal
 - Lunch ~${Math.round(dailyCalorieTarget * 0.35)}kcal
 - Dinner ~${Math.round(dailyCalorieTarget * 0.30)}kcal
 - Snack ~${Math.round(dailyCalorieTarget * 0.10)}kcal

Macro targets per day: Carbs ${dailyMacroTargets.carbs}g (prefer complex carbs / low-GI), Protein ${dailyMacroTargets.protein}g, Fat ${dailyMacroTargets.fat}g.

RULES:
- Use the user's local foods, likes, budget and cooking time wherever possible.
- Follow the user's preferred meal routine and meal management style. The number of meals returned must match the meal routine requirement.
- Each meal MUST include a clear "portionGuide" in everyday units (e.g. "1 roti + ½ cup daal + salad", "½ cup cooked basmati rice + chicken salan").
- Each meal MUST include a "sugarImpact" tag: one of "Low", "Moderate", "Watch".
- Avoid white sugar, sugary drinks, fruit juice, sweets / mithai, and large portions of white rice.
- Description should explain WHY this meal is good for blood sugar (2-3 sentences).
- Include "waterTargetLitres" as a whole number of litres for the day, rounded to the nearest litre.

Return JSON only:
{"waterTargetLitres":3,"meals":[
  {"mealType":"Breakfast","name":"...","description":"...","portionGuide":"e.g. 1 roti + 1 boiled egg + ½ cup yoghurt","sugarImpact":"Low","calories":0,"macros":{"carbs":0,"protein":0,"fat":0},"tags":["Low GI","Diabetes-friendly"],"ingredients":["..."]},
  {"mealType":"Lunch", ...},
  {"mealType":"Dinner", ...},
  {"mealType":"Snack", ...}
]}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: DIABETIC_SYSTEM_PROMPT },
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

    if (meals.length !== 4 || !meals.every(m => m.name && m.mealType && m.calories > 0)) {
      throw new Error('Invalid meal structure');
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
 * Generate the full 7-day diabetic meal plan in one OpenAI call.
 */
export async function generateMealPlanWithAI(user, dailyCalorieTarget, dailyMacroTargets) {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 35000;

  try {
    const context = buildDiabeticContext(user);
    const mealRoutine = mealRoutineInstruction(user);

    const prompt = `${context}

Generate a 7-DAY diabetic-safe meal plan.
Meal routine requirement: ${mealRoutine}
 - Breakfast ~${Math.round(dailyCalorieTarget * 0.25)}kcal
 - Lunch ~${Math.round(dailyCalorieTarget * 0.35)}kcal
 - Dinner ~${Math.round(dailyCalorieTarget * 0.30)}kcal
 - Snack ~${Math.round(dailyCalorieTarget * 0.10)}kcal

Macro targets per day: Carbs ${dailyMacroTargets.carbs}g (LOW-GI), Protein ${dailyMacroTargets.protein}g, Fat ${dailyMacroTargets.fat}g.

REQUIREMENTS:
- Use the user's local foods, likes, budget and cooking time wherever possible.
- Follow the user's preferred meal routine and meal management style. The number of meals returned for each day must match the meal routine requirement.
- Vary meals across the 7 days (no exact repeats).
- Each meal MUST include "portionGuide" in everyday units (e.g. "1 roti + ½ cup daal + salad", "½ cup cooked basmati rice + chicken salan").
- Each meal MUST include a "sugarImpact" tag: "Low" | "Moderate" | "Watch".
- Avoid white sugar, sugary drinks, mithai, fruit juice and large portions of white rice.
- Include "waterTargetLitres" as a whole number of litres for the day, rounded to the nearest litre.

Return JSON only:
{"waterTargetLitres":3,"days":[{"meals":[
  {"mealType":"Breakfast","name":"...","description":"Why this is blood-sugar friendly (2-3 sentences)","portionGuide":"...","sugarImpact":"Low","calories":0,"macros":{"carbs":0,"protein":0,"fat":0},"tags":["Low GI","Diabetes-friendly"],"ingredients":["..."]},
  ...
]}, ... 7 days total ...]}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: DIABETIC_SYSTEM_PROMPT },
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
 * Decide whether a specific food/dish is safe for the diabetic user.
 */
export async function checkFoodSafetyWithAI(user, foodName, portion = '') {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 12000;

  try {
    const context = buildDiabeticContext(user);

    const prompt = `${context}

The user is asking: "Can I eat ${foodName}${portion ? ' (' + portion + ')' : ''}?"

Decide based on the user's diabetes status, latest sugar / HbA1c, medications, allergies and diet style.

Return JSON only:
{
  "verdict": "Safe" | "Eat with care" | "Avoid",
  "reason": "Short 1-2 sentence reason in plain language.",
  "safePortion": "Specific portion the user MAY eat, e.g. '½ cup cooked rice with daal & salad' or 'Up to 1 small apple after meal'",
  "sugarImpact": "Low" | "Moderate" | "Watch",
  "betterAlternatives": ["alt 1", "alt 2", "alt 3"],
  "tips": ["practical tip 1", "tip 2"]
}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: DIABETIC_SYSTEM_PROMPT },
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
        verdict: parsed.verdict || 'Eat with care',
        reason: parsed.reason || '',
        safePortion: parsed.safePortion || '',
        sugarImpact: parsed.sugarImpact || 'Moderate',
        betterAlternatives: Array.isArray(parsed.betterAlternatives) ? parsed.betterAlternatives : [],
        tips: Array.isArray(parsed.tips) ? parsed.tips : [],
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
// 3) Sugar-safe food swaps
// ---------------------------------------------------------------------------

/**
 * Suggest sugar-safe swaps for a food / craving.
 */
export async function generateFoodSwapsWithAI(user, foodName) {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 12000;

  try {
    const context = buildDiabeticContext(user);

    const prompt = `${context}

Suggest 4 SUGAR-SAFE swaps for: "${foodName}".
Each swap must be culturally appropriate (use roti, rice, daal, salan, qeema, biryani, fruits etc. when relevant), affordable for the user's budget and quick to prepare.

Return JSON only:
{
  "swaps": [
    {
      "original": "${foodName}",
      "swap": "name of the swap",
      "portion": "everyday-unit portion, e.g. '1 roti + ½ cup daal'",
      "sugarImpact": "Low" | "Moderate",
      "why": "1 sentence why this is better for blood sugar"
    }
  ]
}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: DIABETIC_SYSTEM_PROMPT },
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

    return Array.isArray(parsed.swaps) ? parsed.swaps : [];
  } catch (error) {
    console.error('generateFoodSwapsWithAI error:', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 4) Weekly grocery list
// ---------------------------------------------------------------------------

/**
 * Build a sugar-safe weekly grocery list based on the user's profile (and an
 * optional list of meal names already planned).
 */
export async function generateGroceryListWithAI(user, plannedMeals = []) {
  const openai = getOpenAI();
  if (!openai) return null;
  const timeout = 15000;

  try {
    const context = buildDiabeticContext(user);
    const mealsHint = plannedMeals.length
      ? `Planned meals this week: ${plannedMeals.slice(0, 28).join('; ')}.`
      : 'No specific meals planned yet — assume a typical diabetic-friendly week.';

    const prompt = `${context}

Build a WEEKLY GROCERY LIST that is diabetic-safe, culturally appropriate (South Asian / Pakistani / Indian friendly) and matches the user's budget & cooking time.
${mealsHint}

Group items by category. Use everyday units (kg, g, packs, pieces, dozen, cups).
If planned meals are provided, include ONLY ingredients required by those planned meals and portion guides. Do not add extra healthy staples, snacks, fruits, or pantry items unless they are clearly needed for the listed meals.
Combine duplicate ingredients across the week and estimate conservative quantities for one person.
Avoid: white sugar, soft drinks, fruit juice, sweets / mithai, full-cream sweetened products.

Return JSON only:
{
  "categories": [
    {
      "name": "Vegetables",
      "items": [
        { "name": "Spinach", "quantity": "500 g", "note": "for daal palak, optional" }
      ]
    },
    { "name": "Fruits (low sugar)", "items": [...] },
    { "name": "Grains & Pulses", "items": [...] },
    { "name": "Protein", "items": [...] },
    { "name": "Dairy & Eggs", "items": [...] },
    { "name": "Pantry / Spices", "items": [...] },
    { "name": "Snacks (diabetic-safe)", "items": [...] }
  ],
  "avoid": ["item 1", "item 2"]
}`;

    const responsePromise = openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: DIABETIC_SYSTEM_PROMPT },
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
    };
  } catch (error) {
    console.error('generateGroceryListWithAI error:', error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 5) Care AI chat (diabetes-focused)
// ---------------------------------------------------------------------------

export async function generateChatResponse(userMessage, user, chatHistory = []) {
  const openai = getOpenAI();
  if (!openai) {
    console.warn('OpenAI not initialized, returning null to use fallback response');
    return null;
  }

  try {
    const context = buildDiabeticContext(user);

    const systemPrompt = `${DIABETIC_SYSTEM_PROMPT}

You are chatting with the user inside the app. Be empathetic, short (2-3 short paragraphs max) and practical.
When asked "can I eat X" always give: verdict (Safe / With care / Avoid), a safe portion, and a quick reason about blood sugar.
When the user is upset about a high reading, calm them first, then give 1-2 concrete next steps.
Never replace doctor's advice. Mention consulting the doctor for any medication change or for HbA1c above 9 %.

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
      responseType = 'blood_sugar';
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
