require('dotenv').config();

const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const WebSocket = require('ws');
const { execSync } = require('child_process');
const pkg = require('./package.json');

function getGitBuildInfo() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) {
    const hash = process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 7);
    return {
      version: `v${pkg.version || '1.0.0'} (${hash})`,
      lastPushed: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      commitHash: hash,
    };
  }

  try {
    const commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
    const commitDate = execSync('git log -1 --format="%cd" --date=format:"%b %d, %Y, %I:%M %p"', { encoding: 'utf8' }).trim();
    return {
      version: `v${pkg.version || '1.0.0'} (${commitHash})`,
      lastPushed: commitDate,
      commitHash,
    };
  } catch (err) {
    return {
      version: `v${pkg.version || '1.0.0'}`,
      lastPushed: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
      commitHash: '',
    };
  }
}

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || 'llama-3.3-70b-versatile';
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'qwen/qwen3.6-27b';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODELS = [
  process.env.GEMINI_MODEL,
  'gemini-2.0-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash-latest',
  'gemini-3.6-flash'
].filter((m, i, self) => m && self.indexOf(m) === i);
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// Service-role client: bypasses RLS, used only after we've verified the caller's
// own access token below — never exposed to the browser. We only ever call
// .from()/.auth() on this client (no realtime), but the SDK's constructor still
// requires a WebSocket implementation on Node < 22, hence the `ws` transport.
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { realtime: { transport: WebSocket } })
    : null;

// Verifies the bearer token the client got from supabase-js auth and attaches the user.
async function requireUser(req, res, next) {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Supabase is not configured on the server (missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' });
  }
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization bearer token' });
  }
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data.user) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }
  req.user = data.user;
  next();
}

// Simple shared-password gate for the admin approval panel — no separate admin
// account, just a password checked against ADMIN_PASSWORD (defaults to "admin").
function requireAdmin(req, res, next) {
  if (!supabaseAdmin) {
    return res.status(500).json({ error: 'Supabase is not configured on the server' });
  }
  const password = req.headers['x-admin-password'];
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  next();
}

const SYSTEM_PROMPT = `You are a precision nutrition estimator specialized in Indian home cooking, food items, and beverages. Given a description or photo of a meal/food item, perform exact mathematical nutrition calculations based on the total quantity, ingredients, and cooking oil specified.

STRICT NUTRITIONAL BENCHMARKS (Use these exact per-100g / per-unit standards for scaling):
- Whole Milk (standard cow/buffalo): ~62 kcal, 3.2g protein, 4.8g carbs, 3.5g fat per 100g/100ml. (Example: 500g whole milk = 310 kcal, 16g protein, 24g carbs, 17.5g fat).
- Toned Milk (low fat): ~54 kcal, 3.1g protein, 4.7g carbs, 3.0g fat per 100g/100ml. (Example: 500g toned milk = 270 kcal, 15.5g protein, 23.5g carbs, 15g fat).
- Skimmed Milk: ~35 kcal, 3.4g protein, 4.8g carbs, 0.5g fat per 100g/100ml. (Example: 500g skimmed milk = 175 kcal, 17g protein, 24g carbs, 2.5g fat).
- Paneer: ~265 kcal, 18g protein, 6g carbs, 20g fat per 100g.
- Curd / Dahi: ~60 kcal, 3.2g protein, 4.5g carbs, 3.3g fat per 100g.
- Chicken (Boneless / Breast): ~120 kcal, 22.5g protein, 0g carbs, 2.6g fat per 100g raw.
- Chicken (Curry Cut / Whole): ~165 kcal, 18g protein, 0g carbs, 9.5g fat per 100g raw.
- Mutton / Goat Meat: ~240 kcal, 20g protein, 0g carbs, 17g fat per 100g raw.
- Egg (1 whole large, 50g): ~72 kcal, 6.3g protein, 0.4g carbs, 4.8g fat.
- Steamed Rice (cooked): ~130 kcal, 2.7g protein, 28g carbs, 0.3g fat per 100g. Raw Rice: ~360 kcal per 100g.
- Roti / Chapati (1 medium, 30g flour): ~85 kcal, 3.5g protein, 18g carbs, 1g fat.
- Dal / Lentils (cooked): ~120 kcal, 7g protein, 20g carbs, 4g fat per 100g.
- Oil / Ghee: ~45 kcal, 5g fat per 1 tsp (5ml). ~135 kcal, 15g fat per 1 tbsp (15ml).

MATHEMATICAL SCALING & ITEM DETECTION RULE:
1. Always calculate total values linearly from the specified mass/volume. If the user specifies generic "milk" (without milk type specified), default to Whole Milk (~62 kcal, 3.2g protein, 3.5g fat per 100g -> 500g = ~310 kcal, 16g protein, 17.5g fat).
2. Detect each individual dish/ingredient and its specific cooking method (e.g. cooked in ghee/oil, fried, boiled, raw, grilled). Calculate item-by-item calories & macros reflecting the quantity and cooking oil/ghee added.
3. Include an "items" array breaking down each detected item with its name, portion, cooking note, and individual calories/protein/carbs/fat.

Respond with ONLY a single valid JSON object and nothing else — no markdown fences, no explanation outside JSON.
JSON format:
{
  "description": string,
  "calories": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "items": [
    {
      "name": string,
      "calories": number,
      "protein": number,
      "carbs": number,
      "fat": number
    }
  ]
}`;

