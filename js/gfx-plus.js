// ===================== Graphics upgrade (الكورنيش اللانهائي) =====================
//  * real-time sun shadows (soft PCF, a shadow box that follows the car, texel-snapped so it never shimmers)
//  * contact shadows (soft ambient-occlusion blobs) under the player and every traffic car
//  * live reflection probe: a cube map rendered around the player car (one face per frame) and used by the player's
//    paint / glass / chrome and by the traffic cars -> the cars really reflect the road, buildings, sky, lamps and other cars
//  * HDR post-processing: the scene renders into a half-float buffer (MSAA), then bloom (lights, sun glints, sea sparkle),
//    a soft highlight shoulder, colour grading, vignette and dithering
//  * dry-asphalt sheen: Fresnel reflection of the horizon on the road at grazing angles (dark binder / wheel tracks shine more)
//  * palm trees along both sidewalks of the corniche (instanced, wind sway, alpha-tested fronds that cast dappled shadows)
// Loaded after game.js; quality follows the existing presets (auto/high/medium/low) with overrides in Settings > Graphics.
(function(){
'use strict';
if(typeof THREE==='undefined'||typeof renderer==='undefined'||typeof scene==='undefined'){console.warn('gfx-plus: game not ready');return}
const clamp=(v,a,b)=>v<a?a:v>b?b:v,sstep=(a,b,x)=>{x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x)};
const GL2=!!renderer.capabilities.isWebGL2,HDR=GL2&&!!renderer.extensions.get('EXT_color_buffer_float');
const PRE={auto:{sh:2048,post:true,refl:256,rd:2},high:{sh:2048,post:true,refl:256,rd:1},medium:{sh:1024,post:true,refl:128,rd:3},low:{sh:0,post:false,refl:0,rd:0}}; // rd = render one probe face every rd frames
const X={sh:0,post:false,refl:0,rd:1,postAtStart:null};      // effective settings
const preset=()=>PRE[(typeof GFX!=='undefined'&&GFX.mode)||'auto']||PRE.auto;

// =====================================================================================================
// 1) SHADOWS
// =====================================================================================================
const SUN={base:new THREE.Vector3(80,120,-40).normalize(),half:50};
scene.add(sun.target);
sun.shadow.camera.near=10;sun.shadow.camera.far=320;
sun.shadow.bias=-.0007;if('normalBias' in sun.shadow)sun.shadow.normalBias=.06;   // no acne on grazing body panels
renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;
// Clear day: a lower, slightly back-lit sun (~30 deg) in the same direction as the sun disc in the sky -> long palm / car shadows
// across the road and the sea glitter ahead, GTA-style. Night (moon) and overcast winter keep the game's own light directions.
const DAY_SUN=new THREE.Vector3(.55,.5,-.67).normalize();
function captureSun(){
  if(!isNight&&weatherMode!=='winter'){
    SUN.base.copy(DAY_SUN);sun.intensity=1.0;
    try{seaU.sunD.value.copy(DAY_SUN);sunSpr.position.copy(DAY_SUN).multiplyScalar(1300)}catch(e){}
  }else if(isNight&&weatherMode!=='winter'){
    // clear night: the moon hangs low ahead over the sea (visible from the chase camera, a glitter path on the water)
    SUN.base.set(.42,.36,-.83).normalize();
    try{seaU.sunD.value.copy(SUN.base)}catch(e){}
  }else SUN.base.copy(sun.position).normalize();
  sun.castShadow=X.sh>0&&weatherMode!=='winter';
}
const _stod=setTimeOfDay;
setTimeOfDay=function(){const r=_stod.apply(this,arguments);try{captureSun();applyEnvMaps();updateGrade()}catch(e){console.warn(e)}return r};
const _sx=new THREE.Vector3(),_sy=new THREE.Vector3(),_sc=new THREE.Vector3(),UP=new THREE.Vector3(0,1,0);
function shadowFollow(){
  if(!renderer.shadowMap.enabled||!sun.castShadow)return;
  const L=SUN.base,ahead=(typeof view!=='undefined'&&view===2)?12:20;
  _sc.set(car.position.x-Math.sin(st.h)*ahead,car.position.y,car.position.z-Math.cos(st.h)*ahead);
  // snap the box centre to whole shadow-map texels in light space (static shadows stay perfectly still while driving)
  _sx.crossVectors(UP,L).normalize();_sy.crossVectors(L,_sx);
  const tx=SUN.half*2/X.sh,a=_sc.dot(_sx),b=_sc.dot(_sy);
  _sc.addScaledVector(_sx,Math.round(a/tx)*tx-a).addScaledVector(_sy,Math.round(b/tx)*tx-b);
  sun.target.position.copy(_sc);sun.position.copy(_sc).addScaledVector(L,150);
  sun.target.updateMatrixWorld();sun.updateMatrixWorld();
  renderer.shadowMap.needsUpdate=true;
}
function setShadowSize(sz){
  X.sh=sz;
  const on=sz>0;
  if(renderer.shadowMap.enabled!==on){renderer.shadowMap.enabled=on;forceRecompile()}
  if(on){
    const c=sun.shadow.camera;c.left=-SUN.half;c.right=SUN.half;c.top=SUN.half;c.bottom=-SUN.half;c.updateProjectionMatrix();
    if(sun.shadow.mapSize.x!==sz){sun.shadow.mapSize.set(sz,sz);if(sun.shadow.map){sun.shadow.map.dispose();sun.shadow.map=null}}
  }
  sun.castShadow=on&&weatherMode!=='winter';
  renderer.shadowMap.needsUpdate=true;
}
function forceRecompile(){scene.traverse(o=>{const m=o.material;if(!m)return;for(const x of (Array.isArray(m)?m:[m]))if(x)x.needsUpdate=true})}
// which meshes cast / receive: flat ground layers never cast (no acne, cheaper), glass / additive / custom shaders are skipped
const FLAT=new Set([asM,sandM,lipM,ground.material,...medM,...swM,...swLM,...curbM].filter(Boolean));
const isLit=m=>m&&(m.isMeshLambertMaterial||m.isMeshPhongMaterial||m.isMeshStandardMaterial);
function flagShadows(o,cast){
  if(!o.isMesh||o.userData._shd)return;o.userData._shd=1;
  const ms=Array.isArray(o.material)?o.material:[o.material];
  if(ms.some(m=>m&&m.isShaderMaterial))return;
  if(!ms.some(isLit))return;
  o.receiveShadow=true;
  const see=ms.some(m=>m&&m.transparent&&(m.opacity<.98||m.blending===THREE.AdditiveBlending));
  o.castShadow=cast&&!see&&!ms.some(m=>FLAT.has(m))&&!o.userData.noCast;
}
function shadowScan(){
  for(const s of segs)s.g.traverse(o=>flagShadows(o,true));
  if(typeof ROADBATCH!=='undefined')ROADBATCH.group.traverse(o=>flagShadows(o,true));
  if(BR.group)BR.group.traverse(o=>flagShadows(o,true));
  if(TUN.group)TUN.group.traverse(o=>flagShadows(o,true));
  car.traverse(o=>{if(o.isMesh&&!o.userData._shdc){o.userData._shdc=1;const ms=Array.isArray(o.material)?o.material:[o.material];
    if(ms.some(m=>m&&m.transparent&&m.opacity<.98))o.castShadow=false;o.receiveShadow=o.castShadow||o.receiveShadow}});
  for(const v of trafficCars){if(v.root.userData._shd)continue;v.root.userData._shd=1;v.root.traverse(o=>{if(o.isMesh&&!o.userData.noDent){const ms=Array.isArray(o.material)?o.material:[o.material];if(ms.some(isLit)){o.castShadow=true;o.receiveShadow=true}}});addBlob(v.root,v.hull)}
  if(POL&&POL.car&&POL.car.root&&!POL.car.root.userData._shd){POL.car.root.userData._shd=1;POL.car.root.traverse(o=>{if(o.isMesh){o.castShadow=true;o.receiveShadow=true}});addBlob(POL.car.root,POL.car.hull)}
  for(const im of bldInst)im.receiveShadow=true;
}

// =====================================================================================================
// 2) CONTACT SHADOWS (soft AO under the cars)
// =====================================================================================================
const blobT=(()=>{const W=128,H=256,c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d'),im=g.createImageData(W,H),D=im.data;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const u=(x+.5)/W*2-1,v=(y+.5)/H*2-1,d=Math.pow(Math.pow(Math.abs(u),3.2)+Math.pow(Math.abs(v),3.2),1/3.2),a=Math.pow(clamp(1-d,0,1),1.35)*1.25,o=(y*W+x)*4;D[o]=D[o+1]=D[o+2]=0;D[o+3]=Math.round(clamp(a,0,1)*255)}
  g.putImageData(im,0,0);const t=new THREE.CanvasTexture(c);t.anisotropy=4;return t})();
const blobM=new THREE.MeshBasicMaterial({map:blobT,color:0x000000,transparent:true,opacity:.62,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-3});
const blobG=new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2);
function addBlob(root,hull){
  if(root.userData._blob)return;
  const m=new THREE.Mesh(blobG,blobM);m.name='contactShadow';m.userData.noDent=true;m.userData.noCast=true;m.renderOrder=1;
  const hw=hull&&hull.hw||.9,hl=hull&&hull.hl||2.25;m.scale.set(hw*2*1.12,1,hl*2*1.06);m.position.y=.045;
  m.frustumCulled=true;root.add(m);root.userData._blob=m;
}
const playerBlob=new THREE.Mesh(blobG,blobM);playerBlob.name='contactShadowPlayer';playerBlob.userData.noDent=true;playerBlob.userData.noCast=true;playerBlob.renderOrder=1;playerBlob.position.y=.05;car.add(playerBlob);
if(typeof CAR_PERM!=='undefined')CAR_PERM.add(playerBlob);                       // survives car switching
function sizePlayerBlob(){
  if(typeof BIKE!=='undefined'&&BIKE){playerBlob.scale.set(.75,1,2.1);return}
  const hw=(typeof PLAYER_HW!=='undefined'?PLAYER_HW:.92),hl=(typeof PLAYER_HL!=='undefined'?PLAYER_HL:2.28);playerBlob.scale.set(hw*2*1.12,1,hl*2*1.05);
}

