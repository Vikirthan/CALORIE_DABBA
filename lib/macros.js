const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

const GOAL_TYPES = ['lose', 'maintain', 'gain'];
const GENDERS = ['male', 'female'];

const KCAL_PER_KG_FAT = 7700;
const MIN_SAFE_CALORIES = { male: 1500, female: 1200 };
const MAX_GOAL_RATE_KG_PER_WEEK = 1.5;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function validateProfile({ weight_kg, height_cm, age, gender, activity_level, goal_type, goal_rate_kg_per_week }) {
  const errors = [];
  if (typeof weight_kg !== 'number' || weight_kg < 20 || weight_kg > 300) {
    errors.push('weight_kg must be a number between 20 and 300');
  }
  if (typeof height_cm !== 'number' || height_cm < 100 || height_cm > 250) {
    errors.push('height_cm must be a number between 100 and 250');
  }
  if (typeof age !== 'number' || age < 10 || age > 100) {
    errors.push('age must be a number between 10 and 100');
  }
  if (!GENDERS.includes(gender)) {
    errors.push(`gender must be one of: ${GENDERS.join(', ')}`);
  }
  if (!ACTIVITY_MULTIPLIERS[activity_level]) {
    errors.push(`activity_level must be one of: ${Object.keys(ACTIVITY_MULTIPLIERS).join(', ')}`);
  }
  if (!GOAL_TYPES.includes(goal_type)) {
    errors.push(`goal_type must be one of: ${GOAL_TYPES.join(', ')}`);
  }
  if (goal_type === 'lose' || goal_type === 'gain') {
    if (
      typeof goal_rate_kg_per_week !== 'number' ||
      goal_rate_kg_per_week <= 0 ||
      goal_rate_kg_per_week > MAX_GOAL_RATE_KG_PER_WEEK
    ) {
      errors.push(`goal_rate_kg_per_week must be a number between 0 and ${MAX_GOAL_RATE_KG_PER_WEEK} when goal_type is "${goal_type}"`);
    }
  }
  return errors;
}

// Positive delta = deficit applied (losing), negative delta = surplus applied (gaining).
function computeGoalCalories({ tdee, gender, goal_type, goal_rate_kg_per_week }) {
  let dailyDelta = 0;
  if (goal_type === 'lose') dailyDelta = -(goal_rate_kg_per_week * KCAL_PER_KG_FAT) / 7;
  else if (goal_type === 'gain') dailyDelta = (goal_rate_kg_per_week * KCAL_PER_KG_FAT) / 7;

  const requestedCalories = tdee + dailyDelta;
  const floor = MIN_SAFE_CALORIES[gender] || 1200;
  const goalCalories = Math.max(requestedCalories, floor);

  return {
    goal_calories: Math.round(goalCalories),
    floor_applied: goalCalories !== requestedCalories,
  };
}

function computeMacroTargets(profile) {
  const errors = validateProfile(profile);
  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }

  const { weight_kg, height_cm, age, gender, activity_level, goal_type, goal_rate_kg_per_week } = profile;

  const bmr =
    gender === 'male'
      ? 10 * weight_kg + 6.25 * height_cm - 5 * age + 5
      : 10 * weight_kg + 6.25 * height_cm - 5 * age - 161;

  const tdee = bmr * ACTIVITY_MULTIPLIERS[activity_level];

  const { goal_calories, floor_applied } = computeGoalCalories({
    tdee,
    gender,
    goal_type,
    goal_rate_kg_per_week: goal_rate_kg_per_week || 0,
  });

  // Calculate solid target macros (2.0g/kg protein for males, 1.8g/kg for females, 25% fat, remainder carbs)
  const protein_g = gender === 'male' ? 2.0 * weight_kg : 1.8 * weight_kg;
  const fat_g = (goal_calories * 0.25) / 9;
  const carbs_g = Math.max(0, (goal_calories - (protein_g * 4 + fat_g * 9)) / 4);

  const band = (grams) => round1(grams * 0.1); // +/-10% range band
  const fiber_min_g = gender === 'male' ? 38 : 25;

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    goal_type,
    goal_rate_kg_per_week: goal_rate_kg_per_week || 0,
    goal_calories,
    calorie_delta: Math.round(tdee - goal_calories), // positive = deficit, negative = surplus
    floor_applied,
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
    fiber: {
      min_g: fiber_min_g,
    },
  };
}

module.exports = {
  computeMacroTargets,
  validateProfile,
  ACTIVITY_MULTIPLIERS,
  GOAL_TYPES,
  MIN_SAFE_CALORIES,
  round1,
};
