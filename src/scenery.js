/* Distant scenery uses three shared meshes, independent of sector entity count. */
(function (SE) {
  'use strict';
  SE.Scenery = function (third, engine) {
    const THREE = engine.THREE;
    const root = new THREE.Group();
    const geometry = new THREE.SphereGeometry(1, 40, 28);
    const planetMaterial = new THREE.ShaderMaterial({
      uniforms: { day: { value: new THREE.Color(0x788e9d) }, bands: { value: new THREE.Color(0xb49b80) } },
      vertexShader: 'varying vec3 vN; varying vec3 vP; void main(){vN=normal;vP=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `varying vec3 vN; varying vec3 vP; uniform vec3 day; uniform vec3 bands;
        void main(){
          float latitude=vP.y*24.0+sin(vP.x*8.0+vP.z*4.0)*0.28;
          float grain=sin(latitude+sin(latitude*1.4)*0.75)*0.5+0.5;
          vec3 base=mix(day,bands,grain*0.55);
          float light=max(0.0,dot(normalize(vN),normalize(vec3(-0.7,0.6,0.65))));
          vec3 colour=base*(0.035+pow(light,0.8)*0.65);
          gl_FragColor=vec4(colour,1.0);
        }`, depthWrite: true, fog: false
    });
    const planet = new THREE.Mesh(geometry, planetMaterial);
    planet.position.set(-1560, 820, -2640); planet.scale.setScalar(810); planet.rotation.z = 0.3;
    root.add(planet);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){vec4 mv=modelViewMatrix*vec4(position,1.0);vN=normalize(normalMatrix*normal);vV=normalize(-mv.xyz);gl_Position=projectionMatrix*mv;}',
      fragmentShader: 'varying vec3 vN; varying vec3 vV; void main(){float rim=pow(1.0-abs(dot(normalize(vN),normalize(vV))),4.5);gl_FragColor=vec4(0.23,0.42,0.55,rim*0.22);}',
      transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending
    });
    const atmosphere = new THREE.Mesh(geometry, atmosphereMaterial);
    atmosphere.position.copy(planet.position); atmosphere.scale.setScalar(846); root.add(atmosphere);
    const ringGeometry = new THREE.RingGeometry(1040, 1340, 96);
    const ringMaterial = new THREE.MeshBasicMaterial({color: 0x9b8d78, transparent: true, opacity: 0.085, side: THREE.DoubleSide, depthWrite: false, fog: false});
    const ring = new THREE.Mesh(ringGeometry, ringMaterial);
    ring.position.copy(planet.position); ring.rotation.set(1.1, 0.4, -0.3); root.add(ring);
    third.scene.add(root);
    return {
      update(camera) { root.position.copy(camera.position); },
      dispose() { third.scene.remove(root); geometry.dispose(); planetMaterial.dispose(); atmosphereMaterial.dispose(); ringGeometry.dispose(); ringMaterial.dispose(); }
    };
  };
})(window.SE = window.SE || {});