// =====================================================================================================
// 3) LIVE REFLECTIONS (cube map probe at the player car)
// =====================================================================================================
// Double-buffered: faces are rendered into the back cube while every car samples the front one (a car may never sample the
// texture it is being drawn into: that is a GPU feedback loop and the draw is dropped). The cubes swap after each full cycle.
const ENV={rts:[],front:0,cam:null,size:0,face:0,tick:0,on:false,primed:false};
const envTex=()=>ENV.rts.length?ENV.rts[ENV.front].texture:null;
function envEnsure(sz){
  if(sz<=0){if(ENV.on){ENV.on=false;applyEnvMaps()}return}
  if(ENV.rts.length&&ENV.size===sz){if(!ENV.on){ENV.on=true;applyEnvMaps()}return}
  for(const r of ENV.rts)r.dispose();
  ENV.size=sz;ENV.rts=[0,1].map(()=>new THREE.WebGLCubeRenderTarget(sz,{format:THREE.RGBAFormat,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter,magFilter:THREE.LinearFilter}));
  ENV.front=0;ENV.cam=new THREE.CubeCamera(.3,2000,ENV.rts[1]);ENV.face=0;ENV.on=true;ENV.primed=false;
  applyEnvMaps();
}
const _envHide=[];
function envHideAdd(o){if(o&&o.visible){o.visible=false;_envHide.push(o)}}
function renderEnvFace(i){
  const fc=ENV.cam.children[i],rt=ENV.rts[1-ENV.front];
  _envHide.length=0;
  envHideAdd(car);
  for(const R of [rainFar,rainNear])if(R&&R.mesh)envHideAdd(R.mesh);
  envHideAdd(rainCurtain);
  // cheap probe: nearby road / traffic only (the far scene is fog anyway)
  const px=car.position.x,pz=car.position.z;
  for(let k=0;k<segs.length;k++){const g=segs[k].g,dz=g.position.z-L/2-pz;if(Math.abs(dz)>210)envHideAdd(g)}
  for(let k=0;k<trafficCars.length;k++){const r=trafficCars[k].root,dx=r.position.x-px,dz=r.position.z-pz;if(dx*dx+dz*dz>130*130)envHideAdd(r)}
  if(i===3)for(let k=0;k<clouds.length;k++)envHideAdd(clouds[k]);   // the downward face never sees the sky
  try{
    syncBuildings(fc);
    if(typeof updateTrafficLOD==='function')updateTrafficLOD(fc,ENV.size);   // the probe is tiny: distant traffic uses its lightest model
    rt.texture.generateMipmaps=(i===5);
    renderer.setRenderTarget(rt,i);
    renderer.render(scene,fc);
  }finally{
    renderer.setRenderTarget(null);
    for(let k=_envHide.length-1;k>=0;k--)_envHide[k].visible=true;
    _envHide.length=0;
  }
}
function envSwap(){
  const old=envTex();ENV.front=1-ENV.front;const t=envTex();
  for(const e of (window._carGloss||[]))if(e.m.envMap===old)e.m.envMap=t;          // same texture type: a uniform swap, no shader rebuild
  for(const m of (window._trafficMats||[]))if(m.envMap===old)m.envMap=t;
}
function envPlace(){ENV.cam.position.set(car.position.x,car.position.y+1.05,car.position.z);ENV.cam.updateMatrixWorld(true)}
function envUpdate(){
  if(!ENV.on||!ENV.rts.length)return;
  if(!ENV.primed){ // fill both cubes once so the first frames never show an empty probe
    envPlace();for(let i=0;i<6;i++)renderEnvFace(i);envSwap();for(let i=0;i<6;i++)renderEnvFace(i);envSwap();
    ENV.primed=true;return}
  ENV.tick++;if(X.rd>1&&ENV.tick%X.rd)return;
  if(ENV.face===0)envPlace();
  renderEnvFace(ENV.face);ENV.face=(ENV.face+1)%6;
  if(ENV.face===0)envSwap();
}
// Point the player car's glossy materials and every traffic car at the live probe (falls back to the game's own maps when off).
// Night: moonlight and street lamps on a 260-shininess clear coat make tiny HDR hot spots that bloom into burnt blobs.
// Real night shots show softer, dimmer glints, so at night every player-car material gets a wider, weaker highlight
// (day values are remembered and restored; if the game changes them, e.g. a new paint finish, those become the day values).
function tameNight(){
  const night=!!isNight;
  car.traverse(o=>{
    if(!o.isMesh)return;
    for(const m of (Array.isArray(o.material)?o.material:[o.material])){
      if(!m||m===headM||m===tailM)continue;const u=m.userData;
      if(m.isMeshPhongMaterial&&m.specular){
        if(u._nt&&(m.shininess!==u._nt.shN||m.specular.getHex()!==u._nt.spN))u._nt=null;
        if(!u._nt)u._nt={sh:m.shininess,sp:m.specular.getHex()};
        m.shininess=night?Math.min(u._nt.sh,70):u._nt.sh;m.specular.setHex(u._nt.sp);if(night)m.specular.multiplyScalar(.3);
        u._nt.shN=m.shininess;u._nt.spN=m.specular.getHex();
      }else if(m.isMeshStandardMaterial){
        if(u._nt&&m.roughness!==u._nt.rN)u._nt=null;
        if(!u._nt)u._nt={r:m.roughness};
        m.roughness=night?Math.max(u._nt.r,.32):u._nt.r;u._nt.rN=m.roughness;
      }
    }
  });
}
const _acg=applyCarGloss;
applyCarGloss=function(){
  _acg.apply(this,arguments);
  try{tameNight()}catch(e){}
  if(!ENV.on||!envTex())return;
  for(const e of (window._carGloss||[])){const m=e.m;if(!m.envMap)continue;
    m.envMap=envTex();
    // clear coat: Fresnel-weighted (carFresnel) mirror of the live probe; dark paints show it most, like real cars
    const nk=isNight?(e.t==='paint'?.7:.5):1;                       // night: street-lamp reflections stay visible but never glare
    if(m.isMeshPhongMaterial&&e.t==='paint'){m.combine=THREE.MixOperation;m.reflectivity=(.3+.2*(1-Math.min(1,(window._paintLum||0)*1.4)))*(weatherMode==='winter'?.8:1)*nk}
    else if(m.isMeshPhongMaterial)m.reflectivity*=nk;
    if(m.isMeshStandardMaterial)m.envMapIntensity=(e.t==='paint'?.75:1.25)*(weatherMode==='winter'?.75:1)*nk;
    m.needsUpdate=true}
};
const _ate=applyTrafficEnv;
applyTrafficEnv=function(){
  _ate.apply(this,arguments);
  if(!ENV.on||!envTex())return;
  const k=weatherMode==='winter'?.55:(isNight?.9:1.05);
  for(const m of (window._trafficMats||[])){m.envMap=envTex();m.envMapIntensity=k;m.needsUpdate=true}
};
function applyEnvMaps(){try{applyCarGloss()}catch(e){}try{applyTrafficEnv()}catch(e){}}

