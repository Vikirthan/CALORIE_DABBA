import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const RING_CIRCUMFERENCE = 2 * Math.PI * 88;

let currentDate = new Date();
let goal = 2000;
let macroTargets = null; // cached_targets from the profiles row, or null if no profile yet
let profile = null;
let selectedGender = 'male';
let selectedActivity = 'sedentary';
let selectedGoalType = 'maintain';

let supabase;
let currentSession = null;
let realtimeChannel = null;
let authMode = 'signin';

const $ = (id) => document.getElementById(id);

// Postgres `numeric` columns come back from PostgREST as strings (to avoid
// float precision loss), so anything read from Supabase needs coercing before math.
const num = (v) => Number(v) || 0;

function toDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isSameDay(a, b) {
  return toDateKey(a) === toDateKey(b);
}

function relativeLabel(d) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  if (isSameDay(d, today)) return 'Today';
  if (isSameDay(d, yesterday)) return 'Yesterday';
  if (isSameDay(d, tomorrow)) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short' });
}

function fullLabel(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function showToast(message, isError = false) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 2500);
}

// Plain fetch wrapper for the two stateless Groq-proxy endpoints and /api/config.
async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  if (res.status === 204) return null;
  return res.json();
}

// Same, but attaches the current Supabase session's access token — used for
// the one endpoint (POST /api/profile) that needs to know who's calling.
async function apiAuthed(path, options = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error('Not signed in');
  return api(path, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${session.access_token}` },
  });
}

function round1(n) {
  return Math.round((n || 0) * 10) / 10;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Auth ----------
function showApp() {
  $('authOverlay').classList.add('hidden');
  $('pendingOverlay').classList.add('hidden');
  $('appMain').classList.remove('hidden');
  $('addFoodBtn').classList.remove('hidden');
  $('headerActions').classList.remove('hidden');
}

function hideApp() {
  $('authOverlay').classList.remove('hidden');
  $('pendingOverlay').classList.add('hidden');
  $('appMain').classList.add('hidden');
  $('addFoodBtn').classList.add('hidden');
  $('headerActions').classList.add('hidden');
}

function showPending() {
  $('authOverlay').classList.add('hidden');
  $('appMain').classList.add('hidden');
  $('addFoodBtn').classList.add('hidden');
  $('headerActions').classList.add('hidden');
  $('pendingOverlay').classList.remove('hidden');
}

function setAuthMode(mode) {
  authMode = mode;
  $('authSubmit').textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  $('authToggleMode').textContent = mode === 'signin' ? 'Need an account? Sign up' : 'Already have an account? Sign in';
  hideAuthMessage();
}

function showAuthMessage(msg, isError) {
  const el = $('authMessage');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.remove('hidden');
}

function hideAuthMessage() {
  $('authMessage').classList.add('hidden');
}

$('authToggleMode').addEventListener('click', () => {
  setAuthMode(authMode === 'signin' ? 'signup' : 'signin');
});

$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!supabase) {
    showAuthMessage('The server isn\'t connected to Supabase yet — check SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY in .env and restart the server.', true);
    return;
  }
  const email = $('authEmail').value.trim();
  const password = $('authPassword').value;
  $('authSubmit').disabled = true;
  hideAuthMessage();
  try {
    if (authMode === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      if (!data.session) {
        showAuthMessage('Account created — check your email to confirm it, then sign in.');
        setAuthMode('signin');
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    showAuthMessage(err.message, true);
  } finally {
    $('authSubmit').disabled = false;
  }
});

$('signOutBtn').addEventListener('click', () => supabase.auth.signOut());
$('pendingSignOutBtn').addEventListener('click', () => supabase.auth.signOut());

function subscribeRealtime(userId) {
  if (realtimeChannel) return;
  realtimeChannel = supabase
    .channel('entries-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'entries', filter: `user_id=eq.${userId}` }, () => {
      refresh();
    })
    .subscribe();
}

function unsubscribeRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

async function isApproved(userId) {
  const { data, error } = await supabase.from('user_status').select('approved').eq('user_id', userId).maybeSingle();
  if (error) {
    console.warn('isApproved check error:', error.message);
    return true;
  }
  if (!data) {
    return true;
  }
  return data.approved !== false;
}

async function handleSession(session) {
  currentSession = session;
  if (session) {
    if (!(await isApproved(session.user.id))) {
      showPending();
      unsubscribeRealtime();
      return;
    }
    showApp();
    subscribeRealtime(session.user.id);
    await loadProfileAndTargets();
    await refresh();

    // Auto-prompt first-time users who have not configured body stats & goals yet
    if (!profile || !profile.weight_kg || !profile.height_cm || !profile.age) {
      setTimeout(() => {
        openProfileModal();
        showToast('Welcome to Dabba! Please set up your body stats & daily goals.');
      }, 600);
    }
  } else {
    hideApp();
    unsubscribeRealtime();
  }
}

async function initAuth() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  await handleSession(session);
  supabase.auth.onAuthStateChange((_event, session) => {
    handleSession(session);
  });
}

// ---------- Admin approval panel ----------
let adminPassword = null;

const adminOverlay = $('adminOverlay');
const adminLoginPanel = $('adminLoginPanel');
const adminPendingPanel = $('adminPendingPanel');
const adminMessage = $('adminMessage');

$('adminLinkBtn').addEventListener('click', () => {
  adminOverlay.classList.remove('hidden');
});
adminOverlay.addEventListener('click', (e) => {
  if (e.target === adminOverlay) adminOverlay.classList.add('hidden');
});

function showAdminMessage(msg, isError) {
  adminMessage.textContent = msg;
  adminMessage.classList.toggle('error', !!isError);
  adminMessage.classList.remove('hidden');
}

async function adminFetch(path, options = {}) {
  return api(path, {
    ...options,
    headers: { ...(options.headers || {}), 'x-admin-password': adminPassword },
  });
}

async function loadPending() {
  const pending = await adminFetch('/api/admin/pending');
  const list = $('adminPendingList');
  list.innerHTML = '';
  $('adminEmptyState').classList.toggle('hidden', pending.length > 0);
  for (const user of pending) {
    const li = document.createElement('li');
    li.className = 'admin-pending-item';
    const created = new Date(user.created_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    li.innerHTML = `
      <div>
        <div class="admin-pending-email">${escapeHtml(user.email || user.user_id)}</div>
        <div class="admin-pending-time">Signed up ${created}</div>
      </div>
      <div class="admin-pending-actions">
        <button class="secondary-btn admin-approve">Approve</button>
        <button class="secondary-btn admin-reject">Reject</button>
      </div>
    `;
    li.querySelector('.admin-approve').addEventListener('click', async () => {
      try {
        await adminFetch('/api/admin/approve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: user.user_id }),
        });
        showToast(`Approved ${user.email}`);
        loadPending();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    li.querySelector('.admin-reject').addEventListener('click', async () => {
      try {
        await adminFetch('/api/admin/reject', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: user.user_id }),
        });
        showToast(`Rejected ${user.email}`);
        loadPending();
      } catch (err) {
        showToast(err.message, true);
      }
    });
    list.appendChild(li);
  }
}

$('adminLoginBtn').addEventListener('click', async () => {
  adminPassword = $('adminPasswordInput').value;
  adminMessage.classList.add('hidden');
  try {
    await loadPending();
    adminLoginPanel.classList.add('hidden');
    adminPendingPanel.classList.remove('hidden');
  } catch (err) {
    adminPassword = null;
    showAdminMessage(err.message, true);
  }
});

// ---------- Date nav ----------
function renderDateNav() {
  $('dateRelative').textContent = relativeLabel(currentDate);
  $('dateFull').textContent = fullLabel(currentDate);
}

$('prevDay').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() - 1);
  refresh();
});
$('nextDay').addEventListener('click', () => {
  currentDate.setDate(currentDate.getDate() + 1);
  refresh();
});

// ---------- Entries + gauge ----------
async function refresh() {
  renderDateNav();
  if (!currentSession) return;
  const { data, error } = await supabase
    .from('entries')
    .select('*')
    .eq('date', toDateKey(currentDate))
    .order('logged_at', { ascending: false });
  if (error) {
    showToast(error.message, true);
    return;
  }
  renderEntries(data);
  renderGauge(data);
  renderRangeBars(data);
}

function totalsFor(entries) {
  return entries.reduce(
    (acc, e) => {
      acc.calories += num(e.calories);
      acc.protein += num(e.protein);
      acc.carbs += num(e.carbs);
      acc.fat += num(e.fat);
      return acc;
    },
    { calories: 0, protein: 0, carbs: 0, fat: 0 }
  );
}

function renderGauge(entries) {
  const totals = totalsFor(entries);

  $('totalCalories').textContent = Math.round(totals.calories);
  $('macroProtein').textContent = `${Math.round(totals.protein)}g`;
  $('macroCarbs').textContent = `${Math.round(totals.carbs)}g`;
  $('macroFat').textContent = `${Math.round(totals.fat)}g`;

  const ratio = Math.min(totals.calories / goal, 1);
  const offset = RING_CIRCUMFERENCE * (1 - ratio);
  const ring = $('ringProgress');
  ring.style.strokeDashoffset = offset;

  const over = totals.calories > goal;
  ring.classList.toggle('over-goal', over);
  ring.setAttribute('stroke', over ? 'url(#ringGradientOver)' : 'url(#ringGradientNormal)');
  const statusEl = $('ringStatus');
  statusEl.classList.toggle('over', over);
  if (over) {
    statusEl.textContent = `${Math.round(totals.calories - goal)} kcal over ${goal} goal`;
  } else {
    statusEl.textContent = `${Math.round(goal - totals.calories)} kcal remaining of ${goal}`;
  }
}

// ---------- Macro range bars ----------
function renderRangeBars(entries) {
  const section = $('macroTargetsSection');
  const prompt = $('targetsPrompt');
  if (!macroTargets) {
    section.classList.add('hidden');
    prompt.classList.remove('hidden');
    return;
  }
  section.classList.remove('hidden');
  prompt.classList.add('hidden');

  const totals = totalsFor(entries);
  const bars = [
    { key: 'protein', label: 'Protein', actual: totals.protein },
    { key: 'carbs', label: 'Carbs', actual: totals.carbs },
    { key: 'fat', label: 'Fat', actual: totals.fat },
  ];

  const container = $('rangeBars');
  container.innerHTML = '';

  for (const bar of bars) {
    const range = macroTargets[bar.key];
    const min = range.min_g;
    const max = range.max_g;
    const scaleMax = Math.max(max * 1.25, bar.actual * 1.05, 1);

    const minPct = (min / scaleMax) * 100;
    const widthPct = ((max - min) / scaleMax) * 100;
    const markerPct = Math.min((bar.actual / scaleMax) * 100, 100);

    let state = 'within';
    if (bar.actual < min) state = 'under';
    else if (bar.actual > max) state = 'over';

    const statusText =
      state === 'within'
        ? 'Within target range'
        : state === 'under'
        ? `${round1(min - bar.actual)}g below minimum`
        : `${round1(bar.actual - max)}g above maximum`;

    const row = document.createElement('div');
    row.className = 'range-bar-row';
    row.innerHTML = `
      <div class="range-bar-head">
        <span class="range-bar-name">${bar.label}</span>
        <span class="range-bar-values">${round1(bar.actual)}g · target ${round1(min)}–${round1(max)}g</span>
      </div>
      <div class="range-bar-track">
        <div class="range-bar-zone" style="left:${minPct}%; width:${widthPct}%;"></div>
        <div class="range-bar-marker ${state}" style="left:${markerPct}%;"></div>
      </div>
      <div class="range-bar-status">${statusText}</div>
    `;
    container.appendChild(row);
  }
}

function renderEntries(entries) {
  const list = $('entryList');
  list.innerHTML = '';
  $('emptyState').classList.toggle('hidden', entries.length > 0);

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'entry-item';
    const time = new Date(entry.logged_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    li.innerHTML = `
      <div class="entry-main">
        <div class="entry-top">
          <span class="source-tag ${entry.source}">${entry.source}</span>
          <span class="entry-time">${time}</span>
        </div>
        <div class="entry-name">${escapeHtml(entry.name)}</div>
        ${entry.serving_note ? `<div class="entry-serving">${escapeHtml(entry.serving_note)}</div>` : ''}
        <div class="entry-macros">P ${round1(num(entry.protein))}g · C ${round1(num(entry.carbs))}g · F ${round1(num(entry.fat))}g</div>
      </div>
      <div class="entry-calories">${Math.round(num(entry.calories))}</div>
      <button class="delete-btn" data-id="${entry.id}" aria-label="Delete entry">×</button>
    `;
    list.appendChild(li);
  }

  list.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { error } = await supabase.from('entries').delete().eq('id', btn.dataset.id);
      if (error) {
        showToast(error.message, true);
        return;
      }
      refresh();
    });
  });
}

async function addEntry(entry) {
  const { error } = await supabase.from('entries').insert({
    user_id: currentSession.user.id,
    date: toDateKey(currentDate),
    source: entry.source,
    name: entry.name,
    serving_note: entry.servingNote || '',
    calories: entry.calories,
    protein: entry.protein || 0,
    carbs: entry.carbs || 0,
    fat: entry.fat || 0,
  });
  if (error) throw new Error(error.message);
  await refresh();
}

// ---------- Bottom sheet ----------
const sheetOverlay = $('sheetOverlay');
$('addFoodBtn').addEventListener('click', () => sheetOverlay.classList.remove('hidden'));
sheetOverlay.addEventListener('click', (e) => {
  if (e.target === sheetOverlay) closeSheet();
});

function closeSheet() {
  sheetOverlay.classList.add('hidden');
  resetPhotoTab();
  resetDescribeTab();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add('active');
  });
});

// ---------- Search DB ----------
$('searchInput').addEventListener('input', () => {
  const q = $('searchInput').value.trim().toLowerCase();
  const results = q ? FOOD_DB.filter((f) => f.name.toLowerCase().includes(q)) : FOOD_DB;
  renderSearchResults(results.slice(0, 30));
});

function renderSearchResults(results) {
  const list = $('searchResults');
  list.innerHTML = '';
  for (const food of results) {
    const li = document.createElement('li');
    li.className = 'search-result-item';
    li.innerHTML = `
      <div>
        <div class="result-name">${escapeHtml(food.name)}</div>
        <div class="result-serving">${escapeHtml(food.serving)}</div>
      </div>
      <div class="result-cal">${food.calories} kcal</div>
    `;
    li.addEventListener('click', async () => {
      try {
        await addEntry({
          source: 'db',
          name: food.name,
          servingNote: food.serving,
          calories: food.calories,
          protein: food.protein,
          carbs: food.carbs,
          fat: food.fat,
        });
        closeSheet();
        showToast('Added to log');
      } catch (err) {
        showToast(err.message, true);
      }
    });
    list.appendChild(li);
  }
}
renderSearchResults(FOOD_DB.slice(0, 30));

// ---------- Photo ----------
const dropZone = $('dropZone');
const photoInput = $('photoInput');
const photoPreview = $('photoPreview');
const photoLoading = $('photoLoading');
const photoConfirm = $('photoConfirm');

dropZone.addEventListener('click', () => photoInput.click());
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) handlePhotoFile(file);
});
photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (file) handlePhotoFile(file);
});

function resetPhotoTab() {
  photoPreview.classList.add('hidden');
  photoLoading.classList.add('hidden');
  photoConfirm.classList.add('hidden');
  photoConfirm.innerHTML = '';
  photoInput.value = '';
  dropZone.classList.remove('hidden');
}

const PHOTO_MAX_DIMENSION = 1280;
const PHOTO_JPEG_QUALITY = 0.85;

// Camera photos can be huge (multi-megapixel, several MB) or in formats the
// vision model rejects outright. Re-encoding through a canvas to a capped,
// plain JPEG sidesteps both problems regardless of what the phone captured.
function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = () => resolve({ img, objectUrl });
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read this image — try a JPEG or PNG photo.'));
    };
    img.src = objectUrl;
  });
}

async function resizeToJpegDataUrl(file) {
  const { img, objectUrl } = await loadImageElement(file);
  const scale = Math.min(1, PHOTO_MAX_DIMENSION / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(objectUrl);
  return canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
}

async function handlePhotoFile(file) {
  dropZone.classList.add('hidden');
  photoConfirm.classList.add('hidden');
  photoPreview.classList.add('hidden');
  photoLoading.classList.remove('hidden');

  try {
    const dataUrl = await resizeToJpegDataUrl(file);
    photoPreview.src = dataUrl;
    photoPreview.classList.remove('hidden');

    const base64 = dataUrl.split(',')[1];
    const result = await api('/api/estimate-photo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBase64: base64, mediaType: 'image/jpeg' }),
    });
    photoLoading.classList.add('hidden');
    renderConfirmCard(photoConfirm, result, 'photo');
  } catch (err) {
    photoLoading.classList.add('hidden');
    showToast(err.message, true);
    resetPhotoTab();
  }
}
const describeForm = $('describeForm');
const fullMealForm = $('fullMealForm');
const modeFullMealBtn = $('modeFullMealBtn');
const modeSingleBtn = $('modeSingleBtn');
const textLoading = $('textLoading');
const textConfirm = $('textConfirm');

let currentDescribeMode = 'full';

if (modeFullMealBtn && modeSingleBtn) {
  modeFullMealBtn.addEventListener('click', () => {
    currentDescribeMode = 'full';
    modeFullMealBtn.classList.add('active');
    modeSingleBtn.classList.remove('active');
    if (fullMealForm) fullMealForm.classList.remove('hidden');
    if (describeForm) describeForm.classList.add('hidden');
  });

  modeSingleBtn.addEventListener('click', () => {
    currentDescribeMode = 'single';
    modeSingleBtn.classList.add('active');
    modeFullMealBtn.classList.remove('active');
    if (describeForm) describeForm.classList.remove('hidden');
    if (fullMealForm) fullMealForm.classList.add('hidden');
  });
}

$('mainIngredient').addEventListener('change', () => {
  const isOther = $('mainIngredient').value === 'Other';
  $('mainIngredientOtherWrap').classList.toggle('hidden', !isOther);
});

function buildDescription() {
  const parts = [];

  const foodType = $('foodType').value;
  if (foodType) parts.push(`Food type: ${foodType}.`);

  let mainIngredient = $('mainIngredient').value;
  if (mainIngredient === 'Other') {
    mainIngredient = $('mainIngredientOther').value.trim() || 'unspecified';
  }
  const rawQty = $('rawQty').value;
  const rawQtyUnit = $('rawQtyUnit').value;
  if (mainIngredient) {
    let line = `Main ingredient: ${mainIngredient}`;
    if (rawQty) line += `, raw quantity / serving: ${rawQty} ${rawQtyUnit}`;
    parts.push(`${line}.`);
  }

  const oilQty = $('oilQty').value;
  const oilQtyUnit = $('oilQtyUnit').value;
  if (oilQty) parts.push(`Oil/ghee added: ${oilQty} ${oilQtyUnit}.`);

  const otherIngredients = $('otherIngredients').value.trim();
  if (otherIngredients) parts.push(`Other ingredients: ${otherIngredients}.`);

  const additionalInfo = $('additionalInfo').value.trim();
  if (additionalInfo) parts.push(`Additional info: ${additionalInfo}`);

  return parts.join(' ');
}

// Handler for Full Meal Freeform Form
if (fullMealForm) {
  fullMealForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const mealInput = $('fullMealInput').value.trim();
    if (!mealInput) {
      showToast('Please enter a description for your meal', true);
      return;
    }
    const notes = $('fullMealNotes').value.trim();
    let description = mealInput;
    if (notes) description += `. Additional notes: ${notes}`;

    fullMealForm.classList.add('hidden');
    textConfirm.classList.add('hidden');
    textLoading.classList.remove('hidden');
    try {
      const result = await api('/api/estimate-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      textLoading.classList.add('hidden');
      renderConfirmCard(textConfirm, result, 'text', () => {
        textConfirm.classList.add('hidden');
        if (currentDescribeMode === 'full' && fullMealForm) {
          fullMealForm.classList.remove('hidden');
        } else if (describeForm) {
          describeForm.classList.remove('hidden');
        }
      });
    } catch (err) {
      textLoading.classList.add('hidden');
      if (fullMealForm) fullMealForm.classList.remove('hidden');
      showToast(err.message, true);
    }
  });
}

// Handler for Single Dish Form
describeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const mainIngredient = $('mainIngredient').value;
  const rawQty = $('rawQty').value;
  if (!mainIngredient || !rawQty) {
    showToast('Please select a main ingredient and its quantity', true);
    return;
  }
  const description = buildDescription();

  describeForm.classList.add('hidden');
  textConfirm.classList.add('hidden');
  textLoading.classList.remove('hidden');
  try {
    const result = await api('/api/estimate-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });
    textLoading.classList.add('hidden');
    renderConfirmCard(textConfirm, result, 'text', () => {
      textConfirm.classList.add('hidden');
      describeForm.classList.remove('hidden');
    });
  } catch (err) {
    textLoading.classList.add('hidden');
    describeForm.classList.remove('hidden');
    showToast(err.message, true);
  }
});

function resetDescribeTab() {
  describeForm.reset();
  if (fullMealForm) fullMealForm.reset();
  $('mainIngredientOtherWrap').classList.add('hidden');
  if (currentDescribeMode === 'full' && fullMealForm) {
    fullMealForm.classList.remove('hidden');
    describeForm.classList.add('hidden');
  } else {
    describeForm.classList.remove('hidden');
    if (fullMealForm) fullMealForm.classList.add('hidden');
  }
  textLoading.classList.add('hidden');
  textConfirm.classList.add('hidden');
  textConfirm.innerHTML = '';
}

// ---------- Shared confirm card ----------
function renderConfirmCard(container, estimate, source, onEdit) {
  container.classList.remove('hidden');
  container.innerHTML = `
    <label class="field-label">Name
      <input class="cf-name" type="text" value="${escapeHtml(estimate.description || '')}" />
    </label>
    <div class="macro-inputs">
      <label class="field-label">Calories
        <input class="cf-calories" type="number" value="${Math.round(estimate.calories || 0)}" />
      </label>
      <label class="field-label">Protein
        <input class="cf-protein" type="number" step="0.1" value="${estimate.protein || 0}" />
      </label>
    </div>
    <div class="macro-inputs">
      <label class="field-label">Carbs
        <input class="cf-carbs" type="number" step="0.1" value="${estimate.carbs || 0}" />
      </label>
      <label class="field-label">Fat
        <input class="cf-fat" type="number" step="0.1" value="${estimate.fat || 0}" />
      </label>
    </div>
    <span class="field-hint" style="margin-top: 4px; margin-bottom: 12px; display: block;">💡 Feel free to edit any numbers above if you have your exact package label values.</span>
    <button class="primary-btn cf-add">Add to log</button>
    ${onEdit ? '<button type="button" class="secondary-btn cf-edit">← Re-enter details</button>' : ''}
  `;
  container.querySelector('.cf-add').addEventListener('click', async () => {
    try {
      await addEntry({
        source,
        name: container.querySelector('.cf-name').value.trim() || 'Logged meal',
        servingNote: '',
        calories: parseFloat(container.querySelector('.cf-calories').value) || 0,
        protein: parseFloat(container.querySelector('.cf-protein').value) || 0,
        carbs: parseFloat(container.querySelector('.cf-carbs').value) || 0,
        fat: parseFloat(container.querySelector('.cf-fat').value) || 0,
      });
      closeSheet();
      showToast('Added to log');
    } catch (err) {
      showToast(err.message, true);
    }
  });
  if (onEdit) {
    container.querySelector('.cf-edit').addEventListener('click', onEdit);
  }
}

// ---------- Settings (calorie goal) ----------
const settingsOverlay = $('settingsOverlay');
$('settingsBtn').addEventListener('click', () => {
  $('goalInput').value = goal;
  settingsOverlay.classList.remove('hidden');
});
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});
$('goalSave').addEventListener('click', async () => {
  const newGoal = parseFloat($('goalInput').value);
  if (isNaN(newGoal) || newGoal <= 0) {
    showToast('Enter a valid goal', true);
    return;
  }
  const { error } = await supabase
    .from('profiles')
    .upsert({ user_id: currentSession.user.id, daily_goal_calories: newGoal }, { onConflict: 'user_id' });
  if (error) {
    showToast(error.message, true);
    return;
  }
  goal = newGoal;
  settingsOverlay.classList.add('hidden');
  refresh();
  showToast('Goal updated');
});

// ---------- Profile & macro targets ----------
const profileOverlay = $('profileOverlay');
const profileResults = $('profileResults');
const profileInsights = $('profileInsights');
const goalRateWrap = $('goalRateWrap');

async function loadProfileAndTargets() {
  const { data, error } = await supabase.from('profiles').select('*').eq('user_id', currentSession.user.id).maybeSingle();
  if (error) {
    showToast(error.message, true);
    return;
  }
  profile = data;
  macroTargets = data?.cached_targets || null;
  goal = data?.daily_goal_calories != null ? num(data.daily_goal_calories) : 2000;
}

async function openProfileModal() {
  await loadProfileAndTargets();
  if (profile) {
    $('profileWeight').value = profile.weight_kg ?? '';
    $('profileHeight').value = profile.height_cm ?? '';
    $('profileAge').value = profile.age ?? '';
    selectGender(profile.gender || 'male');
    selectActivity(profile.activity_level || 'sedentary');
    selectGoalType(profile.goal_type || 'maintain');
    if (profile.goal_rate_kg_per_week) $('goalRate').value = String(num(profile.goal_rate_kg_per_week));
    $('goalDescription').value = profile.goal_description || '';
  }
  if (macroTargets) {
    renderProfileResults(macroTargets);
    renderInsights(macroTargets.insights);
  } else {
    profileResults.classList.add('hidden');
    profileInsights.classList.add('hidden');
  }
  profileOverlay.classList.remove('hidden');
}

$('profileBtn').addEventListener('click', openProfileModal);

const settingsEditProfileBtn = $('settingsEditProfileBtn');
if (settingsEditProfileBtn) {
  settingsEditProfileBtn.addEventListener('click', () => {
    $('settingsOverlay').classList.add('hidden');
    openProfileModal();
  });
}

profileOverlay.addEventListener('click', (e) => {
  if (e.target === profileOverlay) profileOverlay.classList.add('hidden');
});

function selectGender(value) {
  selectedGender = value;
  document.querySelectorAll('#genderSegmented .segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function selectActivity(value) {
  selectedActivity = value;
  document.querySelectorAll('#activitySegmented .segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
}

function selectGoalType(value) {
  selectedGoalType = value;
  document.querySelectorAll('#goalTypeSegmented .segmented-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.value === value);
  });
  goalRateWrap.classList.toggle('hidden', value === 'maintain');
}

document.querySelectorAll('#genderSegmented .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => selectGender(btn.dataset.value));
});
document.querySelectorAll('#activitySegmented .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => selectActivity(btn.dataset.value));
});
document.querySelectorAll('#goalTypeSegmented .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => selectGoalType(btn.dataset.value));
});

function renderProfileResults(targets) {
  profileResults.classList.remove('hidden');
  const deltaLabel =
    targets.calorie_delta > 0
      ? `${targets.calorie_delta} kcal deficit`
      : targets.calorie_delta < 0
      ? `${-targets.calorie_delta} kcal surplus`
      : 'at maintenance';
  const coachBadge = targets.coach_generated
    ? `<div class="coach-badge">🏆 Coach-tailored plan${targets.goal_description ? ` for "${escapeHtml(targets.goal_description)}"` : ''}</div>`
    : '';
  profileResults.innerHTML = `
    ${coachBadge}
    <div class="profile-results-grid">
      <div class="profile-result-item">
        <div class="profile-result-label">BMR</div>
        <div class="profile-result-value">${targets.bmr} kcal</div>
      </div>
      <div class="profile-result-item">
        <div class="profile-result-label">Maintenance (TDEE)</div>
        <div class="profile-result-value">${targets.tdee} kcal</div>
      </div>
      <div class="profile-result-item profile-result-highlight">
        <div class="profile-result-label">Daily goal</div>
        <div class="profile-result-value">${targets.goal_calories} kcal</div>
        <div class="profile-result-sub">${deltaLabel}${targets.floor_applied ? ' · capped at a safe minimum' : ''}</div>
      </div>
      <div class="profile-result-item">
        <div class="profile-result-label">Fiber (min)</div>
        <div class="profile-result-value">${targets.fiber.min_g} g</div>
      </div>
      <div class="profile-result-item">
        <div class="profile-result-label">Protein</div>
        <div class="profile-result-value">${round1(targets.protein.min_g)}–${round1(targets.protein.max_g)} g</div>
        <div class="profile-result-sub">${targets.protein.min_kcal}–${targets.protein.max_kcal} kcal</div>
      </div>
      <div class="profile-result-item">
        <div class="profile-result-label">Fat</div>
        <div class="profile-result-value">${round1(targets.fat.min_g)}–${round1(targets.fat.max_g)} g</div>
        <div class="profile-result-sub">${targets.fat.min_kcal}–${targets.fat.max_kcal} kcal</div>
      </div>
      <div class="profile-result-item">
        <div class="profile-result-label">Carbs</div>
        <div class="profile-result-value">${round1(targets.carbs.min_g)}–${round1(targets.carbs.max_g)} g</div>
        <div class="profile-result-sub">${targets.carbs.min_kcal}–${targets.carbs.max_kcal} kcal</div>
      </div>
    </div>
  `;
}

function renderInsights(insightsText) {
  if (!insightsText) {
    profileInsights.classList.add('hidden');
    profileInsights.innerHTML = '';
    return;
  }
  profileInsights.classList.remove('hidden');
  profileInsights.innerHTML = `
    <div class="insights-label">Insights</div>
    <p class="insights-text">${escapeHtml(insightsText)}</p>
  `;
}

$('profileSave').addEventListener('click', async () => {
  const weight_kg = parseFloat($('profileWeight').value);
  const height_cm = parseFloat($('profileHeight').value);
  const age = parseFloat($('profileAge').value);
  const goal_rate_kg_per_week = parseFloat($('goalRate').value);

  $('profileSave').disabled = true;
  $('profileSave').textContent = 'Calculating…';
  try {
    const saved = await apiAuthed('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        weight_kg,
        height_cm,
        age,
        gender: selectedGender,
        activity_level: selectedActivity,
        goal_type: selectedGoalType,
        goal_rate_kg_per_week: selectedGoalType === 'maintain' ? 0 : goal_rate_kg_per_week,
        goal_description: $('goalDescription').value.trim(),
      }),
    });
    profile = saved.profile;
    macroTargets = saved.targets;
    goal = saved.targets.goal_calories;
    renderProfileResults(saved.targets);
    renderInsights(saved.targets.insights);
    showToast('Profile saved — daily goal updated to match your target');
    refresh();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    $('profileSave').disabled = false;
    $('profileSave').textContent = 'Save & calculate';
  }
});

// ---------- PWA & Mobile Installation ----------
let deferredInstallPrompt = null;
const DISMISS_KEY = 'dabba_pwa_dismissed';
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours dismissal memory

function isStandaloneApp() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true ||
    document.referrer.includes('android-app://')
  );
}

function isMobileDevice() {
  return (
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    (window.innerWidth <= 768 && ('ontouchstart' in window || navigator.maxTouchPoints > 0))
  );
}

function isIOSDevice() {
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

function wasDismissedRecently() {
  const dismissedAt = localStorage.getItem(DISMISS_KEY);
  if (!dismissedAt) return false;
  return Date.now() - Number(dismissedAt) < DISMISS_DURATION_MS;
}

function dismissPWAInstallBanner() {
  const banner = $('pwaInstallBanner');
  if (banner) {
    banner.classList.add('hidden');
  }
  localStorage.setItem(DISMISS_KEY, Date.now());
}

function showPWAInstallBanner() {
  // CRITICAL: If already running inside the installed app, DO NOT show notification
  if (isStandaloneApp()) {
    return;
  }

  // Show notification pop-up only on mobile when not recently dismissed
  if (isMobileDevice() && !wasDismissedRecently()) {
    const banner = $('pwaInstallBanner');
    if (banner) {
      setTimeout(() => banner.classList.remove('hidden'), 1200);
    }
  }
}

function triggerPWAInstall() {
  if (isIOSDevice()) {
    const iosOverlay = $('iosInstallOverlay');
    if (iosOverlay) iosOverlay.classList.remove('hidden');
    dismissPWAInstallBanner();
    return;
  }

  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    deferredInstallPrompt.userChoice.then((choiceResult) => {
      if (choiceResult.outcome === 'accepted') {
        showToast('Thank you for installing Dabba!');
        dismissPWAInstallBanner();
      }
      deferredInstallPrompt = null;
      updateInstallStatusUI();
    });
  } else {
    showToast('To install: open your browser menu and tap "Add to Home screen" or "Install App".');
  }
}

function updateInstallStatusUI() {
  const statusText = $('pwaStatusText');
  const settingsBtn = $('settingsInstallBtn');

  if (isStandaloneApp()) {
    if (statusText) statusText.textContent = 'Dabba is running as an installed standalone app.';
    if (settingsBtn) {
      settingsBtn.textContent = 'Installed ✓';
      settingsBtn.disabled = true;
    }
  } else if (deferredInstallPrompt || isIOSDevice()) {
    if (statusText) statusText.textContent = 'Install Dabba on your device for instant access & offline support.';
    if (settingsBtn) {
      settingsBtn.textContent = 'Install App';
      settingsBtn.disabled = false;
    }
  }
}

function initPWA() {
  // Register Service Worker
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => console.log('PWA Service Worker registered:', reg.scope))
        .catch((err) => console.warn('PWA Service Worker registration failed:', err));
    });
  }

  // Catch Chrome/Android install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallStatusUI();
    showPWAInstallBanner();
  });

  // Handle app installed event
  window.addEventListener('appinstalled', () => {
    showToast('Dabba installed successfully!');
    dismissPWAInstallBanner();
    deferredInstallPrompt = null;
    updateInstallStatusUI();
  });

  // Handle iOS Safari mobile visitor
  if (isIOSDevice() && isMobileDevice() && !isStandaloneApp()) {
    showPWAInstallBanner();
  }

  // Event Listeners for UI
  const installBtn = $('pwaInstallBtn');
  if (installBtn) installBtn.addEventListener('click', triggerPWAInstall);

  const dismissBtn = $('pwaDismissBtn');
  if (dismissBtn) dismissBtn.addEventListener('click', dismissPWAInstallBanner);

  const closeIconBtn = $('pwaCloseIconBtn');
  if (closeIconBtn) closeIconBtn.addEventListener('click', dismissPWAInstallBanner);

  const settingsInstallBtn = $('settingsInstallBtn');
  if (settingsInstallBtn) settingsInstallBtn.addEventListener('click', triggerPWAInstall);

  const iosCloseBtn = $('iosModalCloseBtn');
  if (iosCloseBtn) {
    iosCloseBtn.addEventListener('click', () => {
      const iosOverlay = $('iosInstallOverlay');
      if (iosOverlay) iosOverlay.classList.add('hidden');
    });
  }

  const iosOverlay = $('iosInstallOverlay');
  if (iosOverlay) {
    iosOverlay.addEventListener('click', (e) => {
      if (e.target === iosOverlay) iosOverlay.classList.add('hidden');
    });
  }

  updateInstallStatusUI();
}

// ---------- Init ----------
async function main() {
  initPWA();
  const config = await api('/api/config');
  if (config.version && $('appVersionText')) {
    $('appVersionText').textContent = config.version;
  }
  if (config.lastPushed && $('appLastPushedText')) {
    $('appLastPushedText').textContent = `Pushed: ${config.lastPushed}`;
  }
  supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
  setAuthMode('signin');
  await initAuth();
}

main().catch((err) => showAuthMessage(err.message, true));
