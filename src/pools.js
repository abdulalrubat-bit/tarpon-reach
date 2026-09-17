/* Object pools.
 *
 * Nothing that appears and disappears during combat is ever allocated during
 * combat. Lasers, salvage crates and impact flashes are built once at boot,
 * parked inactive, and recycled forever. The win is not the allocation — V8 is
 * fast at that — it is that a pool never gives the collector anything to
 * collect, and a collection pause during a firefight is the one stutter a
 * player always notices.
 *
 * A pool that runs dry recycles its oldest live member rather than growing.
 * Growing mid-fight is exactly the allocation the pool exists to avoid, and
 * the oldest laser is the one nearest the end of its life anyway.
 */
(function (SE) {
  'use strict';

  function Pool(size, make, reset) {
    const items = new Array(size);
    for (let i = 0; i < size; i++) {
      const it = make(i);
      it._alive = false;
      it._born = 0;
      items[i] = it;
    }
    let cursor = 0;
    let stamp = 0;

    return {
      items,
      size,
      get live() { let n = 0; for (let i = 0; i < size; i++) if (items[i]._alive) n++; return n; },

      take() {
        // One sweep from the cursor; if everything is live, evict the oldest.
        for (let n = 0; n < size; n++) {
          const it = items[cursor];
          cursor = (cursor + 1) % size;
          if (!it._alive) { it._alive = true; it._born = ++stamp; return it; }
        }
        let oldest = items[0];
        for (let i = 1; i < size; i++) if (items[i]._born < oldest._born) oldest = items[i];
        reset(oldest);
        oldest._born = ++stamp;
        return oldest;
      },

      give(it) {
        if (!it._alive) return;
        it._alive = false;
        reset(it);
      },

      forEachLive(fn) {
        for (let i = 0; i < size; i++) if (items[i]._alive) fn(items[i], i);
      },

      releaseAll() {
        for (let i = 0; i < size; i++) if (items[i]._alive) { items[i]._alive = false; reset(items[i]); }
      }
    };
  }

  SE.Pool = Pool;
})(window.SE = window.SE || {});
