/* One AI, two worlds.
 *
 * Every ship in the game runs the same state machine over the same order
 * queue. What changes is only the last step: a ship with a physics view gets
 * its intent turned into thruster forces and angular velocity, and a ship
 * without one gets the same intent integrated as arithmetic. A freighter
 * hauling ore three sectors away is running the code the wingman beside you is
 * running, and when you jump to its sector it does not change behaviour — it
 * just grows a rigid body.
 *
 * So think() must never touch a mesh, a body, or the renderer. If it needs
 * something from the world it asks `world`, which is a small interface the
 * sector provides and the out-of-sector simulator stubs out.
 */
(function (SE) {
  'use strict';

  const ARRIVE = 46;        // metres that count as "there" for a MOVE order
  const ENGAGE = 520;       // open fire inside this
  const BREAK_OFF = 900;    // give up a chase past this
  const MINE_RANGE = 120;   // mining laser reach
  const AGGRO = 620;        // how far a patrol goes looking for trouble
  const FLEE_FROM = 760;    // how far a hauler runs before it feels safe
  const STUCK_SPEED = 3.5;  // below this, with somewhere to be, means wedged
  const STUCK_SECS = 2.4;   // ...for this long

  /* Forward vector of a stored quaternion, without allocating a THREE.Vector3
     to find out. Derived from rotating (0,0,-1) — three.js's forward — by q. */
  function forward(s, out) {
    const x = s.qx, y = s.qy, z = s.qz, w = s.qw;
    out.x = -2 * (w * y + z * x);
    out.y = 2 * (w * x - z * y);
    out.z = 2 * (x * x + y * y) - 1;
    return out;
  }

  const _f = { x: 0, y: 0, z: 0 };
  const _d = { x: 0, y: 0, z: 0 };

  /* ---- think() --------------------------------------------------------
     Reads the front of the order queue and returns an intent. Pops the order
     when it is satisfied. Returns the same shaped object every call — one
     module-level intent, reused, because this runs for every ship every tick
     and a fresh object each time is a garbage collection pause with a delay. */
  const intent = { sx: 0, sy: 0, sz: 0, throttle: 0, fire: false, target: null, mine: -1, brake: false };

  function think(s, world, dt) {
    intent.throttle = 0; intent.fire = false; intent.target = null;
    intent.mine = -1; intent.brake = false;
    intent.sx = s.x; intent.sy = s.y; intent.sz = s.z;

    if (s.dead) return intent;

    const cls = SE.CLASSES[s.cls];
    /* Stations and emplacements think, but never move. They reach further than
       a ship does — a defence platform that has to wait until something is
       inside a corvette's gun range before it notices is not defending
       anything — and an emplacement reaches further still, because reach is
       the only advantage a thing with no engine has. */
    if (SE.isStatic(cls)) {
      const reach = SE.isEmplacement(cls) ? SE.WEAPONS[cls.weapon].range * 1.05 : ENGAGE * 1.6;
      const foe = world.nearestHostile(s, reach);
      if (foe) { intent.target = foe.id; intent.fire = true; }
      return intent;
    }

    s.orderT += dt;
    let order = s.orders[0];

    // No orders: fall back to the standing brief for this hull and faction.
    if (!order) { order = idleOrder(s, world); if (!order) return intent; s.orders.push(order); s.orderT = 0; }

    switch (order.type) {

      case 'MOVE': {
        const d2 = dist2(s, order);
        seek(s, order, intent);
        if (d2 < ARRIVE * ARRIVE) { pop(s); intent.brake = true; intent.throttle = 0; }
        // Self-defence while travelling: a ship under fire that keeps flying
        // its waypoint reads as broken, not as disciplined.
        const foe = world.nearestHostile(s, ENGAGE);
        if (foe) { intent.target = foe.id; intent.fire = inArc(s, foe, cls); }
        break;
      }

      case 'ATTACK': {
        const foe = world.get(order.target);
        if (!foe || foe.dead) { pop(s); break; }
        if (foe.sector !== s.sector) { pop(s); break; }
        const d2 = dist2(s, foe);
        intent.target = foe.id;
        if (d2 > BREAK_OFF * BREAK_OFF && order.committed !== true) {
          // Chase, but remember we chose to — otherwise a target that runs
          // makes the attacker oscillate between pursuing and disengaging.
          order.committed = true;
        }
        seek(s, foe, intent);
        // Close to knife range, then hold station rather than ramming through.
        if (d2 < 130 * 130) { intent.throttle *= 0.25; }
        intent.fire = d2 < ENGAGE * ENGAGE && inArc(s, foe, cls);
        break;
      }

      case 'MINE': {
        if (SE.cargoUsed(s) >= s.cargoMax) { pop(s); break; }
        const node = world.mineNode(s, order.node);
        if (!node) { pop(s); break; }
        const d2 = dist2(s, node);
        seek(s, node, intent);
        if (d2 < MINE_RANGE * MINE_RANGE) {
          intent.throttle *= 0.12;
          intent.mine = node.index;
          const got = world.mine(s, node, dt);
          if (got <= 0) { order.node = -1; }       // node is spent, find another
        }
        break;
      }

      case 'TRADE': {
        const st = world.get(order.station);
        if (!st) { pop(s); break; }
        const d2 = dist2(s, st);
        seek(s, st, intent);
        const dockAt = (SE.CLASSES[st.cls].size + cls.size) * 1.9;
        if (d2 < dockAt * dockAt) {
          intent.brake = true; intent.throttle = 0;
          world.trade(s, st, order.good);
          pop(s);
        }
        break;
      }

      case 'GUARD': {
        const lead = world.get(order.target);
        if (!lead || lead.dead) { pop(s); break; }
        // Station-keeping offset, so a wing of three does not stack into one
        // silhouette. Derived from the guard's own id, so it is stable.
        const k = order.slot || 0;
        const off = 70 + k * 34;
        _d.x = lead.x + Math.cos(k * 2.1) * off;
        _d.y = lead.y + 14 * (k % 2 ? 1 : -1);
        _d.z = lead.z + Math.sin(k * 2.1) * off;
        const foe = world.nearestHostile(s, ENGAGE);
        if (foe) {
          intent.target = foe.id;
          seek(s, foe, intent);
          intent.fire = inArc(s, foe, cls);
        } else {
          const d2 = dist2(s, _d);
          seek(s, _d, intent);
          if (d2 < ARRIVE * ARRIVE) { intent.throttle = 0; intent.brake = true; }
        }
        break;
      }

      case 'JUMP': {
        // Fly to the lane exit, then hand off to the sector transfer. In this
        // slice only out-of-sector ships actually complete the jump; the
        // player's own jump drive is not built yet.
        const exit = world.laneExit(s.sector, order.to);
        if (!exit) { pop(s); break; }
        seek(s, exit, intent);
        if (dist2(s, exit) < (ARRIVE * 2) * (ARRIVE * 2)) {
          world.jump(s, order.to);
          pop(s);
        }
        break;
      }

      case 'FLEE': {
        // Run directly away and keep running until there is distance. A hauler
        // that turns and fights is a hauler the player never has to escort,
        // and escorting convoys is meant to be a thing worth paying for.
        const threat = world.get(order.from);
        if (!threat || threat.dead || threat.sector !== s.sector) { pop(s); break; }
        const away = dist2(s, threat);
        if (away > FLEE_FROM * FLEE_FROM) { pop(s); break; }
        const d = Math.sqrt(away) || 1;
        intent.sx = s.x + (s.x - threat.x) / d * 900;
        intent.sy = s.y + (s.y - threat.y) / d * 900;
        intent.sz = s.z + (s.z - threat.z) / d * 900;
        intent.throttle = 1;
        break;
      }

      case 'WAIT': {
        intent.brake = true;
        if (s.orderT >= (order.secs || 2)) pop(s);
        break;
      }

      default: pop(s);
    }

    /* ---- Steering corrections, applied to whatever the order decided -----
       Both of these exist because of the same playtest note: AI ships were
       getting wedged in the belt. An order picks a destination; these two stop
       a ship driving into a rock on the way there, and dig it out when it has
       already managed to. */
    if (intent.throttle > 0 && world.avoid) {
      forward(s, _f);
      if (world.avoid(s, _f, _d)) {
        intent.sx += _d.x; intent.sy += _d.y; intent.sz += _d.z;
        // Back off the power while threading a gap. Full throttle into a
        // deflection just means hitting the rock at an angle.
        intent.throttle *= 0.62;
      }
    }

    // Wedged: something to do, and no progress made toward doing it. Give it a
    // shove perpendicular to wherever it was trying to go, which is almost
    // always out of whatever it has driven itself into.
    const moving = Math.hypot(s.vx, s.vy, s.vz);
    if (intent.throttle > 0 && moving < STUCK_SPEED) {
      s.stuckT = (s.stuckT || 0) + dt;
      if (s.stuckT > STUCK_SECS) {
        const dx = intent.sx - s.x, dz = intent.sz - s.z;
        const l = Math.hypot(dx, dz) || 1;
        intent.sx = s.x - dz / l * 220;
        intent.sy = s.y + 120;
        intent.sz = s.z + dx / l * 220;
        intent.throttle = 1;
        if (s.stuckT > STUCK_SECS + 2.5) s.stuckT = 0;
      }
    } else if (s.stuckT) {
      s.stuckT = 0;
    }

    return intent;
  }

  function pop(s) { s.orders.shift(); s.orderT = 0; }

  function dist2(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    return dx * dx + dy * dy + dz * dz;
  }

  // Point the intent at a destination and ask for full throttle. Callers scale
  // the throttle down afterwards when they want a gentler approach.
  function seek(s, to, it) {
    it.sx = to.x; it.sy = to.y; it.sz = to.z;
    it.throttle = 1;
  }

  /* Fixed forward guns only fire when the nose is near the target. Turrets
     track independently and do not care, which is most of what makes a capital
     ship feel like one. */
  function inArc(s, foe, cls) {
    if (cls.weapon === 'turret') return true;
    forward(s, _f);
    let dx = foe.x - s.x, dy = foe.y - s.y, dz = foe.z - s.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    return (_f.x * dx + _f.y * dy + _f.z * dz) > 0.965;   // ~15 degrees
  }

  /* ---- Standing briefs ------------------------------------------------
     What a ship does when nobody has told it anything. This is most of the
     galaxy most of the time, so it is deliberately cheap: pick one order, run
     it to completion, pick another. */
  function idleOrder(s, world) {
    const cls = SE.CLASSES[s.cls];
    const f = s.faction;

    // A hauler checks for trouble before it checks for work.
    if (cls.miner || s.cls === 'freighter') {
      const near = world.nearestHostile(s, AGGRO * 0.8);
      if (near) return { type: 'FLEE', from: near.id };
    }
    if (cls.miner && SE.cargoUsed(s) < s.cargoMax) return { type: 'MINE', node: -1 };
    if (cls.miner || s.cls === 'freighter') {
      const st = world.stationFor(s);
      if (st) return { type: 'TRADE', station: st.id, good: 'ore' };
      // Full hold, no buyer in this sector. Take the first leg of the shortest
      // route to one. This is what makes the galaxy graph load-bearing rather
      // than decorative: a miner working a lawless belt eventually shows up at
      // somebody else's station carrying what it dug out.
      if (world.routeToMarket && SE.cargoUsed(s) > s.cargoMax * 0.5) {
        const leg = world.routeToMarket(s);
        if (leg) return { type: 'JUMP', to: leg };
      }
    }
    /* Who starts fights, and with whom.

       This used to be "any armed ship attacks the nearest hostile within 1,400
       metres", which is most of the inhabited part of a sector. On the first
       tick after loading, every armed ship in Tarpon Reach found somebody to
       hate, and the player arrived into a brawl already in progress that had
       nothing to do with them.

       Two changes. Aggression reaches a fifth as far, so a patrol notices what
       is near it rather than everything it can see. And the factions now want
       different things instead of all wanting the same thing:

         pirates  hunt CARGO. A Scrapper picks off haulers and miners and
                  leaves warships alone unless one shoots first — which is
                  both how piracy works and what makes escorting a convoy a
                  job worth paying somebody for.
         patrols  hunt PIRATES. Vanguard is police; it goes after Scrappers
                  and ignores everyone else.
         corporate never starts anything. Apex pays other people to fight.

       Being shot at still overrides all of this — onHit pushes an ATTACK to
       the front of the queue regardless of who you are. */
    if (f === 'scrapper') {
      const prey = world.nearestHostileMatching(s, AGGRO, t =>
        SE.CLASSES[t.cls].miner || t.cls === 'freighter');
      if (prey) return { type: 'ATTACK', target: prey.id };
    } else if (f === 'vanguard') {
      const pirate = world.nearestHostileMatching(s, AGGRO, t => t.faction === 'scrapper');
      if (pirate) return { type: 'ATTACK', target: pirate.id };
    }
    const p = world.patrolPoint(s);
    return p ? { type: 'MOVE', x: p.x, y: p.y, z: p.z } : { type: 'WAIT', secs: 3 };
  }

  /* ---- Applying the intent, in-sector ---------------------------------
     Rotation is steered by setting angular velocity rather than by applying
     torque and letting a PD loop settle. Real torque control on a body with
     260 mass oscillates for a second and a half before it points anywhere, and
     on a phone that reads as input lag rather than as weight. Weight comes
     from the per-class turn-rate ceiling and from translation, which IS real
     force through a real rigid body against real inertia.
  */
  function applyPhysical(s, it, dt, body) {
    const cls = SE.stats(s);

    // --- rotation: shortest arc from current forward to desired forward
    forward(s, _f);
    let dx = it.sx - s.x, dy = it.sy - s.y, dz = it.sz - s.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 0.001 && it.throttle > 0) {
      dx /= len; dy /= len; dz /= len;
      // axis = forward x desired, angle = acos(forward . desired)
      const ax = _f.y * dz - _f.z * dy;
      const ay = _f.z * dx - _f.x * dz;
      const az = _f.x * dy - _f.y * dx;
      const dot = Math.max(-1, Math.min(1, _f.x * dx + _f.y * dy + _f.z * dz));
      const angle = Math.acos(dot);
      const axLen = Math.hypot(ax, ay, az);
      const maxRate = cls.torque / Math.sqrt(cls.mass) * 0.42;   // rad/s ceiling
      if (axLen > 1e-5) {
        const rate = Math.min(angle / Math.max(dt, 1 / 60), maxRate);
        body.setAngularVelocity(ax / axLen * rate, ay / axLen * rate, az / axLen * rate);
      } else if (dot < -0.999) {
        // Exactly backwards: the cross product is degenerate, so pick any
        // perpendicular axis and let the next frame do it properly.
        body.setAngularVelocity(0, maxRate, 0);
      }
    } else {
      body.setAngularVelocity(0, 0, 0);
    }

    // --- translation: thrust along the nose, never along the seek vector.
    // Thrusting straight at the destination regardless of facing is how a
    // space game stops feeling like flying and starts feeling like dragging.
    const v = body.velocity;
    const speed = Math.hypot(v.x, v.y, v.z);
    if (it.brake || it.throttle <= 0) {
      // Retro-burn rather than a hard stop, capped so it cannot reverse.
      const k = Math.min(1, (cls.thrust * 0.9) * dt / (cls.mass * Math.max(speed, 0.001)));
      body.setVelocity(v.x * (1 - k), v.y * (1 - k), v.z * (1 - k));
    } else {
      forward(s, _f);
      const t = cls.thrust * it.throttle;
      body.applyCentralForce(_f.x * t, _f.y * t, _f.z * t);
      // Soft top speed by drag rather than a clamp: a clamp makes every ship
      // hit exactly the same wall and kills the sense of a drive straining.
      if (speed > cls.topSpeed) {
        const over = Math.min(1, (speed - cls.topSpeed) / cls.topSpeed);
        const k = over * 2.6 * dt;
        body.setVelocity(v.x * (1 - k), v.y * (1 - k), v.z * (1 - k));
      }
    }
  }

  /* ---- Applying the intent, out of sector -----------------------------
     The same intent, integrated. No collision, no arc, no drag curve: turn
     toward the destination at the class's agility, move forward at the class's
     top speed scaled by throttle. It has to agree with the physical version
     closely enough that a fleet does not teleport when you jump into its
     sector, and it does not have to agree any more closely than that. */
  function applyAbstract(s, it, dt) {
    const cls = SE.stats(s);
    if (SE.isStatic(cls)) return;

    let dx = it.sx - s.x, dy = it.sy - s.y, dz = it.sz - s.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.001 || it.throttle <= 0) {
      s.vx *= 0.94; s.vy *= 0.94; s.vz *= 0.94;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      return;
    }
    dx /= len; dy /= len; dz /= len;

    // Rotate the stored forward toward the desired one at the class's agility,
    // then rebuild the quaternion from that forward so the ship still has a
    // real orientation when it comes back into view.
    forward(s, _f);
    const turn = Math.min(1, cls.agility * dt);
    let nx = _f.x + (dx - _f.x) * turn;
    let ny = _f.y + (dy - _f.y) * turn;
    let nz = _f.z + (dz - _f.z) * turn;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    quatFromForward(s, nx, ny, nz);

    // Only make headway to the degree the nose is already pointed there, which
    // is what stops an OOS freighter cornering like a fighter.
    const align = Math.max(0, nx * dx + ny * dy + nz * dz);
    const sp = cls.topSpeed * it.throttle * (0.35 + 0.65 * align);
    const step = Math.min(sp * dt, len);
    s.vx = nx * sp; s.vy = ny * sp; s.vz = nz * sp;
    s.x += nx * step; s.y += ny * step; s.z += nz * step;
  }

  /* Shortest-arc quaternion taking (0,0,-1) to the given unit forward. Written
     out rather than borrowed from THREE so that the out-of-sector simulator
     has no renderer dependency at all — it must be able to run in a worker. */
  function quatFromForward(s, fx, fy, fz) {
    // axis = (0,0,-1) x f ; angle = acos((0,0,-1) . f)
    const ax = -fy, ay = fx, az = 0;
    const dot = -fz;
    const al = Math.hypot(ax, ay, az);
    if (al < 1e-6) {
      if (dot > 0) { s.qx = 0; s.qy = 0; s.qz = 0; s.qw = 1; }
      else { s.qx = 0; s.qy = 1; s.qz = 0; s.qw = 0; }   // 180 degrees about Y
      return;
    }
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
    const sh = Math.sin(angle / 2);
    s.qx = ax / al * sh; s.qy = ay / al * sh; s.qz = az / al * sh;
    s.qw = Math.cos(angle / 2);
  }

  SE.AI = { think, applyPhysical, applyAbstract, forward, quatFromForward, ARRIVE, ENGAGE, MINE_RANGE };
})(window.SE = window.SE || {});
