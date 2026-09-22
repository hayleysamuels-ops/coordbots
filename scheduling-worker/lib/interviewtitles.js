"use strict";
/**
 * Interview id -> title, cached.
 *
 * Lifted out of bot 1 because classifying sessions by identity means the
 * suggestion strip needs titles too, and two copies of a lookup that decides
 * what counts as the trial is how the two consumers drifted apart in the first
 * place.
 *
 * interview.list is incomplete — it omits most interviews actually used on
 * schedules — so titles come from interview.info one id at a time. They change
 * rarely, so they are cached in lookup_cache indefinitely and shared across
 * every candidate: "Agent Shadowing" is one id reused on every FDE row, so
 * after the first warm-up this costs nothing.
 *
 * A lookup that fails is remembered as null for this resolver's lifetime, not
 * written to the cache, and reported by incomplete(). A failed title must never
 * be mistaken for a title that did not match.
 *
 * isDebrief IS THREE-VALUED, and that is the point of this file's second
 * revision. It used to be stored as !!iv.isDebrief, which collapsed "Ashby did
 * not report the flag" and "Ashby reported it false" into the same value. A
 * consumer that wanted to fall back only when Ashby was silent therefore could
 * not, and bot 1's debrief fallback fired on an explicit false instead. That
 * cost the FDS cohort its debrief reminder for a week. Nothing reads the
 * distinction today, because the fallback is gone, but the cache must not
 * destroy information its callers may later need to tell apart.
 *
 * CACHE NAMESPACE. The stored shape changed with it, so the kind is versioned.
 * Rows written under the old namespace are simply never read again; this is
 * the cache clear, and it needs no database access to take effect.
 */
const CACHE_KIND = "interview_v2";
const { mapLimit } = require("./http");

function createTitleResolver({ ashby, botStore, concurrency = 5 }) {
  const cache = new Map();
  let incomplete = false;

  async function load(interviewIds) {
    const wanted = [...new Set((interviewIds || []).filter(Boolean))].filter((id) => !cache.has(id));
    await mapLimit(wanted, concurrency, async (id) => {
      try {
        const hit = await botStore.lookupGet(CACHE_KIND, id);
        if (hit) return cache.set(id, hit);
        const iv = await ashby.getInterview(id);
        /* null means Ashby did not report the flag, false means it reported
           no. Consumers may treat them the same; the cache may not decide
           that for them. */
        const value = {
          title: iv.title || "",
          isDebrief: iv.isDebrief === undefined || iv.isDebrief === null ? null : !!iv.isDebrief,
        };
        await botStore.lookupPut(CACHE_KIND, id, value);
        cache.set(id, value);
      } catch (e) {
        incomplete = true;
        cache.set(id, null);
      }
    });
  }

  return {
    load,
    /** { title, isDebrief } or null when we could not find out. */
    get: (id) => cache.get(id) || null,
    incomplete: () => incomplete,
  };
}

module.exports = { createTitleResolver };
