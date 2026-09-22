# September 17 coordination dashboard amendment

Requested direction: a focused action queue on the left, lighter calendar in the center,
and one candidate detail panel on the right. This amendment supersedes conflicting
layout, density and interaction rules below. The existing Manrope family, 8px spacing,
white/warm gray surfaces, restrained borders and role palette carry over.

- Explicit urgency and blockers lead. All-day trials say Today / tomorrow rather than
  implying an exact start time. Next 72 hours uses the next three Pacific calendar days.
- White calendar cards use a narrow role-color edge, a secondary role label, status,
  resource summary and one proposal count. Assignment values and reasons live in details.
- Click, Enter or Space on queue, calendar or candidate list opens the same detail view.
  No hover activation. At narrower widths the detail view becomes a right-side drawer;
  Escape/Close dismisses it. Calendar keeps its horizontal scroll and day-span geometry.
- Duplicate names or Ashby links produce a review warning and links to compare records.
  No automatic merge or changes to scheduling/readiness eligibility.
- Declines show severity, an explicit owner (Unassigned until chosen), follow-up and
  handled/reopen actions. Triage is stored on candidate.coordination. Calendar and Slack
  are unchanged. A rescheduled event or different declining attendees requires new triage.
- Admin / Automation houses all bot controls and snapshot import/export. Dashboard shows
  only a health summary; status unavailable must never imply healthy.
- Work Trial suggestions show dates, computed priority, Unassigned owner, bulk selection,
  acknowledged writes, failure reporting and persistent undo of the last dismissal batch.
  Potential matches remain individually reviewed when adding in bulk.
- New labels and controls are at least 12px with visible focus. Muted text is darkened to
  #625E5B on light grounds. Motion stays minimal and respects reduced motion.
- No new dependencies, framework, external write integration, or fabricated live data.

---

# DESIGN.md — Work trial tracker calendar

Locked 11 Sep 2026. Direction A, "Planning board". Supersedes the visual sections of `day-view-spec.md` (§10) and `day-view-spec-addendum.md` (§C, §F). All behavioural rules in those documents and in addendum 2 still stand.

---

## Project

The calendar band of the Poetic work trial tracker. A Railway-hosted internal tool used daily by Carrara talent ops to see which work trials are running, who is partnering them, and whether a desk and laptop exist. It sits at the top of a single page, above stat tiles, a Bots panel and the candidate list.

## Audience

Three to six people who use this every working day and already know every candidate by name. They do not need onboarding, explanation, or persuasion. They need to see the state of the week from across a room and spot what is missing.

## Type

- **Manrope** throughout. Weights 500, 600, 700 only.
- **JetBrains Mono 500** for desk and laptop identifiers only, because those are machine names. Nothing else.
- Scale in use:
  - Day numeral: 30px / 700 / line-height 1 / tracking -0.02em
  - Weekday label: 12px / 600 / lowercase
  - Candidate name: 15px / 700 / line-height 1.25 / tracking -0.005em
  - Day counter line: 10.5px / 600
  - Meta row (role, partner, load): 12px / 600
  - Kit chips: 10.5px / 500 mono
  - Status pill: 9.5px / 700 / tracking 0.09em / uppercase
  - Flag text: 11.5px / 600
- Weekday labels are **lowercase**, not uppercase. Uppercase stays reserved for status pills.

## Color

| Token | Hex | Job |
|---|---|---|
| `--ink` | `#2E2B2B` | Candidate names, day numerals, flag text |
| `--ink-2` | `#4D4D4D` | All secondary text **on coloured cards** |
| `--ink-3` | `#827F7D` | Secondary text on white or surface grounds only |
| `--surface` | `#EBE8E4` | Page ground, day tiles, empty columns |
| `--line` | `#EEEEEE` | Card shell borders, dividers |
| `--paper` | `#FFFFFF` | Calendar shell, today's tile, chip grounds |
| `--ember` | `#EB4C18` | **Flag dots and the stretched-capacity indicator. Nothing else.** |

**Role colours, filled card grounds:**

| Role | Hex | Token |
|---|---|---|
| FDE | `#B2CDED` (blue) | `--role-fde` |
| FDS | `#A8CA9F` (green) | `--role-fds` |
| Sales | `#E0D8CC` (sand) | `--role-sales` |

> **Amended 11 Sep 2026.** FDS was locked at `#A4C69B`. Against it `--ink-2`
> measures **4.48:1**, just under AA, while the contrast rule below states it
> clears. Ruled: lighten FDS one step to `#A8CA9F`, which measures 4.67:1.
> Lighter, not darker — the text is dark, so contrast rises as the ground
> lightens. FDE and Sales are unchanged.
>
> The role grounds have their own tokens rather than reusing `--blue` and
> `--green`. Those remain the list view's in-progress and complete tints, and a
> future nudge to one of them must not be able to silently fail the cards'
> contrast test.

