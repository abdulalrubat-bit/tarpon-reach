/* Shared procedural ship art. Nose is -Y; dimensions are normalized to one
 * unit. Map sprites, fleet cards and inspectors use the same cached drawing. */
(function (SE) {
  'use strict';

  /** @typedef {[number, number]} Point */
  /** @typedef {{hull: Point[], engines: number[][], canopy: number[], panels?: number[][], turrets?: Point[], pods?: number[][], min: number, base: number, max: number}} HullSpec */
  /** @type {Record<string, HullSpec>} */
  const SHAPES = {
    interceptor: {
      hull: [[0,-1],[.18,-.35],[.76,.55],[.34,.42],[.18,.84],[-.18,.84],[-.34,.42],[-.76,.55],[-.18,-.35]],
      engines: [[0,.84,.13]], canopy: [0,-.3,.09,.25],
      panels: [[-.19,-.2,-.48,.48],[.19,-.2,.48,.48]], min: 22, base: 27, max: 34
    },
    corvette: {
      hull: [[0,-1],[.27,-.62],[.29,.02],[.48,.23],[.48,-.08],[.66,.08],[.66,.83],[.43,.83],[.31,.58],[.22,.91],[-.22,.91],[-.31,.58],[-.43,.83],[-.66,.83],[-.66,.08],[-.48,-.08],[-.48,.23],[-.29,.02],[-.27,-.62]],
      engines: [[-.54,.83,.1],[.54,.83,.1]], canopy: [0,-.44,.11,.19],
      pods: [[-.63,.18,.17,.47],[.46,.18,.17,.47]], turrets: [[0,.2]], min: 27, base: 33, max: 42
    },
    extractor: {
      hull: [[-.57,-1],[-.29,-1],[-.24,-.39],[.24,-.39],[.29,-1],[.57,-1],[.57,-.18],[.67,.05],[.6,.65],[.32,.89],[-.32,.89],[-.6,.65],[-.67,.05],[-.57,-.18]],
      engines: [[-.28,.89,.12],[.28,.89,.12]], canopy: [0,-.03,.16,.1],
      pods: [[-.55,.14,.27,.4],[.28,.14,.27,.4]], panels: [[-.3,.64,.3,.64]], min: 28, base: 34, max: 42
    },
    freighter: {
      hull: [[0,-1],[.24,-.82],[.24,-.58],[.57,-.58],[.57,-.13],[.24,-.13],[.24,-.02],[.57,-.02],[.57,.43],[.24,.43],[.24,.56],[.38,.56],[.38,.9],[-.38,.9],[-.38,.56],[-.24,.56],[-.24,.43],[-.57,.43],[-.57,-.02],[-.24,-.02],[-.24,-.13],[-.57,-.13],[-.57,-.58],[-.24,-.58],[-.24,-.82]],
      engines: [[-.23,.9,.11],[.23,.9,.11]], canopy: [0,-.77,.12,.07],
      pods: [[-.54,-.55,.28,.39],[.26,-.55,.28,.39],[-.54,.01,.28,.39],[.26,.01,.28,.39]], min: 30, base: 37, max: 46
    },
    dreadnought: {
      hull: [[-.12,-1],[.12,-1],[.3,-.67],[.3,-.31],[.49,-.03],[.49,.32],[.63,.47],[.63,.86],[.35,.86],[.28,.97],[-.28,.97],[-.35,.86],[-.63,.86],[-.63,.47],[-.49,.32],[-.49,-.03],[-.3,-.31],[-.3,-.67]],
      engines: [[-.46,.86,.1],[0,.97,.17],[.46,.86,.1]], canopy: [0,.36,.12,.11],
      pods: [[-.44,-.01,.18,.49],[.26,-.01,.18,.49]], turrets: [[0,-.6],[0,-.24],[-.31,.15],[.31,.15]],
      panels: [[-.15,-.78,-.15,.69],[.15,-.78,.15,.69]], min: 40, base: 49, max: 62
    }
  };
  const SIZE = 128, UNIT = SIZE * .43;
  const cache = new Map(), urls = new Map();
  const PALETTES = {
    ops: { edge: '#f6f0df', line: '#192a2d', side: '#334348', face: '#73868a', ridge: '#a3afb0', seam: '#24383d' },
    tactical: { edge: '#07191e', line: '#bbd1d3', side: '#415961', face: '#819ba2', ridge: '#c3d3d5', seam: '#263e46' }
  };
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const css = n => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);

  function shadeInt(c, k) {
    const ch = n => Math.round(k < 0 ? n * (1 + k) : n + (255 - n) * k);
    return (ch(c >> 16 & 255) << 16) | (ch(c >> 8 & 255) << 8) | ch(c & 255);
  }

  // Normalize before caching: unknown save/mod values cannot grow the cache.
  function identity(cls, faction, mode = 'tactical', detail = 'full') {
    const c = own(SHAPES, cls) ? cls : 'corvette';
    const f = own(SE.FACTIONS, faction) ? faction : 'apex';
    const m = mode === 'ops' ? 'ops' : 'tactical';
    const d = detail === 'small' ? 'small' : 'full';
    return { cls: c, faction: f, mode: m, detail: d, key: [c, f, m, d].join(':') };
  }

  /** Map canvas side in CSS pixels, independent of device pixel ratio.
   * Zoom supplies context, but even capitals remain smaller than the port. */
  function mapSize(cls, zoomRatio = 1) {
    const p = own(SHAPES, cls) ? SHAPES[cls] : SHAPES.corvette;
    const z = Number.isFinite(zoomRatio) ? Math.max(0, zoomRatio) : 1;
    return Math.max(p.min, Math.min(p.max, p.base * Math.pow(z, .16)));
  }

  function canvas(cls, faction, mode = 'tactical', detail = 'full') {
    const id = identity(cls, faction, mode, detail);
    if (cache.has(id.key)) return cache.get(id.key);
    const shape = SHAPES[id.cls], p = PALETTES[id.mode], small = id.detail === 'small';
    const cv = document.createElement('canvas'); cv.width = cv.height = SIZE;
    const c = cv.getContext('2d'), u = UNIT;
    const factionColour = SE.FACTIONS[id.faction]?.colour ?? 0x8a96a6;
    // Darker markings on cream, brighter on the night plot.
    const trim = css(shadeInt(factionColour, id.mode === 'ops' ? -.15 : .15));
    c.translate(SIZE / 2, SIZE / 2); c.lineJoin = 'round';
    const path = points => {
      c.beginPath(); points.forEach(([x, y], i) => i ? c.lineTo(x*u, y*u) : c.moveTo(x*u, y*u)); c.closePath();
    };
    const rect = (x,y,w,h,fill) => { c.fillStyle = fill; c.fillRect(x*u,y*u,w*u,h*u); };
    const line = (x,y,xx,yy,colour,width) => { c.beginPath(); c.moveTo(x*u,y*u); c.lineTo(xx*u,yy*u); c.strokeStyle=colour; c.lineWidth=width; c.stroke(); };
    const grad = c.createLinearGradient(-u,0,u,0);
    grad.addColorStop(0,p.side); grad.addColorStop(.48,p.face); grad.addColorStop(.5,p.ridge); grad.addColorStop(1,p.side);
    path(shape.hull); c.fillStyle = grad; c.fill();
    // A thin background keyline separates hulls from station detail. No bloom.
    c.strokeStyle = p.edge; c.lineWidth = small ? 7 : 5; c.stroke();
    c.strokeStyle = p.line; c.lineWidth = small ? 3.5 : 2.3; c.stroke();
    c.save(); path(shape.hull); c.clip();
    for (const [x,y,w,h] of shape.pods || []) {
      rect(x,y,w,h,p.side); rect(x+.025,y+.025,w-.05,h-.05,p.face);
      rect(x+.025,y+.025,w-.05,small ? .12 : .075,trim);
      if (!small) line(x+.06,y+h-.055,x+w-.055,y+h-.055,p.ridge,1.3);
    }
    // Consistent faction livery: nose, shoulders, and an aft ownership stripe.
    rect(-.3,-.71,.6,.13,trim);
    if (!shape.pods) {
      line(-.25,.06,-.5,.47,trim,small ? 7 : 5);
      line(.25,.06,.5,.47,trim,small ? 7 : 5);
    }
    rect(-.21,.56,.42,.11,trim);
    if (!small) {
      for (const [x,y,xx,yy] of shape.panels || []) line(x,y,xx,yy,p.seam,1.6);
      line(0,-.93,0,.5,p.ridge,1.4);
      for (const [x,y] of shape.turrets || []) {
        rect(x-.075,y-.055,.15,.13,p.seam);
        rect(x-.035,y-.17,.07,.16,p.ridge);
      }
    }
    const [cx,cy,cw,ch] = shape.canopy;
    rect(cx-cw,cy-ch,cw*2,ch*2,p.seam);
    rect(cx-cw*.7,cy-ch*.7,cw*1.4,ch*1.2,id.mode === 'ops' ? '#b7dadd' : '#d5eeee');
    c.restore();
    for (const [x,y,w] of shape.engines) {
      rect(x-w,y-.1,w*2,.11,p.seam);
      rect(x-w*.7,y-.04,w*1.4,.045,'#91cbd1');
    }
    cache.set(id.key,cv); return cv;
  }

  function icon(cls, faction, mode = 'tactical', detail = 'full') {
    const id = identity(cls,faction,mode,detail);
    if (!urls.has(id.key)) urls.set(id.key,canvas(id.cls,id.faction,id.mode,id.detail).toDataURL());
    return urls.get(id.key);
  }
  SE.ShipArt = { SHAPES, canvas, icon, shadeInt, identity, mapSize };
})(window.SE = window.SE || {});