// =====================================================================================================
// 4) HDR POST-PROCESSING: bloom + grading
// =====================================================================================================
const PP=(()=>{
  const TYPE=HDR?THREE.HalfFloatType:THREE.UnsignedByteType;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));geo.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,2,0,0,2],2));
  const qs=new THREE.Scene(),qc=new THREE.OrthographicCamera(-1,1,1,-1,0,1),quad=new THREE.Mesh(geo);quad.frustumCulled=false;qs.add(quad);
  const VS='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
  const mk=(fs,u)=>new THREE.ShaderMaterial({uniforms:u,vertexShader:VS,fragmentShader:fs,depthTest:false,depthWrite:false});
  const bright=mk(`uniform sampler2D tSrc;uniform vec2 uTex;uniform float uTh,uKnee,uClamp;varying vec2 vUv;
vec3 s(vec2 o){return min(texture2D(tSrc,vUv+o*uTex).rgb,vec3(uClamp));}
void main(){vec3 c=(s(vec2(-1.,-1.))+s(vec2(1.,-1.))+s(vec2(-1.,1.))+s(vec2(1.,1.)))*.25;
float br=max(c.r,max(c.g,c.b));float q=clamp(br-uTh+uKnee,0.,2.*uKnee);q=q*q/(4.*uKnee+1e-4);
gl_FragColor=vec4(c*(max(q,br-uTh)/max(br,1e-4)),1.);}`,{tSrc:{value:null},uTex:{value:new THREE.Vector2()},uTh:{value:1.3},uKnee:{value:.3},uClamp:{value:6}});
  const down=mk(`uniform sampler2D tSrc;uniform vec2 uTex;varying vec2 vUv;
void main(){vec3 c=texture2D(tSrc,vUv).rgb*4.;c+=texture2D(tSrc,vUv+uTex*vec2(-1.,-1.)).rgb;c+=texture2D(tSrc,vUv+uTex*vec2(1.,-1.)).rgb;c+=texture2D(tSrc,vUv+uTex*vec2(-1.,1.)).rgb;c+=texture2D(tSrc,vUv+uTex).rgb;gl_FragColor=vec4(c*.125,1.);}`,{tSrc:{value:null},uTex:{value:new THREE.Vector2()}});
  const up=mk(`uniform sampler2D tSrc,tAdd;uniform vec2 uTex;varying vec2 vUv;
void main(){vec2 h=uTex;vec3 c=texture2D(tSrc,vUv+vec2(-2.*h.x,0.)).rgb+texture2D(tSrc,vUv+vec2(2.*h.x,0.)).rgb+texture2D(tSrc,vUv+vec2(0.,-2.*h.y)).rgb+texture2D(tSrc,vUv+vec2(0.,2.*h.y)).rgb;
c+=(texture2D(tSrc,vUv+vec2(-h.x,h.y)).rgb+texture2D(tSrc,vUv+h).rgb+texture2D(tSrc,vUv-h).rgb+texture2D(tSrc,vUv+vec2(h.x,-h.y)).rgb)*2.;
gl_FragColor=vec4(c/12.+texture2D(tAdd,vUv).rgb,1.);}`,{tSrc:{value:null},tAdd:{value:null},uTex:{value:new THREE.Vector2()}});
  const comp=mk(`uniform sampler2D tScene,tBloom;uniform float uBloom,uExpo,uSat,uCon,uVig,uT,uWarm,uLift;uniform vec2 uRes;varying vec2 vUv;
void main(){vec3 c=texture2D(tScene,vUv).rgb*uExpo;
c+=texture2D(tBloom,vUv).rgb*uBloom;
float m=max(c.r,max(c.g,c.b));
if(m>.8){float nm=.8+.2*(1.-exp(-(m-.8)/.2));c*=nm/m;c=mix(c,vec3(nm),smoothstep(1.,4.,m)*.55);} // soft highlight shoulder (keeps hue, hot cores turn white)
float l=dot(c,vec3(.2126,.7152,.0722));c=mix(vec3(l),c,uSat);
c=mix(c,c*c*(3.-2.*c),uCon);                                    // gentle filmic S-curve
c=c*(1.-uLift)+uLift*vec3(.62,.66,.75)*(1.-c);                    // faint cool lift in the deep shadows
c*=vec3(1.+uWarm,1.+uWarm*.35,1.-uWarm);
vec2 q=vUv-.5;q.x*=uRes.x/uRes.y;c*=1.-uVig*smoothstep(.42,1.12,length(q));
c+=(fract(sin(dot(gl_FragCoord.xy+uT,vec2(12.9898,78.233)))*43758.5453)-.5)/255.;
gl_FragColor=vec4(clamp(c,0.,1.),1.);}`,{tScene:{value:null},tBloom:{value:null},uBloom:{value:.35},uExpo:{value:1},uSat:{value:1.06},uCon:{value:.12},uVig:{value:.22},uT:{value:0},uWarm:{value:.012},uLift:{value:.012},uRes:{value:new THREE.Vector2(1,1)}});
  let main=null,W=0,H=0,msaa=-1;const D=[],U=[],LV=6;
  const opt={minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,type:TYPE,depthBuffer:false,stencilBuffer:false,generateMipmaps:false};
  const _v=new THREE.Vector2();
  function wantMsaa(){const aa=GS.aa||'auto';return GL2&&(aa==='on'||(aa!=='off'&&_savedQuality!=='low'&&(window.devicePixelRatio||1)<1.5))}
  function ensure(){
    renderer.getDrawingBufferSize(_v);const w=Math.max(2,_v.x|0),h=Math.max(2,_v.y|0),ms=wantMsaa()?4:0;
    if(main&&w===W&&h===H&&ms===msaa)return;
    W=w;H=h;msaa=ms;
    if(main)main.dispose();
    const mo={minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,format:THREE.RGBAFormat,type:TYPE,depthBuffer:true,stencilBuffer:false,generateMipmaps:false};
    if(ms&&THREE.WebGLMultisampleRenderTarget){main=new THREE.WebGLMultisampleRenderTarget(W,H,mo);main.samples=ms}else main=new THREE.WebGLRenderTarget(W,H,mo);
    for(const r of D)r.dispose();for(const r of U)r.dispose();D.length=U.length=0;
    let bw=Math.max(1,W>>1),bh=Math.max(1,H>>1);
    for(let i=0;i<LV;i++){D.push(new THREE.WebGLRenderTarget(bw,bh,opt));if(i<LV-1)U.push(new THREE.WebGLRenderTarget(bw,bh,opt));bw=Math.max(1,bw>>1);bh=Math.max(1,bh>>1)}
    comp.uniforms.uRes.value.set(W,H);
  }
  function pass(m,rt){quad.material=m;renderer.setRenderTarget(rt);renderer.render(qs,qc)}
  function render(cam){
    ensure();
    renderer.setRenderTarget(main);renderer.render(scene,cam);
    bright.uniforms.tSrc.value=main.texture;bright.uniforms.uTex.value.set(1/W,1/H);pass(bright,D[0]);
    for(let i=1;i<LV;i++){down.uniforms.tSrc.value=D[i-1].texture;down.uniforms.uTex.value.set(1/D[i-1].width,1/D[i-1].height);pass(down,D[i])}
    let src=D[LV-1];
    for(let i=LV-2;i>=0;i--){up.uniforms.tSrc.value=src.texture;up.uniforms.tAdd.value=D[i].texture;up.uniforms.uTex.value.set(1/src.width,1/src.height);pass(up,U[i]);src=U[i]}
    comp.uniforms.tScene.value=main.texture;comp.uniforms.tBloom.value=src.texture;comp.uniforms.uT.value=(performance.now()*.013)%97;
    pass(comp,null);
  }
  function dispose(){if(main){main.dispose();main=null}for(const r of D)r.dispose();for(const r of U)r.dispose();D.length=U.length=0;W=H=0;msaa=-1}
  return{render,dispose,comp,bright};
})();
// grading per time of day / weather (GTA-like: warm, saturated days; deep blue nights with strong light bloom; flat cold winter)
// Night bloom is deliberately soft: lights glow, but nothing burns out (threshold above lit surfaces, hot pixels clamped).
const G0={bloom:.38,th:1.32,clamp:6,expo:1,sat:1.08};
function updateGrade(){
  const c=PP.comp.uniforms,b=PP.bright.uniforms,winter=weatherMode==='winter';
  if(isNight){Object.assign(G0,{bloom:winter?.4:.5,th:.95,clamp:3,expo:1,sat:winter?.95:1.04});b.uKnee.value=.25;c.uCon.value=.07;c.uVig.value=.28;c.uWarm.value=0;c.uLift.value=.02}
  else if(winter){Object.assign(G0,{bloom:.3,th:1.2,clamp:4,expo:1,sat:.9});b.uKnee.value=.3;c.uCon.value=.06;c.uVig.value=.2;c.uWarm.value=-.01;c.uLift.value=.01}
  else{Object.assign(G0,{bloom:.38,th:1.32,clamp:6,expo:1,sat:1.08});b.uKnee.value=.35;c.uCon.value=.12;c.uVig.value=.22;c.uWarm.value=.014;c.uLift.value=.01}
  applyGrade();
}
// eye adaptation in the tunnel: less bloom, a higher bloom threshold and a slightly lower exposure (the bright tube no longer glares)
function applyGrade(){
  const c=PP.comp.uniforms,b=PP.bright.uniforms,f=(typeof TUN!=='undefined'&&TUN.inside)||0;
  c.uBloom.value=G0.bloom*(1-.6*f);b.uTh.value=G0.th+.55*f;b.uClamp.value=G0.clamp*(1-.4*f);c.uExpo.value=G0.expo*(1-.14*f);c.uSat.value=G0.sat*(1-.08*f);
}

