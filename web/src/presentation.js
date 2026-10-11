/* Presentation catalogue: DOM instruments and canvas charts share semantic
 * colours. It is immutable, has no simulation hooks, and allocates once. */
(function (SE) {
  'use strict';
  /** @typedef {'ops'|'tactical'} MapMode */
  /** @typedef {{id:MapMode,bg:string,bgEdge:string,grid:number,gridA:number,cross:number,ink:string,inkHalo:string,sub:string,chipBg:number,chipInk:string,accent:number,accentCss:string,ret:number,lane:number,laneA:number,marker:number,warn:string,hostile:number,planet:number[],atmos:boolean,dust:boolean}} MapPalette */
  /** @type {Readonly<Record<string,string>>} */
  const tokens = Object.freeze({
    bg:'#050a12', panel:'#0d1927', line:'#2a4155', ink:'#e4eef7', muted:'#a5b7c9', dim:'#849aad',
    amber:'#ffb35c', cyan:'#73d9ef', green:'#83d6b4', danger:'#ff828c',
    'surface-low':'#08121e', 'surface-high':'#132436', 'stroke-soft':'#719cbd30',
    radius:'4px', 'panel-shadow':'0 12px 30px #0005,inset 0 1px #b9dfff06',
    sans:'Inter,"Segoe UI",Roboto,Arial,sans-serif', mono:'"SFMono-Regular",Consolas,"Liberation Mono",monospace'
  });
  /** @type {Readonly<Record<MapMode,MapPalette>>} */
  const maps = Object.freeze({
    ops: Object.freeze({
      id:'ops', bg:'#091522', bgEdge:'#040913', grid:0x547d9b, gridA:.16, cross:0x5e8099,
      ink:'#dcebf6', inkHalo:'#091522', sub:'#78c4db', chipBg:0x132a3c, chipInk:'#c7eafb',
      accent:0x73d9ef, accentCss:'#73d9ef', ret:0x6597b0, lane:0x7bbbd8, laneA:.13,
      marker:0xffb35c, warn:'#ff828c', hostile:0xf76e7d, planet:[0x647da0,0x817196,0x778d95,0xa18973],atmos:true,dust:true
    }),
    tactical: Object.freeze({
      id:'tactical', bg:'#080e19', bgEdge:'#03060d', grid:0x66749e, gridA:.13, cross:0x77849e,
      ink:'#e6edf7', inkHalo:'#080e19', sub:'#a5b6ce', chipBg:0x172039, chipInk:'#d7e5fa',
      accent:0xffb35c, accentCss:'#ffb35c', ret:0xc09563, lane:0xa1b8d3, laneA:.10,
      marker:0xffb35c, warn:'#ff828c', hostile:0xff7181, planet:[0x637392,0x86758f,0x6e8596,0xa18b76],atmos:true,dust:true
    })
  });
  /** Apply at startup, before a scene creates a texture. @returns {void} */
  function install() {
    const style = document.documentElement.style;
    for (const [name,value] of Object.entries(tokens)) style.setProperty('--'+name,value);
    document.documentElement.dataset.presentation = 'deep-space';
  }
  /** @param {string} mode @returns {MapPalette} */
  function map(mode) { return maps[mode === 'tactical' ? 'tactical' : 'ops']; }
  // Freeze nested arrays as well: canvas clients never mutate a theme in place.
  for (const palette of Object.values(maps)) Object.freeze(palette.planet);
  /** Static distant stars stay on the compositor; zooming never rebuilds them. */
  const stars = Array.from({length:28}, (_,i) => {
    const x=(i*37+11)%100, y=(i*i*19+7)%100, alpha=i%5===0?.5:.23;
    return `radial-gradient(1px 1px at ${x}% ${y}%,rgba(190,218,243,${alpha}) 60%,transparent 100%)`;
  }).join(',');
  SE.Presentation = Object.freeze({ tokens, maps, map, install, stars });
  install();
})(window.SE = window.SE || {});
