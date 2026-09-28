# Dashboard design system

Status: agreed and implemented 28 September 2026 (§ Decisions, § Implementation notes). It describes the
system in two reference screens from another project: a daily dashboard, and a
candidate swipe-review page. It then maps that system onto this dashboard's existing
tokens in `public/style.css`. The values are approximate, because they were read from
screenshots, not from CSS.

Scope: the main dashboard (`index.html`, `style.css`). The booking and connection
pages use their own palette (`scheduler-theme.css`) and are out of scope until
decided separately.

## Principles

1. **Colour means state, never decoration.** Almost everything is neutral: ink, grey,
   white and a tinted page. Colour appears only where something needs attention, is
   handled, or has a consequence. A number is black until it's a problem, then it
   turns red.
2. **Colour is never the only signal.** Every coloured element also carries words:
   "Out now", "PART-COVERED", "Archive". It must still read in greyscale.
3. **Three typefaces, three jobs.** A serif for titles, a sans for content, and a mono
   for metadata. You can tell what a piece of text is by its face before reading it.
4. **Say why it's empty.** An empty state names what's missing and what happens next.
   It isn't a blank space or an illustration.
5. **The client accent is identity, not meaning.** See § Client accent.

## Typography

| Role | Face | Size / weight | Used for |
|---|---|---|---|
| Page title | Serif | ~32px, 700 | One per page, if the page has a hero. The topbar title stays at 22px. |
| Section title | Serif | ~20px, 700 | Card and section headings ("To-do", "Coverage calendar") |
| Stat number | Sans | ~28px, 700, tabular | The big number in a stat tile |
| Lead / row primary | Sans | 16px, 500–600 | A person's name in a row, a to-do item |
| Body | Sans | 14px, 400 | Sentences, descriptions, stat labels, empty-state body |
| Meta | Mono | 12px, 400–500 | Counts ("3 items"), date ranges, row numbers, "moved on in Ashby", timestamps |
| Eyebrow / label | Mono | 11–12px, 500, uppercase, +0.12em tracking | "DAILY DASHBOARD", "CLIENTS", badge text |

- **Pairing.** Keep the brand fonts already imported: PT Serif (`--font-serif`) and
  Manrope (`--font-sans`). Add one mono, `--font-mono`, e.g. IBM Plex Mono 400/500
  from the same Google Fonts import, falling back to `ui-monospace, "SF Mono", Menlo,
  monospace`.
- **The serif is only for titles.** Never use it for body text, buttons or tags.
- **The mono never carries a sentence.** Short tokens only: a count, a date, a label.
  If it needs a verb, it's body text.
- **Numbers.** Use `font-variant-numeric: tabular-nums` on stat numbers and on mono
  meta, so counts and times don't jitter as they refresh.
- **Line height.** 1.5 for body, 1.2 for titles, 1 for pills and badges.

## Spacing

The base unit is 4px. The steps in use are **4, 8, 12, 16, 24, 32, 48**.

- **Inside a control or chip:** 4–8px vertically, 12–16px horizontally.
- **Card padding:** 20–24px. A stat tile has 20px padding, and a 4px gap between
  number and label.
- **Between related items:** 8–12px (chips in a row, a label to its value).
- **Between cards in a grid:** 16px.
- **Between sections:** 24–32px. A card is never closer to the next section than it
  is to its own contents.
- **Page gutter:** 32px on desktop and 16px on phone widths, from one wrapper.
- **List rows:** 12–14px vertical padding, separated by 1px hairlines rather than
  gaps. Each person block in the coverage list has a full-width hairline under it.

## Surfaces and cards

- **Page:** a tinted off-white (`--surface-sunken`, marmol `#edebea`, or slightly
  lighter), so white cards lift off it without heavy shadow.
- **Card:** a white `--surface`, 1px `--gridline` border, and `--shadow-xs` at most.
  Radius as in § Radii.
- **State lives inside the card.** A card doesn't change colour or border for state;
  the tag or number inside it does. Today's 3px severity-coloured left border
  (`.card.sev-*`) is removed in the restyle (§ Decisions).