// =====================================================================================================
// 5) DRY-ASPHALT SHEEN (Fresnel horizon reflection on the road; winter keeps its own wet-road shader)
// =====================================================================================================
const SHEEN={K:{value:0},C:{value:new THREE.Color()}};
(function patchSheen(mat){
  const prev=mat.onBeforeCompile,prevKey=mat.customProgramCacheKey?mat.customProgramCacheKey():'';
  mat.onBeforeCompile=function(sh,r){
    if(prev)prev.call(this,sh,r);
    if(sh.fragmentShader.indexOf('vRWP')<0)return;
    sh.uniforms.uShK=SHEEN.K;sh.uniforms.uShC=SHEEN.C;
    sh.fragmentShader=sh.fragmentShader.replace('void main() {','uniform float uShK;uniform vec3 uShC;\nvoid main() {').replace('#include <emissivemap_fragment>',['#include <emissivemap_fragment>',
      'if(uShK>.001){',
      '  vec3 _sv=normalize(cameraPosition-vRWP);float _sc=clamp(_sv.y,0.,1.);',
      '  float _sF=.025+.975*pow(1.-_sc,5.);',
      '  float _sl=dot(diffuseColor.rgb,vec3(.299,.587,.114));',
      '  float _sg=.55+.75*(1.-smoothstep(.16,.42,_sl));',
      '  totalEmissiveRadiance+=uShC*_sF*_sg*uShK;',
      '}'].join('\n'));
  };
  mat.customProgramCacheKey=()=>prevKey+'|sheen1';
  mat.needsUpdate=true;
})(asM);
function updateSheen(){
  const winter=weatherMode==='winter';
  SHEEN.K.value=winter?0:(isNight?.12:.42);
  SHEEN.C.value.copy(scene.fog.color);if(TUN&&TUN.inside)SHEEN.K.value*=.2;
}