Sales is a deeper shade of the existing surface, chosen deliberately over ember-tint `#FDDED4` so that warm orange continues to mean one thing: attention. Do not substitute ember-tint.

**Contrast rule, not negotiable.** On the three role grounds, never use `--ink-3` and never use alpha-blended ink. `#827F7D` on `#A4C69B` measures about 2:1 and fails AA outright. Use solid `--ink` for names and solid `--ink-2` for every secondary line. `#4D4D4D` clears 4.5:1 on all three role colours as amended above; verify if any role colour changes. `test/design.test.js` computes this from the tokens rather than trusting it, so a change that breaks it fails the suite.

Measured, 11 Sep 2026:

| Ground | with `--ink` | with `--ink-2` | with `--ink-3` |
|---|---|---|---|
| FDE `#B2CDED` | 8.59:1 | 5.17:1 | 2.43:1 (banned) |
| FDS `#A8CA9F` | 7.76:1 | 4.67:1 | 2.11:1 (banned) |
| Sales `#E0D8CC` | 9.93:1 | 5.98:1 | 2.81:1 (banned) |

**Cards carry role colour, never status colour.** Status remains a pill. The earlier rule that bars carry no status colour is unchanged and still binding.

## Space

- Base unit 8px. Grid gap 8px between columns and between stacked cards.
- Calendar shell: `#FFFFFF`, radius 16px, 1px `--line` border, padding 18px 18px 22px.
- Day tile: radius 12px, padding 12px 14px 13px, min-height 74px.
- Day column: radius 12px, padding 8px, min-height 340px.
- Card: radius 12px, padding 13px 14px 14px, no border.
- Chips: radius 6px, padding 3px 7px. Status pill: radius 999px, padding 3px 8px.

## Layout

Seven equal columns at week width, three at the 3-day setting. Two stacked grids sharing one column template: a day-tile header band, then the lane grid beneath it.

- **Day tiles**: lowercase weekday above a large numeral. Weekend tiles render the numeral in `--ink-3`. **Today is a white tile with a 1.5px `--ink` border**, elevated against its tinted siblings. This is the single strongest signal on the page and replaces any separate "today" marker.
- **Scroll anchor**: on load the calendar anchors on today with **one column of
  lead-in**, so the 3-day window reads yesterday, today, tomorrow. Amended
  11 Sep 2026 from "today leftmost": yesterday is where debriefs are, and the
  lead-in makes the past reachable without looking like the view has scrolled
  past itself. The Today control returns to the same position from anywhere.
- **Empty days**: full width, ground at `--surface` around 55% opacity, label "No trials" at 11.5px / 600 `--ink-3`. No border, no box. An empty day and a broken render must not look alike.
- **Calendar height**: fills the viewport below the page header on load, and grows past that if lanes require it. No internal vertical scroll, no `max-height`. Addendum 2's rules stand.
- Horizontal scrolling unchanged, including the 90-day cap and clipped-edge cues.

## Components

**Trial card**, top to bottom:

1. Candidate name, `--ink`.
2. Day counter, `--ink-2`, only on multi-day trials. Final day reads "Day 3 of 3, final day".
3. Meta row: role, a 4px dot separator, partner name, then concurrent load as "1 running". Unassigned partner suppresses this row and shows the flag instead.
4. Flag row when present: 7px Ember dot plus sentence-case text at 11.5px / 600.
5. Kit row: desk chip, laptop chip, status pill. Missing desk or laptop renders a dashed-outline chip reading "No desk" or "No laptop" in Manrope 600, not mono, since there is no machine name to show.

**Three chip states, three treatments.** Amended 11 Sep: the spec asked for
dashed chips for suggestions, which collided with the dashed unset state
already on the card.

| State | Treatment |
|---|---|
| Confirmed | Filled chip, paper ground, JetBrains Mono |
| Unset | Dashed outline, no fill, Manrope, reads "No desk" |
| Suggested | Solid hairline, no fill, prefixed with the word **Suggested** |

Fill, dash and hairline are separable across a room. The word is what stops a
proposal being read as a booking at any distance, so it is never styling alone.
Mono stays for desk and laptop identifiers only: a suggested *person* is not a
machine name and is set in Manrope.

Suggestions sit in their own row, never in the partner meta row and never in
the kit row. "FDS · Shantam Jain · 1 running" with a proposed name in it would
be indistinguishable from a real booking, and an unassigned partner keeps its
"No main partner" flag with the proposal beside it: the gap is real until
somebody accepts.

**Suggestion reasons cross-reference each other.** When the same person, desk or
laptop is proposed on another card, the reason says which card and that it is
only a proposal. "Why does this say Advait again" is answered without
pretending the rotation moved.

**Clipped cards** keep the name visible. A card clipped at the left edge currently renders with no label at all; that is a defect, not a style.

