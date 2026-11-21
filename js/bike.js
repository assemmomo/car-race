// ============================================================================================================
//  MOTORCYCLE SYSTEM  (Yamaha MT-09 SP)  -  loaded BEFORE game.js
//  1) BikePhys   : pure single-track physics with real lean dynamics (no THREE, testable in Node)
//  2) RiderMath  : pure rider kinematics (joint positions, 2-bone IK)
//  3) buildBikeCar / bikeVisual / stepBike : THREE rig + glue to the game loop
// ============================================================================================================

// ---------------------------------------------------------------------------------------------------------
// 1) PHYSICS
// ---------------------------------------------------------------------------------------------------------
/* Model summary (SI units, heading h>0 = turning LEFT, lean phi>0 = leaning LEFT)
   * Yaw rate comes from the LEAN angle, exactly like a real motorcycle:   tan(phi) = u^2 * kappa / g   ->   yaw = g*tan(phi)/u
     At walking speed the bars (steering lock) set the curvature instead (kinematic bicycle); the two are blended 2.5..7.5 m/s.
   * The rider's steering input commands a TARGET lean. The bike reaches it through a 2nd-order roll response whose speed
     drops with velocity (gyroscopic effect), limited to ~80 deg/s. So the bike "falls into" the corner, it never snaps.
   * Max lean = tyre friction circle:  tan(phi) <= sqrt(mu^2 - (a_long/g)^2)   (braking/accelerating in a corner reduces it).
   * Counter-steering is shown on the bars: a short, opposite bar movement while the roll rate is high.
   * Longitudinal: real MT-09 torque curve, 6-speed ratios, rev limiter, auto-shifter, aero drag, rolling resistance.
   * Load transfer: rear traction limit grows with acceleration, front brake limit with braking, wheelie when
     m*a*h > m*g*b (rigid-body pitch about the rear contact patch) with a front-lift limiter like the real bike's LIF.
   * Suspension: fork dive under braking, rear squat under power (visual + body pitch). */
const BikePhys=(function(){
  const D={
    m:270,            // kg  (193 kg bike + rider)
    R:.321,Rf:.307,   // rear / front wheel radius (m)
    L:1.465,          // wheelbase
    wf:.46,           // static front weight fraction -> CG is bR=wf*L ahead of the rear axle
    h:.60,            // CG height with rider
    g:9.81,rho:1.2,CdA:.50,Crr:.015,
    idle:1300,limiter:11300,
    ratios:[12.38,9.38,7.80,6.49,5.73,4.99],   // primary * gear * final
    eff:.90,
    mu:1.2,           // dry sport-touring tyre
    brakeA:10.2,      // max brake demand (m/s^2) before the load-transfer / ABS limit
    rearBrakeA:3.2,
    rake:25*Math.PI/180,lock:35*Math.PI/180,phiMax:54*Math.PI/180,
    swingLen:.54,travelF:.13,travelR:.12,sagF:.035,sagR:.04
  };
  D.bR=D.wf*D.L;D.aF=D.L-D.bR;
  const TQ=[[0,0],[1000,40],[1500,58],[2000,68],[3000,78],[4000,82],[5000,86],[6000,90],[7000,93],[8000,91],[9000,88],[10000,84],[10500,76],[11000,60],[11500,0]];
  function tq(r){if(r<=0)return 0;for(let i=1;i<TQ.length;i++){if(r<=TQ[i][0]){const a=TQ[i-1],b=TQ[i];return a[1]+(b[1]-a[1])*(r-a[0])/(b[0]-a[0])}}return 0}
  const clamp=(x,a,b)=>x<a?a:x>b?b:x;
  const sstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};
  function newState(){
    return{gear:0,shiftT:0,thr:0,brk:0,rb:0,steerIn:0,rpmE:D.idle,
      phi:0,phiDot:0,delta:0,yaw:0,kappa:0,ax:0,ay:0,
      thetaW:0,thetaWd:0,wl:0,manOn:false,dF:D.sagF,dR:D.sagR,pitchS:0,lif:0,tcs:0,mu:D.mu};
  }
  // ---- gearbox (call once per frame) ----
  function shift(s,sp,th,dt){
    const wr=g=>sp/D.R*D.ratios[g]*9.5493;
    if(s.shiftT>0){s.shiftT-=dt;return}
    if(s.gear<5&&wr(s.gear)>6000+3800*th&&wr(s.gear+1)>3300){s.gear++;s.shiftT=.14}
    else if(s.gear>0&&((wr(s.gear)<2600+1500*th)||(th>.9&&wr(s.gear)<5200&&wr(s.gear-1)<9300))&&wr(s.gear-1)<9800){s.gear--;s.shiftT=.12}
    if(sp<1.5&&s.gear>0)s.gear=0;
  }
  // ---- yaw rate + lean dynamics. u = forward speed (>=0 expected). returns yaw rate (rad/s) ----
  function lateral(s,u,h){
    const sp=Math.max(0,u),g=D.g,mu=s.mu;
    const ax=s.ax,circ=Math.sqrt(Math.max(0,mu*mu-(ax/g)*(ax/g)));
    const phiCap=Math.min(D.phiMax,Math.atan(circ));
    const phiFull=phiCap;                 // full stick at very high speed asks for a little less lean
    const kLock=Math.tan(D.lock)*Math.cos(D.rake)/D.L;             // tightest curvature the bars allow
    const st=s.steerIn;
    const phiLock=Math.atan(sp*sp*kLock/g);                        // lean needed for full-lock curvature at this speed
    // car-like steering feel: the stick commands a yaw RATE that stays strong at high speed (lean is shown as ~60% of the physical need)
    const yawMax=Math.max(.7,2.5/(1+(sp/34)*(sp/34))),yawT=st*yawMax;
    const lk=sp<22.2?1:sp<33.3?1-.143*(sp-22.2)/11.1:sp<44.4?.857-.08*(sp-33.3)/11.1:.777;   // max lean: 43deg @120km/h, 39deg @160km/h+
                                     // visual lean gets much lighter at high speed (realistic look)
    const phiT=Math.sign(st)*Math.min(Math.atan(.6*sp*Math.abs(yawT)/g)*lk,phiLock,phiFull*lk);
    // roll response: quick when slow, heavier with speed (gyroscopic), critically-ish damped
    const w=15.5+.5/(1+(sp/30)*(sp/30)),z=.9;
    let acc=w*w*(phiT-s.phi)-2*z*w*s.phiDot;
    s.phiDot+=acc*h;s.phiDot=clamp(s.phiDot,-3.4,3.4);
    s.phi+=s.phiDot*h;
    if(s.phi>D.phiMax){s.phi=D.phiMax;if(s.phiDot>0)s.phiDot=0}else if(s.phi<-D.phiMax){s.phi=-D.phiMax;if(s.phiDot<0)s.phiDot=0}
    // curvature: kinematic (bars) at low speed, lean-derived at speed
    const dLow=st*D.lock*(1-.5*sstep(1.5,5,sp));
    const kKin=Math.tan(dLow)*Math.cos(D.rake)/D.L;
    s.yawF=(s.yawF||0)+(yawT-(s.yawF||0))*Math.min(1,h*13);
    const kLean=s.yawF/Math.max(sp,1);
    const bl=sstep(2.5,7.5,sp);
    const kappa=kKin*(1-bl)+kLean*bl;
    s.kappa=kappa;s.yaw=kappa*sp;s.ay=kappa*sp*sp;
    // bar angle about the steering axis (what the rider actually does)
    const roadA=Math.atan(D.L*kappa),dSS=Math.atan(Math.tan(roadA)/Math.cos(D.rake));
    const dCS=-clamp(.055*s.phiDot*Math.min(1,sp/14),-.1,.1);       // counter-steer pulse while rolling in/out
    s.delta=dLow*(1-bl)+(dSS+dCS)*bl;
    return s.yaw;
  }
  // ---- longitudinal. u = forward speed (signed). inp: {thr,brk,rb}. returns new u ----
  function longitudinal(s,u,h){
    const m=D.m,g=D.g,mu=s.mu,sp=Math.abs(u),L=D.L,hh=D.h;
    const th=s.thr;
    const ratio=D.ratios[s.gear];
    const rpmW=sp/D.R*ratio*9.5493;
    // clutch slip: engine revs above the wheels at launch
    s.rpmE=Math.max(rpmW,D.idle+th*3200*(rpmW<D.idle+3200?1:0));
    let Te=th*tq(s.rpmE)-(1-th)*(rpmW>1300?8+.0016*rpmW:0);
    if(s.shiftT>0)Te=Math.min(Te,0);
    if(s.rpmE>D.limiter-500&&Te>0)Te*=clamp((D.limiter-s.rpmE)/500,0,1);
    // front-lift limiter (like the bike's own electronics)
    const lif=s.manOn?0:sstep(.17,.42,s.thetaW);s.lif=lif;if(Te>0)Te*=1-lif;
    let F=Te*ratio*D.eff/D.R;
    // traction (rear): load transfer + friction circle (lean uses up grip)
    const ayN=Math.min(.45,Math.abs(s.ay)/(mu*g)),circ=Math.sqrt(Math.max(0,1-ayN*ayN));   // arcade: cornering never robs the drive
    const wl=sstep(0,.05,s.thetaW);                                   // front wheel in the air -> all weight on the rear
    const Ftr=circ*mu*m*g*(D.aF/L*(1-wl)+wl)/Math.max(.05,1-mu*hh/L*(1-wl));
    s.tcs=0;if(F>.97*Ftr){F=.97*Ftr;s.tcs=1}
    // brakes (front+rear with ABS): limited by front load transfer and the friction circle
    const decMax=circ*mu*g*(D.bR/L)/Math.max(.05,1-mu*hh/L);
    let aBrk=Math.min(s.brk*D.brakeA,decMax)+Math.min(s.rb*D.rearBrakeA,mu*g*.35);
    aBrk=Math.min(aBrk,circ*mu*g*1.02);
    if(s.thetaW>.02)aBrk*=.55;                                         // front brake does little in the air
    const su=Math.tanh(u/.4);
    const aero=.5*D.rho*D.CdA*u*Math.abs(u),roll=D.Crr*m*g*Math.tanh(u/.3);
    const a=(F-aero-roll)/m-aBrk*su;
    const un=u+a*h;
    const uOut=(s.thr<.02&&u*un<0)||(s.brk>.01&&u*un<0)?0:un;
    s.ax+=((a)-s.ax)*Math.min(1,h*14);
    if(s.manOn){s.thetaWd=0;return uOut}                               // manual wheelie (SPACE bar): angle is driven by stepBike
    // wheelie: rigid body pitching about the rear contact patch
    const bR=D.bR,Ip=m*(bR*bR+hh*hh)+22;
    let thd=s.thetaWd,t=s.thetaW;
    const ac=s.ax;
    const tau=m*ac*(bR*Math.sin(t)+hh*Math.cos(t))-m*g*(bR*Math.cos(t)-hh*Math.sin(t))-60*thd;
    // rider keeps the front wheel from looping over (like the real bike's wheelie control): strong restoring torque above ~18deg, and no wheelie at walking speed
    const ctl=-(90*Math.max(0,t-.32)+(t>.2?8*thd:0)+(sp<3?40*t:0));      // angular accel (rad/s^2)
    thd+=tau/Ip*h+ctl*h;t+=thd*h;
    if(t<=0){t=0;if(thd<0)thd=0}
    if(t>.6){t=.6;if(thd>0)thd=0}
    s.thetaW=t;s.thetaWd=thd;
    return uOut;
  }
  // ---- suspension / body pitch (per frame) ----
  function suspension(s,dt){
    const g=D.g,ax=s.ax;
    const tF=clamp(D.sagF+Math.max(0,-ax)/g*.075-Math.max(0,ax)/g*.02,0,D.travelF)*(1-sstep(0,.12,s.thetaW));
    const tR=clamp(D.sagR+Math.max(0,ax)/g*.05-Math.max(0,-ax)/g*.012+sstep(0,.2,s.thetaW)*.02,0,D.travelR);
    const k=Math.min(1,dt*10);
    s.dF+=(tF-s.dF)*k;s.dR+=(tR-s.dR)*k;
    s.pitchS=(s.dR-s.dF*Math.cos(D.rake))/D.L;
  }
  return{D,newState,shift,lateral,longitudinal,suspension,tq,clamp,sstep};
})();