// =====================================================================================================
// 6) PALM TREES along the corniche sidewalks
// =====================================================================================================
const PALMS=(()=>{
  // frond texture: rachis + angled leaflets (alpha cut-out)
  const frondT=(()=>{const W=512,H=128,c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d');g.clearRect(0,0,W,H);
    g.lineCap='round';
    for(let x=14;x<W-6;x+=6){const t=x/W,len=(1-Math.pow(t,1.6))*54+6,w=Math.max(1.2,3.6*(1-t*.6));
      for(const s of [-1,1]){const a=.55+Math.random()*.25,ex=x+len*Math.cos(a)*.9,ey=64+s*len*Math.sin(a)*1.05;
        const gr=g.createLinearGradient(x,64,ex,ey);const hue=88+Math.random()*28,l1=24+Math.random()*10;gr.addColorStop(0,'hsl('+hue+',48%,'+l1+'%)');gr.addColorStop(1,'hsl('+(hue+8)+',52%,'+(l1+16)+'%)');
        g.strokeStyle=gr;g.lineWidth=w;g.beginPath();g.moveTo(x,64);g.quadraticCurveTo((x+ex)/2+3,(64+ey)/2+s*4,ex,ey);g.stroke()}}
    g.strokeStyle='#7a6a3e';g.lineWidth=5;g.beginPath();g.moveTo(0,64);g.lineTo(W,64);g.stroke();
    const t=new THREE.CanvasTexture(c);t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());return t})();
  const barkT=(()=>{const W=64,H=256,c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d');g.fillStyle='#8a7656';g.fillRect(0,0,W,H);
    for(let y=0;y<H;y+=7+Math.random()*3){g.fillStyle='rgba(40,30,18,'+(.25+Math.random()*.2)+')';g.fillRect(0,y,W,2.2);g.fillStyle='rgba(255,240,210,.08)';g.fillRect(0,y+2.2,W,1.2)}
    for(let i=0;i<400;i++){g.fillStyle=Math.random()<.5?'rgba(0,0,0,.08)':'rgba(255,255,255,.05)';g.fillRect(Math.random()*W,Math.random()*H,2,2)}
    const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;return t})();
  const TH=8.6;
  // trunk: slightly curved, tapered, swollen base
  const trunkGeo=(()=>{const R=8,S=14,P=[],N=[],UV=[],IX=[];
    for(let j=0;j<=S;j++){const t=j/S,bx=.55*t*t,y=t*TH,r=.19*(1-.3*t)+.16*Math.exp(-t*14);
      for(let i=0;i<=R;i++){const a=i/R*Math.PI*2,c=Math.cos(a),s=Math.sin(a);P.push(bx+c*r,y,s*r);N.push(c,.08,s);UV.push(i/R,t*TH/1.6)}}
    for(let j=0;j<S;j++)for(let i=0;i<R;i++){const a=j*(R+1)+i,b=a+R+1;IX.push(a,b,a+1,a+1,b,b+1)}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(N,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(UV,2));g.setIndex(IX);return g})();
  // crown: ~15 drooping, V-folded fronds + a few dead hanging ones (vertex colour)
  const crownGeo=(()=>{const P=[],UV=[],C=[],IX=[],top=new THREE.Vector3(.55,TH,0);let vo=0;
    const add=(az,el,len,droop,col,fold)=>{const dx=Math.cos(az),dz=Math.sin(az),sx=-dz,sz=dx,SEG=9;
      for(let k=0;k<=SEG;k++){const s=k/SEG,h=len*s,px=top.x+dx*h*Math.cos(el),py=top.y+h*Math.sin(el)-droop*s*s*len,pz=top.z+dz*h*Math.cos(el),w=.7*Math.sin(Math.PI*Math.min(1,.12+s*.95))+.06,lift=w*Math.sin(fold);
        P.push(px+sx*w*Math.cos(fold),py+lift,pz+sz*w*Math.cos(fold), px,py,pz, px-sx*w*Math.cos(fold),py+lift,pz-sz*w*Math.cos(fold));
        UV.push(s,0,s,.5,s,1);for(let q=0;q<3;q++)C.push(col[0],col[1],col[2])}
      for(let k=0;k<SEG;k++){const a=vo+k*3;IX.push(a,a+3,a+1,a+1,a+3,a+4,a+1,a+4,a+2,a+2,a+4,a+5)}
      vo+=(SEG+1)*3};
    const n=15;for(let i=0;i<n;i++){const az=i/n*Math.PI*2+(Math.random()-.5)*.3,el=.15+Math.random()*.55,g=.9+Math.random()*.2;add(az,el,3.3+Math.random()*1.1,.62+Math.random()*.3,[g,g,g*.95],.38)}
    for(let i=0;i<4;i++){const az=Math.random()*Math.PI*2;add(az,-1.05,2.4,.15,[1.35,1.05,.55],.2)}
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(UV,2));g.setAttribute('color',new THREE.Float32BufferAttribute(C,3));g.setIndex(IX);g.computeVertexNormals();
    // bias the normals upward: foliage reads lit from the sky rather than flat-shaded per leaf
    const nn=g.attributes.normal;for(let i=0;i<nn.count;i++){const x=nn.getX(i),y=nn.getY(i),z=nn.getZ(i),yy=Math.abs(y)*.6+.55,l=Math.hypot(x,yy,z);nn.setXYZ(i,x/l,yy/l,z/l)}
    return g})();
  const WIND={value:0};
  const trunkM=new THREE.MeshLambertMaterial({map:barkT,color:0xd8cdb8});
  const frondM=new THREE.MeshLambertMaterial({map:frondT,vertexColors:true,alphaTest:.42,side:THREE.DoubleSide});
  frondM.onBeforeCompile=sh=>{sh.uniforms.uWind=WIND;sh.vertexShader=sh.vertexShader.replace('void main() {','uniform float uWind;\nvoid main() {').replace('#include <begin_vertex>',
    '#include <begin_vertex>\n#ifdef USE_INSTANCING\nfloat _ph=instanceMatrix[3].x*.37+instanceMatrix[3].z*.21;\n#else\nfloat _ph=0.;\n#endif\nfloat _k=max(0.,length(transformed.xz-vec2(.55,0.)))*.06;transformed.x+=sin(uWind*1.3+_ph+transformed.z*.4)*_k*1.6;transformed.z+=cos(uWind*1.1+_ph*1.3)*_k;transformed.y+=sin(uWind*2.1+_ph+transformed.x)*_k*.8;')};
  frondM.customProgramCacheKey=()=>'palmFrond1';
  const CAP=N*5;
  const trunks=new THREE.InstancedMesh(trunkGeo,trunkM,CAP),crowns=new THREE.InstancedMesh(crownGeo,frondM,CAP);
  crowns.customDepthMaterial=new THREE.MeshDepthMaterial({depthPacking:THREE.RGBADepthPacking,map:frondT,alphaTest:.42,side:THREE.DoubleSide});
  for(const im of [trunks,crowns]){im.count=0;im.frustumCulled=false;im.castShadow=true;im.receiveShadow=true;im.userData._shd=1;im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);scene.add(im)}
  const per=new Map(),_p=new THREE.Vector3(),_q=new THREE.Quaternion(),_e=new THREE.Euler(),_s=new THREE.Vector3();
  let dirty=true;
  function place(seg){
    const list=per.get(seg)||[];list.length=0;per.set(seg,list);dirty=true;
    const z0=seg.g.position.z,bb=seg.bb&&seg.bb.grp,bbZ=bb&&bb.visible?z0+(bb.userData.roadOffsetZ||-30):1e9;
    const spots=[[23.55,-7],[23.55,-27],[23.55,-47],[-23.6,-17],[-23.6,-37]];
    for(const [lat,off] of spots){
      const station=z0+off+(Math.random()-.5)*3;
      if(tunnelF(station)>0||tunnelF(station-12)>0||tunnelF(station+12)>0)continue;     // no palms in / at the mouths of the tunnels
      if(lat>0&&Math.abs(station-bbZ)<7.5)continue;                                       // keep clear of the billboard
      trackToWorld(lat+(Math.random()-.5)*.3,.3,station,_p,true);
      const sea=lat>0?1:-1;
      _e.set((Math.random()-.5)*.06,Math.random()*Math.PI*2,-sea*(.02+Math.random()*.06),'YXZ');_q.setFromEuler(_e);
      const k=.85+Math.random()*.32;_s.set(k,k*(.92+Math.random()*.16),k);
      list.push(new THREE.Matrix4().compose(_p,_q,_s));
    }
  }
  function sync(){
    if(!dirty)return;dirty=false;let n=0;
    for(const [,list] of per)for(const m of list){if(n>=CAP)break;trunks.setMatrixAt(n,m);crowns.setMatrixAt(n,m);n++}
    trunks.count=crowns.count=n;trunks.instanceMatrix.needsUpdate=crowns.instanceMatrix.needsUpdate=true;
  }
  function all(){for(const s of segs)place(s);sync()}
  return{place,sync,all,WIND,trunks,crowns};
})();
const _usrt=updateSegmentRoadTransform;
updateSegmentRoadTransform=function(seg){const r=_usrt.apply(this,arguments);try{PALMS.place(seg)}catch(e){}return r};

