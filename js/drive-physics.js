// ===================== GTA-style vehicle dynamics (الكورنيش اللانهائي) =====================
// Replaces the arcade "steering commands the yaw rate" model with a real two-axle tyre model:
//  * every tyre makes force from its slip angle (Pacejka-like curve: grip builds, peaks, then drops to sliding friction)
//  * friction circle per axle: throttle / brakes eat lateral grip -> power oversteer, wheelspin, trail-braking rotation
//  * dynamic weight transfer front <-> rear (brake -> nose dives & the tail gets light, throttle -> squat)
//  * true yaw inertia (the car has weight, it takes time to rotate and to stop rotating)
//  * handbrake locks the rear wheels: they slide like a block -> handbrake turns / drifts
//  * GTA-like forgiving aids: speed-sensitive steering lock, light automatic counter-steer, anti-spin yaw damping
//  * spring/damper body roll, pitch and heave (the body rocks, dives and settles like GTA V cars)
// The core (DriveCore) is pure maths with no THREE / DOM, so it can be tested on its own (node tools/test-drive.js).
(function(root){
'use strict';
const g=9.81;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const sstep=(a,b,x)=>{x=clamp((x-a)/(b-a),0,1);return x*x*(3-2*x)};
const toward=(v,t,d)=>v<t?Math.min(t,v+d):Math.max(t,v-d);

// ---- handling data (like GTA's handling.meta): one base car + per-car overrides ----
const BASE={
  // chassis
  m:1480,a:1.20,b:1.40,hcg:.52,Ik:1.0,R:.33,
  // engine + automatic gearbox (same Lancer power train for every car, as before)
  ratios:[3.6,2.2,1.5,1.12,.9,.74],rev:4.5,fd:3.9,eff:.86,idle:900,redline:7100,limiter:7300,
  TQ:[[0,0],[800,120],[1500,200],[2500,310],[3500,366],[4500,352],[5500,335],[6500,300],[7000,250],[7500,100],[8000,0]],
  engBrake:18,engBrakeK:.02,
  // aero + rolling
  CdA:.74,ClA:.32,Crr:.014,
  // tyres: mu = peak grip, B/C = curve shape (peak slip ~9.5 deg, sliding ~83% of peak), vFloor = low-speed slip regulariser (m/s)
  mu:1.14,B:13,C:1.38,slideMu:.84,vFloor:2.6,lts:.1,wet:.86,
  // rear tyres: stiffer and with almost no grip drop past the peak -> the tail only lets go with the handbrake or too much throttle (GTA feel)
  Br:24,Cr:1.15,muR:1.14,spinMu:.93,wtK:.7,                       // wtK: how much of the weight transfer reaches the tyres (the body still pitches fully)
  // drivetrain + brakes (frontBias = share of drive torque on the front axle)
  frontBias:.45,brakeG:1.15,brakeBias:.64,hbG:.92,
  // steering: full lock (rad), build-up rate at standstill / at speed (input units per s), return rate, grip margin of the speed-sensitive lock
  steerLock:.62,steerRate:6.5,steerRateHi:4.5,steerReturn:12,latMargin:1.0,
  // body motion: rad of roll / pitch per g, spring frequency (Hz), damping ratio
  rollK:.065,pitchK:.055,susHz:1.45,susZeta:.34,rollZeta:.55,heaveK:.022,
  // driver aids: anti-spin yaw damping and automatic counter-steer (0 = none)
  // driver aids: anti-spin, yaw tracking (pulls the rotation toward the path the front wheels ask for), auto counter-steer
  // latK: damps sideways sliding of the body beyond ~1 deg (quick lane changes stay clean)
  assist:1,trackK:8,trackE0:.003,trackE1:.05,latK:2.2,csAssist:.55,abs:.97,ebd:.82,
  // high-speed agility (GTA-style aero grip): from hiV0 to hiV1 (m/s) the tyres gain up to hiGrip extra grip, the car's yaw inertia
  // drops by hiInertia and the steering builds hiSteer faster -> sharp, light direction changes at speed without sliding
  hiGrip:.42,hiInertia:.2,hiSteer:.3,hiV0:16.7,hiV1:33.3
};
const CARS={
  lancer:{},                                                        // AWD, balanced: the reference car
  kia:{m:1640,a:1.25,b:1.40,hcg:.66,frontBias:.62,mu:1.06,rollK:.08,pitchK:.065,susHz:1.3,susZeta:.32,Ik:1.05}, // tall FWD-biased SUV: more roll, mild understeer
  lada:{m:1180,a:1.22,b:1.20,hcg:.55,frontBias:0,mu:1.06,rollK:.085,pitchK:.07,susHz:1.2,susZeta:.27,steerLock:.58,assist:.9,csAssist:.5} // light RWD classic: soft body, the tail only steps out with a lot of throttle
};
function handling(id){
  const H=Object.assign({},BASE,CARS[id]||{});
  H.L=H.a+H.b;H.Iz=H.Ik*H.m*H.a*H.b;
  H.alphaP=Math.tan(Math.PI/(2*H.C))/H.B;                          // slip angle of peak grip (rad)
  return H;
}
function tq(H,r){const T=H.TQ;if(r<=0)return 0;for(let i=1;i<T.length;i++)if(r<=T[i][0]){const a=T[i-1],b=T[i];return a[1]+(b[1]-a[1])*(r-a[0])/(b[0]-a[0])}return 0}
const tyre=(H,al)=>Math.sin(H.C*Math.atan(H.B*al));                // normalised lateral grip vs slip angle (peak = 1)
const tyreR=(H,al)=>Math.sin(H.Cr*Math.atan(H.Br*al));
const mixMu=(H,Fx,Fy)=>{const k=Math.abs(Fx)/(Math.hypot(Fx,Fy)||1);return H.slideMu+(H.spinMu-H.slideMu)*k};

function makeState(){
  return{x:0,z:0,h:0,wx:0,wz:0,r:0,axS:0,ayS:0,thr:0,brk:0,hbp:0,steer:0,delta:0,gear:0,shiftT:0,rpm:900,rev:false,coast:0,burn:false,
    spinF:0,spinR:0,roll:0,rollV:0,pitch:0,pitchV:0,heave:0,heaveV:0,dist:0,beta:0,slideF:0,slideR:0,lockR:0,u:0,wet:false,thrT:0};
}

// One frame of driving. S = state (world: x,z position, h heading (h>0 = turned left), wx,wz velocity, r yaw rate),
// H = handling, I = input {gas 0..1, brake 0..1, steer -1..1 (+ = left), hb bool, analog bool}. Returns the forward speed (m/s).
function step(S,H,I,dt){
  if(!(dt>0))return S.u;
  let sh=Math.sin(S.h),chh=Math.cos(S.h);
  const u0=-S.wx*sh-S.wz*chh,vy0=-S.wx*chh+S.wz*sh,sp0=Math.abs(u0),V0=Math.hypot(S.wx,S.wz);
  const hiF=sstep(H.hiV0,H.hiV1,V0);S.hiF=hiF;
  const m=H.m,L=H.L,Iz=H.Iz*(1-H.hiInertia*hiF),kd=.6*H.CdA/m,mu0=H.mu*(S.wet?H.wet:1)*(1+H.hiGrip*hiF*(1-.85*S.hbp)); // the speed grip fades out under the handbrake (no extra spin)
  // ---- driver intent: W = go / brake when rolling backwards, S = brake / reverse, W+S at a standstill = burnout ----
  const gasA=clamp(I.gas||0,0,1),brA=clamp(I.brake||0,0,1),gas=gasA>.06,brk=brA>.06;
  let thrT=0,brkT=0,rev=false,burn=false;
  if(gas&&brk){if(sp0<4&&u0>-1){thrT=gasA;brkT=brA;burn=true}else brkT=brA}
  else if(gas){if(u0<-1.5)brkT=gasA;else thrT=gasA}
  else if(brk){if(u0>.4)brkT=brA;else{thrT=brA;rev=true}}
  S.thrT=thrT;S.burn=burn;
  S.thr+=(thrT-S.thr)*Math.min(1,dt*(thrT?7:10));
  S.brk+=(brkT-S.brk)*Math.min(1,dt*12);
  S.hbp+=((I.hb?1:0)-S.hbp)*Math.min(1,dt*(I.hb?14:8));
  if(gas&&!brk)S.coast=0;else if(!gas&&!brk)S.coast+=dt;else S.coast=0;
  const coastRetard=(!gas&&!brk)?1.8*clamp((S.coast-3)/1.25,0,1):0; // the game's gentle extra slow-down after 3 s off the pedals
  // ---- steering: rate-limited keyboard steering, slower to build at speed, quick to centre ----
  const beta0=Math.atan2(vy0,Math.max(Math.abs(u0),1));
  const tg=clamp(I.steer||0,-1,1);
  if(I.analog)S.steer+=(tg-S.steer)*Math.min(1,dt*16);
  else{
    const build=Math.abs(tg)>.01&&tg*S.steer>=0&&Math.abs(tg)>=Math.abs(S.steer);
    const rate=build?H.steerRateHi*(1+H.hiSteer*hiF)+(H.steerRate-H.steerRateHi)/(1+(V0/16)*(V0/16)):H.steerReturn;
    S.steer=toward(S.steer,tg,rate*dt);
  }
  // speed-sensitive lock: full lock = the front tyres at their peak grip (more lock is allowed for counter-steering a slide)
  let dMax=Math.min(H.steerLock,Math.atan(L*mu0*g*H.latMargin/Math.max(V0*V0,.01))+H.alphaP*.95);
  // extra lock for counter-steering, but only while the car is still rotating INTO the slide (no pendulum on keyboard flicks)
  const into=-S.r*Math.sign(beta0);
  if(S.steer*beta0>0)dMax=Math.min(H.steerLock,dMax+Math.min(.6,Math.abs(beta0))*sstep(-.05,.35,into));
  let delta=S.steer*dMax;
  if(u0>3)delta+=H.csAssist*beta0*(1-.55*Math.abs(S.steer))*sstep(3,9,u0); // front wheels follow the travel direction a little
  delta=clamp(delta,-H.steerLock,H.steerLock);S.delta=delta;
  // ---- automatic gearbox (same shift logic as before) ----
  const spinD=Math.max(H.frontBias>.01?S.spinF:0,H.frontBias<.99?S.spinR:0);
  const wr=k=>sp0/H.R*H.ratios[k]*H.fd*9.5493;
  if(S.shiftT>0)S.shiftT-=dt;
  else if(!rev&&!burn){
    const th=S.thr,k=S.gear;
    if(k<H.ratios.length-1&&wr(k)>3200+3500*th&&wr(k+1)>1900){S.gear++;S.shiftT=.2}
    else if(k>0&&((wr(k)<1700+1100*th)||(th>.85&&wr(k)<3600&&wr(k-1)<5800))&&wr(k-1)<6800){S.gear--;S.shiftT=.15}
  }
  if((rev||burn)&&S.gear!==0&&sp0<2)S.gear=0;
  S.rev=rev;
  const ratio=rev?H.rev:H.ratios[S.gear];
  // torque, rev limiter and shifts follow road speed; wheelspin only shows on the rev counter / in the engine sound
  const rpmW=sp0/H.R*ratio*H.fd*9.5493;
  const rpmE=Math.max(rpmW,H.idle+S.thr*(1300+1000*(rpmW<2500?1:0)));
  const rpmShow=Math.max(rpmE,(sp0+spinD)/H.R*ratio*H.fd*9.5493);
  let Te=0;
  if(S.shiftT<=0){
    Te=S.thr*tq(H,rpmE)-(1-S.thr)*(rpmW>1300?H.engBrake+H.engBrakeK*rpmE:0);
    if((rpmW>H.redline||(rev&&sp0>10))&&Te>0)Te=0;                  // rev limiter / reverse speed cap
  }
  const Fdrv=Te*ratio*H.fd*H.eff/H.R*(rev?-1:1);
  S.rpm+=(Math.min(rpmShow,H.limiter)-S.rpm)*Math.min(1,dt*14);
  const Fb=S.brk*H.brakeG*m*g;
  const fBias=burn?0:H.frontBias,bBias=burn?1:H.brakeBias;          // burnout: front brakes hold the car, all torque to the rear
  // ---- integrate the chassis in sub-steps (stiff tyres need ~300 Hz) ----
  const n=Math.max(1,Math.ceil(dt*300)),h=dt/n,cd=Math.cos(delta),sd=Math.sin(delta),tanP=Math.tan(H.alphaP*.75);
  let slF=0,slR=0,lkR=0,lrF=0,lrR=0;
  for(let k=0;k<n;k++){
    sh=Math.sin(S.h);chh=Math.cos(S.h);
    const fx=-sh,fz=-chh,lx=-chh,lz=sh;                               // forward / left unit vectors
    const u=S.wx*fx+S.wz*fz,vy=S.wx*lx+S.wz*lz,r=S.r,V=Math.hypot(u,vy);
    // loads: static split + longitudinal weight transfer + a little downforce
    const down=.6*H.ClA*V*V,dF=m*S.axS*H.hcg/L*H.wtK,mn=.08*m*g;
    const Fzf=Math.max(mn,m*g*H.b/L-dF+down*.45),Fzr=Math.max(mn,m*g*H.a/L+dF+down*.55);
    // lateral load transfer costs grip (tyre load sensitivity); the front loses a bit more -> stable, slight understeer at the limit
    const lt=S.ayS/(mu0*g),lt2=Math.min(1.5,lt*lt);
    const FmF=mu0*(1-H.lts*1.25*lt2)*Fzf,FmR=mu0*H.muR*(1-H.lts*.75*lt2)*Fzr;
    // front axle (tyre frame rotated by the steering angle)
    const vfy=vy+H.a*r,vtx=u*cd+vfy*sd,vty=-u*sd+vfy*cd;
    let FyF=-FmF*tyre(H,Math.atan2(vty,Math.max(Math.abs(vtx),H.vFloor)));
    const FxFd=Fdrv*fBias;
    // ABS: the brakes only use the grip the cornering force leaves free (never locks the fronts)
    const bF=Math.min(Fb*bBias,Math.sqrt(Math.max(0,FmF*FmF*H.abs*H.abs-FyF*FyF*.7)));
    let FxF=FxFd-bF*Math.tanh(vtx/.35);
    let ov=Math.hypot(FxF,FyF)/FmF;
    if(ov>1){const s=(1-(1-mixMu(H,FxF,FyF))*sstep(1,1.5,ov))/ov;FxF*=s;FyF*=s}  // friction circle (+ drop to sliding grip)
    // rear axle
    const vry=vy-H.b*r;
    let FyR=-FmR*tyreR(H,Math.atan2(vry,Math.max(Math.abs(u),H.vFloor)));
    const FxRd=Fdrv*(1-fBias)*(1-S.hbp);
    // EBD: rear brake force is limited to what the (unloaded) rear tyres can take next to the cornering force -> braking in a bend never spins the car
    const bR=Math.min(Fb*(1-bBias),H.ebd*Math.sqrt(Math.max(0,FmR*FmR-FyR*FyR)));
    let FxR=FxRd-bR*Math.tanh(u/.35);
    ov=Math.hypot(FxR,FyR)/FmR;
    if(ov>1){const s=(1-(1-mixMu(H,FxR,FyR))*sstep(1,1.5,ov))/ov;FxR*=s;FyR*=s}
    if(S.hbp>.005){                                                  // handbrake: locked rear wheels slide against their own velocity
      const vr=Math.hypot(u,vry),kk=FmR*H.slideMu*H.hbG/Math.max(vr,.7);
      FxR+=(-u*kk-FxR)*S.hbp;FyR+=(-vry*kk-FyR)*S.hbp;
    }
    // body forces & yaw moment
    const FxB=FxF*cd-FyF*sd,FyB=FxF*sd+FyF*cd;
    const Fres=-(H.Crr*g+coastRetard)*m*Math.tanh(u/.3);
    const Fx=FxB+FxR+Fres-kd*m*V*u;let Fy=FyB+FyR-kd*m*V*vy;
    if(u>3&&H.latK>0){const ex=Math.sign(vy)*Math.max(0,Math.abs(vy)-.02*u),ak2=(1-.95*S.hbp)*(1-.4*S.thr*(1-fBias))*sstep(3,10,u);Fy+=clamp(-ex*m*H.latK*ak2,-.35*m*g,.35*m*g)}
    let Mz=H.a*FyB-H.b*FyR;
    if(u>4&&H.assist>0){
      // GTA-like stability: damp yaw that grows the slide, and gently pull the yaw rate toward the path the front wheels ask for
      const b=Math.atan2(vy,u),ak=H.assist*(1-.95*S.hbp)*(1-.3*S.thr*(1-fBias));
      if(b*r<0)Mz-=r*Iz*8*ak*sstep(.04,.35,Math.abs(b));
      const rMax=mu0*g*1.15/Math.max(u,1),rT=clamp(u*Math.tan(delta)/L,-rMax,rMax);
      Mz-=(r-rT)*Iz*H.trackK*ak*sstep(4,14,u)*sstep(H.trackE0,H.trackE1,Math.abs(r-rT));
    }
    const ax=Fx/m,ay=Fy/m;
    S.wx+=(ax*fx+ay*lx)*h;S.wz+=(ax*fz+ay*lz)*h;
    S.r+=Mz/Iz*h;S.h+=S.r*h;
    S.x+=S.wx*h;S.z+=S.wz*h;
    const kf=Math.min(1,h*8);S.axS+=(ax-S.axS)*kf;S.ayS+=(ay-S.ayS)*kf;
    // telemetry: sliding speed of each axle beyond ~75% of the peak slip angle, handbrake lock, drive demand vs grip
    slF+=Math.max(0,Math.abs(vty)-Math.abs(vtx)*tanP);slR+=Math.max(0,Math.abs(vry)-Math.abs(u)*tanP);
    lkR+=S.hbp*Math.abs(u);lrF+=Math.abs(FxFd)/FmF;lrR+=Math.abs(FxRd)/FmR;
  }
  slF/=n;slR/=n;lkR/=n;lrF/=n;lrR/=n;
  // parking: come to a complete stop
  {const vv=Math.hypot(S.wx,S.wz);if(!thrT&&vv<.25&&(I.hb||S.brk>.2||vv<.1)){S.wx=S.wz=0;S.r=0}}
  // wheelspin (visual + engine revs + smoke): how far the drive force exceeds what the tyres can take
  const spT=k=>clamp((k-.92)*14,0,18);
  S.spinF+=((thrT>0?spT(lrF):0)-S.spinF)*Math.min(1,dt*(thrT>0?5:9));
  S.spinR+=((thrT>0?spT(lrR):0)-S.spinR)*Math.min(1,dt*(thrT>0?5:9));
  S.slideF=slF+(fBias>.01?S.spinF*.6:0);S.slideR=Math.max(slR,lkR)+(fBias<.99?S.spinR*.6:0);S.lockR=lkR;
  // ---- body: roll / pitch / heave springs (visual suspension) ----
  sh=Math.sin(S.h);chh=Math.cos(S.h);
  const u1=-S.wx*sh-S.wz*chh,vy1=-S.wx*chh+S.wz*sh,V1=Math.hypot(u1,vy1);
  S.beta=Math.atan2(vy1,Math.max(Math.abs(u1),1));
  S.dist+=V1*dt;
  const w=2*Math.PI*H.susHz,z=H.susZeta,ns=Math.max(1,Math.ceil(dt*240)),hs=dt/ns;
  const rT=clamp(-S.ayS/g*H.rollK,-.12,.12),pT=clamp(S.axS/g*H.pitchK,-.09,.09);
  const bump=(Math.sin(S.dist*1.7)*Math.sin(S.dist*.53)*.004+Math.sin(S.dist*4.1)*.0012)*sstep(4,40,V1);
  const hT=-H.heaveK*Math.min(1.4,Math.hypot(S.axS,S.ayS)/g)+bump;
  for(let i=0;i<ns;i++){
    S.rollV+=(-w*w*(S.roll-rT)-2*H.rollZeta*w*S.rollV)*hs;S.roll+=S.rollV*hs;
    S.pitchV+=(-w*w*1.15*(S.pitch-pT)-2*z*w*S.pitchV)*hs;S.pitch+=S.pitchV*hs;
    S.heaveV+=(-w*w*1.4*(S.heave-hT)-2*z*w*S.heaveV)*hs;S.heave+=S.heaveV*hs;
  }
  S.u=u1;
  return u1;
}
const DriveCore={BASE,CARS,handling,makeState,step,tq};
root.DriveCore=DriveCore;
if(typeof module!=='undefined'&&module.exports)module.exports=DriveCore;
})(typeof window!=='undefined'?window:globalThis);
