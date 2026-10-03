# Designing a game on the canvas

The brief for an agent whose job is to design a game (or a game feature) and draw the design on a
canvas. Read it with `drawing_guide {"topic": "design"}`. It says **what a good design contains**.
`drawing_guide {"topic": "drawing"}` says how to draw it (palette, sizes, every `add_shapes`
option); read that too before your first `add_shapes`.

The bar is a careful design document for a small game, such as Flappy Bird done properly:
someone who has never seen the game could build it from your canvas and would not have to ask what
a number should be. `docs/canvas-examples/flap-ball.json` is that bar in miniature.

A design that is a title, a box labelled "Physics" and a box labelled "Obstacles" is not a design.
It is a list of topics. If a frame names a mechanic without a number, a rule or a picture of how
it behaves, it is not finished.

## How this fits the person's settings

The person chose a **detail level** and a **style** (Settings, Canvas; a canvas can override
both). They end every `drawing_guide` answer. They decide **how much goes in each frame and how it
looks**. This brief decides **what the design must cover**. Neither overrides the other:

- Every section below is covered at every level. `sparse` covers them briefly, with one number or
  one picture each. `dense` covers them fully, with the arithmetic and the edge cases.
- If a level asks for fewer panels than a section needs, give the section its own frame instead of
  cramming it. More frames is always allowed; an unreadable frame never is.
- Style changes the look and the wording, never the content. A `whiteboard` design has the same
  numbers as a `blueprint` one.

| Level | How each section below is done |
|---|---|
| `sparse` | One frame per section, one or two panels. Key numbers on the picture. No tables. |
| `standard` | One to three frames per section. Numbers with units, a scale, a table where a section is a list of values. |
| `dense` | A frame per subsystem and per detail. Tables, worked examples with the arithmetic, ranges, edge cases. |

## Method

1. **Read first.** `drawing_guide` (drawing and design), `design_brief`, then `list_canvases` and
   `read_canvas` or `list_diagrams` for a canvas that already has work on it. Extend what is
   there; do not start a second overview.
2. **Pin down the game in one sentence** and the one thing the player does. Put both in the
   overview frame. Everything else must serve them.
3. **Decide the numbers before drawing.** Write the tuning values into the canvas value table
   (`set_values`) and use `{{name}}` in labels, so a number that appears twice cannot drift. Check
   with `values` after.
4. **Draw one frame per section, in the order below,** each with `covers` set from the checklist
   so `coverage` shows the gaps.
5. **Look at every frame** with `view_diagram` and fix what is cramped, overlapping or wrong
   before the next one.
6. **Finish with the open questions,** then rebuild the index (`add_shapes` with `index: true`)
   and run `coverage`.

If the person gave a brief, design what they asked for and nothing else. Where they were silent,
make the decision yourself, say so in the frame (`assumed:`), and list it in the open questions.
Never leave a number out because you were not told it.

## What the design contains

Each heading is a frame, or a group of frames, on the canvas. The `covers` value to use is in
brackets.

### 1. Overview (`overview`)

One screen. The one-sentence pitch, the core verb (what the player does, in one word), the camera
and the playfield drawn to scale, the win or lose condition, the target session length and the
platform. Draw the playfield with the player, the main hazard and the goal in their real
proportions. Link to the frames below.

### 2. Controls and input (`input`)

Every input the game reads, per platform (touch, mouse, keyboard, gamepad), and exactly what each
does. For each: the trigger (press, release, hold, swipe), when it is accepted, and what happens
when it arrives at a bad moment.

- Draw the input on a timeline: press, hold, release, with the response drawn under it.
- Give the numbers that make it feel right: input buffer window (ms), coyote time (ms), repeat
  rate, dead zone, hold threshold, and the response latency budget.
- Say what is ignored: taps in a menu transition, a second finger, a held key after a state change.

### 3. Mechanics, with numbers (`physics`, `scoring`)

Every rule the player can feel, stated as a number and drawn as geometry or a curve. This is the
section most designs get wrong, so be exact.

- **Motion.** Gravity, jump or flap impulse, terminal velocity, scroll speed, acceleration. Units
  on every value (`u/s`, `u/s²`, px, ms). Draw the arc of one action to scale, with the apex
  height, its time, and the distance covered at scroll speed.
- **Hit rules.** The shape of every hitbox (circle, box, capsule) and its size against the sprite,
  the test used, and what counts as a touch. Draw the nearest-point test with the distance.
- **Scoring.** What earns points, how many, and when it is counted (on passing the gap's centre,
  not on entering). Combos, multipliers, caps, the best-score rule and where it is stored.
- **Difficulty.** Which numbers change with time or score, by how much, with a curve or a table
  and a ceiling so the game stays possible. State the intended failure rate for a new player.
- **A worked example.** One full action with the arithmetic: "flap at t = 0: v = -9.0; apex after
  0.30 s at 1.35 u; the ball has moved 1.8 u forward."
- **Derived limits.** Show that the game is always possible: the largest gap shift reachable
  between two obstacles from the numbers above, against the shift the generator may ask for.

### 4. The game loop (`states`)

What happens each frame and each second, in order.

- The update order (input, physics, collision, spawn, score, render), the fixed timestep or frame
  budget, and what is frame-rate independent.
- The core loop as a cycle: the action, the feedback, the reward, and why the player goes again.
  Draw it as a loop with the time each turn takes.
- The meta loop if there is one: runs, unlocks, daily goals.
- Pausing, backgrounding and resuming: what freezes and what keeps running.

### 5. States and screens (`states`, `ui`)

- **State machine.** Every state (boot, menu, ready, playing, paused, dead, results) as boxes, every
  transition as an arrow labelled with its trigger and guard, and what each state shows, accepts
  and plays. A transition table for anything with more than five arrows. No state without an exit.
