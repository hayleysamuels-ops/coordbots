"use strict";

/**
 * The scopes, defined ONCE.
 *
 * This lives in its own file rather than in metrics.js because
 * payload-contract.js reads it, and the contract is loaded by
 * scripts/smoke.js — which runs in CI against a deployed URL and must
 * not open the SQLite database that requiring metrics.js would.
 *
 * The list used to be written out as a literal ["all", "coordinated"]
 * in five places: the client payload, the overview rebuild,
 * /api/config, the contract and the smoke test. Adding a third to some
 * of them and not the others is exactly the drift that took the
 * dashboard down over the period list, so there is one list now.
 *
 * `notCoordinated` is NOT simply "all minus coordinated". It counts
 * work booked by a NAMED person who is not on the roster. Schedules
 * with no scheduler at all (3.7% of January's, 33% of Luminai's) are
 * in neither side: attributing them to the client would invent a
 * finding and attributing them to us would flatter one. Events are a
 * different story — 99.9%+ carry a scheduler — so the volume
 * comparison is effectively complete while the cancellation one is
 * not. The remainder is reported in the data-quality section rather
 * than hidden inside a subtraction.
 */
const SCOPES = [
  { key: "coordinated", label: "Carrara-coordinated", description: "booked by a coordinator on this client's roster" },
  { key: "notCoordinated", label: "Client's own", description: "booked by a named person who is not on the roster" },
  { key: "all", label: "All activity", description: "every interview that ran, whoever booked it" },
];

const SCOPE_KEYS = SCOPES.map((s) => s.key);
const DEFAULT_SCOPE = "coordinated";

module.exports = { SCOPES, SCOPE_KEYS, DEFAULT_SCOPE };
