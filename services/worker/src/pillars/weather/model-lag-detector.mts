// GFS and ECMWF models update every 6 hours: 00:00, 06:00, 12:00, 18:00 UTC.
// Data typically available ~30 min after run start.
// If market prices haven't reacted to the latest model run, there's a lag → edge.

const MODEL_RUN_HOURS = [0, 6, 12, 18];
const MODEL_PROCESSING_DELAY_MIN = 30;

export interface ModelLagResult {
  lastModelRun: Date;
  modelAge: number;          // minutes since last model data available
  hasLag: boolean;           // true if lag > 15 min detected
  lagMinutes: number;
  nearBoundary: boolean;     // true if within 15 min of next model run
}

/**
 * Get the most recent model run time (when data became available).
 */
export function getLastModelRun(now: Date = new Date()): Date {
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();

  // Find the most recent run where data is already available
  // (run_hour + 30 min processing)
  let lastRunHour = -1;
  for (const h of MODEL_RUN_HOURS) {
    const availableAtMin = h * 60 + MODEL_PROCESSING_DELAY_MIN;
    const currentMin = utcHour * 60 + utcMin;
    if (availableAtMin <= currentMin) {
      lastRunHour = h;
    }
  }

  const result = new Date(now);

  if (lastRunHour === -1) {
    // Before 00:30 UTC → use yesterday's 18:00 run
    result.setUTCDate(result.getUTCDate() - 1);
    lastRunHour = 18;
  }

  result.setUTCHours(lastRunHour, MODEL_PROCESSING_DELAY_MIN, 0, 0);
  return result;
}

/**
 * Get the next model run time (when next data will be available).
 */
export function getNextModelRun(now: Date = new Date()): Date {
  const lastRun = getLastModelRun(now);
  const lastRunHour = lastRun.getUTCHours();
  const idx = MODEL_RUN_HOURS.indexOf(lastRunHour);
  const nextIdx = (idx + 1) % MODEL_RUN_HOURS.length;

  const result = new Date(lastRun);
  if (nextIdx === 0) {
    // Wrap to next day
    result.setUTCDate(result.getUTCDate() + 1);
  }
  result.setUTCHours(MODEL_RUN_HOURS[nextIdx], MODEL_PROCESSING_DELAY_MIN, 0, 0);
  return result;
}

/**
 * Detect model lag: time since latest model data became available.
 */
export function detectModelLag(now: Date = new Date()): ModelLagResult {
  const lastRun = getLastModelRun(now);
  const nextRun = getNextModelRun(now);

  const modelAgeMs = now.getTime() - lastRun.getTime();
  const modelAge = Math.round(modelAgeMs / 60000);

  const timeToNextMs = nextRun.getTime() - now.getTime();
  const timeToNext = Math.round(timeToNextMs / 60000);

  // Near boundary: within 15 min of next model run → don't trade
  const nearBoundary = timeToNext < 15;

  // Lag: model data is available for > 15 min but market may not have reacted
  // Best trading window: 15–120 min after model update
  const hasLag = modelAge >= 15 && modelAge <= 120;

  return {
    lastModelRun: lastRun,
    modelAge,
    hasLag,
    lagMinutes: modelAge,
    nearBoundary,
  };
}

/**
 * Check if current time is in the optimal trading window.
 * Best: 15-45 min after model update (market hasn't fully reacted).
 */
export function isOptimalWindow(now: Date = new Date()): boolean {
  const { modelAge, nearBoundary } = detectModelLag(now);
  return modelAge >= 15 && modelAge <= 90 && !nearBoundary;
}