const INSIGHTS_SYSTEM_PROMPT = `You are a supportive, concise nutrition coach for someone eating mostly Indian home-cooked food. Given a person's stats and calculated calorie/macro targets, write a short insight (3-4 sentences, plain prose, no markdown, no headers, no bullet points) explaining their daily calorie target relative to their maintenance level and practical tips for hitting their protein/carb/fat/fiber ranges with everyday Indian meals. Be encouraging and specific to the numbers given.`;

const COACH_SYSTEM_PROMPT = `You are a top-tier, evidence-based physique and performance coach who eats mostly Indian home-cooked food. A client gives you their body stats, their BMR and TDEE (maintenance calories), and a specific goal in their own words — which may be a nuanced framing like "muscle gain", "lean bulk", "recomp", "aggressive cut", "shredding", etc. Use real coaching judgment to set the numbers correctly for THAT specific goal:
- Lean bulk: a small, controlled surplus (roughly 5-10% above TDEE, e.g. TDEE + 200-300 kcal).
- Muscle gain: a moderate surplus (roughly 10-15% above TDEE).
- Recomposition (recomp): calories at or very close to maintenance, with protein pushed high.
- Aggressive cut / shredding: a larger deficit (roughly 20-25% below TDEE).
- General fat loss: a moderate deficit (roughly 15-20% below TDEE).
- Maintenance: calories set at TDEE.

To calculate macros precisely, follow this strict math:
1. Protein: Set between 1.6g and 2.2g per kg of bodyweight (favoring 2.0g-2.2g for fat loss/recomp/muscle gain).
2. Fat: Set to 20% to 30% of the daily calorie target (typically 25% for balanced health). To get fat in grams, take (goal_calories * fat_percent) / 9.
3. Carbs: Must fill all remaining calories. To get carbs in grams, take (goal_calories - (protein_g * 4 + fat_g * 9)) / 4.
4. Fiber: Set to 25g to 35g depending on size/calories.

Ensure your calculations are mathematically consistent: (protein_g * 4 + fat_g * 9 + carbs_g * 4) should equal goal_calories.

Respond with ONLY a single valid JSON object and nothing else — no markdown fences, no explanation outside the JSON. The JSON must have exactly these keys: {"goal_calories": number, "protein_g": number, "fat_g": number, "carbs_g": number, "fiber_g": number, "rationale": string}. "rationale" should be 2-4 confident, coach-toned sentences explaining why these specific numbers fit this specific goal.`;

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found in model response');
  return JSON.parse(match[0]);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Groq's 429 body includes a "Please try again in Xs" hint; the Retry-After
// header (when present) is the more reliable source.
function parseRetryAfterSeconds(res, bodyText) {
  const header = res.headers.get('retry-after');
  if (header && !isNaN(parseFloat(header))) return parseFloat(header);
  const match = bodyText.match(/try again in ([\d.]+)s/i);
  if (match) return parseFloat(match[1]);
  return null;
}

const MAX_AUTO_RETRY_WAIT_SECONDS = 15;

