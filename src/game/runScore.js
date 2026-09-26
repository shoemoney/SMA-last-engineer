export function runScore(completedWaves, combatSeconds) {
  return completedWaves * 10000 + Math.min(9999,
    Math.floor(completedWaves * 6000 / Math.max(1, combatSeconds)))
}
