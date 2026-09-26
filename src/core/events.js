/** Minimal pub/sub. Gameplay emits, HUD and audio listen. No three.js dependency. */
export class EventBus {
  constructor() { this.handlers = new Map() }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type).add(fn)
    return () => this.off(type, fn)
  }

  off(type, fn) { this.handlers.get(type)?.delete(fn) }

  emit(type, payload) {
    const set = this.handlers.get(type)
    if (!set) return
    for (const fn of set) {
      try { fn(payload) } catch (err) { console.error(`[bus] ${type} handler threw`, err) }
    }
  }

  clear() { this.handlers.clear() }
}

export const bus = new EventBus()

export const EV = {
  WAVE_START: 'wave:start',
  WAVE_CLEAR: 'wave:clear',
  BOSS_INCOMING: 'wave:boss',
  COUNTDOWN: 'wave:countdown',
  ZOMBIE_SPAWN: 'zombie:spawn',
  ZOMBIE_HIT: 'zombie:hit',
  ZOMBIE_DEATH: 'zombie:death',
  PLAYER_HIT: 'player:hit',
  PLAYER_DEATH: 'player:death',
  PLAYER_HEAL: 'player:heal',
  LOW_HEALTH: 'player:lowhealth',
  WEAPON_FIRE: 'weapon:fire',
  WEAPON_DRY: 'weapon:dry',
  WEAPON_RELOAD: 'weapon:reload',
  WEAPON_SWITCH: 'weapon:switch',
  PICKUP: 'pickup:taken',
  MOD_GAINED: 'pickup:mod',
  TRAIN_INBOUND: 'train:inbound',
  TRAIN_DOORS: 'train:doors',
  EXPLOSION: 'fx:explosion',
  STATE_CHANGE: 'game:state',
  SCORE: 'game:score',
  COMBAT_CALLOUT: 'audio:combat-callout',
}