// =====================================================================================================
// settings + per-frame hooks
// =====================================================================================================
function apply(){
  const p=preset();
  const sh=GS.gShadow!=null?+GS.gShadow:p.sh;
  const post=(GS.gPost!=null?!!GS.gPost:p.post)&&GL2;
  const refl=GS.gRefl!=null?(GS.gRefl?(p.refl||128):0):p.refl;
  X.post=post;X.rd=p.rd||2;
  setShadowSize(sh);
  envEnsure(refl);
  if(!post)PP.dispose();
  updateGrade();updateSheen();
}
const _sq=setQuality;
setQuality=function(){const r=_sq.apply(this,arguments);try{apply();syncUI()}catch(e){console.warn('gfx apply failed',e)}return r};
let _frame=0;
// called by renderOptimizedScene() for the main camera: returns true when it rendered the frame itself
function render(cam){
  _frame++;
  if((_frame&127)===1){shadowScan();sizePlayerBlob()}
  playerBlob.visible=!(typeof cockpitOn!=='undefined'&&cockpitOn);
  PALMS.sync();PALMS.WIND.value=performance.now()*.001;
  updateSheen();applyGrade();
  shadowFollow();
  if(X.post)PP.render(cam);else renderer.render(scene,cam);
  return true;
}
// called once per frame after the main render + mirrors (never from inside renderOptimizedScene)
function afterFrame(){try{envUpdate()}catch(e){if(!ENV._err){ENV._err=1;console.warn('env probe failed',e)}}}

