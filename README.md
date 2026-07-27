# Dabba 🍱

A personal calorie tracker themed around an Indian steel tiffin box. Multi-user with email/password login, entries sync live across devices via Supabase.

## Features

- Email/password sign-in (Supabase Auth) — each user only ever sees their own data (enforced by Postgres Row Level Security)
- **Admin-gated sign-up**: anyone can create an account, but new accounts can't log anything until approved from a password-protected admin panel (link at the bottom of the sign-in screen)
- Entries sync **live**: add or delete food on one device/tab and any other open session updates instantly (Supabase Realtime)
- Date navigation (previous/next day, Today/Yesterday labels) with per-day logs
- Tiffin-lid calorie ring showing today's total vs. your daily goal, plus remaining/over-goal text and protein/carb/fat totals
- Three ways to log food:
  1. **Search DB** — a built-in database of ~48 common Indian dishes, tap to log a serving
  2. **Describe** — a structured form (food type, main ingredient, raw quantity, oil/ghee added, other ingredients, optional notes) gets turned into a nutrition estimate via Groq
  3. **Photo** — currently disabled (see `public/index.html` — the tab button was removed to avoid Groq vision rate limits; the endpoint and handling code are still there to re-enable)
- **Profile & macro targets**: enter your body stats + a goal (lose/maintain/gain weight, or type something specific like "lean bulk" or "muscle gain") to get BMR, TDEE, a calorie target, and protein/carb/fat/fiber ranges. A specific typed goal gets sent to Groq acting as a coach to tailor the plan; otherwise a standard formula is used. Range bars on the main screen show today's totals against these targets.
- Editable, persisted daily calorie goal (auto-synced to your calculated target whenever you save your profile)

AI estimation and coaching insights are powered by [Groq](https://groq.com) — fast inference over open models, called server-side so your API key never touches the browser. Data (users, entries, profile) lives in a Supabase Postgres project.

## Setup

### 1. Install dependencies
```
npm install
```

### 2. Create a Supabase project
1. Sign up / log in at [supabase.com](https://supabase.com) and create a new project.
2. Open the **SQL Editor** in your project dashboard, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run it. This creates the `profiles`, `entries`, and `user_status` tables, Row Level Security policies, enables Realtime on `entries`, and adds a trigger that auto-creates an (unapproved) `user_status` row whenever someone signs up.
3. In **Authentication > Providers**, email/password sign-up is enabled by default. For local development you may want to turn off **Confirm email** (Authentication > Settings) so new accounts can sign in immediately without waiting on an email — otherwise you'll need working email delivery configured, and new sign-ups will need to click a confirmation link before they can sign in.
4. In **Project Settings > API**, copy your **Project URL**, **anon/public key**, and **service_role key**.

### 3. Configure environment variables
```
cp .env.example .env
```
Edit `.env`:
- `GROQ_API_KEY` — get one free at [console.groq.com](https://console.groq.com). The default models (`llama-3.3-70b-versatile` for text, `qwen/qwen3.6-27b` for photos) work on Groq's free tier — change `GROQ_TEXT_MODEL` / `GROQ_VISION_MODEL` if you'd like different models. Not every model is available to every account/region — if you get a `model_not_found` error, check `https://api.groq.com/openai/v1/models` with your API key to see what you actually have access to.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — from step 2.4 above. **Never commit or expose `SUPABASE_SERVICE_ROLE_KEY`** — it bypasses Row Level Security and is only ever used server-side.
- `ADMIN_PASSWORD` — the shared password for the admin approval panel (defaults to `admin` if unset — **change this** before exposing the app beyond your own machine).

### 4. Start the server
```
npm start
```
Open [http://localhost:3000](http://localhost:3000), sign up with an email/password. New accounts land on a "waiting for approval" screen — click the small **Admin** link on the sign-in page, enter the admin password, and approve the pending sign-up. That user can then sign in and start logging. Works on mobile browsers too — try it on your phone over your local network.

## Architecture notes

- **Auth & data (entries, goal, profile reads)** happen directly from the browser to Supabase using `@supabase/supabase-js` with the public anon key — Row Level Security is what actually keeps users' data separate, not secrecy of that key.
- **Express (`server.js`)** only handles: serving the static frontend, proxying the two Groq endpoints (`/api/estimate-text`, `/api/estimate-photo`) so the Groq API key never reaches the browser, handing out Supabase config (`/api/config`), and `/api/profile` — the one write that needs both a verified user identity *and* the secret Groq key (for goal-calorie/macro calculation and coaching insights), so it verifies the caller's Supabase access token server-side and writes via the service-role key.
- No local file storage remains — all persistent data lives in your Supabase Postgres project.