// ---------------------------------------------------------------------------------------------------------
// 2) RIDER KINEMATICS (pure maths, body coordinates: x right, y up, z backwards)
// ---------------------------------------------------------------------------------------------------------
const RiderMath=(function(){
  const rotX=(v,a)=>{const c=Math.cos(a),s=Math.sin(a);return[v[0],v[1]*c-v[2]*s,v[1]*s+v[2]*c]};
  const rotZ=(v,a)=>{const c=Math.cos(a),s=Math.sin(a);return[v[0]*c-v[1]*s,v[0]*s+v[1]*c,v[2]]};
  const add=(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
  const mul=(a,k)=>[a[0]*k,a[1]*k,a[2]*k],dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],len=a=>Math.hypot(a[0],a[1],a[2]);
  const norm=a=>{const l=len(a)||1;return[a[0]/l,a[1]/l,a[2]/l]};
  // two-bone IK: returns the middle joint (elbow / knee)
  function ik2(a,t,l1,l2,pole){
    const d=sub(t,a);let dist=len(d);const maxD=l1+l2-1e-4;if(dist>maxD)dist=maxD;if(dist<.05)dist=.05;
    const n=norm(d),x=(l1*l1-l2*l2+dist*dist)/(2*dist),y=Math.sqrt(Math.max(0,l1*l1-x*x));
    let p=sub(pole,mul(n,dot(pole,n)));p=norm(p);
    return add(add(a,mul(n,x)),mul(p,y));
  }
  const P0={pelvisY:.955,pelvisZ:.22,hipX:.10,torso:.46,shX:.19,upperArm:.29,foreArm:.27,thigh:.44,shin:.43,
            headY:.64,headZ:-.05,alpha0:.66,hang:.09,ubRoll:.30};
  function pose(p){
    const o={},phi=p.phi,alpha=p.alpha;
    const hang=P0.hang*Math.max(-1,Math.min(1,phi/.75));
    o.pelvis=[-hang,P0.pelvisY,P0.pelvisZ];
    o.ubRotX=-alpha;o.ubRotZ=P0.ubRoll*phi;
    const ub=v=>add(o.pelvis,rotZ(rotX(v,-alpha),o.ubRotZ));    // upper-body local -> body
    o.shL=ub([-P0.shX,P0.torso,0]);o.shR=ub([P0.shX,P0.torso,0]);
    o.head=ub([0,P0.headY,P0.headZ]);
    o.hipL=[o.pelvis[0]-P0.hipX,o.pelvis[1]-.01,o.pelvis[2]];o.hipR=[o.pelvis[0]+P0.hipX,o.pelvis[1]-.01,o.pelvis[2]];
    const hl=[p.gripL[0]-.035,p.gripL[1]+.015,p.gripL[2]],hr=[p.gripR[0]+.035,p.gripR[1]+.015,p.gripR[2]];
    o.handL=hl;o.handR=hr;
    o.elbL=ik2(o.shL,hl,P0.upperArm,P0.foreArm,[-.55,-1,.3]);o.elbR=ik2(o.shR,hr,P0.upperArm,P0.foreArm,[.55,-1,.3]);
    o.ankL=add(p.pegL,[0,.075,.085]);o.ankR=add(p.pegR,[0,.075,.085]);
    o.toeL=add(p.pegL,[0,.04,-.14]);o.toeR=add(p.pegR,[0,.04,-.14]);
    o.kneeL=ik2(o.hipL,o.ankL,P0.thigh,P0.shin,[-.3,.2,-1]);o.kneeR=ik2(o.hipR,o.ankR,P0.thigh,P0.shin,[.3,.2,-1]);
    return o;
  }
  return{P0,pose,ik2,len,sub};
})();

// ---------------------------------------------------------------------------------------------------------
// 3) THREE rig
// ---------------------------------------------------------------------------------------------------------
let BIKE=null;                       // active bike (null while driving a car)
const BIKE_RC=.075;                  // tyre cross-section radius: the bike rolls over this circle when it leans