async function callGroq(messages, model, { expectJson = true, _retried = false } = {}) {
  if (!GROQ_API_KEY) {
    const err = new Error('GROQ_API_KEY is not set on the server');
    err.status = 500;
    throw err;
  }
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();

    if (res.status === 429) {
      const waitSeconds = parseRetryAfterSeconds(res, bodyText);
      // A short wait is worth riding out automatically; the caller never sees the blip.
      if (!_retried && waitSeconds !== null && waitSeconds <= MAX_AUTO_RETRY_WAIT_SECONDS) {
        await sleep(waitSeconds * 1000 + 250);
        return callGroq(messages, model, { expectJson, _retried: true });
      }
      const err = new Error(
        `Groq's rate limit for "${model}" was reached (free tier limits are low per-minute). ${
          waitSeconds !== null ? `Try again in about ${Math.ceil(waitSeconds)}s.` : 'Wait a bit and try again.'
        }`
      );
      err.status = 429;
      throw err;
    }

    const err = new Error(`Groq API error (${res.status}): ${bodyText}`);
    err.status = 502;
    throw err;
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    const err = new Error('Groq response had no content');
    err.status = 502;
    throw err;
  }
  return expectJson ? extractJson(content) : content.trim();
}

async function callGemini(systemPrompt, userPrompt, imagePayload = null) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set on the server');
  }

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

      const parts = [{ text: userPrompt }];
      if (imagePayload && imagePayload.imageBase64 && imagePayload.mediaType) {
        parts.push({
          inline_data: {
            mime_type: imagePayload.mediaType,
            data: imagePayload.imageBase64,
          },
        });
      }

      const payload = {
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          response_mime_type: 'application/json',
          temperature: 0.2,
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Gemini API model ${model} HTTP ${res.status}: ${bodyText.slice(0, 150)}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error(`Empty content response from Gemini model ${model}`);
      }

      return extractJson(text);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('All Gemini models failed');
}

async function callGeminiText(systemPrompt, userPrompt) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set on the server');
  }

  let lastError = null;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

      const payload = {
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
        },
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw new Error(`Gemini API model ${model} HTTP ${res.status}: ${bodyText.slice(0, 150)}`);
      }

      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error(`Empty content response from Gemini model ${model}`);
      }

      return text.trim();
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('All Gemini models failed');
}

async function estimateNutritionText(systemPrompt, userPrompt) {
  if (GEMINI_API_KEY) {
    try {
      const result = await callGemini(systemPrompt, userPrompt);
      console.log('[AI Provider] Successfully generated estimation via Gemini API');
      return result;
    } catch (err) {
      console.warn(`[AI Provider Fallback] Gemini API unavailable (${err.message}). Falling back to Groq API...`);
    }
  }

  return await callGroq(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    GROQ_TEXT_MODEL
  );
}

async function estimateNutritionPhoto(systemPrompt, imageBase64, mediaType) {
  if (GEMINI_API_KEY) {
    try {
      const result = await callGemini(systemPrompt, 'Estimate the nutrition for the meal in this photo.', {
        imageBase64,
        mediaType,
      });
      console.log('[AI Provider] Successfully generated photo estimation via Gemini Vision API');
      return result;
    } catch (err) {
      console.warn(`[AI Provider Fallback] Gemini Vision API unavailable (${err.message}). Falling back to Groq Vision API...`);
    }
  }

  return await callGroq(
    [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Estimate the nutrition for the meal in this photo.' },
          { type: 'image_url', image_url: { url: `data:${mediaType};base64,${imageBase64}` } },
        ],
      },
    ],
    GROQ_VISION_MODEL
  );
}

function fallbackInsights(targets) {
  const action =
    targets.goal_type === 'lose' ? 'losing weight' : targets.goal_type === 'gain' ? 'gaining weight' : 'maintaining your weight';
  const deltaText =
    targets.calorie_delta > 0
      ? `a ${targets.calorie_delta} kcal daily deficit below your ${targets.tdee} kcal maintenance level`
      : targets.calorie_delta < 0
      ? `a ${-targets.calorie_delta} kcal daily surplus above your ${targets.tdee} kcal maintenance level`
      : `right at your ${targets.tdee} kcal maintenance level`;
  return `Your plan for ${action} is built around ${targets.goal_calories} kcal/day — ${deltaText}. Aim for ${targets.protein.min_g}-${targets.protein.max_g}g protein, ${targets.carbs.min_g}-${targets.carbs.max_g}g carbs, and ${targets.fat.min_g}-${targets.fat.max_g}g fat each day, with at least ${targets.fiber.min_g}g fiber from vegetables, dals, and whole grains.`;
}

