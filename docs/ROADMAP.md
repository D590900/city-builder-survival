# Roadmap

Last Refuge is an endless game — survive as long as you can. This is the
short list of what we'd like to improve next, in no strict order and with no
dates. Suggestions are welcome via
[issues](https://github.com/D590900/city-builder-survival/issues).

## Gameplay

- **Endless-mode balancing.** Tune the long game: horde growth past
  night 12, late-game resource pacing, upgrade costs and the reputation
  curve, so that runs stay tense instead of hitting a wall (or a plateau).

## Readability & UI

- **Night-time brightness/readability.** The night scene is too dark:
  zombies and damaged buildings are hard to read exactly when it matters
  most. Improve lighting/contrast without losing the night mood.
- **Compact HUD mode.** A denser HUD layout for small screens and narrow
  windows (smaller top bar, collapsible panels).

## Internationalization

- **Optional i18n.** The UI is English-only with strings hardcoded in the
  `src/ui/` modules. Extract the strings into a message table and make the
  language selectable, keeping English as the default.

## Audio

- **More audio.** All sound is synthesized via WebAudio (no external files);
  extend it with more effects and ambient variation — weather, dawn stingers,
  UI feedback.

## Docs & presentation

- **Gameplay GIF in the README.** A short (15–25 s) capture of a day/night
  cycle — building by day, defending by night — to show the game better than
  the static screenshots.