**Controls**: Today button, then a 3 days / Week segmented control, then the role legend right-aligned. Legend swatches are 9px rounded squares.

## Motion

Almost none. Hover and focus states may transition background and border over 120ms ease. Nothing else animates. Respect `prefers-reduced-motion` by rendering final states.

## Imagery

None. No avatars, no icons beyond the dot separators and flag dots. The reference image uses attendee avatars; there is no avatar data here and inventing one would be fabrication.

## Voice

Sentence case everywhere except status pills. Say "No desk", not a dash. Say "1 running", not "1 concurrent". **No em dashes anywhere in UI copy.** Flags state what was observed, never a cause that has not been checked.

## Constraints

- No shadows.
- No gradients. The reference's gradient header wash is explicitly rejected.
- No new brand colours beyond the three role grounds listed above.
- Ember appears only on flag dots and the stretched-capacity indicator.
- No time axis. Trials are all-day and hour rows would imply precision the data does not have.

## References

- `calendar.me` mockup supplied 11 Sep. Taken: large day tiles with lowercase weekday and big numeral, today as an elevated white tile among tinted siblings, borderless soft-filled cards colour-coded by category, generous radii. Rejected: the gradient header wash, the lavender palette, attendee avatars, the hourly time grid.
- The tracker's own existing list view, for pill, chip and flag treatments that should stay consistent across both halves of the page.

---

## Build notes

**Carry over unchanged** from the existing implementation: the day model, `effective()` precedence, the alias map, lane packing, clipped-edge logic, the 90-day cap, the hover panel behaviour and its body-level layer.

**Fixed 11 Sep 2026, in two passes.** On load `.dayscroll` had `scrollLeft: 0`,
so the calendar opened on the back-7 region with today off-screen to the right.

The first pass replaced `scrollIntoView` — which can scroll the page as well as
the band, and whose `block: "nearest"` is satisfied by a column that is merely
visible — with a direct assignment. That fixed the Today control but not the
initial render. Three further causes, all measured live:

1. **`.dayscroll` carried `scroll-behavior: smooth` in CSS, and CSS
   `scroll-behavior` governs programmatic scrolls as well as user ones.** Every
   "instant" anchor was therefore starting an animation, which the next render
   cancelled by replacing the element, while the synchronous read-back saw 0
   and reported failure. The Today button worked because it asked for smooth
   and nothing replaced the element underneath it.

   Setting `style.scrollBehavior = "auto"` before the assignment did **not**
   fix this, and shipped as a second failed attempt: writing to `.style` only
   marks style dirty, and a `scrollLeft` *write* does not force a style flush,
   so the assignment still ran under the stale computed value.

   There is now no `scroll-behavior` in the stylesheet at all. An assignment is
   instant because nothing says otherwise, and the Today button passes
   `behavior: "smooth"` explicitly, skipping it under `prefers-reduced-motion`.
2. Success was assumed rather than observed, so an attempt that scrolled
   nowhere marked the job permanently done. It now returns the observed
   position, and gates on `offsetWidth` because an unlaid-out element reports
   `offsetLeft: 0`, which would otherwise look like a target already satisfied.
3. The first paint runs against an empty candidate list before `pull()` returns.
   Its `scrollLeft: 0` was preserved across the second render. The
   position-preserving branch now applies only after today has actually been
   anchored; until then every render re-attempts it, and a failed attempt
   retries on `requestAnimationFrame` rather than a timeout.

Every anchor attempt is recorded to `window.__dayAnchor` — target, observed
position, whether the node was still in the document, and the scroll extents —
because two fixes for this were wrong before the third and reasoning about it
from outside the browser was the problem.

Node has no layout engine, so no test proves today is visible in a browser.
`test/design.test.js` models the measured failure instead — a stub whose
`offsetLeft` and `offsetWidth` read 0 until laid out and whose `scrollLeft`
clamps to 0 — and asserts that the old code's shape fails it. The previous test
asserted today was in the scrollport and passed against stubs no matter what
the code did.

**Open question, resolved 11 Sep 2026:** the day counter was not selected when
card contents were chosen, but the approved mockup includes it. Ruled: keep it
as specified. Multi-day cards read "Day 2 of 3"; the final day reads "Day 3 of
3, final day"; single-day cards show nothing.

**Tests to add:**

- Day numeral, weekday case, and today's white tile all render as specified.
- Each role maps to its exact hex. A fourth role value falls back to a neutral and raises a flag rather than picking a colour.
- No `--ink-3` on any element whose computed background is a role colour.
- Contrast of every text colour against its actual card ground is at least 4.5:1.
- Empty day renders the tinted ground and the label, with no border.
- A clipped card still renders its candidate name.
- No shadow and no gradient anywhere in the calendar band.
- Today's column is inside the scrollport after initial render.
