// Nightly zombie wave scaling and spawn scheduling. Pure logic, no I/O.

// Endless mode: stats grow linearly up to night 12, then the growth is
// dampened with a square root (defensive DPS per tower is fixed, so a
// linear count×hp would outscale any defense; with √ the wave's total hp
// keeps growing roughly linearly and the run stays playable).
export function waveForNight(n) {
  const over = n - 12;
  return {
    count: over <= 0 ? 3 + n * 2 : 27 + Math.round(8 * Math.sqrt(over)),
    hp: over <= 0 ? 20 + n * 6 : 92 + Math.round(10 * Math.sqrt(over)),
    damage: over <= 0 ? 3 + n : 15 + Math.round(3 * Math.sqrt(over)),
    speed: 1.5, // tiles per second
    spawnInterval: Math.max(0.4, 2 - 0.15 * n), // seconds between spawns
  };
}

// Splits the wave of night n into spawn batches spread over nightLength
// seconds. Batches get denser toward the middle/end of the night.
// The returned counts always sum to waveForNight(n).count.
export function spawnPlan(n, nightLength) {
  const { count } = waveForNight(n);
  const fractions = [0.15, 0.4, 0.65, 0.9]; // of nightLength
  const weights = [1, 2, 3, 4];
  const totalWeight = weights.reduce((a, w) => a + w, 0);

  const counts = weights.map((w) => Math.floor((count * w) / totalWeight));
  let remainder = count - counts.reduce((a, c) => a + c, 0);
  // Leftover zombies go to the latest batches, keeping the end denser.
  for (let i = counts.length - 1; i >= 0 && remainder > 0; i--, remainder--) {
    counts[i]++;
  }

  const plan = [];
  for (let i = 0; i < fractions.length; i++) {
    if (counts[i] > 0) {
      plan.push({ t: fractions[i] * nightLength, count: counts[i] });
    }
  }
  return plan;
}
