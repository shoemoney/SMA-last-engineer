# Last Engineer public audio credits

This public source package differs from the deployed arcade audio pack. No downloaded YouTube samples or third-party announcer derivatives are included here.

## Original public effects

Pistol, rifle, shotgun, bullet casing, and headshot impact MP3s are original deterministic procedural synthesis. No third-party samples were used. Original source and sounds are MIT licensed. The reproducible generator is `tools/generate-public-sfx.py` (Python, numpy, scipy, ffmpeg).

## Voice

Narration, hurt reactions, and all six award announcements are generated using Jeremy Schoemaker's JeremySay voice. The public award clips say HEADSHOT, RAMPAGE, KILLSTREAK, BLOODBATH, MASSACRE, and TERMINUS. Voice and likeness are separate from the MIT source license; see NOTICE.

## Retained effects

Older ambience and zombie effects retain the source licenses below. These descriptions are historical sourcing records; weapon entries below do not describe the procedural public replacements above.

## Historical source inventory

The following tables describe the previous Unreal import and retained older effects. The three
weapon rows are superseded in the browser build by the current MP3 entries above.

## Weapons/

| File | Source file | Source URL | License | Author |
|---|---|---|---|---|
| `pistol_shot.wav` | Walther PPQ `X_39P.wav` (near distance, trimmed to single shot) | https://opengameart.org/content/the-free-firearm-sound-library | CC0 (Public Domain) | Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney (The Free Firearm Sound Library) |
| `rifle_shot.wav` | AR-15 `D_32P.wav` (near distance, trimmed to single shot) | https://opengameart.org/content/the-free-firearm-sound-library | CC0 (Public Domain) | Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney |
| `shotgun_blast.wav` | Benelli Nova pump shotgun `O_21P.wav` (near distance, trimmed to single shot) | https://opengameart.org/content/the-free-firearm-sound-library | CC0 (Public Domain) | Ben Jaszczak, Brian Nelson, Kevin Heras, Matthew Nanney |
| `magazine_reload.wav` | "Handgun movement" (mixkit id 1668) | https://mixkit.co/free-sound-effects/gun/ | Mixkit Free License (mixkit.co/license/#sfxFree) — free, no attribution required | Mixkit |
| `empty_chamber_click.wav` | "Handgun click" (mixkit id 1660) | https://mixkit.co/free-sound-effects/gun/ | Mixkit Free License | Mixkit |
| `explosion.wav` | "Explosion hit" (mixkit id 1704) | https://mixkit.co/free-sound-effects/explosion/ | Mixkit Free License | Mixkit |

Direct download archive kept in `Weapons/_source/Prepared_SFX_Library.7z`
(from https://opengameart.org/sites/default/files/Prepared%20SFX%20Library.7z, CC0), plus
`Prepared Master Sheet.csv` describing every gun/take in the library for future re-use.

**Gap — not sourced:** pistol shot (suppressed/silenced). No license-clean, curl-able,
no-login source was found. Pixabay is Cloudflare-gated (403 to unattended curl) and
Freesound.org requires an account/API key to download. Do not fake this one — flag it for a
manual pull or a session with browser automation.

## Zombies/

| File | Source file | Source URL | License | Author |
|---|---|---|---|---|
| `zombie_growl_1.wav` | "Zombie monster growl" (mixkit id 1973) | https://mixkit.co/free-sound-effects/monster/ | Mixkit Free License | Mixkit |
| `zombie_growl_2.wav` | "Wild creature growl" (mixkit id 1957) | https://mixkit.co/free-sound-effects/monster/ | Mixkit Free License | Mixkit |
| `zombie_growl_3.wav` | "Monster calm growl" (mixkit id 1956) | https://mixkit.co/free-sound-effects/monster/ | Mixkit Free License | Mixkit |
| `zombie_scream.wav` | "Monsters scream" (mixkit id 1958) | https://mixkit.co/free-sound-effects/monster/ | Mixkit Free License | Mixkit |
| `zombie_death_1.wav` | "Monster dying in pain" (mixkit id 1960) | https://mixkit.co/free-sound-effects/monster/ | Mixkit Free License | Mixkit |
| `zombie_death_2.wav` | "Exclamation of pain from a zombie" (mixkit id 2207) | https://mixkit.co/free-sound-effects/hurt/ | Mixkit Free License | Mixkit |
| `zombie_attack_swipe.wav` | "Sword slash swoosh" (mixkit id 1476) — generic melee whoosh, repurposed as a zombie claw-swipe cue, not a zombie-specific recording | https://mixkit.co/free-sound-effects/swoosh/ | Mixkit Free License | Mixkit |

## Ambience/

| File | Source file | Source URL | License | Author |
|---|---|---|---|---|
| `train_arriving.wav` | "Train arrival at station" (mixkit id 1629) | https://mixkit.co/free-sound-effects/train/ | Mixkit Free License | Mixkit |
| `train_doors_open.wav` | "Train door open" (mixkit id 1637) | https://mixkit.co/free-sound-effects/train/ | Mixkit Free License | Mixkit |
| `alarm_siren.wav` | "City alert siren loop" (mixkit id 1008) | https://mixkit.co/free-sound-effects/alarm/ | Mixkit Free License | Mixkit |
| `station_ambience_loop.wav` | "Walking crowd at subway station loop" (mixkit id 358) | https://mixkit.co/free-sound-effects/public-places/ | Mixkit Free License | Mixkit |

**Gap — not sourced:** train brake squeal. Mixkit has no brake/screech category with a real
match (searched `brake`, `screech`, `car`, `truck` — nothing usable). Pixabay returned HTTP 403
(Cloudflare "Just a moment" bot check) to unattended curl. Freesound.org hits require login/API
key. Left out rather than mislabeling something else as a brake squeal.

## License notes

- **CC0 (OpenGameArt "The Free Firearm Sound Library")**: public domain, no rights reserved, no
  attribution required. Verified the file actually downloaded from OGA's own file server
  (`opengameart.org/sites/default/files/...`), not the dead `freefirearmsfx.com`/mediafire
  links mentioned in the page's own comments.
- **Mixkit Free License**: royalty-free, no attribution required, free for personal and
  commercial use; the one restriction is you cannot resell/redistribute the raw sound file
  itself as a standalone stock asset. Confirmed via each asset's real download URL
  (`https://mixkit.co/free-sound-effects/download/<id>/`), which resolves to
  `https://assets.mixkit.co/active_storage/sfx/<id>/<id>.wav` (or `.mp3` for a few IDs) — this
  is the real full-quality file, not a watermarked preview.

The opening narration was regenerated with JeremySay on September 25, 2026.
Script: "One day I woke up... it was dark... and I realized... I was the last engineer."