async function buildBikeCar(id,cfg,pk){
  if(!pk||!pk.z)throw new Error('bike data missing: '+id);
  if(!THREE.GLTFLoader||!window.fflate)throw new Error('GLTFLoader/fflate unavailable');
  const bytes=fflate.gunzipSync(z85Decode(pk.z,pk.n));
  const gltf=await trafficParseGLB(new THREE.GLTFLoader(),bytes);
  const bikeRoot=gltf.scene;bikeRoot.name='BikeRoot_'+id;
  const bc=cfg.bike,N=n=>bikeRoot.getObjectByName(n);
  const need=['steer','fork_lower','wheel_f','wheel_r','swingarm','grip_l','grip_r'];
  for(const n of need)if(!N(n))throw new Error('bike node missing: '+n);
  for(const n of ['steer','fork_lower','wheel_f','wheel_r','swingarm']){const o=N(n);o.userData.q0=o.quaternion.clone();o.userData.p0=o.position.clone()}

  // lean (about the tyre crown) > suspension pitch > wheelie pitch (about the rear contact patch) > body
  const zS=0,zR=bc.rearZ;
  const lean=new THREE.Group(),sus=new THREE.Group(),whl=new THREE.Group(),body=new THREE.Group();
  lean.name='bikeLean';lean.position.set(0,BIKE_RC,0);
  sus.position.set(0,-BIKE_RC,zS);whl.position.set(0,0,zR-zS);body.position.set(0,0,-zR);
  lean.add(sus);sus.add(whl);whl.add(body);body.add(bikeRoot);

  const S={children:[lean],wheels:[],pivots:[],paint:[],paintDef:new Map(),glass:[],cluster:null,swPivot:null,swAxis:null,EYE:new THREE.Vector3(0,1.4,-.3),pitch:cfg.pitch,
    mirPanels:[],MIRC:[],mirrorHost:null,handParts:[],armUpd:null,dome:null,domeFix:null,rearPos:new THREE.Vector3(...cfg.rear),spots:cfg.spots.map(s=>new THREE.Vector3(...s))};

  // materials / shadows / paint / emissive groups
  const seen=new Set(),M={tail:[],head:[],dash:[],lamp:[]};
  bikeRoot.traverse(o=>{
    if(!o.isMesh)return;
    o.castShadow=true;o.receiveShadow=true;
    for(const m of (Array.isArray(o.material)?o.material:[o.material])){
      if(!m||seen.has(m))continue;seen.add(m);
      m.side=THREE.DoubleSide;
      if(m.map)m.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
      if(m.name==='Paint_Body'){S.paint.push(m);S.paintDef.set(m,{roughness:.45,metalness:0,envMapIntensity:m.envMapIntensity});m.roughness=.45;m.metalness=0}
      if(/^Taillight$/.test(m.name))M.tail.push(m);
      else if(/^Headlight_LED$/.test(m.name))M.head.push(m);
      else if(/^Dash_|^Indicator|^Lamp_/.test(m.name))M.dash.push(m);
      m.needsUpdate=true;
    }
  });
  // headlamp / tail glow overlays (same non-indexed triangle-list convention as the cars)
  bikeRoot.updateMatrixWorld(true);
  const disc=(x,y,z,r,dirZ)=>{
    const g0=new THREE.CircleGeometry(r,14);if(dirZ<0)g0.rotateY(Math.PI);g0.translate(x,y,z);return g0.toNonIndexed();
  };
  const mkGlow=(geos,mat,parent,name)=>{
    const pos=[];for(const g of geos)pos.push(...g.attributes.position.array);
    const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));
    const me=new THREE.Mesh(g,mat);me.name=name;me.renderOrder=10;me.castShadow=false;me.receiveShadow=false;me.frustumCulled=false;
    bikeRoot.add(me);parent.attach(me);
    // bake the node transform into the geometry: lamp-split code (initCarParts) re-creates the mesh with an identity transform
    me.updateMatrix();me.geometry.applyMatrix4(me.matrix);me.position.set(0,0,0);me.quaternion.set(0,0,0,1);me.scale.set(1,1,1);me.updateMatrix();
    return me;
  };
  mkGlow([disc(-.065,.836,-.79,.04,-1),disc(.072,.836,-.79,.04,-1)],headM,N('steer'),'GLOW_HEAD');
  mkGlow([disc(-.045,.93,.735,.028,1),disc(.045,.93,.735,.028,1)],tailM,N('chassis')||bikeRoot,'GLOW_TAIL');

  const glows=[];bikeRoot.traverse(o=>{if(o.name==='GLOW_HEAD'||o.name==='GLOW_TAIL')glows.push(o)});
  // ---- rider ----
  const rider=buildRider(bc);body.add(rider.root);

  // ---- bike object ----
  const lampL=[[-.065,.84,-.79],[.072,.84,-.79]].map(a=>N('steer').worldToLocal(bikeRoot.localToWorld(new THREE.Vector3(...a))));
  const B={id,cfg,lampL,glows,mass:BikePhys.D.m,s:BikePhys.newState(),lean,sus,whl,body,root:bikeRoot,N,rider,M,
    steer:N('steer'),forkL:N('fork_lower'),wf:N('wheel_f'),wr:N('wheel_r'),swing:N('swingarm'),gripL:N('grip_l'),gripR:N('grip_r'),
    gears:['n','1','2','3','4','5','6'].map(k=>N('gear_'+k)),eye:rider.eye,
    spinF:0,spinR:0,dv:0,hideCockpit:rider.hideCockpit,lastGear:-1,lastEm:'',
    reset(){B.s=BikePhys.newState();B.spinF=B.spinR=0;B.dv=0;B.rev=false;B.revT=0;B.lost=false;B.lostT=0;wheelieHide();bikeFlameOff(B);B.apply(0)},
    apply:null};
  B.apply=bikeApplyPose.bind(null,B);
  try{B.flame=buildBikeFlame(bikeRoot,bc)}catch(e){console.warn('bike flame failed',e);B.flame=null}
  try{B.hands=buildBikeHands(lean,body,N);if(B.hands){S.handParts=B.hands.parts;for(const o of B.hands.parts)o.visible=false}}catch(e){console.warn('bike hands failed',e);B.hands=null}
  B.apply(0);

  // ---- speedometer on the bike's own TFT screen (the tilted panel above the handlebars) ----
  // Screen placement (bikeRoot space, measured from the model's Dash_Display quad): centre c, size w x h, 'up' = direction up the tilted face.
  try{
    const sc=Object.assign({c:[.004,1.044,-.6375],up:[0,.776,-.630],w:.152,h:.098,off:.004},bc.screen||{});
    const SW=620,SH=400,F='Tahoma,Arial,sans-serif';
    const dc=document.createElement('canvas');dc.width=SW;dc.height=SH;const dx=dc.getContext('2d');
    const dtex=new THREE.CanvasTexture(dc);dtex.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
    const dmat=new THREE.MeshBasicMaterial({map:dtex,fog:false,side:THREE.DoubleSide,transparent:false,alphaTest:.35,depthTest:true,depthWrite:true,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,toneMapped:false});
    const disp=new THREE.Mesh(new THREE.PlaneGeometry(sc.w,sc.h),dmat);
    disp.name='DashDisplayTFT';disp.frustumCulled=false;disp.castShadow=false;disp.receiveShadow=false;
    // plane basis: x = bike right, y = up the tilted face, z = face normal (towards the rider)
    const X=new THREE.Vector3(1,0,0),Y=new THREE.Vector3(...sc.up).normalize(),Z=new THREE.Vector3().crossVectors(X,Y).normalize();
    const pos=new THREE.Vector3(...sc.c).addScaledVector(Z,sc.off);
    const steerN=N('steer');lean.updateMatrixWorld(true);steerN.updateMatrixWorld(true);bikeRoot.updateMatrixWorld(true);
    const M=new THREE.Matrix4().makeBasis(X,Y,Z).setPosition(pos);
    M.premultiply(bikeRoot.matrixWorld).premultiply(new THREE.Matrix4().copy(steerN.matrixWorld).invert());   // bikeRoot space -> steer-local (it turns with the bars)
    M.decompose(disp.position,disp.quaternion,disp.scale);
    const cl=new THREE.Group();cl.name='bikeCluster';cl.visible=false;cl.frustumCulled=false;cl.add(disp);steerN.add(cl);
    cl.userData.panelSize={width:sc.w,height:sc.h};S.cluster=cl;
    const rr=(c,x,y,w,h,r)=>{c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath()};
    let key='',last=-1e9;
    // layout fitted to the screen's 1.55:1 shape: big speed (left), gear box (right), segmented speed bar along the bottom
    function drawDisplay(kmh,rpm,gear){
      const v=Math.max(0,kmh),k=Math.round(v)+'|'+gear;if(k===key)return;
      const t=performance.now();if(t-last<33)return;last=t;key=k;
      const c=dx;c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,SW,SH);
      const g=c.createLinearGradient(0,0,0,SH);g.addColorStop(0,'#0b1522');g.addColorStop(1,'#04070c');
      c.fillStyle=g;rr(c,0,0,SW,SH,34);c.fill();
      c.strokeStyle='#2a3d52';c.lineWidth=6;rr(c,3,3,SW-6,SH-6,32);c.stroke();
      c.textBaseline='alphabetic';c.textAlign='right';
      c.fillStyle='#ffffff';c.font='bold 190px '+F;c.fillText(String(Math.round(v)),410,226);
      c.fillStyle='#8ea5b8';c.font='bold 34px '+F;c.fillText('km/h',410,274);
      rr(c,448,44,140,200,22);c.fillStyle='#0a1118';c.fill();c.strokeStyle='#ff3b30';c.lineWidth=4;c.stroke();
      c.textAlign='center';c.fillStyle='#8ea5b8';c.font='bold 26px '+F;c.fillText('GEAR',518,86);
      c.fillStyle='#4fd6ff';c.font='bold 130px '+F;c.fillText(String(gear),518,208);
      const n=28,x0=34,gp=4,bw=(SW-2*x0-(n-1)*gp)/n,by=296,bh=52;
      for(let i=0;i<n;i++){
        c.fillStyle=v>i*10+2?(i<16?'#4fd6ff':(i<22?'#ffb020':'#ff3b30')):'#16222f';
        rr(c,x0+i*(bw+gp),by,bw,bh,4);c.fill();
      }
      c.fillStyle='#8ea5b8';c.font='bold 22px '+F;c.textAlign='left';
      for(const m of [0,80,160,240]){const x=x0+(m/10)*(bw+gp);c.fillText(String(m),x,by+bh+28)}
      dtex.needsUpdate=true;
    }
    S.drawDisplay=drawDisplay;
  }catch(e){console.warn('bike display failed',e)}
  S.bike=B;
  B.drawDisplay=S.drawDisplay||null;
  return S;
}


// ----- the SAME hands + arms as the cars (HandsGeo / buildHands from game.js), re-posed to grip the handlebar -----
function buildBikeHands(lean,body,N){
  if(typeof DRIVER_HANDS==='undefined'||!DRIVER_HANDS||typeof HandsGeo==='undefined'||typeof buildHands!=='function')return null;
  const H=HandsGeo,V=H.V,F=new THREE.Group();F.name='bikeHandsFrame';F.rotation.y=Math.PI;body.add(F);   // Lancer interior space -> bike (like the cars)
  H.setRim({ring:.165,rx:.0175,ra:.0175,s0:.01,ox:0,oy:0});                                          // hand closes around a ~35 mm grip instead of a steering-wheel rim
  lean.updateMatrixWorld(true);
  const invB=new THREE.Matrix4().copy(body.matrixWorld).invert();
  const P0=s=>{const ph=s*80*Math.PI/180,sn=Math.sin(ph),cs=Math.cos(ph);return V.add(V.mul(V.add(V.mul([1,0,0],sn),V.mul(H.UP,cs)),.165),V.mul(H.AX,.01))};
  const mir=v=>[-v[0],v[1],v[2]],hands=[],ups=[],before=handParts.length;
  for(const s of [1,-1]){                                                     // s=+1 is the LEFT hand (as in the cars)
    const grip=N(s===1?'grip_l':'grip_r');if(!grip)return null;
    const Mg=new THREE.Matrix4().multiplyMatrices(invB,grip.matrixWorld);
    const gp=new THREE.Vector3().setFromMatrixPosition(Mg);
    const G=[gp.x+(s===1?.03:-.03),gp.y,gp.z],SH=[s===1?-.19:.19,1.32,-.06];
    const ax=H.grip(s).axes,GL=s===1?G:mir(G),SL=s===1?SH:mir(SH);
    const tA=V.norm(V.sub(SL,GL)),up=[0,1,0];
    const tR=V.norm(V.sub(up,V.mul(tA,V.dot(up,tA)))),tT=V.cross(tR,tA);
    let T=[tT,tR,tA];if(s===-1)T=T.map(mir);
    const S=[ax.eT,ax.eR,ax.eA],R=[[0,0,0],[0,0,0],[0,0,0]];
    for(let i=0;i<3;i++)for(let r=0;r<3;r++)for(let c=0;c<3;c++)R[r][c]+=T[i][r]*S[i][c];
    const p0=P0(s),t=[G[0]-(R[0][0]*p0[0]+R[0][1]*p0[1]+R[0][2]*p0[2]),G[1]-(R[1][0]*p0[0]+R[1][1]*p0[1]+R[1][2]*p0[2]),G[2]-(R[2][0]*p0[0]+R[2][1]*p0[1]+R[2][2]*p0[2])];
    const Mb=new THREE.Matrix4().set(R[0][0],R[0][1],R[0][2],t[0],R[1][0],R[1][1],R[1][2],t[1],R[2][0],R[2][1],R[2][2],t[2],0,0,0,1);
    const T0=new THREE.Matrix4().copy(Mg).invert().multiply(Mb);
    const hp=new THREE.Group();F.add(hp);
    const prev=armUpd,arms=buildHands(F,hp,{only:s,S:{[s]:[-SH[0],SH[1],-SH[2]]}});ups.push(armUpd);armUpd=prev;
    if(!arms||!arms.length)return null;
    hands.push({s,grip,hp,T0,arm:arms[0]});
  }
  const parts=handParts.splice(before);
  H.setRim({ring:.165,rx:.025,ra:.02,s0:.01,ox:0,oy:0});                                              // back to the steering-wheel fit for the cars
  const m=new THREE.Matrix4(),iF=new THREE.Matrix4();
  return{parts,F,hands,
    place(o){                                                                  // o = rider pose (body space)
      iF.copy(F.matrixWorld).invert();
      for(const h of hands){
        m.multiplyMatrices(iF,h.grip.matrixWorld).multiply(h.T0);m.decompose(h.hp.position,h.hp.quaternion,h.hp.scale);
        const sh=h.s===1?o.shL:o.shR,S=h.arm.S;S[0]=-sh[0];S[1]=sh[1];S[2]=-sh[2];h.arm.sh.position.set(S[0],S[1],S[2]);
      }
    },
    update(){for(const u of ups)if(u)u()}};
}

