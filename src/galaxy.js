/* The galaxy map, and the only screen in the game that is not the cockpit.
 *
 * Drawn on its own 2D canvas in a DOM overlay rather than on the Phaser layer,
 * and that is a deliberate break from where the radar lives. The radar is part
 * of the glass you are flying behind: it is up sixty times a second, it has to
 * be in the same frame as the ship it describes, and it belongs on the game
 * canvas. This is a screen you STOP to read. It redraws when something changes
 * and not otherwise, it wants real text at real sizes, and it wants to cover
 * the game rather than float over it. That is a document, and documents are
 * cheaper and sharper in DOM.
 *
 * Territory is a Voronoi tessellation of the sector positions, coloured by
 * owner. This is the one place the brief's d3-delaunay earns its 19 KB: the
 * library was deliberately left out of the first build with a note saying it
 * would arrive with this screen, because a geometry library with no geometry
 * to do is 19 KB of nothing.
 *
 * Voronoi is also the right ANSWER and not just the available one. Faction
 * borders drawn as circles around each station say "this faction owns a radius";
 * drawn as a tessellation they say "space belongs to whoever is nearest, and
 * the border is wherever two claims meet" — which is how a border between two
 * powers with no natural frontier actually works, and it puts the contested
 * edge in exactly the place a player would guess.
 */
