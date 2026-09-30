/* Rendering adapter for the authoritative corridor graph. All route decisions live in transit.ts. */
(function (SE) {
  'use strict';
  /** @param {object} third @param {object} E @param {Reach.TransitLayout} layout */
  function TransitView(third, E, layout) {
    const THREE = E.THREE;
    const group = new THREE.Group();
    group.name = 'sector-transit';
    const vertices = [], colours = [], beacons = [];
    const cyan = new THREE.Color(0x6fceeb), amber = new THREE.Color(0xe0af6c);
    function line(ax, ay, az, bx, by, bz, colour) {
      vertices.push(ax, ay, az, bx, by, bz);
      for (let i = 0; i < 2; ++i) colours.push(colour.r, colour.g, colour.b);
    }
    for (const edge of layout.edges) {
      const a = layout.nodes[edge.a], b = layout.nodes[edge.b];
      const length = Math.hypot(b.x-a.x, b.z-a.z), dx=(b.x-a.x)/length, dz=(b.z-a.z)/length;
      for (const direction of [-1,1]) {
        const colour = direction === 1 ? cyan : amber, offset = SE.Transit.rules.lane*direction;
        // Paired dashed guides and arrows make direction legible without a solid luminous tube.
        for (let distance = 30; distance < length-25; distance += 110) {
          const x=a.x+dx*distance-dz*offset,z=a.z+dz*distance+dx*offset;
          line(x-dx*20,-7,z-dz*20,x+dx*20,-7,z+dz*20,colour);
          line(x,-7,z,x-dx*direction*12-dz*7,-7,z-dz*direction*12+dx*7,colour);
          line(x,-7,z,x-dx*direction*12+dz*7,-7,z-dz*direction*12-dx*7,colour);
          beacons.push({x:a.x+dx*distance-dz*96*direction,y:-7,z:a.z+dz*distance+dx*96*direction,colour});
        }
      }
    }
    const linesGeometry = new THREE.BufferGeometry();
    linesGeometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));
    linesGeometry.setAttribute('color',new THREE.Float32BufferAttribute(colours,3));
    const linesMaterial = new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:0.48,depthWrite:false});
    const lines = new THREE.LineSegments(linesGeometry,linesMaterial);group.add(lines);
    const beaconGeometry = new THREE.OctahedronGeometry(2.5,0), beaconMaterial = new THREE.MeshBasicMaterial({color:0xffffff});
    const markers = new THREE.InstancedMesh(beaconGeometry,beaconMaterial,beacons.length);
    const matrix = new THREE.Matrix4();
    beacons.forEach((point,index)=>{matrix.makeTranslation(point.x,point.y,point.z);markers.setMatrixAt(index,matrix);markers.setColorAt(index,point.colour);});
    markers.instanceMatrix.needsUpdate=true;markers.frustumCulled=false;group.add(markers);
    const gateGeometry = new THREE.TorusGeometry(108,3.5,6,48), gateMaterial = new THREE.MeshBasicMaterial({color:0x507f99});
    const exits = Object.values(layout.gates), gates = new THREE.InstancedMesh(gateGeometry,gateMaterial,exits.length);
    const transform = new THREE.Object3D();
    exits.forEach((node,index)=>{const p=layout.nodes[node];transform.position.set(p.x,p.y,p.z);transform.lookAt(0,0,0);transform.updateMatrix();gates.setMatrixAt(index,transform.matrix);});
    gates.instanceMatrix.needsUpdate=true;gates.frustumCulled=false;group.add(gates);
    third.scene.add(group);
    let destroyed=false;
    return {group,destroy(){if(destroyed)return;destroyed=true;third.scene.remove(group);linesGeometry.dispose();linesMaterial.dispose();beaconGeometry.dispose();beaconMaterial.dispose();gateGeometry.dispose();gateMaterial.dispose();markers.dispose?.();gates.dispose?.();}};
  }
  SE.TransitView=TransitView;
})(window.SE=window.SE||{});