// ----- rider (procedural mannequin: dark leathers, white helmet) -----
function buildRider(bc){
  const root=new THREE.Group();root.name='Rider';
  const mat=(c,r,m)=>new THREE.MeshStandardMaterial({color:c,roughness:r,metalness:m||0});
  const jacket=mat(0x16181d,.6),pants=mat(0x1a212c,.8),boot=mat(0x0d0e10,.55),glove=mat(0x0f1013,.45),helmetM=mat(0xf2f2ef,.25),visorM=mat(0x05080c,.08,.25),accent=mat(0xe0560b,.55);
  const hideCockpit=[];
  const _Y=new THREE.Vector3(0,1,0),_d=new THREE.Vector3(),_m=new THREE.Vector3();
  const seg=(m,ra,rb,parent)=>{const me=new THREE.Mesh(new THREE.CylinderGeometry(rb,ra,1,14,1),m);me.castShadow=true;(parent||root).add(me);return me};
  const sph=(m,r,sx,sy,sz,parent)=>{const me=new THREE.Mesh(new THREE.SphereGeometry(r,14,10),m);me.scale.set(sx||1,sy||1,sz||1);me.castShadow=true;(parent||root).add(me);return me};
  const V=a=>new THREE.Vector3(a[0],a[1],a[2]);
  const place=(me,a,b)=>{_m.copy(a).add(b).multiplyScalar(.5);me.position.copy(_m);_d.copy(b).sub(a);const l=_d.length()||1e-3;me.scale.set(1,l,1);me.quaternion.setFromUnitVectors(_Y,_d.multiplyScalar(1/l))};
  // upper body group (pivot at the pelvis)
  const UB=new THREE.Group();UB.rotation.order='ZXY';root.add(UB);
  const torso=new THREE.Mesh(new THREE.CylinderGeometry(.165,.15,.5,18),jacket);torso.scale.set(1.2,1,.74);torso.position.set(0,.25,0);torso.castShadow=true;UB.add(torso);
  const chest=sph(jacket,.17,1.2,.85,.78,UB);chest.position.set(0,.37,-.015);
  const belly=sph(jacket,.15,1.15,.8,.78,UB);belly.position.set(0,.06,0);
  const shLs=sph(jacket,.075,1,1,1,UB),shRs=sph(jacket,.075,1,1,1,UB);shLs.position.set(-.19,.46,0);shRs.position.set(.19,.46,0);
  const pad=sph(accent,.045,1.5,.6,1.1,UB);pad.position.set(0,.52,.09);                // hump stripe on the back
  const neck=seg(jacket,.06,.055,UB);neck.position.set(0,.55,-.01);neck.scale.set(1,.1,1);
  const HG=new THREE.Group();HG.position.set(0,.66,-.045);UB.add(HG);
  const helmet=sph(helmetM,.148,.93,1,1.1,HG);
  const visor=new THREE.Mesh(new THREE.SphereGeometry(.152,18,10,Math.PI*1.5-.85,1.7,.95,.62),visorM);visor.scale.set(.93,1,1.1);visor.rotation.y=0;HG.add(visor);
  const stripe=new THREE.Mesh(new THREE.TorusGeometry(.149,.012,6,28,Math.PI),accent);stripe.rotation.set(0,Math.PI/2,0);stripe.scale.set(1.1,1,.93);HG.add(stripe);
  const eye=new THREE.Object3D();eye.position.set(0,-.035,.15);HG.add(eye);
  for(const o of [UB,HG])hideCockpit.push(o);
  // limbs (placed each frame from RiderMath joints)
  const limb={uaL:seg(jacket,.06,.05),uaR:seg(jacket,.06,.05),faL:seg(jacket,.05,.042),faR:seg(jacket,.05,.042),
    thL:seg(pants,.088,.066),thR:seg(pants,.088,.066),shL:seg(pants,.065,.052),shR:seg(pants,.065,.052),
    elL:sph(jacket,.052),elR:sph(jacket,.052),knL:sph(pants,.07),knR:sph(pants,.07),hpL:sph(pants,.09),hpR:sph(pants,.09),
    gvL:sph(glove,.05,1,.85,1.5),gvR:sph(glove,.05,1,.85,1.5),
    btL:new THREE.Mesh(new THREE.BoxGeometry(.09,.1,.28),boot),btR:new THREE.Mesh(new THREE.BoxGeometry(.09,.1,.28),boot)};
  limb.btL.castShadow=limb.btR.castShadow=true;root.add(limb.btL);root.add(limb.btR);
  // keep the camera outside the helmet: torso / head are hidden in the cockpit view
  const pl=[],pr=[];
  const R={root,UB,HG,eye,hideCockpit,limb,
    update(p){
      const o=RiderMath.pose(p);
      UB.position.set(...o.pelvis);UB.rotation.set(o.ubRotX,0,o.ubRotZ);
      HG.rotation.set(.82*p.alpha-.0,0,-.5*(p.phi+o.ubRotZ)); // head stays level-ish, looks ahead
      HG.rotation.y=p.look||0;
      const P=a=>V(a);
      place(limb.uaL,P(o.shL),P(o.elbL));place(limb.uaR,P(o.shR),P(o.elbR));
      place(limb.faL,P(o.elbL),P(o.handL));place(limb.faR,P(o.elbR),P(o.handR));
      limb.elL.position.copy(P(o.elbL));limb.elR.position.copy(P(o.elbR));
      limb.gvL.position.copy(P(o.handL));limb.gvR.position.copy(P(o.handR));
      limb.gvL.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),P(o.handL).sub(P(o.elbL)).normalize());
      limb.gvR.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),P(o.handR).sub(P(o.elbR)).normalize());
      place(limb.thL,P(o.hipL),P(o.kneeL));place(limb.thR,P(o.hipR),P(o.kneeR));
      place(limb.shL,P(o.kneeL),P(o.ankL));place(limb.shR,P(o.kneeR),P(o.ankR));
      limb.hpL.position.copy(P(o.hipL));limb.hpR.position.copy(P(o.hipR));
      limb.knL.position.copy(P(o.kneeL));limb.knR.position.copy(P(o.kneeR));
      for(const [bt,an,to] of [[limb.btL,o.ankL,o.toeL],[limb.btR,o.ankR,o.toeR]]){
        bt.position.set((an[0]+to[0])/2,(an[1]+to[1])/2-.01,(an[2]+to[2])/2-.02);
        bt.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),new THREE.Vector3(to[0]-an[0],to[1]-an[1]-.03,to[2]-an[2]).normalize());
      }
      return o;
    }};
  return R;
}

// ----- per-frame pose of every moving part -----
const _qa=new THREE.Quaternion(),_ax=new THREE.Vector3(1,0,0),_az=new THREE.Vector3(0,0,1),_bv=new THREE.Vector3(),_bv2=new THREE.Vector3();
function bikeApplyPose(B,dt){
  const s=B.s,D=BikePhys.D;
  B.lean.rotation.z=s.phi;
  B.sus.position.y=-BIKE_RC-(s.dF*Math.cos(D.rake)+s.dR)/2+(D.sagF*Math.cos(D.rake)+D.sagR)/2;
  B.sus.rotation.x=s.pitchS-(D.sagR-D.sagF*Math.cos(D.rake))/D.L;
  B.whl.rotation.x=s.thetaW;
  B.whl.position.y=.34*BikePhys.sstep(.9,1.7,s.thetaW);          // flipped over: rest on the rider's back / tail instead of sinking into the road
  // steering: rotate the head about the fork axis (local z of the steering node)
  const k=dt>0?Math.min(1,dt*22):1;B.dv+=(s.delta-B.dv)*k;
  _qa.setFromAxisAngle(_az,B.dv);B.steer.quaternion.copy(B.steer.userData.q0).multiply(_qa);
  B.forkL.position.copy(B.forkL.userData.p0);B.forkL.position.z+=s.dF-D.sagF;
  _qa.setFromAxisAngle(_ax,-(s.dR-D.sagR)/D.swingLen);B.swing.quaternion.copy(B.swing.userData.q0).multiply(_qa);
  _qa.setFromAxisAngle(_ax,B.spinF);B.wf.quaternion.copy(B.wf.userData.q0).multiply(_qa);
  _qa.setFromAxisAngle(_ax,B.spinR);B.wr.quaternion.copy(B.wr.userData.q0).multiply(_qa);
  // rider follows the grips
  car.updateMatrixWorld(true);B.lean.updateMatrixWorld(true);
  const rd=B.rider;
  _bv.setFromMatrixPosition(B.gripL.matrixWorld);rd.root.worldToLocal(_bv);
  _bv2.setFromMatrixPosition(B.gripR.matrixWorld);rd.root.worldToLocal(_bv2);
  const bc=B.cfg.bike;
  const alpha=RiderMath.P0.alpha0+BikePhys.clamp(-s.ax/9.81,-.5,1)*.10-s.thetaW*.5;
  const pose=rd.update({phi:s.phi,alpha,gripL:[_bv.x,_bv.y,_bv.z],gripR:[_bv2.x,_bv2.y,_bv2.z],pegL:bc.pegL,pegR:bc.pegR,look:BikePhys.clamp(s.kappa*2.2,-.35,.35)});
  if(B.hands)B.hands.place(pose);
}