async function generateInsights(profile, targets) {
  const summary = `Profile: ${profile.gender}, age ${profile.age}, weight ${profile.weight_kg}kg, height ${profile.height_cm}cm, activity level "${profile.activity_level}". Goal: ${targets.goal_type}${
    targets.goal_rate_kg_per_week ? ` at ${targets.goal_rate_kg_per_week}kg/week` : ''
  }. BMR ${targets.bmr} kcal, maintenance (TDEE) ${targets.tdee} kcal, daily calorie target ${targets.goal_calories} kcal (calorie delta vs maintenance: ${targets.calorie_delta}, positive means deficit). Protein target ${targets.protein.min_g}-${targets.protein.max_g}g, fat ${targets.fat.min_g}-${targets.fat.max_g}g, carbs ${targets.carbs.min_g}-${targets.carbs.max_g}g, fiber at least ${targets.fiber.min_g}g.`;

  try {
    return await callGeminiText(INSIGHTS_SYSTEM_PROMPT, summary);
  } catch (err) {
    console.warn(`[AI Provider Fallback] Gemini API insights failed (${err.message}). Using local fallback...`);
    return fallbackInsights(targets);
  }
}

// Sanity bounds so a hallucinated Groq response can't push someone into an unsafe plan.
function clampCoachPlan(plan, profile, baseline) {
  const { weight_kg, gender } = profile;
  const floor = MIN_SAFE_CALORIES[gender] || 1200;
  const ceiling = baseline.tdee * 1.6;

  const goal_calories = Math.round(Math.min(Math.max(plan.goal_calories, floor), ceiling));
  const protein_g = round1(Math.min(Math.max(plan.protein_g, 0.5 * weight_kg), 3 * weight_kg));
  const fat_g = round1(Math.min(Math.max(plan.fat_g, 0.4 * weight_kg), 2 * weight_kg));
  const fiber_g = Math.round(Math.min(Math.max(plan.fiber_g, 15), 60));

  const macroKcal = protein_g * 4 + fat_g * 9;
  const carbs_g = round1(Math.max(0, (goal_calories - macroKcal) / 4));

  return { goal_calories, protein_g, fat_g, carbs_g, fiber_g, rationale: plan.rationale };
}

function buildTargetsFromCoachPlan(profile, baseline, plan) {
  const { goal_calories, protein_g, fat_g, carbs_g, fiber_g, rationale } = clampCoachPlan(plan, profile, baseline);
  const band = (grams) => round1(grams * 0.1); // +/-10% band so the existing range-bar UI still has a zone to render

  return {
    bmr: baseline.bmr,
    tdee: baseline.tdee,
    goal_type: profile.goal_type,
    goal_rate_kg_per_week: profile.goal_rate_kg_per_week || 0,
    goal_description: profile.goal_description || '',
    coach_generated: true,
    goal_calories,
    calorie_delta: Math.round(baseline.tdee - goal_calories),
    floor_applied: false,
    protein: {
      min_g: round1(protein_g - band(protein_g)),
      max_g: round1(protein_g + band(protein_g)),
      min_kcal: Math.round((protein_g - band(protein_g)) * 4),
      max_kcal: Math.round((protein_g + band(protein_g)) * 4),
    },
    fat: {
      min_g: round1(fat_g - band(fat_g)),
      max_g: round1(fat_g + band(fat_g)),
      min_kcal: Math.round((fat_g - band(fat_g)) * 9),
      max_kcal: Math.round((fat_g + band(fat_g)) * 9),
    },
    carbs: {
      min_g: round1(Math.max(0, carbs_g - band(carbs_g))),
      max_g: round1(carbs_g + band(carbs_g)),
      min_kcal: Math.round(Math.max(0, carbs_g - band(carbs_g)) * 4),
      max_kcal: Math.round((carbs_g + band(carbs_g)) * 4),
    },
    fiber: { min_g: fiber_g },
    rationale,
  };
}

async function requestCoachPlan(profile, baseline) {
  const summary = `Client stats: ${profile.gender}, age ${profile.age}, weight ${profile.weight_kg}kg, height ${profile.height_cm}cm, activity level "${profile.activity_level}". BMR ${baseline.bmr} kcal, TDEE (maintenance) ${baseline.tdee} kcal. Stated goal: "${profile.goal_description}" (general category: ${profile.goal_type}${
    profile.goal_rate_kg_per_week ? ` at roughly ${profile.goal_rate_kg_per_week}kg/week` : ''
  }). Set the daily calorie target and macro targets that best fit this specific goal.`;

  try {
    const plan = await callGemini(COACH_SYSTEM_PROMPT, summary);
    if (
      typeof plan.goal_calories !== 'number' ||
      typeof plan.protein_g !== 'number' ||
      typeof plan.fat_g !== 'number' ||
      typeof plan.fiber_g !== 'number'
    ) {
      return null;
    }
    return plan;
  } catch (err) {
    console.error('Gemini coach plan failed:', err);
    return null;
  }
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Public: hands the browser what it needs to talk to Supabase directly.
// The anon key is meant to be public — Postgres Row Level Security is what
// actually keeps one user's data away from another, not secrecy of this key.
app.get('/api/config', (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase is not configured on the server (missing SUPABASE_URL / SUPABASE_ANON_KEY)' });
  }
  const buildInfo = getGitBuildInfo();
  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY,
    version: buildInfo.version,
    lastPushed: buildInfo.lastPushed,
    commitHash: buildInfo.commitHash,
  });
});