- **Stat tile:** a card holding only a number and a one-line label. It's equal width
  in a row of three, and collapses to one column on narrow screens.
- **Collapsible section:** a card with only its title and a small disclosure
  triangle at the right. The whole card is the control.
- **Side panel:** a full-height card, e.g. the Queue/Decided panel. It has its own
  segmented control at the top and a hairline under that control.
- **Mode banner:** a full-width strip above the header, with a `--serious-wash`
  background, a 1px `--serious` bottom border and dark text. Key phrases are bold.
  It's only for "this page has real consequences right now" (e.g. "Swipes now change
  Ashby"). It isn't for notices or errors.

## Radii

| Token (proposed) | Value | Used for |
|---|---|---|
| `--radius-control` | 8px | Buttons, inputs, chips, the segmented control |
| `--radius-card` | 12px | Cards, stat tiles, panels |
| `--radius-pill` | 999px (exists) | Status pills and mode badges only |
| `--radius-check` | 6px | Checkboxes (rounded square) |

These replace the current 2 / 4 / 8px tokens. **This is a deliberate product choice
for the dashboard**, and it may differ from Carrara's deck and document templates,
which stay angular. The dashboard follows this doc, not the templates. The "Carrara is
angular" comment in `style.css` changes with the tokens in the restyle.

## Buttons

There are four levels, and each region has at most one primary.

1. **Primary.** Solid fill with bold text, e.g. "Add". It's the same height as the
   input beside it. The fill is **ink**: `--text-primary`, with `--surface` text,
   which inverts correctly in dark mode. It's never the client accent and never a
   state colour. The reference screen uses teal, but a fixed hue would clash with
   some client accents.
2. **Secondary.** Outlined: 1px `--border`, `--surface` fill, `--text-primary` text.
   Examples are "Skip" and "+ Coverage". This is the default for anything that isn't
   the one primary action.
3. **Consequential.** Outlined like secondary, but the border and text take the
   state colour of what the button does. "Archive" uses `--critical`, "To Review"
   uses `--good`. They're the same size and weight as secondary, and **never
   filled**, so a destructive action never looks like the recommended one. The
   existing Snooze/Hide pair already follows this: Snooze is secondary, and Hide is
   consequential with `--critical`.
4. **Segmented control.** Equal-width segments inside one outlined container. The
   active segment gets a `--surface-sunken` fill and `--text-primary`; inactive
   segments are text only, in `--text-secondary`. Tabs and filter-mode toggles use
   this.

- **Hover:** darken the border to `--text-secondary`, with no colour shift.
- **Focus:** the existing `:focus-visible` outline (3px `--text-primary`, 3px offset)
  applies to all four levels. The blue ring in the swipe screenshot is the
  browser's own focus outline, not a design colour.

## Colour for state

State colours use the existing tokens, which already have dark-mode values. Every
state has a **wash**, a low-alpha background, and an **ink**, a saturated text or
border colour. Filled state backgrounds with white text aren't used anywhere.

| State | Tokens | Meaning | Reference examples |
|---|---|---|---|
| Critical | `--critical` / `--critical-wash` | Needs action now, overdue, destructive | "Out now", a coverage-gap count of 1, "Archive" |
| Warning | `--warning` / `--warning-wash` | Partial, soon, stale, uncertain | "This Saturday", "PART-COVERED", "Runlayer · uncovered" |
| Good | `--good` / `--good-wash` | Handled, covered, confirmed | "✓ Modal COVERED", "Anna has it", "To Review" |
| Neutral | `--border` / `--surface` | Informational, low priority | "Console LOW PRIORITY", "Skip" |
| Mode | `--serious` / `--serious-wash` | The page is in a consequential mode | The live banner and "LIVE: SWIPES CHANGE ASHBY" |

Three kinds of tag carry state:

- **Status pill.** `--radius-pill`, wash fill, ink text, sans 12–13px 600, no border.
  It sits at the right of a row, e.g. "Out now".