// ----- WHEELIE (SPACE): hold = bar fills = front wheel rises; release = bar drains = front wheel comes down; bar full = flips over backwards = lose -----
const WHEELIE={ang:1.05,        // wheel-lift angle (rad) when the bar is full (~60 deg)
  up:.34,upAcc:.30,             // fill speed (bar/s) - gets faster as the bike goes higher
  down:.55,                     // drain speed (bar/s) after releasing the key
  minSpeed:3,                   // m/s: a wheelie needs some speed to start
  fallMax:1.75};                // final angle when the bike lies on its back (rad)
let _wlEl=null,_wlFill=null,_loseEl=null;
function wheelieUI(){
  if(_wlEl)return;
  const st0=document.createElement('style');
  st0.textContent='body:not(.game-playing) #wheelieBar{display:none!important}'+
    '#wheelieBar{position:fixed;left:50%;bottom:calc(26px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);width:min(320px,70vw);z-index:30;pointer-events:none;direction:ltr;font-family:Tahoma,Arial,sans-serif;display:none}'+
    '#wheelieBar .wl-t{display:flex;justify-content:space-between;color:#fff;font-size:12px;font-weight:700;text-shadow:0 1px 3px #000;margin-bottom:4px}'+
    '#wheelieBar .wl-bg{height:16px;border-radius:9px;background:rgba(8,14,22,.72);border:2px solid rgba(255,255,255,.55);overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.5)}'+
    '#wheelieBar .wl-f{height:100%;width:0;border-radius:7px}'+
    '#wheelieBar.danger .wl-bg{animation:wlBlink .22s infinite alternate}@keyframes wlBlink{to{border-color:#ff3b30;box-shadow:0 0 14px #ff3b30}}'+
    '#bikeLose{position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:rgba(0,0,0,.55);backdrop-filter:blur(3px);color:#fff;text-align:center;font-family:Tahoma,Arial,sans-serif;direction:rtl;cursor:pointer}'+
    '#bikeLose h1{margin:0;font-size:clamp(28px,6vw,56px);color:#ff5148;text-shadow:0 3px 14px #000}'+
    '#bikeLose p{margin:0;font-size:clamp(15px,2.6vw,22px)}#bikeLose small{opacity:.85;font-size:15px}';
  document.head.appendChild(st0);
  _wlEl=document.createElement('div');_wlEl.id='wheelieBar';
  _wlEl.innerHTML='<div class="wl-t"><span>WHEELIE</span><span class="wl-p">0%</span></div><div class="wl-bg"><div class="wl-f"></div></div>';
  document.body.appendChild(_wlEl);_wlFill=_wlEl.querySelector('.wl-f');
  _loseEl=document.createElement('div');_loseEl.id='bikeLose';
  _loseEl.innerHTML='<h1>💥 وقعت على ضهرك!</h1><p>خسرت - الموتسيكل انقلب للخلف</p><p id="bikeLoseScore"></p><small>اضغط Enter أو Space أو المس الشاشة لإعادة المحاولة</small>';
  document.body.appendChild(_loseEl);
  _loseEl.addEventListener('pointerdown',()=>{if(BIKE&&BIKE.lost&&BIKE.lostReady)bikeRestart()});
  addEventListener('keydown',e=>{
    if(!BIKE||!BIKE.lost||!BIKE.lostReady||e.repeat)return;
    if(e.code==='Enter'||e.code==='NumpadEnter'||e.code==='Space'){e.preventDefault();e.stopImmediatePropagation();bikeRestart()}
  },true);
}
function wheelieHide(){
  if(_wlEl)_wlEl.style.display='none';
  if(_loseEl)_loseEl.style.display='none';
  if(BIKE)BIKE.lostReady=false;
}
function wheelieShow(v,danger){
  wheelieUI();
  _wlEl.style.display='block';
  const pc=Math.round(v*100);
  _wlFill.style.width=pc+'%';
  _wlFill.style.background=v<.5?'linear-gradient(90deg,#2ee86b,#b6e82e)':(v<.8?'linear-gradient(90deg,#e8d52e,#ff9a1f)':'linear-gradient(90deg,#ff9a1f,#ff3b30)');
  _wlEl.querySelector('.wl-p').textContent=pc+'%';
  _wlEl.classList.toggle('danger',!!danger);
}
function wheelieUpdate(B,dt,press,u0){
  const s=B.s,W=WHEELIE;
  if(!_wlEl)wheelieUI();
  if(B.lost){                                              // falling over backwards, then lying on its back
    s.manOn=true;
    s.thetaWd=Math.min(s.thetaWd+9*dt,3.4);s.thetaW+=s.thetaWd*dt;
    if(s.thetaW>W.fallMax){s.thetaW=W.fallMax;s.thetaWd=s.thetaWd>1?-s.thetaWd*.22:0}
    B.lostT+=dt;
    wheelieShow(1,true);
    if(B.lostT>1.0&&!B.lostReady){
      B.lostReady=true;
      try{drvSave(true)}catch(e){}
      const sc=document.getElementById('bikeLoseScore');
      if(sc){let n=0;try{n=Math.floor(drvScore)}catch(e){}sc.textContent='النقاط: '+(typeof fmtNum==='function'?fmtNum(n):n)}
      _loseEl.style.display='flex';
    }
    return;
  }
  if(!s.manOn){
    if(press&&u0>=W.minSpeed){s.manOn=true;s.wl=Math.min(.95,Math.max(0,s.thetaW/W.ang))}
    else{if(_wlEl&&_wlEl.style.display!=='none')_wlEl.style.display='none';return}
  }
  if(press&&u0>=W.minSpeed*.5)s.wl+=(W.up+W.upAcc*s.wl)*dt;
  else s.wl-=W.down*dt;
  if(s.wl<=0){s.wl=0;s.manOn=false;s.thetaW=0;s.thetaWd=0;if(_wlEl)_wlEl.style.display='none';return}
  if(s.wl>=1){                                              // too high: over the balance point -> flips over
    s.wl=1;B.lost=true;B.lostT=0;B.lostReady=false;s.thetaW=W.ang;s.thetaWd=.5;
    wheelieShow(1,true);return;
  }
  s.thetaW=s.wl*W.ang;s.thetaWd=0;
  wheelieShow(s.wl,s.wl>.8);
}
function bikeRestart(){
  const B=BIKE;if(!B)return;
  B.lost=false;B.lostReady=false;wheelieHide();
  try{
    st.x=10.17;st.z=0;st.h=0;st.wx=st.wz=0;st.steer=0;st.thr=0;st.roll=st.pitch=0;
    reset();
    if(typeof resetSegmentPositions==='function')resetSegmentPositions();
    if(typeof resetTrafficFleet==='function')resetTrafficFleet();
    if(typeof drvReset==='function')drvReset();
    if(typeof placeCarOnRoad==='function')placeCarOnRoad();
  }catch(e){console.warn('bike restart failed',e)}
}

// ============================================================================================================
//  MOTORCYCLE SOUND  (procedural Web Audio, no audio files)
//  Engine  : Yamaha CP3 "crossplane" triple -> uneven firing 270 / 180 / 270 deg (the MT-09's lumpy growl).
//            3 looped "engine cycle" layers (low / mid / high rpm) are cross-faded and pitch-scaled with the real rpm,
//            then saturated + filtered by throttle load, plus intake roar, wind, rev-limiter cut, quick-shifter cut, exhaust pops.
//  Horn    : thin, buzzy single-tone motorcycle horn (different from the car's two-tone horn).
// ============================================================================================================
// <BikeSndMath>
const BikeSndMath=(function(){
  const FIRE=[0,.375,.625],AMP=[1,.86,.95];                  // firing points as fractions of the 720 deg cycle (270-180-270)
  const LAYERS=[
    {rpm:2400,f1:78,f2:150,f3:290,tau:.015,tauN:.006,noise:.30,click:.08},
    {rpm:5000,f1:110,f2:230,f3:470,tau:.0085,tauN:.0035,noise:.38,click:.14},
    {rpm:9000,f1:160,f2:340,f3:700,tau:.0048,tauN:.0022,noise:.46,click:.22}];
  // `cycles` engine cycles in one loop, each with slightly different pulse strength / timing / noise -> never sounds like a pure repeating tone
  function genLayer(sr,L,cycles,rnd){
    const T=120/L.rpm,N=Math.max(64,Math.round(T*sr*cycles)),out=new Float32Array(N),per=N/cycles,TP=2*Math.PI;
    for(let c=0;c<cycles;c++)for(let k=0;k<3;k++){
      const amp=AMP[k]*(1+(rnd()-.5)*.16),n0=Math.floor(c*per+(FIRE[k]+(rnd()-.5)*.012)*per),len=Math.min(N,Math.floor(sr*L.tau*6));
      let lp=0;
      for(let i=0;i<len;i++){
        const t=i/sr,env=Math.exp(-t/L.tau)*(1-Math.exp(-t/.0003));
        lp+=((rnd()*2-1)-lp)*.35;
        let v=env*(Math.sin(TP*L.f1*t)*.9+Math.sin(TP*L.f2*t+.7)*.55*Math.exp(-t/(L.tau*.6))+Math.sin(TP*L.f3*t+1.9)*.3*Math.exp(-t/(L.tau*.35)));
        v+=lp*Math.exp(-t/L.tauN)*L.noise*1.6+(rnd()*2-1)*Math.exp(-t/.0006)*L.click;
        out[(n0+i)%N]+=v*amp;
      }
    }
    let mean=0;for(let i=0;i<N;i++)mean+=out[i];mean/=N;
    let e=0;for(let i=0;i<N;i++){out[i]-=mean;e+=out[i]*out[i]}
    const g=.2/(Math.sqrt(e/N)||1);
    for(let i=0;i<N;i++)out[i]=Math.tanh(out[i]*g*1.4)*.8;
    return out;
  }
  // exhaust pop / burble: crack + low thump
  function genPop(sr,rnd){
    const N=Math.floor(sr*.12),o=new Float32Array(N);let lp=0,pk=0;
    for(let i=0;i<N;i++){
      const t=i/sr;lp+=((rnd()*2-1)-lp)*.18;
      o[i]=lp*Math.exp(-t/.016)*3+Math.sin(2*Math.PI*125*t)*Math.exp(-t/.028)*.7+(rnd()*2-1)*Math.exp(-t/.0012)*.9;
      pk=Math.max(pk,Math.abs(o[i]));
    }
    for(let i=0;i<N;i++)o[i]=o[i]/(pk||1)*.9;
    return o;
  }
  return{FIRE,LAYERS,genLayer,genPop};
})();
// </BikeSndMath>

