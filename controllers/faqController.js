import OpenAI from 'openai';
import { getMergedKnowledgeText } from '../services/knowledgeStoreService.js';
import { recordOpenAiUsage } from '../utils/trackUsage.js';

const MAX_HISTORY_MESSAGES = 10;

let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  const key = process.env.OPENAI_API_KEY?.trim();
  if (key) {
    _openai = new OpenAI({ apiKey: key });
  }
  return _openai;
}

/**
 * POST /api/faq/chat
 *
 * Public endpoint — no auth required.
 * Answers questions strictly based on the knowledge base managed by the admin.
 * Falls back gracefully if OpenAI is not configured.
 *
 * Body: { messages: [{ role: "user"|"assistant", content: string }] }
 * Response: { reply: string }
 */
export async function faqChat(req, res) {
  try {
    const messages = req.body?.messages;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Provide a non-empty "messages" array.',
      });
    }

    // Validate each message
    for (const m of messages) {
      if (!m?.role || !m?.content || typeof m.content !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Each message must have "role" and "content" (string).',
        });
      }
      if (!['user', 'assistant'].includes(m.role)) {
        return res.status(400).json({
          success: false,
          message: 'Message role must be "user" or "assistant".',
        });
      }
    }

    const openai = getOpenAI();
    if (!openai) {
      return res.json({
        success: true,
        reply:
          'The AI assistant is currently unavailable. Please try again later or contact support.',
      });
    }

    // Fetch current knowledge base (curated by admin via uni_admin)
    const knowledgeText = await getMergedKnowledgeText();

    const systemPrompt = knowledgeText?.trim()
      ? `You are a support assistant for the Wellora Health app. Your ONLY source of truth is the knowledge base delimited below.

STRICT RULES — follow them without exception:
1. Answer ONLY from the knowledge base. Do NOT use any external knowledge, training data, or assumptions.
2. If the user's question is not clearly answered by the knowledge base, respond with exactly:
   "I don't have information on that in my current knowledge base. Please contact support or consult your doctor/dietitian."
   Do NOT attempt a partial answer, guess, or suggest related information that isn't in the knowledge base.
3. Do NOT say "based on general knowledge", "typically", "usually", or any phrase that implies you are drawing from outside the knowledge base.
4. Keep answers concise and factual. Quote or closely paraphrase the knowledge base when possible.

--- KNOWLEDGE BASE START ---
${knowledgeText}
--- KNOWLEDGE BASE END ---`
      : `You are a support assistant for the Wellora Health app. The knowledge base has not been configured yet.

For every question, respond with:
"I don't have information on that in my current knowledge base. Please contact support or consult your doctor/dietitian."

Do NOT attempt to answer from general knowledge.`;

    // Keep only the most recent messages to avoid large token usage
    const recentMessages = messages.slice(-MAX_HISTORY_MESSAGES);

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...recentMessages.map((m) => ({ role: m.role, content: m.content })),
      ],
      max_tokens: 500,
      temperature: 0,
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() ?? '';
    if (!reply) {
      return res.status(502).json({
        success: false,
        message: 'Received an empty response from the AI. Please try again.',
      });
    }

    recordOpenAiUsage(null, completion.usage, 'faq-chat', 'gpt-4o-mini').catch(() => {});

    return res.json({ success: true, reply });
  } catch (err) {
    console.error('[faqChat] error:', err?.message || err);
    return res.status(500).json({
      success: false,
      message: 'Failed to process your question. Please try again.',
    });
  }
}