- **Screens.** One frame per screen, drawn as a wireframe to scale on the target resolution, with
  every element placed, its text, its size and the safe area. For each: how it is reached, what it
  shows, its buttons and where they go, and what happens on back. Include the HUD, and the empty,
  loading and error versions of a screen that can have them.
- **Navigation.** A map of screens and the arrows between them.

### 6. Entities with properties (`spawning`)

Everything that exists in the world: the player, each enemy or obstacle, each pickup, each piece of
scenery that matters. A frame per kind, or a table when a kind has few properties.

For each, the numbers and rules:

| Property | Example |
|---|---|
| Size and hitbox | 0.9 u circle, hitbox 0.8 u |
| Behaviour | moves with the scroll, never otherwise |
| Spawn rule | every 2.2 s, gap centre within ±1.2 u of the last |
| Lifetime and despawn | removed 2 u left of the screen |
| Interaction | kills the player on touch; scores 1 when its gap centre passes |
| Variants | 3 pipe heights, picked by the difficulty table |

Draw the spawner as geometry: the allowed range of the next gap against the last, the minimum
spacing, the pool size. Say how many exist at once and what happens at the limit.

### 7. Progression (`tuning`)

How the game changes over a session and across sessions: the difficulty ramp, unlocks and what
unlocks them, currencies with their sources and sinks, rewards with their values, the first-minute
experience, and what a player who stays for ten minutes sees that a new one does not. A progression
table (level or score band against the values that change) beats prose. If there is no progression,
say so and say what keeps the game fresh instead.

Also here: the **tuning table**, every number from the sections above in one place with its
unit, its value, a safe range and what getting it wrong feels like. These are the `set_values`
entries; the table's cells use `{{name}}`.

### 8. Art direction (`ui`)

A direction a different artist could follow.

- A one-line look ("flat, high-contrast, chunky silhouettes"), the camera, the resolution and the
  scale of one unit in pixels.
- A palette of five to eight named colours with roles (background, player, hazard, goal, UI, text).
  Write each as a label with its hex value (`#2f9e44`) and a `fill` from the nearest canvas palette
  name: the canvas draws only its own eight colours, so a hex `fill` is drawn in ink.
- A shape language: what is round, what is sharp, how much outline, how much shading.
- Typography: faces, sizes for score, headings and body, and where each is used.
- Animation: the frames and timing of each entity's motion (the flap is 3 frames at 60 ms), and
  the UI transitions with their durations and easing.
- Effects: particles, screen shake (amplitude, duration), flashes, with when each triggers.
- References: pull in reference images with `refs` and cite them by name.

### 9. Audio direction (`audio`)

- The mood and genre in one line, tempo and key for music, and how it loops.
- A table of every sound: trigger, character, length, volume against the mix, and whether it
  varies (pitch shift on each point). No game event without a sound or an explicit "silent".
- Music states: which track plays in which game state and how it changes (crossfade time).
- Mix rules: ducking under effects, a master and a music volume, behaviour with sound off, and what
  happens on a device that is muted.

### 10. The asset list as spec cards (`ui`, `audio`)

Every asset the build needs, as one **spec card per asset**: a frame of type `model` for a 3D
asset, or `ui-screen` or `note` for what is not 3D. Make cards with `create_frame` or `set_frame`
and fill them in; do not describe an asset only in prose.

A card carries the asset's name, its size in metres or pixels, its triangle or texture budget, the
style notes (what it looks like, what it must read as at a glance, the palette names it uses),
reference images, and `review_state: "draft"`. Cover:

- Characters, props and environment pieces.
- UI: icons, buttons, fonts, screens.
- Effects: sprites and particles.
- Audio: each sound and track, as a `note` card with its trigger, length and mood.

Cross-check the cards against the other sections: every entity in section 6, every screen in
section 5 and every sound in section 9 has a card, and every card is used by something. Run
`assets` and read it against that list. Then put each card's frame in a child canvas if the
project does that (`link_frame`).

### 11. Open questions (`tuning`)

The last frame. Everything you decided without being told, and everything that needs a person
(`assumed:` items), each as a question with the options you considered, the one you picked and
why, and what it would cost to change. Include risks: what might not be fun, what might be too
hard to build, what you could not check. Number them so a reviewer can reply "Q3: option B".
Where a question blocks a number, the number is still given, marked provisional.

## Quality bar

Before you stop, check each of these. A failure means more work, not a caveat.

- **No bare nouns.** Every box that names a mechanic has a number, a rule, a picture of its
  behaviour or a link to the frame that has one.
- **Numbers carry units**, and a number that appears in two places is a `{{value}}`.
- **Consistent.** The jump height fits the gap; the spawn spacing fits the scroll speed; the score
  per point fits the difficulty curve. Show the arithmetic that proves it for the one pair of
  numbers most likely to break the game.
- **Complete.** Every state has an entry and an exit. Every input is handled in every state. Every
  entity has a spawn rule and a despawn rule.
- **Buildable.** An engineer could start without asking a question, and an artist could start from
  the art direction and the cards.
- **Covered.** `coverage` shows no missing topic, and each frame's `covers` is true.
- **Looked at.** Every frame has been checked with `view_diagram`, in dark mode too if the style
  uses colour, and the comments (`list_comments`) are all answered.

## Common failures

- Describing in a label what should be drawn: "the ball falls fast". Draw the curve.
- Round numbers that were never checked against each other.
- A state machine with only the happy path: no pause, no death-then-retry, no interruption.
- An asset list written once and never reconciled with the entities and screens.
- Open questions written as "TBD". Write the question, the options and your pick.
- Padding: three frames that say the same thing. Merge them. Depth is more numbers and more
  cases, not more words.
