/* Operations connect existing simulation results to deliberate expansion.
 * The Director owns the subscription and transaction boundary. This reducer
 * creates no timers, listeners, ships, cargo, or synthetic combat outcomes. */
(function (Reach) {
  'use strict';
  /** @typedef {'ore'|'freight'|'production'|'kills'|'investment'|'fitting'} Metric */
  /** @typedef {{metric:Metric,label:string,target:number,panel:string}} Goal */
  /** @typedef {{id:string,track:string,tier:number,title:string,sponsor:string,risk:string,brief:string,reward:number,xp:number,standing:number,goals:Goal[]}} Offer */
  /** @typedef {{id:string,phase:'running'|'ready',started:number,progress:Record<string,number>}} Active */
  /** @typedef {{version:1,active:Active|null,settled:string[],earned:number}} OperationState */
  /** @typedef {{ok:boolean,message:string}} Result */
  /** @typedef {{world:Object,state:Object,fleet:Object[],scene:Object,reputation:Function,log:Function,execute:Function}} DirectorPort */
  /** @type {Readonly<Record<string,{name:string,sponsor:string,risk:string,brief:string,goals:{metric:Metric,label:string,targets:number[],panel:string}[],rewards:number[]}>>} */
  const TRACKS = {
    prospect: {name:'Prospecting charter',sponsor:'apex',risk:'Commercial · exposed miners',brief:'Sell ore through your ships, then reinvest in a completed hull, a new facility or a facility upgrade. Normal ore revenue stays yours.',goals:[
      {metric:'ore',label:'Ore sold by your ships',targets:[60,240,720],panel:'fleet'},
      {metric:'investment',label:'Hulls commissioned / facilities built or upgraded',targets:[1,2,3],panel:'shipyard'}],rewards:[900,2000,4500]},
    supply: {name:'Industrial supply charter',sponsor:'apex',risk:'Logistics · vulnerable freight lanes',brief:'Produce real goods and deliver freight from your facilities. Market, industry and shipyard deliveries count; assigning a route alone does not.',goals:[
      {metric:'production',label:'Units produced by your facilities',targets:[100,350,900],panel:'industry'},
      {metric:'freight',label:'Units delivered by freight routes',targets:[60,240,720],panel:'fleet'}],rewards:[1500,3300,7200]},
    security: {name:'Frontier security charter',sponsor:'vanguard',risk:'Combat · permanent ship losses',brief:'Refit your flagship for the mission and defeat hostile contacts with your fleet. Losses and repairs come from your treasury. Peaceful ships never count.',goals:[
      {metric:'fitting',label:'Modules bought and fitted',targets:[1,1,2],panel:'outfit'},
      {metric:'kills',label:'Hostile ships or defences destroyed',targets:[2,5,12],panel:'fleet'}],rewards:[1200,2800,6200]}
  };
  /** @type {Record<string,Offer>} */
  const offers = {};
  for (const [track,spec] of Object.entries(TRACKS)) {
    for (let tier=1;tier<=3;tier++) {
      const id = track+'-'+tier;
      const goals = spec.goals.map(g=>Object.freeze({metric:g.metric,label:g.label,target:g.targets[tier-1],panel:g.panel}));
      offers[id] = Object.freeze({id,track,tier,title:spec.name,sponsor:spec.sponsor,risk:spec.risk,brief:spec.brief,reward:spec.rewards[tier-1],xp:[90,180,360][tier-1],standing:[3,5,8][tier-1],goals:Object.freeze(goals)});
    }
  }
  Object.freeze(offers);
  /** @param {unknown} id @returns {Offer|undefined} */
  const offerFor = id => typeof id==='string' && Object.prototype.hasOwnProperty.call(offers,id) ? offers[id] : undefined;
  /** @returns {OperationState} */
  const fresh = () => ({version:1,active:null,settled:[],earned:0});
  /** Reject damaged receipts: silently dropping one could award it twice.
   * Old saves without operations migrate to an empty ledger. @param {unknown} raw @returns {OperationState} */
  function restore(raw) {
    if (raw === undefined || raw === null) return fresh();
    if (typeof raw!=='object' || Array.isArray(raw) || raw.version!==1 || !Array.isArray(raw.settled) || raw.settled.length>9)
      throw new Error('Invalid operations ledger.');
    /** @type {string[]} */ const settled=[];
    for (const id of raw.settled) {
      const spec=offerFor(id);
      if (!spec || settled.includes(id) || (spec.tier>1 && !settled.includes(spec.track+'-'+(spec.tier-1)))) throw new Error('Invalid operation settlement sequence.');
      settled.push(id);
    }
    /** @type {Active|null} */ let active=null;
    if (raw.active!==null && raw.active!==undefined) {
      const a=raw.active, spec=offerFor(a.id);
      if (!spec || settled.includes(a.id) || !['running','ready'].includes(a.phase) || !Number.isFinite(a.started) || a.started<0 || !a.progress || typeof a.progress!=='object' || Array.isArray(a.progress) || (spec.tier>1 && !settled.includes(spec.track+'-'+(spec.tier-1))))
        throw new Error('Invalid active operation.');
      /** @type {Record<string,number>} */ const progress={};
      for (const g of spec.goals) {
        const n=a.progress[g.metric];
        if (!Number.isFinite(n) || n<0 || n>g.target) throw new Error('Invalid operation progress.');
        progress[g.metric]=n;
      }
      const done=spec.goals.every(g=>progress[g.metric]>=g.target);
      active={id:a.id,phase:done?'ready':'running',started:a.started,progress};
    }
    // Earned is derived from immutable receipts, never trusted as a second balance.
    return {version:1,active,settled,earned:settled.reduce((n,id)=>n+offers[id].reward,0)};
  }
  class Operations {
    /** @param {DirectorPort} director */
    constructor(director) {
      /** @type {DirectorPort} */ this.director=director;
      /** @type {OperationState} */ this.state=restore(director.state.operations);
      director.state.operations=this.state;
    }
    /** @returns {{offer:Offer,reason:string}[]} */
    board() {
      return Object.keys(TRACKS).map(track=>{
        const offer=Object.values(offers).find(o=>o.track===track && !this.state.settled.includes(o.id));
        return offer ? {offer,reason:this.locked(offer)} : null;
      }).filter(Boolean);
    }
    /** @param {Offer} offer @returns {string} */
    locked(offer) {
      const d=this.director;
      if (offer.tier>1 && !this.state.settled.includes(offer.track+'-'+(offer.tier-1))) return 'Settle the previous tier first.';
      if (SE.hostile('player',offer.sponsor)) return 'Make peace with '+SE.FACTIONS[offer.sponsor].name+'.';
      if (offer.track==='supply' && (!d.state.outposts.length || !d.fleet.some(s=>s.cls==='freighter'))) return 'Requires a facility and a freighter.';
      if (offer.track==='prospect' && !d.fleet.some(s=>SE.CLASSES[s.cls].miner)) return 'Requires a mining ship.';
      if (offer.track==='security' && d.fleet.filter(s=>SE.CLASSES[s.cls].weapon && !SE.CLASSES[s.cls].miner).length<2) return 'Requires two armed ships.';
      return '';
    }
    /** @param {string} id @returns {Result} */
    accept(id) {
      const spec=offerFor(id);
      if (!spec) return {ok:false,message:'Unknown operation.'};
      if (this.state.active) return {ok:false,message:'Settle or abandon the current operation first.'};
      if (this.state.settled.includes(id)) return {ok:false,message:'This operation is already settled.'};
      const reason=this.locked(spec);
      if (reason) return {ok:false,message:reason};
      const progress=Object.fromEntries(spec.goals.map(g=>[g.metric,0]));
      this.state.active={id,phase:'running',started:this.director.world.elapsed,progress};
      return {ok:true,message:spec.title+' accepted. Only new results count; open Operations to track them.'};
    }
    /** @param {Metric} metric @param {number} quantity @returns {void} */
    advance(metric,quantity) {
      const a=this.state.active;
      if (!a || a.phase!=='running' || !Number.isFinite(quantity) || quantity<=0) return;
      const spec=offers[a.id],goal=spec.goals.find(g=>g.metric===metric);
      if (!goal) return;
      a.progress[metric]=Math.min(goal.target,a.progress[metric]+quantity);
      if (spec.goals.every(g=>a.progress[g.metric]>=g.target)) {
        a.phase='ready';
        this.director.log(spec.title+' complete. Settle the operation to receive '+spec.reward+' cr.','gain');
      }
    }
    /** Feed committed simulation events, never button clicks. @param {Object} event @returns {void} */
    receive(event) {
      if (event.type==='trade' && event.ship?.owned && event.good==='ore') this.advance('ore',event.quantity);
      else if (event.type==='kill' && event.killer?.owned && event.victim && !event.victim.owned && SE.hostile('player',event.victim.faction)) this.advance('kills',1);
      else if (event.type==='commission' && event.owned) this.advance('investment',1);
      else if (event.type==='freight-delivered' && event.ship?.owned) this.advance('freight',event.quantity);
      else if (event.type==='industry-produced') this.advance('production',event.quantity);
    }
    /** @param {string} type @returns {void} */
    committed(type) {
      if (type==='industry.build' || type==='industry.upgrade') this.advance('investment',1);
      if (type==='module.fit') this.advance('fitting',1);
    }
    /** @param {string} id @returns {Result} */
    settle(id) {
      const a=this.state.active,spec=offerFor(id),d=this.director;
      if (!a || a.id!==id || a.phase!=='ready' || !spec || this.state.settled.includes(id)) return {ok:false,message:'No completed operation to settle.'};
      if (SE.hostile('player',spec.sponsor)) return {ok:false,message:'The sponsor has suspended payment during hostilities. Make peace to settle.'};
      // Commit receipt before feedback. Replayed clicks and save/reload cannot repay it.
      this.state.settled.push(id);this.state.active=null;this.state.earned+=spec.reward;
      d.world.credits+=spec.reward;d.state.xp+=spec.xp;d.reputation(spec.sponsor,spec.standing);
      return {ok:true,message:spec.title+' settled: +'+spec.reward+' cr, +'+spec.xp+' XP, +'+spec.standing+' '+SE.FACTIONS[spec.sponsor].short+' standing.'};
    }
    /** @param {string} id @returns {Result} */
    abandon(id) {
      if (!this.state.active || this.state.active.id!==id) return {ok:false,message:'That operation is no longer active.'};
      this.state.active=null;
      return {ok:true,message:'Operation abandoned. Progress is lost; fleet orders and cargo are unchanged.'};
    }
    /** Actionable guidance adapts when a miner dies, cargo is selling or a route stalls.
     * @returns {{label:string,panel:string,note:string,miner?:string}} */
    next() {
      const a=this.state.active,d=this.director;
      if (!a) return {label:'Choose an operation',panel:'contracts',note:'Prospect, supply industry or secure the frontier.'};
      if (a.phase==='ready') return {label:'Settle operation',panel:'contracts',note:'Your sponsor is ready to review the results.'};
      const spec=offers[a.id],g=spec.goals.find(goal=>a.progress[goal.metric]<goal.target);
      if (g.metric==='ore') {
        const miner=d.fleet.find(s=>!s.isPlayer && SE.CLASSES[s.cls].miner && SE.SECTOR_BY_ID[s.sector]?.belt && !['repair','freight'].includes(s.duty));
        if (!miner) return {label:'Review mining fleet',panel:'fleet',note:'A surviving miner needs a belt and a friendly buyer.'};
        if (miner.duty!=='mine') return {label:'Assign '+miner.name+' to mine',panel:'fleet',note:'It will extract, return and sell automatically.',miner:miner.id};
        return {label:'Inspect mining fleet',panel:'fleet',note:miner.name+' is mining. Return to the map to advance time; sales count when cargo reaches a buyer.'};
      }
      const notes={investment:'Commission a hull or build/upgrade a facility. A commissioned ship counts when construction finishes.',production:'Keep facilities supplied and funded. Suspended or input-starved plants produce nothing.',freight:'Assign a freighter to carry facility output. Only delivered goods count.',fitting:'Dock at a friendly station and buy a module for your flagship.',kills:'Use the system Tactical view to engage hostile ships. Protect damaged hulls and budget for repairs.'};
      return {label:{investment:'Reinvest in your operation',production:'Inspect production',freight:'Manage freight routes',fitting:'Refit your flagship',kills:'Command your combat fleet'}[g.metric],panel:g.panel,note:notes[g.metric]};
    }
  }
  Reach.OperationRules=Object.freeze({offers,restore,fresh});
  Reach.Operations=Operations;
})(Reach || (Reach = {}));