// ---------- Settings UI (Graphics tab) ----------
function syncUI(){
  const $=id=>document.getElementById(id);
  const sv=GS.gShadow!=null?String(GS.gShadow):'auto';
  document.querySelectorAll('#gfxShadow button').forEach(b=>{const on=b.dataset.v===sv;b.classList.toggle('active',on);b.setAttribute('aria-checked',on?'true':'false')});
  if($('gfxPostToggle'))$('gfxPostToggle').checked=X.post;
  if($('gfxReflToggle'))$('gfxReflToggle').checked=ENV.on;
  if($('gfxPostToggle'))$('gfxPostToggle').disabled=!GL2;
  // the canvas is created without its own anti-aliasing when post-processing is on (the HDR buffer is multisampled instead)
  const rr=$('gfxReloadRow');if(rr&&X.postAtStart!=null&&X.post!==X.postAtStart)rr.hidden=false;
  const tag=$('gfxCustomTag');if(tag&&(GS.gShadow!=null||GS.gPost!=null||GS.gRefl!=null))tag.hidden=false;
}
(function bindUI(){
  const $=id=>document.getElementById(id);
  document.querySelectorAll('#gfxShadow button').forEach(b=>b.addEventListener('click',()=>{GS.gShadow=b.dataset.v==='auto'?null:+b.dataset.v;saveGS();apply();if(window.syncGfxUI)window.syncGfxUI();syncUI()}));
  if($('gfxPostToggle'))$('gfxPostToggle').addEventListener('change',e=>{GS.gPost=e.target.checked;saveGS();apply();if(window.syncGfxUI)window.syncGfxUI();syncUI()});
  if($('gfxReflToggle'))$('gfxReflToggle').addEventListener('change',e=>{GS.gRefl=e.target.checked;saveGS();apply();if(window.syncGfxUI)window.syncGfxUI();syncUI()});
  // presets / reset restore the preset's own shadow / post / reflection settings
  document.querySelectorAll('#qualityGrid .time-option').forEach(b=>b.addEventListener('click',()=>{GS.gShadow=GS.gPost=GS.gRefl=null;saveGS();apply();syncUI()}));
  if($('gfxResetBtn'))$('gfxResetBtn').addEventListener('click',()=>{GS.gShadow=GS.gPost=GS.gRefl=null;saveGS();apply();syncUI()});
  const _sg=window.syncGfxUI;if(_sg)window.syncGfxUI=function(){_sg.apply(this,arguments);syncUI()};
})();

// ---------- init ----------
X.postAtStart=!!window._ppAtStart;
// the game only classified the player's glossy materials (paint / glass / chrome) at night: do it now so day reflections work too
try{patchPlayerCarMaterials()}catch(e){console.warn(e)}
captureSun();
apply();
try{shadowScan();PALMS.all()}catch(e){console.warn('gfx init scan failed',e)}
syncUI();
window.GFXP={render,afterFrame,apply,X,ENV,PP,PALMS,SUN,shadowScan};
})();