- **Entity chip.** `--radius-control`. An entity name in sans 500, followed by a
  qualifier in mono uppercase at 11px, inside one chip ("Runlayer PART-COVERED").
  Emphasis comes from border and fill: a solid wash for "someone has it", a wash plus
  an ink border for the strongest state, and an outline only for neutral.
- **Mode badge.** `--radius-pill`, 1px ink border, wash fill, mono uppercase with
  tracking. It sits next to the page title, and is only for page-level modes.

**State numbers.** A stat number uses `--text-primary` normally and `--critical` when
it counts a problem and is above zero. Zero is never red.

**Inline state text.** A whole line can take a state ink, e.g. "Runlayer ·
uncovered: Oct 1–6" in `--warning`. Only the line with the problem is coloured, never
the block around it.

## Loading, empty and error

- **Loading:** a mono `--text-muted` status line where the content will appear, e.g.
  "Loading availability submissions…". There are no spinners and no skeleton
  shimmer. The section's header and title render immediately; only the content area
  waits. This matches today's text-only loading lines.
- **Empty, nothing to do:** centred, no border and no illustration. A sans 600
  heading at ~20px in `--text-secondary` ("Nothing left to review"), then one or two
  body sentences in `--text-muted`. The sentences say why it's empty and what happens
  next, e.g. "Skipped people come back next time you open this page, because a skip
  records nothing." A one-line mono status can repeat the heading above the controls
  when the controls stay visible.
- **Empty, but can't confirm:** today's `.empty-state-error` rule stays. It shows
  "Refresh failed — can't confirm this is empty." in `--warning` with a solid border.
  A failed refresh must never look like a confident "nothing to do". This is the one
  empty state that keeps a border.
- **Counts:** a section's item count ("3 items", "4 upcoming") is mono meta at the top
  right of the card title row. It shows "0 items" when empty rather than disappearing.

## Client accent (`CLIENT_ACCENT_COLOR`)

The accent varies per client: blue, orange and black today, and any CSS colour is
accepted. So nothing may depend on its hue or its lightness.

- **It's allowed only in client chrome:** the topbar's bottom rule, the topbar title
  and the active tab. That's where `--header-accent` is used today.
- **It's never used for:** state, a primary button, links, a card, a tag, a
  focus ring, or a loading or empty state. Keeping the orange accent out of state
  matters most, because it's Carrara's ember, the same hue as `--serious`.
- **Anything drawn in the accent on the page goes through `--header-accent-on-page`**
  (the title and rule), which lifts it in dark mode. Only the active tab uses
  `--header-accent` directly, and dark mode replaces that fill.
- **Anything drawn in the accent needs a fallback that works for any value:**
  - Text in the accent is only allowed at title size (22px or more, bold), where
    3:1 contrast is enough.
  - A fill in the accent is only allowed where the dark-mode rule replaces it. The
    active tab already does this.
- **Test matrix for any change:** blue, orange, black and the unset default, each in
  light and dark mode.

## Keeping today's contrast and dark-mode fixes

These already exist in `style.css` and stay:

- **Dark palette.** The `@media (prefers-color-scheme: dark)` token block at the top,
  with its lighter state inks and alpha washes. Every new token gets a dark value
  there, in the same block.
- **Selected controls in dark mode.** The end-of-file block gives `.tab-btn`,
  `.filter-mode-btn`, `.signal-chip` and `.queue-nav-item` a light fill with dark text
  when active, and strengthens Hide in dark mode. The segmented control inherits
  this.
- **Muted grey.** `--nuvola` was darkened to `#7C776D` for small meta text. Its
  comment puts that at about 4.45:1 on white, just under 4.5:1. Mono meta therefore
  stays at 12px minimum, on `--surface`, never on a wash.
- **Focus.** The global `:focus-visible` outline.
- **State pairs.** Every wash + ink pair must reach 4.5:1 for its text size, in both
  modes, before it ships.

## Decisions (28 September 2026)

1. **Radii: soft.** 8px for controls, 12px for cards, as in the reference. This is a
   deliberate dashboard choice and may differ from the deck and doc templates.
