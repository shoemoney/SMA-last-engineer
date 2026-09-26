# ShoeMoney Arcade: Last Engineer

A lone engineer survives an overrun subway. Browser survival shooter built with Three.js, WebGPU, and a WebGL2 fallback.

[Play Last Engineer](https://arcade.shoemoney.com/last-engineer/) · [ShoeMoney Arcade](https://arcade.shoemoney.com/)

## Run locally

Use Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open the local Vite URL. WASD moves, Shift sprints, Space jumps, R reloads, number keys select weapons, and mouse aims/fires. The menu offers Mute Jeremy separately from weapons and announcer audio.

```sh
npm test
npm run build
npm run preview
```

The build uses relative asset paths and can be hosted under `/last-engineer/`. `SITE_URL` sets absolute social-preview metadata; the default is `https://arcade.shoemoney.com/last-engineer/`.

## Arcade scores

After a run, players may enter a name and submit to the shared same-origin arcade API. Standalone clones remain playable when the API is absent. Only a display name is retained locally; shared scores require the backend.

- `POST /api/games/last-engineer/runs` with `{}` issues an expiring run token.
- `POST /api/games/last-engineer/scores` accepts `{runToken,name,score,wave,kills,headshots,duration}`. Duration is seconds.
- `GET /api/games/last-engineer/scores` returns `{scores:[{id,name,score,createdAt}],order:"highest"}`.

Scores are client-reported. Tokens prevent duplicate submissions; they do not constitute anti-cheat verification. Never put database credentials in the game.

## Project layout

`src/game` owns rules and simulation. `src/world` builds the station. `src/audio` owns sound playback, `src/ui` the HUD and menus, and `src/arcade` score submission. `test` contains behavioral tests. `public` contains the game media and sharing assets.

The repository is `SMA-last-engineer`; the game slug is `last-engineer`. Future ShoeMoney Arcade games follow `SMA-{game-slug}` and `https://arcade.shoemoney.com/{game-slug}/`.

## License and media

Original source code is MIT licensed. See [LICENSE](LICENSE), [NOTICE](NOTICE), and [audio credits](public/game/audio/CREDITS.md). This public build uses original procedural combat effects and JeremySay announcer clips. Branding, likeness, voice, and third-party media are separately identified and are not relicensed wholesale as MIT. The deployed arcade may use a different audio pack. This public edition uses an independently implemented spherical-cap weapon spread sampler rather than the earlier engine-derived sampler.
