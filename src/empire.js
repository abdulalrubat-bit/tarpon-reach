/* The empire host: the game with no cockpit.
 *
 * This replaces the 3D sector scene. There is no live sector any more and no
 * rigid bodies: every ship in the galaxy, the player's flagship included, is
 * run by the same arithmetic that always ran the sectors nobody was looking
 * at (world.tickOOS). That was the architecture's one promise — ai.js never
 * learns whether anyone is watching — and it is what makes removing the
 * cockpit a matter of deleting the view rather than rewriting the game.
 *
 * The star chart is the main screen. You send your fleet by setting a course;
 * the flagship flies the lanes one jump at a time on ordinary JUMP orders and
 * its escorts go with it. A port is any friendly station in the system your
 * flagship is in. Everything the command deck (reach/director.js and
 * reach/shell.js) expects of a "scene" is provided here, with the flight-only
 * parts reduced to inert stand-ins until they are removed from the deck.
 */
(function (SE) {
  'use strict';

  const OOS_STEP = 0.25;        // simulation step, seconds
  const MAX_FRAME = 0.25;       // a backgrounded tab does not come back to a minute of catch-up
  const MAP_REFRESH = 0.5;      // seconds between map redraws while it is showing

  // A system whose owner would shoot the player's fleet on sight.
  function hostileHeld(id) {
    const sec = SE.SECTOR_BY_ID[id];
    return !!(sec && sec.owner && sec.owner !== 'player' && SE.hostile('player', sec.owner));
  }

  function EmpireHost() {
    const host = this;
    const world = SE.populate(SE.World(window.SE_SEED || 'tarpon-1'));
    world.headless = true;
    this.world = world;
    this.loading = true;
    this.views = {};              // no bodies; kept because the deck reads it
    this.speed = 0;
    this.playerTarget = null;
    this.mineNode = -1;
    this.course = null;           // { to } — the far end; legs are re-derived
    this.accumulator = 0;
    this.mapClock = 0;
    this.pace = 1;                // game speed: 1x, 2x or 4x
    this.motionClock = { ticks: 0, droppedSeconds: 0, reset() {} };

    // Inert stand-ins for the flight controls the deck still touches.
    this.controls = { state: { throttle: 0, pitch: 0, yaw: 0, firing: false, boost: false }, sens: 1, reset() {} };
    this.cameraRig = { zoom() {}, orbit() {}, mode: 'follow', recenter() {}, beginOrbit() {} };
    this.scene = { pause() {}, resume() {} };
    this.dock = { show() {}, hide() {}, refresh() {} };

    this.galaxy = SE.Galaxy({
      here: () => world.sectorId,
      ships: id => world.registry.inSector(id),
      courseTo: () => this.course ? this.course.to : null,
      route: (a, b) => this.route(a, b),
      hostileHeld: id => hostileHeld(id)
    });

    this.missions = SE.Missions(world);
    world.onOOSKill = (victim, killer) => this.missions.onKill(victim, killer);
    world.onSay = msg => this.say(msg);
    world.onJump = (ship, to) => this.onJump(ship, to);

    this.persist = SE.Persistence();
    this.wireSaveOnExit();

    this.restore().then(() => {
      this.loading = false;
      this.playerSector = world.player.sector;
      world.sectorId = this.playerSector;
      this.director = new SE.Director(this);
      window.SE_READY = true;
      this.last = performance.now();
      requestAnimationFrame(t => this.frame(t));
    }).catch(error => {
      document.getElementById('bootmsg').textContent = 'COMMANDER FILE NEEDS ATTENTION';
      const detail = document.getElementById('boot-error');
      detail.textContent = error.message;
      detail.classList.remove('hidden');
    });

    // Bound once so a frame does not allocate a closure.
    this._frame = t => host.frame(t);
  }

  EmpireHost.prototype = {
    frame(now) {
      const dt = Math.min(MAX_FRAME, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      if (!this.loading && this.director && !this.director.paused) this.step(dt * this.pace);
      requestAnimationFrame(this._frame);
    },

    step(dt) {
      const w = this.world;
      this.accumulator += dt;
      while (this.accumulator >= OOS_STEP) {
        this.accumulator -= OOS_STEP;
        w.elapsed += OOS_STEP;
        this.steerFlagship();
        w.tickOOS(OOS_STEP);
        this.motionClock.ticks++;
        const me = w.player;
        if (me && me.dead) this.flagshipLost(me);
      }
      const me = w.player;
      this.speed = me ? Math.hypot(me.vx, me.vy, me.vz) : 0;
      this.director.tick(dt);
      this.missions.tick();
      this.mapClock += dt;
      if (this.mapClock >= MAP_REFRESH) { this.mapClock = 0; this.galaxy.refresh(); this.director.shell.updateMap(); }
    },

    /* The flagship has no pilot, so it needs standing orders like any other
       hull: fly the next leg of the course if there is one, otherwise hold
       station off the local port. A flagship with no orders would fall back
       to the AI's idle brief and wander off on patrol. */
    steerFlagship() {
      const w = this.world, me = w.player;
      if (!me || me.dead) return;
      const leg = this.nextLeg();
      const head = me.orders[0];
      if (leg) {
        if (!head || head.type !== 'JUMP' || head.to !== leg.leg) {
          me.orders = [{ type: 'JUMP', to: leg.leg }];
          me.orderT = 0;
        }
        return;
      }
      if (head) return;
      const port = w.iface(me.sector).stationFor(me);
      const berth = port ? w.transit.dockPoint(port, me) : null;
      me.orders = berth && Math.hypot(me.x - berth.x, me.z - berth.z) > 60
        ? [{ type: 'MOVE', x: berth.x, y: berth.y, z: berth.z }]
        : [{ type: 'WAIT', secs: 6 }];
      me.orderT = 0;
    },

    /* The fleet travels together. Leaving your own escorts behind in a system
       you have left is technically the simulation working, and is a bug
       report every single time. */
    onJump(ship, to) {
      if (!ship.isPlayer) return;
      const w = this.world;
      const from = this.playerSector;
      const api = w.iface(from);
      const going = w.registry.inSector(from).filter(s => s.owned && !s.isPlayer && !s.dead &&
        (!s.duty || s.duty === 'escort'));
      for (const s of going) api.jump(s, to);
      let k = 0;
      for (const s of going) {
        const a = (k++) * 2.2;
        s.x = ship.x + Math.cos(a) * 52; s.z = ship.z + Math.sin(a) * 52; s.y = ship.y;
      }
      this.playerSector = to;
      w.sectorId = to;
      if (this.course && this.course.to === to) {
        this.course = null;
        this.say('ARRIVED ' + SE.SECTOR_BY_ID[to].name.toUpperCase());
      }
      w.events.emit({ type: 'sector', sector: to });
      this.galaxy.refresh();
      this.autosave(true);
    },

    /* Rebuilt at a friendly port rather than game over. This is a sandbox; a
       permadeath rule in a game about building an empire deletes the empire. */
    flagshipLost(me) {
      const w = this.world;
      const fee = Math.round(w.credits * 0.35);
      w.credits -= fee;
      me.dead = false;
      me.hull = me.hullMax;
      me.shield = me.shieldMax;
      me.cargo = {};
      me.orders = [];
      this.course = null;
      const home = w.get('st_home');
      if (home && me.sector !== home.sector) w.iface(me.sector).jump(me, home.sector);
      me.x = 0; me.z = SE.Transit.rules.dockStop + 40; me.y = 0;
      me.vx = me.vy = me.vz = 0;
      this.director.log(`${me.name} was lost and towed to port.` + (fee ? ` ${fee.toLocaleString('en-US')} cr in salvage fees.` : ''), 'warn');
    },

    /* The fleet's route: shortest, but a hostile stronghold costs eight
       lanes' worth to pass through, so the fleet goes round one whenever
       there is any reasonable way round. Flying through Scrapper space on the
       shortest line is how a flagship meets four gun platforms at once. */
    route(from, to) { return SE.route(from, to, id => hostileHeld(id) ? 8 : 1); },

    /* A jump is about half a minute of real flying at 1x, which is right for
       watching a fight and long for crossing a map. Faster time costs only
       more of the same arithmetic per frame. */
    cyclePace() {
      this.pace = this.pace === 1 ? 2 : this.pace === 2 ? 4 : 1;
      const b = document.getElementById('gx-pace');
      if (b) b.textContent = this.pace + '×';
      return this.pace;
    },

    setCourse(to) {
      const here = this.world.sectorId;
      if (!to || to === here) { this.clearCourse(); return; }
      const path = this.route(here, to);
      if (!path) return;
      this.course = { to };
      this.say('COURSE ' + SE.SECTOR_BY_ID[to].name.toUpperCase() + ' — ' + (path.length - 1) + ' JUMP' + (path.length === 2 ? '' : 'S'));
      this.galaxy.refresh();
    },

    clearCourse() {
      this.course = null;
      const me = this.world.player;
      if (me && me.orders[0] && me.orders[0].type === 'JUMP') me.orders = [];
    },

    // The next hop and its lane mouth, re-derived from where the flagship is.
    nextLeg() {
      if (!this.course) return null;
      const here = this.world.sectorId;
      if (this.course.to === here) return null;
      const path = this.route(here, this.course.to);
      if (!path || path.length < 2) return null;
      const exit = this.world.iface(here).laneExit(here, path[1]);
      return exit ? { leg: path[1], exit, hops: path.length - 1 } : null;
    },

    /* Buying and fitting are one action, because they are one decision. */
    buyModule(id) {
      if (this.director && !this.director.atPort) return 'DOCK BEFORE REFITTING';
      const me = this.world.player, m = SE.MODULES[id];
      if (!m) return 'unknown module';
      if (this.world.credits < m.cost) return 'NOT ENOUGH CREDITS';
      const err = SE.fitModule(me, id);
      if (err) return err;
      this.world.credits -= m.cost;
      this.autosave(true);
      return null;
    },

    unfitModule(id) {
      if (this.director && !this.director.atPort) return 'DOCK BEFORE REFITTING';
      const me = this.world.player, m = SE.MODULES[id];
      const err = SE.unfitModule(me, id);
      if (err) return err;
      this.world.credits += Math.round(m.cost * 0.5);
      this.autosave(true);
      return null;
    },

    // Kept for the deck's sake: there are no bodies to refit or attach.
    refitView() {}, attach() {}, resetMotion() {}, setQuality() {},

    say(msg) { if (this.director && this.director.shell) this.director.shell.toast(String(msg), 'info'); },

    autosave(quiet) {
      if (this.loading || this._gone) return Promise.resolve(0);
      const snap = SE.snapshot(this.world);
      return this.persist.save(snap).then(bytes => {
        if (bytes && !quiet) this.say('SAVED — ' + Math.round(bytes / 1024) + ' KB');
        return bytes;
      }).catch(err => { this.say('SAVE FAILED: ' + err.message); return 0; });
    },

    wireSaveOnExit() {
      const flush = () => { if (!this._gone) { try { this.autosave(true); } catch (e) { /* leaving anyway */ } } };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
      window.addEventListener('pagehide', flush);
    },

    async restore() {
      let data = null;
      try { data = await this.persist.load(); }
      catch (err) { throw new Error('Your existing commander could not be read. No save was overwritten. ' + err.message); }
      if (!data) return;
      if (data.seed !== this.world.seed) throw new Error('This commander belongs to a different universe seed. No save was overwritten.');
      const w = this.world;
      // Rebuild the registry from the file rather than patching the generated
      // one: reconciling born-later and died-since ships is a bug farm.
      w.registry.all.slice().forEach(s => w.registry.remove(s));
      SE.setNextId(data.nextId || 1);
      data.ships.forEach(r => {
        const s = SE.makeShip({ id: r.id, name: r.name, cls: r.cls, faction: r.faction, sector: r.sector, isPlayer: r.isPlayer, owned: r.owned });
        Object.assign(s, {
          x: r.x, y: r.y, z: r.z, qx: r.qx, qy: r.qy, qz: r.qz, qw: r.qw,
          vx: r.vx, vy: r.vy, vz: r.vz, hull: r.hull, shield: r.shield,
          cargo: r.cargo || {}, credits: r.credits || 0, orders: r.orders || [], dead: !!r.dead,
          duty: r.duty, commanderId: r.commanderId, escortOf: r.escortOf, damageAt: r.damageAt
        });
        if (r.fit) { s.fit = r.fit; SE.bumpFit(s); }
        w.registry.add(s);
      });
      if (data.galaxy !== SE.GALAXY_SEED) SE.populateMissing(w);
      w.credits = data.credits;
      w.empire = data.empire;
      w.economyState = data.economy;
      w.contracts = data.contracts || [];
      w.completed = data.completed || [];
      w.boards = {};
      w.elapsed = data.elapsed || 0;
      w.stationStock = data.stations || {};
      w.beltState = data.belts || {};
      w.sectorId = data.sector || 'home';
      // A save taken mid-flight may hold a flagship order aimed at a sector it
      // has since been moved out of; the flagship re-plans on the first step.
      const me = w.player;
      if (me) me.orders = [];
      window.SE_RESTORED = true;
    }
  };

  SE.EmpireHost = EmpireHost;
  SE.boot = function () { window.SE_HOST = new EmpireHost(); };
})(window.SE = window.SE || {});