2. **Severity left borders are removed.** Queue rows and cards already carry state
   in words (signal chips, age labels), so the 3px border only repeated that signal
   in colour.
3. **The primary button is ink** (`--text-primary` fill, `--surface` text), never
   the client accent or a state colour.
4. **The black-accent dark-mode bug is fixed as a defect, before the restyle** and
   in its own commit, because it's live on Profound (§ Found while writing this).

Settled during the restyle:

- **Mono: IBM Plex Mono** (400/500) for metadata, loaded with the other two faces.
  It's one token, `--font-mono`, if a different face is wanted.
- **Stat tiles and page title: not added.** They're described here in case a summary
  row is wanted later; nothing in the restyle needed them.

## Implementation notes

What the restyle changed beyond restating this doc in CSS, and why:

- **Sections are cards.** Each `.column` is a card on the tinted page, with its
  title and "Updated" time on one row. The side column stacks them, since 300px has
  no room for both. The onsite panel keeps its deliberately heavier 2px border.
- **The queue sidebar is a card too**, so its muted counts and labels sit on
  `--surface`, not the tinted page.
- **Removed as decoration:**
  - the coloured dot before each section title (a fixed colour per section, not
    state)
  - the ember tick on "Filter by"
  - the Stale Candidates card tint
  - ember link hovers, which are now underline only
  - the ember accent colour on the filter checkboxes, which now use ink
- **Hide never fills in light mode.** It's outlined in `--critical` and gains the
  wash on hover. The dark-mode override at the end of `style.css` is unchanged, and
  it still fills on hover. Align it only if the fill looks wrong there.
- **Contrast.** Every text-on-background pair was measured in headless Chrome
  before and after, in both modes and with the default, black, blue and orange
  accents. The restyle put state pills on the lighter card surface in dark mode,
  where two regressed, so the tokens were adjusted until every pair passes:
  - `--nuvola`: `#7C776D` → `#7A756B`, from 4.45:1 to 4.61:1. It was just short of
    AA before.
  - Light-mode `--good`, `--warning`, `--critical`: `#4a7442`, `#807115`, `#b0370b`,
    a shade darker than moss, lemon and ember-press. Their pills measured 4.29,
    4.08 and 4.29 before.
  - Dark-mode `--good`, `--critical`: `#9fca8f`, `#ffb198`, with washes redrawn from
    the new inks. On the card surface they'd dropped to 4.22 and 3.96.
  - The active tab's accent fill is capped at OKLCH lightness 0.55, so its white
    text passes for any accent. The default ember was 3.73:1 and is now 5.33:1.
    Black and dark blue are unchanged.
- **Dark-mode title contrast is now measured on the topbar's card surface**
  (`#3a3634`), not grafite: black 4.79, blue 4.29, orange 4.22. All clear the 3:1
  that 22px bold needs. The figures in § Found while writing this were measured on
  grafite.
- **Phone width.** The tab row wraps, and gutters drop to 16px. The page no longer
  scrolls sideways at 400px; it scrolled 218px before. The action queue table still
  scrolls inside its own box.
- **Still to do:** empty-state copy. The empty state is restyled, but most sections
  still say only "Nothing flagged". § Loading, empty and error asks for a sentence
  on why it's empty and what happens next, which is an `app.js` copy change per
  section.

## Found while writing this

- **Black accent in dark mode (fixed).** With a black accent, the topbar title and
  rule were black on grafite, about 1.5:1, so close to invisible. A dark blue was
  about 2.1:1. The dark-mode block now draws both through `--header-accent-on-page`,
  which keeps the client's hue but raises its OKLCH lightness to at least 0.72:
  - black becomes a light grey (5.7:1)
  - `#1d4ed8` becomes a lighter blue (5.1:1)
  - raw ember becomes a lighter orange (5.0:1)
  - the default dark ember is unchanged (7.9:1)

  Browsers without relative colour syntax fall back to `--text-primary`. This keeps
  the accent in the title, rather than switching the title to `--text-primary` as
  first suggested, so every client's dark-mode title stays recognisably theirs.
