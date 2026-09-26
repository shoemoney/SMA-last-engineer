/**
 * Headless 25-wave soak. Pure simulation — no renderer, no browser — so it runs
 * in seconds and any crash is reproducible from the seed.
 */
import { runSoak } from '../src/game/soak.js'

const waves = Number(process.argv[2] ?? process.argv.find(a => /^\d+$/.test(a)) ?? 25)
const seed = Number(process.env.SEED ?? 1337)

console.log(`soaking ${waves} waves, seed ${seed}\n`)
const t0 = process.hrtime.bigint()
const report = runSoak({ waves, seed })
const ms = Number(process.hrtime.bigint() - t0) / 1e6

for (const w of report.waves) {
  console.log(
    `wave ${String(w.wave).padStart(2)} | ${String(w.spawned).padStart(3)} spawned | ` +
    `${String(w.killed).padStart(3)} killed | ${w.simSeconds.toFixed(1)}s sim` +
    (w.boss ? '  ☠ BOSS' : '')
  )
}

const bossWaves = report.waves.filter(w => w.boss).map(w => w.wave)
console.log(`\n${waves} waves in ${ms.toFixed(0)}ms`)
console.log(`bosses at: ${bossWaves.join(', ') || 'NONE'}`)
console.log(`total spawned: ${report.totalSpawned}, killed: ${report.totalKilled}`)
console.log(`errors: ${report.errors.length}`)

if (report.errors.length) {
  report.errors.slice(0, 10).forEach(e => console.error(`  ! ${e}`))
  process.exit(1)
}
if (!bossWaves.length) { console.error('no boss waves fired'); process.exit(1) }
console.log('\nSOAK PASSED')