// ---------------------------------------------------------------------------------------------------------
// EXHAUST FLAME: a short jet of fire + glow + sparks out of the tailpipe on every exhaust pop.
// It shares the trigger with the pop SOUND (bikePop below), so fire and "bang" always happen together.
// ---------------------------------------------------------------------------------------------------------
// tailpipe mouth + exit direction, measured on the MT-09 model (bikeRoot space: +x right, +y up, +z rear). cfg.bike.exhaust = {p:[x,y,z],d:[x,y,z]} overrides it.
const BIKE_EXHAUST={p:[.232,.517,.682],d:[.05,.40,.915]};
function buildBikeFlame(bikeRoot,bc){
  const ex=Object.assign({},BIKE_EXHAUST,(bc&&bc.exhaust)||{});
  const NAME='BikeFlame_Dash';                    // the name matches game.js's "skip" filter -> hit-box and dents ignore the flame
  const grp=new THREE.Group();grp.name=NAME;grp.visible=false;
  const dir=new THREE.Vector3(ex.d[0],ex.d[1],ex.d[2]).normalize();
  grp.position.set(ex.p[0],ex.p[1],ex.p[2]).addScaledVector(dir,.012);
  grp.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dir);          // flame-local +Y = out of the pipe
  // teardrop flame (lathe), colour fades yellow-white -> orange -> red -> black (black = invisible with additive blending)
  const prof=[[0,0],[.5,.05],[.62,.2],[.5,.42],[.3,.68],[.12,.88],[0,1]].map(a=>new THREE.Vector2(a[0],a[1]));
  const lerp3=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t];
  const ramp=stops=>t=>{for(let i=1;i<stops.length;i++)if(t<=stops[i][0]){const a=stops[i-1],b=stops[i];return lerp3(a[1],b[1],(t-a[0])/(b[0]-a[0]))}return stops[stops.length-1][1]};
  const mkGeo=col=>{
    const g=new THREE.LatheGeometry(prof,12),pos=g.attributes.position,c=new Float32Array(pos.count*3);
    for(let i=0;i<pos.count;i++){const k=col(Math.max(0,Math.min(1,pos.getY(i))));c[i*3]=k[0];c[i*3+1]=k[1];c[i*3+2]=k[2]}
    g.setAttribute('color',new THREE.BufferAttribute(c,3));return g;
  };
  const mkMat=()=>new THREE.MeshBasicMaterial({vertexColors:true,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,fog:false,toneMapped:false});
  const outer=new THREE.Mesh(mkGeo(ramp([[0,[1,.9,.55]],[.25,[1,.55,.12]],[.6,[.9,.22,.03]],[1,[0,0,0]]])),mkMat());
  const inner=new THREE.Mesh(mkGeo(ramp([[0,[1,1,.9]],[.5,[1,.8,.35]],[1,[0,0,0]]])),mkMat());
  for(const m of [outer,inner]){m.name=NAME;m.castShadow=false;m.receiveShadow=false;m.frustumCulled=false;m.renderOrder=12;m.visible=false;grp.add(m)}
  // glow at the mouth
  const cv=document.createElement('canvas');cv.width=cv.height=64;const cx=cv.getContext('2d'),gr=cx.createRadialGradient(32,32,0,32,32,32);
  gr.addColorStop(0,'rgba(255,240,200,1)');gr.addColorStop(.25,'rgba(255,170,60,.7)');gr.addColorStop(.6,'rgba(255,90,10,.22)');gr.addColorStop(1,'rgba(255,60,0,0)');
  cx.fillStyle=gr;cx.fillRect(0,0,64,64);
  const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:new THREE.CanvasTexture(cv),blending:THREE.AdditiveBlending,transparent:true,depthWrite:false,fog:false,toneMapped:false,opacity:0}));
  glow.name=NAME;glow.frustumCulled=false;glow.renderOrder=13;glow.visible=false;grp.add(glow);
  // sparks
  const NS=12,pos=new Float32Array(NS*3),vel=new Float32Array(NS*3),sg=new THREE.BufferGeometry();
  sg.setAttribute('position',new THREE.BufferAttribute(pos,3));
  const sm=new THREE.PointsMaterial({color:0xffb43c,size:.018,sizeAttenuation:true,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});
  const pts=new THREE.Points(sg,sm);pts.name=NAME;pts.frustumCulled=false;pts.renderOrder=12;grp.add(pts);
  bikeRoot.add(grp);
  const inv=grp.quaternion.clone().invert();
  return{grp,outer,inner,glow,pts,sm,pos,vel,N:NS,t:1e9,D:.1,TL:.17,I:0,
    g:new THREE.Vector3(0,-9.8,0).applyQuaternion(inv),                    // gravity in flame-local axes
    rear:new THREE.Vector3(0,0,1).applyQuaternion(inv)};                    // "behind the bike" in flame-local axes (sparks fall behind when riding fast)
}
function bikeFlameOff(B){
  const F=B&&B.flame;if(!F)return;
  F.t=1e9;F.grp.visible=false;F.outer.visible=F.inner.visible=F.glow.visible=false;
}
function bikeFlameTrigger(B,I){                    // I = 0..1 strength of the pop
  const F=B&&B.flame;if(!F)return;
  F.t=0;F.I=I;F.D=.07+.09*I;F.TL=F.D*1.7;
  for(let k=0;k<F.N;k++){
    const a=Math.random()*6.2832,sp=(.8+Math.random()*2.2)*(.5+I),cone=.2+Math.random()*.5,i=k*3;
    F.vel[i]=Math.cos(a)*cone*sp;F.vel[i+1]=sp;F.vel[i+2]=Math.sin(a)*cone*sp;F.pos[i]=F.pos[i+1]=F.pos[i+2]=0;
  }
  F.pts.geometry.attributes.position.needsUpdate=true;
  F.grp.visible=true;
}
function bikeFlameUpdate(B,dt){
  const F=B.flame;if(!F||F.t>=F.TL)return;
  F.t+=dt;
  if(F.t>=F.TL){bikeFlameOff(B);return}
  const x=F.t/F.D,I=F.I,rnd=Math.random;
  const env=x<1?(x<.18?x/.18:Math.pow(1-(x-.18)/.82,1.4)):0;                 // fast flare, then a quick fade
  const len=(.14+.40*I)*env*(.75+.5*rnd()),rad=(.030+.030*I)*(.55+.45*env)*(.85+.3*rnd());
  const vis=env>.02;
  F.outer.visible=F.inner.visible=F.glow.visible=vis;
  if(vis){
    F.outer.scale.set(rad,Math.max(.001,len),rad);F.inner.scale.set(rad*.55,Math.max(.001,len*.62),rad*.55);
    F.outer.rotation.set((rnd()-.5)*.28,0,(rnd()-.5)*.28);F.inner.rotation.copy(F.outer.rotation);      // flicker / wobble
    F.outer.material.opacity=Math.min(1,env*1.15);F.inner.material.opacity=Math.min(1,env*1.3);
    F.glow.position.set(0,.03+len*.18,0);F.glow.scale.setScalar((.16+.34*I)*(.4+.6*env)*(.85+.3*rnd()));F.glow.material.opacity=env*.9;
  }
  // sparks: fly out, slow down, fall, and drift behind the bike when riding fast
  const sp=Math.hypot(st.wx,st.wz),d=Math.exp(-2.5*dt),p=F.pos,v=F.vel;
  for(let k=0;k<F.N;k++){
    const i=k*3;
    v[i]+=(F.g.x+F.rear.x*sp*1.5)*dt;v[i+1]+=(F.g.y+F.rear.y*sp*1.5)*dt;v[i+2]+=(F.g.z+F.rear.z*sp*1.5)*dt;
    v[i]*=d;v[i+1]*=d;v[i+2]*=d;p[i]+=v[i]*dt;p[i+1]+=v[i+1]*dt;p[i+2]+=v[i+2]*dt;
  }
  F.pts.geometry.attributes.position.needsUpdate=true;
  F.sm.opacity=Math.max(0,1-F.t/F.TL);
}

