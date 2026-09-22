"use strict";
/**
 * Preload that moves the wall clock by SHIFT_DAYS, leaving every other Date
 * behaviour intact.
 *
 * Why this exists: a suite full of date fixtures can quietly grow a test that
 * reads "today", and it will pass every day until the one where it does not —
 * a Monday, a DST boundary, a month end. Running the whole suite at a spread
 * of offsets makes that impossible to miss, and costs about a second.
 *
 *   npm run test:clock
 *
 * A Date SUBCLASS, not a Proxy: proxying Date breaks instanceof and the static
 * helpers in ways that fail tests for reasons unrelated to the clock, which is
 * exactly the false positive this is meant to avoid. The first version of this
 * did that and reported 98 failures at zero shift.
 */
const SHIFT = Number(process.env.SHIFT_DAYS || 0) * 86400000;
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + SHIFT);
    else super(...args);
  }
  static now() { return RealDate.now() + SHIFT; }
}
globalThis.Date = ShiftedDate;
