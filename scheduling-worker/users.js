"use strict";
/**
 * Who is allowed into the Work Trial Tracker.
 *
 * This list seeds the `users` table on boot. To add a teammate, add a row here
 * and redeploy — or insert directly into the table, which takes effect straight
 * away with no deploy.
 *
 * Seeding never overwrites `can_approve` or `active` on rows that already exist,
 * so revoking someone in the database is not undone by the next deploy.
 */

const ALLOWED_DOMAIN = "carrara.is";

const SEED_USERS = [
  { name: 'Hayley Samuels',          email: 'hayley.samuels@carrara.is',   slack_user_id: 'U077S1EQKDW', can_approve: true },
  { name: 'Tess Wicks',              email: 'tess@carrara.is',             slack_user_id: 'U09BRJMBRD5', can_approve: true },
  { name: 'Sadiqeh Agah',            email: 'sadiqeh@carrara.is',          slack_user_id: 'U0ASY17UEAZ', can_approve: true },
  { name: 'Ria Carla Hipolito',      email: 'ria@carrara.is',              slack_user_id: 'U0AFPN8KHTK', can_approve: true },
  { name: 'Catherine "Cath" Ariola', email: 'catherine.ariola@carrara.is', slack_user_id: 'U0ATNMS6Z0W', can_approve: true },
];

/**
 * Can this person approve things?
 *
 * Nothing calls this yet — it is the hook the Slack bot approval queue will use.
 * Signing in is enough to VIEW the tracker; approving needs can_approve = true.
 */
function canApprove(user) {
  return !!(user && user.active && user.can_approve);
}

module.exports = { ALLOWED_DOMAIN, SEED_USERS, canApprove };
