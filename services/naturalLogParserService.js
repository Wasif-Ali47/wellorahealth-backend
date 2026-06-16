import OpenAI from 'openai';

let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  const key = process.env.OPENAI_API_KEY;
  if (key?.trim()) _openai = new OpenAI({ apiKey: key });
  return _openai;
}

function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function inferMealTypeFromText(text = '') {
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

/** Split "2 eggs with 1 roti" into rough item phrases */
function splitFoodPhrases(text) {
  const cleaned = text
    .replace(/^(i\s+)?(had|ate|eaten|eating|consumed)\s+/i, '')
    .replace(/\s+(for|in|at)\s+(the\s+)?(morning|breakfast|lunch|dinner|evening|night)\s*$/i, '')
    .trim();

  const parts = cleaned
    .split(/\s+(?:with|and|,)\s+/i)
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : [cleaned || text];
}

function parseItemPhrase(phrase) {
  const match = phrase.match(/^(\d+(?:\.\d+)?)\s+(.+)$/i);
  if (match) {
    return {
      name: match[2].trim(),
      quantity: parseFloat(match[1]),
      unit: /egg|roti|slice|piece|cup/i.test(match[2]) ? 'piece' : 'serving'
    };
  }
  return { name: phrase, quantity: 1, unit: 'serving' };
}

/** Rule-based fallback when OpenAI is unavailable */
function parseWithHeuristics(text, category) {
  const lower = text.toLowerCase().trim();
  const entries = [];

  const waterMatch = lower.match(/(\d+(?:\.\d+)?)\s*(l|liter|litre|ml|glass|glasses|cup|cups)/i);
  if (category === 'water' || category === 'auto') {
    if (waterMatch || /water|hydrat|drank|drink/.test(lower)) {
      let ml = 250;
      const amount = parseFloat(waterMatch?.[1] || '1');
      const unit = (waterMatch?.[2] || 'glass').toLowerCase();
      if (unit.startsWith('l')) ml = amount * 1000;
      else if (unit === 'ml') ml = amount;
      else if (unit.includes('cup') || unit.includes('glass')) ml = amount * 250;
      const glasses = Math.round((ml / 250) * 10) / 10;
      entries.push({
        type: 'water',
        amountMl: Math.round(ml),
        organizedSummary: `${glasses} glass${glasses === 1 ? '' : 'es'} · ${Math.round(ml)} ml`,
        summary: text
      });
    }
  }

  const weightMatch = lower.match(/(\d+(?:\.\d+)?)\s*(kg|kilos|lb|lbs|pounds)/i);
  if ((category === 'weight' || category === 'auto') && weightMatch) {
    let kg = parseFloat(weightMatch[1]);
    if (/lb/.test(weightMatch[2])) kg = kg * 0.453592;
    entries.push({
      type: 'weight',
      weightKg: Math.round(kg * 10) / 10,
      organizedSummary: `${kg.toFixed(1)} kg`,
      summary: text
    });
  }

  if (entries.length === 0 && (category === 'food' || category === 'auto')) {
    const mealType = inferMealTypeFromText(text);
    const phrases = splitFoodPhrases(text);
    const items = phrases.map((p) => {
      const parsed = parseItemPhrase(p);
      return {
        name: parsed.name,
        quantity: parsed.quantity,
        unit: parsed.unit,
        calories: null
      };
    });

    entries.push({
      type: 'food',
      mealType,
      items,
      originalText: text,
      foodName: items.map((i) => i.name).join(', ')
    });
  }

  return { entries, source: 'heuristic' };
}

const SYSTEM_PROMPT = (category) => `You are a nutrition logging assistant. Organize the user's message into structured log entries.

Category hint: "${category}" (food | water | weight | auto).

Return JSON only:
{
  "entries": [
    {
      "type": "food",
      "mealType": "Breakfast" | "Lunch" | "Dinner" | "Snack",
      "originalText": "user phrase for this meal",
      "items": [
        { "name": "eggs", "quantity": 2, "unit": "piece", "calories": 140, "protein": 12 },
        { "name": "roti", "quantity": 1, "unit": "piece", "calories": 120, "protein": 3 }
      ]
    }
  ]
}

Rules:
- SPLIT distinct foods into separate items (e.g. "2 eggs with 1 roti" → items: eggs qty 2, roti qty 1).
- Infer mealType from morning/breakfast, lunch, dinner, evening, night.
- unit MUST be one of: g, ml, cup, piece, serving.
- Estimate reasonable calories and protein (grams) per item when possible.
- For water: { "type":"water", "amountMl": number, "organizedSummary": "2 glasses · 500 ml" }
- For weight: { "type":"weight", "weightKg": number, "organizedSummary": "68.5 kg" }
- Use South Asian foods when mentioned (roti, daal, salan, paratha, chai, etc.).`;

/**
 * Parse natural-language log input into organized structured entries.
 */
export async function parseNaturalLog(text, category = 'auto') {
  if (!text?.trim()) {
    return { entries: [], source: 'empty' };
  }

  const openai = getOpenAI();
  if (!openai) {
    return parseWithHeuristics(text, category);
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT(category) },
        { role: 'user', content: text.trim() }
      ]
    });

    const raw = response.choices[0]?.message?.content;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.entries) && parsed.entries.length > 0) {
      return { entries: parsed.entries, source: 'openai', usage: response.usage || null };
    }
    return parseWithHeuristics(text, category);
  } catch (err) {
    console.warn('[parseNaturalLog] OpenAI failed, using heuristics:', err.message);
    return parseWithHeuristics(text, category);
  }
}

export { startOfDay };
