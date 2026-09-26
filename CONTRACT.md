# Last Engineer run and score contract

This document describes the browser game and its same-origin arcade API. The arcade server and SQLite database live outside this repository.

## Run lifecycle

| Phase | Behavior |
| :--- | :--- |
| Start screen | Animated hero, Jeremy voice preference, and current top ten; viewing the board does not create a run token |
| Preparation | Starts after pointer capture succeeds; 30 active real-time seconds before wave one |
| Train arrival | The train arrives before enemies spawn |
| Combat | Spawning and fighting advance combat simulation time |
| Wave break | 10 active real-time seconds after a completed wave |
| Paused | Gameplay clocks stop; pointer and focus loss pause the run |
| Results | Final metrics freeze once; the server checks top-ten eligibility before showing a name field |

**E** skips preparation or a wave break while the pointer is captured. **Start Wave** provides the same action in the control panel. Both actions start one wave at most. **Escape** pauses. **Resume** captures the pointer before continuing. Failed pointer capture leaves the game paused.

**[** and **]**, or the slower and faster buttons, select 0.5×, 1×, 1.5×, or 2× simulation speed. These controls do not rewind. A fresh run restores 1× speed.

## Clocks and scoring

`completedWaves` counts cleared waves. `wave` is the highest wave started. The two values are not interchangeable.

`duration` counts active real-time run seconds, including preparation and wave breaks but excluding pauses. `combatSeconds` counts simulation seconds in spawning and fighting phases. It excludes preparation, train arrival, wave breaks, and pauses. At 2× speed, combat time can exceed real duration.

Version 2 uses this formula in both the game and API:

```js
const seconds = Math.round(combatSeconds * 1000) / 1000
const bonus = Math.min(9999, Math.floor(completedWaves * 6000 / Math.max(1, seconds)))
const score = completedWaves * 10000 + bonus
```

A completed wave always outranks an additional speed bonus. Millisecond normalization prevents different simulation step sizes from changing the score through floating-point drift. Hit zones, kills, and kill chains still drive combat feedback, but do not add to the version 2 leaderboard formula.

The local terminal summary calls the version field `scoringVersion`. The HTTP payload calls it `scoreVersion`. The score client translates that boundary.

## Version 2 API

All paths below start with `/api/games/last-engineer`. POST requests use JSON and the allowed same-origin `Origin` header.

| Request | Contract |
| :--- | :--- |
| `POST /runs` | `{scoreVersion:2}` returns `{runToken,scoreVersion:2,expiresAt}` |
| `POST /qualify` | `{runToken,scoreVersion:2,wave,kills,headshots,duration,completedWaves,combatSeconds}` freezes the metrics and computes the score |
| Qualification response | `{scoreVersion:2,score,qualified,rank,limit,reason,scores}` |
| `POST /scores` | `{runToken,scoreVersion:2,name}` uses the frozen metrics and rechecks the cutoff |
| Accepted result | `{accepted:true,replayed,rank,scoreVersion:2,score}` |
| Displaced result | `{accepted:false,qualified:false,reason:"board_changed",scoreVersion:2,rank,scores}` |
| `GET /scores` | `{scores,scoreVersion:2,order:"highest"}` |
| `GET /scores?scoreVersion=1` | Preserved legacy results, separate from version 2 |

A public score contains `id`, `name`, `score`, `scoreVersion`, `completedWaves`, `combatSeconds`, and `createdAt`. Legacy rows can have null combat metrics.

Qualification requires at least one completed wave and a rank within the first ten. The board orders by score descending, then creation time ascending, then ID ascending. A new tied score ranks behind existing equal scores. SQLite retains accepted historical rows; each board query returns its highest ten.

Names contain 1–24 printable Unicode characters after NFKC normalization, trimming, and repeated-space collapse. The client does not request a name while qualification is pending or has failed. Failed checks offer a retry. If the board changes before submission, the server can reject the formerly qualifying result without storing a score.

Run tokens expire after 24 hours. Repeated qualification must use identical metrics. Repeated submission must use the same canonical name and token. A lost response can be retried without creating a duplicate row. An accepted submission can still be replayed after token expiry. Expired unsubmitted or conflicting runs require a new run.

The server validates metrics and computes points, but gameplay metrics remain client-reported. This protocol is not authoritative gameplay anti-cheat.

## Combat and pickups

Solid station geometry blocks melee and bile projectiles. Bile sweeps against world bounds and pawn capsules, resolves the earliest contact, and ignores its shooter. Other enemies remain valid projectile targets. Ranged enemies reposition when cover blocks their sightline.

Impact numbers show immediate health removed after armor and health limits. Incendiary damage continues over time and is not promised in the initial number.

Each wave has at most one health heart and one armor chestplate on distinct vacant pickup points. Uncollected supplies are replaced at the next wave; consumed supplies do not respawn on a timer. Preparation supplies belong to wave one. Reward placement reserves room for both supplies and retires old rewards instead of stacking pickups on an occupied point.