// Loudness calibration: the cars' engine is game.js's saw oscillator (gain = engineVolume*(.03+.05*throttle)). The bike engine was measured offline against it
// (flat RMS + A-weighted level, offline simulation of this exact chain) and needs this much trim (dB) at rpm01 = 0 / .25 / .5 / .75 / 1  (rpm01 = (rpm-1000)/10300).
// BIKE_LEVEL is a global multiplier on top (1 = same level as the cars; .8 = a bit quieter, 1.25 = a bit louder).
const BIKE_TRIM_DB=[-4.5,-10.4,-12.8,-16.0,-17.9],BIKE_LEVEL=1;
function bikeTrimGain(r01){
  const x=Math.max(0,Math.min(.9999,r01))*4,i=Math.floor(x),f=x-i;
  return BIKE_LEVEL*Math.pow(10,(BIKE_TRIM_DB[i]+(BIKE_TRIM_DB[i+1]-BIKE_TRIM_DB[i])*f)/20);
}
const BikeSnd={S:null,last:0,err:0};
function bikeSndBuild(ctx){
  const sr=ctx.sampleRate;let seed=20250917;
  const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
  const S={ctx,layers:[],rpm:1300,L:0,gear:-1,cutUntil:0,tHigh:-1e9,rHigh:0,popT:0,gnOff:false};
  const comp=ctx.createDynamicsCompressor();comp.threshold.value=-14;comp.knee.value=12;comp.ratio.value=4;comp.attack.value=.004;comp.release.value=.12;
  const master=ctx.createGain();master.gain.value=0;master.connect(ctx.destination);
  const trim=ctx.createGain();trim.gain.value=.3;comp.connect(trim);trim.connect(master);      // trim = loudness calibration (see BIKE_TRIM_DB)
  // engine chain: layers -> bus -> saturation -> throttle-dependent lowpass -> exhaust "bark" -> intake "rasp" -> loudness -> ignition cut -> compressor
  const bus=ctx.createGain();bus.gain.value=.55;
  const shaper=ctx.createWaveShaper(),curve=new Float32Array(2048);
  for(let i=0;i<2048;i++){const x=i/1023.5-1;curve[i]=Math.tanh(x*2.4)/Math.tanh(2.4)}
  shaper.curve=curve;try{shaper.oversample='2x'}catch(e){}
  const lp=ctx.createBiquadFilter();lp.type='lowpass';lp.frequency.value=1200;lp.Q.value=.8;
  const bark=ctx.createBiquadFilter();bark.type='peaking';bark.frequency.value=1150;bark.Q.value=1.1;bark.gain.value=4;
  const rasp=ctx.createBiquadFilter();rasp.type='peaking';rasp.frequency.value=2900;rasp.Q.value=.9;rasp.gain.value=0;
  const eng=ctx.createGain();eng.gain.value=0;const cut=ctx.createGain();cut.gain.value=1;
  bus.connect(shaper);shaper.connect(lp);lp.connect(bark);bark.connect(rasp);rasp.connect(eng);eng.connect(cut);cut.connect(comp);
  for(const L of BikeSndMath.LAYERS){
    const data=BikeSndMath.genLayer(sr,L,4,rnd),buf=ctx.createBuffer(1,data.length,sr);
    if(buf.copyToChannel)buf.copyToChannel(data,0);else buf.getChannelData(0).set(data);
    const g=ctx.createGain();g.gain.value=0;g.connect(bus);
    const srcs=[0,1].map(()=>{const o=ctx.createBufferSource();o.buffer=buf;o.loop=true;o.connect(g);o.start(0,rnd()*buf.duration);return o});
    S.layers.push({g,srcs,base:L.rpm});
  }
  // intake roar + wind (white noise through filters)
  const nb=ctx.createBuffer(1,sr*2,sr),nd=nb.getChannelData(0);for(let i=0;i<nd.length;i++)nd[i]=rnd()*2-1;
  const mkNoise=()=>{const o=ctx.createBufferSource();o.buffer=nb;o.loop=true;o.start(0,rnd()*2);return o};
  const inBP=ctx.createBiquadFilter();inBP.type='bandpass';inBP.frequency.value=700;inBP.Q.value=.8;
  const inG=ctx.createGain();inG.gain.value=0;mkNoise().connect(inBP);inBP.connect(inG);inG.connect(comp);
  const wLP=ctx.createBiquadFilter();wLP.type='lowpass';wLP.frequency.value=600;wLP.Q.value=.5;
  const wG=ctx.createGain();wG.gain.value=0;mkNoise().connect(wLP);wLP.connect(wG);wG.connect(comp);
  const pd=BikeSndMath.genPop(sr,rnd),popBuf=ctx.createBuffer(1,pd.length,sr);
  if(popBuf.copyToChannel)popBuf.copyToChannel(pd,0);else popBuf.getChannelData(0).set(pd);
  Object.assign(S,{comp,trim,master,lp,bark,rasp,eng,cut,inBP,inG,wLP,wG,popBuf});
  return S;
}
function bikePop(S,vol,rate){
  bikeFlameTrigger(BIKE,BikePhys.clamp((vol-.1)/.4,.2,1));          // fire out of the exhaust together with the bang
  const ctx=S.ctx,o=ctx.createBufferSource(),g=ctx.createGain();
  o.buffer=S.popBuf;o.playbackRate.value=rate;g.gain.value=vol*.5;o.connect(g);g.connect(S.master);   // straight to master: not affected by the engine trim
  o.onended=()=>{try{g.disconnect()}catch(e){}};o.start();
}
function bikeAudioFrame(B,dt){
  if(typeof ac==='undefined'||!ac)return;                       // audio starts with the first key press (startAudio in game.js)
  let S=BikeSnd.S;
  if(S===null){try{S=BikeSnd.S=bikeSndBuild(ac)}catch(e){BikeSnd.S=false;console.warn('bike sound failed',e);return}}
  if(!S)return;
  const ctx=S.ctx,now=ctx.currentTime,s=B.s,pn=performance.now(),clamp=BikePhys.clamp,sm=BikePhys.sstep;
  BikeSnd.last=pn;
  if(ctx.state==='suspended')ctx.resume().catch(()=>{});
  if(!S.gnOff&&typeof gn!=='undefined'&&gn){try{gn.disconnect()}catch(e){}S.gnOff=true}   // mute the car's simple synth engine
  const lost=!!B.lost,thr=lost?0:s.thr,sp=Math.hypot(st.wx,st.wz);
  // engine speed: revs up fast, falls with flywheel inertia
  const rpmT=lost?0:Math.max(900,s.rpmE);
  S.rpm+=(rpmT-S.rpm)*(1-Math.exp(-dt/(rpmT>S.rpm?.045:.12)));
  S.L+=(thr-S.L)*(1-Math.exp(-dt/.06));
  const rpm=Math.max(60,S.rpm*(1+(1-S.L)*(.005*Math.sin(pn*.0107)+.0035*Math.sin(pn*.0193))));   // tiny idle "lope"
  const r01=clamp((rpm-1000)/10300,0,1),L=S.L,ck=typeof cockpitOn!=='undefined'&&cockpitOn;
  // layer cross-fade (equal power)
  const w1=sm(2200,3600,rpm),w2=sm(6000,8000,rpm),gs=[Math.sqrt(1-w1),Math.sqrt(w1*(1-w2)),Math.sqrt(w2)];
  for(let i=0;i<3;i++){
    const ly=S.layers[i],rate=Math.max(.03,rpm/ly.base);
    ly.srcs[0].playbackRate.setTargetAtTime(rate,now,.02);
    ly.srcs[1].playbackRate.setTargetAtTime(rate*1.0035,now,.02);
    ly.g.gain.setTargetAtTime(gs[i]*.62,now,.03);
  }
  S.trim.gain.setTargetAtTime(bikeTrimGain(r01),now,.05);
  S.eng.gain.setTargetAtTime((.28+.72*Math.pow(r01,.7))*(.42+.58*L)*1.35,now,.03);
  S.lp.frequency.setTargetAtTime((1000+1500*L+2400*r01+1400*L*r01)*(ck?.85:1),now,.04);
  S.rasp.gain.setTargetAtTime(7*L*(.4+.6*r01),now,.05);
  S.inBP.frequency.setTargetAtTime(500+2200*r01,now,.05);
  S.inG.gain.setTargetAtTime(lost?0:((.012+.13*r01)*L+.008)*(ck?1.6:1),now,.04);
  S.wLP.frequency.setTargetAtTime(500+sp*18,now,.1);
  S.wG.gain.setTargetAtTime(Math.min(.25,Math.pow(sp/55,2)*.22)*(ck?1:.7),now,.1);
  // ignition cut: rev limiter (rapid on/off) or quick-shifter on a gear change
  if(s.gear!==S.gear){
    if(S.gear>=0){S.cutUntil=pn+70;if(s.gear>S.gear&&L>.3&&rpm>4500&&Math.random()<.6)bikePop(S,.3,1.1)}
    S.gear=s.gear;
  }
  const lim=L>.6&&rpm>10800&&!lost,cutOn=lim?(Math.floor(pn/45)&1):(pn<S.cutUntil);
  S.cut.gain.setTargetAtTime(cutOn?.12:1,now,.005);
  // exhaust pops / burble when the throttle is shut after high revs
  if(thr>.55){S.tHigh=pn;S.rHigh=rpm}
  const since=(pn-S.tHigh)/1000;
  if(thr<.12&&S.rHigh>4500&&since<1.5&&sp>3&&!lost){
    S.popT-=dt;
    if(S.popT<=0){S.popT=.05+Math.random()*.16;if(Math.random()<.75*(1-since/1.5)*Math.min(1,S.rHigh/8000))bikePop(S,.18+Math.random()*.28,.75+Math.random()*.6)}
  }
  // master volume follows the game's engine-volume slider / mute; the engine dies when the bike falls over
  const vol=(typeof muted!=='undefined'&&muted)?0:(typeof engineVolume!=='undefined'?engineVolume:.75);
  S.master.gain.setTargetAtTime(lost?0:vol,now,lost?.25:.05);
}
// watchdog: silence the bike while the game is paused / in a menu, and give the car synth back when a car is selected
setInterval(()=>{
  try{if(typeof mirC!=='undefined'&&!(mirC>=0))mirC=0}catch(e){}                            // bike has no interior mirrors: 1%0 made the cockpit-mirror index NaN -> car mirrors died after switching
  if(BIKE&&BIKE.flame&&performance.now()-BikeSnd.last>300)bikeFlameOff(BIKE);       // paused / menu: no frozen flame on screen
  const S=BikeSnd.S;if(!S)return;
  if(!(BIKE&&performance.now()-BikeSnd.last<300)){try{S.master.gain.setTargetAtTime(0,S.ctx.currentTime,.05)}catch(e){}}
  if(!BIKE&&S.gnOff){try{if(typeof gn!=='undefined'&&gn)gn.connect(S.ctx.destination)}catch(e){}S.gnOff=false}
},150);

