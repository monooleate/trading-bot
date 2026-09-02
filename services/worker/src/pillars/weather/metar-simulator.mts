// METAR Fahrenheit rounding simulator.
//
// Polymarket settles weather markets using METAR data which stores
// temperature as whole Fahrenheit values. This creates a systematic
// rounding bias that the crowd often ignores.
//
// Example:
//   20.3°C → 68.54°F → 69°F (METAR rounds) → 20.6°C
//   20.1°C → 68.18°F → 68°F (METAR rounds) → 20.0°C
//
// A forecast of 20.3°C actually settles at 20.6°C on Polymarket!

/**
 * Simulate METAR rounding: °C → °F → round to integer → back to °C.
 * Returns the temperature as Polymarket would settle it.
 */
export function simulateMetarRounding(tempCelsius: number): number {
  const fahrenheit = tempCelsius * 9 / 5 + 32;
  const roundedF = Math.round(fahrenheit);
  const backToCelsius = (roundedF - 32) * 5 / 9;
  return Math.round(backToCelsius * 10) / 10; // 1 decimal place
}

/**
 * Get the METAR Fahrenheit integer for a given Celsius temperature.
 */
export function celsiusToMetarF(tempCelsius: number): number {
  return Math.round(tempCelsius * 9 / 5 + 32);
}

/**
 * Get the rounding bias: how much the METAR rounding shifts the value.
 * Positive = METAR rounds up, negative = rounds down.
 */
export function metarRoundingBias(tempCelsius: number): number {
  const simulated = simulateMetarRounding(tempCelsius);
  return Math.round((simulated - tempCelsius) * 10) / 10;
}

/**
 * Apply station offset and METAR rounding to a forecast temperature.
 * This is the full correction pipeline:
 *   1. Apply city→station offset
 *   2. Simulate METAR rounding
 */
export function correctForecast(
  forecastCelsius: number,
  cityOffset: number,
): number {
  const stationTemp = forecastCelsius + cityOffset;
  return simulateMetarRounding(stationTemp);
}
