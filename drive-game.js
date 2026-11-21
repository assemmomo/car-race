// ===================== Game glue for the GTA-style physics (drive-physics.js) =====================
// input -> DriveCore -> game state, plus skid marks, tyre smoke, tyre squeal, extra engine sound layers and the chase-camera helper.
// Loaded after game.js: it reads / writes game.js globals (st, yawR, gi, keys, pad, FX, scene ...).
(function(){
'use strict';
if(typeof THREE==='undefined'||typeof st==='undefined'||typeof scene==='undefined'||!window.DriveCore){console.warn('drive-game: game not ready');return}
const DC=window.DriveCore,clamp=(v,a,b)=>v<a?a:v>b?b:v,sstep=(a,b,x)=>{x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x)};
const S=DC.makeState(),I={gas:0,brake:0,steer:0,hb:false,analog:false};
let H=null,Hid='';
function curH(){const id=(typeof activeCarId!=='undefined'&&activeCarId)||'lancer';if(id!==Hid||!H){Hid=id;H=DC.handling(id);P.m=H.m}return H}

// ---------- skid marks: one ring buffer of road-hugging quads, a continuous strip per wheel ----------
const SKID=(()=>{
  const MAX=3200,pos=new Float32Array(MAX*12),al=new Float32Array(MAX*4),idx=new Uint16Array(MAX*6);
  for(let q=0;q<MAX;q++){const v=q*4,o=q*6;idx[o]=v;idx[o+1]=v+1;idx[o+2]=v+2;idx[o+3]=v+2;idx[o+4]=v+1;idx[o+5]=v+3}
  const geo=new THREE.BufferGeometry(),pa=new THREE.BufferAttribute(pos,3),aa=new THREE.BufferAttribute(al,1);
  pa.setUsage(THREE.DynamicDrawUsage);aa.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position',pa);geo.setAttribute('aA',aa);geo.setIndex(new THREE.BufferAttribute(idx,1));geo.setDrawRange(0,0);
  const mat=new THREE.ShaderMaterial({uniforms:{uCol:{value:new THREE.Color(.03,.03,.034)},uFN:{value:120},uFF:{value:700},uK:{value:1}},transparent:true,depthWrite:false,
    polygonOffset:true,polygonOffsetFactor:-4,polygonOffsetUnits:-4,
    vertexShader:'attribute float aA;varying float vA;varying float vD;void main(){vA=aA;vec4 mv=modelViewMatrix*vec4(position,1.);vD=-mv.z;gl_Position=projectionMatrix*mv;}',
    fragmentShader:'uniform vec3 uCol;uniform float uFN,uFF,uK;varying float vA;varying float vD;void main(){gl_FragColor=vec4(uCol,vA*uK*(1.-smoothstep(uFN,uFF,vD)));}'});
  const mesh=new THREE.Mesh(geo,mat);mesh.frustumCulled=false;mesh.renderOrder=2;mesh.name='skidMarks';scene.add(mesh);
  const last=[null,null,null,null];let q=0,used=0,dLo=MAX,dHi=-1,wrapped=false;
  function put(qi,x0,y0,z0,x1,y1,z1,x2,y2,z2,x3,y3,z3,a0,a1){const o=qi*12;
    pos[o]=x0;pos[o+1]=y0;pos[o+2]=z0;pos[o+3]=x1;pos[o+4]=y1;pos[o+5]=z1;pos[o+6]=x2;pos[o+7]=y2;pos[o+8]=z2;pos[o+9]=x3;pos[o+10]=y3;pos[o+11]=z3;
    const k=qi*4;al[k]=a0;al[k+1]=a0;al[k+2]=a1;al[k+3]=a1;if(qi<dLo)dLo=qi;if(qi>dHi)dHi=qi}
  function add(i,x,y,z,a,hw){
    const L=last[i];
    if(!L){last[i]={x,y,z,a,has:false,lx:0,lz:0,rx:0,rz:0};return}
    const dx=x-L.x,dz=z-L.z,d=Math.hypot(dx,dz);
    if(d<.35)return;
    if(d>5){last[i]={x,y,z,a,has:false,lx:0,lz:0,rx:0,rz:0};return}
    const nx=-dz/d*hw,nz=dx/d*hw;
    const l0x=L.has?L.lx:L.x+nx,l0z=L.has?L.lz:L.z+nz,r0x=L.has?L.rx:L.x-nx,r0z=L.has?L.rz:L.z-nz;
    put(q,l0x,L.y,l0z,r0x,L.y,r0z,x+nx,y,z+nz,x-nx,y,z-nz,L.a,a);
    q++;if(q>=MAX){q=0;wrapped=true}used=Math.min(MAX,used+1);
    L.x=x;L.y=y;L.z=z;L.a=a;L.lx=x+nx;L.lz=z+nz;L.rx=x-nx;L.rz=z-nz;L.has=true;
  }
  function brk(i){last[i]=null}
  function flush(){
    if(dHi>=dLo){
      if(wrapped){pa.updateRange.offset=0;pa.updateRange.count=-1;aa.updateRange.offset=0;aa.updateRange.count=-1;wrapped=false}
      else{pa.updateRange.offset=dLo*12;pa.updateRange.count=(dHi-dLo+1)*12;aa.updateRange.offset=dLo*4;aa.updateRange.count=(dHi-dLo+1)*4}
      pa.needsUpdate=true;aa.needsUpdate=true;geo.setDrawRange(0,used*6);dLo=MAX;dHi=-1;
    }
    if(scene.fog){mat.uniforms.uFN.value=scene.fog.near;mat.uniforms.uFF.value=scene.fog.far}
    mat.uniforms.uK.value=weatherMode==='winter'?.55:1;
  }
  function clear(){used=0;q=0;geo.setDrawRange(0,0);for(let i=0;i<4;i++)last[i]=null}
  return{add,brk,flush,clear,mesh};
})();

// ---------- wheel contact points (car-local, measured from the loaded model once per car) ----------
let wheelKey=null,WL=[];
const _m4=new THREE.Matrix4(),_v3=new THREE.Vector3();
function wheelLocal(){
  const k=wheels.length?wheels[0]:'none';
  if(k===wheelKey&&WL.length)return WL;
  wheelKey=k;WL=[];
  if(wheels.length>=4){
    car.updateMatrixWorld(true);_m4.copy(car.matrixWorld).invert();
    for(const w of wheels){w.getWorldPosition(_v3);_v3.applyMatrix4(_m4);WL.push({x:_v3.x,z:_v3.z,rear:!!w.userData.rear})}
  }
  if(WL.length<4){WL=[];for(const [x,z,rear] of [[-.76,-1.3,false],[.76,-1.3,false],[-.76,1.32,true],[.76,1.32,true]])WL.push({x,z,rear})}
  return WL;
}

// ---------- audio: tyre squeal + a richer engine (extra layers feed the game's engine gain node, so volume / mute / pause still apply) ----------
const SQ={},ENG={};
function noiseBuf(sec){const b=ac.createBuffer(1,Math.max(1,Math.floor(ac.sampleRate*sec)),ac.sampleRate),d=b.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;return b}
function audioInit(){
  if(typeof ac==='undefined'||!ac||(SQ.g&&ENG.lp))return;
  try{
    if(!SQ.g){
      const g=ac.createGain();g.gain.value=0;g.connect(ac.destination);
      const o1=ac.createOscillator(),o2=ac.createOscillator();o1.type='triangle';o2.type='triangle';o1.frequency.value=960;o2.frequency.value=1440;
      const lfo=ac.createOscillator(),lg=ac.createGain();lfo.frequency.value=8.5;lg.gain.value=26;lfo.connect(lg);lg.connect(o1.frequency);lg.connect(o2.frequency);
      const og=ac.createGain();og.gain.value=.12;o1.connect(og);o2.connect(og);og.connect(g);
      const src=ac.createBufferSource();src.buffer=noiseBuf(2);src.loop=true;
      const bp=ac.createBiquadFilter();bp.type='bandpass';bp.frequency.value=1650;bp.Q.value=1.6;const ng=ac.createGain();ng.gain.value=.55;
      src.connect(bp);bp.connect(ng);ng.connect(g);
      o1.start();o2.start();lfo.start();src.start();
      Object.assign(SQ,{g,o1,o2,bp});
    }
    if(!ENG.lp&&typeof gn!=='undefined'&&gn){
      const lp=ac.createBiquadFilter();lp.type='lowpass';lp.frequency.value=500;lp.Q.value=2.2;
      const sub=ac.createOscillator();sub.type='square';const sg=ac.createGain();sg.gain.value=.24;sub.connect(sg);sg.connect(lp);
      const har=ac.createOscillator();har.type='sawtooth';const hg=ac.createGain();hg.gain.value=.2;har.connect(hg);hg.connect(lp);
      const src=ac.createBufferSource();src.buffer=noiseBuf(2);src.loop=true;
      const bp=ac.createBiquadFilter();bp.type='bandpass';bp.frequency.value=600;bp.Q.value=.9;const ng=ac.createGain();ng.gain.value=0;
      src.connect(bp);bp.connect(ng);ng.connect(gn);lp.connect(gn);
      sub.start();har.start();src.start();
      Object.assign(ENG,{lp,sub,har,ng,bp});
    }
  }catch(e){console.warn('drive audio init failed',e)}
}
function audioUpdate(sq,pitch){
  if(!SQ.g)return;
  const t=ac.currentTime,vol=(muted||engineVolume<=0)?0:Math.min(1,engineVolume*1.2);
  SQ.g.gain.setTargetAtTime(sq*.2*vol,t,.05);
  SQ.o1.frequency.setTargetAtTime(860+pitch*320,t,.08);SQ.o2.frequency.setTargetAtTime(1290+pitch*480,t,.08);SQ.bp.frequency.setTargetAtTime(1450+pitch*600,t,.1);
  if(ENG.lp){
    const r01=clamp((engRPM-700)/6600,0,1),f0=40+r01*120;
    ENG.sub.frequency.setTargetAtTime(f0*.5,t,.02);ENG.har.frequency.setTargetAtTime(f0*2.006,t,.02);
    ENG.lp.frequency.setTargetAtTime(260+st.thr*900+r01*1300,t,.04);
    ENG.ng.gain.setTargetAtTime(.04+.3*st.thr*(.3+r01),t,.05);ENG.bp.frequency.setTargetAtTime(450+r01*1700,t,.05);
  }
}

// ---------- per-frame tyre effects ----------
const smokeAcc=[0,0,0,0];
function tyreFx(dt){
  const W=wheelLocal(),c=Math.cos(st.h),s=Math.sin(st.h),wet=weatherMode==='winter';
  let sqMax=0;
  for(let i=0;i<4&&i<W.length;i++){
    const w=W[i],sl=w.rear?S.slideR:S.slideF;
    const x=st.x+w.x*c+w.z*s,z=st.z-w.x*s+w.z*c;
    const mk=sstep(2.2,7,sl)*(wet?.7:1);
    if(mk>.02)SKID.add(i,x,bridgeElevAt(x,z)+.035,z,Math.min(.62,mk*.62),.115);else SKID.brk(i);
    const sm=sstep(4,11,sl)*(wet?.25:1);
    if(sm>.01&&FX.tire){smokeAcc[i]+=sm*18*dt;while(smokeAcc[i]>=1){smokeAcc[i]-=1;FX.tire(x,bridgeElevAt(x,z)+.2,z,st.wx,st.wz,sm)}}else smokeAcc[i]=0;
    sqMax=Math.max(sqMax,sl);
  }
  SKID.flush();
  const sq=sstep(2.4,8,sqMax)*(wet?.35:1);
  audioUpdate(sq,clamp((sqMax-2.4)/9,0,1));
}

// ---------- the step that replaces the arcade physics ----------
const D={enabled:true,S,core:DC,skid:SKID};
D.handling=()=>curH();
D.step=function(dt){
  const H=curH();
  // the game owns the authoritative state: collisions / kerbs may have moved or spun the car since the last frame
  S.x=st.x;S.z=st.z;S.h=st.h;S.wx=st.wx;S.wz=st.wz;
  // crash / kerb spin impulses become real yaw (the tyres then fight it); scaled down because the old arcade model
  // let them decay on their own while the steering kept full control of the yaw
  S.r=clamp(yawR+(st.cw||0)*.55,-5,5);st.cw=0;
  S.roll=st.roll;S.pitch=st.pitch;S.gear=gi;S.shiftT=shiftT;S.wet=weatherMode==='winter';
  const keyGas=!!(keys.w||keys.arrowup),keyBrake=!!(keys.s||keys.arrowdown);
  const keySteer=(keys.a||keys.arrowleft?1:0)-(keys.d||keys.arrowright?1:0),digital=(pad.left?1:0)-(pad.right?1:0),an=Number(pad.steer)||0;
  I.gas=Math.max(keyGas?1:0,Number(pad.throttle)||(pad.gas?1:0));
  I.brake=Math.max(keyBrake?1:0,Number(pad.brakeAmount)||(pad.brake?1:0));
  I.hb=!!(keys[' ']||pad.hb);I.steer=keySteer+digital+an;I.analog=!keySteer&&!digital&&Math.abs(an)>.02;
  const vf=DC.step(S,H,I,dt);
  st.x=S.x;st.z=S.z;st.h=S.h;st.wx=S.wx;st.wz=S.wz;yawR=S.r;
  gi=S.gear;shiftT=S.shiftT;engRPM=S.rpm;revMode=S.rev;
  st.thr=S.thr;st.steer=S.steer;brkp=S.brk;hbp=S.hbp;throttleOffTime=S.coast;
  axF=S.axS;ayF=S.ayS;accel=axF;slide=Math.min(1,Math.abs(S.beta)*2.5+S.hbp*.5);
  dlVis=S.delta/.75;                                    // front wheels / steering wheel show the real steering angle (incl. counter-steer)
  resolveCurbs(dt);
  st.roll=S.roll;st.pitch=S.pitch;st.heave=S.heave;
  const sg=vf<0?-1:1;
  spin-=(vf+(H.frontBias>.01?S.spinF*sg:0))*dt/H.R;
  if(S.hbp<.5)spinR-=(vf+(H.frontBias<.99?S.spinR*sg:0))*dt/H.R;   // the handbrake locks the rear wheels
  tailM.opacity=(I.hb||(I.brake>.06&&vf>.2))?1:(isNight?.6:.45);
  audioInit();
  try{tyreFx(dt)}catch(e){if(!D._fxErr){D._fxErr=1;console.warn('tyre fx failed',e)}}
  return vf;
};
D.reset=function(){
  Object.assign(S,DC.makeState());S.x=st.x;S.z=st.z;S.h=st.h;st.heave=0;
  SKID.clear();for(let i=0;i<4;i++)smokeAcc[i]=0;
  if(SQ.g)try{SQ.g.gain.setTargetAtTime(0,ac.currentTime,.03)}catch(e){}
};
D.silence=function(){if(SQ.g&&SQ.g.gain.value>.0005)try{SQ.g.gain.setTargetAtTime(0,ac.currentTime,.03)}catch(e){}};
// ---------- GTA-style chase camera: swings toward the travel direction in a slide, pulls back with speed, lags on acceleration ----------
const CAM={dk:1,hk:0,out:{yaw:0,d:1,h:0}};
D.cam=function(dt){
  const V=Math.hypot(st.wx,st.wz),fwd=-Math.sin(st.h)*st.wx-Math.cos(st.h)*st.wz;
  let yaw=st.h;
  if(V>3&&fwd>0){let d=Math.atan2(-st.wx,-st.wz)-st.h;d=Math.atan2(Math.sin(d),Math.cos(d));yaw=st.h+clamp(d,-.8,.8)*.4*sstep(3,12,V)}
  const tD=1+.13*sstep(12,55,V)+clamp(S.axS*.013,-.07,.08);
  CAM.dk+=(tD-CAM.dk)*Math.min(1,dt*2.4);
  CAM.hk+=(-.2*sstep(15,60,V)-CAM.hk)*Math.min(1,dt*2);
  CAM.out.yaw=yaw;CAM.out.d=CAM.dk;CAM.out.h=CAM.hk;
  return CAM.out;
};
window.DRIVE=D;
})();