// ----- bike horn: higher, thinner and buzzier than the car horn (single ~500 Hz diaphragm tone with a 90 Hz rattle) -----
function bikeHornStart(){
  if(typeof ac==='undefined'||!ac||muted||engineVolume<=0||HORN.au)return;
  try{
    if(ac.state==='suspended')ac.resume().catch(()=>{});
    const t=ac.currentTime,master=ac.createGain(),hp=ac.createBiquadFilter(),pk=ac.createBiquadFilter(),lp=ac.createBiquadFilter(),am=ac.createGain(),oscs=[];
    hp.type='highpass';hp.frequency.value=330;hp.Q.value=.7;
    pk.type='peaking';pk.frequency.value=1900;pk.Q.value=1.1;pk.gain.value=6;
    lp.type='lowpass';lp.frequency.value=5200;
    am.gain.value=.7;
    const lfo=ac.createOscillator(),lg=ac.createGain();lfo.type='triangle';lfo.frequency.value=90;lg.gain.value=.3;lfo.connect(lg);lg.connect(am.gain);lfo.start(t);oscs.push(lfo);
    for(const [f,type,a] of [[500,'square',.5],[750,'sawtooth',.22],[1010,'sawtooth',.1],[1500,'square',.07]]){
      const o=ac.createOscillator(),g=ac.createGain();o.type=type;g.gain.value=a;
      o.frequency.setValueAtTime(f*.93,t);o.frequency.linearRampToValueAtTime(f,t+.04);   // diaphragm "starts up"
      o.connect(g);g.connect(am);o.start(t);oscs.push(o);
    }
    am.connect(hp);hp.connect(pk);pk.connect(lp);lp.connect(master);master.connect(ac.destination);
    const vol=.26*Math.min(1,engineVolume*1.3);
    master.gain.setValueAtTime(0,t);master.gain.linearRampToValueAtTime(vol,t+.01);
    HORN.au={master,oscs,vol,t0:t};                       // same shape as the car horn -> game.js hornAudioStop works unchanged
  }catch(e){HORN.au=null}
}
function bikeHornPatch(){                                // route the horn to the bike version while a bike is selected (installed once)
  if(bikeHornPatch.done||typeof hornAudioStart!=='function')return;
  bikeHornPatch.done=true;
  const carStart=hornAudioStart;
  hornAudioStart=function(){return BIKE?bikeHornStart():carStart.apply(this,arguments)};
}

// ----- game glue -----
// Reverse: hold the brake (S / down) while (almost) stopped for `delay` s -> the bike rolls backwards, never faster than `maxKmh`.
const BIKE_REVERSE={maxKmh:5,accel:1.2,delay:.35};
function stepBike(dt){
  const B=BIKE,s=B.s,D=BikePhys.D;
  bikeHornPatch();
  const keyGas=!!(keys.w||keys.arrowup),keyBrake=!!(keys.s||keys.arrowdown);
  const gasAmount=Math.max(keyGas?1:0,Number(pad.throttle)||(pad.gas?1:0));
  const brakeAmount=Math.max(keyBrake?1:0,Number(pad.brakeAmount)||(pad.brake?1:0));
  const wlKey=(keys[' ']||pad.hb)?1:0,rear=0;     // SPACE = wheelie (no longer the rear brake)
  const keySteer=(keys.a||keys.arrowleft?1:0)-(keys.d||keys.arrowright?1:0);
  const digitalPadSteer=(pad.left?1:0)-(pad.right?1:0);
  const tg=B.lost?0:Math.max(-1,Math.min(1,keySteer+digitalPadSteer+(Number(pad.steer)||0)));
  const thrT=(B.lost||brakeAmount>.06)?0:(gasAmount>.06?gasAmount:0);
  s.thr+=(thrT-s.thr)*Math.min(1,dt*(thrT>s.thr?9:16));
  s.brk+=(brakeAmount-s.brk)*Math.min(1,dt*12);
  s.rb+=(rear-s.rb)*Math.min(1,dt*14);
  st.steer+=(tg-st.steer)*Math.min(1,dt*(Math.abs(tg)>.01?16:18));
  s.steerIn=st.steer;
  s.mu=D.mu*(weatherMode==='winter'?.8:1);
  let fx=-Math.sin(st.h),fz=-Math.cos(st.h);
  const u0=Math.max(0,st.wx*fx+st.wz*fz);
  BikePhys.shift(s,u0,s.thr,dt);
  wheelieUpdate(B,dt,wlKey,u0);
  // reverse: brake held while (almost) stopped; releasing the brake or pressing the throttle ends it
  {const wantRev=brakeAmount>.5&&gasAmount<.06;
   if(!wantRev){B.revT=0;B.rev=false}
   else if(u0<.3){B.revT=(B.revT||0)+dt;if(B.revT>BIKE_REVERSE.delay)B.rev=true}}
  const REV_MAX=BIKE_REVERSE.maxKmh/3.6;
  const n=Math.max(1,Math.ceil(dt/.008)),h=dt/n;
  for(let i=0;i<n;i++){
    fx=-Math.sin(st.h);fz=-Math.cos(st.h);
    let rx=Math.cos(st.h),rz=-Math.sin(st.h);
    let u=st.wx*fx+st.wz*fz,v=st.wx*rx+st.wz*rz;
    let yaw=BikePhys.lateral(s,u,h);
    if(u<0){yaw=s.kappa*u;s.yaw=yaw}                                  // rolling backwards: the bars steer kinematically (yaw = curvature x signed speed)
    st.h+=yaw*h;st.h+=st.cw*h;st.cw*=Math.exp(-CRASH.cwDecay*h);
    fx=-Math.sin(st.h);fz=-Math.cos(st.h);rx=Math.cos(st.h);rz=-Math.sin(st.h);
    // the velocity turns WITH the bike (no speed lost by cornering); only throttle / brakes / drag change the speed
    if(B.rev){                                                         // reverse gear: ramp to -maxKmh, nothing faster
      const a=Math.max(-BIKE_REVERSE.accel,Math.min(BIKE_REVERSE.accel,(-REV_MAX-u)/h));
      u=Math.max(-REV_MAX,u+a*h);s.ax+=(a*.4-s.ax)*Math.min(1,h*14);
    }else u=BikePhys.longitudinal(s,u,h);
    v*=Math.exp(-14*h);
    st.wx=u*fx+v*rx;st.wz=u*fz+v*rz;
    st.x+=st.wx*h;st.z+=st.wz*h;
  }
  if(B.lost){const k=Math.exp(-2.2*dt);st.wx*=k;st.wz*=k}
  yawR=s.yaw;
  fx=-Math.sin(st.h);fz=-Math.cos(st.h);
  const vf=st.wx*fx+st.wz*fz;
  // stop / parking
  {const vv=Math.hypot(st.wx,st.wz);if(!B.rev&&s.thr<.02&&vv<.25&&(s.brk>.05||s.rb>.05||vv<.1)){st.wx=st.wz=0;yawR=0;s.yaw=0}}
  accel=s.ax;axF=s.ax;ayF=-s.ay;
  engRPM=Math.max(900,s.rpmE*.64);gi=s.gear;
  resolveCurbs(dt);
  BikePhys.suspension(s,dt);
  B.spinF-=vf*dt/D.Rf;B.spinR-=vf*dt/D.R;
  st.roll=st.pitch=0;
  tailM.opacity=(s.rb>.2||(s.brk>.15&&vf>.2))?1:(isNight?.6:.45);
  return vf;
}
function bikeVisual(dt){
  const B=BIKE;if(!B)return;
  B.apply(dt);
  for(const o of B.hideCockpit)o.visible=!cockpitOn;
  {const L=B.rider.limb,own=!(B.hands&&cockpitOn);for(const k of ['uaL','uaR','faL','faR','elL','elR','gvL','gvR'])L[k].visible=own;if(B.hands&&cockpitOn)B.hands.update()}
  // cockpit view: the big halo sprites would flood the rider's view
  for(const k in LAMPS){const L=LAMPS[k];if(!L)continue;if(L.halo)L.halo.visible=headOn&&L.ok&&!cockpitOn}
  // lamps follow the steering head: spots + halos
  const gear=Math.max(0,Math.min(6,B.s.gear+1));
  const gs=Math.abs(st.wx)+Math.abs(st.wz)<.4?0:gear;
  if(gs!==B.lastGear){B.lastGear=gs;B.gears.forEach((o,i)=>{if(o)o.visible=i===gs})}
  const em=(headOn?'h':'-')+(isNight?'n':'d')+((B.s.brk>.15||B.s.rb>.2)?'b':'-');
  if(em!==B.lastEm){B.lastEm=em;
    for(const m of B.M.head)m.emissiveIntensity=headOn?1.6:.12;
    for(const m of B.M.tail)m.emissiveIntensity=em[2]==='b'?1.6:(isNight?.45:.18);
    for(const m of B.M.dash)m.emissiveIntensity=isNight?1:.35;
  }
  // headlight spots + halos sit on the lamp (it leans and steers with the bike)
  if(headLights.length){
    const lamp=B.steer;
    for(let i=0;i<2;i++){
      _bv.copy(B.lampL[i]);lamp.localToWorld(_bv);car.worldToLocal(_bv);
      if(headLights[i])headLights[i].position.copy(_bv);
      const K=i?LAMPS.fr:LAMPS.fl;if(K&&K.halo)K.halo.position.copy(_bv);
    }
  }
  if(B.flame)bikeFlameUpdate(B,dt);
  try{bikeAudioFrame(B,dt)}catch(e){if(!BikeSnd.err){BikeSnd.err=1;console.warn('bike sound error',e)}}
}