// Admin approval panel: lists unapproved sign-ups and lets the admin accept/reject
// them. Gated by a shared password (ADMIN_PASSWORD, default "admin") rather than
// a separate Supabase account — writes use the service-role client so they bypass
// the RLS policy that otherwise stops anyone from setting their own `approved` flag.
app.get('/api/admin/pending', requireAdmin, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('user_status')
    .select('user_id, email, created_at')
    .eq('approved', false)
    .order('created_at', { ascending: true });
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.json(data);
});

app.post('/api/admin/approve', requireAdmin, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  const { error } = await supabaseAdmin.from('user_status').update({ approved: true }).eq('user_id', user_id);
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.status(204).end();
});

app.post('/api/admin/reject', requireAdmin, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id is required' });
  // Deleting the auth user cascades to user_status/profiles/entries (all FK'd with ON DELETE CASCADE).
  const { error } = await supabaseAdmin.auth.admin.deleteUser(user_id);
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  res.status(204).end();
});

// Entries and the plain daily goal are simple per-user CRUD with no secrets
// involved, so the browser talks to Supabase directly (see public/app.js) —
// Express only needs to handle the profile/macro-targets flow below, since
// that's the part that calls Groq with the server-side API key.

app.post('/api/profile', requireUser, async (req, res) => {
  const { weight_kg, height_cm, age, gender, activity_level, goal_type, goal_rate_kg_per_week, goal_description } = req.body;
  const profile = { weight_kg, height_cm, age, gender, activity_level, goal_type, goal_rate_kg_per_week, goal_description: goal_description || '' };
  const errors = validateProfile(profile);
  if (errors.length) {
    return res.status(400).json({ error: errors.join('; ') });
  }

  const baseline = computeMacroTargets(profile);

  let targets;
  let insights;
  if (profile.goal_description.trim()) {
    const plan = await requestCoachPlan(profile, baseline);
    if (plan) {
      targets = buildTargetsFromCoachPlan(profile, baseline, plan);
      insights = targets.rationale;
    }
  }
  if (!targets) {
    targets = baseline;
    insights = await generateInsights(profile, baseline);
  }
  targets = { ...targets, insights };

  const row = {
    user_id: req.user.id,
    weight_kg: profile.weight_kg,
    height_cm: profile.height_cm,
    age: profile.age,
    gender: profile.gender,
    activity_level: profile.activity_level,
    goal_type: profile.goal_type,
    goal_rate_kg_per_week: profile.goal_rate_kg_per_week || 0,
    goal_description: profile.goal_description,
    insights,
    cached_targets: targets,
    daily_goal_calories: targets.goal_calories,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseAdmin.from('profiles').upsert(row, { onConflict: 'user_id' }).select().single();
  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ profile: data, targets });
});

// No separate GET for reading back targets — the client reads `cached_targets`
// directly off its own profiles row via Supabase (RLS-scoped), no round trip needed.

app.post('/api/estimate-text', async (req, res) => {
  const { description } = req.body;
  if (!description) return res.status(400).json({ error: 'description is required' });
  try {
    const result = await estimateNutritionText(SYSTEM_PROMPT, description);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post('/api/estimate-photo', async (req, res) => {
  const { imageBase64, mediaType } = req.body;
  if (!imageBase64 || !mediaType) {
    return res.status(400).json({ error: 'imageBase64 and mediaType are required' });
  }
  try {
    const result = await estimateNutritionPhoto(SYSTEM_PROMPT, imageBase64, mediaType);
    res.json(result);
  } catch (err) {
    if (/invalid image data/i.test(err.message)) {
      return res
        .status(400)
        .json({ error: 'This photo could not be processed by the vision model. Try a different photo (a plain JPEG or PNG works best).' });
    }
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  // When running locally (node server.js), serve the SPA fallback.
  // On Vercel, this route is never reached — all static assets are served
  // by @vercel/static CDN and all API routes go to /api/*.
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Dabba running at http://localhost:${PORT}`);
  });
}

module.exports = app;