(function (SE) {
  'use strict';

  const PAD = 54;              // map margin in CSS pixels
  const NEUTRAL = 0x5a6472;

  function hex(n, a) {
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function Galaxy(ctx) {
    const root = document.getElementById('galaxy');
    const wrap = document.getElementById('gxwrap');
    const cv = document.getElementById('galaxymap');
    const g = cv.getContext('2d');
    const title = document.getElementById('gxwhere');
    const detail = document.getElementById('gxdetail');
    const setBtn = document.getElementById('gxset');

    let open = false;
    let picked = null;          // sector id the player has tapped
    let cells = null;           // Voronoi polygons, in map pixels
    let pts = null;             // sector centres, in map pixels
    let W = 0, H = 0, dpr = 1;
    const labelBoxes = []; // Reused across event-driven redraws, never a frame loop.

    /* Galaxy coordinates -> map pixels. Recomputed on every layout because the
       map is sized to whatever the screen is, and a phone rotates. */
    function project() {
      const S = SE.SECTORS;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const s of S) {
        if (s.gx < x0) x0 = s.gx; if (s.gx > x1) x1 = s.gx;
        if (s.gy < y0) y0 = s.gy; if (s.gy > y1) y1 = s.gy;
      }
      // Uniform scale on both axes: a galaxy stretched to fill a portrait
      // screen is a galaxy whose distances lie, and distance is the whole
      // content of this picture.
      const k = Math.min((W - PAD * 2) / Math.max(1, x1 - x0), (H - Math.min(PAD, H * 0.24) * 2) / Math.max(1, y1 - y0));
      const ox = (W - (x1 - x0) * k) / 2 - x0 * k;
      const oy = (H - (y1 - y0) * k) / 2 - y0 * k;
      pts = S.map(s => ({ id: s.id, x: s.gx * k + ox, y: s.gy * k + oy }));

      /* The Voronoi is computed over a box much larger than the screen and
         then drawn clipped. Computed at the screen edge instead, the outermost
         cells get cut square against the viewport and the territory looks like
         it stops at the bezel rather than carrying on past it. */
      const D = window.d3 && window.d3.Delaunay;
      cells = null;
      if (D) {
        const d = D.from(pts.map(p => [p.x, p.y]));
        const v = d.voronoi([-W, -H, W * 2, H * 2]);
        cells = pts.map((p, i) => v.cellPolygon(i));
      }
    }

    function layout() {
      /* Measured from the WRAP, not from the overlay.
         Measuring the overlay sized the canvas to the full screen height while
         it was positioned inside a flex slot shorter than that, so it spilled
         over the footer — and an absolutely positioned canvas on top of a
         button eats the button's taps. The map looked perfect and SET COURSE
         could not be pressed, on a phone or in a test. */
      const r = wrap.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      W = Math.max(1, Math.round(r.width));
      H = Math.max(1, Math.round(r.height));
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      project();
    }

    // How many hulls of each persuasion are sitting in a sector right now. The
    // registry is the authority whether or not the sector is the live one,
    // which is the point of the whole state/view split.
    function census(id) {
      const list = ctx.ships(id);
      let mine = 0, foe = 0, guns = 0;
      for (const s of list) {
        if (s.dead) continue;
        const cls = SE.CLASSES[s.cls];
        if (cls.tier === 'emplacement') { if (SE.hostile(s.faction, 'player')) guns++; continue; }
        if (cls.tier === 'structure') continue;
        if (s.owned) mine++;
        else if (SE.hostile(s.faction, 'player')) foe++;
      }
      return { mine, foe, guns };
    }

    function draw() {
      if (!open) return;
      const here = ctx.here();
      g.clearRect(0, 0, W, H);labelBoxes.length=0;
      g.fillStyle='#091722';g.fillRect(0,0,W,H);
      g.strokeStyle='#86b7cd0b';g.lineWidth=1;g.beginPath();
      for(let x=24;x<W;x+=40){g.moveTo(x,0);g.lineTo(x,H);}
      for(let y=24;y<H;y+=40){g.moveTo(0,y);g.lineTo(W,y);}g.stroke();
      for(let i=0;i<64;i++){const x=(i*173.31+31)%W,y=(i*i*19.73+17)%H;g.fillStyle=i%3?'#b7d6e92b':'#b7d6e957';g.fillRect(x,y,1,1);}
      g.font='9px ui-monospace,monospace';g.textAlign='left';g.fillStyle='#92adbf';
      g.fillText('SECTOR NETWORK / '+pts.length.toString().padStart(2,'0'),16,24);
      if(H>260){g.fillStyle='#efbc7f';g.fillRect(16,H-24,5,5);g.fillStyle='#92adbf';g.fillText('CURRENT SECTOR',29,H-19);}


      // Territory.
      if (cells) {
        for (let i = 0; i < pts.length; i++) {
          const poly = cells[i];
          if (!poly) continue;
          const sec = SE.SECTOR_BY_ID[pts[i].id];
          const col = sec.owner ? (SE.FACTIONS[sec.owner] || {}).colour || NEUTRAL : NEUTRAL;
          g.beginPath();
          g.moveTo(poly[0][0], poly[0][1]);
          for (let k = 1; k < poly.length; k++) g.lineTo(poly[k][0], poly[k][1]);
          g.closePath();
          g.fillStyle = hex(col, sec.owner ? 0.065 : 0.025);
          g.fill();
          g.strokeStyle = hex(col, sec.owner ? 0.25 : 0.12);
          g.lineWidth = 1;
          g.stroke();
        }
      }

      // Lanes.
      g.lineWidth = 1.4;
      g.strokeStyle = 'rgba(130,203,216,.35)';
      for (const [a, b] of SE.LANES) {
        const A = pts.find(p => p.id === a), B = pts.find(p => p.id === b);
        g.beginPath(); g.moveTo(A.x, A.y); g.lineTo(B.x, B.y); g.stroke();
      }

      // The route to wherever the player has tapped, over the top of the lanes.
      if (picked && picked !== here) {
        const path = SE.route(here, picked);
        if (path && path.length > 1) {
          g.lineWidth = 2.6;
          g.strokeStyle = 'rgba(239,188,127,.95)';
          g.setLineDash([7, 5]);
          g.beginPath();
          for (let i = 0; i < path.length; i++) {
            const p = pts.find(q => q.id === path[i]);
            i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y);
          }
          g.stroke();
          g.setLineDash([]);
        }
      }

      // Sectors.
      g.textAlign = 'center';
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const sec = SE.SECTOR_BY_ID[p.id];
        const col = sec.owner ? (SE.FACTIONS[sec.owner] || {}).colour || NEUTRAL : NEUTRAL;
        const c = census(p.id);
        const isHere = p.id === here;
        const isPicked = p.id === picked;

        if (sec.station) {
          g.beginPath(); g.arc(p.x, p.y, 13, 0, Math.PI * 2);
          g.fillStyle = hex(col, 0.22); g.fill();
        }
        g.beginPath(); g.arc(p.x, p.y, sec.station ? 7 : 4.5, 0, Math.PI * 2);
        g.fillStyle = hex(col, 0.95); g.fill();

        if (isHere) {
          // Amber matches the bridge's primary-action and current-location accent.
          g.beginPath(); g.arc(p.x, p.y, 19, 0, Math.PI * 2);
          g.lineWidth = 2; g.strokeStyle = '#efbc7f'; g.stroke();
        }
        if (isPicked && !isHere) {
          g.beginPath(); g.arc(p.x, p.y, 22, 0, Math.PI * 2);
          g.lineWidth = 1.6; g.strokeStyle = 'rgba(63,224,200,.9)'; g.setLineDash([4, 4]);
          g.stroke(); g.setLineDash([]);
        }

        // Bounded label placement keeps neighbouring sector names readable on narrow phones.
        // Reject overlaps with earlier labels and all node hit areas; geometry itself stays undistorted.
        const name=sec.name.toUpperCase();
        const status=isHere?'CURRENT SYSTEM':(c.foe+c.guns)?(c.foe+c.guns)+' HOSTILE CONTACTS':sec.station?'STATION SERVICES':'OPEN SPACE';
        g.font='600 10px ui-monospace,monospace';const nameWidth=g.measureText(name).width;
        g.font='8px ui-monospace,monospace';
        const labelWidth=Math.min(W-12,Math.max(72,nameWidth+16,g.measureText(status).width+16));
        const labelHeight=34;
        let bestBox=null,bestPenalty=Infinity;
        for(const dy of [23,-58,42,-76,61,80,-96,100]){
          for(const dx of [0,-48,48,-80,80,-120,120,-160,160]){
            const box={x:Math.max(6,Math.min(W-labelWidth-6,p.x-labelWidth/2+dx)),y:Math.max(32,Math.min(H-labelHeight-8,p.y+dy)),w:labelWidth,h:labelHeight};
            let penalty=Math.abs(dx)*0.02+Math.abs(dy-23)*0.01;
            for(const other of labelBoxes){const width=Math.min(box.x+box.w,other.x+other.w)-Math.max(box.x,other.x),height=Math.min(box.y+box.h,other.y+other.h)-Math.max(box.y,other.y);if(width>-4&&height>-4)penalty+=1000+Math.max(0,width)*Math.max(0,height);}
            for(const node of pts){if(node.x>box.x-17&&node.x<box.x+box.w+17&&node.y>box.y-17&&node.y<box.y+box.h+17)penalty+=10000;}
            if(penalty<bestPenalty){bestPenalty=penalty;bestBox=box;}
          }
        }
        bestBox.id=p.id;labelBoxes.push(bestBox);
        const labelX=bestBox.x+bestBox.w/2;
        g.lineWidth=1;g.strokeStyle='#83b5ca36';g.beginPath();g.moveTo(p.x,p.y);g.lineTo(labelX,bestBox.y+labelHeight/2);g.stroke();
        g.fillStyle=isHere?'#172b36f2':'#0b1b28ed';g.fillRect(bestBox.x,bestBox.y,bestBox.w,bestBox.h);
        g.strokeStyle=isHere?'#efbc7f65':'#6d9ab338';g.strokeRect(bestBox.x,bestBox.y,bestBox.w,bestBox.h);
        g.font='600 10px ui-monospace,monospace';g.fillStyle='#e1edf3';g.fillText(name,labelX,bestBox.y+13);
        g.font='8px ui-monospace,monospace';g.fillStyle=c.foe||c.guns?'#eaa690':'#a1c7d6';

        g.fillText(status,labelX,bestBox.y+26);

      }
    }

    function describe() {
      const here = ctx.here();
      title.textContent = SE.SECTOR_BY_ID[here].name;
      if (!picked || picked === here) {
        detail.textContent = 'Tap a sector to plot a course.';
        setBtn.disabled = true;
        setBtn.textContent = 'SET COURSE';
        return;
      }
      const sec = SE.SECTOR_BY_ID[picked];
      const path = SE.route(here, picked);
      const c = census(picked);
      const hops = path.length - 1;
      const owner = sec.owner ? SE.FACTIONS[sec.owner].name : 'Unclaimed';
      detail.textContent = sec.name + ' — ' + owner + ' · ' + hops + ' jump' + (hops === 1 ? '' : 's') +
        (c.foe || c.guns ? ' · ' + (c.foe + c.guns) + ' hostile' : '') +
        (sec.station ? ' · ' + sec.station : ' · no station');
      setBtn.disabled = false;
      setBtn.textContent = 'SET COURSE — ' + path[1].toUpperCase();
    }

    function tap(ev) {
      const r = cv.getBoundingClientRect();
      const t = ev.changedTouches ? ev.changedTouches[0] : ev;
      const x = t.clientX - r.left, y = t.clientY - r.top;
      const label=labelBoxes.find(box=>x>=box.x&&x<=box.x+box.w&&y>=box.y&&y<=box.y+box.h);
      let best = label?label.id:null, bd = label?0:44;
      for (const p of pts) {
        const d = Math.hypot(p.x - x, p.y - y);
        if (d < bd) { bd = d; best = p.id; }
      }
      if (best) { picked = (picked === best) ? null : best; describe(); draw(); }
    }

    cv.addEventListener('pointerdown', tap);
    window.addEventListener('resize', () => { if (open) { layout(); draw(); } });

    return {
      get open() { return open; },
      show() {
        open = true;
        picked = ctx.courseTo() || null;
        root.classList.add('on');
        layout(); describe(); draw();
      },
      hide() { open = false; root.classList.remove('on'); },
      toggle() { open ? this.hide() : this.show(); },
      get picked() { return picked; },
      refresh() { if (open) { describe(); draw(); } }
    };
  }

  SE.Galaxy = Galaxy;
})(window.SE = window.SE || {});
