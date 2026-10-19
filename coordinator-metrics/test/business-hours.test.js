"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { businessHoursBetween } = require("../src/business-hours");

const TZ = "America/New_York";
const HOURS = { start: 8, end: 18 };

test("the weekend is not counted", () => {
  // Friday 17:00 to Monday 09:30 is 64 clock hours and about 2 business
  // hours. Only the second describes how fast anyone worked, which is
  // the whole reason turnaround is reported in business hours.
  const h = businessHoursBetween("2026-10-16T21:00:00Z", "2026-10-19T13:30:00Z", TZ, HOURS);
  assert.ok(h <= 3, `expected ~2 business hours, got ${h}`);
});

test("a gap entirely inside a weekend is zero", () => {
  assert.strictEqual(businessHoursBetween("2026-10-17T14:00:00Z", "2026-10-18T22:00:00Z", TZ, HOURS), 0);
});

test("overnight hours outside the business window are not counted", () => {
  // 16:00 to 10:00 next day: 2 hours before close, 2 after open.
  const h = businessHoursBetween("2026-10-19T20:00:00Z", "2026-10-20T14:00:00Z", TZ, HOURS);
  assert.ok(h >= 3 && h <= 5, `expected ~4, got ${h}`);
});

test("a daylight-saving change does not shift the count", () => {
  // US clocks go back on 2026-11-01. Friday 08:00 local to Tuesday 07:00
  // local is Friday (10) + Monday (10) + Tuesday before opening (0).
  const h = businessHoursBetween("2026-10-30T12:00:00Z", "2026-11-03T12:00:00Z", TZ, HOURS);
  assert.strictEqual(h, 20);
});

test("an end before the start is zero, not negative", () => {
  assert.strictEqual(businessHoursBetween("2026-10-19T20:00:00Z", "2026-10-19T14:00:00Z", TZ, HOURS), 0);
});

test("an unparseable timestamp returns null rather than a wrong number", () => {
  assert.strictEqual(businessHoursBetween("not a date", "2026-10-19T14:00:00Z", TZ, HOURS), null);
});

test("each client's own timezone is honoured", () => {
  // 00:30 UTC Tuesday is Monday 17:30 in Los Angeles — inside the
  // business day there, outside it in London.
  const la = businessHoursBetween("2026-10-20T00:00:00Z", "2026-10-20T01:00:00Z", "America/Los_Angeles", HOURS);
  const london = businessHoursBetween("2026-10-20T00:00:00Z", "2026-10-20T01:00:00Z", "Europe/London", HOURS);
  assert.strictEqual(la, 1);
  assert.strictEqual(london, 0);
});
