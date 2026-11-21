let _tlStFrame=-1,_frameId=0; // perf: per-frame cache token for lamp stations
const L=60,REAR_ROAD_BUFFER=1000,N=36;
const ROAD_RING_LENGTH=L*N,FRONT_ROAD_BUFFER=ROAD_RING_LENGTH-REAR_ROAD_BUFFER;
const BRIDGE_SPACING=4000,BRIDGE_CLEAR=380,BR={active:false,z:0,group:null,k:0}; // bridge every 4 km; road kept straight +-380 m around it
const BRIDGE_H=6,BRIDGE_FLAT=150,BRIDGE_RAMP=160; // deck height (m), flat length each side of the centre, ramp length each side
// Road elevation (m) at world z: smooth climb onto the bridge, flat top, smooth descent; 0 everywhere else.
// The first 4 km are ordinary road. At every 4 km mark (4, 8, 12 ... km) EITHER a bridge OR a tunnel appears, chosen at random (a fresh random pattern every time the game loads).
const FEAT_SEED=(Math.random()*4294967296)>>>0;
function featKind(k){let h=(Math.imul(k,2654435761)+FEAT_SEED)>>>0;h^=h>>>15;h=Math.imul(h,2246822519)>>>0;h^=h>>>13;h=Math.imul(h,3266489917)>>>0;h^=h>>>16;return(h&1)?1:0} // 0 = bridge, 1 = tunnel
function bridgeElev(z){const d=-z;if(d<=0)return 0;const kk=Math.max(1,Math.round(d/BRIDGE_SPACING)),c=kk*BRIDGE_SPACING,a=Math.abs(d-c);
  if(featKind(kk)!==0)return 0;if(a>=BRIDGE_FLAT+BRIDGE_RAMP)return 0;if(a<=BRIDGE_FLAT)return BRIDGE_H;const t=1-(a-BRIDGE_FLAT)/BRIDGE_RAMP;return BRIDGE_H*t*t*(3-2*t)}
function bridgeSlope(z){return bridgeElev(z+.5)-bridgeElev(z-.5)} // dElevation/dz
// ---- Lane split: the player's carriageway has 5 lanes (x 1..19.33). Lanes 1-3 (x 1..12) climb onto the bridge; lanes 4-5 (x 12..19.33) stay at ground level beside/under it.
// A solid divider wall (faces BR_WALL_L on the deck side / BR_WALL_R on the ground side) separates them as soon as the deck is BR_WALL_E m high.
const BR_X0=1.0,BR_SPLIT=12.0,BR_WALL_L=11.98,BR_WALL_R=12.42,BR_MID=12.2,BR_WALL_E=.1;
// The 2 lower lanes sink into a trench (BR_DIP x deck height, up to 3 m) and, where the deck is high enough (BR_CAP_E), the deck slab widens over them (to x=BR_RIGHT) so they run UNDER the bridge.
const BR_DIP=.5,BR_CAP_E=3.8,BR_RIGHT=19.6;
// ---- Tunnel (نفق): appears at a random 4 km mark instead of a bridge (see featKind). The whole road (both carriageways + median island) sinks TUN_D m below ground
// over a TUN_RAMP m ramp, runs TUN_FLAT m each side of the centre at full depth inside a closed circular-arch tube, then climbs back out. The road is kept straight around it.
const TUN_SPACING=4000,TUN_OFF=0,TUN_FLAT=600,TUN_RAMP=240,TUN_D=11.5,TUN_CLEAR=TUN_FLAT+TUN_RAMP+60,TUN_TUBE_F=.9,TUN_HW=21.5,TUN_SPRING=4.5,TUN_RISE=5;
const TUN={active:false,z:0,k:-1,group:null,roof:null,inside:0};
function tunnelF(z){const d=-z;if(d<=0)return 0;const k=Math.round((d-TUN_OFF)/TUN_SPACING),a=Math.abs(d-(TUN_OFF+k*TUN_SPACING));
  if(k<1||featKind(k)!==1)return 0;if(a>=TUN_FLAT+TUN_RAMP)return 0;if(a<=TUN_FLAT)return 1;const t=1-(a-TUN_FLAT)/TUN_RAMP;return t*t*(3-2*t)}
function tunE(x,z){return(x>-22&&x<22)?-TUN_D*tunnelF(z):0}
function tunSl(x,z){return(x>-22&&x<22)?-TUN_D*(tunnelF(z+.5)-tunnelF(z-.5)):0}
function bridgeElevAt(x,z){return((x>BR_X0-.05&&x<BR_MID)?bridgeElev(z):(x>=BR_MID&&x<19.5)?-BR_DIP*bridgeElev(z):0)+tunE(x,z)}   // x = lateral road position (the road is straight around every bridge / tunnel)
function bridgeSlopeAt(x,z){return((x>BR_X0-.05&&x<BR_MID)?bridgeSlope(z):(x>=BR_MID&&x<19.5)?-BR_DIP*bridgeSlope(z):0)+tunSl(x,z)}
// true if a lane change between lateral positions a and b, for a car at z driving towards -z, would cross the divider within the next ~160 m
function bridgeWallBetween(a,b,z){if((a<BR_MID)===(b<BR_MID))return false;for(const o of [30,0,-40,-80,-120,-160])if(bridgeElev(z+o)>=BR_WALL_E*.5)return true;return false}
const rnd=(a,b)=>a+Math.random()*(b-a),pick=a=>a[Math.floor(Math.random()*a.length)];
function cv(w,h,f){const c=document.createElement('canvas');c.width=w;c.height=h;f(c.getContext('2d'),w,h);const t=new THREE.CanvasTexture(c);t.anisotropy=ANISO;return t}
const scene=new THREE.Scene();
scene.fog=new THREE.Fog(0xcfe6f6,120,700);let isNight=false;var headPool=null;
let _savedQuality=null;try{_savedQuality=localStorage.getItem('corniche_quality')}catch(e){}
let _GS0={};try{_GS0=JSON.parse(localStorage.getItem('corniche_gfx_adv')||'{}')||{}}catch(e){_GS0={}}
const GS=Object.assign({res:null,adaptive:null,fpsCap:0,mirror:null,clouds:null,rain:null,fov:0,showFps:true,aa:'auto',aniso:null},_GS0);
function saveGS(){try{localStorage.setItem('corniche_gfx_adv',JSON.stringify(GS))}catch(e){}}
// high-performance GPU hint (picks the discrete GPU on laptops), opaque canvas, no stencil buffer; AA is skipped only in the "low" preset
window._ppAtStart=(GS.gPost!=null?!!GS.gPost:_savedQuality!=='low'); // js/gfx-plus.js renders through a multisampled HDR buffer: the canvas itself then needs no MSAA
const renderer=new THREE.WebGLRenderer({antialias:window._ppAtStart?false:(GS.aa==='on'?true:GS.aa==='off'?false:(_savedQuality!=='low'&&(window.devicePixelRatio||1)<1.5)),alpha:false,stencil:false,powerPreference:'high-performance'});
const MAX_PR=Math.min(window.devicePixelRatio||1,1.5);
renderer.setPixelRatio(MAX_PR);
const ANISO=Math.min(GS.aniso?+GS.aniso:(_savedQuality==='low'?2:8),renderer.capabilities.getMaxAnisotropy());
document.body.appendChild(renderer.domElement);
const camera=new THREE.PerspectiveCamera(58,1,.5,2200);
camera.rotation.order='YXZ';
function resize(){renderer.setSize(innerWidth,innerHeight);camera.aspect=innerWidth/innerHeight;camera.fov=innerWidth<innerHeight?74:58;camera.updateProjectionMatrix()}
addEventListener('resize',resize);resize();

const hemi=new THREE.HemisphereLight(0xdfeeff,0x998877,.85);scene.add(hemi);
const sun=new THREE.DirectionalLight(0xfff2dc,.9);sun.position.set(80,120,-40);scene.add(sun);

// sky
// blotchy wrap-around helper for sky textures (draws a soft blob and its horizontal wrap copies so the seam stays invisible)
function skyBlob(g,w,x,y,rx,ry,col0,col1){for(const ox of [-w,0,w]){g.save();g.translate(x+ox,y);g.scale(1,ry/rx);const gr=g.createRadialGradient(0,0,0,0,0,rx);gr.addColorStop(0,col0);gr.addColorStop(1,col1);g.fillStyle=gr;g.beginPath();g.arc(0,0,rx,0,7);g.fill();g.restore()}}
const skyT=cv(1024,512,(g,w,h)=>{const gr=g.createLinearGradient(0,0,0,h);gr.addColorStop(0,'#0e4fae');gr.addColorStop(.18,'#1a6fd0');gr.addColorStop(.34,'#4a98e2');gr.addColorStop(.43,'#9ccbf0');gr.addColorStop(.49,'#d7ebf8');gr.addColorStop(.5,'#cfe6f6');gr.addColorStop(1,'#cfe6f6');g.fillStyle=gr;g.fillRect(0,0,w,h);
// warm sun-side glow + hazy horizon bands
skyBlob(g,w,w*.72,h*.40,w*.22,h*.16,'rgba(255,238,200,.38)','rgba(255,238,200,0)');
for(let i=0;i<70;i++)skyBlob(g,w,rnd(0,w),rnd(h*.36,h*.495),rnd(60,170),rnd(5,16),'rgba(255,255,255,'+rnd(.06,.2)+')','rgba(255,255,255,0)');
// thin high cirrus streaks
for(let i=0;i<34;i++)skyBlob(g,w,rnd(0,w),rnd(h*.06,h*.3),rnd(90,260),rnd(2.5,6),'rgba(255,255,255,'+rnd(.08,.22)+')','rgba(255,255,255,0)')});
const sky=new THREE.Mesh(new THREE.SphereGeometry(1500,48,32),new THREE.MeshBasicMaterial({map:skyT,side:THREE.BackSide,fog:false,depthWrite:false}));
sky.renderOrder=-1;scene.add(sky);
// Realistic clouds: fractal-noise density, soft billowy edges, sun-side self-shadowing (lit tops, blue-grey bases)
const _cN=64,_cNoise=()=>{const p=new Float32Array(_cN*_cN);for(let i=0;i<p.length;i++)p[i]=Math.random();const sm=t=>t*t*(3-2*t);
  return(x,y)=>{x=((x%_cN)+_cN)%_cN;y=((y%_cN)+_cN)%_cN;const xi=Math.floor(x),yi=Math.floor(y),xf=sm(x-xi),yf=sm(y-yi),x1=(xi+1)%_cN,y1=(yi+1)%_cN,a=p[yi*_cN+xi],b=p[yi*_cN+x1],c=p[y1*_cN+xi],d=p[y1*_cN+x1];return a+(b-a)*xf+(c-a)*yf+(a-b-c+d)*xf*yf}};
const _ss=(a,b,x)=>{x=Math.max(0,Math.min(1,(x-a)/(b-a)));return x*x*(3-2*x)};
function mkCloudTex(kind){const W=512,H=256,n1=_cNoise(),n2=_cNoise(),n3=_cNoise(),dens=new Float32Array(W*H),raw=new Float32Array(W*H),ox=rnd(0,40),oy=rnd(0,40),ww=rnd(.36,.46),ab=rnd(.58,.66);
  const fb=(n,x,y,o)=>{let v=0,a=.5,f=1;for(let i=0;i<o;i++){v+=a*n(x*f,y*f);f*=2.03;a*=.5}return v};
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const u=x/W,v=y/H;let dd;
    if(kind===1){ // high wispy cirrus: stretched noise inside a thin lens
      const env=Math.max(0,1-Math.pow((u-.5)/.48,2)-Math.pow((v-.5)/.2,2)),wv=fb(n1,u*7+ox+fb(n3,u*3,v*3,2)*2,v*38+oy,5);
      dd=_ss(.38,.78,wv*1.25*Math.pow(env,.6)+(env-.5)*.5)*.7;raw[y*W+x]=dd*.6}
    else{ // cumulus: domed top, flat base, billowy fbm erosion
      const wx=u+(fb(n3,u*3+ox,v*3,3)-.5)*.22,wy=v+(fb(n3,u*3,v*3+oy,3)-.5)*.2,dx=(wx-.5)/ww,dy=wy<ab?(ab-wy)/(ab-.1):(wy-ab)/.07,env=Math.max(0,1-dx*dx-dy*dy);
      const dn=fb(n1,wx*9+ox,wy*6.5+oy,7),rw=Math.pow(env,.7)*1.05+(dn-.5)*1.35;const mk=_ss(-.3,.12,1-dx*dx-dy*dy)*_ss(0,.05,u)*_ss(0,.05,1-u);raw[y*W+x]=Math.max(0,rw)*mk;dd=_ss(.16,.6,rw)*mk}
    dens[y*W+x]=dd}
  const c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d'),im=g.createImageData(W,H),D=im.data,sx=.62,sy=-.78;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const i=y*W+x,d=dens[i],o=i*4;if(d<.004){D[o+3]=0;continue}
    let acc=0;for(let k=1;k<=7;k++){const xx=Math.round(x+sx*k*3.2),yy=Math.round(y+sy*k*3.2);if(xx>=0&&xx<W&&yy>=0&&yy<H)acc+=raw[yy*W+xx]}
    const lt=Math.exp(-acc*(kind===1?.15:.17)),v=y/H,base=.8+.2*(1-_ss(.5,.78,v)),edge=1-d,shine=Math.pow(edge,2)*lt*.18;
    const R=(150+(255-150)*lt)*base+shine*60,G=(166+(253-166)*lt)*base+shine*60,B=(198+(248-198)*lt)*base+shine*55;
    D[o]=Math.min(255,R);D[o+1]=Math.min(255,G);D[o+2]=Math.min(255,B);D[o+3]=Math.round(Math.min(1,d*(kind===1?.8:1.02))*255)}
  g.putImageData(im,0,0);const t=new THREE.CanvasTexture(c);t.anisotropy=4;return t}
const cloudTs=[mkCloudTex(0),mkCloudTex(0),mkCloudTex(0),mkCloudTex(0),mkCloudTex(1),mkCloudTex(1)];
const clouds=[];
for(let i=0;i<16;i++){const wisp=i>=12,s=new THREE.Sprite(new THREE.SpriteMaterial({map:cloudTs[wisp?4+(i%2):i%4],fog:false,transparent:true,depthWrite:false,opacity:wisp?rnd(.55,.8):rnd(.82,1)}));s.userData.baseOp=s.material.opacity;const w0=wisp?rnd(650,950):rnd(320,560);s.scale.set(w0,w0*.5,1);const az=i<12?rnd(-1.75,1.75):rnd(2.6,3.7),rad=rnd(400,950);s.userData.az=az;s.userData.rad=rad;s.userData.h=wisp?rnd(250,340):rnd(100,230); // fixed place on the sky dome (azimuth/radius/height around the player), positioned every frame like the sky sphere
s.position.set(Math.sin(az)*rad,s.userData.h,-Math.cos(az)*rad);scene.add(s);clouds.push(s)}

// sea + ground
const seaT=cv(256,256,(g,w,h)=>{g.fillStyle='#1c6cb2';g.fillRect(0,0,w,h);for(let i=0;i<280;i++){g.strokeStyle='rgba(255,255,255,'+rnd(.05,.28)+')';g.lineWidth=rnd(1,3);const x=rnd(0,w-45),y=rnd(0,h),l=rnd(10,40);g.beginPath();g.moveTo(x,y);g.lineTo(x+l,y+rnd(-2,2));g.stroke()}});
seaT.wrapS=seaT.wrapT=THREE.RepeatWrapping;seaT.repeat.set(30,56);
const SEA_LEVEL=-.15; // Lowered slightly below the road so the sea cannot visually rise over the asphalt on bends.
const seaNm=(()=>{const S=256,c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d'),im=g.createImageData(S,S),a=mkWrapNoise(8,8),b=mkWrapNoise(16,16),d=mkWrapNoise(40,40),
H=(x,y)=>{const u=(x+S)%S/S,v=(y+S)%S/S;return a(u,v)*.7+b(u,v)*.4+d(u,v)*.18};
for(let y=0;y<S;y++)for(let x=0;x<S;x++){const o=(y*S+x)*4,dx=(H(x+1,y)-H(x-1,y))*9,dy=(H(x,y+1)-H(x,y-1))*9;im.data[o]=Math.max(0,Math.min(255,128+dx*127));im.data[o+1]=Math.max(0,Math.min(255,128+dy*127));im.data[o+2]=255;im.data[o+3]=255}
g.putImageData(im,0,0);const t=new THREE.CanvasTexture(c);t.wrapS=t.wrapT=THREE.RepeatWrapping;t.anisotropy=ANISO;return t})();
const seaU=THREE.UniformsUtils.merge([THREE.UniformsLib.fog,{nm:{value:seaNm},t:{value:0},sunD:{value:new THREE.Vector3(.5,.8,-.25).normalize()},sunC:{value:new THREE.Color(1,.93,.8)},skyH:{value:new THREE.Color(.81,.9,.96)},skyZ:{value:new THREE.Color(.25,.55,.88)},deep:{value:new THREE.Color(.02,.2,.42)},shal:{value:new THREE.Color(.05,.55,.6)}}]);
const SEA_P={day:[[.81,.9,.96],[.25,.55,.88],[.02,.2,.42],[.05,.55,.6],[1,.93,.8],[.5,.8,-.25]],night:[[.09,.13,.28],[.01,.03,.1],[.01,.04,.1],[.02,.12,.17],[.45,.55,1],[-.5,.8,-.4]],winter:[[.55,.62,.66],[.4,.47,.52],[.08,.17,.22],[.2,.33,.37],[.5,.55,.58],[.3,.8,.2]]};
function seaMode(n,w){const p=SEA_P[n?'night':'day'].map(a=>a.slice());if(w){const q=SEA_P.winter;for(let i=0;i<4;i++)for(let j=0;j<3;j++)p[i][j]=n?q[i][j]*.3:q[i][j];p[4]=n?[.15,.18,.22]:q[4]}
 seaU.skyH.value.fromArray(p[0]);seaU.skyZ.value.fromArray(p[1]);seaU.deep.value.fromArray(p[2]);seaU.shal.value.fromArray(p[3]);seaU.sunC.value.fromArray(p[4]);seaU.sunD.value.set(p[5][0],p[5][1],p[5][2]).normalize();foamM.color.setScalar(n?.3:(w?.7:1))}
const sea=new THREE.Mesh(new THREE.PlaneGeometry(600,1400),new THREE.ShaderMaterial({uniforms:seaU,fog:true,
vertexShader:`varying vec3 vW;varying float vD;
#include <fog_pars_vertex>
void main(){vec4 w=modelMatrix*vec4(position,1.);vW=w.xyz;vD=position.x+287.;vec4 mvPosition=viewMatrix*w;gl_Position=projectionMatrix*mvPosition;
#include <fog_vertex>
}`,
fragmentShader:`uniform sampler2D nm;uniform float t;uniform vec3 sunD,sunC,skyH,skyZ,deep,shal;varying vec3 vW;varying float vD;
#include <fog_pars_fragment>
void main(){vec2 p=vW.xz;
vec2 s=(texture2D(nm,p*.02+vec2(-t*.03,t*.006)).xy-.5)*2.+(texture2D(nm,p*.06+vec2(-t*.05,t*.01)).xy-.5)*1.2+(texture2D(nm,p*.23+vec2(t*.035,-t*.03)).xy-.5)*.7+(texture2D(nm,p*.9+vec2(-t*.06,t*.05)).xy-.5)*.35;
float ph=p.x*.3+t*1.2+sin(p.y*.04)*2.;s+=vec2(cos(ph)*.3,sin(p.y*.11+t*.7)*.12)+vec2(cos(p.x*.9+t*2.1)*.1,0.);
vec3 V=cameraPosition-vW;float dist=length(V);V/=dist;float k=1./(1.+dist*.006);
vec3 N=normalize(vec3(s.x*k*1.6,1.,s.y*k*1.6));
float fr=min(1.,(.02+.98*pow(1.-max(dot(N,V),0.),5.))*1.6);
vec3 R=reflect(-V,N);R.y=abs(R.y);
vec3 refl=mix(skyH,skyZ,smoothstep(0.,.55,R.y));
float dd=max(vD,0.);vec3 body=mix(mix(vec3(.62,.56,.42)*(.5+.5*sunC.r),shal*1.15,smoothstep(0.,16.,dd)),deep,smoothstep(25.,190.,dd))*(.8+.4*dot(N,normalize(vec3(.3,1.,.2))));
vec3 col=mix(body,refl,fr);
vec3 Hh=normalize(sunD+V);float nh=max(dot(N,Hh),0.);
col+=sunC*(pow(nh,500.)*8.+pow(nh,60.)*.35)*(.5+.5*fr);
col+=vec3(.9,.95,1.)*smoothstep(.95,1.5,length(s))*.22*k;
gl_FragColor=vec4(col,1.);
#include <fog_fragment>
}`}));
sea.rotation.x=-Math.PI/2;sea.position.set(326,SEA_LEVEL,-600);scene.add(sea);
const ground=new THREE.Mesh(new THREE.PlaneGeometry(1200,1600),new THREE.MeshLambertMaterial({color:0xb9b2a2}));
ground.rotation.x=-Math.PI/2;ground.position.set(-575,-.1,-600);
// The land plane is only a backdrop: draw it first and never write depth, so the sunken lanes under the bridge (which lie below it) are not hidden by it.
ground.material.depthWrite=false;ground.renderOrder=-.5;scene.add(ground); // Keep the land plane on the road side; its edge meets the shoreline instead of covering the lowered sea.

// shared materials & geometries
// ===================== Realistic road / sidewalk / median surfaces (visual upgrade) =====================
// Everything below is procedural (no extra files). Textures are tileable along the road so segment joins stay seamless.
const _hq=_savedQuality!=='low';
function mkWrapNoise(gx,gy){const p=new Float32Array(gx*gy);for(let i=0;i<p.length;i++)p[i]=Math.random();
  return(u,v)=>{const x=(u-Math.floor(u))*gx,y=(v-Math.floor(v))*gy,xi=Math.floor(x),yi=Math.floor(y);let xf=x-xi,yf=y-yi;xf=xf*xf*(3-2*xf);yf=yf*yf*(3-2*yf);
    const x1=(xi+1)%gx,y1=(yi+1)%gy,a=p[yi*gx+xi],b=p[yi*gx+x1],c=p[y1*gx+xi],d=p[y1*gx+x1];return a+(b-a)*xf+(c-a)*yf+(a-b-c+d)*xf*yf}}
const _R=(a,b)=>a+Math.random()*(b-a);
function _mkCanvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c}
function _tex(c,wrapS,wrapT,rx,ry){const t=new THREE.CanvasTexture(c);t.wrapS=wrapS;t.wrapT=wrapT;if(rx)t.repeat.set(rx,ry);t.anisotropy=ANISO;return t}
// per-pixel grain on top of whatever is already painted (amp = random grain, amp2 = soft low-frequency mottling)
function _grain(c,amp,amp2,cells,tint){const W=c.width,H=c.height,g=c.getContext('2d'),im=g.getImageData(0,0,W,H),D=im.data,n=mkWrapNoise(cells,cells),n2=mkWrapNoise(cells*4,cells*4);
  const tr=tint?tint[0]:0,tg=tint?tint[1]:0,tb=tint?tint[2]:0;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){const o=(y*W+x)*4,u=x/W,v=y/H,d=(Math.random()-.5)*amp+(n(u,v)-.5)*amp2+(n2(u,v)-.5)*amp2*.5;D[o]+=d+tr;D[o+1]+=d+tg;D[o+2]+=d+tb}
  g.putImageData(im,0,0)}

// ---------- asphalt ----------
function buildAsphaltCanvas(W,H){
  const c=_mkCanvas(W,H),g=c.getContext('2d'),PX=W/18.33,PY=H/L,mpp=1/PX,laneM=18.33/5;
  const o0=mkWrapNoise(4,8),o1=mkWrapNoise(16,32),o2=mkWrapNoise(64,128),o3=mkWrapNoise(W/4,H/4),o4=mkWrapNoise(6,40);
  const im=g.createImageData(W,H),D=im.data;
  for(let y=0;y<H;y++){const v=y/H;
    for(let x=0;x<W;x++){const u=x/W,r=Math.random(),n0=o0(u,v),n1=o1(u,v),n2=o2(u,v),n3=o3(u,v);
      const lp=u*5,ln=Math.floor(lp),t=(lp-ln-.5)*laneM,at=Math.abs(t);              // metres from lane centre
      const wv=.55+.9*o4((ln+.37)/5,v);
      const tr=Math.exp(-((at-.82)*(at-.82))/.08)*wv;                                 // polished wheel paths
      const mid=Math.exp(-(t*t)/.04)*wv*.6;                                           // oil drip line between the wheels
      const dust=Math.exp(-Math.min(x,W-1-x)*mpp/.5)*(.45+.9*n2);                     // sand/dirt collected along the kerbs
      let Lm=60+(n0-.5)*20+(n1-.5)*15+(n2-.5)*13+(n3-.5)*12+(r-.5)*18;
      const ch=Math.random();
      if(ch<.05*(1-tr*.6))Lm+=26+Math.random()*44;else if(ch>.985)Lm-=20;             // light stone chips / dark binder
      Lm-=8*tr+5*mid;Lm+=11*dust;
      const o=(y*W+x)*4;D[o]=Lm+dust*12+tr;D[o+1]=Lm+dust*8;D[o+2]=Lm+3-dust*4+tr*2;D[o+3]=255}}
  g.putImageData(im,0,0);
  const k=W/512,wd=fn=>{for(const o of [0,-H,H]){g.save();g.translate(0,o);fn();g.restore()}};
  const poly=(pts,col,w)=>wd(()=>{g.strokeStyle=col;g.lineWidth=w;g.lineJoin='round';g.lineCap='round';g.beginPath();g.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)g.lineTo(pts[i][0],pts[i][1]);g.stroke()});
  // repair patches (fresh, darker asphalt with sealed edges) and trench cuts
  for(let i=0;i<6;i++){const w=_R(36,100)*k,h=_R(55,150)*k,x=_R(14*k,W-w-14*k),y=_R(0,H),a=_R(.1,.22),sp=Math.floor(w*h*.1);
    wd(()=>{g.fillStyle='rgba(20,21,25,'+a+')';g.fillRect(x,y,w,h);
      for(let s=0;s<sp;s++){g.fillStyle=Math.random()<.5?'rgba(255,255,255,.07)':'rgba(0,0,0,.14)';g.fillRect(x+Math.random()*w,y+Math.random()*h,_R(1,2.2),_R(1,2.2))}
      g.strokeStyle='rgba(6,6,8,.26)';g.lineWidth=1.1*k;g.strokeRect(x,y,w,h);g.strokeStyle='rgba(255,255,255,.03)';g.lineWidth=.8*k;g.strokeRect(x+1.5*k,y+1.5*k,w-3*k,h-3*k)})}
  for(let i=0;i<2;i++){const w=_R(.22,.4)*W,h=_R(9,20)*k,x=_R(10*k,W-w-10*k),y=_R(0,H);
    wd(()=>{g.fillStyle='rgba(14,15,18,.32)';g.fillRect(x,y,w,h);g.strokeStyle='rgba(0,0,0,.4)';g.lineWidth=1.4*k;g.strokeRect(x,y,w,h);g.strokeStyle='rgba(150,150,160,.07)';g.lineWidth=.8*k;g.strokeRect(x+1.5*k,y+1.5*k,w-3*k,h-3*k)})}
  // transverse sealed cracks
  for(let i=0;i<3;i++){const pts=[[0,_R(0,H)]];let x=0,y=pts[0][1];while(x<W){x+=_R(10,26)*k;y+=_R(-2.6,2.6)*k;pts.push([x,y])}
    poly(pts,'rgba(8,8,10,.34)',1.8*k);poly(pts,'rgba(150,150,160,.06)',.7*k)}
  // oil / fluid stains concentrated in the lane centres
  for(let i=0;i<18;i++){const x=(Math.floor(_R(0,5))+.5)*W/5+_R(-.2,.2)*W/5,y=_R(0,H),rx=_R(.1,.34)*PX,ry=_R(.2,.9)*PY,a=_R(.3,.55);
    wd(()=>{g.save();g.translate(x,y);g.scale(1,ry/rx);const gr=g.createRadialGradient(0,0,0,0,0,rx);gr.addColorStop(0,'rgba(6,6,9,'+a+')');gr.addColorStop(.65,'rgba(10,10,14,'+a*.45+')');gr.addColorStop(.9,'rgba(70,76,92,.1)');gr.addColorStop(1,'rgba(0,0,0,0)');g.fillStyle=gr;g.beginPath();g.arc(0,0,rx,0,7);g.fill();g.restore()})}
  // braking marks
  for(let i=0;i<3;i++){const x=(Math.floor(_R(0,5))+.5)*W/5,y=_R(0,H),len=_R(5,11)*PY,ox=_R(-.12,.12)*PX;
    for(const s of [-.8,.8]){const gx=x+s*PX*.9+ox,pts=[];for(let j=0;j<=8;j++)pts.push([gx+Math.sin(j*.5)*.03*PX,y+len*j/8]);poly(pts,'rgba(5,5,7,.2)',.22*PX)}}
  // cracks with branches
  const cracks=[];
  const mk=(x,y,ang,len,depth)=>{const pts=[[x,y]];let a=ang,l=0;while(l<len){const s=_R(8,20)*k;a+=_R(-.4,.4);x+=Math.cos(a)*s*.7;y+=Math.sin(a)*s*1.3;pts.push([x,y]);l+=s;if(depth<2&&Math.random()<.08)mk(x,y,a+_R(.5,1.1)*(Math.random()<.5?-1:1),len*.5,depth+1)}cracks.push(pts)};
  for(let i=0;i<11;i++)mk(_R(10*k,W-10*k),_R(0,H),Math.PI/2+_R(-.8,.8),_R(40,130)*k,0);
  for(const p of cracks){poly(p,'rgba(0,0,0,.12)',2.6*k);poly(p,'rgba(4,4,6,.5)',.9*k)}
  // alligator (map) cracking
  for(let n=0;n<2;n++){const s=_R(10,15)*k,x0=_R(20*k,W-120*k),y0=_R(0,H),m=6,P=[];
    for(let i=0;i<=m;i++){P.push([]);for(let j=0;j<=m;j++)P[i].push([x0+i*s+_R(-.32,.32)*s,y0+j*s*1.4+_R(-.32,.32)*s])}
    wd(()=>{g.fillStyle='rgba(0,0,0,.07)';g.fillRect(x0,y0,m*s,m*s*1.4);g.strokeStyle='rgba(4,4,6,.38)';g.lineWidth=.9*k;g.beginPath();
      for(let i=0;i<=m;i++)for(let j=0;j<=m;j++){if(i<m&&Math.random()<.6){g.moveTo(P[i][j][0],P[i][j][1]);g.lineTo(P[i+1][j][0],P[i+1][j][1])}if(j<m&&Math.random()<.6){g.moveTo(P[i][j][0],P[i][j][1]);g.lineTo(P[i][j+1][0],P[i][j+1][1])}}g.stroke()})}
  // manhole covers + kerb drain grates (circular/rectangular in world space despite the non-square texture)
  for(const lane of [1.5,3.5]){const x=lane*W/5+_R(-.2,.2)*PX,y=_R(0,H),rx=.37*PX,ry=.37*PY;
    wd(()=>{g.fillStyle='rgba(0,0,0,.34)';g.beginPath();g.ellipse(x,y,rx+3*k,ry+3*k,0,0,7);g.fill();
      g.fillStyle='#2a2b2e';g.beginPath();g.ellipse(x,y,rx,ry,0,0,7);g.fill();g.strokeStyle='rgba(170,170,175,.5)';g.lineWidth=1.6*k;g.stroke();
      g.strokeStyle='rgba(95,96,100,.7)';g.lineWidth=1.1*k;g.beginPath();g.ellipse(x,y,rx*.72,ry*.72,0,0,7);g.stroke();
      for(let a=0;a<12;a++){const an=a*Math.PI/6;g.beginPath();g.moveTo(x+Math.cos(an)*rx*.72,y+Math.sin(an)*ry*.72);g.lineTo(x+Math.cos(an)*rx*.97,y+Math.sin(an)*ry*.97);g.stroke()}})}
  for(const side of [0,1])for(let q=0;q<2;q++){const gw=.5*PX,gh=1*PY,x=side?W-.12*PX-gw:.12*PX,y=_R(0,H-gh);
    wd(()=>{g.fillStyle='rgba(0,0,0,.45)';g.fillRect(x-2*k,y-2*k,gw+4*k,gh+4*k);g.fillStyle='#202124';g.fillRect(x,y,gw,gh);g.strokeStyle='rgba(120,120,126,.75)';g.lineWidth=1.5*k;g.strokeRect(x,y,gw,gh);
      for(let b=1;b<10;b++){const yy=y+gh*b/10;g.beginPath();g.moveTo(x+2*k,yy);g.lineTo(x+gw-2*k,yy);g.stroke()}})}
  // gutter shadow + sand drifts on the road side of every kerb
  g.fillStyle='rgba(14,12,10,.34)';g.fillRect(0,0,5*k,H);g.fillRect(W-5*k,0,5*k,H);
  for(let i=0;i<90;i++){const e=Math.random()<.5,x=e?_R(0,32*k):W-_R(0,32*k),y=_R(0,H),r=_R(6,22)*k;
    wd(()=>{const gr=g.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,'rgba(178,158,118,.24)');gr.addColorStop(1,'rgba(178,158,118,0)');g.fillStyle=gr;g.fillRect(x-r,y-r,r*2,r*2)})}
  // ---- lane markings: thermoplastic paint that is worn, dirty and chipped ----
  const pc=_mkCanvas(W,H),p=pc.getContext('2d'),rects=[[4*k,0,8*k,H],[W-12*k,0,8*k,H]];
  for(let j=1;j<5;j++)for(let i=0;i<6;i++)rects.push([j*W/5-3*k,i*H/6,6*k,H/12]);
  for(const [x,y,w,h] of rects){g.fillStyle='rgba(0,0,0,.14)';g.fillRect(x-2.5*k,y,w+5*k,h);p.fillStyle='#e9e8e1';p.fillRect(x,y,w,h)}
  p.globalCompositeOperation='source-atop';
  for(let i=0;i<70;i++){const r=rects[Math.floor(Math.random()*rects.length)],bx=r[0]+Math.random()*r[2],by=r[1]+Math.random()*r[3],rr=_R(5,20)*k,gr=p.createRadialGradient(bx,by,0,bx,by,rr);gr.addColorStop(0,'rgba(95,90,80,'+_R(.15,.4)+')');gr.addColorStop(1,'rgba(95,90,80,0)');p.fillStyle=gr;p.fillRect(bx-rr,by-rr,rr*2,rr*2)}
  p.globalCompositeOperation='destination-out';
  for(const [x,y,w,h] of rects){const n=Math.floor(w*h*.028);for(let s=0;s<n;s++){p.fillStyle='rgba(0,0,0,'+_R(.3,.9)+')';p.fillRect(x+Math.random()*w,y+Math.random()*h,_R(1,3)*k*.8,_R(1,4)*k*.8)}
    for(let s=0;s<h/(5*k);s++){const ex=Math.random()<.5?x:x+w-1.2*k;p.fillStyle='rgba(0,0,0,'+_R(.4,1)+')';p.fillRect(ex+_R(-1,1)*k,y+Math.random()*h,_R(1,2.2)*k,_R(1,4)*k)}}
  for(let i=0;i<14;i++){const r=rects[Math.floor(Math.random()*rects.length)],bx=r[0]+Math.random()*r[2],by=r[1]+Math.random()*r[3],rr=_R(8,24)*k,gr=p.createRadialGradient(bx,by,0,bx,by,rr);gr.addColorStop(0,'rgba(0,0,0,'+_R(.2,.45)+')');gr.addColorStop(1,'rgba(0,0,0,0)');p.fillStyle=gr;p.fillRect(bx-rr,by-rr,rr*2,rr*2)}
  g.globalAlpha=.94;g.drawImage(pc,0,0);g.globalAlpha=1;
  for(let i=0;i<500;i++){const r=rects[Math.floor(Math.random()*rects.length)];g.fillStyle='rgba(255,255,255,'+_R(.2,.5)+')';g.fillRect(r[0]+Math.random()*r[2],r[1]+Math.random()*r[3],1,1)}
  return c}
function buildGrainCanvas(S){const c=_mkCanvas(S,S),g=c.getContext('2d'),im=g.createImageData(S,S),D=im.data,n=mkWrapNoise(S/8,S/8),n2=mkWrapNoise(S/2,S/2);
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){const o=(y*S+x)*4;let v=128+(Math.random()-.5)*70+(n(x/S,y/S)-.5)*46+(n2(x/S,y/S)-.5)*34;if(Math.random()<.04)v+=(Math.random()<.5?-1:1)*38;D[o]=D[o+1]=D[o+2]=v;D[o+3]=255}
  g.putImageData(im,0,0);return c}
const AW=_hq?1024:512,AH=_hq?2048:1024;
const asC=buildAsphaltCanvas(AW,AH);
const asT=new THREE.CanvasTexture(asC);asT.anisotropy=ANISO;
asT.wrapS=asT.wrapT=THREE.ClampToEdgeWrapping;
const asDetailT=_tex(buildGrainCanvas(256),THREE.RepeatWrapping,THREE.RepeatWrapping);
const asM=new THREE.MeshPhongMaterial({map:asT,color:0xffffff,specular:0x17191c,shininess:8});
// micro-grain layer: tiles every 0.5 m so the asphalt stays crisp when the camera is close to the ground
asM.onBeforeCompile=sh=>{sh.uniforms.detailMap={value:asDetailT};
  sh.fragmentShader='uniform sampler2D detailMap;\n'+sh.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\n{float _d=texture2D(detailMap,vUv*vec2(36.7,120.)).r;diffuseColor.rgb*=.45+1.1*_d;}')};
asM.customProgramCacheKey=()=>'asphaltDetailV2';
// ===== Night road lighting (v58) =====================================================================
// Analytic lamp pools + view-dependent wet-asphalt reflection streaks. Up to 24 lights (20 street-lamp heads + 4 car lights)
// are fed to the road/sidewalk shaders every frame from updateRoadLampUniforms().
const RLN=24;
const RLU={P:{value:Array.from({length:RLN},()=>new THREE.Vector4())},C:{value:Array.from({length:RLN},()=>new THREE.Vector4())},K:{value:0},W:{value:0}};
function patchRoadLamp(mat,streak,poolK,refK){
  const prev=mat.onBeforeCompile,prevKey=mat.customProgramCacheKey?mat.customProgramCacheKey():'';
  mat.onBeforeCompile=function(sh,r){
    if(prev)prev.call(this,sh,r);
    sh.uniforms.uRP=RLU.P;sh.uniforms.uRC=RLU.C;sh.uniforms.uRK=RLU.K;sh.uniforms.uRW=RLU.W;
    sh.vertexShader=sh.vertexShader
      .replace('void main() {','varying vec3 vRWP;\nvoid main() {')
      .replace('#include <project_vertex>','#include <project_vertex>\nvRWP=(modelMatrix*vec4(transformed,1.0)).xyz;');
    const f=[
      'if(uRK>.001){',
      '  diffuseColor.rgb*=1.-.2*uRK;',
      '  vec3 _alb=diffuseColor.rgb;vec3 _acc=vec3(0.);',
      '  for(int _i=0;_i<20;_i++){',
      '    vec3 _d=uRP[_i].xyz-vRWP;float _h2=dot(_d.xz,_d.xz);',
      '    float _f=1./(1.+_h2/170.);',
      '    _f*=clamp(1.-sqrt(_h2)/52.,0.,1.);',
      '    _f*=clamp(_d.y/sqrt(_h2+_d.y*_d.y)*1.6,0.,1.);',
      '    _acc+=uRC[_i].rgb*_f;',
      '  }',
      '  totalEmissiveRadiance+=_alb*_acc*'+poolK.toFixed(2)+'*uRK;'
    ];
    if(streak)f.push(
      '  vec3 _V=normalize(cameraPosition-vRWP);',
      '  vec3 _R=vec3(-_V.x,_V.y,-_V.z);',
      '  vec2 _rh=_R.xz/(length(_R.xz)+1e-4);',
      '  float _fr=.28+.72*pow(1.-clamp(_V.y,0.,1.),2.);',
      '  float _md=.9+.1*sin(vRWP.z*.9+vRWP.x*2.3)*sin(vRWP.z*.37-vRWP.x*1.1);',
      '  vec3 _sl=vec3(0.);vec3 _sc=vec3(0.);',
      '  for(int _i=0;_i<24;_i++){',
      '    vec4 _c=uRC[_i];',
      '    if(_i<20){',
      '      if(abs(_c.a)>0.){',
      '        vec3 _d=vRWP-uRP[_i].xyz;',
      '        float _s=uRP[_i].w;vec2 _lt=vec2(sqrt(1.-_s*_s),_s);',
      '        float _ac=dot(_d.xz,_lt)*sign(_c.a);',
      '        float _al=dot(_d.xz,vec2(-_lt.y,_lt.x));',
      '        float _lp=smoothstep(-2.6,-1.4,_ac)*(1.-.88*smoothstep(6.2,18.,_ac));',
      '        _sl+=_c.rgb*_lp*(.85*exp(-(_al*_al)/289.)+.2*exp(-(_al*_al)/36.));',
      '      }',
      '    }else if(_c.a>0.){',
      '      vec3 _d=uRP[_i].xyz-vRWP;float _dl=length(_d);vec3 _dn=_d/_dl;',
      '      vec2 _dh=_d.xz/(length(_d.xz)+1e-4);',
      '      float _az=_rh.x*_dh.y-_rh.y*_dh.x;',
      '      float _de=_R.y-_dn.y;',
      '      float _se=uRP[_i].w*(1.+1.5*uRW);',
      '      float _g=(exp(-(_az*_az)/(.0049*(1.+1.4*uRW)))*exp(-(_de*_de)/(_se*_se))+.45*exp(-(_az*_az)/(.0343*(1.+1.4*uRW)))*exp(-(_de*_de)/(_se*_se*2.5)))*step(0.,dot(_rh,_dh));',
      '      _g/=(1.+_dl*_dl/90000.)*(1.+.4*uRW);',
      '      _sc+=_c.rgb*_g*_c.a;',
      '    }',
      '  }',
      '  totalEmissiveRadiance+=(_sl*(1.+.6*uRW)*'+refK.toFixed(2)+'+_sc*_fr*_md*.3*(1.+.8*uRW))*uRK;'
    );
    f.push('}');
    sh.fragmentShader=sh.fragmentShader
      .replace('void main() {','uniform vec4 uRP[24];uniform vec4 uRC[24];uniform float uRK;uniform float uRW;varying vec3 vRWP;\nvoid main() {')
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\n'+f.join('\n'));
  };
  mat.customProgramCacheKey=()=>prevKey+'|roadLamp'+(streak?'S':'P')+poolK+'_'+refK;
  mat.needsUpdate=true;
}
patchRoadLamp(asM,true,.7,.15);
// ===== Wet surfaces (winter): rain-soaked thin water film on asphalt / pavement. NO standing water, NO puddles. =====
// Look: darker, slightly saturated and lower-contrast albedo (water fills the pores); soft Fresnel reflection of the overcast sky that
// grows toward the horizon (broad, rough-film blur - never a mirror); glossier binder / polished wheel tracks vs matte stone chips;
// tiny impact dimples + micro-splashes from the falling rain. Everything is analytic (no extra textures / render passes).
const RAINU={T:{value:0},K:{value:0},N:{value:0},S:{value:new THREE.Vector3(.56,.62,.67)},Z:{value:new THREE.Vector3(.34,.38,.43)},G:{value:new THREE.Vector3(.40,.43,.46)}};
// <<WET-GLSL-BEGIN>>
const WET_FN=[
  'uniform float uRT;uniform float uRainK;uniform float uWN;uniform vec3 uRSky;uniform vec3 uRZen;uniform vec3 uRGnd;',
  'float wtH(vec2 p){vec3 q=fract(vec3(mod(p,512.).xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}',
  'float wtV(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(wtH(i),wtH(i+vec2(1.,0.)),f.x),mix(wtH(i+vec2(0.,1.)),wtH(i+vec2(1.,1.)),f.x),f.y);}',
  'float wtF(vec2 p){return wtV(p)*.57+wtV(p*2.17+7.1)*.29+wtV(p*4.6+3.7)*.14;}',
  // reflected sky: ground-level scenery -> hazy horizon -> darker overcast zenith; "rough" widens every transition (blurred reflection)
  'vec3 wtSky(float y,float rough){',
  '  float w=.05+.6*rough;',
  '  vec3 c=mix(uRSky,uRZen,smoothstep(-w,.6+w,y));',
  '  vec3 g=mix(uRGnd,uRSky,1.-smoothstep(.0,.05+.05*rough,y));',   // looking along the road: far scenery dissolves into the haze
  '  return mix(g,c,smoothstep(.02,.14+.35*rough,y));',
  '}',
  // one grid layer of drop impacts: a faint ring that widens to ~7 cm + a ~8 mm bright micro-splash in the first part of the cycle
  'vec2 wtHit(vec2 p,float t,float cell,float rate){',
  '  vec2 g=p/cell;vec2 id=floor(g);vec2 f=fract(g)-.5;',
  '  float h=wtH(id),h3=wtH(id+19.7);',
  '  float per=.55+h3*.8;',
  '  float tt=t*rate/per+h*7.3;',
  '  float cy=floor(tt);float ph=tt-cy;',
  '  vec2 c=(vec2(wtH(id+cy*1.7+7.3),wtH(id+cy*2.3+3.1))-.5)*.5;',
  '  float on=step(.38,wtH(id+cy*3.7+h3*11.));',
  '  float d=length(f-c)*cell;',
  '  float R=.004+ph*.07;',
  '  float q=(d-R)/.0075;',
  '  float fd=1.-ph;fd*=fd;',
  '  float ring=exp(-q*q)*fd;',
  '  float spl=exp(-d*d/.00005)*(1.-smoothstep(0.,.12,ph));',
  '  return vec2(ring,spl)*on;',
  '}'
].join('\n');
// o: dark = albedo multiplier when fully wet, gloss = base smoothness of the film (0..1), rip = strength of drop-impact marks
function wetBody(o){
  const f=x=>Number(x).toFixed(3);
  return [
    'if(uRainK>.001){',
    '  vec3 _wv=normalize(cameraPosition-vRWP);',
    '  float _cv=clamp(_wv.y,0.,1.);',
    '  float _rd=length(cameraPosition-vRWP);',
    '  vec2 _p=vRWP.xz;',
    // slow wetness variation (more / less water on the surface) - the film itself stays thin everywhere
    '  float _m1=wtF(_p*.23+3.1);float _m2=wtF(_p*1.3+11.3);',
    '  float _wet=uRainK*clamp(.86+.55*(_m1-.5)+.3*(_m2-.5),.62,1.);',
    '  float _lum=dot(diffuseColor.rgb,vec3(.299,.587,.114));',
    // wet albedo: lower contrast, a touch cooler, darker
    '  vec3 _wc=mix(diffuseColor.rgb,vec3(_lum)*vec3(.95,1.,1.06),.28)*(1.-.4*smoothstep(.17,.4,_lum)*(1.-smoothstep(.55,.78,_lum)));',
    '  diffuseColor.rgb=_wc*mix(1.,'+f(o.dark)+',_wet);',
    // smoothness: dark binder / worn wheel tracks reflect more, bright stone chips scatter the light
    '  float _gl=clamp('+f(o.gloss)+'*(.84+.5*(_m2-.45)+.35*(_m1-.5))*(1.18-1.3*smoothstep(.14,.46,_lum)),.06,1.);',
    '  float _rg=1.-_gl;',
    // Fresnel (water, F0 .03): faint when looking down at the road, strong toward the horizon; roughness tempers it
    '  float _F=(.04+.96*pow(1.-_cv,5.))*(1.-.38*_rg);',
    '  vec3 _Rv=vec3(-_wv.x,_wv.y,-_wv.z);',
    '  vec3 _env=wtSky(_Rv.y,.12+.5*_rg);',
    '  vec3 _rfl=_env*_F*(.55+.45*_gl);',
    '  _rfl=1.-exp(-_rfl*1.8);',                           // soft shoulder: no glare, no hot spots
    '  totalEmissiveRadiance+=_rfl*_wet;',
    // rain impacts (near field only; they fade out before they could alias)
    '  float _rf=(1.-smoothstep(5.,24.,_rd))*uRainK*'+f(o.rip)+';',
    '  if(_rf>.003){',
    '    vec2 _h1=wtHit(_p,uRT,.33,1.);',
    '    vec2 _h2=wtHit(mat2(.8,.6,-.6,.8)*_p+13.7,uRT,.5,.8);',
    '    vec2 _h3=wtHit(mat2(.6,-.8,.8,.6)*_p+31.9,uRT,.21,1.3);',
    '    float _ring=_h1.x+_h2.x+.7*_h3.x;float _spl=_h1.y+_h2.y+_h3.y;',
    '    vec3 _rc=mix(vec3(.62,.70,.78),uRSky*1.3,.5);',
    '    totalEmissiveRadiance+=_rc*(_ring*.22+_spl*.5)*_rf*(.35+.65*_F);',
    '  }',
    '}'
  ].join('\n');
}
// <<WET-GLSL-END>>
function patchWet(mat,o){
  const prev=mat.onBeforeCompile,prevKey=mat.customProgramCacheKey?mat.customProgramCacheKey():'';
  mat.onBeforeCompile=function(sh,r){
    if(prev)prev.call(this,sh,r);
    sh.uniforms.uRT=RAINU.T;sh.uniforms.uRainK=RAINU.K;sh.uniforms.uWN=RAINU.N;
    sh.uniforms.uRSky=RAINU.S;sh.uniforms.uRZen=RAINU.Z;sh.uniforms.uRGnd=RAINU.G;
    if(sh.vertexShader.indexOf('vRWP')<0){   // world position varying (already added by patchRoadLamp on most materials)
      sh.vertexShader=sh.vertexShader
        .replace('void main() {','varying vec3 vRWP;\nvoid main() {')
        .replace('#include <project_vertex>','#include <project_vertex>\nvRWP=(modelMatrix*vec4(transformed,1.0)).xyz;');
      sh.fragmentShader=sh.fragmentShader.replace('void main() {','varying vec3 vRWP;\nvoid main() {');
    }
    sh.fragmentShader=sh.fragmentShader
      .replace('void main() {',WET_FN+'\nvoid main() {')
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\n'+wetBody(o));
  };
  mat.customProgramCacheKey=()=>prevKey+'|wetV3:'+[o.dark,o.gloss,o.rip].join('_');
  mat.needsUpdate=true;
}
const WET_ROAD={dark:.7,gloss:.8,rip:1},WET_WALK={dark:.68,gloss:.4,rip:.55};
patchWet(asM,WET_ROAD);
// the wet look is fully procedural and fades in with the rain, so the dry texture is used in every weather (no texture swap pop)
const asWetT=asT;

// ---------- sidewalk: 40x20 cm concrete pavers in running bond (one 512px tile = 2 m x 2 m) ----------
function buildPaverCanvas(S){
  const c=_mkCanvas(S,S),g=c.getContext('2d');
  g.fillStyle='#6c665a';g.fillRect(0,0,S,S);                                   // joint sand
  const cols=5,rows=10,pw=S/cols,ph=S/rows,gap=Math.max(3,Math.round(S/128));
  for(let r=0;r<rows;r++)for(let i=-1;i<=cols;i++){
    const x=Math.round((i+(r%2)*.5)*pw),y=Math.round(r*ph),w=Math.round(pw)-gap,h=Math.round(ph)-gap,t=Math.random(),v=_R(-11,11);
    const b=t<.68?[206,196,176]:t<.9?[192,189,180]:[176,164,140];
    g.fillStyle='rgb('+Math.round(b[0]+v+(Math.random()<.1?8:0))+','+Math.round(b[1]+v)+','+Math.round(b[2]+v-(Math.random()<.1?6:0))+')';g.fillRect(x,y,w,h);
    const gr=g.createLinearGradient(x,y,x+w,y+h);gr.addColorStop(0,'rgba(255,255,255,.12)');gr.addColorStop(1,'rgba(0,0,0,.09)');g.fillStyle=gr;g.fillRect(x,y,w,h);
    g.fillStyle='rgba(255,255,255,.3)';g.fillRect(x,y,w,2);g.fillRect(x,y,2,h);g.fillStyle='rgba(0,0,0,.2)';g.fillRect(x,y+h-2,w,2);g.fillRect(x+w-2,y,2,h);
    if(Math.random()<.12){g.fillStyle='rgba(50,44,34,.55)';const s=_R(4,9);g.beginPath();g.moveTo(x+w,y+h);g.lineTo(x+w-s,y+h);g.lineTo(x+w,y+h-s);g.fill()}
    if(Math.random()<.07){g.strokeStyle='rgba(40,34,24,.6)';g.lineWidth=1;g.beginPath();let cx=x+_R(.2,.8)*w,cy=y;g.moveTo(cx,cy);while(cy<y+h){cx+=_R(-5,5);cy+=_R(5,12);g.lineTo(Math.max(x,Math.min(x+w,cx)),Math.min(y+h,cy))}g.stroke()}}
  for(let i=0;i<14;i++){const x=_R(0,S),y=_R(0,S),r=_R(20,70),gr=g.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,'rgba(70,56,36,'+_R(.08,.2)+')');gr.addColorStop(1,'rgba(70,56,36,0)');g.fillStyle=gr;g.fillRect(x-r,y-r,r*2,r*2)}
  for(let i=0;i<30;i++){g.fillStyle='rgba(60,60,58,'+_R(.25,.5)+')';g.beginPath();g.arc(_R(0,S),_R(0,S),_R(1.2,3),0,7);g.fill()}
  _grain(c,22,14,16);return c}
const swT=_tex(buildPaverCanvas(512),THREE.RepeatWrapping,THREE.RepeatWrapping,2.5,30);
// kerb stone face (1 m sections, grimy toward the road)
function buildKerbFaceCanvas(){const W=512,H=128,c=_mkCanvas(W,H),g=c.getContext('2d');
  g.fillStyle='#b4b1a6';g.fillRect(0,0,W,H);
  let gr=g.createLinearGradient(0,0,0,H);gr.addColorStop(0,'rgba(255,255,255,.22)');gr.addColorStop(.12,'rgba(255,255,255,0)');gr.addColorStop(.5,'rgba(60,50,35,0)');gr.addColorStop(1,'rgba(52,42,30,.62)');g.fillStyle=gr;g.fillRect(0,0,W,H);
  for(let i=0;i<40;i++){const x=_R(0,W),w=_R(1,4),a=_R(.04,.12),gg=g.createLinearGradient(0,0,0,H);gg.addColorStop(0,'rgba(60,50,40,0)');gg.addColorStop(1,'rgba(60,50,40,'+a+')');g.fillStyle=gg;g.fillRect(x,0,w,H*_R(.5,1))}
  for(let i=0;i<14;i++){g.fillStyle='rgba(10,10,10,'+_R(.1,.22)+')';g.beginPath();g.ellipse(_R(0,W),_R(H*.55,H*.95),_R(10,40),_R(3,9),0,0,7);g.fill()}
  for(let i=0;i<7;i++){g.fillStyle='rgba(50,45,38,.35)';g.beginPath();g.arc(_R(0,W),_R(0,H*.3),_R(.8,1.8),0,7);g.fill()}
  g.fillStyle='rgba(20,18,14,.7)';g.fillRect(0,0,3,H);g.fillStyle='rgba(255,255,255,.12)';g.fillRect(3,0,1,H);
  _grain(c,24,10,16);return c}
const kerbFaceT=_tex(buildKerbFaceCanvas(),THREE.RepeatWrapping,THREE.ClampToEdgeWrapping,60,1);
const swSide=new THREE.MeshPhongMaterial({map:kerbFaceT,bumpMap:kerbFaceT,bumpScale:.004,specular:0x101010,shininess:5});
// sidewalk = 2 draw calls (textured top + kerb sides) instead of 6; the unseen bottom and end caps are dropped
const _swTop=tint=>new THREE.MeshPhongMaterial({map:swT,bumpMap:swT,bumpScale:.006,color:tint,specular:0x1a1a1a,shininess:7});
const swM=[_swTop(0xffffff),swSide],swLM=[_swTop(0xe4dcc8),swSide];

// ---------- generic weathered concrete (coping, kerb lip, sea wall top) ----------
function buildConcreteCanvas(W,H,base,jointH,jointV){const c=_mkCanvas(W,H),g=c.getContext('2d');
  g.fillStyle='rgb('+base[0]+','+base[1]+','+base[2]+')';g.fillRect(0,0,W,H);
  for(let i=0;i<10;i++){const x=_R(0,W),y=_R(0,H),r=_R(.1,.4)*Math.min(W,H)*2,gr=g.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,'rgba(60,52,40,'+_R(.05,.16)+')');gr.addColorStop(1,'rgba(60,52,40,0)');g.fillStyle=gr;g.fillRect(x-r,y-r,r*2,r*2)}
  for(let i=0;i<Math.floor(W*H/900);i++){g.fillStyle='rgba(40,36,30,'+_R(.2,.5)+')';g.fillRect(_R(0,W),_R(0,H),_R(1,2),_R(1,2))}
  if(jointH){g.fillStyle='rgba(20,18,14,.7)';g.fillRect(0,0,W,Math.max(2,H/64));g.fillStyle='rgba(255,255,255,.14)';g.fillRect(0,Math.max(2,H/64),W,1)}
  if(jointV){g.fillStyle='rgba(20,18,14,.6)';g.fillRect(0,0,Math.max(2,W/128),H)}
  _grain(c,22,12,8);return c}

// ---------- median island ----------
// concrete coping + painted kerb stones (alternating white / black every metre, as on Egyptian corniches)
function buildCurbPaintCanvas(){const W=512,H=64,c=_mkCanvas(W,H),g=c.getContext('2d');
  g.fillStyle='#a8a59a';g.fillRect(0,0,W,H);
  g.fillStyle='#dfded6';g.fillRect(0,0,W/2,H);g.fillStyle='#242427';g.fillRect(W/2,0,W/2,H);
  for(let i=0;i<260;i++){const x=Math.random()<.5?_R(0,W):(Math.random()<.5?_R(0,W/2):_R(W/2,W)),y=Math.random()<.7?_R(0,H*.35):_R(0,H);g.fillStyle='rgba(150,146,134,'+_R(.5,.95)+')';g.fillRect(x,y,_R(1,4),_R(1,3))}   // flaked paint
  const gr=g.createLinearGradient(0,0,0,H);gr.addColorStop(0,'rgba(255,255,255,.12)');gr.addColorStop(.45,'rgba(120,104,80,0)');gr.addColorStop(1,'rgba(120,104,80,.6)');g.fillStyle=gr;g.fillRect(0,0,W,H);
  for(let i=0;i<9;i++){g.fillStyle='rgba(8,8,8,'+_R(.12,.25)+')';g.beginPath();g.ellipse(_R(0,W),_R(H*.6,H*.95),_R(8,30),_R(2,6),0,0,7);g.fill()}
  g.fillStyle='rgba(0,0,0,.55)';g.fillRect(0,0,2,H);g.fillRect(W/2-1,0,2,H);
  _grain(c,20,8,16);return c}
const curbPaintT=_tex(buildCurbPaintCanvas(),THREE.RepeatWrapping,THREE.ClampToEdgeWrapping,30,1);
const copingT=_tex(buildConcreteCanvas(256,128,[168,166,158],true,false),THREE.RepeatWrapping,THREE.RepeatWrapping,1,60);
const curbM=[new THREE.MeshPhongMaterial({map:copingT,bumpMap:copingT,bumpScale:.003,specular:0x101010,shininess:5}),new THREE.MeshPhongMaterial({map:curbPaintT,bumpMap:curbPaintT,bumpScale:.003,specular:0x101010,shininess:6})];
// grass bed (1.5 m x 2 m tile) with dry patches, clover, soil showing through and daisies
function buildGrassCanvas(S){const c=_mkCanvas(S,S),g=c.getContext('2d'),im=g.createImageData(S,S),D=im.data,o0=mkWrapNoise(6,6),o1=mkWrapNoise(24,24),o2=mkWrapNoise(96,96);
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){const u=x/S,v=y/S,n0=o0(u,v),n1=o1(u,v),n2=o2(u,v),r=Math.random(),dry=_ss(.62,.85,n0)*.5,m=n1;
    let R_=62+m*28,G_=104+m*26,B_=36+m*10;R_+=(150-R_)*dry;G_+=(140-G_)*dry;B_+=(76-B_)*dry;
    const b=(r-.5)*38+(n2-.5)*34,o=(y*S+x)*4;D[o]=R_+b*.8;D[o+1]=G_+b;D[o+2]=B_+b*.5;D[o+3]=255}
  g.putImageData(im,0,0);
  const pal=['#3f6a22','#4f7c2a','#668f38','#2f5719','#7aa044','#8b8f48'],wr=(fn)=>{for(const ox of [0,-S,S])for(const oy of [0,-S,S]){g.save();g.translate(ox,oy);fn();g.restore()}};
  for(let i=0;i<5200;i++){const x=_R(0,S),y=_R(0,S),a=_R(0,6.28),l=_R(4,10),near=x<14||x>S-14||y<14||y>S-14,col=pal[Math.floor(Math.random()*pal.length)];
    const draw=()=>{g.strokeStyle=col;g.globalAlpha=_R(.35,.8);g.lineWidth=_R(.8,1.5);g.beginPath();g.moveTo(x,y);g.lineTo(x+Math.cos(a)*l,y+Math.sin(a)*l);g.stroke()};
    if(near)wr(draw);else draw()}
  g.globalAlpha=1;
  for(let i=0;i<7;i++){const x=_R(0,S),y=_R(0,S),rx=_R(14,36),ry=_R(10,26),gr=g.createRadialGradient(x,y,0,x,y,rx);gr.addColorStop(0,'rgba(118,94,66,.75)');gr.addColorStop(.7,'rgba(118,94,66,.35)');gr.addColorStop(1,'rgba(118,94,66,0)');g.save();g.translate(x,y);g.scale(1,ry/rx);g.translate(-x,-y);g.fillStyle=gr;g.beginPath();g.arc(x,y,rx,0,7);g.fill();g.restore()}
  for(let i=0;i<36;i++){const x=_R(0,S),y=_R(0,S);g.fillStyle='rgba(38,82,26,.8)';for(let k=0;k<3;k++){g.beginPath();g.arc(x+Math.cos(k*2.1)*3,y+Math.sin(k*2.1)*3,2.6,0,7);g.fill()}}
  for(let i=0;i<46;i++){const x=_R(0,S),y=_R(0,S);g.fillStyle='rgba(245,245,238,.92)';for(let k=0;k<5;k++){g.beginPath();g.arc(x+Math.cos(k*1.256)*2.2,y+Math.sin(k*1.256)*2.2,1.3,0,7);g.fill()}g.fillStyle='#e8c11e';g.beginPath();g.arc(x,y,1.1,0,7);g.fill()}
  for(const edge of [0,1]){const gr=g.createLinearGradient(edge?S:0,0,edge?S-S*.1:S*.1,0);gr.addColorStop(0,'rgba(150,128,92,.5)');gr.addColorStop(1,'rgba(150,128,92,0)');g.fillStyle=gr;g.fillRect(edge?S*.93:0,0,S*.07,S)}
  _grain(c,14,0,8);return c}
const grassT=_tex(buildGrassCanvas(512),THREE.RepeatWrapping,THREE.RepeatWrapping,1,30);
const soilT=_tex((()=>{const c=_mkCanvas(128,16),g=c.getContext('2d');g.fillStyle='#6e5a42';g.fillRect(0,0,128,16);for(let i=0;i<120;i++){g.fillStyle='rgba('+(Math.random()<.5?'30,22,12':'170,150,120')+','+_R(.1,.35)+')';g.fillRect(_R(0,128),_R(0,16),_R(1,3),_R(1,3))}g.fillStyle='rgba(60,95,35,.55)';g.fillRect(0,0,128,3);return c})(),THREE.RepeatWrapping,THREE.ClampToEdgeWrapping,30,1);
const medM=[new THREE.MeshLambertMaterial({map:grassT}),new THREE.MeshLambertMaterial({map:soilT})];
// low shrubs on the island: leaf texture + per-vertex colour tint
function buildLeafCanvas(){const S=128,c=_mkCanvas(S,S),g=c.getContext('2d');g.fillStyle='#2a4c1f';g.fillRect(0,0,S,S);
  const pal=['#3d6a2a','#4c7f32','#5f9440','#2d5420','#74a64a','#86ab55'];
  for(let i=0;i<900;i++){const x=_R(0,S),y=_R(0,S),a=_R(0,6.28),l=_R(4,9),w=_R(1.6,3.2);g.save();g.translate(x,y);g.rotate(a);g.fillStyle=pal[Math.floor(Math.random()*pal.length)];g.globalAlpha=_R(.6,1);g.beginPath();g.ellipse(0,0,l,w,0,0,7);g.fill();g.restore()}
  g.globalAlpha=1;for(let i=0;i<40;i++){g.fillStyle='rgba(15,35,10,'+_R(.25,.5)+')';g.beginPath();g.arc(_R(0,S),_R(0,S),_R(2,5),0,7);g.fill()}
  for(let i=0;i<22;i++){g.fillStyle=Math.random()<.5?'#f4e9ee':'#f08aa8';g.beginPath();g.arc(_R(0,S),_R(0,S),_R(1.2,2.2),0,7);g.fill()}
  return c}
const leafT=_tex(buildLeafCanvas(),THREE.RepeatWrapping,THREE.RepeatWrapping);
const bushM=new THREE.MeshLambertMaterial({map:leafT,vertexColors:true});

// ---------- sea wall: concrete panels every 2 m with an expansion joint, a recessed band and salt staining ----------
function buildWallCanvas(){const W=512,H=256,c=_mkCanvas(W,H),g=c.getContext('2d');
  g.fillStyle='#cbc4b3';g.fillRect(0,0,W,H);
  for(let i=0;i<12;i++){const x=_R(0,W),y=_R(0,H),r=_R(40,130),gr=g.createRadialGradient(x,y,0,x,y,r);gr.addColorStop(0,'rgba(90,80,60,'+_R(.05,.14)+')');gr.addColorStop(1,'rgba(90,80,60,0)');g.fillStyle=gr;g.fillRect(x-r,y-r,r*2,r*2)}
  g.fillStyle='rgba(235,232,222,.5)';g.fillRect(0,0,W,H*.14);g.fillStyle='rgba(60,50,38,.4)';g.fillRect(0,H*.14,W,2);
  g.fillStyle='rgba(40,34,26,.5)';g.fillRect(0,H*.58,W,5);g.fillStyle='rgba(255,255,255,.22)';g.fillRect(0,H*.58+5,W,2);
  for(let i=0;i<60;i++){const x=_R(0,W),w=_R(1,3),len=_R(.15,.6)*H,y=_R(0,H*.4),gr=g.createLinearGradient(0,y,0,y+len);gr.addColorStop(0,'rgba(70,58,40,.1)');gr.addColorStop(1,'rgba(70,58,40,0)');g.fillStyle=gr;g.fillRect(x,y,w,len)}
  const gr=g.createLinearGradient(0,H*.6,0,H);gr.addColorStop(0,'rgba(80,100,72,0)');gr.addColorStop(1,'rgba(70,88,60,.38)');g.fillStyle=gr;g.fillRect(0,H*.6,W,H*.4);
  for(let i=0;i<50;i++){g.fillStyle='rgba(235,235,225,'+_R(.15,.35)+')';g.fillRect(_R(0,W),_R(H*.55,H),_R(4,18),_R(1,3))}
  g.fillStyle='rgba(15,12,8,.75)';g.fillRect(0,0,4,H);g.fillStyle='rgba(255,255,255,.12)';g.fillRect(4,0,1,H);
  _grain(c,22,12,12);return c}
const wallSideT=_tex(buildWallCanvas(),THREE.RepeatWrapping,THREE.ClampToEdgeWrapping,30,1);
const wallTopT=_tex(buildConcreteCanvas(128,256,[205,199,187],true,false),THREE.RepeatWrapping,THREE.RepeatWrapping,1,60);
const wallM=[new THREE.MeshPhongMaterial({map:wallTopT,bumpMap:wallTopT,bumpScale:.003,specular:0x101010,shininess:5}),new THREE.MeshPhongMaterial({map:wallSideT,bumpMap:wallSideT,bumpScale:.005,specular:0x101010,shininess:5})];
// raised granite lip along the sidewalk edge
const lipT=_tex(buildConcreteCanvas(64,256,[150,148,142],true,false),THREE.RepeatWrapping,THREE.RepeatWrapping,1,60);
const lipM=new THREE.MeshPhongMaterial({map:lipT,bumpMap:lipT,bumpScale:.003,specular:0x222222,shininess:12});
const rockM=new THREE.MeshLambertMaterial({color:0x8c8a84}),poleM=new THREE.MeshLambertMaterial({color:0x8a9099});
const foamT=(()=>{const W=128,Hh=256,c=document.createElement('canvas');c.width=W;c.height=Hh;const g=c.getContext('2d'),im=g.createImageData(W,Hh),n1=mkWrapNoise(6,10),n2=mkWrapNoise(24,40);
for(let y=0;y<Hh;y++)for(let x=0;x<W;x++){const u=x/W,v=y/Hh,o=(y*W+x)*4,sh=Math.pow(1-u,1.6),ph=u*9+n1(u,v)*2.2,ln=Math.pow(Math.max(0,Math.sin(ph*6.283)),5)*Math.pow(1-u,1.1)*(.35+.9*n2(u,v)),fm=Math.min(1,ln+Math.pow(1-u,9)*1.2*(.6+n2(u,v)));
im.data[o]=70+fm*185;im.data[o+1]=185+fm*70;im.data[o+2]=185+fm*70;im.data[o+3]=Math.min(255,(sh*.62+fm*.9)*255)}
g.putImageData(im,0,0);const t=new THREE.CanvasTexture(c);t.anisotropy=ANISO;return t})();

const foamM=new THREE.MeshBasicMaterial({map:foamT,transparent:true,depthWrite:false});
const ROAD_CURVE_SEGMENTS=60; // one subdivision per metre keeps road edges and markings smooth through bends
function makeTrimmedBox(w,h,len){
  const g=new THREE.BoxGeometry(w,h,len,1,1,ROAD_CURVE_SEGMENTS),ix=g.index.array,G=g.groups; // groups: px,nx,py,ny,pz,nz
  const sl=i=>ix.slice(G[i].start,G[i].start+G[i].count),top=sl(2),px=sl(0),nx=sl(1);
  const out=new ix.constructor(top.length+px.length+nx.length);out.set(top,0);out.set(px,top.length);out.set(nx,top.length+px.length);
  g.setIndex(new THREE.BufferAttribute(out,1));g.clearGroups();
  g.addGroup(0,top.length,0);g.addGroup(top.length,px.length+nx.length,1);
  return g}
function makeSidewalkGeo(){return makeTrimmedBox(5,.3,L)}
const gRoad=new THREE.PlaneGeometry(18.33,L,2,ROAD_CURVE_SEGMENTS),gSW=makeSidewalkGeo(),gWall=makeTrimmedBox(.6,1.1,L),gFoam=new THREE.PlaneGeometry(9,L,2,ROAD_CURVE_SEGMENTS),gCurb=makeTrimmedBox(2,.3,L),gMed=makeTrimmedBox(1.5,.08,L),gRock=new THREE.DodecahedronGeometry(1,0);

// buildings
const nightWinMats=[];
const wallC=['#e9dfc8','#dccdae','#f1ece1','#d3d9de','#cbb99c','#e6d2c3','#efe3d0'],BT=[];
const litPal=['#ffd88a','#ffc36a','#fff0c4','#ffb86b','#cfe2ff'],awnPal=[['#b3322c','#f2f2f2'],['#1f6b8c','#f2f2f2'],['#2f7d4a','#f2f2f2'],['#c98a1b','#f7f1e1'],['#6d3a8c','#f2f2f2']];
// Facade painter: one layout drives both the daylight texture and the night emissive (lit windows) texture.
function makeFacade(nx,ny,style,col){
  const CW=32,W=nx*CW,H=ny*CW,cells=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const gnd=y===ny-1;cells.push({X:x*CW,Y:y*CW,gnd,lit:Math.random()<.5,pal:pick(litPal),curt:Math.random()<.35,bal:style===1&&!gnd&&Math.random()<.45,ac:!gnd&&Math.random()<.12,shut:style===0&&Math.random()<.55,shutC:pick(['#6b8e6b','#8a6a4a','#5d7391']),awn:pick(awnPal),shopLit:Math.random()<.75})}
  const K=2,day=cv(W*K,H*K,g=>{g.scale(K,K);
    g.fillStyle=col;g.fillRect(0,0,W,H);
    for(let i=0;i<nx*2;i++){g.fillStyle='rgba(0,0,0,'+rnd(0,.035)+')';g.fillRect(rnd(0,W),0,rnd(4,18),H)}
    for(let y=1;y<=ny;y++){const Y=y*CW;g.fillStyle='rgba(0,0,0,.13)';g.fillRect(0,Y-3,W,2);g.fillStyle='rgba(255,255,255,.2)';g.fillRect(0,Y-1,W,1)}
    if(style===0)for(let x=0;x<=nx;x++){g.fillStyle='rgba(255,255,255,.17)';g.fillRect(x*CW-2,0,4,H-CW);g.fillStyle='rgba(0,0,0,.09)';g.fillRect(x*CW+2,0,1.5,H-CW)}
    for(const c of cells){const X=c.X,Y=c.Y;
      if(c.gnd){ // shop front: dark glass, awning stripes, door frame
        g.fillStyle='#202d36';g.fillRect(X+3,Y+11,26,21);
        const rg=g.createLinearGradient(X+3,Y+11,X+29,Y+32);rg.addColorStop(0,'rgba(190,215,235,.38)');rg.addColorStop(.5,'rgba(190,215,235,.05)');rg.addColorStop(1,'rgba(190,215,235,.15)');g.fillStyle=rg;g.fillRect(X+3,Y+11,26,21);
        g.fillStyle='#2c3034';g.fillRect(X+15,Y+11,2,21);g.fillRect(X+3,Y+11,26,1.5);
        for(let k=0;k<7;k++){g.fillStyle=k%2?c.awn[1]:c.awn[0];g.fillRect(X+3+k*3.7,Y+4,3.7,8)}
        g.fillStyle='rgba(0,0,0,.25)';g.fillRect(X+3,Y+12,26,2);
      }else if(style===2){ // ribbon windows with spandrel
        g.fillStyle='rgba(60,70,80,.16)';g.fillRect(X,Y+2,CW,6);g.fillRect(X,Y+24,CW,6);
        const gl=g.createLinearGradient(0,Y+8,0,Y+24);gl.addColorStop(0,'#7da0bb');gl.addColorStop(1,'#2b4256');g.fillStyle=gl;g.fillRect(X,Y+8,CW,16);
        g.fillStyle='rgba(255,255,255,.16)';g.beginPath();g.moveTo(X+4,Y+24);g.lineTo(X+14,Y+8);g.lineTo(X+22,Y+8);g.lineTo(X+12,Y+24);g.fill();
        g.fillStyle='#d9d6cc';g.fillRect(X,Y+8,1.5,16);g.fillRect(X,Y+7,CW,1.5);g.fillRect(X,Y+23.5,CW,1.5);
      }else{ // punched window: frame, glass, mullions, sill, optional shutters/balcony/AC
        g.fillStyle='rgba(0,0,0,.16)';g.fillRect(X+5,Y+5,22,3);
        g.fillStyle='#f1eee6';g.fillRect(X+5,Y+6,22,22);
        const gl=g.createLinearGradient(0,Y+8,0,Y+26);gl.addColorStop(0,'#6b8aa3');gl.addColorStop(1,'#2a3f52');g.fillStyle=gl;g.fillRect(X+7,Y+8,18,18);
        g.fillStyle='rgba(255,255,255,.18)';g.beginPath();g.moveTo(X+7,Y+22);g.lineTo(X+17,Y+8);g.lineTo(X+22,Y+8);g.lineTo(X+7,Y+26);g.fill();
        g.fillStyle='#f1eee6';g.fillRect(X+15,Y+8,2,18);g.fillRect(X+7,Y+16,18,1.6);
        g.fillStyle='#d8d4c8';g.fillRect(X+3,Y+27,26,3);g.fillStyle='rgba(0,0,0,.2)';g.fillRect(X+3,Y+30,26,1.5);
        if(c.shut){g.fillStyle=c.shutC;g.fillRect(X+1,Y+6,4,22);g.fillRect(X+27,Y+6,4,22);g.fillStyle='rgba(0,0,0,.22)';for(let k=0;k<7;k++){g.fillRect(X+1,Y+8+k*3,4,1);g.fillRect(X+27,Y+8+k*3,4,1)}}
        if(c.bal){g.fillStyle='#cdc8bc';g.fillRect(X+1,Y+28,30,4);g.fillStyle='rgba(0,0,0,.22)';g.fillRect(X+1,Y+32-1,30,1);g.fillStyle='rgba(40,42,48,.85)';for(let k=0;k<10;k++)g.fillRect(X+2+k*3,Y+20,1,8);g.fillRect(X+1,Y+19.5,30,1.5)}
        if(c.ac){g.fillStyle='#d9dbdc';g.fillRect(X+23,Y+19,8,6);g.fillStyle='rgba(0,0,0,.4)';for(let k=0;k<3;k++)g.fillRect(X+24,Y+20+k*1.7,6,.8)}
        if(Math.random()<.5){g.fillStyle='rgba(50,40,30,.13)';const gr=g.createLinearGradient(0,Y+30,0,Y+CW+14);gr.addColorStop(0,'rgba(50,40,30,.2)');gr.addColorStop(1,'rgba(50,40,30,0)');g.fillStyle=gr;g.fillRect(X+5,Y+30,3,16)} // rain streak
      }}
    for(const c of cells){if(c.gnd)continue;const X=c.X,Y=c.Y;
 if(style!==2){g.fillStyle='rgba(0,0,0,.3)';g.fillRect(X+7,Y+8,18,2.4);g.fillRect(X+7,Y+8,1.8,18);
  const bl=Math.random();if(bl>.55){const hh=Math.min(15,(bl-.45)*26);g.fillStyle='rgba(238,230,208,.93)';g.fillRect(X+7,Y+10,18,hh);g.fillStyle='rgba(0,0,0,.14)';for(let k=0;k<hh;k+=2)g.fillRect(X+7,Y+10+k,18,.5)}
  if(Math.random()<.07){g.fillStyle='#d9d9d9';g.beginPath();g.ellipse(X+27,Y+22,3.3,2.5,.5,0,7);g.fill();g.fillStyle='#6a6a6a';g.fillRect(X+26.5,Y+22,1,4)}}
 else{g.fillStyle='rgba(255,255,255,.1)';g.fillRect(X,Y+9,CW,1.5)}}
for(const px of [3,W-5]){g.fillStyle='rgba(70,70,66,.5)';g.fillRect(px,0,1.8,H-CW);g.fillStyle='rgba(255,255,255,.15)';g.fillRect(px+1.8,0,.6,H-CW)}
let gg=g.createLinearGradient(0,H-CW*1.7,0,H);gg.addColorStop(0,'rgba(60,50,40,0)');gg.addColorStop(1,'rgba(60,50,40,.24)');g.fillStyle=gg;g.fillRect(0,H-CW*1.7,W,CW*1.7);
    gg=g.createLinearGradient(0,0,0,CW*.9);gg.addColorStop(0,'rgba(40,35,30,.2)');gg.addColorStop(1,'rgba(40,35,30,0)');g.fillStyle=gg;g.fillRect(0,0,W,CW*.9);
    for(let i=0;i<W*H/180;i++){g.fillStyle=Math.random()<.5?'rgba(255,255,255,.05)':'rgba(0,0,0,.06)';g.fillRect(rnd(0,W),rnd(0,H),rnd(1,2.2),rnd(1,2.2))}
  });
  const em=cv(W*K,H*K,g=>{g.scale(K,K);g.fillStyle='#000';g.fillRect(0,0,W,H);
    for(const c of cells){const X=c.X,Y=c.Y;
      if(c.gnd){if(c.shopLit){g.fillStyle=c.pal;g.globalAlpha=.9;g.fillRect(X+3,Y+11,26,21);g.globalAlpha=1;g.fillStyle='#000';g.fillRect(X+15,Y+11,2,21)}g.globalAlpha=.55;g.fillStyle=c.awn[0];g.fillRect(X+3,Y+4,26,8);g.globalAlpha=1}
      else if(c.lit){g.globalAlpha=rnd(.6,1);g.fillStyle=c.pal;
        if(style===2){g.fillRect(X+1,Y+9,CW-2,14)}else{g.fillRect(X+7,Y+8,18,18);g.globalAlpha=1;if(c.curt){g.fillStyle='rgba(0,0,0,.5)';g.fillRect(X+7,Y+8,9,18)}g.fillStyle='#000';g.fillRect(X+15,Y+8,2,18);g.fillRect(X+7,Y+16,18,1.6)}
        g.globalAlpha=1}}
  });
  const sp=cv(W,H,g=>{g.fillStyle='#161616';g.fillRect(0,0,W,H);g.fillStyle='#fff';for(const c of cells){if(c.gnd)g.fillRect(c.X+3,c.Y+11,26,21);else if(style===2)g.fillRect(c.X,c.Y+8,CW,16);else g.fillRect(c.X+7,c.Y+8,18,18)}});
  return{day,em,sp}}
const envDay=new THREE.CanvasTexture(skyT.image,THREE.EquirectangularReflectionMapping);
const sideT=cv(128,256,(g,w,h)=>{g.fillStyle='#e6e2d8';g.fillRect(0,0,w,h);for(let i=0;i<40;i++){const x=rnd(0,w),gr=g.createLinearGradient(0,0,0,h);gr.addColorStop(0,'rgba(60,50,40,0)');gr.addColorStop(1,'rgba(60,50,40,'+rnd(.04,.13)+')');g.fillStyle=gr;g.fillRect(x,0,rnd(2,9),h*rnd(.4,1))}
 for(let i=0;i<10;i++){g.fillStyle='rgba(0,0,0,.07)';g.fillRect(0,i*h/10,w,2)}for(let i=0;i<1400;i++){g.fillStyle=Math.random()<.5?'rgba(255,255,255,.07)':'rgba(0,0,0,.08)';g.fillRect(rnd(0,w),rnd(0,h),rnd(1,3),rnd(1,3))}});
const bldDetailM=new THREE.MeshLambertMaterial({color:0xaaa597});
// merge indexed geometries into one (body first, so its 36 indices keep their positions)
function mergeGeos(list){let vc=0,ic=0;for(const g of list){vc+=g.attributes.position.count;ic+=g.index.count}
  const pos=new Float32Array(vc*3),nor=new Float32Array(vc*3),uv=new Float32Array(vc*2),idx=new Uint16Array(ic);let vo=0,io=0;
  for(const g of list){pos.set(g.attributes.position.array,vo*3);nor.set(g.attributes.normal.array,vo*3);uv.set(g.attributes.uv.array,vo*2);for(let i=0;i<g.index.count;i++)idx[io+i]=g.index.array[i]+vo;vo+=g.attributes.position.count;io+=g.index.count}
  const m=new THREE.BufferGeometry();m.setAttribute('position',new THREE.BufferAttribute(pos,3));m.setAttribute('normal',new THREE.BufferAttribute(nor,3));m.setAttribute('uv',new THREE.BufferAttribute(uv,2));m.setIndex(new THREE.BufferAttribute(idx,1));return m}
for(let i=0;i<10;i++){const nx=pick([4,5,6]),ny=pick([9,12,15,18]),col=pick(wallC),style=i%3,s=nx*3.2,H=ny*3.2;
  const f=makeFacade(nx,ny,style,col);
  const m=new THREE.MeshPhongMaterial({map:f.day,specularMap:f.sp,specular:0x777777,shininess:70,envMap:envDay,combine:THREE.AddOperation,reflectivity:.5,emissive:0xffffff,emissiveMap:f.em,emissiveIntensity:0}),sd=new THREE.MeshLambertMaterial({map:sideT,color:col});nightWinMats.push(m);
  m.userData.facade={nx,ny,style}; // window grid, used by js/city-plus.js (interior rooms behind the windows)
  const roof=new THREE.MeshLambertMaterial({color:pick([0xa59f92,0x948e82,0xb0a898])});
  const body=new THREE.BoxGeometry(s,H,s),parts=[body],T=H/2,bx=(w,h,dd,x,y,z)=>new THREE.BoxGeometry(w,h,dd).translate(x,y,z);
  // cornice, plinth, corner pilasters, and real balcony slabs + glass railings
  parts.push(bx(s+.7,.5,s+.7,0,T-.25,0),bx(s+.2,.35,s+.2,0,-T+.175,0));for(const sx of [-1,1])for(const sz of [-1,1])parts.push(bx(.55,H,.55,sx*s/2,0,sz*s/2));
  if(style===1)for(let k=1;k<ny;k++){const y=T-k*3.2+.12;parts.push(bx(1.2,.14,s*.86,s/2+.6,y,0),bx(.05,.95,s*.86,s/2+1.15,y+.5,0))}
  // roof parapet, stair/lift housing, water tank on a stand, roof AC units, antenna
  parts.push(bx(s,.6,.3,0,T+.3,s/2-.15),bx(s,.6,.3,0,T+.3,-s/2+.15),bx(.3,.6,s-.6,s/2-.15,T+.3,0),bx(.3,.6,s-.6,-s/2+.15,T+.3,0));
  const hx=rnd(-s*.22,s*.22),hz=rnd(-s*.22,s*.22);parts.push(bx(s*.28,2.4,s*.28,hx,T+1.2,hz));
  if(Math.random()<.7){const tx=-hx*1.2,tz=-hz*1.2;parts.push(bx(1.5,.8,1.5,tx,T+.4,tz),new THREE.CylinderGeometry(.9,.9,1.6,8).translate(tx,T+1.6,tz))}
  for(let k=0;k<2;k++)parts.push(bx(1.3,.8,.9,rnd(-s*.3,s*.3),T+.4,rnd(-s*.3,s*.3)));
  parts.push(bx(.1,3.5,.1,rnd(-s*.3,s*.3),T+1.75,rnd(-s*.3,s*.3)));
  const geo=mergeGeos(parts);
  // draw the 4 walls as two groups (px+nx, pz+nz), the roof face, skip the unseen underside, then all roof details
  // perf: the roof face (+y) and underside of the body can never be seen from the street, so drop them and draw the 4 walls as ONE group
  // windows on the road face AND both side faces (+x, +z, -z; the sides are seen at an angle while driving); only the back (-x) is a plain wall
  {const ix=geo.index.array,nIx=new Uint16Array(ix.length-12);nIx.set(ix.subarray(0,6),0);nIx.set(ix.subarray(24,36),6);nIx.set(ix.subarray(6,12),18);nIx.set(ix.subarray(36),24);
   geo.setIndex(new THREE.BufferAttribute(nIx,1));geo.clearGroups();geo.addGroup(0,18,0);geo.addGroup(18,6,1);geo.addGroup(24,nIx.length-24,2)}
  BT.push({w:s,h:H,mats:[m,sd,bldDetailM],geo})}
// perf: every building of every segment is drawn as an instance of ONE InstancedMesh per building type
// (was: 6 meshes x 3 material groups = 18 draw calls per segment). Instances are rebuilt per render pass,
// limited to visible segments and to the camera frustum.
const BLD_CAP=N*6,bldInst=BT.map(b=>{b.r=Math.hypot(b.w,b.h)*.5+6;const im=new THREE.InstancedMesh(b.geo,b.mats,BLD_CAP);im.count=0;im.frustumCulled=false;im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);scene.add(im);return im});
const _bM=new THREE.Matrix4(),_bPV=new THREE.Matrix4(),_bFr=new THREE.Frustum(),_bS=new THREE.Sphere(),_bCnt=new Array(BT.length).fill(0);
function syncBuildings(cam){
  cam.updateWorldMatrix(true,false);
  _bPV.multiplyMatrices(cam.projectionMatrix,_bM.copy(cam.matrixWorld).invert());_bFr.setFromProjectionMatrix(_bPV);
  _bCnt.fill(0);
  for(const s of segs){if(!s.g.visible)continue;const gm=s.g.matrix;
    for(const o of s.blds){_bM.multiplyMatrices(gm,o.m);const e=_bM.elements;_bS.center.set(e[12],e[13],e[14]);_bS.radius=BT[o.t].r;
      if(!_bFr.intersectsSphere(_bS))continue;_bM.toArray(bldInst[o.t].instanceMatrix.array,_bCnt[o.t]++*16)}}
  for(let t=0;t<bldInst.length;t++){const im=bldInst[t];im.count=_bCnt[t];im.visible=_bCnt[t]>0;im.instanceMatrix.needsUpdate=true}
}

// palms & lamps
for(const _m of [swM[0],swLM[0],curbM[0],curbM[1],medM[0]])patchRoadLamp(_m,false,.65,0);
for(const _m of [swM[0],swLM[0],curbM[0],curbM[1]])patchWet(_m,WET_WALK);
const trunkG=new THREE.CylinderGeometry(.16,.3,7,6).translate(0,3.5,0),trunkM=new THREE.MeshLambertMaterial({color:0x8a7457});
const crownM=new THREE.MeshLambertMaterial({color:0x3f7a35,side:THREE.DoubleSide});
function crownGeo(){const p=[];for(let k=0;k<9;k++){const a=k*Math.PI*2/9+rnd(-.1,.1),c=Math.cos(a),s=Math.sin(a),len=rnd(2.8,3.6),mx=c*len*.5,mz=s*len*.5;
const A=[c*.2,0,s*.2],Lf=[mx-s*.6,.35,mz+c*.6],R=[mx+s*.6,.35,mz-c*.6],T=[c*len,-1.1,s*len];p.push(...A,...Lf,...T,...A,...T,...R)}
const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.computeVertexNormals();return g}
const crowns=[crownGeo(),crownGeo(),crownGeo()];
const gPole=new THREE.CylinderGeometry(.07,.1,9.5,6).translate(0,4.75,0),gArm=new THREE.BoxGeometry(4.4,.12,.12).translate(0,9.4,0);

// street-lamp heads + light pools (visible only in night mode)
const lampM=new THREE.MeshBasicMaterial({color:0xffe2a8,fog:false});lampM.visible=false;
const poolT=cv(128,128,(g,w,h)=>{const gr=g.createRadialGradient(64,64,0,64,64,64);gr.addColorStop(0,'rgba(255,205,130,.95)');gr.addColorStop(.35,'rgba(255,190,110,.45)');gr.addColorStop(1,'rgba(255,170,90,0)');g.fillStyle=gr;g.fillRect(0,0,w,h)});
const poolM=new THREE.MeshBasicMaterial({map:poolT,transparent:true,opacity:.3,blending:THREE.AdditiveBlending,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});poolM.visible=false;poolM.opacity=.06;
const gLamp=new THREE.BoxGeometry(1,.2,.4),gPool=new THREE.PlaneGeometry(22,22).rotateX(-Math.PI/2);
// billboards
const bbG=mergeGeos([new THREE.PlaneGeometry(10,4.4).translate(0,0,.29),new THREE.PlaneGeometry(10,4.4).rotateY(Math.PI).translate(0,0,-.29)]);
// perf: static props are merged once into shared geometries (1 draw call each per segment instead of 4-9)

function mergeC(list){let vc=0,ic=0;for(const[g]of list){vc+=g.attributes.position.count;ic+=g.index.count}
 const pos=new Float32Array(vc*3),nor=new Float32Array(vc*3),col=new Float32Array(vc*3),idx=new Uint16Array(ic);let vo=0,io=0;
 for(const[g,c]of list){const n=g.attributes.position.count;pos.set(g.attributes.position.array,vo*3);nor.set(g.attributes.normal.array,vo*3);for(let q=0;q<n;q++)col.set(c,(vo+q)*3);for(let q=0;q<g.index.count;q++)idx[io+q]=g.index.array[q]+vo;vo+=n;io+=g.index.count}
 const m=new THREE.BufferGeometry();m.setAttribute('position',new THREE.BufferAttribute(pos,3));m.setAttribute('normal',new THREE.BufferAttribute(nor,3));m.setAttribute('color',new THREE.BufferAttribute(col,3));m.setIndex(new THREE.BufferAttribute(idx,1));return m}
const lampPoleM=new THREE.MeshPhongMaterial({vertexColors:true,specular:0x444444,shininess:40});
const glowT=cv(64,32,(g,w,h)=>{g.translate(32,16);g.scale(1,.5);const r=g.createRadialGradient(0,0,0,0,0,32);r.addColorStop(0,'rgba(255,244,214,1)');r.addColorStop(.55,'rgba(255,214,140,.85)');r.addColorStop(.85,'rgba(255,175,85,.3)');r.addColorStop(1,'rgba(255,150,60,0)');g.fillStyle=r;g.fillRect(-32,-32,64,64)});
const glowM=new THREE.MeshBasicMaterial({map:glowT,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false});glowM.visible=false;
const TLAMP={g:new THREE.BoxGeometry(.3,.12,.07),h:new THREE.MeshBasicMaterial({color:0xfff6dc,fog:true}),t:new THREE.MeshBasicMaterial({color:0xff2a1a,fog:true}),
 gh:new THREE.SpriteMaterial({map:glowT,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}),
 gt:new THREE.SpriteMaterial({map:glowT,color:0xff3322,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false})};
TLAMP.gh.visible=TLAMP.gt.visible=false;

const _lp=[],_ll=[],_lg=[],_poolList=[];
for(const z of [-10,-40]){const Y=.3,A=(g,c,x,y,zo)=>{g.translate(x,y,z+(zo||0));_lp.push([g,c])};
 A(new THREE.CylinderGeometry(.27,.3,.12,8),[.3,.32,.34],0,Y+.06);
 A(new THREE.CylinderGeometry(.2,.26,.95,8),[.27,.3,.31],0,Y+.6);
 A(new THREE.CylinderGeometry(.08,.14,8.6,8),[.62,.65,.68],0,Y+5.3);
 A(new THREE.BoxGeometry(.22,.5,.05),[.15,.16,.17],0,Y+1.6,.14);
 A(new THREE.CylinderGeometry(.12,.1,.3,8),[.3,.32,.34],0,Y+9.55);
 for(const sg of [-1,1]){
  const cu=new THREE.CatmullRomCurve3([new THREE.Vector3(0,Y+9.6,0),new THREE.Vector3(sg*.35,Y+10.15,0),new THREE.Vector3(sg*1.2,Y+10.55,0),new THREE.Vector3(sg*1.9,Y+10.35,0)]);
  A(new THREE.TubeGeometry(cu,10,.05,5,false),[.45,.48,.5],0,0);
  A(new THREE.SphereGeometry(1,10,6).scale(.7,.13,.27),[.5,.52,.55],sg*2.15,Y+10.25);
  _ll.push(new THREE.SphereGeometry(1,20,8,0,Math.PI*2,Math.PI/2,Math.PI/2).scale(.71,.135,.275).translate(sg*2.15,Y+10.25,z));
  _lg.push(new THREE.PlaneGeometry(1.5,.6).rotateX(Math.PI/2).translate(sg*2.15,Y+10.105,z));
  _poolList.push(gPool.clone().translate(sg*3.5,.06,z))}}
const gPolesMerged=mergeC(_lp),gLampsMerged=mergeGeos(_ll),gGlowMerged=mergeGeos(_lg),gPoolsMerged=mergeGeos(_poolList);
// Lamp light pools are split by zone so each follows its own road level: ground (median + opposite side), deck (x 1..12, lifted) and trench lanes (x 12..19.4, sunk).
function clipPools(lo,hi){const P=gPoolsMerged.attributes.position.array,list=[];
  for(let q=0;q<P.length/12;q++){let mnx=1e9,mxx=-1e9,mnz=1e9,mxz=-1e9,y=0;
    for(let k=0;k<4;k++){const o=q*12+k*3;mnx=Math.min(mnx,P[o]);mxx=Math.max(mxx,P[o]);mnz=Math.min(mnz,P[o+2]);mxz=Math.max(mxz,P[o+2]);y=P[o+1]}
    const x0=Math.max(mnx,lo),x1=Math.min(mxx,hi);if(x1-x0<.1)continue;
    const g=new THREE.PlaneGeometry(1,1,1,1),p=g.attributes.position,u=g.attributes.uv,w=mxx-mnx;
    for(let i=0;i<4;i++){const ix=i%2,iy=i>>1,x=ix?x1:x0;p.setXYZ(i,x,y,iy?mxz:mnz);u.setXY(i,(x-mnx)/w,iy?0:1)}
    list.push(g)}
  return mergeGeos(list)}
const gPoolsDeck=clipPools(BR_X0,BR_SPLIT),gPoolsLow=clipPools(BR_SPLIT,19.4),gPoolsGround=clipPools(-1e9,BR_X0);
const steelM=new THREE.MeshPhongMaterial({color:0x6c737b,specular:0x333333,shininess:30}),B=(w,h,d,x,y,z)=>new THREE.BoxGeometry(w,h,d).translate(x,y,z);
const gBPsMerged=mergeGeos([B(10.5,4.9,.5,0,8.6,0),B(.34,8.2,.3,-3.6,4.1,-.1),B(.34,8.2,.3,3.6,4.1,-.1),B(.9,.12,.9,-3.6,.06,-.1),B(.9,.12,.9,3.6,.06,-.1),
 B(10.6,.08,1,0,5.95,.45),B(10.6,.05,.05,0,6.95,.9),B(10.6,.05,.05,0,6.5,.9),B(.05,1,.05,-5.2,6.45,.9),B(.05,1,.05,5.2,6.45,.9),
 ...[-4,0,4].flatMap(x=>[B(.06,.06,1.1,x,11.12,.7),B(.45,.2,.3,x,11,1.3)])]);

function mergeRockSet(){
  const m4=new THREE.Matrix4(),q=new THREE.Quaternion(),e=new THREE.Euler(),pv=new THREE.Vector3(),sv=new THREE.Vector3(),P=[],N=[];
  for(let i=0;i<9;i++){const sc=rnd(.7,1.6);pv.set(rnd(25.3,29.3),.3,-rnd(0,L));e.set(0,rnd(0,6),0);q.setFromEuler(e);sv.set(sc,sc*.6,sc);m4.compose(pv,q,sv);
    const g=gRock.clone();g.applyMatrix4(m4);P.push(g.attributes.position.array);N.push(g.attributes.normal.array)}
  const n=P.reduce((a,b)=>a+b.length,0),pos=new Float32Array(n),nor=new Float32Array(n);let o=0;
  for(let i=0;i<P.length;i++){pos.set(P[i],o);nor.set(N[i],o);o+=P[i].length}
  const mg=new THREE.BufferGeometry();mg.setAttribute('position',new THREE.BufferAttribute(pos,3));mg.setAttribute('normal',new THREE.BufferAttribute(nor,3));return mg}
const ROCK_SETS=[];for(let i=0;i<8;i++)ROCK_SETS.push(mergeRockSet());
const AD=[['#0a3d91','#1e90ff','إنترنت فائق السرعة','اشترك الآن واحصل على شهرين مجاناً','wifi','اتصل 19999'],
['#b3122f','#ff7a3d','تخفيضات الصيف حتى ٥٠٪','على جميع الملابس والأحذية','sale','في المعرض وأونلاين'],
['#06503b','#35c79a','شقتك على البحر مباشرة','تقسيط حتى ١٠ سنوات','home','اتصل 16777'],
['#ff7a00','#ffd21f','عصير برتقال طبيعي ١٠٠٪','انتعاش حقيقي في كل رشفة','juice','بدون سكر مضاف'],
['#161a24','#566074','السيارة الجديدة كلياً','قوة وأناقة وأمان لكل رحلة','car','احجز تجربة قيادة']];
const bbM=AD.map(([a,b,h,sb,k,cta])=>{const t=cv(1024,451,(g,w,hh)=>{
 let gr=g.createLinearGradient(0,0,w,hh);gr.addColorStop(0,a);gr.addColorStop(1,b);g.fillStyle=gr;g.fillRect(0,0,w,hh);
 gr=g.createRadialGradient(260,200,10,260,200,330);gr.addColorStop(0,'rgba(255,255,255,.35)');gr.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=gr;g.fillRect(0,0,w,hh);
 g.save();g.translate(250,225);g.strokeStyle='#fff';g.fillStyle='#fff';g.lineWidth=14;g.lineCap='round';g.textAlign='center';g.textBaseline='middle';
 if(k==='wifi'){for(let r=50;r<=170;r+=40){g.globalAlpha=1-r/260;g.beginPath();g.arc(0,70,r,-2.35,-.79);g.stroke()}g.globalAlpha=1;g.beginPath();g.arc(0,70,16,0,7);g.fill()}
 else if(k==='sale'){g.fillStyle='#ffd21f';g.beginPath();for(let i=0;i<32;i++){const r=i%2?120:155,q=i*Math.PI/16;g.lineTo(Math.cos(q)*r,Math.sin(q)*r)}g.fill();g.fillStyle=a;g.font='bold 110px Tahoma,Arial';g.fillText('٥٠٪',0,6)}
 else if(k==='home'){[[-170,70,150],[-90,80,230],[10,75,190],[95,70,140]].forEach(([x,bw,bh])=>{g.fillStyle='rgba(255,255,255,.93)';g.fillRect(x,120-bh,bw,bh);g.fillStyle='rgba(6,80,59,.55)';for(let y=130-bh;y<110;y+=26)for(let X=x+10;X<x+bw-14;X+=24)g.fillRect(X,y,12,14)});
  g.lineWidth=6;g.strokeStyle='rgba(255,255,255,.9)';for(let r=0;r<3;r++){g.beginPath();for(let X=-180;X<=180;X+=10)g.lineTo(X,142+r*18+Math.sin(X/18+r)*5);g.stroke()}}
 else if(k==='juice'){g.fillStyle='#ffb02e';g.beginPath();g.moveTo(-70,-110);g.lineTo(70,-110);g.lineTo(48,120);g.lineTo(-48,120);g.closePath();g.fill();g.lineWidth=8;g.stroke();
  g.fillStyle='#ff8a00';g.beginPath();g.arc(95,-90,55,0,7);g.fill();g.lineWidth=6;g.stroke();g.lineWidth=4;for(let i=0;i<8;i++){g.beginPath();g.moveTo(95,-90);g.lineTo(95+Math.cos(i*.785)*55,-90+Math.sin(i*.785)*55);g.stroke()}}
 else{g.beginPath();g.moveTo(-185,70);g.quadraticCurveTo(-190,25,-130,15);g.lineTo(-70,-35);g.quadraticCurveTo(-20,-75,50,-60);g.quadraticCurveTo(110,-45,140,15);g.quadraticCurveTo(190,25,190,70);g.closePath();g.fill();
  g.fillStyle='rgba(20,30,50,.8)';g.beginPath();g.moveTo(-55,-22);g.quadraticCurveTo(-15,-52,45,-46);g.lineTo(95,8);g.lineTo(-100,8);g.closePath();g.fill();
  for(const x of [-105,115]){g.fillStyle='#111';g.beginPath();g.arc(x,72,34,0,7);g.fill();g.fillStyle='#bbb';g.beginPath();g.arc(x,72,15,0,7);g.fill()}}
 g.restore();
 g.direction='rtl';g.textAlign='right';g.textBaseline='alphabetic';g.fillStyle='#fff';g.shadowColor='rgba(0,0,0,.35)';g.shadowBlur=10;g.shadowOffsetY=4;
 const wd=h.split(' '),mid=Math.ceil(wd.length/2),ls=[wd.slice(0,mid).join(' '),wd.slice(mid).join(' ')].filter(Boolean);let fs=84;
 do{fs-=2;g.font='bold '+fs+'px Tahoma,Arial'}while(fs>30&&Math.max(...ls.map(l=>g.measureText(l).width))>470);
 ls.forEach((l,n)=>g.fillText(l,990,120+n*fs*1.15));
 g.shadowBlur=0;g.shadowOffsetY=0;g.font='32px Tahoma,Arial';g.globalAlpha=.92;g.fillText(sb,990,150+ls.length*fs*1.1);g.globalAlpha=1;
 g.fillStyle='#fff';g.beginPath();g.arc(560,385,32,Math.PI/2,Math.PI*1.5);g.arc(800,385,32,-Math.PI/2,Math.PI/2);g.closePath();g.fill();
 g.fillStyle=a;g.font='bold 30px Tahoma,Arial';g.textAlign='center';g.fillText(cta,680,396);
 g.fillStyle='rgba(255,255,255,.65)';g.font='15px Tahoma,Arial';g.textAlign='right';g.fillText('تطبق الشروط والأحكام',990,438)});
 return new THREE.MeshLambertMaterial({map:t,emissive:0xffffff,emissiveMap:t,emissiveIntensity:0})});

// cars
const carMats={},mat=c=>carMats[c]||(carMats[c]=new THREE.MeshLambertMaterial({color:c}));
const gBody=new THREE.BoxGeometry(1.9,.8,4.2).translate(0,.7,0),gCab=new THREE.BoxGeometry(1.65,.65,2.2).translate(0,1.4,.2),gVan=new THREE.BoxGeometry(2,1.7,4.9).translate(0,1.25,0),gVanW=new THREE.BoxGeometry(2.04,.5,3.8).translate(0,1.65,0),gUnder=new THREE.BoxGeometry(1.8,.4,4).translate(0,.3,0);
const glass=mat(0x1e2a36),dark=mat(0x111111),carCols=[0x222222,0xa02020,0x2a5aa8,0xdddddd,0xe0b020,0x555555,0x1e7a3a,0xf2f2f2];
function makeCar(){const g=new THREE.Group();
if(Math.random()<.5){g.add(new THREE.Mesh(gVan,mat(Math.random()<.85?0xf2f2f2:0xe0b020)),new THREE.Mesh(gVanW,glass),new THREE.Mesh(gUnder,dark))}
else{g.add(new THREE.Mesh(gBody,mat(pick(carCols))),new THREE.Mesh(gCab,glass),new THREE.Mesh(gUnder,dark))}
return g}
const LANES=[[1,[-2.83,-6.5,-10.17,-13.83,-17.5],[22,25,28,31,34]],[-1,[2.83,6.5,10.17,13.83,17.5],[34,31,28,25,22]]];

// ---- extra road-side geometry: granite lip along both sidewalk edges, low shrubs on the island ----
const gLips=mergeGeos([new THREE.BoxGeometry(.2,.06,L,1,1,ROAD_CURVE_SEGMENTS).translate(19.43,0,0),new THREE.BoxGeometry(.2,.06,L,1,1,ROAD_CURVE_SEGMENTS).translate(-19.43,0,0)]);
function makeBushGeo(){
  const P=[],N=[],U=[],C=[],cols=[[1,1.05,.9],[1.1,1.2,.9],[.95,1.1,1],[1.25,1.25,.9],[1.1,1.1,.8]];
  const hash=(x,y,z)=>{const s=Math.sin(x*127.1+y*311.7+z*74.7)*43758.5453;return s-Math.floor(s)};
  const lampLocal=[20,-10]; // street-lamp poles stand at z=-10/-40 in world => 20/-10 in this part's local frame
  for(let z=-L/2+2.5;z<L/2-1.5;z+=_R(3.6,6.2)){
    if(lampLocal.some(e=>Math.abs(z-e)<1.8))continue;
    const col=cols[Math.floor(Math.random()*cols.length)],n=Math.random()<.45?2:1;
    for(let q=0;q<n;q++){
      const sx=_R(.3,.44),sy=_R(.2,.36),sz=_R(.5,.85),cx=_R(-.18,.18),cz=z+q*_R(.7,1.1),ico=new THREE.IcosahedronGeometry(1,1),pa=ico.attributes.position,na=ico.attributes.normal,ua=ico.attributes.uv;
      for(let i=0;i<pa.count;i++){
        const px=pa.getX(i),py=pa.getY(i),pz=pa.getZ(i),h=hash(Math.round(px*50),Math.round(py*50),Math.round(pz*50)),j=1+(h-.5)*.34;
        P.push(cx+px*sx*j,py*sy*j+sy*.3,cz+pz*sz*j);
        let nx=na.getX(i)/sx,ny=na.getY(i)/sy,nz=na.getZ(i)/sz;const nl=Math.hypot(nx,ny,nz)||1;N.push(nx/nl,ny/nl,nz/nl);
        U.push(ua.getX(i)*3,ua.getY(i)*2);const b=.8+h*.35;C.push(col[0]*b,col[1]*b,col[2]*b)}
      ico.dispose()}}
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(P,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(N,3));
  g.setAttribute('uv',new THREE.Float32BufferAttribute(U,2));g.setAttribute('color',new THREE.Float32BufferAttribute(C,3));return g}
const BUSH_SETS=[];for(let i=0;i<6;i++)BUSH_SETS.push(makeBushGeo());let _bushI=0;
const sandT=(()=>{const W=256,Hh=256,c=document.createElement('canvas');c.width=W;c.height=Hh;const g=c.getContext('2d'),im=g.createImageData(W,Hh),n1=mkWrapNoise(8,16),n2=mkWrapNoise(48,96),n3=mkWrapNoise(128,128),ss=(a,b,x)=>{x=Math.max(0,Math.min(1,(x-a)/(b-a)));return x*x*(3-2*x)};
for(let y=0;y<Hh;y++)for(let x=0;x<W;x++){const u=x/W,v=y/Hh,o=(y*W+x)*4,wet=ss(.34,.47,u),rp=Math.sin((u*70+n1(u,v)*7)*1)*.035,m=n1(u,v)*.12+n2(u,v)*.1+rp+(n3(u,v)-.5)*.14+(Math.random()-.5)*.07,
 dr=[228,208,162],wt=[150,126,90],sp=(u>.4&&u<.44&&Math.random()<.03)?-60:0;
 for(let k=0;k<3;k++)im.data[o+k]=Math.max(0,Math.min(255,(dr[k]+(wt[k]-dr[k])*wet)*(1+m-.1)+sp));im.data[o+3]=255}
g.putImageData(im,0,0);const t=new THREE.CanvasTexture(c);t.anisotropy=ANISO;return t})();
const sandM=new THREE.MeshLambertMaterial({map:sandT});
const gSand=(()=>{const g=new THREE.PlaneGeometry(30,L,6,ROAD_CURVE_SEGMENTS),p=g.attributes.position;for(let i=0;i<p.count;i++){const x=p.getX(i)+15;p.setZ(i,.03-x*.012+Math.sin(x*.9)*.012+Math.sin(p.getY(i)*.35+x)*.01)}g.computeVertexNormals();return g})();
// Road surface in strips that keep the original 18.33 m-per-carriageway texture mapping:
//  opposite carriageway stays on the ground; lanes 4-5 of the player's side sink into a trench ('trench' flag); deck strip = lanes 1-3 (lifted onto the bridge).
function roadStrip(cx,x0,x1){const g=new THREE.PlaneGeometry(x1-x0,L,1,ROAD_CURVE_SEGMENTS),p=g.attributes.position,u=g.attributes.uv,m=(x0+x1)/2-cx;
  for(let i=0;i<p.count;i++)u.setX(i,(p.getX(i)+m+9.165)/18.33);
  return g.rotateX(-Math.PI/2).translate((x0+x1)/2,.02,-L/2)}
const gRoadOpp=mergeGeos([roadStrip(-10.17,-19.335,-1.005)]),gRoadLow=mergeGeos([roadStrip(10.17,BR_SPLIT,19.335)]),gRoadDeck=mergeGeos([roadStrip(10.17,1.005,BR_SPLIT)]);
function makeSegment(){
const g=new THREE.Group(),cars=[],roadParts=[],blds=[];
g.matrixAutoUpdate=false; // moved only when recycled (see updateSegmentRoadTransform)
// every child is static relative to its segment: compose its matrix once and freeze it
const fin=o=>{o.updateMatrix();o.matrixAutoUpdate=false;g.add(o);return o};
const add=(geo,m,x,y,z)=>{const o=new THREE.Mesh(geo,m);o.position.set(x,y,z);return fin(o)};
const addRoadPart=(geo,m,x,y,z,rx=0)=>{const o=new THREE.Mesh(geo,m);o.position.set(x,y,z);o.rotation.x=rx;fin(o);roadParts.push(o);return o};
const gnd=o=>{o.userData.noElev=true;return o}; // stays at ground level (only the deck strip and its light pools climb onto the bridge)
const tunS=o=>{o.userData.tunSink=true;return o},tunH=o=>{o.userData.tunHide=true;return o}; // tunnel: sink with the road / drop out of sight
tunS(gnd(addRoadPart(gRoadOpp,asM,0,0,0)));addRoadPart(gRoadDeck,asM,0,0,0);addRoadPart(gRoadLow,asM,0,0,0).userData.trench=true;
tunH(addRoadPart(gPoolsDeck,poolM,0,0,0));tunH(addRoadPart(gPoolsLow,poolM,0,0,0)).userData.trench=true;
tunS(gnd(addRoadPart(gCurb,curbM,0,.15,-L/2)));tunH(gnd(addRoadPart(gMed,medM,0,.34,-L/2)));
tunS(gnd(addRoadPart(gSW,swM,21.83,.15,-L/2)));tunS(gnd(addRoadPart(gSW,swLM,-21.83,.15,-L/2)));
tunS(gnd(addRoadPart(gWall,wallM,24.63,.55,-L/2)));
tunS(gnd(addRoadPart(gLips,lipM,0,.3,-L/2)));tunH(gnd(addRoadPart(BUSH_SETS[(_bushI++)%BUSH_SETS.length],bushM,0,.36,-L/2)));
addRoadPart(gSand,sandM,39.93,0,-L/2,-Math.PI/2).userData.noElev=true;addRoadPart(gFoam,foamM,42.6,SEA_LEVEL+.04,-L/2,-Math.PI/2).userData.noElev=true;
// Central-median trees removed to keep the divider clear and improve forward visibility.
const rocks=add(ROCK_SETS[0],rockM,0,0,0);rocks.visible=false;
// Median streetlights and their light pools must follow the exact curved road frame,
// just like the road surface, instead of remaining straight in the segment's original coordinates.
const lampParts=[tunH(gnd(addRoadPart(gPolesMerged,lampPoleM,0,0,0))),tunH(gnd(addRoadPart(gLampsMerged,lampM,0,0,0))),tunH(gnd(addRoadPart(gPoolsGround,poolM,0,0,0))),tunH(gnd(addRoadPart(gGlowMerged,glowM,0,0,0)))];
for(let i=0;i<6;i++)blds.push({t:0,m:new THREE.Matrix4()});
// Billboard stays on the outer sidewalk and is repositioned/oriented against the curve at its own Z station.
const bg=new THREE.Group();bg.position.set(21.8,0,-30);bg.userData.roadLateral=21.8;bg.userData.roadOffsetZ=-30;bg.rotation.y=-.7;bg.visible=false;
const board=new THREE.Mesh(bbG,bbM[0]);board.position.y=8.6;board.updateMatrix();board.matrixAutoUpdate=false;bg.add(board);
const bp=new THREE.Mesh(gBPsMerged,steelM);bp.updateMatrix();bp.matrixAutoUpdate=false;bg.add(bp);
bg.updateMatrix();bg.matrixAutoUpdate=false;g.add(bg);
scene.add(g);
const seg={g,cars,roadParts,rocks,blds,bb:{grp:bg,board},lampParts};
refreshSegment(seg);return seg}
// Re-randomise a segment's scenery in place (used at creation and every time a segment is recycled)
function refreshSegment(s){
  s.rocks.visible=false;
  const bz=[-10,-30,-50,-20,-40,-58];
  for(let i=0;i<6;i++){const ti=Math.floor(Math.random()*BT.length),b=BT[ti],o=s.blds[i],back=i>2;o.t=ti;o.m.makeTranslation(back?-52-b.w/2-rnd(0,10):-25.5-b.w/2-rnd(0,3),b.h/2,bz[i]+(back?rnd(-5,5):rnd(-.4,.4)))}
  const bb=s.bb;
  if(Math.random()<.5){bb.grp.userData.roadOffsetZ=-rnd(12,48);bb.board.material=pick(bbM);bb.grp.visible=true}else bb.grp.visible=false;
}

const segs=[];
// Keep a kilometre of already-driven road behind the player so rear-view mirrors
// never reveal the short recycling boundary. The remaining ring stays ahead.
for(let i=0;i<N;i++){const s=makeSegment();s.g.position.z=REAR_ROAD_BUFFER-L/2-i*L;s.g.updateMatrix();segs.push(s)}
// ===================== Road batching (performance) =====================
// Every 60 m segment used to draw ~20 separate meshes (asphalt strips, kerbs, sidewalks, sea wall, bushes, lamp poles, pools...),
// ~300 draw calls per frame with the shadow pass. All segments share the same materials, so each kind of part is copied into ONE
// combined mesh per material (a slot per segment). When a segment is recycled / bent to the road, only its slot is rewritten.
// The geometry is identical, so nothing changes on screen; the per-segment meshes stay as hidden sources for the curve warping.
const ROADBATCH=(()=>{
  const group=new THREE.Group();group.name='roadBatch';scene.add(group);
  const parts=[];                                   // per part index: {cap,icaps,attrs:{position,normal,uv,color},geos:[],meshes:[],dLo,dHi}
  const _m=new THREE.Matrix4(),_n=new THREE.Matrix3(),_v=new THREE.Vector3();
  let ready=false;
  function init(){
    const S=segs.length,K=segs[0].roadParts.length;
    for(let j=0;j<K;j++){
      const srcs=segs.map(sg=>sg.roadParts[j]);
      const m0=srcs[0],g0=m0.geometry,mats=Array.isArray(m0.material)?m0.material:[m0.material];
      let cap=0;for(const o of srcs)cap=Math.max(cap,o.geometry.attributes.position.count);
      const names=['position','normal','uv','color'].filter(n=>g0.attributes[n]);
      const attrs={};for(const n of names){const it=g0.attributes[n].itemSize,a=new THREE.BufferAttribute(new Float32Array(S*cap*it),it);a.setUsage(THREE.DynamicDrawUsage);attrs[n]=a}
      // index lists per material group (whole geometry when there are no groups)
      const groupsOf=g=>g.groups&&g.groups.length?g.groups:[{start:0,count:g.index?g.index.count:g.attributes.position.count,materialIndex:0}];
      const G=groupsOf(g0),P={cap,attrs,names,geos:[],meshes:[],dLo:1e9,dHi:-1};
      const big=S*cap>65535;
      G.forEach((gr,gi)=>{
        let icap=0;for(const o of srcs){const gg=groupsOf(o.geometry)[gi];icap=Math.max(icap,gg?gg.count:0)}
        const ix=big?new Uint32Array(S*icap):new Uint16Array(S*icap);
        srcs.forEach((o,si)=>{const g=o.geometry,gg=groupsOf(g)[gi],base=si*cap,off=si*icap;let k=0;
          if(gg){const id=g.index?g.index.array:null;for(;k<gg.count;k++)ix[off+k]=base+(id?id[gg.start+k]:gg.start+k)}
          for(;k<icap;k++)ix[off+k]=base;                // padding: zero-area triangles
        });
        const geo=new THREE.BufferGeometry();for(const n of names)geo.setAttribute(n,attrs[n]);geo.setIndex(new THREE.BufferAttribute(ix,1));
        geo.boundingSphere=new THREE.Sphere(new THREE.Vector3(),1e7);
        const mat=mats[gr.materialIndex!==undefined?gr.materialIndex:0]||mats[0];
        const mesh=new THREE.Mesh(geo,mat);mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;mesh.renderOrder=m0.renderOrder||0;
        mesh.name='roadBatch_'+j+'_'+gi;group.add(mesh);P.geos.push(geo);P.meshes.push(mesh);
      });
      parts.push(P);
    }
    // static attributes (uv, colour) once; positions / normals for every segment
    segs.forEach((sg,si)=>{for(let j=0;j<K;j++){const P=parts[j],g=sg.roadParts[j].geometry;for(const n of ['uv','color'])if(P.attrs[n]&&g.attributes[n])P.attrs[n].array.set(g.attributes[n].array.subarray(0,Math.min(g.attributes[n].array.length,P.cap*P.attrs[n].itemSize)),si*P.cap*P.attrs[n].itemSize)}update(sg)});
    for(const P of parts)for(const n of ['uv','color'])if(P.attrs[n])P.attrs[n].needsUpdate=true;
    for(const sg of segs)for(const o of sg.roadParts)o.visible=false;   // sources stay in the scene graph (warped in place), never drawn
    ready=true;flush();
  }
  function update(sg){
    if(!parts.length)return;
    const si=segs.indexOf(sg);if(si<0)return;
    for(let j=0;j<parts.length;j++){
      const P=parts[j],o=sg.roadParts[j],g=o.geometry,pa=g.attributes.position,na=g.attributes.normal,n=pa.count,base=si*P.cap;
      _m.multiplyMatrices(sg.g.matrix,o.matrix);_n.getNormalMatrix(_m);
      const dp=P.attrs.position.array,e=_m.elements,ne=_n.elements,src=pa.array;
      for(let i=0;i<n;i++){const k=i*3,x=src[k],y=src[k+1],z=src[k+2],w=(base+i)*3;
        dp[w]=e[0]*x+e[4]*y+e[8]*z+e[12];dp[w+1]=e[1]*x+e[5]*y+e[9]*z+e[13];dp[w+2]=e[2]*x+e[6]*y+e[10]*z+e[14]}
      if(na&&P.attrs.normal){const dn=P.attrs.normal.array,sn=na.array;
        for(let i=0;i<n;i++){const k=i*3,x=sn[k],y=sn[k+1],z=sn[k+2],w=(base+i)*3;
          let a=ne[0]*x+ne[3]*y+ne[6]*z,b=ne[1]*x+ne[4]*y+ne[7]*z,c=ne[2]*x+ne[5]*y+ne[8]*z;const l=Math.hypot(a,b,c)||1;dn[w]=a/l;dn[w+1]=b/l;dn[w+2]=c/l}}
      if(si<P.dLo)P.dLo=si;if(si>P.dHi)P.dHi=si;
    }
  }
  function flush(){
    if(!ready)return;
    for(const P of parts){
      if(P.dHi<P.dLo)continue;
      for(const n of ['position','normal']){const a=P.attrs[n];if(!a)continue;a.updateRange.offset=P.dLo*P.cap*a.itemSize;a.updateRange.count=(P.dHi-P.dLo+1)*P.cap*a.itemSize;a.needsUpdate=true}
      P.dLo=1e9;P.dHi=-1;
    }
  }
  return{init,update,flush,group,parts};
})();
try{ROADBATCH.init()}catch(err){console.warn('road batching failed, using per-segment meshes',err);for(const sg of segs)for(const o of sg.roadParts)o.visible=true}

// ===================== Elevated bridge section (كوبري) on the main road, every 4 km =====================
// Lanes 1-3 of the player's carriageway climb onto the bridge (the 'deck' road strip is lifted by bridgeElev(), see deformRoadPartForCurve);
// lanes 4-5 sink into a trench beside it, separated by a solid divider wall, and pass UNDER the widened deck. Here we build the structure: deck slab + widening, parapets, divider/retaining walls, dark ground under the deck and piers.
// Sand / foam / buildings stay at ground level. The road is kept straight around each bridge (ensureRoadCurves).
(function(){
  try{
    const grp=new THREE.Group();grp.visible=false;scene.add(grp);
    BR.group=grp;BR.k=0;
    const conM=new THREE.MeshLambertMaterial({color:0xaaa79e,side:THREE.DoubleSide});
    const pierM=new THREE.MeshLambertMaterial({color:0xb4b1a8});
    const stT=new THREE.CanvasTexture(curbPaintT.image);stT.wrapS=THREE.RepeatWrapping;stT.wrapT=THREE.ClampToEdgeWrapping;stT.anisotropy=ANISO;
    const stripeM=new THREE.MeshLambertMaterial({map:stT,side:THREE.DoubleSide});
    const underM=new THREE.MeshLambertMaterial({color:0x55524b,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    const colG=new THREE.CylinderGeometry(1,1.12,1,14),beamG=new THREE.BoxGeometry(1,1,1);
    const STEP=3,HALF=BRIDGE_FLAT+BRIDGE_RAMP;
    const parH=e=>1.1*Math.max(0,Math.min(1,e/.4)); // parapet / divider-wall height above the deck: grows from 0 at the foot of the ramp to 1.1 m
    // Open polyline profile swept along the road (z). prof(e) gives [x, absolute y] points for a deck height e; steps where e < minE are skipped.
    function sweep(prof,c,mat,minE){
      const pos=[],uv=[],idx=[];let n=0;
      for(let d=-HALF;d<HALF;d+=STEP){
        const z0=-(c+d),z1=-(c+d+STEP),e0=bridgeElev(z0),e1=bridgeElev(z1);
        if(e0<minE&&e1<minE)continue;
        const p0=prof(e0),p1=prof(e1);
        for(let j=0;j<p0.length-1;j++){
          const a=p0[j],b=p0[j+1],a1=p1[j],b1=p1[j+1];
          pos.push(a[0],a[1],z0, b[0],b[1],z0, b1[0],b1[1],z1, a1[0],a1[1],z1);
          const u0=z0/2,u1=z1/2;uv.push(u0,0,u0,1,u1,1,u1,0);
          idx.push(n,n+1,n+2,n,n+2,n+3);n+=4;
        }
      }
      if(!n)return null;
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
      g.setIndex(idx);g.computeVertexNormals();g.computeBoundingSphere();
      const m=new THREE.Mesh(g,mat);m.frustumCulled=false;return m;
    }
    const piers=new THREE.InstancedMesh(colG,pierM,120),beams=new THREE.InstancedMesh(beamG,pierM,40);
    piers.frustumCulled=beams.frustumCulled=false;
    const dyn=[];
    BR.build=function(k){
      for(const o of dyn){grp.remove(o);o.geometry.dispose()}dyn.length=0;
      const c=k*BRIDGE_SPACING;
      const add=o=>{if(o){dyn.push(o);grp.add(o)}};BR.cap=null;
      // deck slab under the 3 bridge lanes (x 0.7 .. 12)
      add(sweep(e=>[[.7,e-.03],[.7,e-1.4],[BR_SPLIT,e-1.4],[BR_SPLIT,e-.03]],c,conM,.04));
      // striped parapet on the median side of the deck
      add(sweep(e=>{const t=e+parH(e);return[[1,e-.03],[1,t],[.7,t],[.7,e-.03]]},c,stripeM,.04));
      // solid divider wall between the bridge lanes and the 2 ground lanes: deck side face x=BR_WALL_L, ground side face x=BR_WALL_R, tall enough to hold up the deck
      add(sweep(e=>{const t=e+parH(e);return[[BR_WALL_L,-3.6],[BR_WALL_L,t],[BR_WALL_R,t],[BR_WALL_R,-3.6]]},c,conM,.04));
      // right retaining wall of the trench (sidewalk edge) so the sunken lanes have a solid side
      add(sweep(e=>[[19.33,-BR_DIP*e-.1],[19.33,0]],c,conM,.1));
      // (the deck widening slab over the 2 sunken lanes was removed: the lower road beside the bridge is now open to the sky)
      // dark ground under the elevated deck (instead of bare sand) wherever it is clearly above the ground
      add(sweep(e=>[[.7,-.01],[BR_SPLIT,-.01]],c,underM,.3));
      // piers every 24 m wherever the deck is well above the ground: two columns + a cross-beam, all under the bridge lanes
      const m4=new THREE.Matrix4(),q=new THREE.Quaternion(),p=new THREE.Vector3(),s=new THREE.Vector3();let np=0,nb=0;
      for(let d=-HALF+12;d<=HALF-12&&nb<40;d+=24){
        const z=-(c+d),E=bridgeElev(z);if(E<2.4)continue;
        const top=E-1.4,bot=-3,len=top-bot;
        for(const x of [2.6,10.1]){p.set(x,(top+bot)/2,z);s.set(.8,len,.8);m4.compose(p,q,s);piers.setMatrixAt(np++,m4)}
        p.set((.55+12.15)/2,top-.45,z);s.set(11.6,.9,2.4);m4.compose(p,q,s);beams.setMatrixAt(nb++,m4);
      }
      piers.count=np;beams.count=nb;piers.instanceMatrix.needsUpdate=beams.instanceMatrix.needsUpdate=true;
      BR.k=k;
    };
    grp.add(piers,beams);
  }catch(err){console.warn('Bridge build failed:',err);BR.group=null}
})();
// Every frame: keeps the single bridge structure at the nearest 4 km mark.
function bridgeUpdate(dt){
  const g=BR.group;if(!g)return;
  const k=Math.max(1,Math.round(-st.z/BRIDGE_SPACING)),c=-k*BRIDGE_SPACING,on=featKind(k)===0&&Math.abs(st.z-c)<1600;
  if(on&&BR.k!==k)BR.build(k);
  if(g.visible!==on)g.visible=on;
  if(BR.cap)BR.cap.visible=!(st.x>=BR_MID&&view===1); // high chase camera on the sunken lanes: hide the slab above so the car stays visible
  BR.active=on;BR.z=c;
}

// ===================== Tunnel (نفق دائري مغلق) =====================
// A closed circular-arch tube that covers BOTH carriageways + the median island, buried TUN_D m under the ground. The road sinks into it along a ramp (see deformRoadPartForCurve / tunnelF).
// Inside: lit ceiling floodlights (4 rows), light strips on both walls, soft floodlight pools on the asphalt, and a plain concrete median island (no grass, no bushes, no light poles).
// Only one tunnel structure exists at a time; it is rebuilt at the nearest tunnel mark.
(function(){
  try{
    const grp=new THREE.Group();grp.visible=false;scene.add(grp);
    const roof=new THREE.Group();grp.add(roof);
    TUN.group=grp;TUN.roof=roof;TUN.k=-1;
    const STEP=4,HALF=TUN_FLAT+TUN_RAMP;
    const R=(TUN_HW*TUN_HW+TUN_RISE*TUN_RISE)/(2*TUN_RISE),CY=TUN_SPRING+TUN_RISE-R;
    const ceilY=x=>CY+Math.sqrt(Math.max(0,R*R-x*x)); // height of the arch above the road floor at lateral x
    const shellT=cv(256,256,(g,w,h)=>{ // pale tunnel tiles, brighter band across each lamp ring (period 12 m along z = v)
      const gr=g.createLinearGradient(0,0,0,h);gr.addColorStop(0,'#8e8c84');gr.addColorStop(.5,'#d2cfc4');gr.addColorStop(1,'#8e8c84');g.fillStyle=gr;g.fillRect(0,0,w,h);
      g.strokeStyle='rgba(60,58,52,.35)';g.lineWidth=2;for(let i=0;i<=8;i++){g.beginPath();g.moveTo(i*w/8,0);g.lineTo(i*w/8,h);g.stroke()}
      g.beginPath();g.moveTo(0,1);g.lineTo(w,1);g.stroke()});
    shellT.wrapS=shellT.wrapT=THREE.RepeatWrapping;
    const glowT=cv(64,64,(g,w,h)=>{const r=g.createRadialGradient(w/2,h/2,1,w/2,h/2,w/2);r.addColorStop(0,'rgba(255,244,214,1)');r.addColorStop(.55,'rgba(255,236,190,.45)');r.addColorStop(1,'rgba(255,230,180,0)');g.fillStyle=r;g.fillRect(0,0,w,h)});
    const shellM=new THREE.MeshBasicMaterial({map:shellT,color:0x9c9384,side:THREE.DoubleSide}); // softened: the unlit pale tiles used to glare
    const stripM=new THREE.MeshBasicMaterial({color:0xe8cf9e,side:THREE.DoubleSide});
    const concM=new THREE.MeshLambertMaterial({color:0xaeaba2,side:THREE.DoubleSide});
    const islandM=new THREE.MeshLambertMaterial({color:0xc9c6bc,side:THREE.DoubleSide});
    const coverM=new THREE.MeshLambertMaterial({color:0xbdb39b,side:THREE.DoubleSide});
    const fixM=new THREE.MeshBasicMaterial({color:0xfffbe8});
    const poolMat=new THREE.MeshBasicMaterial({map:glowT,transparent:true,opacity:.28,blending:THREE.AdditiveBlending,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2,fog:false});
    const fixG=new THREE.BoxGeometry(2.4,.2,.55),poolG=new THREE.PlaneGeometry(1,1).rotateX(-Math.PI/2);
    const fixtures=new THREE.InstancedMesh(fixG,fixM,600),pools=new THREE.InstancedMesh(poolG,poolMat,600);
    fixtures.frustumCulled=pools.frustumCulled=false;pools.renderOrder=3;
    roof.add(fixtures);grp.add(pools);
    const dyn=[];
    // Swept open profile along z. prof(Y,F) -> [[x,y],...] (Y = road floor height at that z, F = tunnel depth factor); a step is built only where ok(F) holds at both ends.
    function sweepT(prof,c,mat,ok,vScale){
      const pos=[],uv=[],idx=[];let n=0;
      for(let d=-HALF;d<HALF;d+=STEP){
        const z0=-(c+d),z1=-(c+d+STEP),F0=tunnelF(z0),F1=tunnelF(z1);
        if(!ok(F0)||!ok(F1))continue;
        const p0=prof(-TUN_D*F0,F0),p1=prof(-TUN_D*F1,F1);
        let len=0;
        for(let j=0;j<p0.length-1;j++){
          const a=p0[j],b=p0[j+1],a1=p1[j],b1=p1[j+1];
          pos.push(a[0],a[1],z0, b[0],b[1],z0, b1[0],b1[1],z1, a1[0],a1[1],z1);
          const u0=len/8,u1=(len+Math.hypot(b[0]-a[0],b[1]-a[1]))/8;len+=Math.hypot(b[0]-a[0],b[1]-a[1]);
          const v0=z0/12*(vScale||1),v1=z1/12*(vScale||1);uv.push(u0,v0,u1,v0,u1,v1,u0,v1);
          idx.push(n,n+1,n+2,n,n+2,n+3);n+=4;
        }
      }
      if(!n)return null;
      const g=new THREE.BufferGeometry();
      g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));
      g.setIndex(idx);g.computeVertexNormals();g.computeBoundingSphere();
      const m=new THREE.Mesh(g,mat);m.frustumCulled=false;return m;
    }
    const inTube=F=>F>=TUN_TUBE_F,inRamp=F=>F>.02&&F<TUN_TUBE_F,anyF=F=>F>.02;
    const archPts=(Y,x0,x1,n)=>{const a=[];for(let i=0;i<=n;i++){const x=x0+(x1-x0)*i/n;a.push([x,Y+ceilY(x)])}return a};
    // portal face at z: concrete wall between the arch opening and the ground, plus the solid blocks beside the tube
    function facade(z,Y){
      const pos=[],idx=[];let n=0;const top=.03,N=28,xs=[];
      for(let i=0;i<=N;i++)xs.push(-TUN_HW+2*TUN_HW*i/N);
      for(let i=0;i<N;i++){const xa=xs[i],xb=xs[i+1],ya=Y+ceilY(xa),yb=Y+ceilY(xb);
        pos.push(xa,ya,z, xb,yb,z, xb,top,z, xa,top,z);idx.push(n,n+1,n+2,n,n+2,n+3);n+=4}
      for(const [xa,xb] of [[-24.5,-TUN_HW],[TUN_HW,27]]){pos.push(xa,Y,z, xb,Y,z, xb,top,z, xa,top,z);idx.push(n,n+1,n+2,n,n+2,n+3);n+=4}
      const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(pos,3));g.setIndex(idx);g.computeVertexNormals();g.computeBoundingSphere();
      const m=new THREE.Mesh(g,concM);m.frustumCulled=false;return m;
    }
    TUN.build=function(k){
      for(const o of dyn){(o.parent||grp).remove(o);if(o.geometry)o.geometry.dispose()}dyn.length=0;
      const c=TUN_OFF+k*TUN_SPACING;
      const add=(o,parent)=>{if(o){dyn.push(o);(parent||grp).add(o)}return o};
      // arched roof (inner surface) + vertical walls
      add(sweepT(Y=>archPts(Y,-TUN_HW,TUN_HW,24),c,shellM,inTube),roof);
      add(sweepT(Y=>[[-TUN_HW,Y+.1],[-TUN_HW,Y+ceilY(-TUN_HW)]],c,shellM,inTube));
      add(sweepT(Y=>[[TUN_HW,Y+.1],[TUN_HW,Y+ceilY(TUN_HW)]],c,shellM,inTube));
      // continuous light strips along both walls
      add(sweepT(Y=>[[-TUN_HW+.04,Y+3.0],[-TUN_HW+.04,Y+3.35]],c,stripM,inTube));
      add(sweepT(Y=>[[TUN_HW-.04,Y+3.0],[TUN_HW-.04,Y+3.35]],c,stripM,inTube));
      // median island: plain concrete block (no grass, no bushes, no light poles); it rises smoothly out of the curb at the tunnel mouth
      add(sweepT((Y,F)=>{const h=.18+.4*Math.min(1,F*6);return[[-.75,Y+.02],[-.75,Y+h],[.75,Y+h],[.75,Y+.02]]},c,islandM,anyF));
      // open trench: retaining walls on both sides of the ramps + earth cover that hides the sunken kerbs / sea wall
      add(sweepT(Y=>[[-TUN_HW,Y+.1],[-TUN_HW,.03]],c,concM,inRamp));
      add(sweepT(Y=>[[TUN_HW,Y+.1],[TUN_HW,.03]],c,concM,inRamp));
      add(sweepT(()=>[[-24.5,.03],[-TUN_HW,.03]],c,coverM,inRamp));
      add(sweepT(()=>[[TUN_HW,.03],[27,.03]],c,coverM,inRamp));
      add(sweepT(()=>[[-24.5,.03],[27,.03]],c,coverM,inTube),roof);
      // portals + floodlights
      let zs=null,ze=null;
      for(let d=-HALF;d<HALF;d+=STEP){const z0=-(c+d),z1=-(c+d+STEP);if(inTube(tunnelF(z0))&&inTube(tunnelF(z1))){if(zs===null)zs=z0;ze=z1}}
      if(zs!==null){add(facade(zs,-TUN_D*tunnelF(zs)));add(facade(ze,-TUN_D*tunnelF(ze)))}
      const m4=new THREE.Matrix4(),q=new THREE.Quaternion(),p=new THREE.Vector3(),sc=new THREE.Vector3();let nf=0,np=0;
      if(zs!==null)for(let z=zs-6;z>ze+6&&nf<600;z-=12){
        const Y=-TUN_D*tunnelF(z);
        for(const x of [-15,-5.5,5.5,15]){
          p.set(x,Y+ceilY(x)-.14,z);sc.set(1,1,1);m4.compose(p,q,sc);fixtures.setMatrixAt(nf++,m4);
          p.set(x,Y+.07,z);sc.set(10,1,13);m4.compose(p,q,sc);pools.setMatrixAt(np++,m4);
        }
      }
      fixtures.count=nf;pools.count=np;fixtures.instanceMatrix.needsUpdate=pools.instanceMatrix.needsUpdate=true;
      TUN.k=k;
    };
  }catch(err){console.warn('Tunnel build failed:',err);TUN.group=null}
})();
// Every frame: keeps the tunnel structure at the nearest tunnel mark and mixes the scene lighting for the tunnel interior
const _tunCol=new THREE.Color(),_tunHemi=new THREE.Color(0xffe2b8),_tunGnd=new THREE.Color(0x6b665c),_tunFog=new THREE.Color(0x34363a);
function tunnelUpdate(dt){
  const g=TUN.group;if(!g)return;
  const d=-st.z,k=Math.max(1,Math.round((d-TUN_OFF)/TUN_SPACING)),c=TUN_OFF+k*TUN_SPACING,on=featKind(k)===1&&Math.abs(d-c)<1500;
  if(on&&TUN.k!==k)TUN.build(k);
  if(g.visible!==on)g.visible=on;
  TUN.active=on;TUN.z=-c;
  const F=on?tunnelF(st.z):0,target=Math.max(0,Math.min(1,(F-.55)/.35));
  TUN.inside+=(target-TUN.inside)*Math.min(1,dt*8);if(Math.abs(TUN.inside-target)<.002)TUN.inside=target;
  const f=TUN.inside;
  if(TUN.roof)TUN.roof.visible=!(view===1&&f>.2); // high chase camera: open the roof so the car stays visible
  // lighting: remember what setTimeOfDay / weather chose, blend towards the tunnel look, restore when leaving
  const fog=scene.fog,A=TUN.ap;
  if(!A||hemi.intensity!==A.hi||fog.far!==A.ff)TUN.base={hi:hemi.intensity,hc:hemi.color.clone(),hg:hemi.groundColor.clone(),si:sun.intensity,fc:fog.color.clone(),fn:fog.near,ff:fog.far};
  const B=TUN.base;
  if(f>.001){
    hemi.intensity=B.hi+(.72-B.hi)*f; // warm, moderate tunnel light (was a full-strength 1.0 that over-lit the car)hemi.color.copy(B.hc).lerp(_tunHemi,f);hemi.groundColor.copy(B.hg).lerp(_tunGnd,f);
    sun.intensity=B.si*(1-.85*f);
    fog.color.copy(B.fc).lerp(_tunFog,f);fog.near=B.fn+(Math.min(B.fn,25)-B.fn)*f;fog.far=B.ff+(Math.min(B.ff,300)-B.ff)*f;
    TUN.ap={hi:hemi.intensity,ff:fog.far};
    if(f>.5){rainCurtain.visible=false;rainFar.mesh.visible=false;rainNear.mesh.visible=false}
  }else if(A){
    hemi.intensity=B.hi;hemi.color.copy(B.hc);hemi.groundColor.copy(B.hg);sun.intensity=B.si;fog.color.copy(B.fc);fog.near=B.fn;fog.far=B.ff;TUN.ap=null;
  }
}

// ---- player car: FBX embedded directly in this HTML ----
// The FBX bytes (including embedded image payloads, when present) are stored below.
const car=new THREE.Group();
car.rotation.order='YXZ';
scene.add(car);
// Kept as empty compatibility arrays for the existing vehicle update loop.
const wheels=[],pivots=[],paintMaterials=new Set(),paintMaterialDefaults=new Map();
let activePaintColor="#f2f2f2",activePaintFinish="gloss";
const headM=new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
const tailM=new THREE.MeshBasicMaterial({color:0xff1414,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
// ---- cockpit (in-car view) helpers ----
const mirPanels=[],MIRC=[];let EYE=null,cockpitGlass=[],cluster=null,swPivot=null,swAxis=null,cockpitOn=false,clx=null,clTex=null,clKey='',mirrorHost=null,mitsuClusterBadgeRemoved=false,eraseMitsubishiClusterBadge=()=>false;
const _eyeV=new THREE.Vector3();const handParts=[];let armUpd=null;
// Cockpit camera: eye point in interior-mesh space (x sideways - driver is at +.35, y height, z forward) and how far the view is tilted down (radians).
// Lower y = lower eye = bigger windshield opening and more road; raise it to see more of the hood.
const COCKPIT_EYE=[.35,.99,-.08];let COCKPIT_PITCH=.12;
function setCockpit(on){if(on===cockpitOn)return;cockpitOn=on;for(const o of handParts)o.visible=on;for(const o of cockpitGlass)o.visible=!on;if(cluster)cluster.visible=on;for(const p of mirPanels)p.visible=on&&!p.userData.dead}
// ===== Driver's hands + arms: fully procedural (no assets). Pure maths, no THREE dependency, so it can be previewed outside the game. =====
// Coordinates: "pivot-local" = relative to the steering-wheel centre C, un-rotated (what a child of swPivot sees);
//              "cab-local"  = the interior-mesh space (what EYE, C and the shoulders are expressed in).
// The hand itself is modelled once in "hand-local" coordinates  [t, r, a]:  t = along the rim towards the thumb, r = dorsal (back of the hand, towards the
// driver / outwards), a = from the knuckles towards the wrist (towards the driver).  Both hands share that mesh (it is mirror-correct by construction).
const HandsGeo=(function(){
  const V={
    add:(a,b)=>[a[0]+b[0],a[1]+b[1],a[2]+b[2]],sub:(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]],mul:(a,k)=>[a[0]*k,a[1]*k,a[2]*k],
    dot:(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2],cross:(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],
    len:a=>Math.hypot(a[0],a[1],a[2]),norm:a=>{const l=Math.hypot(a[0],a[1],a[2])||1;return[a[0]/l,a[1]/l,a[2]/l]},
    lerp:(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t,a[2]+(b[2]-a[2])*t]
  };
  const C=[.3497,.7174,.3858],AX=V.norm([0,.3559,-.9345]),UP=V.norm([0,.9345,.3559]);   // wheel centre, column axis (towards the driver), "up" inside the wheel plane
  let RING=.165,S0=.01,RX=.025,RA=.02,OFFV=[0,0,0];const RX0=.025,RA0=.02,PHI0=80*Math.PI/180;                           // rim ring radius, rim axial offset, rim tube half-sizes (radial / axial), grip angle from 12 o'clock
  const BETA=32*Math.PI/180,cb=Math.cos(BETA),sb=Math.sin(BETA);                       // the whole hand is turned about the rim by BETA towards the driver
  function frame(s){
    const ph=s*PHI0,sn=Math.sin(ph),cs=Math.cos(ph);
    const Rr=V.add(V.mul([1,0,0],sn),V.mul(UP,cs)),T=V.sub(V.mul([1,0,0],cs),V.mul(UP,sn));
    const P=V.add(V.add(V.mul(Rr,RING),V.mul(AX,S0)),OFFV);
    return (tt,r,a)=>V.add(V.add(P,V.mul(T,-s*tt)),V.add(V.mul(Rr,r),V.mul(AX,a)));
  }
  const Geo=()=>({p:[],n:[],i:[],c:[]});
  // rim-frame (tt, radial, axial) -> hand-local [t, r, a]
  const toL=(tt,rx,ax)=>[tt,rx*cb+ax*sb,-rx*sb+ax*cb];
  // Fit the hands to the real wheel: ring radius, rim tube half-sizes (radial / axial), axial offset and in-plane centre offset (all in pivot-local metres)
  function setRim(o){
    const ok=x=>typeof x==='number'&&isFinite(x);
    if(ok(o.ring))RING=Math.min(.25,Math.max(.1,o.ring));
    if(ok(o.rx))RX=Math.min(.04,Math.max(.008,o.rx));
    if(ok(o.ra))RA=Math.min(.04,Math.max(.008,o.ra));
    if(ok(o.s0))S0=Math.min(.06,Math.max(-.06,o.s0));
    if(ok(o.ox)&&ok(o.oy))OFFV=V.add(V.mul([1,0,0],Math.max(-.03,Math.min(.03,o.ox))),V.mul(UP,Math.max(-.03,Math.min(.03,o.oy))));
    LOCAL=null;
  }
  const smin=(a,b,k)=>{const h=Math.max(k-Math.abs(a-b),0)/k;return Math.min(a,b)-h*h*k*.25};
  const sstep=(a,b,x)=>{const t=Math.min(1,Math.max(0,(x-a)/(b-a)));return t*t*(3-2*t)};

  // ---------- signed-distance primitives (plain numbers for speed) ----------
  // tapered capsule; optional flattening: the cross-section is squeezed by factor k along the unit vector n (which should be ~perpendicular to the axis)
  function mkCap(a,b,r0,r1,n,k){const bx=b[0]-a[0],by=b[1]-a[1],bz=b[2]-a[2];return{a,bx,by,bz,il:1/((bx*bx+by*by+bz*bz)||1e-9),r0,r1,n:n||null,k:k||1}}
  function capSd(x,y,z,c){
    let px=x-c.a[0],py=y-c.a[1],pz=z-c.a[2];
    if(c.k!==1){const f=(px*c.n[0]+py*c.n[1]+pz*c.n[2])*(c.k-1);px+=c.n[0]*f;py+=c.n[1]*f;pz+=c.n[2]*f}
    let t=(px*c.bx+py*c.by+pz*c.bz)*c.il;t=t<0?0:t>1?1:t;
    const dx=px-c.bx*t,dy=py-c.by*t,dz=pz-c.bz*t;
    return Math.sqrt(dx*dx+dy*dy+dz*dz)-(c.r0+(c.r1-c.r0)*t)}
  function mkEll(c,u,v,w,ru,rv,rw){return{c,u:V.norm(u),v:V.norm(v),w:V.norm(w),ru,rv,rw}}
  function ellSd(x,y,z,E){const px=x-E.c[0],py=y-E.c[1],pz=z-E.c[2],
    a=(px*E.u[0]+py*E.u[1]+pz*E.u[2])/E.ru,b=(px*E.v[0]+py*E.v[1]+pz*E.v[2])/E.rv,c=(px*E.w[0]+py*E.w[1]+pz*E.w[2])/E.rw,
    k0=Math.sqrt(a*a+b*b+c*c),k1=Math.sqrt(a*a/(E.ru*E.ru)+b*b/(E.rv*E.rv)+c*c/(E.rw*E.rw));
    return k1<1e-9?-Math.min(E.ru,E.rv,E.rw):k0*(k0-1)/k1}
  const mkSph=(c,r)=>({c,r});
  const sphSd=(x,y,z,S)=>Math.sqrt((x-S.c[0])*(x-S.c[0])+(y-S.c[1])*(y-S.c[1])+(z-S.c[2])*(z-S.c[2]))-S.r;

  // ---------- surface nets on a sparse grid (blocks far from the surface are skipped) ----------
  function sdfMesh(f,colF,mn,mx,h){
    const nx=Math.ceil((mx[0]-mn[0])/h)+2,ny=Math.ceil((mx[1]-mn[1])/h)+2,nz=Math.ceil((mx[2]-mn[2])/h)+2,sx=1,sy=nx,sz=nx*ny;
    const val=new Float32Array(nx*ny*nz),B=4,bnx=Math.ceil(nx/B),bny=Math.ceil(ny/B),bnz=Math.ceil(nz/B);
    const bval=new Float32Array(bnx*bny*bnz),bact=new Uint8Array(bnx*bny*bnz),rad=B*h*.866*1.7;
    for(let bk=0;bk<bnz;bk++)for(let bj=0;bj<bny;bj++)for(let bi=0;bi<bnx;bi++){
      const v=f(mn[0]+(bi*B+B*.5)*h,mn[1]+(bj*B+B*.5)*h,mn[2]+(bk*B+B*.5)*h);bval[bi+bj*bnx+bk*bnx*bny]=v;
      if(Math.abs(v)<rad)bact[bi+bj*bnx+bk*bnx*bny]=1;
    }
    const near=new Uint8Array(bnx*bny*bnz);
    for(let bk=0;bk<bnz;bk++)for(let bj=0;bj<bny;bj++)for(let bi=0;bi<bnx;bi++){
      if(!bact[bi+bj*bnx+bk*bnx*bny])continue;
      for(let dk=-1;dk<=1;dk++)for(let dj=-1;dj<=1;dj++)for(let di=-1;di<=1;di++){
        const a=bi+di,b=bj+dj,c=bk+dk;if(a<0||b<0||c<0||a>=bnx||b>=bny||c>=bnz)continue;near[a+b*bnx+c*bnx*bny]=1}
    }
    for(let k=0;k<nz;k++)for(let j=0;j<ny;j++)for(let i=0;i<nx;i++){
      const bi=(i/B)|0,bj=(j/B)|0,bk=(k/B)|0,bid=bi+bj*bnx+bk*bnx*bny;
      val[i+j*sy+k*sz]=near[bid]?f(mn[0]+i*h,mn[1]+j*h,mn[2]+k*h):bval[bid];
    }
    const cid=new Int32Array(nx*ny*nz).fill(-1),vp=[];
    const E=[[0,1],[2,3],[4,5],[6,7],[0,2],[1,3],[4,6],[5,7],[0,4],[1,5],[2,6],[3,7]],cx=[0,1,0,1,0,1,0,1],cy=[0,0,1,1,0,0,1,1],cz=[0,0,0,0,1,1,1,1];
    const co=[0,1,sy,sy+1,sz,sz+1,sz+sy,sz+sy+1],cv=new Float32Array(8);
    for(let k=0;k<nz-1;k++)for(let j=0;j<ny-1;j++)for(let i=0;i<nx-1;i++){
      const o=i+j*sy+k*sz;let neg=0;
      for(let c=0;c<8;c++){cv[c]=val[o+co[c]];if(cv[c]<0)neg++}
      if(neg===0||neg===8)continue;
      let px=0,py=0,pz=0,n=0;
      for(const [a,b] of E){const va=cv[a],vb=cv[b];if((va<0)===(vb<0))continue;const t=va/(va-vb);
        px+=cx[a]+t*(cx[b]-cx[a]);py+=cy[a]+t*(cy[b]-cy[a]);pz+=cz[a]+t*(cz[b]-cz[a]);n++}
      cid[o]=vp.length/3;vp.push(mn[0]+(i+px/n)*h,mn[1]+(j+py/n)*h,mn[2]+(k+pz/n)*h);
    }
    const tri=[],quad=(a,b,c,d)=>{if(a<0||b<0||c<0||d<0)return;tri.push(a,b,c,a,c,d)};
    for(let k=1;k<nz-1;k++)for(let j=1;j<ny-1;j++)for(let i=1;i<nx-1;i++){
      const o=i+j*sy+k*sz,v0=val[o]<0;
      if(v0!==(val[o+sx]<0))quad(cid[o],cid[o-sy],cid[o-sy-sz],cid[o-sz]);
      if(v0!==(val[o+sy]<0))quad(cid[o],cid[o-sx],cid[o-sx-sz],cid[o-sz]);
      if(v0!==(val[o+sz]<0))quad(cid[o],cid[o-sx],cid[o-sx-sy],cid[o-sy]);
    }
    // relax the vertices a little (removes the stair-step look of the grid), then project onto the true surface; normals come from the field gradient
    const nv=vp.length/3,e=.0006,NN=new Float32Array(nv*3),G={p:[],n:[],c:[],i:[]};
    const nb=new Array(nv);for(let v=0;v<nv;v++)nb[v]=[];
    for(let t=0;t<tri.length;t+=3){const a=tri[t],b=tri[t+1],c=tri[t+2];nb[a].push(b,c);nb[b].push(a,c);nb[c].push(a,b)}
    for(let it=0;it<2;it++){
      const np=vp.slice();
      for(let v=0;v<nv;v++){const L=nb[v];if(!L.length)continue;let ax=0,ay=0,az=0;for(const u of L){ax+=vp[u*3];ay+=vp[u*3+1];az+=vp[u*3+2]}
        const q=1/L.length;np[v*3]=vp[v*3]*.5+ax*q*.5;np[v*3+1]=vp[v*3+1]*.5+ay*q*.5;np[v*3+2]=vp[v*3+2]*.5+az*q*.5}
      for(let v=0;v<vp.length;v++)vp[v]=np[v];
    }
    for(let v=0;v<nv;v++){
      let x=vp[v*3],y=vp[v*3+1],z=vp[v*3+2];
      for(let it=0;it<2;it++){
        let gx=f(x+e,y,z)-f(x-e,y,z),gy=f(x,y+e,z)-f(x,y-e,z),gz=f(x,y,z+e)-f(x,y,z-e);const gl=Math.hypot(gx,gy,gz)||1;gx/=gl;gy/=gl;gz/=gl;
        const d=Math.max(-h,Math.min(h,f(x,y,z)));x-=gx*d;y-=gy*d;z-=gz*d;NN[v*3]=gx;NN[v*3+1]=gy;NN[v*3+2]=gz;
      }
      const c=colF(x,y,z);G.p.push(x,y,z);G.n.push(NN[v*3],NN[v*3+1],NN[v*3+2]);G.c.push(c[0],c[1],c[2]);
    }
    for(let t=0;t<tri.length;t+=3){
      const a=tri[t],b=tri[t+1],c=tri[t+2],A=a*3,Bb=b*3,Cc=c*3,P=G.p,
        ux=P[Bb]-P[A],uy=P[Bb+1]-P[A+1],uz=P[Bb+2]-P[A+2],wx=P[Cc]-P[A],wy=P[Cc+1]-P[A+1],wz=P[Cc+2]-P[A+2],
        nx_=uy*wz-uz*wy,ny_=uz*wx-ux*wz,nz_=ux*wy-uy*wx,dt=nx_*(NN[A]+NN[Bb]+NN[Cc])+ny_*(NN[A+1]+NN[Bb+1]+NN[Cc+1])+nz_*(NN[A+2]+NN[Bb+2]+NN[Cc+2]);
      if(dt>=0)G.i.push(a,b,c);else G.i.push(a,c,b);
    }
    return G;
  }

  // ---------- the hand (hand-local coordinates) ----------
  let LOCAL=null;
  function buildLocalHand(){
    const UX=[1,0,0],UY=[0,1,0],UZ=[0,0,1];
    const RIMC=tt=>[tt,0,0];                                  // centre of the rim tube section under finger tt
    const perp=(v,ax)=>{const d=V.dot(v,ax);return V.sub(v,V.mul(ax,d))};
    const PT=[],JT=[],TP=[],NL=[],CREASE=[];                  // bounds points / joint points / fingertip pads / nails / crease lines {p,ax,rad}
    const parts={fingers:[],joints:[]};
    const mcpR=[.0108,.0111,.0104,.0093];
    // ---- back of the hand: a soft rounded slab, narrowing to the wrist, with the knuckle row slightly arched ----
    const RD=.012,dX=RX-RX0,dA=RA-RA0,SH=[0,dX*cb+dA*sb,-dX*sb+dA*cb];   // palm / thumb root follow the rim size
    const slab=(x,y,z)=>{
      const k=sstep(0,1,(.102-z)/.112);                       // 0 at the wrist end .. 1 at the knuckles
      const hw=.0295+(.0445-.0295)*k;
      const yy=y-(.0450-.0085*Math.pow(Math.min(1.4,Math.abs(x)/.046),2));
      const dx=Math.abs(x)-(hw-RD),dz=Math.abs(z-.046)-(.057-RD),dy=Math.abs(yy)-(.0138-RD);
      const ox=dx>0?dx:0,oy=dy>0?dy:0,oz=dz>0?dz:0;
      return Math.sqrt(ox*ox+oy*oy+oz*oz)+Math.min(Math.max(dx,dy,dz),0)-RD;
    };
    const thenar=mkEll([.036,.0405,.064],UX,UY,UZ,.0195,.0155,.0385);
    const hypo=mkEll([-.0375,.0405,.066],UX,UY,UZ,.0125,.0125,.034);
    const mcpN=[.032,.0115,-.0085,-.0275].map((tt,i)=>[tt,.0485+(i===1?.0035:i===0?.0015:0),-.003]);
    const mcpPts=mcpN.map(p=>[p[0]+SH[0],p[1]+SH[1],p[2]+SH[2]]);
    const knuckles=mcpN.map((p,i)=>mkSph(p,mcpR[i]*1.02));
    const ridges=mcpN.map((p,i)=>mkCap([p[0],.0575,.012],[p[0]*.55,.0585,.094],.0040,.0042));
    const wrist=mkCap([0,.0455,.078],[0,.0455,.126],.0286,.0262,UY,1.45);   // runs on a little way into the forearm so the arm tube can cover its end
    const ulna=mkSph([-.0215,.0535,.098],.0066);
    for(const q of [[0,.047,.14],[0,.04,.05],[.04,.04,.07],[-.04,.04,.07]])PT.push([q[0]+SH[0],q[1]+SH[1],q[2]+SH[2]]);
    // ---- fingers wrapped around the rim ----
    const fin=[[.032,.0100,[-2,48,102,158]],[.0115,.0104,[-2,48,102,160]],[-.0085,.0097,[-2,46,100,154]],[-.0275,.0084,[-2,46,98]]];
    const fingers=[];
    for(let fi=0;fi<fin.length;fi++){
      const [tt,rf,angs]=fin[fi],pts=[mcpPts[fi].slice()];
      for(const d of angs){const q=d*Math.PI/180;pts.push(toL(tt,(RX+rf)*Math.cos(q),-(RA+rf)*Math.sin(q)))}
      const m=pts.length-1,cum=[0];for(let k=1;k<=m;k++)cum.push(cum[k-1]+V.len(V.sub(pts[k],pts[k-1])));
      const tot=cum[m],rad=s=>rf*(1.16-.42*s);
      const at=s=>{const L=s*tot;let k=1;while(k<m&&cum[k]<L)k++;const t=(L-cum[k-1])/((cum[k]-cum[k-1])||1);return{p:V.lerp(pts[k-1],pts[k],t),ax:V.norm(V.sub(pts[k],pts[k-1]))}};
      const caps=[];
      for(let k=0;k<m;k++){
        const a=pts[k],b=pts[k+1],ax=V.norm(V.sub(b,a)),mid=V.mul(V.add(a,b),.5),n=V.norm(perp(V.sub(mid,RIMC(tt)),ax));
        caps.push(mkCap(a,b,rad(cum[k]/tot),rad(cum[k+1]/tot),n,1.1));
      }
      const pip=at(.4),dip=at(.72),joints=[];
      for(const [j,sc] of [[pip,.4],[dip,.72]]){joints.push(mkSph(j.p,rad(sc)*1.055));JT.push(j.p);
        for(const o of [-.0021,0,.0021])CREASE.push({p:V.add(j.p,V.mul(j.ax,o)),ax:j.ax,rad:rad(sc)*1.9,w:o===0?1:.7})}
      CREASE.push({p:mcpPts[fi],ax:V.norm(V.sub(pts[1],pts[0])),rad:.016,w:.6});
      fingers.push({caps,joints});
      PT.push(...pts);TP.push(pts[m]);
      // nail: flat plate on the dorsal side of the last phalanx
      const pa=pts[m-1],pb=pts[m],d=V.norm(V.sub(pb,pa)),o=V.norm(perp(V.sub(pb,RIMC(tt)),d)),w=V.cross(d,o),re=rad(1);
      NL.push(mkEll(V.add(V.sub(pb,V.mul(d,re*.6)),V.mul(o,re*.9)),d,o,w,re*1.05,re*.2,re*.78));
    }
    // ---- thumb: metacarpal + two phalanges lying along the back face of the rim ----
    const cmc=[.027+SH[0],.0415+SH[1],.090+SH[2]],mcp=toL(.036,.016+dX,.046+dA),ip=toL(.0675,.0125+dX,.0335+dA),tip=toL(.0855,.0105+dX,.0285+dA);
    const thMcpS=mkSph(mcp,.0132),thIpS=mkSph(ip,.0117);
    const nOf=(a,b)=>{const ax=V.norm(V.sub(b,a)),mid=V.mul(V.add(a,b),.5);return V.norm(perp(V.sub(mid,RIMC(mid[0])),ax))};
    const thumb=[mkCap(cmc,mcp,.0158,.0128,UY,1.12),mkCap(mcp,ip,.0128,.0112,nOf(mcp,ip),1.12),mkCap(ip,tip,.0112,.0095,nOf(ip,tip),1.12)];
    PT.push(cmc,mcp,ip,tip);JT.push(mcp,ip);TP.push(tip);
    {const ax=V.norm(V.sub(tip,ip));for(const o of [-.0021,0,.0021])CREASE.push({p:V.add(ip,V.mul(ax,o)),ax,rad:.02,w:o===0?1:.7})}
    {const d=V.norm(V.sub(tip,ip)),o=V.norm(perp(V.sub(tip,RIMC(tip[0])),d)),w=V.cross(d,o);
     NL.push(mkEll(V.add(V.sub(tip,V.mul(d,.0052)),V.mul(o,.0082)),d,o,w,.0098,.0016,.0074))}
    // ---- the whole field ----
    const fld=(x,y,z)=>{
      const px=x-SH[0],py=y-SH[1],pz=z-SH[2];
      let d=slab(px,py,pz);
      d=smin(d,ellSd(px,py,pz,thenar),.016);d=smin(d,ellSd(px,py,pz,hypo),.014);
      d=smin(d,capSd(px,py,pz,wrist),.026);d=smin(d,sphSd(px,py,pz,ulna),.012);
      for(const k of knuckles)d=smin(d,sphSd(px,py,pz,k),.009);
      for(const r of ridges)d=smin(d,capSd(px,py,pz,r),.014);
      let fd=1e9;
      for(const F of fingers){
        let q=capSd(x,y,z,F.caps[0]);for(let k=1;k<F.caps.length;k++)q=smin(q,capSd(x,y,z,F.caps[k]),.006);
        for(const j of F.joints)q=smin(q,sphSd(x,y,z,j),.005);
        if(q<fd)fd=q;
      }
      d=smin(d,fd,.011);
      let td=capSd(x,y,z,thumb[0]);for(let k=1;k<3;k++)td=smin(td,capSd(x,y,z,thumb[k]),.006);
      td=smin(td,sphSd(x,y,z,thMcpS),.006);td=smin(td,sphSd(x,y,z,thIpS),.005);
      d=smin(d,td,.013);
      for(const E of NL)d=smin(d,ellSd(x,y,z,E),.0012);
      return d};
    // ---- skin colour: joint creases, flushed knuckles / fingertips, faint veins on the back of the hand, nails ----
    const VEINS=[[[.026,.060,.012],[.018,.0605,.050],[.008,.0615,.092]],[[.006,.0605,.010],[.0035,.0612,.050],[0,.0618,.092]],[[-.014,.0605,.010],[-.012,.0612,.050],[-.004,.0618,.092]]];
    const colF=(x,y,z)=>{
      let sh=1,tk=0,fl=0;
      for(const q of CREASE){const dx=x-q.p[0],dy=y-q.p[1],dz=z-q.p[2],al=dx*q.ax[0]+dy*q.ax[1]+dz*q.ax[2],r2=dx*dx+dy*dy+dz*dz-al*al;
        if(r2<q.rad*q.rad)sh-=.075*q.w*Math.exp(-al*al/.0000004)}
      for(const q of JT){const dx=x-q[0],dy=y-q[1],dz=z-q[2];fl+=.55*Math.exp(-(dx*dx+dy*dy+dz*dz)/.00012)}
      for(const q of mcpPts){const dx=x-q[0],dy=y-q[1],dz=z-q[2];fl+=.5*Math.exp(-(dx*dx+dy*dy+dz*dz)/.00022)}
      for(const q of TP){const dx=x-q[0],dy=y-q[1],dz=z-q[2];tk+=Math.exp(-(dx*dx+dy*dy+dz*dz)/.00014)}
      let r=sh*(1+.02*fl),g=sh*(1-.06*fl-.08*tk),b=sh*(1-.09*fl-.13*tk);
      if(y-SH[1]>.0525){let vmin=1e9;
        for(const P of VEINS)for(let k=0;k<2;k++){const a=P[k],bb=P[k+1],abx=bb[0]-a[0],abz=bb[2]-a[2],t=Math.max(0,Math.min(1,((x-SH[0]-a[0])*abx+(z-SH[2]-a[2])*abz)/(abx*abx+abz*abz))),
          dd=Math.hypot(x-SH[0]-(a[0]+abx*t),z-SH[2]-(a[2]+abz*t));if(dd<vmin)vmin=dd}
        const v=Math.exp(-vmin*vmin/.0000028)*sstep(.0525,.058,y-SH[1]);r*=1-.16*v;g*=1-.09*v;b*=1+.01*v}
      for(const E of NL){const s=ellSd(x,y,z,E);if(s<.0011){const lun=sstep(-.002,.0,-(((x-E.c[0])*E.u[0]+(y-E.c[1])*E.u[1]+(z-E.c[2])*E.u[2])/E.ru)-.35);
        r*=1.15+.03*lun;g*=1.05+.06*lun;b*=1.05+.06*lun;break}}
      return[r,g,b]};
    const mn=[1e9,1e9,1e9],mx=[-1e9,-1e9,-1e9];
    for(const p of PT)for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],p[k]-.03);mx[k]=Math.max(mx[k],p[k]+.03)}
    const G=sdfMesh(fld,colF,mn,mx,.00135);
    return{G,wristEnd:[SH[0],.0455+SH[1],.108+SH[2]]};
  }
  // one hand gripping the rim: hand-local mesh mapped into pivot-local space (the mirrored hand flips the triangle winding)
  function grip(s){
    if(!LOCAL)LOCAL=buildLocalHand();
    const X=frame(s),O=X(0,0,0),dir=(t,r,a)=>V.sub(X(t,r,a),O);
    const eT=dir(1,0,0),eR0=dir(0,1,0),eA0=dir(0,0,1);
    const eR=V.add(V.mul(eR0,cb),V.mul(eA0,sb)),eA=V.add(V.mul(eR0,-sb),V.mul(eA0,cb));
    const G=LOCAL.G,P=[],N=[],I=[],n=G.p.length/3,flip=V.dot(V.cross(eT,eR),eA)<0;
    for(let v=0;v<n;v++){
      const x=G.p[v*3],y=G.p[v*3+1],z=G.p[v*3+2],nx=G.n[v*3],ny=G.n[v*3+1],nz=G.n[v*3+2];
      P.push(O[0]+eT[0]*x+eR[0]*y+eA[0]*z,O[1]+eT[1]*x+eR[1]*y+eA[1]*z,O[2]+eT[2]*x+eR[2]*y+eA[2]*z);
      N.push(eT[0]*nx+eR[0]*ny+eA[0]*nz,eT[1]*nx+eR[1]*ny+eA[1]*nz,eT[2]*nx+eR[2]*ny+eA[2]*nz);
    }
    for(let t=0;t<G.i.length;t+=3){if(flip)I.push(G.i[t],G.i[t+2],G.i[t+1]);else I.push(G.i[t],G.i[t+1],G.i[t+2])}
    const w=LOCAL.wristEnd,cuff=V.add(O,V.add(V.mul(eT,w[0]),V.add(V.mul(eR,w[1]),V.mul(eA,w[2]))));
    return{skin:{p:P,n:N,c:G.c.slice(),i:I},cuff,axes:{eT,eR,eA}};
  }

  // ---------- the arm: one seamless tube (upper arm -> elbow -> forearm -> wrist) rebuilt every frame from shoulder / elbow / wrist ----------
  // shoulder joints (cab-local) of a driver sitting upright behind the wheel; s = +1 left arm, -1 right arm
  const SHOULDER=s=>[.35+s*.19,.80,-.18],L1=.30,L2=.28;
  // two-bone arm: shoulder S, wrist target Wt, elbow bends downwards and a little outwards
  function elbow(S,Wt,s){
    const d=V.sub(Wt,S),e=V.norm(d);
    const L=Math.min(Math.max(V.len(d),Math.abs(L1-L2)+.01),L1+L2-.003);
    const a=(L1*L1-L2*L2+L*L)/(2*L),h=Math.sqrt(Math.max(0,L1*L1-a*a));
    let pv=V.norm([s*.45,-1,-.15]);pv=V.norm(V.sub(pv,V.mul(e,V.dot(pv,e))));
    return V.add(V.add(S,V.mul(e,a)),V.mul(pv,h));
  }
  // cross-section half-axes [fraction, half-width, half-depth]: width = across the limb (thumb side <-> little-finger side), depth = front/back
  const UPPER=[[0,.0575,.0545],[.25,.0585,.0560],[.6,.0505,.0485],[.85,.0425,.0405],[1,.0385,.0375]];
  const FORE=[[0,.0385,.0375],[.12,.0425,.0405],[.3,.0435,.0385],[.55,.0372,.0318],[.8,.0305,.0248],[1,.0275,.0190]];
  const prof=(T,f)=>{f=Math.min(1,Math.max(0,f));let k=1;while(k<T.length-1&&T[k][0]<f)k++;const a=T[k-1],b=T[k],u=(f-a[0])/((b[0]-a[0])||1),w=u*u*(3-2*u);
    return[a[1]+(b[1]-a[1])*w,a[2]+(b[2]-a[2])*w]};
  const bez=(P0,P1,P2,P3,t)=>{const u=1-t,a=u*u*u,b=3*u*u*t,c=3*u*t*t,d=t*t*t;return[0,1,2].map(k=>a*P0[k]+b*P1[k]+c*P2[k]+d*P3[k])};
  const dbez=(P0,P1,P2,P3,t)=>{const u=1-t,a=3*u*u,b=6*u*t,c=3*t*t;return[0,1,2].map(k=>a*(P1[k]-P0[k])+b*(P2[k]-P1[k])+c*(P3[k]-P2[k]))};
  function ArmRig(s){
    const NA=20,NB=34,NX=3,NR=NA+NB+1+NX,SEG=28,NS=12;
    const mk=(rings)=>({pos:new Float32Array(rings*SEG*3),nor:new Float32Array(rings*SEG*3),sk:new Float32Array(rings*SEG*3),idx:null,rings});
    const skin=mk(NR),sleeve=mk(NS+2);
    const refE=[s*1,0,0];
    function makeIdx(M,flip){const I=[];for(let i=0;i<M.rings-1;i++)for(let j=0;j<SEG;j++){const j2=(j+1)%SEG,a=i*SEG+j,b=i*SEG+j2,c=(i+1)*SEG+j,d=(i+1)*SEG+j2;
      if(flip)I.push(a,b,c,b,d,c);else I.push(a,c,b,b,c,d)}M.idx=new Uint16Array(I)}
    let ready=false;
    function update(S,E,W,eW,eA){
      const l1=V.len(V.sub(E,S)),l2=V.len(V.sub(W,E)),dU=V.norm(V.sub(E,S)),dF=V.norm(V.sub(W,E)),tE=V.norm(V.add(dU,dF));
      const A0=S,A1=V.add(S,V.mul(dU,l1/3)),A2=V.sub(E,V.mul(tE,l1/3)),A3=E;
      const B0=E,B1=V.add(E,V.mul(tE,l2/3)),B2=V.add(W,V.mul(eA,l2*.38)),B3=W;
      let ew=eW;if(V.dot(ew,refE)<0)ew=V.mul(ew,-1);
      const ctr=[],tan=[],wid=[],dep=[],rad=[],arc=[];let L=0,prev=null;
      const push=(p,t,fb,aw,ad,slope)=>{
        t=V.norm(t);if(prev)L+=V.len(V.sub(p,prev));prev=p;
        const mix=sstep(.15,.95,fb);let ref=V.norm(V.lerp(refE,ew,mix));
        let w=V.norm(V.sub(ref,V.mul(t,V.dot(ref,t)))),d=V.cross(t,w);
        ctr.push(p);tan.push(t);wid.push(w);dep.push(d);rad.push([aw,ad,slope]);arc.push(L);
      };
      for(let i=0;i<=NA;i++){const t=i/NA,a=prof(UPPER,t),a2=prof(UPPER,Math.min(1,t+.02)),a1=prof(UPPER,Math.max(0,t-.02));
        push(bez(A0,A1,A2,A3,t),dbez(A0,A1,A2,A3,t),0,a[0],a[1],((a2[0]+a2[1])-(a1[0]+a1[1]))*.5/(.04*l1+1e-6))}
      for(let j=1;j<=NB;j++){const t=j/NB,a=prof(FORE,t),a2=prof(FORE,Math.min(1,t+.02)),a1=prof(FORE,Math.max(0,t-.02));
        push(bez(B0,B1,B2,B3,t),dbez(B0,B1,B2,B3,t),t,a[0],a[1],((a2[0]+a2[1])-(a1[0]+a1[1]))*.5/(.04*l2+1e-6))}
      {const hv=V.mul(eA,-1),tw=V.norm(hv),aw0=rad[rad.length-1][0],ad0=rad[rad.length-1][1],lastW=wid[wid.length-1],lastD=dep[dep.length-1];
       [[.006,.97],[.014,.94],[.024,.9]].forEach(([dd,sc])=>{ctr.push(V.add(W,V.mul(tw,dd)));tan.push(tw);wid.push(lastW);dep.push(lastD);rad.push([aw0*sc,ad0*sc,0]);arc.push(L+dd)})}
      const fill=(M,i,k,off,ring)=>{
        const p=ctr[k],t=tan[k],w=wid[k],d=dep[k],aw=rad[k][0]+off,ad=rad[k][1]+off;
        for(let j=0;j<SEG;j++){
          const th=j/SEG*Math.PI*2,c=Math.cos(th),sn=Math.sin(th),o=(i*SEG+j)*3;
          M.pos[o]=p[0]+w[0]*aw*c+d[0]*ad*sn;M.pos[o+1]=p[1]+w[1]*aw*c+d[1]*ad*sn;M.pos[o+2]=p[2]+w[2]*aw*c+d[2]*ad*sn;
          let nx=w[0]*c/aw+d[0]*sn/ad,ny=w[1]*c/aw+d[1]*sn/ad,nz=w[2]*c/aw+d[2]*sn/ad;const nl=Math.hypot(nx,ny,nz)||1;nx/=nl;ny/=nl;nz/=nl;
          const sl=rad[k][2];nx-=t[0]*sl;ny-=t[1]*sl;nz-=t[2]*sl;const l2n=Math.hypot(nx,ny,nz)||1;
          M.nor[o]=nx/l2n;M.nor[o+1]=ny/l2n;M.nor[o+2]=nz/l2n;
          M.sk[o]=c*.034;M.sk[o+1]=arc[k];M.sk[o+2]=sn*.034;
        }
      };
      for(let k=0;k<NR;k++)fill(skin,k,k,0);
      // short sleeve over the first half of the upper arm, with a rolled hem
      for(let i=0;i<=NS;i++)fill(sleeve,i,Math.round(i/NS*NA*.5),.0085);
      fill(sleeve,NS+1,Math.round(NA*.5),.0055);
      if(!ready){ready=true;
        // choose the triangle winding so that the geometric normal agrees with the outward vertex normals
        for(const M of [skin,sleeve]){makeIdx(M,false);const a=M.idx[0]*3,b=M.idx[1]*3,c=M.idx[2]*3;
          const u=[M.pos[b]-M.pos[a],M.pos[b+1]-M.pos[a+1],M.pos[b+2]-M.pos[a+2]],v=[M.pos[c]-M.pos[a],M.pos[c+1]-M.pos[a+1],M.pos[c+2]-M.pos[a+2]],g=V.cross(u,v);
          if(V.dot(g,[M.nor[a],M.nor[a+1],M.nor[a+2]])<0)makeIdx(M,true)}
      }
      return ctr[0];
    }
    return{skin,sleeve,update};
  }
  return{V,C,AX,UP,setRim,grip,SHOULDER,elbow,L1,L2,Geo,ArmRig};
})();
// Builds the driver's two hands (parented to the steering wheel pivot, so they turn with it) and arms (one seamless tube per arm, rebuilt every frame between the fixed shoulder and the moving wrist).
// Set DRIVER_HANDS to 1 to keep only the left hand (the right one is hidden) or 2 for both; 0 removes both.
const DRIVER_HANDS=2;
// Skin material: matte, excluded from the car-paint gloss/lamp patches, with procedural mottling, fine pores (bump) and a warm sub-surface rim glow.
// useAttr: take the noise coordinate from the "skinP" vertex attribute (arms, whose vertices move every frame) instead of the vertex position.
function skinify(m,useAttr){
  m.userData.litPatched=true;
  m.onBeforeCompile=sh=>{
    sh.vertexShader=sh.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vSkinP;'+(useAttr?'\nattribute vec3 skinP;':''))
      .replace('#include <begin_vertex>','#include <begin_vertex>\n'+(useAttr?'vSkinP=skinP;':'vSkinP=position*vec3(1.,length(modelMatrix[1].xyz)/length(modelMatrix[0].xyz),1.);'));
    sh.fragmentShader=sh.fragmentShader.replace('#include <common>',`#include <common>
varying vec3 vSkinP;
float skHash(float n){return fract(sin(n)*43758.5453);}
float skNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);float n=i.x+i.y*57.+i.z*113.;
 return mix(mix(mix(skHash(n),skHash(n+1.),f.x),mix(skHash(n+57.),skHash(n+58.),f.x),f.y),mix(mix(skHash(n+113.),skHash(n+114.),f.x),mix(skHash(n+170.),skHash(n+171.),f.x),f.y),f.z);}`)
    .replace('#include <color_fragment>',`#include <color_fragment>
{float m1=skNoise(vSkinP*38.),m2=skNoise(vSkinP*135.+7.);
 diffuseColor.rgb*=vec3(1.+.09*(m1-.5)+.03*(m2-.5),1.-.07*(m1-.5)+.025*(m2-.5),1.-.12*(m1-.5)+.02*(m2-.5));
 diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(1.06,.93,.9),smoothstep(.55,.8,skNoise(vSkinP*22.+3.)));}`)
    .replace('#include <emissivemap_fragment>',`#include <emissivemap_fragment>
{float hh=skNoise(vSkinP*160.)*.6+skNoise(vSkinP*480.)*.4;
 vec3 sp=-vViewPosition,sx=dFdx(sp),sy=dFdy(sp),R1=cross(sy,normal),R2=cross(normal,sx);
 float fDet=dot(sx,R1);vec3 vG=sign(fDet)*(dFdx(hh)*R1+dFdy(hh)*R2);
 normal=normalize(abs(fDet)*normal-.0009*vG);
 float rim=pow(1.-clamp(dot(normal,normalize(vViewPosition)),0.,1.),2.5);
 totalEmissiveRadiance+=vec3(.07,.022,.012)*rim;}`);
  };
  m.customProgramCacheKey=()=>useAttr?'skinv1a':'skinv1';
  return m;
}
// Measures the real steering-wheel rim from the wheel mesh (positions relative to the wheel centre) so the hands grip it exactly.
// Works on the outer ring of the wheel in 5-degree sectors; the median over the sectors ignores the spokes and hub.
function measureWheelRim(pos){
  const H=HandsGeo,UPv=H.UP,AXv=H.AX,n=pos.length/3;
  const U=new Float32Array(n),W=new Float32Array(n),A=new Float32Array(n);
  const rho0=new Float32Array(n);
  for(let i=0;i<n;i++){
    const x=pos[i*3],y=pos[i*3+1],z=pos[i*3+2];
    U[i]=x;W[i]=y*UPv[1]+z*UPv[2];A[i]=y*AXv[1]+z*AXv[2];rho0[i]=Math.hypot(U[i],W[i]);
  }
  const sorted=Array.from(rho0).sort((a,b)=>a-b),rmax=sorted[Math.floor(n*.995)];
  if(!(rmax>.1&&rmax<.3))return null;
  const NB=72,med=a=>{a=a.filter(v=>isFinite(v)).sort((p,q)=>p-q);return a.length?a[a.length>>1]:NaN};
  let ox=0,oy=0;
  for(let pass=0;pass<2;pass++){
    const bo=new Array(NB).fill(-1e9),bi=new Array(NB).fill(1e9),a0=new Array(NB).fill(1e9),a1=new Array(NB).fill(-1e9),cnt=new Array(NB).fill(0);
    for(let i=0;i<n;i++){
      const u=U[i]-ox,w=W[i]-oy,r=Math.hypot(u,w);if(r<rmax*.7)continue;
      const b=Math.min(NB-1,Math.floor((Math.atan2(u,w)+Math.PI)/(2*Math.PI)*NB));
      if(r>bo[b])bo[b]=r;if(r<bi[b])bi[b]=r;if(A[i]<a0[b])a0[b]=A[i];if(A[i]>a1[b])a1[b]=A[i];cnt[b]++;
    }
    const ok=b=>cnt[b]>3;
    if(pass===0){        // centre of the outer edge: the mean of R(phi)*dir(phi) over a full circle is c/2
      let sx=0,sy=0,k=0;
      for(let b=0;b<NB;b++)if(ok(b)){const ph=(b+.5)/NB*2*Math.PI-Math.PI;sx+=bo[b]*Math.sin(ph);sy+=bo[b]*Math.cos(ph);k++}
      if(k<NB*.8)return null;ox+=2*sx/k;oy+=2*sy/k;
    }else{
      const f=arr=>med(arr.filter((v,b)=>ok(b)));
      const ro=f(bo),ri=f(bi),aa0=f(a0),aa1=f(a1);
      if(![ro,ri,aa0,aa1].every(isFinite))return null;
      return{ring:(ro+ri)/2,rx:(ro-ri)/2,ra:(aa1-aa0)/2,s0:(aa0+aa1)/2,ox,oy};
    }
  }
  return null;
}
function buildHands(inte,pivot,opt){
  if(!DRIVER_HANDS)return;
  const H=HandsGeo;
  try{const wm=pivot.children[0],rim=wm&&wm.geometry&&measureWheelRim(wm.geometry.attributes.position.array);if(rim)H.setRim(rim)}catch(e){}
  const skinM=skinify(new THREE.MeshPhongMaterial({color:0xc99371,vertexColors:true,specular:0x261c17,shininess:12}));
  const armM=skinify(new THREE.MeshPhongMaterial({color:0xc99371,specular:0x261c17,shininess:12}),true);
  const sleeveM=new THREE.MeshPhongMaterial({color:0x2b3340,specular:0x0c0c0c,shininess:4,side:THREE.DoubleSide});
  const setup=(m,parent)=>{m.frustumCulled=false;m.castShadow=false;m.receiveShadow=false;m.renderOrder=32;m.visible=cockpitOn;parent.add(m);handParts.push(m);return m};
  const toGeo=G=>{const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(new Float32Array(G.p),3));
    g.setAttribute('normal',new THREE.BufferAttribute(new Float32Array(G.n),3));
    g.setAttribute('color',new THREE.BufferAttribute(new Float32Array(G.c),3));
    g.setIndex(new THREE.BufferAttribute(G.p.length/3>65535?new Uint32Array(G.i):new Uint16Array(G.i),1));return g};
  const dynGeo=M=>{const g=new THREE.BufferGeometry();
    g.setAttribute('position',new THREE.BufferAttribute(M.pos,3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal',new THREE.BufferAttribute(M.nor,3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('skinP',new THREE.BufferAttribute(M.sk,3).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(M.idx,1));return g};
  const wV=new THREE.Vector3(),tV=new THREE.Vector3(),aV=new THREE.Vector3();
  // shoulder -> elbow -> wrist for one arm, written into its rig buffers (all in interior-mesh space)
  const solve=a=>{
    wV.copy(a.cuff).applyQuaternion(pivot.quaternion).add(pivot.position);                // wrist in interior-mesh space
    tV.set(a.axes.eT[0],a.axes.eT[1],a.axes.eT[2]).applyQuaternion(pivot.quaternion);     // across the wrist (thumb side)
    aV.set(a.axes.eA[0],a.axes.eA[1],a.axes.eA[2]).applyQuaternion(pivot.quaternion);     // from the knuckles towards the wrist = where the forearm comes from
    const W=[wV.x,wV.y,wV.z],E=H.elbow(a.S,W,a.s);
    a.rig.update(a.S,E,W,[tV.x,tV.y,tV.z],[aV.x,aV.y,aV.z]);
  };
  const arms=[];
  for(const s of [1,-1]){
    if(DRIVER_HANDS<2&&s<0)continue;
    if(opt&&opt.only&&opt.only!==s)continue;
    const g=H.grip(s);
    setup(new THREE.Mesh(toGeo(g.skin),skinM),pivot);
    const a={s,S:(opt&&opt.S&&opt.S[s])||H.SHOULDER(s),cuff:new THREE.Vector3(g.cuff[0],g.cuff[1],g.cuff[2]),axes:g.axes,rig:H.ArmRig(s)};
    solve(a);                                                                              // fills the buffers and picks the triangle winding
    a.skinGeo=dynGeo(a.rig.skin);a.sleeveGeo=dynGeo(a.rig.sleeve);
    setup(new THREE.Mesh(a.skinGeo,armM),inte);
    setup(new THREE.Mesh(a.sleeveGeo,sleeveM),inte);
    const sh=setup(new THREE.Mesh(new THREE.SphereGeometry(.058,20,14),sleeveM),inte);sh.position.set(a.S[0],a.S[1],a.S[2]);a.sh=sh;
    arms.push(a);
  }
  armUpd=()=>{
    for(const a of arms){
      solve(a);
      for(const g of [a.skinGeo,a.sleeveGeo]){g.attributes.position.needsUpdate=true;g.attributes.normal.needsUpdate=true;g.attributes.skinP.needsUpdate=true}
    }
  };
  return arms;
}
// Splits the steering wheel (its own connected pieces inside the interior mesh) into a separate mesh that can rotate around the column axis.
function splitSteeringWheel(mesh,C,Ax){
  let g=mesh.geometry;if(g.index)g=g.toNonIndexed();
  const pos=g.attributes.position,vc=pos.count,n=Math.floor(vc/3);
  const ids=new Int32Array(vc),map=new Map();
  for(let i=0;i<vc;i++){const k=Math.round(pos.getX(i)*1e4)+','+Math.round(pos.getY(i)*1e4)+','+Math.round(pos.getZ(i)*1e4);let id=map.get(k);if(id===undefined){id=map.size;map.set(k,id)}ids[i]=id}
  const par=new Int32Array(map.size);for(let i=0;i<par.length;i++)par[i]=i;
  const find=a=>{while(par[a]!==a){par[a]=par[par[a]];a=par[a]}return a};
  const uni=(a,b)=>{a=find(a);b=find(b);if(a!==b)par[b]=a};
  for(let t=0;t<n;t++){uni(ids[t*3],ids[t*3+1]);uni(ids[t*3+1],ids[t*3+2])}
  const bb=new Map();
  for(let i=0;i<vc;i++){const r=find(ids[i]),x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);let b=bb.get(r);if(!b){b=[x,y,z,x,y,z];bb.set(r,b)}else{if(x<b[0])b[0]=x;if(y<b[1])b[1]=y;if(z<b[2])b[2]=z;if(x>b[3])b[3]=x;if(y>b[4])b[4]=y;if(z>b[5])b[5]=z}}
  const wheelRoot=new Set();
  for(const [r,b] of bb){if(b[0]>=.15&&b[3]<=.55&&b[1]>=.52&&b[4]<=.9&&b[2]>=.28&&(b[2]+b[5])/2<.43)wheelRoot.add(r)}
  const wt=[],rt=[];
  for(let t=0;t<n;t++)(wheelRoot.has(find(ids[t*3]))?wt:rt).push(t);
  if(wt.length<4000||wt.length>12000)throw new Error('steering wheel selection looks wrong ('+wt.length+' tris)');
  const triMat=new Int16Array(n);
  if(g.groups&&g.groups.length)for(const gr of g.groups)for(let t=gr.start/3;t<(gr.start+gr.count)/3;t++)triMat[t]=gr.materialIndex;
  const build=tl=>{const ng=new THREE.BufferGeometry();
    for(const name in g.attributes){const a=g.attributes[name],s=a.itemSize,arr=new a.array.constructor(tl.length*3*s);let o=0;
      for(const t of tl)for(let k=0;k<3;k++){const vi=(t*3+k)*s;for(let c=0;c<s;c++)arr[o++]=a.array[vi+c]}
      ng.setAttribute(name,new THREE.BufferAttribute(arr,s,a.normalized))}
    let st0=0;for(let i=1;i<=tl.length;i++){if(i===tl.length||triMat[tl[i]]!==triMat[tl[st0]]){ng.addGroup(st0*3,(i-st0)*3,triMat[tl[st0]]);st0=i}}
    return ng};
  const wg=build(wt);wg.translate(-C.x,-C.y,-C.z);
  const rest=build(rt);
  mesh.geometry.dispose();mesh.geometry=rest;
  // The original interior material uses a little transparency. Keep the wheel's
  // original texture/colors, but render the separated steering wheel fully opaque.
  const solidWheelMaterial=src=>{const m=src.clone();m.transparent=false;m.opacity=1;m.alphaTest=0;m.depthWrite=true;m.depthTest=true;m.blending=THREE.NormalBlending;m.premultipliedAlpha=false;m.side=THREE.DoubleSide;m.needsUpdate=true;return m};
  const wheelMat=Array.isArray(mesh.material)?mesh.material.map(solidWheelMaterial):solidWheelMaterial(mesh.material);
  const wm=new THREE.Mesh(wg,wheelMat);wm.castShadow=true;wm.receiveShadow=true;wm.frustumCulled=false;wm.renderOrder=31;
  const pv=new THREE.Group();pv.position.copy(C);pv.add(wm);mesh.add(pv);
  return pv;
}
// Digital + analogue instrument cluster drawn on a canvas (left: tachometer + gear, right: speedometer + digital km/h)
function clDial(c,cx,cy,r,max,minor,major,labEvery,val,red,labFn,part){
  const F='Tahoma,Arial,sans-serif',A=v=>(135+270*v/max)*Math.PI/180;
  if(part!=='needle'){
    const g=c.createRadialGradient(cx,cy,r*.1,cx,cy,r);g.addColorStop(0,'#101b29');g.addColorStop(1,'#060a10');
    c.fillStyle=g;c.beginPath();c.arc(cx,cy,r,0,7);c.fill();
    c.strokeStyle='#2a3d52';c.lineWidth=5;c.beginPath();c.arc(cx,cy,r,0,7);c.stroke();
    if(red!==null){c.strokeStyle='#e5322d';c.lineWidth=9;c.beginPath();c.arc(cx,cy,r-9,A(red),A(max));c.stroke()}
    for(let v=0;v<=max+1e-6;v+=minor){const a=A(v),isMaj=Math.abs(v/major-Math.round(v/major))<1e-6,l=isMaj?20:10;
      c.strokeStyle=(red!==null&&v>=red)?'#ff6a5e':'#cfe0ee';c.lineWidth=isMaj?3.5:2;
      c.beginPath();c.moveTo(cx+Math.cos(a)*(r-18),cy+Math.sin(a)*(r-18));c.lineTo(cx+Math.cos(a)*(r-18-l),cy+Math.sin(a)*(r-18-l));c.stroke();
      if(isMaj&&Math.abs(v/labEvery-Math.round(v/labEvery))<1e-6){c.fillStyle='#e9f2fa';c.font='bold 21px '+F;c.textAlign='center';c.textBaseline='middle';c.fillText(labFn(v),cx+Math.cos(a)*(r-52),cy+Math.sin(a)*(r-52))}}
  }
  if(part!=='static'){
    const a=A(Math.max(0,Math.min(max,val)));
    c.strokeStyle='#ff3b30';c.lineWidth=6;c.lineCap='round';c.beginPath();c.moveTo(cx-Math.cos(a)*18,cy-Math.sin(a)*18);c.lineTo(cx+Math.cos(a)*(r-24),cy+Math.sin(a)*(r-24));c.stroke();c.lineCap='butt';
  }
}
// Instrument cluster layout (texture px; 3000 px per metre): two dials that fit the car's own binnacle openings (dial dia. 98.4 mm, centres 168 mm apart)
const CL_W=900,CL_H=360,CL_R=148,CL_XL=198,CL_XR=702,CL_Y=180,CL_K=CL_R/158;
let clStatic=null,clLast=-1e9;
function clAt(g,cx,cy,fn){g.save();g.translate(cx,cy);g.scale(CL_K,CL_K);fn(g);g.restore()}
function drawCluster(kmh,rpm,gear){
  if(!clx)return;
  const key=Math.round(kmh)+'|'+Math.round(rpm/40)+'|'+gear;if(key===clKey)return;
  const t=performance.now();if(t-clLast<33)return; // at most ~30 redraws + texture uploads per second
  clLast=t;clKey=key;
  const c=clx,W=CL_W,H=CL_H,F='Tahoma,Arial,sans-serif';
  if(!clStatic){ // dial faces are drawn once (everything outside the two dials stays transparent so the car's own dashboard shows through); only needles, centre discs and numbers change
    clStatic=document.createElement('canvas');clStatic.width=W;clStatic.height=H;
    const s=clStatic.getContext('2d');
    clAt(s,CL_XL,CL_Y,g=>clDial(g,0,0,158,8,.5,1,1,0,7,v=>String(v),'static'));
    clAt(s,CL_XR,CL_Y,g=>clDial(g,0,0,158,280,10,20,40,0,null,v=>String(v),'static'));
  }
  c.clearRect(0,0,W,H);c.drawImage(clStatic,0,0);
  // tachometer (x1000 rpm) – left dial (as seen by the driver)
  clAt(c,CL_XL,CL_Y,g=>{
    clDial(g,0,0,158,8,.5,1,1,rpm/1000,7,v=>String(v),'needle');
    g.fillStyle='#0a1118';g.beginPath();g.arc(0,0,56,0,7);g.fill();g.strokeStyle='#ff3b30';g.lineWidth=3;g.beginPath();g.arc(0,0,56,0,7);g.stroke();
    g.fillStyle='#4fd6ff';g.font='bold 66px '+F;g.textAlign='center';g.textBaseline='middle';g.fillText(String(gear),0,-4);
    g.fillStyle='#8ea5b8';g.font='16px '+F;g.fillText('x1000 rpm',0,52);
  });
  // speedometer – right dial
  clAt(c,CL_XR,CL_Y,g=>{
    clDial(g,0,0,158,280,10,20,40,kmh,null,v=>String(v),'needle');
    g.fillStyle='#0a1118';g.beginPath();g.arc(0,0,72,0,7);g.fill();g.strokeStyle='#ff3b30';g.lineWidth=3;g.beginPath();g.arc(0,0,72,0,7);g.stroke();
    g.fillStyle='#ffffff';g.font='bold 58px '+F;g.textAlign='center';g.textBaseline='middle';g.fillText(String(Math.round(kmh)),0,-10);
    g.fillStyle='#8ea5b8';g.font='17px '+F;g.fillText('km/h',0,36);
  });
  clTex.needsUpdate=true;
}
// Size optimisation: models are stored as gzip( header + skeleton + byte-shuffled numeric arrays ). This rebuilds the original file bytes.
function csUnpack(u8){
  const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
  const hl=dv.getUint32(0,true),H=JSON.parse(new TextDecoder().decode(u8.subarray(4,4+hl)));
  const sl=dv.getUint32(4+hl,true);let sp=8+hl,pp=sp+sl;
  const out=new Uint8Array(H.n);let o=0;
  for(const [st,ln,el] of H.s){
    out.set(u8.subarray(sp,sp+(st-o)),o);sp+=st-o;o=st;
    const cnt=ln/el;
    for(let j=0;j<el;j++){const base=pp+j*cnt;for(let i=0;i<cnt;i++)out[o+i*el+j]=u8[base+i]}
    pp+=ln;o+=ln;
  }
  out.set(u8.subarray(sp,sp+(H.n-o)),o);
  return out;
}
const Z85_ALPHABET='!#$%()*+,-.0123456789:=?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[]^_abcdefghijklmnopqrstuvwxyz{|}~';
const Z85_LOOKUP=(()=>{const t=new Int16Array(128);t.fill(-1);for(let i=0;i<Z85_ALPHABET.length;i++)t[Z85_ALPHABET.charCodeAt(i)]=i;return t})();
function z85Decode(data,byteLength){
  if(typeof data!=='string'||data.length%5!==0)throw new Error('Invalid embedded asset encoding');
  const fullLength=(data.length/5)*4;
  if(!Number.isInteger(byteLength)||byteLength<0||byteLength>fullLength)throw new Error('Invalid embedded asset length');
  const out=new Uint8Array(fullLength);let p=0;
  for(let i=0;i<data.length;i+=5){
    const c0=data.charCodeAt(i),c1=data.charCodeAt(i+1),c2=data.charCodeAt(i+2),c3=data.charCodeAt(i+3),c4=data.charCodeAt(i+4);
    if(c0>127||c1>127||c2>127||c3>127||c4>127)throw new Error('Invalid embedded asset character');
    const a=Z85_LOOKUP[c0],b=Z85_LOOKUP[c1],c=Z85_LOOKUP[c2],d=Z85_LOOKUP[c3],e=Z85_LOOKUP[c4];
    if(a<0||b<0||c<0||d<0||e<0)throw new Error('Invalid embedded asset character');
    const v=((((a*85+b)*85+c)*85+d)*85+e);
    if(v>4294967295)throw new Error('Invalid embedded asset block');
    out[p++]=(v>>>24)&255;out[p++]=(v>>>16)&255;out[p++]=(v>>>8)&255;out[p++]=v&255;
  }
  return out.subarray(0,byteLength);
}

try{
  if(typeof fflate === "undefined" || typeof fflate.gunzipSync !== "function") throw new Error("تعذر تحميل مكتبة fflate المطلوبة لقراءة FBX. تأكد من اتصال الإنترنت ثم أعد فتح الملف.");
  if(typeof THREE.FBXLoader !== "function") throw new Error("تعذر تحميل FBXLoader من CDN. تأكد من اتصال الإنترنت ثم أعد فتح الملف.");
  const loader=new THREE.FBXLoader();
  const playerFbxBytes=csUnpack(fflate.gunzipSync(z85Decode(EMBEDDED_CAR_FBX_GZIP_Z85,EMBEDDED_CAR_FBX_GZIP_BYTES)));
  const model=loader.parse(playerFbxBytes.buffer.slice(playerFbxBytes.byteOffset,playerFbxBytes.byteOffset+playerFbxBytes.byteLength),'');
  model.updateMatrixWorld(true);
  let bounds=new THREE.Box3().setFromObject(model);
  let size=bounds.getSize(new THREE.Vector3());
  const dims=[size.x,size.y,size.z];
  const longest=dims.indexOf(Math.max(...dims));
  if(longest===0) model.rotation.y=Math.PI/2;
  // The road/player forward direction is -Z; rotate the imported vehicle 180 degrees to face forward.
  model.rotation.y += Math.PI;
  model.updateMatrixWorld(true);
  bounds=new THREE.Box3().setFromObject(model);
  size=bounds.getSize(new THREE.Vector3());
  const targetLength=4.57;
  const horizontalLength=Math.max(size.x,size.z);
  model.scale.setScalar(targetLength/Math.max(horizontalLength,0.001));
  model.updateMatrixWorld(true);
  bounds=new THREE.Box3().setFromObject(model);
  const center=bounds.getCenter(new THREE.Vector3());
  model.position.x-=center.x;
  model.position.z-=center.z;
  model.position.y-=bounds.min.y;
  model.traverse(obj=>{
    // Tail-light glow: copy the rear-most triangles of the lights mesh into a red additive overlay.
    if(obj.isMesh && /Kit0_Light/i.test(obj.name||'') && obj.geometry && !obj.userData.tailDone){
      obj.userData.tailDone=true;
      try{
        const g=obj.geometry,pos=g.attributes.position,idx=g.index;
        g.computeBoundingBox();
        const zMin=g.boundingBox.min.z,lim=zMin+0.23; // rear end of the model (FBX space: rear = -Z)
        const out=[],tri=idx?idx.count/3:pos.count/3;
        for(let t=0;t<tri;t++){
          const a=idx?idx.getX(t*3):t*3,b=idx?idx.getX(t*3+1):t*3+1,c=idx?idx.getX(t*3+2):t*3+2;
          const cz=(pos.getZ(a)+pos.getZ(b)+pos.getZ(c))/3;
          if(cz<lim)out.push(pos.getX(a),pos.getY(a),pos.getZ(a),pos.getX(b),pos.getY(b),pos.getZ(b),pos.getX(c),pos.getY(c),pos.getZ(c));
        }
        const tg=new THREE.BufferGeometry();
        tg.setAttribute('position',new THREE.Float32BufferAttribute(out,3));
        const glow=new THREE.Mesh(tg,tailM);
        glow.renderOrder=10;glow.castShadow=false;glow.receiveShadow=false;glow.frustumCulled=false;
        obj.add(glow);
        obj.userData.isGlowHost=true;
        console.info('Tail-light glow triangles:',out.length/9);
        // Headlamp glow: front-most, upper (y>.35) triangles of the same lights mesh -> white additive overlay
        {const zMax=g.boundingBox.max.z,hout=[];
         for(let t=0;t<tri;t++){
          const a=idx?idx.getX(t*3):t*3,b=idx?idx.getX(t*3+1):t*3+1,c=idx?idx.getX(t*3+2):t*3+2;
          const cz=(pos.getZ(a)+pos.getZ(b)+pos.getZ(c))/3,cy=(pos.getY(a)+pos.getY(b)+pos.getY(c))/3;
          if(cz>zMax-.4&&cy>.35)hout.push(pos.getX(a),pos.getY(a),pos.getZ(a),pos.getX(b),pos.getY(b),pos.getZ(b),pos.getX(c),pos.getY(c),pos.getZ(c));
         }
         const hg=new THREE.BufferGeometry();hg.setAttribute('position',new THREE.Float32BufferAttribute(hout,3));
         const hglow=new THREE.Mesh(hg,headM);hglow.renderOrder=10;hglow.castShadow=false;hglow.receiveShadow=false;hglow.frustumCulled=false;obj.add(hglow);
         console.info('Headlamp glow triangles:',hout.length/9);}
      }catch(e){console.warn('tail glow failed',e)}
    }
    if(obj.isMesh && (obj.material===tailM||obj.material===headM))return;
    if(obj.isMesh){
      obj.castShadow=true;
      obj.receiveShadow=true;
      if(obj.material){
        const materials=Array.isArray(obj.material)?obj.material:[obj.material];
        const paintSignature=[obj.name||"",...materials.map(m=>m&&m.name||"")].join(" ");
        // These are the Lancer exterior body-paint slots in the embedded FBX.
        // Avoid glass, lamps, wheels, carbon trim, grille and interior materials.
        if(/PaintTNR|Kit0_Paint|Hood0a_Paint|Wing0a_Paint/i.test(paintSignature) && !/Window|Glass|Light|Wheel|Interior|Carbon|Grille|Badge/i.test(paintSignature)){
          materials.forEach(m=>{
            if(!m||!m.color)return;
            paintMaterials.add(m);
            // Keep the exact imported finish so the matte option restores the original look.
            if(!paintMaterialDefaults.has(m))paintMaterialDefaults.set(m,{
              specular:m.specular&&m.specular.clone?m.specular.clone():null,
              shininess:m.shininess,
              roughness:m.roughness,
              metalness:m.metalness,
              reflectivity:m.reflectivity,
              clearcoat:m.clearcoat,
              clearcoatRoughness:m.clearcoatRoughness
            });
          });
        }
        materials.forEach(m=>{if(m){m.side=THREE.DoubleSide;m.needsUpdate=true;}});
      }
    }
  });
  car.add(model);
  car.updateMatrixWorld(true);
  // ---- wheel rig: each wheel assembly (tyre + rim) gets a steer pivot (front only) and a spin pivot ----
  // NOTE: FBXLoader renames nodes ("3DWheel Front L" -> "3DWheel_Front_L"), so match spaces or underscores.
  const wheelNodes=[];
  model.traverse(o=>{if(/3DWheel[\s_]*(Front|Rear)/i.test(o.name||''))wheelNodes.push(o)});
  for(const wn of wheelNodes){
    const box=new THREE.Box3();
    for(const c of wn.children){box.expandByObject(c)}
    if(box.isEmpty())box.setFromObject(wn);
    const centre=car.worldToLocal(box.getCenter(new THREE.Vector3()));
    const steerG=new THREE.Group(),spinG=new THREE.Group();
    steerG.position.copy(centre);
    car.add(steerG);steerG.add(spinG);
    car.updateMatrixWorld(true);
    spinG.attach(wn);            // keeps the wheel exactly where it was
    spinG.userData.rear=!/Front/i.test(wn.name);
    wheels.push(spinG);          // spins around the axle (X)
    if(/Front/i.test(wn.name))pivots.push(steerG); // front wheels also turn left/right
  }
  console.info('Wheel assemblies found:',wheels.length,'front pivots:',pivots.length);
  // ---- rear glass: black tint (50% opaque) laid over the rear-window triangles of the glass mesh ----
  try{
    let rgCount=0;
    model.traverse(o=>{
      if(!o.isMesh||o.userData.rearGlassDone||!o.geometry||!/Window/i.test(o.name||'')||/Inside|Wheel|RearGlassBlack/i.test(o.name||''))return;
      o.userData.rearGlassDone=true;
      const g=o.geometry,pos=g.attributes.position,nor=g.attributes.normal,uv=g.attributes.uv,idx=g.index;
      if(!pos)return;
      g.computeBoundingBox();const bb=g.boundingBox,zLim=bb.min.z+(bb.max.z-bb.min.z)*.38; // FBX space: rear = -Z
      const P=[],N=[],U=[],tri=idx?idx.count/3:pos.count/3,V=[new THREE.Vector3(),new THREE.Vector3(),new THREE.Vector3()],e1=new THREE.Vector3(),e2=new THREE.Vector3();
      for(let t=0;t<tri;t++){
        const id=[0,1,2].map(k=>idx?idx.getX(t*3+k):t*3+k);
        for(let k=0;k<3;k++)V[k].fromBufferAttribute(pos,id[k]);
        if((V[0].z+V[1].z+V[2].z)/3>zLim)continue;
        e1.subVectors(V[1],V[0]);e2.subVectors(V[2],V[0]);e1.cross(e2).normalize();
        if(Math.abs(e1.z)<.3)continue; // only faces that look backwards (rear screen), not side glass
        for(let k=0;k<3;k++){P.push(V[k].x,V[k].y,V[k].z);if(nor)N.push(nor.getX(id[k]),nor.getY(id[k]),nor.getZ(id[k]));if(uv)U.push(uv.getX(id[k]),uv.getY(id[k]))}
      }
      if(!P.length)return;
      const rg=new THREE.BufferGeometry();
      rg.setAttribute('position',new THREE.Float32BufferAttribute(P,3));
      if(N.length)rg.setAttribute('normal',new THREE.Float32BufferAttribute(N,3));else rg.computeVertexNormals();
      if(U.length)rg.setAttribute('uv',new THREE.Float32BufferAttribute(U,2));
      const rm=new THREE.MeshPhongMaterial({name:'RearGlassBlack_Window',color:0x020304,specular:0xffffff,shininess:240,transparent:true,opacity:.5,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2});
      const rmesh=new THREE.Mesh(rg,rm);rmesh.name='RearGlassBlack_Window';rmesh.renderOrder=5;rmesh.castShadow=false;rmesh.receiveShadow=false;rmesh.frustumCulled=false;
      o.add(rmesh);rgCount+=P.length/9;
    });
    console.info('Rear glass triangles tinted:',rgCount);
  }catch(e){console.warn('rear glass tint failed',e)}
  // ---- cockpit: driver eye point, rotating steering wheel, digital instrument cluster ----
  try{
    let inte=null;
    model.traverse(o=>{if(o.isMesh&&/Interior_Geo_lodA_Interior_Geo/i.test(o.name||''))inte=o;
      if(o.isMesh&&/Window/i.test(o.name||'')&&!/Wheel/i.test(o.name||''))cockpitGlass.push(o)});
    if(!inte)throw new Error('interior mesh not found');
    car.updateMatrixWorld(true);inte.updateMatrixWorld(true);
    mirrorHost=inte;

    // ---- realistic black/grey cabin finish + fully opaque interior surfaces ----
    // The main interior atlas carries the original dashboard, door-card and control details.
    // A neutral graphite tint keeps those details while moving the cabin to a black/grey palette.
    const solidInteriorMaterial=(source,tint)=>{
      if(!source)return source;
      const m=source.clone();
      if(m.color && m.color.setHex)m.color.setHex(tint);
      m.transparent=false;
      m.opacity=1;
      m.alphaTest=0;
      m.depthWrite=true;
      m.depthTest=true;
      m.blending=THREE.NormalBlending;
      m.premultipliedAlpha=false;
      m.side=THREE.DoubleSide;
      if('transmission' in m)m.transmission=0;
      if('roughness' in m)m.roughness=.84;       // matte leather / soft-touch plastic
      if('metalness' in m)m.metalness=.02;
      if('shininess' in m)m.shininess=24;
      m.needsUpdate=true;
      return m;
    };
    // InteriorA contains the seats, rear bench, dashboard and inner door panels.
    // Keep its UV textures (stitching, buttons, labels and instrument details) intact.
    inte.material=Array.isArray(inte.material)
      ?inte.material.map(m=>solidInteriorMaterial(m,0x9da2a9))
      :solidInteriorMaterial(inte.material,0x9da2a9);

    // The separate colour-zone mesh is used for darker interior trim / seat inserts.
    // Seat belts stay visible in a muted grey instead of inheriting any accidental alpha.
    const interiorAccentMeshes=[];
    model.traverse(o=>{
      if(!o.isMesh)return;
      const n=o.name||'';
      if(/InteriorTillingColourZone/i.test(n))interiorAccentMeshes.push({mesh:o,tint:0x42474f});
      else if(/SeatBelt_Geo_lodA_SeatBelt_Geo/i.test(n))interiorAccentMeshes.push({mesh:o,tint:0x70767e});
    });
    for(const entry of interiorAccentMeshes){
      const mesh=entry.mesh;
      mesh.material=Array.isArray(mesh.material)
        ?mesh.material.map(m=>solidInteriorMaterial(m,entry.tint))
        :solidInteriorMaterial(mesh.material,entry.tint);
      mesh.castShadow=true;mesh.receiveShadow=true;
    }

    // Do not remove the separate dashboard nameplate surface here:
    // the requested Mitsubishi Motors card belongs to the instrument-cluster emissive texture.
    const mitsuBadgeTextures=[];
    const intMats=Array.isArray(inte.material)?inte.material:[inte.material];
    for(const im of intMats){
      if(im){im.transparent=false;im.opacity=1;im.alphaTest=0;im.depthWrite=true;im.depthTest=true;im.blending=THREE.NormalBlending;im.premultipliedAlpha=false;im.side=THREE.DoubleSide;im.needsUpdate=true;}
      if(!im)continue;
      const tx=im.emissiveMap;
      if(tx && (/InteriorA/i.test(im.name||'') || /InteriorA_Emissive/i.test(tx.name||'')) && !mitsuBadgeTextures.includes(tx)){
        mitsuBadgeTextures.push(tx);
      }
    }
    eraseMitsubishiClusterBadge=function(){
      let changed=false;
      for(const tx of mitsuBadgeTextures){
        if(!tx || (tx.userData && tx.userData.__mitsuClusterBadgeRemoved))continue;
        const image=tx.image;
        const w=image&&(image.naturalWidth||image.videoWidth||image.width);
        const h=image&&(image.naturalHeight||image.videoHeight||image.height);
        // The Mitsubishi badge is the dedicated top-left card in the 512x512
        // InteriorA emissive atlas (about 50.5% wide by 28.3% high).
        if(!image || !w || !h)continue;
        try{
          const canvas=document.createElement('canvas');
          canvas.width=w;canvas.height=h;
          const cx=canvas.getContext('2d');
          cx.drawImage(image,0,0,w,h);
          cx.fillStyle='#000000';
          cx.fillRect(0,0,Math.round(w*.505),Math.round(h*.283));
          tx.image=canvas;
          tx.needsUpdate=true;
          tx.userData=tx.userData||{};
          tx.userData.__mitsuClusterBadgeRemoved=true;
          changed=true;
          console.info('Removed Mitsubishi Motors badge from instrument-cluster emissive texture');
        }catch(err){console.warn('Could not patch Mitsubishi cluster badge texture:',err)}
      }
      return changed;
    };
    mitsuClusterBadgeRemoved=eraseMitsubishiClusterBadge();
    // eye position of the driver (left seat), above/behind the steering wheel, in car-local coordinates (FBX interior space -> car space)
    EYE=car.worldToLocal(inte.localToWorld(new THREE.Vector3(COCKPIT_EYE[0],COCKPIT_EYE[1],COCKPIT_EYE[2])));
    // warm roof (dome) light: low-intensity, short-range point light in the middle of the cabin so the inside is gently lit
    try{const dome=new THREE.PointLight(0xffd9a8,.8,3.2,1.8);dome.visible=!!isNight;window._dome=dome;dome.position.copy(car.worldToLocal(inte.localToWorld(new THREE.Vector3(0,1.2,-.15))));dome.name='cabinDomeLight';car.add(dome);
      // visible lamp fixture: housing + glowing lens + soft halo, stuck to the underside of the roof (found by a ray cast straight up)
      try{
        model.updateMatrixWorld(true);
        const w0=inte.localToWorld(new THREE.Vector3(0,1.2,-.15)),rc=new THREE.Raycaster(w0,new THREE.Vector3(0,1,0),.02,1),sides=[],meshes=[];
        model.traverse(o=>{if(o.isMesh&&o.visible&&!/Window|Wheel|RearGlass/i.test(o.name||'')){meshes.push(o);for(const m of(Array.isArray(o.material)?o.material:[o.material]))if(m){sides.push([m,m.side]);m.side=THREE.DoubleSide}}});
        const hit=rc.intersectObjects(meshes,false)[0];
        for(const [m,sd] of sides)m.side=sd;
        const wp=hit?hit.point.clone():w0.clone().add(new THREE.Vector3(0,.14,0));
        const lp=car.worldToLocal(wp.clone());
        const fx=new THREE.Group();fx.name='cabinDomeFixture';fx.position.copy(lp).add(new THREE.Vector3(0,-.002,0));
        const rr=(w,h,r)=>{const sh=new THREE.Shape(),x=-w/2,y=-h/2;sh.moveTo(x+r,y);sh.lineTo(x+w-r,y);sh.quadraticCurveTo(x+w,y,x+w,y+r);sh.lineTo(x+w,y+h-r);sh.quadraticCurveTo(x+w,y+h,x+w-r,y+h);sh.lineTo(x+r,y+h);sh.quadraticCurveTo(x,y+h,x,y+h-r);sh.lineTo(x,y+r);sh.quadraticCurveTo(x,y,x+r,y);return sh};
        const ext=(sh,d)=>new THREE.ExtrudeGeometry(sh,{depth:d,bevelEnabled:false,curveSegments:8}).rotateX(Math.PI/2); // plan in XZ, extruded downward
        const hous=new THREE.Mesh(ext(rr(.13,.056,.016),.01),new THREE.MeshPhongMaterial({color:0x3a3c40,specular:0x2a2a2a,shininess:25}));
        const lens=new THREE.Mesh(ext(rr(.105,.038,.011),.003),new THREE.MeshBasicMaterial({color:0xe9dcc2,toneMapped:false,fog:false}));lens.position.y=-.01;
        for(const o of [hous,lens]){o.castShadow=false;o.receiveShadow=false}
        fx.add(hous,lens);fx.visible=!!isNight;car.add(fx);window._domeFix=fx;
        dome.position.copy(lp).add(new THREE.Vector3(0,-.28,0));
        dome.intensity=.8;
        console.info('Dome lamp fixture placed',hit?'on roof':'fallback');
      }catch(e){console.warn('dome fixture failed',e)}
    }catch(e){console.warn('dome light failed',e)}
    const C=new THREE.Vector3(.3497,.7174,.3858),Ax=new THREE.Vector3(0,.3559,-.9345).normalize(); // wheel centre and column axis (pointing at the driver)
    try{swPivot=splitSteeringWheel(inte,C,Ax);swAxis=Ax}catch(e){console.warn('steering wheel split failed',e)}
    try{if(swPivot)buildHands(inte,swPivot)}catch(e){console.warn('driver hands failed',e)}
    // Instrument cluster: placed in the car's own binnacle (behind the steering wheel, on the steering-column axis), exactly on the plane of the
    // two original dial faces (measured on the interior mesh: centre x=.351,y=.724,z=.690; face normal tilted 14.4deg toward the driver; dials 98.4 mm dia., 168 mm apart).
    // Normal depth testing is ON, so the steering wheel, the driver's hands and the dashboard hood all correctly cover it.
    const cvs=document.createElement('canvas');cvs.width=CL_W;cvs.height=CL_H;clx=cvs.getContext('2d');
    clTex=new THREE.CanvasTexture(cvs);clTex.anisotropy=ANISO;
    const faceC=new THREE.Vector3(.351,.724,.690),faceN=new THREE.Vector3(0,.2489,-.9685).normalize(); // dial-face centre, normal toward the driver
    cluster=new THREE.Group();
    cluster.position.copy(faceC).addScaledVector(faceN,.003); // 3 mm in front of the original faces (no z-fighting)
    cluster.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),faceN).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI));
    cluster.visible=false;cluster.frustumCulled=false;inte.add(cluster);
    const clusterMat=new THREE.MeshBasicMaterial({map:clTex,fog:false,side:THREE.DoubleSide,transparent:false,alphaTest:.35,depthTest:true,depthWrite:true,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
    const panelW=CL_W/3000,panelH=CL_H/3000; // .30 x .12 m
    const display=new THREE.Mesh(new THREE.PlaneGeometry(panelW,panelH),clusterMat);
    display.frustumCulled=false;display.castShadow=false;display.receiveShadow=false;cluster.add(display);
    cluster.userData.panelSize={width:panelW,height:panelH};
    drawCluster(0,900,'N');
    // Build shaped mirror glass instead of flat rectangular overlays. Each screen
    // gets a dark, matching bezel and an inset glass surface following its outline.
    const upV=new THREE.Vector3(0,1,0);
    function mirrorShape(w,h,kind,sx=1,sy=1){
      const a=w*.5*sx,b=h*.5*sy,sh=new THREE.Shape();
      if(kind===0){ // overhead rear-view mirror: rounded, slightly tapered ends
        sh.moveTo(-a*.80,-b);
        sh.bezierCurveTo(-a*.98,-b,-a,-b*.58,-a,-b*.10);
        sh.bezierCurveTo(-a,b*.55,-a*.90,b,a*.74,b);
        sh.bezierCurveTo(a*.98,b,a,b*.56,a,b*.10);
        sh.bezierCurveTo(a,-b*.56,a*.90,-b,a*.74,-b);
      }else{ // side mirrors: rounded housing outline
        sh.moveTo(-a*.92,-b*.12);
        sh.bezierCurveTo(-a*.99,-b*.72,-a*.58,-b,a*.08,-b*.98);
        sh.bezierCurveTo(a*.70,-b*.96,a*.99,-b*.56,a*.96,-b*.08);
        sh.bezierCurveTo(a*.99,b*.48,a*.66,b*.94,a*.12,b*.98);
        sh.bezierCurveTo(-a*.52,b*.90,-a*.94,b*.54,-a*.92,-b*.12);
      }
      sh.closePath();
      const geo=new THREE.ShapeGeometry(sh,24);
      // ShapeGeometry stores UVs in local units (the mirrors are only a few
      // centimetres wide). Normalize them to 0..1 so the render-target image
      // fills the entire mirror instead of sampling a tiny patch of its centre.
      geo.computeBoundingBox();
      const bb=geo.boundingBox,pos=geo.attributes.position,uv=geo.attributes.uv;
      const sxBox=Math.max(1e-6,bb.max.x-bb.min.x),syBox=Math.max(1e-6,bb.max.y-bb.min.y);
      for(let i=0;i<pos.count;i++)uv.setXY(i,(pos.getX(i)-bb.min.x)/sxBox,(pos.getY(i)-bb.min.y)/syBox);
      uv.needsUpdate=true;
      return geo;
    }
    for(const [c,n,w,h,rw,rh,vf,cp,off,kind] of [
      [[-.001,1.094,.343],[-.205,0,-.979],.215,.05,320,80,22.6,[0,1.3,2.4],0,0],      // rear-view mirror (optimized capture size)
      [[.9355,.853,.5955],[-.289,.01,-.957],.15,.125,160,135,46,[-1.12,1.05,-.6],-.14,1], // left door mirror
      [[-.9355,.853,.5955],[.289,.01,-.957],.15,.125,160,135,46,[1.12,1.05,-.6],.14,1]]){  // right door mirror
      const rt=new THREE.WebGLRenderTarget(rw,rh,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,generateMipmaps:false});
      rt.texture.repeat.x=-1;rt.texture.offset.x=1; // horizontal flip = real mirror image
      const N=new THREE.Vector3(...n).normalize(),U=new THREE.Vector3().crossVectors(upV,N).normalize(),W=new THREE.Vector3().crossVectors(N,U);
      const rot=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(U,W,N));
      const centre=new THREE.Vector3(...c);
      // Dark shaped surround, slightly behind the glass, visually joining it to the mount.
      const frame=new THREE.Mesh(mirrorShape(w,h,kind),new THREE.MeshBasicMaterial({color:0x171d25,fog:false,side:THREE.DoubleSide}));
      frame.position.copy(centre).addScaledVector(N,-.002);frame.quaternion.copy(rot);frame.visible=false;frame.renderOrder=5;
      inte.add(frame);mirPanels.push(frame);
      // Reflective glass now fills almost the complete housing. A very narrow
      // dark edge remains visible so the glass still reads as seated in its frame.
      const p=new THREE.Mesh(mirrorShape(w,h,kind,.985,.94),new THREE.MeshBasicMaterial({map:rt.texture,fog:false,side:THREE.DoubleSide}));
      p.position.copy(centre).addScaledVector(N,.0008);p.quaternion.copy(rot);p.visible=false;p.renderOrder=6;
      inte.add(p);mirPanels.push(p);
      const cam=new THREE.PerspectiveCamera(vf,rw/rh,.05,1800);cam.rotation.order='YXZ';
      MIRC.push({rt,cam,centre:centre.clone(),normal:N.clone(),host:inte});
    }
    console.info('Cockpit ready. glass meshes:',cockpitGlass.length,'wheel split:',!!swPivot);
  }catch(e){console.warn('cockpit setup failed',e);EYE=null}
}catch(err){
  console.error('تعذر تجهيز موديل السيارة المضمّن:',err);
  const msg=document.createElement('div');
  msg.style.cssText='position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:20;background:#8b1e1e;color:white;padding:12px 18px;border-radius:10px;font:14px Tahoma;direction:rtl;text-align:center;max-width:80vw';
  msg.textContent='حدث خطأ أثناء قراءة موديل السيارة المضمّن. افتح أدوات المطور لمعرفة التفاصيل.';
  document.body.appendChild(msg);
}
// ---- audio: engine + procedural winter ambience (wind and rain) ----
let ac,osc,gn,muted=false;
let winterMasterGain=null,winterWindSource=null,winterRainSource=null,winterGustOsc=null;
function makeWinterNoiseBuffer(kind){
  const seconds=4,length=Math.max(1,Math.floor(ac.sampleRate*seconds)),buffer=ac.createBuffer(1,length,ac.sampleRate),data=buffer.getChannelData(0);
  if(kind==='wind'){
    // Smooth brown-like noise gives the wind a low, soft, distant character.
    let brown=0;for(let i=0;i<length;i++){const white=Math.random()*2-1;brown=(brown+.022*white)/1.022;data[i]=brown*3.4;}
  }else{
    // Fine broadband noise, filtered below, creates a gentle continuous rainfall layer.
    let smooth=0;for(let i=0;i<length;i++){const white=Math.random()*2-1;smooth=smooth*.82+white*.18;data[i]=white*.82+smooth*.18;}
  }
  return buffer;
}
function createWinterAmbience(){
  if(!ac||winterMasterGain)return;
  winterMasterGain=ac.createGain();winterMasterGain.gain.value=0;winterMasterGain.connect(ac.destination);
  const windFilter=ac.createBiquadFilter();windFilter.type='lowpass';windFilter.frequency.value=340;windFilter.Q.value=.55;
  const windGain=ac.createGain();windGain.gain.value=.34;
  winterWindSource=ac.createBufferSource();winterWindSource.buffer=makeWinterNoiseBuffer('wind');winterWindSource.loop=true;
  winterWindSource.connect(windFilter);windFilter.connect(windGain);windGain.connect(winterMasterGain);
  const rainFilter=ac.createBiquadFilter();rainFilter.type='bandpass';rainFilter.frequency.value=1550;rainFilter.Q.value=.48;
  const rainGain=ac.createGain();rainGain.gain.value=.16;
  winterRainSource=ac.createBufferSource();winterRainSource.buffer=makeWinterNoiseBuffer('rain');winterRainSource.loop=true;
  winterRainSource.connect(rainFilter);rainFilter.connect(rainGain);rainGain.connect(winterMasterGain);
  // Slow wind-gust variation keeps the ambience from sounding like a static loop.
  winterGustOsc=ac.createOscillator();winterGustOsc.type='sine';winterGustOsc.frequency.value=.075;
  const gustDepth=ac.createGain();gustDepth.gain.value=.055;winterGustOsc.connect(gustDepth);gustDepth.connect(windGain.gain);
  winterWindSource.start();winterRainSource.start();winterGustOsc.start();
}
function updateWinterAmbience(){
  if(!ac)return;
  const shouldPlay=gameMode==='playing'&&weatherMode==='winter'&&winterVolume>0;
  if(shouldPlay){
    createWinterAmbience();
    if(winterMasterGain){const t=ac.currentTime;winterMasterGain.gain.cancelScheduledValues(t);winterMasterGain.gain.setTargetAtTime(winterVolume*.30,t,.22);}
  }else if(winterMasterGain){
    const t=ac.currentTime;winterMasterGain.gain.cancelScheduledValues(t);winterMasterGain.gain.setTargetAtTime(0,t,.16);
  }
}
function startAudio(){
  try{
    if(!ac){ac=new(window.AudioContext||window.webkitAudioContext)();osc=ac.createOscillator();osc.type='sawtooth';const f=ac.createBiquadFilter();f.type='lowpass';f.frequency.value=900;gn=ac.createGain();gn.gain.value=0;osc.connect(f);f.connect(gn);gn.connect(ac.destination);osc.start();}
    if(ac.state==='suspended')ac.resume().catch(()=>{});
    updateWinterAmbience();
  }catch(e){console.warn('Audio initialization failed:',e);}
}

// ---- state & input ----
const st={x:10.17,z:0,h:0,wx:0,wz:0,steer:0,thr:0,roll:0,pitch:0,cw:0};
// Frequent, varied highway bends: much shorter straights and independently randomized bend angles.
// Each bend remains a smooth S-shaped transition; the road, curbs, median, sidewalks and wall share one frame.
const roadCurveEvents=[];
let roadCurveBuiltTo=0,roadCurveSeed=0x51A7C0DE;
function roadRandom(){roadCurveSeed=(roadCurveSeed+0x6D2B79F5)|0;let t=roadCurveSeed;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296;}
function ensureRoadCurves(distance){
  const need=Math.max(0,distance)+1000;
  while(roadCurveBuiltTo<need){
    const gap=300+roadRandom()*350;             // 300–650 m of straight road between bends (was 2,000–2,500 m)
    const length=260+roadRandom()*220;           // each bend spans 260–480 m
    const peakAngleDeg=6+roadRandom()*12;        // each bend gets its own target peak angle: 6–18 degrees
    const maxBumpSlope=3.434;                    // maximum |d(64*t^3*(1-t)^3)/dt|
    const amplitude=Math.min(38,Math.max(10,Math.tan(peakAngleDeg*Math.PI/180)*length/maxBumpSlope));
    const direction=roadRandom()<.5?-1:1;        // independently choose left or right
    let start=roadCurveBuiltTo+gap;
    for(let guard=0;guard<4;guard++){            // never start/finish a bend within BRIDGE_CLEAR of a flyover (it sits on a straight)
      let moved=false;
      const k0=Math.max(1,Math.floor((start-BRIDGE_CLEAR)/BRIDGE_SPACING)),k1=Math.ceil((start+length+BRIDGE_CLEAR)/BRIDGE_SPACING);
      for(let k=k0;k<=k1;k++){const c=k*BRIDGE_SPACING;if(start<c+BRIDGE_CLEAR&&start+length>c-BRIDGE_CLEAR){start=c+BRIDGE_CLEAR;moved=true}}
      for(let k=1;k<=Math.ceil((start+length+TUN_CLEAR)/TUN_SPACING);k++){if(featKind(k)!==1)continue;const c=TUN_OFF+k*TUN_SPACING;if(start<c+TUN_CLEAR&&start+length>c-TUN_CLEAR){start=c+TUN_CLEAR;moved=true}}
      if(!moved)break;
    }
    roadCurveEvents.push({start,end:start+length,length,amplitude,direction,peakAngleDeg});
    roadCurveBuiltTo=start+length;
  }
}
function roadFrameAt(z){
  const distance=-z;
  if(distance<=0)return{x:0,slope:0};
  ensureRoadCurves(distance);
  for(let i=roadCurveEvents.length-1;i>=0;i--){
    const e=roadCurveEvents[i];
    if(distance<e.start)continue;
    if(distance>e.end)break;
    const t=Math.max(0,Math.min(1,(distance-e.start)/e.length));
    const t2=t*t,t3=t2*t,t4=t3*t,t5=t4*t;
    const bump=64*t3*(1-t)*(1-t)*(1-t);
    const slope=192*t2*(1-t)*(1-t)*(1-2*t)*e.amplitude*e.direction/e.length;
    return{x:e.amplitude*e.direction*bump,slope};
  }
  return{x:0,slope:0};
}
function roadYawAt(z){return-Math.atan(roadFrameAt(z).slope);}
const _roadCameraPosition=new THREE.Vector3(),_roadLookTarget=new THREE.Vector3();
function trackToWorld(x,y,z,out,ground){
  const frame=roadFrameAt(z),yaw=-Math.atan(frame.slope),c=Math.cos(yaw),sn=Math.sin(yaw);
  return(out||new THREE.Vector3()).set(frame.x+x*c,y+(ground?0:bridgeElevAt(x,z)),z-x*sn);
}
// The player moves in world coordinates. Road projection is only for lane checks,
// traffic interaction and streamed-road positioning; no automatic curve-following.
function worldToRoadCoords(worldX,worldZ){
  let station=worldZ,lateral=0,frame,yaw,c,sn;
  for(let i=0;i<5;i++){
    frame=roadFrameAt(station);yaw=-Math.atan(frame.slope);c=Math.cos(yaw);sn=Math.sin(yaw);
    lateral=(worldX-frame.x)*c-(worldZ-station)*sn;
    station=worldZ+lateral*sn;
  }
  frame=roadFrameAt(station);yaw=-Math.atan(frame.slope);c=Math.cos(yaw);sn=Math.sin(yaw);
  lateral=(worldX-frame.x)*c-(worldZ-station)*sn;
  return{x:lateral,z:station,frame,yaw,c,sn};
}
function playerRoadCoords(){return worldToRoadCoords(st.x,st.z);}
function placeCarOnRoad(){
  // The player must steer into bends manually; never rotate/translate the car by road curvature.
  const _E=bridgeElevAt(st.x,st.z);
  car.position.set(st.x,_E+(BIKE?0:(st.heave||0)),st.z);
  car.rotation.set(st.pitch+(_E!==0||bridgeElevAt(st.x,st.z+30)!==0||bridgeElevAt(st.x,st.z-30)!==0?Math.atan(bridgeSlopeAt(st.x,st.z)*-Math.cos(st.h)):0),st.h,st.roll);
  if(headPool){headPool.position.set(st.x,.08+_E,st.z);headPool.rotation.set(0,st.h,0)}
}
const keys={},pad={};
let view=0,ch=0,last=performance.now(),spin=0,shownS='',shownG='';
let gameMode='menu',settingsReturn='main',externalMirrorsVisible=true,engineVolume=.75;
let winterVolume=.45;try{const _wv=localStorage.getItem('corniche_winter_volume');if(_wv!==null&&Number.isFinite(Number(_wv)))winterVolume=Math.max(0,Math.min(1,Number(_wv)/100));}catch(e){}
const uiOverlay=document.getElementById('uiOverlay');
const mainMenuPanel=document.getElementById('mainMenu');
const pauseMenuPanel=document.getElementById('pauseMenu');
const settingsMenuPanel=document.getElementById('settingsMenu');
const setupMenuPanel=document.getElementById('setupMenu');
const gameOverPanel=document.getElementById('gameOverMenu');
const pauseTopButton=document.getElementById('pauseTopButton');
function clearDrivingInput(){for(const k in keys)keys[k]=0;for(const k in pad)pad[k]=0;}
/* ---- full-screen menus: uniformly scale each panel so it always fits (no scrolling, no scrollbar) ---- */
function menuFits(inner,content,s){
  inner.style.setProperty('--fit',s.toFixed(4));
  const cs=getComputedStyle(inner);
  const needH=content.offsetHeight+parseFloat(cs.paddingTop)+parseFloat(cs.paddingBottom);
  const needW=content.scrollWidth+parseFloat(cs.paddingLeft)+parseFloat(cs.paddingRight);
  return needH<=inner.clientHeight+.5&&needW<=inner.clientWidth+.5;
}
function fitMenuPanel(panel){
  if(!panel||panel.classList.contains('hidden'))return;
  const inner=panel.querySelector('.mp-inner'),content=inner&&inner.querySelector('.mp-content');
  if(!inner||!content)return;
  let s=1;
  if(!menuFits(inner,content,1)){
    let lo=.3,hi=1;
    for(let i=0;i<9;i++){const mid=(lo+hi)/2;if(menuFits(inner,content,mid))lo=mid;else hi=mid}
    s=lo;
  }
  inner.style.setProperty('--fit',s.toFixed(4));
  inner.scrollTop=inner.scrollLeft=panel.scrollTop=panel.scrollLeft=0;
}
function fitMenus(){document.querySelectorAll('#uiOverlay .menu-panel').forEach(fitMenuPanel)}
addEventListener('resize',fitMenus);
addEventListener('orientationchange',()=>setTimeout(fitMenus,120));
if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fitMenus);
(function(){let t=0;const re=()=>{cancelAnimationFrame(t);t=requestAnimationFrame(fitMenus)};
  new MutationObserver(re).observe(document.getElementById('uiOverlay'),{childList:true,subtree:true,characterData:true})})();
document.addEventListener('scroll',e=>{const t=e.target;if(t&&t.classList&&(t.classList.contains('menu-panel')||t.classList.contains('mp-inner')||t===document)){if(t.scrollTop)t.scrollTop=0;if(t.scrollLeft)t.scrollLeft=0}},true);

function showMenuPanel(panel){
  try{drvFillStats()}catch(e){}
  uiOverlay.classList.remove('hidden');
  mainMenuPanel.classList.toggle('hidden',panel!=='main');
  setupMenuPanel.classList.toggle('hidden',panel!=='setup');
  pauseMenuPanel.classList.toggle('hidden',panel!=='pause');
  settingsMenuPanel.classList.toggle('hidden',panel!=='settings');
  gameOverPanel.classList.toggle('hidden',panel!=='over');
  pauseTopButton.classList.toggle('visible',gameMode==='playing');
  fitMenus();requestAnimationFrame(fitMenus);
}
function setCarPaintColor(hex){
  if(!/^#[0-9a-f]{6}$/i.test(hex))return;
  activePaintColor=hex;
  const color=new THREE.Color(hex);
  paintMaterials.forEach(m=>{if(m&&m.color){m.color.copy(color);m.needsUpdate=true;}});
  window._paintLum=.2126*color.r+.7152*color.g+.0722*color.b;
  try{applyCarGloss()}catch(e){}
  document.querySelectorAll('[data-car-color]').forEach(b=>b.classList.toggle('active',b.dataset.carColor.toLowerCase()===hex.toLowerCase()));
}
function setCarPaintFinish(finish){
  if(finish!=="matte"&&finish!=="gloss")return;
  activePaintFinish=finish;
  paintMaterials.forEach(m=>{
    if(!m)return;
    const base=paintMaterialDefaults.get(m)||{};
    if(finish==="gloss"){
      // Glossy automotive clear-coat: bright specular highlights and a smoother surface.
      if(m.specular&&m.specular.setHex)m.specular.setHex(0x8c8c8c);
      if('shininess' in m)m.shininess=260;
      if('roughness' in m)m.roughness=0.08;
      if('metalness' in m)m.metalness=0.5;
      if('reflectivity' in m)m.reflectivity=0.95;
      if('clearcoat' in m)m.clearcoat=0.9;
      if('clearcoatRoughness' in m)m.clearcoatRoughness=0.12;
    }else{
      // Restore each imported material's original values: matte remains exactly as before.
      if(base.specular&&m.specular&&m.specular.copy)m.specular.copy(base.specular);
      if(base.shininess!==undefined)m.shininess=base.shininess;
      if(base.roughness!==undefined)m.roughness=base.roughness;
      if(base.metalness!==undefined)m.metalness=base.metalness;
      if(base.reflectivity!==undefined)m.reflectivity=base.reflectivity;
      if(base.clearcoat!==undefined)m.clearcoat=base.clearcoat;
      if(base.clearcoatRoughness!==undefined)m.clearcoatRoughness=base.clearcoatRoughness;
    }
    m.needsUpdate=true;
  });
  applyCarGloss();
  document.querySelectorAll('[data-car-finish]').forEach(b=>{
    const active=b.dataset.carFinish===finish;
    b.classList.toggle('active',active);
    b.setAttribute('aria-checked',active?'true':'false');
  });
}
function setExternalMirrorsVisible(on){
  externalMirrorsVisible=!!on;
  const toggle=document.getElementById('externalMirrorsToggle');
  if(toggle)toggle.checked=externalMirrorsVisible;
  if(!externalMirrorsVisible){for(const m of MIR)m.el.style.display='none';mirShown=false;}
}
function deformRoadPartForCurve(mesh,segmentZ,centerFrame,centerYaw){
  // First call: bake the part's original local transform into a private geometry. After that the SAME geometry is
  // re-warped in place whenever its segment is recycled (no clone / computeVertexNormals / dispose, no GC, no GPU buffer churn).
  const U=mesh.userData;
  if(!U._roadBase){
    mesh.updateMatrix();
    const geo=mesh.geometry.clone();
    geo.applyMatrix4(mesh.matrix);
    mesh.geometry=geo;
    U._roadBase=geo.attributes.position.array.slice();
    mesh.position.set(0,0,0);mesh.rotation.set(0,0,0);mesh.scale.set(1,1,1);
    mesh.updateMatrix();
  }
  const geo=mesh.geometry,position=geo.attributes.position,arr=position.array,base=U._roadBase;
  const cc=Math.cos(centerYaw),cs=Math.sin(centerYaw);
  let lastZ=NaN,frame=null,c=1,sn=0;
  for(let i=0;i<arr.length;i+=3){
    const lateral=base[i],localY=base[i+1],worldZ=segmentZ+base[i+2];
    if(worldZ!==lastZ){lastZ=worldZ;frame=roadFrameAt(worldZ);const yaw=-Math.atan(frame.slope);c=Math.cos(yaw);sn=Math.sin(yaw)}
    // Same mapping used by trackToWorld(): every road vertex follows the centreline frame.
    const worldX=frame.x+lateral*c;
    const curvedWorldZ=worldZ-lateral*sn;
    const dx=worldX-centerFrame.x;
    const dz=curvedWorldZ-segmentZ;
    const tF=tunnelF(worldZ);
    // tunHide parts (median lamps, grass, bushes, light pools) are dropped far below the road inside the tunnel; tunSink parts (road, curbs, sidewalks, sea wall) go down with the road
    const tY=tF>0?(U.tunHide?-Math.min(1,tF*25)*60:(!U.noElev||U.tunSink)?-TUN_D*tF:0):0;
    arr[i]=cc*dx-cs*dz;arr[i+1]=(U.trench?localY-BR_DIP*bridgeElev(worldZ):U.noElev?localY:localY+bridgeElev(worldZ))+tY;arr[i+2]=cs*dx+cc*dz;
  }
  position.needsUpdate=true;
  geo.computeBoundingBox();geo.computeBoundingSphere();
}
function updateSegmentRoadTransform(segment){
  _tlStFrame=-1; // lamp-station cache is stale once a segment moves
  const segmentZ=segment.g.position.z;
  // The group is aligned to the middle of its 60 m span; this reduces scenery skew,
  // while each road-related mesh itself is curved continuously along the whole span.
  const referenceZ=segmentZ-L/2;
  const frame=roadFrameAt(referenceZ),yaw=-Math.atan(frame.slope);
  segment.g.position.x=frame.x;
  segment.g.rotation.y=yaw;
  for(const part of (segment.roadParts||[]))deformRoadPartForCurve(part,segmentZ,frame,yaw);
  // Place the billboard using the road frame at the billboard's actual station, not the segment midpoint.
  // This keeps its two supports on the sidewalk and prevents it from cutting across the road on bends.
  const billboard=segment.bb&&segment.bb.grp;
  if(billboard){
    const station=segmentZ+(Number.isFinite(billboard.userData.roadOffsetZ)?billboard.userData.roadOffsetZ:-30);
    const lateral=Number.isFinite(billboard.userData.roadLateral)?billboard.userData.roadLateral:21.8;
    const billboardFrame=roadFrameAt(station),billboardYaw=-Math.atan(billboardFrame.slope);
    const bc=Math.cos(billboardYaw),bs=Math.sin(billboardYaw);
    const worldX=billboardFrame.x+lateral*bc,worldZ=station-lateral*bs;
    const dx=worldX-frame.x,dz=worldZ-segmentZ,cc=Math.cos(yaw),cs=Math.sin(yaw);
    billboard.position.set(cc*dx-cs*dz,0,cs*dx+cc*dz);
    billboard.rotation.y=billboardYaw-yaw-.7;
    billboard.updateMatrix();
  }
  segment.g.updateMatrix(); // group matrix is frozen (matrixAutoUpdate=false), refresh it explicitly
  ROADBATCH.update(segment);
}
function resetSegmentPositions(){
  const playerS=playerRoadCoords().z;
  ensureRoadCurves(Math.max(0,-playerS)+FRONT_ROAD_BUFFER+100);
  for(let i=0;i<segs.length;i++){
    segs[i].g.position.z=playerS+REAR_ROAD_BUFFER-L/2-i*L;
    updateSegmentRoadTransform(segs[i]);
  }
}
// Pointer Lock keeps the hidden mouse captured by the game while driving.
// It is requested only from a user action (Start / Resume), as required by browsers.
function lockGamePointer(){
  if(gameMode!=='playing')return;
  const canvas=renderer.domElement;
  if(!canvas||typeof canvas.requestPointerLock!=='function')return;
  try{
    const request=canvas.requestPointerLock();
    if(request&&typeof request.catch==='function')request.catch(()=>{});
  }catch(err){console.warn('Pointer Lock could not be enabled:',err);}
}
function releaseGamePointer(){
  if(document.pointerLockElement&&typeof document.exitPointerLock==='function'){
    try{document.exitPointerLock();}catch(err){console.warn('Pointer Lock could not be released:',err);}
  }
}
document.addEventListener('pointerlockchange',()=>{
  // Pressing Esc or losing the lock pauses the game, restoring the visible cursor.
  if(gameMode==='playing'&&document.pointerLockElement!==renderer.domElement)pauseGame();
});
// ===== UI sound effects (synthesised with WebAudio, no external files) =====
const UISND=(()=>{
  let c=null,master=null,last=0,lastName='',on=true;
  try{if(localStorage.getItem('corniche_ui_sound')==='0')on=false}catch(e){}
  function ctx(){
    if(!c){try{c=new(window.AudioContext||window.webkitAudioContext)();master=c.createGain();master.gain.value=.55;const comp=c.createDynamicsCompressor();master.connect(comp);comp.connect(c.destination)}catch(e){c=null}}
    if(c&&c.state==='suspended')c.resume().catch(()=>{});
    return c;
  }
  function tone(f0,f1,t,dur,type,vol,delay){
    const a=c.currentTime+(delay||0),o=c.createOscillator(),g=c.createGain();
    o.type=type||'sine';o.frequency.setValueAtTime(f0,a);if(f1&&f1!==f0)o.frequency.exponentialRampToValueAtTime(Math.max(20,f1),a+dur);
    g.gain.setValueAtTime(0.0001,a);g.gain.exponentialRampToValueAtTime(vol,a+Math.min(.008,dur/3));g.gain.exponentialRampToValueAtTime(0.0001,a+dur);
    o.connect(g);g.connect(master);o.start(a);o.stop(a+dur+.03);
  }
  const S={
    click:()=>{tone(1250,760,0,.07,'triangle',.28);tone(2600,1800,0,.03,'sine',.08)},
    hover:()=>{tone(1900,2100,0,.035,'sine',.045)},
    select:()=>{tone(660,660,0,.08,'triangle',.22);tone(990,990,0,.11,'sine',.2,.05)},
    on:()=>{tone(520,520,0,.07,'triangle',.22);tone(780,780,0,.1,'triangle',.22,.06)},
    off:()=>{tone(780,780,0,.07,'triangle',.2);tone(500,500,0,.1,'triangle',.2,.06)},
    slider:()=>{tone(1500,1500,0,.022,'square',.05)},
    start:()=>{[523.25,659.25,783.99,1046.5].forEach((f,i)=>tone(f,f,0,.2,'triangle',.24,i*.07));tone(130.8,196,0,.4,'sawtooth',.07)},
    back:()=>{tone(720,430,0,.12,'triangle',.26);tone(360,300,0,.1,'sine',.12,.04)},
    pause:()=>{tone(620,420,0,.13,'triangle',.26);tone(310,210,0,.16,'sine',.14,.03)},
    resume:()=>{tone(420,640,0,.13,'triangle',.26);tone(840,840,0,.1,'sine',.12,.07)},
    danger:()=>{tone(300,170,0,.2,'sawtooth',.16);tone(150,110,0,.22,'square',.08,.03)},
    score:()=>{tone(988,988,0,.12,'triangle',.26);tone(1318,1318,0,.14,'triangle',.26,.08);tone(1760,1760,0,.26,'sine',.24,.16);tone(3520,3520,0,.18,'sine',.06,.16)}
  };
  return{
    get enabled(){return on},
    set enabled(v){on=!!v;try{localStorage.setItem('corniche_ui_sound',on?'1':'0')}catch(e){}},
    play(name,force){
      if(!on||!S[name])return;
      const now=performance.now();
      if(!force&&now-last<(name==='hover'||name==='slider'?30:110))return;
      if(!ctx())return;
      last=now;lastName=name;try{S[name]()}catch(e){}
    }
  };
})();
(function setupUISounds(){
  const ov=document.getElementById('uiOverlay'),pb=document.getElementById('pauseTopButton');
  const kind=el=>{
    const id=el.id||'';
    if(id==='startGameBtn'||id==='restartGameBtn'||id==='beginDriveBtn'||id==='overRetryBtn')return'start';
    if(id==='setupBackBtn')return'back';
    if(id==='resumeGameBtn')return'resume';
    if(id==='settingsBackBtn')return'back';
    if(id==='pauseTopButton')return'pause';
    if(el.classList.contains('danger'))return'danger';
    if(el.matches('.time-option,.color-option,.paint-finish-option'))return'select';
    return'click';
  };
  document.addEventListener('click',e=>{
    const b=e.target.closest&&e.target.closest('button,#uiOverlay label');
    if(!b||!(ov.contains(b)||b===pb))return;
    if(b.tagName==='BUTTON')UISND.play(kind(b),true);
  },true);
  ov.addEventListener('change',e=>{const t=e.target;if(t&&t.type==='checkbox')UISND.play(t.checked?'on':'off',true)});
  ov.addEventListener('input',e=>{const t=e.target;if(t&&t.type==='range')UISND.play('slider')});
  let lastHover=null;
  const hov=e=>{if(e.pointerType&&e.pointerType!=='mouse')return;const b=e.target.closest&&e.target.closest('button');if(b&&b!==lastHover&&ov.contains(b)&&!b.disabled){lastHover=b;UISND.play('hover')}else if(!b)lastHover=null};
  ov.addEventListener('pointerover',hov);
  // gamepad / keyboard focus moves
  ov.addEventListener('focusin',e=>{if(e.target.classList&&e.target.classList.contains('gamepad-focused')===false&&document.querySelector('.gamepad-focused'))return;});
  // optional switch: UI sounds on/off
  const t=document.getElementById('uiSoundToggle');
  if(t){t.checked=UISND.enabled;t.addEventListener('change',()=>{UISND.enabled=t.checked;if(t.checked)UISND.play('on',true)})}
  // range sliders: fill the track up to the value
  const fill=r=>r.style.setProperty('--p',((r.value-r.min)/((r.max-r.min)||1)*100)+'%');
  document.querySelectorAll('input[type=range]').forEach(r=>{fill(r);r.addEventListener('input',()=>fill(r))});
})();

// ===== Score system: progress along the road + close passes =====
const DRV_POINT_PER_M=.1,DRV_NEAR_BONUS=50,DRV_NEAR_GAP=1.0;
let drvScore=0,drvDist=0,drvNear=0,drvBest=0,drvShown=-1,drvSaveAt=0;
try{drvBest=Math.max(0,parseInt(localStorage.getItem('corniche_best_score')||'0',10)||0)}catch(e){}
document.body.insertAdjacentHTML('beforeend','<div id="scoreHud" aria-live="off"><div id="scorePops"></div><div class="score-card" id="scoreCard"><div><div class="sl">النقاط</div><div class="sv" id="scoreVal">0</div></div><div class="sd" id="scoreDist">0 م</div></div></div>');
const scoreValEl=document.getElementById('scoreVal'),scoreDistEl=document.getElementById('scoreDist'),scoreCardEl=document.getElementById('scoreCard'),scorePopsEl=document.getElementById('scorePops');
const fmtNum=n=>Math.floor(n).toLocaleString('en-US');
const fmtDist=m=>m<1000?Math.floor(m)+' م':(m/1000).toFixed(2)+' كم';
function drvSave(force){
  if(drvScore>drvBest)drvBest=Math.floor(drvScore);
  const n=performance.now();if(!force&&n-drvSaveAt<2000)return;drvSaveAt=n;
  try{localStorage.setItem('corniche_best_score',String(Math.floor(drvBest)))}catch(e){}
}
function drvReset(){drvScore=0;drvDist=0;drvNear=0;drvShown=-1;scoreValEl.textContent='0';scoreDistEl.textContent='0 م';scorePopsEl.innerHTML='';
  for(const v of trafficCars){v.npPrev=undefined;v.npMin=Infinity;v.npBad=false}}
function drvRender(){
  const s=Math.floor(drvScore);
  if(s!==drvShown){drvShown=s;scoreValEl.textContent=fmtNum(s);scoreDistEl.textContent=fmtDist(drvDist)}
  if(drvScore>drvBest){drvBest=Math.floor(drvScore);drvSave(false)}
}
function drvPop(text,sub){
  const d=document.createElement('div');d.className='score-pop';d.innerHTML=text+(sub?'<small>'+sub+'</small>':'');
  scorePopsEl.appendChild(d);while(scorePopsEl.children.length>3)scorePopsEl.removeChild(scorePopsEl.firstChild);
  setTimeout(()=>d.remove(),1600);
  scoreCardEl.classList.remove('bump');void scoreCardEl.offsetWidth;scoreCardEl.classList.add('bump');
}
function drvAddProgress(m){ // m = metres driven forward this frame
  if(!(m>0)||m>25)return;
  drvDist+=m;drvScore+=m*DRV_POINT_PER_M;drvRender();
}
// minimum distance between two convex polygons given as [[x,z],...] (0 when they touch / overlap)
function polyGap(A,B){
  const segD=(p,q,r,s)=>{ // distance between segments pq and rs
    const ux=q[0]-p[0],uz=q[1]-p[1],vx=s[0]-r[0],vz=s[1]-r[1],wx=p[0]-r[0],wz=p[1]-r[1];
    const cr=ux*vz-uz*vx;
    if(cr!==0){const t=(wx*vz-wz*vx)/cr*-1,u=(wx*uz-wz*ux)/cr*-1;if(t>=0&&t<=1&&u>=0&&u<=1)return 0}
    const pt=(a,b,c)=>{const dx=c[0]-b[0],dz=c[1]-b[1],L=dx*dx+dz*dz;let t=L?((a[0]-b[0])*dx+(a[1]-b[1])*dz)/L:0;t=Math.max(0,Math.min(1,t));return Math.hypot(a[0]-(b[0]+t*dx),a[1]-(b[1]+t*dz))};
    return Math.min(pt(p,r,s),pt(q,r,s),pt(r,p,q),pt(s,p,q));
  };
  let m=Infinity;
  for(let i=0;i<A.length;i++){const p=A[i],q=A[(i+1)%A.length];
    for(let j=0;j<B.length;j++){const d=segD(p,q,B[j],B[(j+1)%B.length]);if(d<m){m=d;if(m===0)return 0}}}
  return m;
}
function drvNearPass(pr){
  if(!trafficReady)return;
  let pb=null;
  for(const v of trafficCars){
    if(!v.hull)continue;
    const rel=v.z-pr.z;
    if(Math.abs(rel)<8){
      if(v.hitTimer>0)v.npBad=true;
      if(!pb)pb=playerBody();
      const tb=trafficBody(v);
      if(tb&&Math.abs(tb.cx-pb.cx)<14){
        const g=polyGap(pb.pts,tb.pts);
        if(g<.04)v.npBad=true; // touching = a collision, not a clean pass
        else if(g<(v.npMin===undefined?Infinity:v.npMin))v.npMin=g;
      }
      if(v.npPrev!==undefined&&Math.abs(v.npPrev)<8&&(v.npPrev<0)!==(rel<0)){ // the two cars just drew level and passed each other
        if(!v.npBad&&v.npMin<DRV_NEAR_GAP){drvScore+=DRV_NEAR_BONUS;drvNear++;drvRender();drvPop('+'+DRV_NEAR_BONUS,'تجاوز خطير');drvSave(true)}
        v.npMin=Infinity;v.npBad=false;
      }
      v.npPrev=rel;
    }else{v.npPrev=undefined;v.npMin=Infinity;v.npBad=false}
  }
}
function drvFillStats(){
  const set=(id,t)=>{const e=document.getElementById(id);if(e)e.textContent=t};
  set('statBestMain',fmtNum(drvBest));set('statBestPause',fmtNum(drvBest));
  set('statScorePause',fmtNum(drvScore));set('statDistPause',fmtDist(drvDist));set('statNearPause',String(drvNear));
}


let _warmDone=false;
function warmUpGraphics(){
  if(_warmDone)return;_warmDone=true;
  try{
    try{playerHB()}catch(e){}
    const prevOn=headOn,prevCk=cockpitOn;
    setHeadlights(true);setCockpit(true);                       // headlight pools / halos and the whole cockpit are drawn once
    const tmp=[new THREE.Mesh(SIG.g,SIG.m),new THREE.Sprite(SIG.s)]; // turn-signal materials
    for(const o of tmp){o.frustumCulled=false;scene.add(o)}
    try{FX.sparks(0,-60,0,0,0,3,.5);FX.debris(0,-60,0,0,0,3,.5);FX.smoke(0,-60,0,0,0,2,.5)}catch(e){}
    renderOptimizedScene(camera);renderMirrors();
    for(const o of tmp)scene.remove(o);
    setCockpit(prevCk);setHeadlights(prevOn);
    try{loadCrashSound()}catch(e){}                              // decode the crash sound now
    try{if(_playerDentMeshes)dentMeshes(car,_playerDentMeshes,0,.62,0,0,0,1,0,.05,false)}catch(e){} // allocate dent backup buffers now
  }catch(e){console.warn('warm-up failed',e)}
}
function startGame(){
  if(gameMode==='menu'){
    gamepadOrbitYaw=0;gamepadOrbitPitch=0;
    st.x=10.17;st.z=0;st.h=0;st.wx=st.wz=0;st.steer=0;st.thr=0;st.roll=st.pitch=0;
    playerHB();reset();resetSegmentPositions();
    resetTrafficFleet();
    drvReset();
    placeCarOnRoad();
    policeBegin();
  }
  gameMode='playing';document.body.classList.add('game-playing');clearDrivingInput();uiOverlay.classList.add('hidden');pauseTopButton.classList.add('visible');startAudio();warmUpGraphics();try{loadCrashSound()}catch(e){}last=performance.now();updateWinterAmbience();lockGamePointer();
}
function pauseGame(){if(gameMode!=='playing')return;try{drvSave(true);UISND.play('pause')}catch(e){}gameMode='paused';updateWinterAmbience();document.body.classList.remove('game-playing');clearDrivingInput();releaseGamePointer();showMenuPanel('pause');}
function resumeGame(){if(gameMode!=='paused')return;try{UISND.play('resume')}catch(e){}gameMode='playing';updateWinterAmbience();if(ac&&ac.state==='suspended')ac.resume().catch(()=>{});document.body.classList.add('game-playing');clearDrivingInput();uiOverlay.classList.add('hidden');pauseTopButton.classList.add('visible');last=performance.now();lockGamePointer();}
function openSettings(from){settingsReturn=from;gameMode='settings';updateWinterAmbience();document.body.classList.remove('game-playing');clearDrivingInput();releaseGamePointer();showMenuPanel('settings');}
function backFromSettings(){document.body.classList.remove('game-playing');releaseGamePointer();if(settingsReturn==='pause'){gameMode='paused';showMenuPanel('pause');}else{gameMode='menu';showMenuPanel('main');}updateWinterAmbience();}
function returnToMainMenu(){
  gameMode='menu';policeEnd();updateWinterAmbience();document.body.classList.remove('game-playing');clearDrivingInput();releaseGamePointer();
  st.x=10.17;st.z=0;st.h=0;st.wx=st.wz=0;st.steer=0;st.thr=0;st.roll=st.pitch=0;reset();resetSegmentPositions();
  resetTrafficFleet();
  placeCarOnRoad();view=0;ch=0;orb.y=0;
  setCockpit(false);
  camera.position.set(st.x+5.8,2.5,st.z+7);camera.lookAt(st.x,1.2,st.z-1.5);camera.fov=58;camera.updateProjectionMatrix();
  showMenuPanel('main');last=performance.now();
}
function reset(){if(BIKE)BIKE.reset();if(window.DRIVE)try{DRIVE.reset()}catch(e){}st.cw=0;repairPlayerCar();st.x=10.17;st.h=0;st.wx=st.wz=0;st.steer=0;yawR=0;slide=0;hbp=0;gi=0;axF=ayF=0;shiftT=0;brkp=0;engRPM=900;throttleOffTime=0}
// Resolve gameplay keys by physical keyboard position (KeyboardEvent.code),
// not by the character produced by the current layout. WASD therefore works
// identically with English, Arabic, or another keyboard language selected.
// ===== Car horn (X / gamepad RB) + high-beam flash + "honk makes the car ahead change lane" =====
const HORN={on:false,k:0,t0:-1e9,retry:0,pad:false,lit:false,au:null,range:50};
function hornAudioStart(){
  if(!ac||muted||engineVolume<=0||HORN.au)return;
  try{
    if(ac.state==='suspended')ac.resume().catch(()=>{});
    const t=ac.currentTime,master=ac.createGain(),lp=ac.createBiquadFilter(),pk=ac.createBiquadFilter(),oscs=[];
    lp.type='lowpass';lp.frequency.value=2400;pk.type='peaking';pk.frequency.value=1000;pk.Q.value=.9;pk.gain.value=5;
    // two-tone horn (~420 Hz + ~525 Hz) with a little harmonic buzz, like a real car horn
    for(const [f,type,a] of [[419,'sawtooth',.5],[524,'sawtooth',.5],[838,'square',.07],[1048,'square',.05]]){
      const o=ac.createOscillator(),g=ac.createGain();o.type=type;o.frequency.value=f;g.gain.value=a;o.connect(g);g.connect(pk);o.start(t);oscs.push(o);
    }
    pk.connect(lp);lp.connect(master);master.connect(ac.destination);
    const vol=.30*Math.min(1,engineVolume*1.3);
    master.gain.setValueAtTime(0,t);master.gain.linearRampToValueAtTime(vol,t+.012);
    HORN.au={master,oscs,vol,t0:t};
  }catch(e){HORN.au=null}
}
function hornAudioStop(){
  const a=HORN.au;if(!a)return;HORN.au=null;
  try{
    const now=ac.currentTime,at=Math.max(now,a.t0+.16); // even a quick tap gives a short "beep"
    a.master.gain.setValueAtTime(a.vol,at);a.master.gain.linearRampToValueAtTime(0,at+.07);
    for(const o of a.oscs)o.stop(at+.09);
  }catch(e){}
}
// A honk at a car that is less than HORN.range metres ahead in the player's lane makes it move over to a free neighbouring lane.
function hornAlert(){
  if(typeof trafficReady==='undefined'||!trafficReady||!trafficCars.length)return;
  const pr=playerRoadCoords(),ps=Math.hypot(st.wx,st.wz);
  let tgt=null,best=Infinity;
  for(const v of trafficCars){
    if(v.direction>=0||v.hitTimer>0)continue;          // only cars driving the same way as the player
    const d=pr.z-v.z;                                  // "ahead" = smaller z
    if(d<=0||d>=HORN.range||Math.abs(v.x-pr.x)>2.6)continue; // within 50 m, in the player's lane
    if(d<best){best=d;tgt=v}
  }
  if(!tgt||tgt.lcState>0)return;
  const lanes=trafficLanesOf(tgt);let ci=0,bd=1e9;
  for(let i=0;i<lanes.length;i++){const d=Math.abs(lanes[i]-tgt.lane);if(d<bd){bd=d;ci=i}}
  const cand=[];for(const d of [-1,1]){const j=ci+d;if(j>=0&&j<lanes.length&&!bridgeWallBetween(tgt.lane,lanes[j],tgt.z))cand.push(j)}
  if(Math.random()<.5)cand.reverse();
  let pick=-1;
  for(const j of cand)if(lcCheckLane(tgt,lanes[j],pr,ps)){pick=j;break;}      // normal safety rules first
  if(pick<0){                                                                  // otherwise any lane with a car-length gap on both sides
    let bestRoom=9;
    for(const j of cand){
      let room=Infinity;
      for(const o of trafficCars){
        if(o===tgt||o.direction!==tgt.direction)continue;
        if(Math.abs(o.oa-lanes[j])>=2&&Math.abs(o.ob-lanes[j])>=2)continue;
        room=Math.min(room,Math.abs(tgt.z-o.z));
      }
      if(room>bestRoom){bestRoom=room;pick=j}
    }
  }
  if(pick<0)return;
  lcBegin(tgt,pick);tgt.lcForce=true;tgt.lcWait=rnd(.3,.6); // reacts quickly: short blink, then moves over
}
function hornBeamApply(){
  const k=HORN.k,fl=typeof LAMPS!=='undefined'?LAMPS:{};
  const okf=n=>!fl[n]||fl[n].ok;
  if(k<.01){
    if(!HORN.lit)return;
    HORN.lit=false;headPool.scale.set(1,1,1);
    for(const p of headPool.children)p.material.opacity=.765;
    for(const L of headLights){L.intensity=2.6;L.distance=85;L.angle=Math.PI/30}
    for(const n of ['fl','fr'])if(fl[n]&&fl[n].halo)fl[n].halo.scale.set(1,1,1);
    setHeadlights(headOn);return;
  }
  HORN.lit=true;
  // high beam: ~30 % longer and a little wider / brighter than the normal low beam, forward only
  headPool.visible=true;headPool.scale.set(1+.1*k,1,1+.3*k);
  headPool.children.forEach((p,i)=>{p.visible=okf(i?'fr':'fl');p.material.opacity=.765+.2*k});
  headLights.forEach((L,i)=>{L.intensity=okf(i?'fr':'fl')?2.6+1.0*k:0;L.distance=85+25*k;L.angle=Math.PI/30+(Math.PI/22-Math.PI/30)*k});
  for(const n of ['fl','fr'])if(fl[n]&&fl[n].halo){fl[n].halo.visible=fl[n].ok;fl[n].halo.scale.setScalar(1+.45*k)}
}
function hornFrame(dt){
  const want=!!keys.x||HORN.pad,now=performance.now();
  if(want&&!HORN.on){HORN.on=true;HORN.t0=now;HORN.retry=now;hornAudioStart();hornAlert()}
  else if(!want&&HORN.on){HORN.on=false;hornAudioStop()}
  else if(want&&now-HORN.retry>600){HORN.retry=now;hornAlert()}               // keep honking at the next car in the lane
  if(HORN.on)HORN.k+=(1-HORN.k)*Math.min(1,dt*30);                              // switches on fast
  else HORN.k=0;                                                                // switches off instantly on release
  hornBeamApply();
}
function hornReset(){keys.x=0;HORN.on=false;HORN.k=0;hornAudioStop();hornBeamApply()}
// ===== Rebindable controls: keyboard (physical key codes) + gamepad buttons, saved on this device =====
// label, internal key names the game logic reads (slot 1 / slot 2), default key codes
const KB_ACTIONS=[
  ['accel','تسارع',['w','arrowup'],['KeyW','ArrowUp']],
  ['brake','فرامل / رجوع',['s','arrowdown'],['KeyS','ArrowDown']],
  ['left','توجيه لليسار',['a','arrowleft'],['KeyA','ArrowLeft']],
  ['right','توجيه لليمين',['d','arrowright'],['KeyD','ArrowRight']],
  ['handbrake','فرملة اليد',[' '],['Space','']],
  ['headlights','المصابيح الأمامية',['f'],['KeyF','']],
  ['horn','الكلاكس + الإضاءة العالية',['x'],['KeyX','']],
  ['view','تغيير المنظور',['c'],['KeyC','']],
  ['lookLeft','النظر للجانب الأيسر',['q'],['KeyQ','']],
  ['lookRight','النظر للجانب الأيمن',['e'],['KeyE','']],
  ['lookBack','النظر إلى السيارة من الأمام (استمرار)',['r'],['KeyR','']],
  ['mute','كتم صوت المحرك',['m'],['KeyM','']],
  ['hitbox','عرض صناديق التصادم',['h'],['KeyH','']],
  ['pause','إيقاف / متابعة (+ Esc دائماً)',['p'],['KeyP',''] ]
];
// label, default standard-gamepad button index
const GB_ACTIONS=[
  ['gas','بنزين',7],['brake','فرامل / رجوع',6],['handbrake','فرملة اليد',4],
  ['headlights','المصابيح الأمامية',3],['horn','الكلاكس + الإضاءة العالية',5],
  ['view','تغيير المنظور',2],['pause','إيقاف / متابعة',9]
];
const BIND={kb:{},rev:{}},GB={},GO={dead:16,look:100,invertY:false};
const GPCAP={active:false,armed:false,until:0,cb:null};
function bindDefaultsKb(){for(const [id,,,codes] of KB_ACTIONS)BIND.kb[id]=codes.slice()}
function bindDefaultsGp(){for(const [id,,d] of GB_ACTIONS)GB[id]=d;GO.dead=16;GO.look=100;GO.invertY=false}
function bindRebuild(){
  BIND.rev={};
  for(const [id,,keys] of KB_ACTIONS){
    const c=BIND.kb[id]||[];
    for(let i=0;i<2;i++)if(c[i]&&BIND.rev[c[i]]===undefined)BIND.rev[c[i]]=keys[i]!==undefined?keys[i]:keys[0];
  }
}
function bindSave(){try{localStorage.setItem('corniche_bindings',JSON.stringify({kb:BIND.kb,gb:GB,go:GO}))}catch(e){}}
(function bindLoad(){
  bindDefaultsKb();bindDefaultsGp();
  try{
    const j=JSON.parse(localStorage.getItem('corniche_bindings')||'null');
    if(j&&typeof j==='object'){
      if(j.kb)for(const [id] of KB_ACTIONS){const c=j.kb[id];if(Array.isArray(c))BIND.kb[id]=[typeof c[0]==='string'?c[0]:'',typeof c[1]==='string'?c[1]:''];}
      if(j.gb)for(const [id] of GB_ACTIONS){const n=j.gb[id];if(Number.isInteger(n)&&n>=0&&n<64)GB[id]=n}
      if(j.go){if(Number.isFinite(j.go.dead))GO.dead=Math.max(0,Math.min(40,j.go.dead));if(Number.isFinite(j.go.look))GO.look=Math.max(25,Math.min(200,j.go.look));GO.invertY=!!j.go.invertY}
    }
  }catch(e){}
  bindRebuild();
})();
const gpUsed=i=>GB_ACTIONS.some(([id])=>GB[id]===i);
// While the settings page is waiting for a gamepad button, swallow all gamepad input and report the first button pressed.
function gpCaptureStep(gp){
  const n=(gp.buttons||[]).length;let first=-1;
  for(let i=0;i<n;i++)if(gamepadButtonPressed(gp,i)){first=i;break}
  for(let i=0;i<n;i++)gamepadPrevButtons[i]=gamepadButtonPressed(gp,i);
  if(!GPCAP.armed){if(first<0)GPCAP.armed=true;return true}   // wait until every button has been released first
  if(performance.now()>GPCAP.until){if(GPCAP.cb)GPCAP.cb(-1);return true}
  if(first>=0&&GPCAP.cb)GPCAP.cb(first);
  return true;
}
const PHYSICAL_KEY_MAP={
  KeyW:'w',KeyA:'a',KeyS:'s',KeyD:'d',KeyH:'h',
  KeyC:'c',KeyF:'f',KeyX:'x',KeyR:'r',KeyM:'m',KeyP:'p',KeyE:'e',KeyQ:'q',
  Space:' ',ArrowUp:'arrowup',ArrowDown:'arrowdown',ArrowLeft:'arrowleft',ArrowRight:'arrowright',
  Escape:'escape',Enter:'enter'
};
function gameInputKey(e){
  if(e.code){const r=BIND.rev[e.code];if(r!==undefined)return r;if(e.code==='Enter'||e.code==='NumpadEnter')return'enter';if(e.code==='Escape')return'escape';return'unbound:'+e.code}
  // Fallback for unusual keyboards/browsers while preserving the physical WASD mapping above.
  return String(e.key||'').toLowerCase();
}
addEventListener('keydown',e=>{
  const k=gameInputKey(e);
  if(k==='escape'||k==='p'){
    e.preventDefault();
    if(gameMode==='playing')pauseGame();
    else if(gameMode==='paused')resumeGame();
    else if(gameMode==='settings')backFromSettings();
    else if(gameMode==='menu'&&!setupMenuPanel.classList.contains('hidden'))document.getElementById('setupBackBtn').click();
    return;
  }
  if(gameMode!=='playing'){
    if(k==='enter'&&(gameMode==='menu'||gameMode==='over')&&!(document.activeElement&&/^(BUTTON|INPUT)$/.test(document.activeElement.tagName))){const pb=currentMenuPanel().querySelector('.menu-btn.primary');if(pb)pb.click()}
    return;
  }
  keys[k]=1;startAudio();
  if(k==='c')view=(view+1)%3;
  if(k==='f'&&!e.repeat)setHeadlights(!headOn);
  if(k==='h'&&!e.repeat)toggleHitboxes();
  if(k==='m'){muted=!muted;const mt=document.getElementById('muteEngineToggle');if(mt)mt.checked=muted;}
  if(k===' '||k.startsWith('arrow'))e.preventDefault();
});
addEventListener('keyup',e=>{keys[gameInputKey(e)]=0});

// ---- Gamepad support (standard browser Gamepad mapping) ----
const gamepadPrevButtons=[];
let activeGamepadIndex=null,gamepadConnected=false,gamepadNavAt=0,gamepadMenuPanel='',gamepadOrbitYaw=0,gamepadOrbitPitch=0;
const gamepadStatusEl=document.getElementById('gamepadStatus');
const clamp01=v=>Math.max(0,Math.min(1,v));
function axisWithDeadzone(v,dead=.16){v=Number(v)||0;const a=Math.abs(v);return a<=dead?0:Math.sign(v)*((a-dead)/(1-dead));}
function gamepadButtonValue(gp,index){const b=gp.buttons&&gp.buttons[index];if(!b)return 0;return Math.max(b.pressed?1:0,Number(b.value)||0);}
function gamepadButtonPressed(gp,index){return gamepadButtonValue(gp,index)>.5;}
function gamepadJustPressed(gp,index){const down=gamepadButtonPressed(gp,index),was=!!gamepadPrevButtons[index];gamepadPrevButtons[index]=down;return down&&!was;}
function clearGamepadButtons(){for(let i=0;i<gamepadPrevButtons.length;i++)gamepadPrevButtons[i]=false;}
function clearGamepadDriving(){pad.throttle=0;pad.brakeAmount=0;pad.steer=0;pad.lookX=0;pad.lookY=0;pad.gas=0;pad.brake=0;pad.left=0;pad.right=0;pad.hb=0;}
function currentMenuPanel(){return gameMode==='menu'?(setupMenuPanel.classList.contains('hidden')?mainMenuPanel:setupMenuPanel):gameMode==='paused'?pauseMenuPanel:gameMode==='settings'?settingsMenuPanel:gameMode==='over'?gameOverPanel:null;}
function menuFocusableElements(){const panel=currentMenuPanel();if(!panel)return[];return [...panel.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled])')].filter(el=>el.getClientRects().length>0);}
function focusMenuDefault(){const panel=currentMenuPanel();if(!panel)return;let target=gameMode==='menu'?(panel.querySelector('.menu-btn.primary')||document.getElementById('startGameBtn')):gameMode==='paused'?document.getElementById('resumeGameBtn'):panel.querySelector('button:not([disabled]),input:not([disabled]),select:not([disabled])');if(target&&target.getClientRects().length){document.querySelectorAll('.gamepad-focused').forEach(el=>el.classList.remove('gamepad-focused'));target.focus({preventScroll:true});target.classList.add('gamepad-focused');}}
function moveGamepadMenuFocus(direction,now,horizontal=false){
  if(now<gamepadNavAt)return;
  const active=document.activeElement;
  if(horizontal&&active&&active.tagName==='INPUT'&&active.type==='range'){
    const min=Number(active.min)||0,max=Number(active.max)||100,step=Number(active.step)||1;
    active.value=String(Math.max(min,Math.min(max,Number(active.value)+direction*step)));
    active.dispatchEvent(new Event('input',{bubbles:true}));gamepadNavAt=now+110;return;
  }
  const items=menuFocusableElements();if(!items.length)return;
  let index=items.indexOf(active);
  if(index<0){index=0;}else index=(index+direction+items.length)%items.length;
  document.querySelectorAll('.gamepad-focused').forEach(el=>el.classList.remove('gamepad-focused'));
  const target=items[index];target.focus({preventScroll:true});target.classList.add('gamepad-focused');gamepadNavAt=now+190;
}
function gamepadMenuActivate(){
  const items=menuFocusableElements();let active=document.activeElement;
  if(!items.includes(active)){focusMenuDefault();active=document.activeElement;}
  if(active&&typeof active.click==='function'&&active.tagName==='BUTTON'){active.click();return;}
  if(active&&active.type==='checkbox'){active.click();return;}
}
function gamepadMenuBack(){
  if(gameMode==='settings')document.getElementById('settingsBackBtn').click();
  else if(gameMode==='paused')document.getElementById('resumeGameBtn').click();
  else if(gameMode==='over')document.getElementById('overMenuBtn').click();
  else if(gameMode==='menu'&&!setupMenuPanel.classList.contains('hidden'))document.getElementById('setupBackBtn').click();
}
function setGamepadStatus(connected,gp){
  if(!gamepadStatusEl)return;
  gamepadStatusEl.classList.toggle('connected',connected);
  gamepadStatusEl.textContent=connected?'🎮 يد التحكم متصلة — '+(gp&&gp.mapping==='standard'?'جاهزة':'تم اكتشافها'):'🎮 يد التحكم: غير متصلة';
}
function updateGamepad(now,dt){
  let pads=null;
  try{pads=navigator.getGamepads?navigator.getGamepads():null}catch(_){pads=null;}
  let gp=(activeGamepadIndex!==null&&pads?pads[activeGamepadIndex]:null);
  if(!gp||!gp.connected){gp=null;if(pads)for(let i=0;i<pads.length;i++){const x=pads[i];if(x&&x.connected){gp=x;break}}}
  if(!gp){
    if(gamepadConnected){gamepadConnected=false;activeGamepadIndex=null;clearGamepadDriving();clearGamepadButtons();setGamepadStatus(false);}
    return;
  }
  const newlyConnected=!gamepadConnected||activeGamepadIndex!==gp.index;
  gamepadConnected=true;activeGamepadIndex=gp.index;
  if(newlyConnected){clearGamepadButtons();setGamepadStatus(true,gp);gamepadMenuPanel='';}
  if(GPCAP.active&&gpCaptureStep(gp))return; // settings page is waiting for a button to rebind

  const lx=axisWithDeadzone(gp.axes&&gp.axes[0],GO.dead/100),ly=axisWithDeadzone(gp.axes&&gp.axes[1],GO.dead/100);
  const rx=axisWithDeadzone(gp.axes&&gp.axes[2],.18)*GO.look/100,ry=axisWithDeadzone(gp.axes&&gp.axes[3],.18)*GO.look/100*(GO.invertY?-1:1);
  const dUp=gamepadButtonPressed(gp,12),dDown=gamepadButtonPressed(gp,13),dLeft=gamepadButtonPressed(gp,14),dRight=gamepadButtonPressed(gp,15);
  const lt=clamp01(gamepadButtonValue(gp,GB.brake)),rt=clamp01(gamepadButtonValue(gp,GB.gas));
  pad.throttle=rt;pad.brakeAmount=lt;
  pad.gas=rt>.06||dUp;pad.brake=lt>.06||dDown;
  pad.steer=-lx;pad.left=dLeft;pad.right=dRight;
  pad.hb=gamepadButtonPressed(gp,GB.handbrake);
  HORN.pad=gameMode==='playing'&&gamepadButtonPressed(gp,GB.horn);
  pad.lookX=rx;pad.lookY=ry;

  if(gameMode==='playing'){
    if(gamepadJustPressed(gp,GB.pause)||(gamepadJustPressed(gp,1)&&!gpUsed(1))){pauseGame();}
    if(gamepadJustPressed(gp,GB.view)){view=(view+1)%3;}
    if(gamepadJustPressed(gp,GB.headlights)){setHeadlights(!headOn);}
    // Right stick: free look in the cockpit; orbit / elevation outside.
    if(view===2){lkT.y-=rx*dt*1.9;lkT.p+=ry*dt*1.35;lkT.y=Math.max(-2.2,Math.min(2.2,lkT.y));lkT.p=Math.max(-.9,Math.min(.7,lkT.p));}else{gamepadOrbitYaw=Math.max(-Math.PI,Math.min(Math.PI,gamepadOrbitYaw-rx*dt*1.8));gamepadOrbitPitch=Math.max(-.48,Math.min(.48,gamepadOrbitPitch+ry*dt*1.15));}
  }else{
    // A / Cross confirms the highlighted menu item; B / Circle goes back.
    if(gamepadJustPressed(gp,0))gamepadMenuActivate();
    if(gamepadJustPressed(gp,1))gamepadMenuBack();
    if(gamepadJustPressed(gp,9)){if(gameMode==='menu'){const pb=currentMenuPanel().querySelector('.menu-btn.primary');if(pb)pb.click()}else if(gameMode==='paused')document.getElementById('resumeGameBtn').click();else if(gameMode==='over')document.getElementById('overRetryBtn').click();}
    if(gamepadMenuPanel!==gameMode){gamepadMenuPanel=gameMode;focusMenuDefault();}
    const navY=dUp?-1:dDown?1:(Math.abs(ly)>.62?Math.sign(ly):0);
    const navX=dLeft?-1:dRight?1:(Math.abs(lx)>.62?Math.sign(lx):0);
    if(navY)moveGamepadMenuFocus(navY,now,false);else if(navX)moveGamepadMenuFocus(navX,now,true);
  }
  // Update edge history for all buttons that are not explicitly edge-tested above.
  for(let i=0;i<(gp.buttons||[]).length;i++)gamepadPrevButtons[i]=gamepadButtonPressed(gp,i);
  // In external views the right stick controls the camera orbit and vertical angle.
  if(gameMode==='playing'&&view!==2){
    // Values are read by the camera update later in the render loop.
  }
}
window.addEventListener('gamepadconnected',e=>{gamepadConnected=true;activeGamepadIndex=e.gamepad.index;setGamepadStatus(true,e.gamepad);});
window.addEventListener('gamepaddisconnected',e=>{if(activeGamepadIndex===e.gamepad.index){gamepadConnected=false;activeGamepadIndex=null;clearGamepadDriving();clearGamepadButtons();setGamepadStatus(false);}});

document.getElementById('startGameBtn').addEventListener('click',()=>{showMenuPanel('setup');focusMenuDefault();});
document.getElementById('beginDriveBtn').addEventListener('click',startGame);
document.getElementById('setupBackBtn').addEventListener('click',()=>{showMenuPanel('main');focusMenuDefault();});
document.querySelectorAll('[data-traffic-density]').forEach(button=>button.addEventListener('click',()=>setTrafficDensity(button.dataset.trafficDensity)));
document.getElementById('resumeGameBtn').addEventListener('click',resumeGame);
document.getElementById('pauseTopButton').addEventListener('click',pauseGame);
document.getElementById('mainSettingsBtn').addEventListener('click',()=>openSettings('main'));
document.getElementById('pauseSettingsBtn').addEventListener('click',()=>openSettings('pause'));
document.getElementById('settingsBackBtn').addEventListener('click',backFromSettings);
document.getElementById('restartGameBtn').addEventListener('click',()=>{gameMode='menu';startGame();});
document.getElementById('returnMainBtn').addEventListener('click',returnToMainMenu);
document.querySelectorAll('[data-car-color]').forEach(b=>b.addEventListener('click',()=>setCarPaintColor(b.dataset.carColor)));
document.querySelectorAll('[data-car-finish]').forEach(b=>b.addEventListener('click',()=>setCarPaintFinish(b.dataset.carFinish)));
document.getElementById('externalMirrorsToggle').addEventListener('change',e=>setExternalMirrorsVisible(e.target.checked));
const engineVolumeSlider=document.getElementById('engineVolumeSlider');
const engineVolumeValue=document.getElementById('engineVolumeValue');
engineVolumeSlider.addEventListener('input',e=>{engineVolume=Number(e.target.value)/100;engineVolumeValue.textContent=e.target.value+'%';if(engineVolume>0&&muted){muted=false;document.getElementById('muteEngineToggle').checked=false;}});
document.getElementById('muteEngineToggle').addEventListener('change',e=>{muted=e.target.checked;});
const winterVolumeSlider=document.getElementById('winterVolumeSlider');
const winterVolumeValue=document.getElementById('winterVolumeValue');
winterVolumeSlider.value=String(Math.round(winterVolume*100));winterVolumeValue.textContent=winterVolumeSlider.value+'%';
winterVolumeSlider.addEventListener('input',e=>{
  winterVolume=Math.max(0,Math.min(1,Number(e.target.value)/100));
  winterVolumeValue.textContent=e.target.value+'%';
  try{localStorage.setItem('corniche_winter_volume',String(e.target.value))}catch(err){}
  updateWinterAmbience();
});
addEventListener('blur',()=>{if(gameMode==='playing')pauseGame();});
// Set a useful exterior view behind the main menu before the first render.
placeCarOnRoad();camera.position.set(st.x+5.8,2.5,st.z+7);camera.lookAt(st.x,1.2,st.z-1.5);
setCarPaintColor(activePaintColor);
setCarPaintFinish(activePaintFinish);

// ---- time of day: day / night mode (chosen from the main menu) ----
const skyDayT=skyT;
const skyNightT=cv(1024,512,(g,w,h)=>{const gr=g.createLinearGradient(0,0,0,h);gr.addColorStop(0,'#01020a');gr.addColorStop(.25,'#040a1f');gr.addColorStop(.42,'#0d1a3e');gr.addColorStop(.49,'#1d2f5c');gr.addColorStop(.5,'#1b2d58');gr.addColorStop(1,'#1b2d58');g.fillStyle=gr;g.fillRect(0,0,w,h);
// Milky-Way band: diagonal chain of soft blobs, then dense dust
for(let i=0;i<120;i++){const t=i/119,x=w*(.1+t*.55)+rnd(-40,40),y=h*(.34-t*.26)+rnd(-18,18);skyBlob(g,w,x,y,rnd(40,110),rnd(10,26),'rgba(150,170,255,'+rnd(.025,.075)+')','rgba(150,170,255,0)')}
for(let i=0;i<2200;i++){const t=Math.random(),x=w*(.1+t*.55)+rnd(-70,70),y=h*(.34-t*.26)+rnd(-34,34);g.fillStyle='rgba(235,240,255,'+rnd(.15,.6)+')';g.fillRect(x,y,rnd(.6,1.6),rnd(.6,1.6))}
// faint city glow on the horizon and low haze
skyBlob(g,w,w*.25,h*.485,w*.2,h*.05,'rgba(255,170,95,.2)','rgba(255,170,95,0)');skyBlob(g,w,w*.8,h*.485,w*.16,h*.04,'rgba(255,190,120,.14)','rgba(255,190,120,0)');
for(let i=0;i<40;i++)skyBlob(g,w,rnd(0,w),rnd(h*.4,h*.495),rnd(80,200),rnd(5,14),'rgba(120,140,210,'+rnd(.04,.1)+')','rgba(120,140,210,0)')});
const stars=(()=>{const grp=new THREE.Group();grp.visible=false;sky.add(grp);
function mk(n,size,minB){const p=new Float32Array(n*3),c=new Float32Array(n*3);for(let i=0;i<n;i++){const a=Math.random()*Math.PI*2,y=.04+Math.random()*.96,r=Math.sqrt(1-y*y),R=1400;p[i*3]=Math.cos(a)*r*R;p[i*3+1]=y*R;p[i*3+2]=Math.sin(a)*r*R;const b=minB+Math.random()*(1-minB),tint=Math.random();c[i*3]=b*(tint<.25?1:.85);c[i*3+1]=b*.92;c[i*3+2]=b*(tint>.75?.78:1)}
const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.BufferAttribute(p,3));g.setAttribute('color',new THREE.BufferAttribute(c,3));
const o=new THREE.Points(g,new THREE.PointsMaterial({size,sizeAttenuation:false,vertexColors:true,fog:false,transparent:true,depthWrite:false}));o.frustumCulled=false;grp.add(o)}
mk(1500,2.2,.4);mk(60,4,.8);return grp})();

// player headlights
// Headlight beam = additive light-pool decal on the asphalt (same technique as the street-lamp pools),
// so it brightens the road only and never lights buildings, walls or scenery.
const headLights=[];
const makeBeamT=(wl,wr)=>{const W=256,H=1024,c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d'),im=g.createImageData(W,H),D=im.data,LEN=72,WID=24;
  for(let y=0;y<H;y++){const z=(H-1-y)/H*LEN,rise=Math.min(1,z/9),fall=1/(1+Math.pow(z/22,2)),edge=Math.min(1,(LEN-z)/10),I=rise*fall*edge,hw=1.5+z*.075;
    for(let x=0;x<W;x++){const mx=(x/(W-1)-.5)*WID,a=.5*(wr*Math.exp(-Math.pow((mx-.75)/hw,2)*1.6)+wl*Math.exp(-Math.pow((mx+.75)/hw,2)*1.6)),al=Math.min(1,I*a*1.25),o=(y*W+x)*4;
      D[o]=255;D[o+1]=244;D[o+2]=222;D[o+3]=Math.round(al*255)}}
  g.putImageData(im,0,0);const t=new THREE.CanvasTexture(c);t.anisotropy=ANISO;return t};
headPool=new THREE.Group();headPool.visible=false;headPool.frustumCulled=false;
for(const [wl,wr] of [[1,0],[0,1]]){const pm=new THREE.Mesh(new THREE.PlaneGeometry(24,72).rotateX(-Math.PI/2).translate(0,0,-38.4),new THREE.MeshBasicMaterial({map:makeBeamT(wl,wr),transparent:true,opacity:.765,blending:THREE.AdditiveBlending,depthWrite:false,fog:false,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-3}));pm.frustumCulled=false;pm.renderOrder=5;headPool.add(pm)}
scene.add(headPool);
// Very narrow, short-range spot lights: they only reach vehicles in front of the car (buildings sit 25 m+ to the side, outside the 6-degree cone).
for(const sx of [-.72,.72]){const L=new THREE.SpotLight(0xfff4dc,2.6,85,Math.PI/30,.6,1);L.position.set(sx,.75,-1.9);const T=new THREE.Object3D();T.position.set(sx*.35,.5,-80);car.add(L);car.add(T);L.target=T;L.intensity=0;headLights.push(L)}
// Headlamp bloom: a soft white halo + hot white core in front of each front lamp (one-sided planes -> seen only from the front).
const haloT=cv(256,256,(g,w,h)=>{const gr=g.createRadialGradient(128,128,0,128,128,128);gr.addColorStop(0,'rgba(255,255,255,1)');gr.addColorStop(.16,'rgba(255,255,255,.92)');gr.addColorStop(.36,'rgba(255,254,247,.45)');gr.addColorStop(.66,'rgba(255,251,238,.13)');gr.addColorStop(1,'rgba(255,248,230,0)');g.fillStyle=gr;g.fillRect(0,0,w,h)});
function makeHeadHalo(x,y,z){
  const grp=new THREE.Group();
  const mk=(size,op,dz)=>{const m=new THREE.Mesh(new THREE.PlaneGeometry(size,size).rotateY(Math.PI),new THREE.MeshBasicMaterial({map:haloT,color:0xffffff,transparent:true,opacity:op,blending:THREE.AdditiveBlending,depthWrite:false,fog:false,toneMapped:false}));m.position.z=-dz;m.renderOrder=11;m.castShadow=false;m.receiveShadow=false;m.frustumCulled=false;return m};
  grp.add(mk(1.5,.95,.26));grp.add(mk(.6,1,.14));
  grp.position.set(x,y,z);grp.visible=headOn;car.add(grp);return grp}
const sunT=cv(256,256,(g,w,h)=>{const gr=g.createRadialGradient(128,128,0,128,128,128);gr.addColorStop(0,'rgba(255,255,240,1)');gr.addColorStop(.08,'rgba(255,250,225,1)');gr.addColorStop(.14,'rgba(255,240,190,.55)');gr.addColorStop(.4,'rgba(255,225,160,.18)');gr.addColorStop(1,'rgba(255,220,150,0)');g.fillStyle=gr;g.fillRect(0,0,w,h)});
const sunSpr=new THREE.Sprite(new THREE.SpriteMaterial({map:sunT,fog:false,transparent:true,depthWrite:false,blending:THREE.AdditiveBlending}));sunSpr.scale.set(330,330,1);sunSpr.position.set(560,600,-1130);sky.add(sunSpr);
// Overcast winter skies: heavy layered grey cloud deck, no blue and no sun
const skyWinterDayT=cv(1024,512,(g,w,h)=>{const gr=g.createLinearGradient(0,0,0,h);gr.addColorStop(0,'#4b5962');gr.addColorStop(.25,'#66757f');gr.addColorStop(.42,'#7f909b');gr.addColorStop(.49,'#8799a5');gr.addColorStop(.5,'#8799a5');gr.addColorStop(1,'#8799a5');g.fillStyle=gr;g.fillRect(0,0,w,h);
  for(let i=0;i<150;i++){const y=rnd(0,h*.5),dk=Math.random()<.55;skyBlob(g,w,rnd(0,w),y,rnd(70,230),rnd(14,46),dk?'rgba(52,62,70,'+rnd(.12,.3)+')':'rgba(190,203,211,'+rnd(.1,.24)+')','rgba(120,135,145,0)')}
  for(let i=0;i<60;i++)skyBlob(g,w,rnd(0,w),rnd(h*.36,h*.5),rnd(120,300),rnd(8,20),'rgba(150,165,175,'+rnd(.12,.26)+')','rgba(150,165,175,0)')});
const skyWinterNightT=cv(1024,512,(g,w,h)=>{const gr=g.createLinearGradient(0,0,0,h);gr.addColorStop(0,'#04070b');gr.addColorStop(.3,'#0a121a');gr.addColorStop(.46,'#142230');gr.addColorStop(.5,'#1b2a37');gr.addColorStop(1,'#1b2a37');g.fillStyle=gr;g.fillRect(0,0,w,h);
  for(let i=0;i<110;i++)skyBlob(g,w,rnd(0,w),rnd(0,h*.5),rnd(70,220),rnd(14,40),Math.random()<.5?'rgba(8,14,20,'+rnd(.18,.4)+')':'rgba(60,78,92,'+rnd(.08,.2)+')','rgba(30,44,56,0)')});
let timeOfDay='day';
let weatherMode='normal';
let headOn=false;
// ===== Rain: physically based falling drops =====================================================================
// * drop diameter follows an exponential (Marshall-Palmer like) spectrum: many small drops, few big ones
// * terminal fall speed v = 9.65 - 10.3*exp(-0.6*D)  (Atlas et al. 1973, D in mm): 1 mm ~ 4 m/s, 2 mm ~ 6.5 m/s, 4 mm ~ 8.8 m/s
// * wind gusts: the wind is a sum of slow sines and drop positions use its exact integral, so drops sway in gusts without jumping
// * streaks are camera-exposure motion blur along the drop velocity RELATIVE to the camera: the car's speed bends the rain toward the vanishing point
// * streak width is never below ~1.2 px (clean anti-aliasing); thinner than a pixel -> fainter (coverage), plus distance haze
// * at night drops light up inside the street-lamp glow and inside the car's headlight beam
// * two layers (far field + dense near field) and a faint distant rain curtain give depth
// <<RAIN-GLSL-BEGIN>>
const RAIN_VS=`attribute vec4 aSeed;attribute vec2 aCorner;
uniform float uTime,uAlpha,uShutter,uPxK,uInt,uNight,uBeam,uSizeK,uLayerA;
uniform vec3 uBox,uCenter,uCamVel,uCol,uCarPos,uCarDir,uWind;
uniform vec4 uRP[24];uniform vec4 uRC[24];
varying float vA;varying vec2 vUv;varying vec3 vTint;
float rh(float x){x=fract(x*.1031);x*=x+33.33;x*=x+x;return fract(x);}
void main(){
  float r1=rh(aSeed.w*173.1+.3),r2=rh(aSeed.w*91.7+3.7),r4=rh(aSeed.x*311.7+aSeed.y*57.1+aSeed.z*13.3);
  float D=(.75+3.5*aSeed.w*aSeed.w)*uSizeK;
  float vt=9.65-10.3*exp(-.6*D);
  float tw=uTime+(r1-.5)*2.4;
  float g1=.34*uWind.y,g2=.18*uWind.y,g3=.07*uWind.y*(.5+r2);
  vec2 wdir=uWind.xz;
  float gs=1.+g1*sin(.37*tw+1.3)+g2*sin(1.13*tw+.4)+g3*sin(2.9*tw+r2*6.28);
  vec2 Wd=wdir*(uTime-g1/.37*cos(.37*tw+1.3)-g2/1.13*cos(1.13*tw+.4)-g3/2.9*cos(2.9*tw+r2*6.28));
  vec2 org=uCenter.xz-uBox.xz*.5;
  vec2 pxz=org+mod(aSeed.xz*uBox.xz+Wd-org,uBox.xz);
  float py=mod(aSeed.y*uBox.y-vt*uTime,uBox.y);
  vec3 p=vec3(pxz.x,py,pxz.y);
  vec3 vel=vec3(wdir.x*gs,-vt,wdir.y*gs);
  vec3 rel=vel-uCamVel;
  float sp=length(rel);
  vec3 dir=rel/max(sp,.001);
  float len=clamp(sp*uShutter,.05,2.4);
  vec3 toP=p-cameraPosition;
  float dist=max(length(toP),.001);
  vec3 vd=toP/dist;
  vec3 side=cross(dir,vd);float sl=length(side);side=sl>.001?side/sl:vec3(1.,0.,0.);
  float pxW=dist*uPxK;
  float hwPhys=D*.0007;
  float hw=max(hwPhys,pxW*.6);
  float cov=clamp(hwPhys/hw,0.,1.);
  vec3 wp=mix(p,p-dir*len,aCorner.y)+side*aCorner.x*hw;
  float nearF=smoothstep(.45,2.4,dist);
  float edge=1.-smoothstep(.7,1.,max(abs(pxz.x-uCenter.x)/(uBox.x*.5),abs(pxz.y-uCenter.z)/(uBox.z*.5)));
  float topF=1.-smoothstep(.72,1.,py/uBox.y);
  float botF=smoothstep(.0,.25,py);
  float haze=exp(-dist/70.)*mix(.55,1.,smoothstep(1.5,10.,dist));
  float vis=1.-smoothstep(uInt-.05,uInt,r4);
  float szB=.5+.5*smoothstep(.75,3.4,D);
  vec3 lit=vec3(0.);
  if(uNight>.5){
    for(int i=0;i<20;i++){vec3 d=uRP[i].xyz-p;lit+=uRC[i].rgb/(1.+dot(d,d)/70.);}
    lit*=.7;
    if(uBeam>.5){
      vec3 r=p-uCarPos;float al=dot(r.xz,uCarDir.xz);vec2 lat=r.xz-uCarDir.xz*al;
      float sw=al*.17+1.4;
      float hh=(py-.6-al*.03)/(.9+al*.08);
      float bm=step(0.,al)*smoothstep(.6,3.,al)*exp(-dot(lat,lat)/(sw*sw))*exp(-al/40.)*exp(-hh*hh);
      lit+=vec3(1.,.94,.82)*bm*1.3;
    }
  }
  float L=min(length(lit),1.6);
  vA=uAlpha*uLayerA*pow(cov,.5)*szB*nearF*edge*topF*botF*haze*vis*(1.+1.4*L);
  vTint=uCol+lit;
  vUv=aCorner;
  gl_Position=projectionMatrix*viewMatrix*vec4(wp,1.);
}`;
const RAIN_FS=`varying float vA;varying vec2 vUv;varying vec3 vTint;
void main(){
  float a=1.-vUv.x*vUv.x;a*=a;
  a*=smoothstep(0.,.14,vUv.y)*(1.-smoothstep(.35,1.,vUv.y));
  gl_FragColor=vec4(vTint,vA*a);
}`;
// distant rain curtain: faint, soft streak bands on a big cylinder around the camera (gives the "sheets of rain" far away)
const CURT_VS=`varying vec3 vWP;void main(){vec4 w=modelMatrix*vec4(position,1.);vWP=w.xyz;gl_Position=projectionMatrix*viewMatrix*w;}`;
const CURT_FS=`uniform float uTime,uAlpha;uniform vec3 uCol;uniform vec2 uWind;varying vec3 vWP;
float ch(vec2 p){vec3 q=fract(vec3(mod(p,512.).xyx)*.1031);q+=dot(q,q.yzx+33.33);return fract((q.x+q.y)*q.z);}
float cn(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(ch(i),ch(i+vec2(1.,0.)),f.x),mix(ch(i+vec2(0.,1.)),ch(i+vec2(1.,1.)),f.x),f.y);}
void main(){
  vec3 d=normalize(vWP-cameraPosition);
  float az=atan(d.z,d.x)*.159155;
  float y=vWP.y;
  float x=az*1900.+y*(uWind.x*.9+uWind.y*.4)*.5;
  float yy=y*.3+uTime*2.1;
  float s=smoothstep(.5,.92,cn(vec2(x,yy)))*(.55+.45*cn(vec2(x*.37+7.,yy*.21)));
  float s2=smoothstep(.55,.95,cn(vec2(x*1.9+3.,yy*.8+4.)));
  float cl=.35+.65*cn(vec2(az*9.+uTime*.07,y*.03+2.));
  float hf=smoothstep(-2.,5.,y)*(1.-smoothstep(14.,46.,y));
  float a=(s*.8+s2*.5)*cl*hf*uAlpha;
  gl_FragColor=vec4(uCol,a);
}`;
function buildRainArrays(n){
  const seed=new Float32Array(n*16),corner=new Float32Array(n*8),idx=new Uint16Array(n*6),pos=new Float32Array(n*12);
  for(let i=0;i<n;i++){const a=Math.random(),b=Math.random(),c=Math.random(),d=Math.random();
    for(let v=0;v<4;v++){const o=i*4+v;seed[o*4]=a;seed[o*4+1]=b;seed[o*4+2]=c;seed[o*4+3]=d;corner[o*2]=v&1?1:-1;corner[o*2+1]=v>>1?1:0}
    const q=i*4;idx.set([q,q+1,q+2,q+1,q+3,q+2],i*6)}
  return{pos,seed,corner,idx}}
// <<RAIN-GLSL-END>>
const RAIN_FAR_N=_savedQuality==='low'?4500:11000,RAIN_NEAR_N=_savedQuality==='low'?900:3200;
const RAINM={uTime:{value:0},uCamVel:{value:new THREE.Vector3()},uCol:{value:new THREE.Color(0xc4d4de)},uAlpha:{value:.5},
  uWind:{value:new THREE.Vector3(2.0,1.,.8)},uShutter:{value:.016},uPxK:{value:.002},uInt:{value:1},uNight:{value:0},uBeam:{value:0},
  uCarPos:{value:new THREE.Vector3()},uCarDir:{value:new THREE.Vector3(0,0,-1)},uRP:RLU.P,uRC:RLU.C};
function makeRainLayer(count,box,sizeK,alphaK){
  const A=buildRainArrays(count),g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(A.pos,3));
  g.setAttribute('aSeed',new THREE.BufferAttribute(A.seed,4));
  g.setAttribute('aCorner',new THREE.BufferAttribute(A.corner,2));
  g.setIndex(new THREE.BufferAttribute(A.idx,1));
  const U=Object.assign({},RAINM,{uBox:{value:new THREE.Vector3(...box)},uCenter:{value:new THREE.Vector3()},uSizeK:{value:sizeK},uLayerA:{value:alphaK}});
  const m=new THREE.ShaderMaterial({uniforms:U,transparent:true,depthWrite:false,fog:false,vertexShader:RAIN_VS,fragmentShader:RAIN_FS});
  const mesh=new THREE.Mesh(g,m);mesh.frustumCulled=false;mesh.visible=false;mesh.renderOrder=12;scene.add(mesh);
  return{mesh,U,count,alphaK,box}}
const rainFar=makeRainLayer(RAIN_FAR_N,[50,24,70],1,1);
const rainNear=makeRainLayer(RAIN_NEAR_N,[17,9,20],1.25,.85);
const rainLines=rainFar.mesh;rainLines.userData.layers=[rainFar,rainNear];
const CURTM={uTime:RAINM.uTime,uAlpha:{value:.1},uCol:{value:new THREE.Color(0xb9c8d2)},uWind:{value:new THREE.Vector2(2.0,.8)}};
const rainCurtain=new THREE.Mesh(new THREE.CylinderGeometry(1,1,1,48,1,true),new THREE.ShaderMaterial({uniforms:CURTM,transparent:true,depthWrite:false,fog:false,side:THREE.BackSide,vertexShader:CURT_VS,fragmentShader:CURT_FS}));
rainCurtain.frustumCulled=false;rainCurtain.visible=false;rainCurtain.renderOrder=11;rainCurtain.scale.set(95,130,95);scene.add(rainCurtain);
let rainDetail=1;
function setRainDetail(mode){
  rainDetail=mode==='low'?.45:mode==='medium'?.7:1;
  for(const L of [rainFar,rainNear])L.mesh.geometry.setDrawRange(0,Math.floor(L.count*rainDetail)*6);
  rainCurtain.userData.off=(mode==='low')}
setRainDetail(_savedQuality);
let rainK=0;const _rcPrev=new THREE.Vector3(),_rcVel=new THREE.Vector3(),_rcFwd=new THREE.Vector3(),_rcCtr=new THREE.Vector3(),_rcSz=new THREE.Vector2();let _rcInit=false;
function updateRain(dt,speed){
  const target=weatherMode==='winter'?1:0;
  rainK+=(target-rainK)*Math.min(1,dt*1.6);
  const k=rainK;
  // wet surfaces fade in/out with the rain; the sun glint on the film is broad and soft (low specular, mid shininess)
  RAINU.K.value=k;RAINU.N.value=isNight?1:0;
  if(isNight){RAINU.S.value.set(.13,.18,.23);RAINU.Z.value.set(.045,.065,.095);RAINU.G.value.set(.07,.085,.105)}
  else{RAINU.S.value.set(.56,.62,.67);RAINU.Z.value.set(.34,.38,.43);RAINU.G.value.set(.40,.43,.46)}
  asM.shininess=8+26*k;asM.specular.setRGB(.09+.04*k,.098+.052*k,.11+.06*k);
  if(k<.01&&target===0){for(const L of rainLines.userData.layers)L.mesh.visible=false;rainCurtain.visible=false;return}
  rainFar.mesh.visible=true;rainNear.mesh.visible=(typeof view==='undefined'||view!==2);   // no dense drops inside the cabin in cockpit view
  rainCurtain.visible=!rainCurtain.userData.off;
  const T=RAINM.uTime;T.value+=dt;RAINU.T.value=T.value;
  if(!_rcInit){_rcPrev.copy(camera.position);_rcInit=true}
  if(dt>0){_rcVel.copy(camera.position).sub(_rcPrev).divideScalar(dt);if(_rcVel.length()>90)_rcVel.set(0,0,0);RAINM.uCamVel.value.lerp(_rcVel,Math.min(1,dt*10))}
  _rcPrev.copy(camera.position);
  // slowly breathing rain intensity (heavier / lighter spells), always at least a steady downpour
  RAINM.uInt.value=.86+.14*Math.sin(T.value*.13)*Math.sin(T.value*.051+1.);
  RAINM.uAlpha.value=(isNight?.55:.85)*k;
  RAINM.uCol.value.set(isNight?0x2a343d:0xcfdde6);
  RAINM.uNight.value=isNight?1:0;RAINM.uBeam.value=headOn&&isNight?1:0;
  renderer.getDrawingBufferSize(_rcSz);
  RAINM.uPxK.value=2/(camera.projectionMatrix.elements[5]*Math.max(1,_rcSz.y));
  camera.getWorldDirection(_rcFwd);_rcFwd.y=0;if(_rcFwd.lengthSq()>1e-6)_rcFwd.normalize();else _rcFwd.set(0,0,-1);
  _rcCtr.copy(camera.position).addScaledVector(_rcFwd,16);
  rainFar.U.uCenter.value.lerp(_rcCtr,Math.min(1,dt*6));
  _rcCtr.copy(camera.position).addScaledVector(_rcFwd,4);
  rainNear.U.uCenter.value.lerp(_rcCtr,Math.min(1,dt*6));
  // car position / heading for headlight scattering (the headlights point along the car's local -Z)
  RAINM.uCarPos.value.copy(car.position);_rcFwd.set(0,0,-1).applyQuaternion(car.quaternion);RAINM.uCarDir.value.set(_rcFwd.x,0,_rcFwd.z).normalize();
  CURTM.uAlpha.value=(isNight?.08:.24)*k;CURTM.uCol.value.set(isNight?0x40505e:0xb9c8d2);
  rainCurtain.position.set(camera.position.x,camera.position.y-6,camera.position.z);
}
function setHeadlights(on){headOn=!!on;headM.opacity=1;headPool.visible=headOn;for(const L of headLights)L.intensity=headOn?2.6:0;if(_crashReady)applyLamps()}
function setTimeOfDay(mode,save){
  mode=mode==='night'?'night':'day';timeOfDay=mode;isNight=mode==='night';
  if(isNight){
    scene.fog.color.set(0x15244a);scene.fog.near=30;scene.fog.far=520;
    hemi.color.set(0x5c70b8);hemi.groundColor.set(0x14161f);hemi.intensity=.55;
    sun.color.set(0x8da6ff);sun.intensity=.45;sun.position.set(-80,120,-60);
    sky.material.map=skyNightT;
    for(const c of clouds){c.material.color.set(0x2a3560);c.material.opacity=c.userData.baseOp*.5}
  }else{
    scene.fog.color.set(0xcfe6f6);scene.fog.near=120;scene.fog.far=700;
    hemi.color.set(0xdfeeff);hemi.groundColor.set(0x998877);hemi.intensity=.85;
    sun.color.set(0xfff2dc);sun.intensity=.9;sun.position.set(80,120,-40);
    sky.material.map=skyDayT;
    for(const c of clouds){c.material.color.set(0xffffff);c.material.opacity=c.userData.baseOp}
  }
  if(weatherMode==='winter'){
    // Cold overcast light and closer mist; the chosen day/night mode is preserved.
    scene.fog.color.set(isNight?0x1b2a37:0x8799a5);
    scene.fog.near=isNight?18:30;scene.fog.far=isNight?330:420;
    hemi.color.set(isNight?0x71889a:0xa9bdc9);
    hemi.groundColor.set(isNight?0x101820:0x4d5c66);
    hemi.intensity=isNight?.46:.7;
    sun.color.set(isNight?0x9aafc2:0xc6d8e1);
    sun.intensity=isNight?.28:.48;
    for(const c of clouds){c.material.color.set(isNight?0x536575:0x84949e);c.material.opacity=c.userData.baseOp*(isNight?.68:.96)}
    sky.material.map=isNight?skyWinterNightT:skyWinterDayT;
  }
  stars.visible=isNight&&weatherMode!=='winter';sunSpr.visible=!isNight&&weatherMode!=='winter';lampM.visible=isNight;poolM.visible=isNight;glowM.visible=isNight;TLAMP.gh.visible=TLAMP.gt.visible=isNight;
  for(const m of nightWinMats)m.emissiveIntensity=isNight?1:0;
  window._envN||(window._envN=new THREE.CanvasTexture(skyNightT.image,THREE.EquirectangularReflectionMapping));
  for(const m of nightWinMats){m.envMap=isNight?window._envN:envDay;m.reflectivity=weatherMode==='winter'?.18:.5;m.needsUpdate=true}
  for(const m of bbM)m.emissiveIntensity=isNight?.8:0;
  if(typeof applyTrafficEnv==='function')applyTrafficEnv();
  if(typeof applyCarGloss==='function')applyCarGloss();
  seaMode(isNight,weatherMode==='winter');
  setHeadlights(isNight);
  if(window._dome)window._dome.visible=isNight;if(window._domeFix)window._domeFix.visible=isNight;
  document.body.style.background=isNight?'#0b1530':'';
  document.querySelectorAll('#timeGrid .time-option').forEach(b=>{const on=b.dataset.time===mode;b.classList.toggle('active',on);b.setAttribute('aria-checked',on?'true':'false')});
  if(save){try{localStorage.setItem('corniche_time_of_day',mode)}catch(e){}}
}
document.querySelectorAll('#timeGrid .time-option').forEach(b=>b.addEventListener('click',()=>setTimeOfDay(b.dataset.time,true)));
{let saved=null;try{saved=localStorage.getItem('corniche_time_of_day')}catch(e){}setTimeOfDay(saved==='night'?'night':'day',false)}
function setWeatherMode(mode,save){
  weatherMode=mode==='winter'?'winter':'normal';
  const winter=weatherMode==='winter';
  asM.map=asT;asM.color.set(0xffffff);
  document.querySelectorAll('#weatherGrid .time-option').forEach(b=>{const on=b.dataset.weather===weatherMode;b.classList.toggle('active',on);b.setAttribute('aria-checked',on?'true':'false')});
  setTimeOfDay(timeOfDay,false);
  updateWinterAmbience();
  if(save){try{localStorage.setItem('corniche_weather_mode',weatherMode)}catch(e){}}
}
document.querySelectorAll('#weatherGrid .time-option').forEach(b=>b.addEventListener('click',()=>setWeatherMode(b.dataset.weather,true)));
{let saved=null;try{saved=localStorage.getItem('corniche_weather_mode')}catch(e){}setWeatherMode(saved==='winter'?'winter':'normal',false)}
for(const el of document.querySelectorAll('[data-k]')){const k=el.dataset.k;el.addEventListener('pointerdown',e=>{e.preventDefault();pad[k]=1;startAudio()});for(const t of ['pointerup','pointerleave','pointercancel'])el.addEventListener(t,()=>{pad[k]=0});el.addEventListener('contextmenu',e=>e.preventDefault())}
document.getElementById('view').onclick=()=>view=(view+1)%3;
const orb={y:0,p:0,z:1,on:false,t:0,x:0,yy:0,id:null},cvs=renderer.domElement;
// Cockpit free-look: move the mouse (no click) to look around inside the car; on touch, drag a finger.
const lk={y:0,p:0,drag:false,id:null,lx:0,ly:0},lkT={y:0,p:0};
cvs.style.touchAction='none';
cvs.addEventListener('pointerdown',e=>{if(view!==2||e.pointerType==='mouse')return;lk.drag=true;lk.id=e.pointerId;lk.lx=e.clientX;lk.ly=e.clientY;try{cvs.setPointerCapture(e.pointerId)}catch(_){}});
cvs.addEventListener('pointermove',e=>{if(!lk.drag||e.pointerId!==lk.id||e.pointerType==='mouse')return;lkT.y-=(e.clientX-lk.lx)*.005;lkT.p+=(e.clientY-lk.ly)*.004;lk.lx=e.clientX;lk.ly=e.clientY;lkT.y=Math.max(-2.2,Math.min(2.2,lkT.y));lkT.p=Math.max(-.9,Math.min(.7,lkT.p))});
// Mouse: just move it (no click) - cursor position across the window sets the look direction; centre = straight ahead.
addEventListener('mousemove',e=>{if(view!==2||gameMode!=='playing'||document.pointerLockElement!==renderer.domElement)return;lkT.y=Math.max(-2.2,Math.min(2.2,lkT.y-(e.movementX||0)*.0032));lkT.p=Math.max(-.7,Math.min(.6,lkT.p+(e.movementY||0)*.0028))});
function relockPointerIfNeeded(e){if(e&&e.repeat)return;if(gameMode==='playing'&&!document.pointerLockElement)lockGamePointer()}
addEventListener('mousedown',relockPointerIfNeeded,true);addEventListener('keydown',relockPointerIfNeeded,true);
addEventListener('pointermove',e=>{if(e.pointerType!=='mouse'||view!==2||gameMode!=='playing'||document.pointerLockElement)return;const nx=(e.clientX/innerWidth-.5)*2,ny=(e.clientY/innerHeight-.5)*2;lkT.y=-Math.sign(nx)*Math.pow(Math.min(1,Math.abs(nx)),1.3)*2;lkT.p=Math.max(-.7,Math.min(.6,ny*.6))});
for(const t of ['pointerup','pointercancel','lostpointercapture'])cvs.addEventListener(t,()=>{lk.drag=false});
cvs.addEventListener('dblclick',()=>{lkT.y=0;lkT.p=0});
// Camera is fixed (no mouse control). Hold E = look at the car from its right side, Q = from its left side.

const spdEl=document.getElementById('spd'),gearEl=document.getElementById('gear');

// ---- on-screen speedometer (bottom-right), same look as the in-car dial ----
const gaugeEl=document.getElementById('gauge'),gx=gaugeEl.getContext('2d');let gKey='',gStatic=null,gLast=-1e9;
function sizeGauge(){const S=Math.round(Math.min(250,innerWidth*.42)),d=Math.min(window.devicePixelRatio||1,2);gaugeEl.style.width=gaugeEl.style.height=S+'px';gaugeEl.width=gaugeEl.height=Math.round(S*d);gKey='';gStatic=null}
addEventListener('resize',sizeGauge);sizeGauge();
function drawGauge(kmh,gear){
  const key=Math.round(kmh)+'|'+gear+'|'+gaugeEl.width;if(key===gKey)return;
  const t=performance.now();if(t-gLast<33)return;gLast=t;gKey=key;
  const c=gx,F='Tahoma,Arial,sans-serif',cx=170,cy=170,r=160,max=280,PW=gaugeEl.width,A=v=>(135+270*v/max)*Math.PI/180;
  if(!gStatic||gStatic.width!==PW){ // dial face (background, ring, ticks, numbers) is drawn once and re-used
    gStatic=document.createElement('canvas');gStatic.width=gStatic.height=PW;
    const s=gStatic.getContext('2d');s.setTransform(PW/340,0,0,PW/340,0,0);
    const g=s.createRadialGradient(cx,cy,r*.1,cx,cy,r);g.addColorStop(0,'#101b29');g.addColorStop(1,'#060a10');
    s.fillStyle=g;s.beginPath();s.arc(cx,cy,r,0,7);s.fill();
    s.strokeStyle='#2a3d52';s.lineWidth=5;s.beginPath();s.arc(cx,cy,r-2,0,7);s.stroke();
    for(let v=0;v<=max;v+=10){const a=A(v),maj=v%20===0,l=maj?20:10;
      s.strokeStyle='#cfe0ee';s.lineWidth=maj?3.5:2;s.beginPath();s.moveTo(cx+Math.cos(a)*(r-18),cy+Math.sin(a)*(r-18));s.lineTo(cx+Math.cos(a)*(r-18-l),cy+Math.sin(a)*(r-18-l));s.stroke();
      if(v%40===0){s.fillStyle='#e9f2fa';s.font='bold 21px '+F;s.textAlign='center';s.textBaseline='middle';s.fillText(String(v),cx+Math.cos(a)*(r-52),cy+Math.sin(a)*(r-52))}}
  }
  c.setTransform(1,0,0,1,0,0);c.clearRect(0,0,PW,PW);c.drawImage(gStatic,0,0);
  c.setTransform(PW/340,0,0,PW/340,0,0);
  const a=A(Math.max(0,Math.min(max,kmh)));
  c.strokeStyle='#ff3b30';c.lineWidth=6;c.lineCap='round';c.beginPath();c.moveTo(cx-Math.cos(a)*18,cy-Math.sin(a)*18);c.lineTo(cx+Math.cos(a)*(r-24),cy+Math.sin(a)*(r-24));c.stroke();c.lineCap='butt';
  c.fillStyle='#0a1118';c.beginPath();c.arc(cx,cy,76,0,7);c.fill();c.strokeStyle='#ff3b30';c.lineWidth=3;c.beginPath();c.arc(cx,cy,76,0,7);c.stroke();
  c.fillStyle='#fff';c.font='bold 60px '+F;c.textAlign='center';c.textBaseline='middle';c.fillText(String(Math.round(kmh)),cx,cy-10);
  c.fillStyle='#8ea5b8';c.font='16px '+F;c.fillText('km/h',cx,cy+30);
  c.fillStyle='#4fd6ff';c.font='bold 26px '+F;c.fillText(String(gear),cx,cy+56);
}
// ---- mirrors (exterior views only): rear-view top-centre, left top-left, right top-right ----
const _mv=new THREE.Vector3();
// Left/right on-screen mirrors were removed from the exterior views; only the rear-view mirror remains.
{const _st=document.createElement('style');_st.textContent='#mleft,#mright{display:none!important}';document.head.appendChild(_st)}
const MIR=[['mrear',384,120,30,[0,1.3,2.4],0]].map(([id,w,h,fov,pos,off])=>{
  const el=document.getElementById(id),rt=new THREE.WebGLRenderTarget(w,h,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,generateMipmaps:false});
  rt.texture.repeat.x=-1;rt.texture.offset.x=1; // flip horizontally = real mirror image
  const cam=new THREE.PerspectiveCamera(fov,w/h,.3,1500);cam.rotation.order='YXZ';
  return{el,rt,cam,pos:new THREE.Vector3(pos[0],pos[1],pos[2]),off,mat:new THREE.MeshBasicMaterial({map:rt.texture,depthTest:false,depthWrite:false,fog:false})}});
const mqS=new THREE.Scene(),mqC=new THREE.OrthographicCamera(-1,1,1,-1,0,1),mqM=new THREE.Mesh(new THREE.PlaneGeometry(2,2),MIR[0].mat);mqS.add(mqM);
let mirI=0,mirC=0,mirShown=null,mirrorRefreshTick=0,mirrorDiv=1;const _mrEye=new THREE.Vector3(),_mrLook=new THREE.Vector3();
addEventListener('resize',()=>{for(const m of MIR)m.rect=null}); // mirror panel rectangles are cached between resizes
function renderMirrors(){
  const on=gameMode==='playing'&&!cockpitOn&&externalMirrorsVisible;
  if(on!==mirShown){mirShown=on;for(const m of MIR){m.el.style.display=on?'block':'none';m.rect=null}}
  // Menus and pause panels cover the scene; no mirror texture work is needed there.
  if(gameMode!=='playing')return;
  // Keep full mirror refresh while performance is healthy. If FPS remains low,
  // halve the expensive mirror captures automatically; recover when FPS improves.
  // Adaptive mirror capture rate (1 = one mirror every frame, 2/3 = one every 2nd/3rd frame), with hysteresis.
  if(fpsSmoothed<30)mirrorDiv=3;
  else if(fpsSmoothed<48){if(mirrorDiv<2||(mirrorDiv===3&&fpsSmoothed>=38))mirrorDiv=2}
  else if(fpsSmoothed>56)mirrorDiv=1;
  if(mirrorDiv<GFX.mirrorMin)mirrorDiv=GFX.mirrorMin;
  // Keep exterior and cockpit mirrors on the same refresh cadence.
  // At least one capture every 3 frames; the previous image remains visible between captures.
  const mirrorInterval=Math.max(3,mirrorDiv);
  const refreshMirror=(mirrorRefreshTick++%mirrorInterval)===0;
  if(cockpitOn){
    if(!refreshMirror)return;
    car.updateMatrixWorld(true);
    if(!MIRC.length)return;                                   // bikes have no interior mirrors (x%0 = NaN used to poison mirC for every car afterwards)
    if(!(mirC>=0&&mirC<MIRC.length))mirC=0;
    const qi=mirC,q=MIRC[qi];mirC=(mirC+1)%MIRC.length;if(mirPanels[qi*2]&&mirPanels[qi*2].userData.dead)return; // refresh one interior mirror per frame
    // The overhead mirror's face normal points out through the rear glass.
    // Place the virtual camera on the cabin side, then look THROUGH the mirror
    // toward the road behind the car (not toward the seats/dashboard).
    // Use the interior mesh transform so its FBX rotation is included correctly.
    const localEye=_mrEye.copy(q.centre).addScaledVector(q.normal,-.018);
    const localLook=_mrLook.copy(q.centre).addScaledVector(q.normal,160);
    const host=q.host||mirrorHost;
    const savedCarVisible=car.visible;
    q.cam.position.copy(host.localToWorld(localEye));
    q.cam.up.set(0,1,0);
    q.cam.lookAt(host.localToWorld(localLook));
    for(const p of mirPanels)p.visible=false; // prevent mirror-in-mirror feedback
    car.visible=false; // keep the mirror image to the outside road/traffic only
    renderer.setRenderTarget(q.rt);
    renderer.clear();
    renderOptimizedScene(q.cam,true);
    renderer.setRenderTarget(null);
    car.visible=savedCarVisible;
    for(const p of mirPanels)p.visible=!p.userData.dead;
    return;
  }
  if(!externalMirrorsVisible)return;
  if(refreshMirror){
    car.updateMatrixWorld(true);
    const m=MIR[mirI];mirI=(mirI+1)%MIR.length;
    m.cam.position.copy(car.localToWorld(_mv.copy(m.pos)));
    m.cam.rotation.set(-.03,st.h+Math.PI+m.off,0);
    renderer.setRenderTarget(m.rt);renderOptimizedScene(m.cam,true);renderer.setRenderTarget(null);
  }
  // Composite the last-captured mirror image every frame; only the expensive
  // scene capture is throttled, so the on-screen mirror never flickers.
  const ac=renderer.autoClear;renderer.autoClear=false;renderer.setScissorTest(true);
  for(const q of MIR){const r=q.rect||(q.rect=q.el.getBoundingClientRect());if(r.width<2)continue;const y=innerHeight-r.bottom;
    renderer.setViewport(r.left,y,r.width,r.height);renderer.setScissor(r.left,y,r.width,r.height);mqM.material=q.mat;renderer.render(mqS,mqC)}
  renderer.setScissorTest(false);renderer.setViewport(0,0,innerWidth,innerHeight);renderer.autoClear=ac;
}
// ---- physics: ARCADE handling, Need-for-Speed style ----
// * Normal driving: very high lateral grip -> the car goes exactly where it points, at every speed. No sliding from steering/throttle/brakes.
// * Handbrake (SPACE) is the ONLY thing that breaks rear grip -> controlled drift. Releasing it lets grip return smoothly.
// * No driver aids: nothing re-centres the car, no auto counter-steer, no yaw stabiliser. Release the wheel and the car keeps its heading.
// SI units, heading h>0 = turning left.
const P={m:1560,R:.33,
  ratios:[3.6,2.2,1.5,1.12,.9,.74],rev:4.5,fd:3.9,eff:.86,idle:900,
  g:9.81,rho:1.2,CdA:.74,Crr:.014,
  brake:13,hbBrake:3.5,maxTrac:11,        // m/s^2: foot brake, handbrake drag, traction cap on drive
  grip:14,gripSlide:1.1,slideIn:9,slideOut:3.2,slideFric:2.2, // lateral grip (1/s) normal / sliding, how fast rear lets go / regrips
  yaw0:2.1,yawV:38,yawMin:.38,yawLow:4,    // max yaw rate (rad/s) at standstill-ish, speed scale (m/s), floor at top speed, ramp-up speed
  lowK:.6,lowV:22.2,hbYaw:.9,sl0:.7,sl1:1.15,scrub:.06};     // extra rotation during handbrake, drift-angle soft limit (rad), turn scrub
const TQ=[[0,0],[800,120],[1500,200],[2500,310],[3500,366],[4500,352],[5500,335],[6500,300],[7000,250],[7500,100],[8000,0]];
function tq(r){if(r<=0)return 0;for(let i=1;i<TQ.length;i++){if(r<=TQ[i][0]){const a=TQ[i-1],b=TQ[i];return a[1]+(b[1]-a[1])*(r-a[0])/(b[0]-a[0])}}return 0}
let gi=0,accel=0,yawR=0,hbp=0,dlVis=0,engRPM=900,shiftT=0,brkp=0,axF=0,ayF=0,spinR=0,revMode=false,slide=0;
let throttleOffTime=0; // seconds since accelerator release
function step(dt){
if(BIKE)return stepBike(dt);
if(window.DRIVE&&DRIVE.enabled)return DRIVE.step(dt); // GTA-style tyre physics (js/drive-physics.js + js/drive-game.js); the arcade model below is the fallback
const keyGas=!!(keys.w||keys.arrowup),keyBrake=!!(keys.s||keys.arrowdown);
const gasAmount=Math.max(keyGas?1:0,Number(pad.throttle)|| (pad.gas?1:0));
const brakeAmount=Math.max(keyBrake?1:0,Number(pad.brakeAmount)|| (pad.brake?1:0));
const gas=gasAmount>.06,brk=brakeAmount>.06;
const keySteer=(keys.a||keys.arrowleft?1:0)-(keys.d||keys.arrowright?1:0);
const digitalPadSteer=(pad.left?1:0)-(pad.right?1:0);
const hb=keys[' ']||pad.hb;
if(gas&&!brk)throttleOffTime=0;
else if(!gas&&!brk)throttleOffTime+=dt;
else throttleOffTime=0;
// After 3 seconds of coasting, add a smooth extra deceleration up to 1.8 m/s².
const coastRetard=(!gas&&!brk)?1.8*Math.min(1,Math.max(0,(throttleOffTime-3)/1.25)):0;
let fx=-Math.sin(st.h),fz=-Math.cos(st.h);
let u0=st.wx*fx+st.wz*fz;
const sp0=Math.abs(u0);
// --- driver intent: W = go forward / brake if moving backwards, S = brake / reverse ---
let thrT=0,brkT=0,rev=false;
if(gas&&brk)brkT=brakeAmount;
else if(gas){if(u0<-1.5)brkT=gasAmount;else thrT=gasAmount}
else if(brk){if(u0>.4)brkT=brakeAmount;else{thrT=brakeAmount;rev=true}}
st.thr+=(thrT-st.thr)*Math.min(1,dt*(thrT?6:10));
brkp+=(brkT-brkp)*Math.min(1,dt*12);
// --- steering input: same snappy response at every speed (pure input smoothing, no self-centring) ---
const tg=Math.max(-1,Math.min(1,keySteer+digitalPadSteer+(Number(pad.steer)||0)));
st.steer+=(tg-st.steer)*Math.min(1,dt*(Math.abs(tg)>.01?11:13));
hbp+=((hb?1:0)-hbp)*Math.min(1,dt*(hb?12:20));
// rear-axle "slide" state: handbrake kills rear grip fast, grip comes back gradually after release
slide+=((hb?1:0)-slide)*Math.min(1,dt*(hb?P.slideIn:P.slideOut));
// --- automatic gearbox ---
const wr=g=>sp0/P.R*P.ratios[g]*P.fd*9.5493;
if(shiftT>0)shiftT-=dt;
else if(!rev){
  const th=st.thr;
  if(gi<5&&wr(gi)>3200+3500*th&&wr(gi+1)>1900){gi++;shiftT=.2}
  else if(gi>0&&((wr(gi)<1700+1100*th)||(th>.85&&wr(gi)<3600&&wr(gi-1)<5800))&&wr(gi-1)<6800){gi--;shiftT=.15}
}
if(rev){if(gi!==0&&sp0<2)gi=0}
revMode=rev;
const ratio=rev?P.rev:P.ratios[gi];
const rpmW=sp0/P.R*ratio*P.fd*9.5493;
const rpmE=Math.max(rpmW,P.idle+st.thr*(1300+1000*(rpmW<2500?1:0)));
let Te=0;
if(shiftT<=0){
  Te=st.thr*tq(rpmE)-(1-st.thr)*(rpmW>1300?18+.02*rpmE:0);
  if((rpmW>7100||(rev&&sp0>10))&&Te>0)Te=0; // rev limiter / reverse speed cap
}
const Fdrv=Te*ratio*P.fd*P.eff/P.R*(rev?-1:1);
const aDrive=Math.max(-P.maxTrac,Math.min(P.maxTrac,Fdrv/P.m));
engRPM+=(Math.min(rpmE,7300)-engRPM)*Math.min(1,dt*14);
// --- integrate in sub-steps ---
const n=Math.max(1,Math.ceil(dt/.008)),h=dt/n,kd=.5*P.rho*P.CdA/P.m;
let latSum=0,lonSum=0;
for(let s=0;s<n;s++){
  fx=-Math.sin(st.h);fz=-Math.cos(st.h);
  let rx=Math.cos(st.h),rz=-Math.sin(st.h);
  let u=st.wx*fx+st.wz*fz,v=st.wx*rx+st.wz*rz;
  const V=Math.hypot(u,v);
  // yaw: the steering wheel directly commands the rotation rate. Strong at low speed, still very responsive at top speed.
  const dir=u<-2?-1:1;
  const yawMax=Math.max(P.yawMin,P.yaw0/(1+(V/P.yawV)*(V/P.yawV)));
  const lt=Math.min(1,V/P.lowV),lowF=P.lowK+(1-P.lowK)*lt*lt*(3-2*lt); // steering feel 0-80 km/h, blends to 1 above 80 km/h
  let yt=st.steer*yawMax*lowF*Math.min(1,V/P.yawLow)*dir*(1+P.hbYaw*slide);
  if(dir>0){ // soft cap on drift angle so the handbrake turn never becomes an uncontrollable spin (rotation only, nothing straightens the car)
    const beta=Math.atan2(v,Math.max(Math.abs(u),.5));
    if(yt*beta>0){const t=Math.min(1,Math.max(0,(Math.abs(beta)-P.sl0)/(P.sl1-P.sl0)));yt*=1-t*t*(3-2*t)}
  }
  yawR+=(yt-yawR)*Math.min(1,h*(11-6*slide));
  st.h+=yawR*h;st.h+=st.cw*h;st.cw*=Math.exp(-CRASH.cwDecay*h);
  // body axes after rotation (world velocity is unchanged by rotating the body -> this is what creates the slide angle)
  fx=-Math.sin(st.h);fz=-Math.cos(st.h);rx=Math.cos(st.h);rz=-Math.sin(st.h);
  u=st.wx*fx+st.wz*fz;v=st.wx*rx+st.wz*rz;
  // longitudinal: engine, brakes, handbrake drag, aero, rolling, sliding friction, turn scrub
  const su=Math.tanh(u/.4);
  const a=aDrive-(brkp*P.brake+hbp*P.hbBrake+coastRetard+P.slideFric*slide*Math.min(1,Math.abs(v)/3)+P.scrub*Math.abs(u*yawR))*su
          -kd*V*u-P.Crr*P.g*Math.tanh(u/.3);
  const un=u+a*h;
  u=(!thrT&&u*un<0)?0:un; // brakes / resistance can stop the car but never reverse it
  // lateral: rear grip pulls sideways velocity to zero. Huge grip normally, almost none while the handbrake slides the rear.
  const g=P.grip*Math.pow(P.gripSlide/P.grip,slide);
  const vOld=v;
  v=(v-kd*V*v*h)*Math.exp(-g*h);
  latSum+=(v-vOld)/h;lonSum+=a;
  st.wx=u*fx+v*rx;st.wz=u*fz+v*rz;
  st.x+=st.wx*h;st.z+=st.wz*h;
}
const kf=Math.min(1,dt*12);
axF+=(lonSum/n-axF)*kf;ayF+=(-latSum/n-ayF)*kf;
// full stop / parking
{const vv=Math.hypot(st.wx,st.wz);
 if(!thrT&&vv<.25&&(hb||brkp>.2||vv<.1)){st.wx=st.wz=0;yawR=0}}
fx=-Math.sin(st.h);fz=-Math.cos(st.h);
const rx2=Math.cos(st.h),rz2=-Math.sin(st.h);
const vf=st.wx*fx+st.wz*fz,vl=st.wx*rx2+st.wz*rz2,sp=Math.abs(vf);
accel=axF;
// visual front-wheel angle: steering lock + natural counter-steer look while the car slides
{const lock=.5/(1+(sp/40)*(sp/40))+.18;
 const bt=Math.atan2(vl,Math.max(Math.abs(vf),.5));
 dlVis=st.steer*lock-Math.max(-.4,Math.min(.4,bt))*Math.min(1,slide*2);}
resolveCurbs(dt);
// --- body motion (roll / pitch) and wheel spin ---
st.roll+=(Math.max(-.055,Math.min(.055,-ayF*.0055))-st.roll)*Math.min(1,dt*6);
st.pitch+=(Math.max(-.05,Math.min(.05,axF*.0035))-st.pitch)*Math.min(1,dt*6);
spin-=vf*dt/P.R;
if(!hb)spinR-=vf*dt/P.R;
tailM.opacity=(hb||(brk&&vf>.2))?1:(isNight?.6:.45);
return vf}

function resolveCurbs(dt){
// --- Curved-road curbs: detect/resolve contact in road-local lateral coordinates.
{const pc=playerRoadCoords(),sg=pc.x>=0?1:-1,_w=pc.x>=0&&bridgeElev(pc.z)>=BR_WALL_E,CO=_w&&pc.x<BR_MID?BR_WALL_L:19.33,CI=_w&&pc.x>=BR_MID?BR_WALL_R:1.0,HW=PLAYER_HW,HL=PLAYER_HL,II=(HL*HL+HW*HW)/3;
 const relativeHeading=st.h-pc.yaw,ch=Math.cos(relativeHeading),sh=Math.sin(relativeHeading);
 const ext=HW*Math.abs(ch)+HL*Math.abs(sh),a=sg*pc.x;
 let d=0,pen=0;
 if(a+ext>CO-.02){d=1;pen=a+ext-CO+.02}else if(a-ext<CI+.02){d=-1;pen=CI+.02-(a-ext)}
 if(d){
  const correctedLateral=pc.x-sg*d*pen;
  st.x=pc.frame.x+correctedLateral*pc.c;
  st.z=pc.z-correctedLateral*pc.sn;
  const nx=sg*d*pc.c,nz=-sg*d*pc.sn;
  let rx=0,rz=0,best=-Infinity;
  for(const fs of [-1,1])for(const rs of [-1,1]){
    const qx=fs*HL*(-Math.sin(st.h))+rs*HW*Math.cos(st.h);
    const qz=fs*HL*(-Math.cos(st.h))+rs*HW*(-Math.sin(st.h));
    const score=qx*nx+qz*nz;if(score>best){best=score;rx=qx;rz=qz;}
  }
  const vin=nx*(st.wx+yawR*rz)+nz*(st.wz-yawR*rx);
  // Side contact (car roughly parallel to the kerb): no bounce, no spin, no sideways shove - it just scrapes and slows until it stops.
  // Frontal / corner contact at a real angle: the car bounces off and spins until it settles.
  const side=Math.abs(Math.sin(relativeHeading))<.3,tx=-Math.sin(pc.yaw),tz=-Math.cos(pc.yaw);
  if(vin>0){
   if(vin>1.2)crashSound(Math.min(1,vin/14));
   if(vin>2)damageParts(rx*Math.cos(st.h)-rz*Math.sin(st.h),rx*Math.sin(st.h)+rz*Math.cos(st.h),.9);
   if(side){st.wx-=nx*vin;st.wz-=nz*vin}
   else{
    const J=1.15*vin/(1+(rz*rz+rx*rx*.15)/II);
    st.wx-=nx*J;st.wz-=nz*J;
    st.cw=Math.max(-4.5,Math.min(4.5,st.cw-(rz*nx-rx*nz)*J/II*Math.min(1.6,.4+vin/6)));
    if(vin>3){FX.sparks(st.x+rx,.4+bridgeElevAt(st.x,st.z),st.z+rz,st.wx,st.wz,Math.min(30,Math.round(vin*2)),Math.min(1,vin/12));FX.smoke(st.x+rx,.5+bridgeElevAt(st.x,st.z),st.z+rz,st.wx,st.wz,3,.5);crashShake=Math.max(crashShake,Math.min(1,vin/14))}
   }
  }
  {const vt=st.wx*tx+st.wz*tz,dec=Math.min(Math.abs(vt),(side?6:4)*dt);
   if(dec>0){st.wx-=tx*Math.sign(vt)*dec;st.wz-=tz*Math.sign(vt)*dec}
   if(side&&(vin>1||Math.abs(vt)>5))killMirrorSide(nx*Math.cos(st.h)-nz*Math.sin(st.h)>0?1:-1);
   if(Math.abs(vt)>4&&Math.random()<.7)FX.sparks(st.x+rx,.3+bridgeElevAt(st.x,st.z),st.z+rz,st.wx,st.wz,1,.2)}
 }}
}

/*MATH_START*/
// ---- Crash maths (pure functions, no THREE): footprint hull, SAT contact, impulse ----
const CrashMath=(()=>{
  // Build a convex footprint polygon from every vertex of a car (x,z in the car's own frame).
  function buildFootprint(forEach){
    let mnx=Infinity,mxx=-Infinity,mnz=Infinity,mxz=-Infinity;
    forEach((x,z)=>{if(x<mnx)mnx=x;if(x>mxx)mxx=x;if(z<mnz)mnz=z;if(z>mxz)mxz=z});
    if(!isFinite(mnx)||mxx-mnx<.2||mxz-mnz<.2)return null;
    const cx=(mnx+mxx)/2,cz=(mnz+mxz)/2,B=120,best=new Float64Array(B).fill(-1),bx=new Float64Array(B),bz=new Float64Array(B);
    forEach((x,z)=>{
      const dx=x-cx,dz=z-cz,d=dx*dx+dz*dz;
      let k=Math.floor((Math.atan2(dz,dx)+Math.PI)/(2*Math.PI)*B);if(k>=B)k=B-1;
      if(d>best[k]){best[k]=d;bx[k]=x;bz[k]=z}
    });
    const pts=[];for(let k=0;k<B;k++)if(best[k]>=0)pts.push([bx[k],bz[k]]);
    const poly=hull(pts);
    let r=0;for(const p of poly)r=Math.max(r,Math.hypot(p[0]-cx,p[1]-cz));
    return{poly,cx,cz,hw:(mxx-mnx)/2,hl:(mxz-mnz)/2,r};
  }
  function hull(pts){
    pts=pts.slice().sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const cr=(o,a,b)=>(a[0]-o[0])*(b[1]-o[1])-(a[1]-o[1])*(b[0]-o[0]),EPS=2e-3;
    const lo=[];for(const p of pts){while(lo.length>=2&&cr(lo[lo.length-2],lo[lo.length-1],p)<=EPS)lo.pop();lo.push(p)}
    const up=[];for(let i=pts.length-1;i>=0;i--){const p=pts[i];while(up.length>=2&&cr(up[up.length-2],up[up.length-1],p)<=EPS)up.pop();up.push(p)}
    up.pop();lo.pop();return lo.concat(up);
  }
  function polyArea(poly){let a=0;for(let i=0;i<poly.length;i++){const p=poly[i],q=poly[(i+1)%poly.length];a+=p[0]*q[1]-q[0]*p[1]}return a/2}
  function clipPoly(subj,clipP){
    const sg=polyArea(clipP)>=0?1:-1;let out=subj;
    for(let i=0;i<clipP.length&&out.length;i++){
      const a=clipP[i],b=clipP[(i+1)%clipP.length],inp=out;out=[];
      const side=q=>sg*((b[0]-a[0])*(q[1]-a[1])-(b[1]-a[1])*(q[0]-a[0]));
      for(let j=0;j<inp.length;j++){
        const p=inp[j],q=inp[(j+1)%inp.length],sp=side(p),sq=side(q);
        if(sp>=0)out.push(p);
        if((sp>=0)!==(sq>=0)){const t=sp/(sp-sq);out.push([p[0]+(q[0]-p[0])*t,p[1]+(q[1]-p[1])*t])}
      }
    }
    return out;
  }
  function axesOf(poly,out){
    for(let i=0;i<poly.length;i++){
      const a=poly[i],b=poly[(i+1)%poly.length],ex=b[0]-a[0],ez=b[1]-a[1],l=Math.hypot(ex,ez);
      if(l>1e-6)out.push([ez/l,-ex/l]);
    }
  }
  function project(poly,nx,nz){let mn=Infinity,mx=-Infinity;for(const p of poly){const d=p[0]*nx+p[1]*nz;if(d<mn)mn=d;if(d>mx)mx=d}return[mn,mx]}
  function inside(poly,x,z){
    let s=0;
    for(let i=0;i<poly.length;i++){
      const a=poly[i],b=poly[(i+1)%poly.length],c=(b[0]-a[0])*(z-a[1])-(b[1]-a[1])*(x-a[0]);
      if(c>1e-9){if(s<0)return false;s=1}else if(c<-1e-9){if(s>0)return false;s=-1}
    }
    return true;
  }
  // SAT between world-space convex polygons. A,B: {pts,cx,cz}. dvx,dvz: velocity of B relative to A, dt: frame time.
  // Returns {nx,nz (A->B), depth, px,pz (contact point)} or null.
  // The contact axis is the one the cars entered through (time of impact), so fast hits do not get pushed sideways.
  function contact(A,B,dvx,dvz,dt){
    const axes=[];axesOf(A.pts,axes);axesOf(B.pts,axes);
    const dx=B.cx-A.cx,dz=B.cz-A.cz;
    let bestT=-Infinity,toi=null,minO=Infinity,minAx=null;
    for(const ax of axes){
      let nx=ax[0],nz=ax[1];
      if(nx*dx+nz*dz<0){nx=-nx;nz=-nz}
      const pa=project(A.pts,nx,nz),pb=project(B.pts,nx,nz);
      const o=Math.min(pa[1]-pb[0],pb[1]-pa[0]);
      if(o<=0||pa[1]<=pb[0]||pb[1]<=pa[0])return null;
      if(o<minO){minO=o;minAx=[nx,nz,o]}
      const r=-(dvx*nx+dvz*nz);
      if(r>1e-3){const t=dt-o/r;if(t>bestT){bestT=t;toi=[nx,nz,o]}}
    }
    let ax=toi||minAx;if(!ax)return null;
    if(minAx&&ax[2]>minAx[2]+.25)ax=minAx; // the entry axis went deep (lag spike / odd shape): use the shallowest axis instead of a huge shove
    const nx=ax[0],nz=ax[1];
    let sx=0,sz=0,n=0;
    // contact point = centre of the overlap region of the two footprints (Sutherland-Hodgman clip); gives a sensible lever arm for the spin
    const ip=clipPoly(A.pts,B.pts);
    if(ip.length>=3){
      let ar=0,gx=0,gz=0;
      for(let i=0;i<ip.length;i++){const a=ip[i],b=ip[(i+1)%ip.length],cr=a[0]*b[1]-b[0]*a[1];ar+=cr;gx+=(a[0]+b[0])*cr;gz+=(a[1]+b[1])*cr}
      if(Math.abs(ar)>1e-6){sx=gx/(3*ar);sz=gz/(3*ar);n=1}
    }
    if(n===0){for(const p of A.pts)if(inside(B.pts,p[0],p[1])){sx+=p[0];sz+=p[1];n++}
    for(const p of B.pts)if(inside(A.pts,p[0],p[1])){sx+=p[0];sz+=p[1];n++}}
    if(n===0){
      let a=null,b=null,da=-Infinity,db=Infinity;
      for(const p of A.pts){const d=p[0]*nx+p[1]*nz;if(d>da){da=d;a=p}}
      for(const p of B.pts){const d=p[0]*nx+p[1]*nz;if(d<db){db=d;b=p}}
      sx=a[0]+b[0];sz=a[1]+b[1];n=2;
    }
    return{nx,nz,depth:ax[2],px:sx/n,pz:sz/n};
  }
  const push=(b,jx,jz,rx,rz)=>{b.vx+=jx*b.invM;b.vz+=jz*b.invM;b.w+=(rz*jx-rx*jz)*b.invI};
  // Rigid-body impulse with restitution e and Coulomb friction mu. Bodies: {vx,vz,w,invM,invI,cx,cz}.
  // Velocity of a point r from the centre: v + w*(rz,-rx). Returns {jn,vn,jt} or null if separating.
  function impulse(A,B,mf,e,mu){
    const rax=mf.px-A.cx,raz=mf.pz-A.cz,rbx=mf.px-B.cx,rbz=mf.pz-B.cz,nx=mf.nx,nz=mf.nz;
    const rel=()=>[B.vx+B.w*rbz-A.vx-A.w*raz,B.vz-B.w*rbx-A.vz+A.w*rax];
    let [rvx,rvz]=rel();
    const vn=rvx*nx+rvz*nz;
    if(vn>=0)return null;
    const raN=raz*nx-rax*nz,rbN=rbz*nx-rbx*nz;
    const jn=-(1+e)*vn/(A.invM+B.invM+raN*raN*A.invI+rbN*rbN*B.invI);
    push(A,-nx*jn,-nz*jn,rax,raz);push(B,nx*jn,nz*jn,rbx,rbz);
    [rvx,rvz]=rel();
    let tx=rvx-(rvx*nx+rvz*nz)*nx,tz=rvz-(rvx*nx+rvz*nz)*nz;const tl=Math.hypot(tx,tz);
    let jt=0;
    if(tl>1e-4){
      tx/=tl;tz/=tl;
      const raT=raz*tx-rax*tz,rbT=rbz*tx-rbx*tz;
      jt=-tl/(A.invM+B.invM+raT*raT*A.invI+rbT*rbT*B.invI);
      const lim=mu*jn;if(jt<-lim)jt=-lim;
      push(A,-tx*jt,-tz*jt,rax,raz);push(B,tx*jt,tz*jt,rbx,rbz);
    }
    return{jn,vn,jt};
  }
  return{buildFootprint,hull,contact,impulse,inside};
})();
/*MATH_END*/

// ---- Car-to-car collisions: exact footprint hitboxes, rigid-body response, visual / audio effects ----
const CRASH={e0:.03,e1:.1,mu:.3,cwDecay:1.7,maxCw:2.6,maxPush:.06,pushFrac:.8,hitTime:6,maxDent:.05,partHits:2,partGapMs:400};
const TRAFFIC_MASS={exo90:1500,dirty_car:1350,peugeot206:1100};
var _crashReady=false;
let PLAYER_HW=.92,PLAYER_HL=2.28,crashShake=0,showHitboxes=false,_playerHB=null,_playerDentMeshes=null;
const _hbMat=new THREE.LineBasicMaterial({color:0x00ff66,depthTest:false,transparent:true});

// ---- Hitbox tuning (edit these numbers; press H in game to see the green outline) ----
// Side mirrors sit above ~60 % of a car's height and make the convex hull 13-22 cm wider than the body,
// so cars used to "collide" while a visible gap was left between them. The footprint is therefore built only
// from the part of the car BELOW maxHeightFrac x its height (bumpers, fenders, doors, wheels), which excludes the mirrors.
//   maxHeightFrac : 0.55 = ignore everything above 55 % of the car height (mirrors, roof, antenna). 1 = use everything.
//   sideFit/sidePct: the box sides are placed where the body side really is (sidePct = percentile of the slice widths along the door area;
//                   0.5 = median, lower = tighter). Wheel arches / fender flares are wider than the doors, and a convex box that wraps
//                   them left a gap along the doors. false = old behaviour (widest point).
//   insetSide     : metres removed from EACH side of the box (0 = exact body, negative = box slightly bigger, positive = more forgiving).
//   insetEnd      : metres removed from the front and from the rear.
var HB_TUNE={maxHeightFrac:.55,sideFit:true,sidePct:.35,insetSide:0,insetEnd:-.02};
// Motorcycle hitbox: built from the real bike + rider vertices that are lower than maxHeightAbs metres above the tyre bottom.
// (A % of the total height does not work for a bike: with the rider the cap lands at ~0.96 m, exactly where the mirrors / handlebar
//  ends start (0.947 m, x = +-0.52), so the box swung between 0.62 m and 1.05 m wide and left a gap of up to 21 cm on each side.)
//   maxHeightAbs : 0.90 -> body, tank, indicators, pegs, knees, tyres = exact 0.62 x 2.09 m.  1.00 would add the handlebar ends + mirrors (1.05 m wide).
//   insetSide/insetEnd : metres removed from each side / each end (0 = exact, negative = slightly bigger).
var HB_TUNE_BIKE={maxHeightAbs:.90,sideFit:false,insetSide:0,insetEnd:0,
  halfW:.22,      // half-width of the box in metres: the SAME width from the front to the rear (0.22 -> 44 cm wide)
  chamfer:.20,    // length (m) of the cut corners at the very front and very rear (same at both ends)
  endHalfW:.11};  // half-width at the very tip of the front / rear (tyre width)
// Straight-sided bike box (same width front and rear) instead of the convex hull, which was wide at the front and narrow at the tail.
function bikeBoxFootprint(fp,T){
  if(!fp||!(T.halfW>0))return fp;
  const W=T.halfW,c=Math.min(T.chamfer||0,fp.hl*.5),e=Math.min(T.endHalfW||W,W),z0=fp.cz-fp.hl,z1=fp.cz+fp.hl,x=fp.cx;
  const poly=[[x-e,z0],[x+e,z0],[x+W,z0+c],[x+W,z1-c],[x+e,z1],[x-e,z1],[x-W,z1-c],[x-W,z0+c]];
  let r=0;for(const q of poly)r=Math.max(r,Math.hypot(q[0]-fp.cx,q[1]-fp.cz));
  return{poly,cx:fp.cx,cz:fp.cz,hw:W,hl:fp.hl,r};
}
// Typical half-width of the body side: widest vertex per 25 cm slice over the middle 70 % of the length, then the sidePct-percentile of those.
function robustHalfWidth(xs,zs,cx,cz,hl,pct){
  const bin=.25,lo=cz-hl*.7,hi=cz+hl*.7,nb=Math.max(1,Math.floor((hi-lo)/bin)),mx=new Float64Array(nb),cnt=new Int32Array(nb);
  for(let i=0;i<xs.length;i++){const z=zs[i];if(z<lo||z>=hi)continue;const k=Math.floor((z-lo)/bin),d=Math.abs(xs[i]-cx);cnt[k]++;if(d>mx[k])mx[k]=d}
  const v=[];for(let k=0;k<nb;k++)if(cnt[k]>=6)v.push(mx[k]);
  if(v.length<3)return 0;v.sort((a,b)=>a-b);return v[Math.min(v.length-1,Math.floor(v.length*pct))];
}
function shrinkFootprint(fp,sideIn,endIn){
  if(!fp||(!sideIn&&!endIn))return fp;
  const sx=Math.max(.5,(fp.hw-sideIn)/fp.hw),sz=Math.max(.5,(fp.hl-endIn)/fp.hl);
  const poly=fp.poly.map(p=>[fp.cx+(p[0]-fp.cx)*sx,fp.cz+(p[1]-fp.cz)*sz]);
  let r=0;for(const p of poly)r=Math.max(r,Math.hypot(p[0]-fp.cx,p[1]-fp.cz));
  return{poly,cx:fp.cx,cz:fp.cz,hw:fp.hw*sx,hl:fp.hl*sz,r};
}
// Real footprint of a model: the vertices of every mesh (below the height cap), projected on the ground plane in the model's own frame.
function collectFootprint(root,skip,tune){
  root.updateMatrixWorld(true);
  const inv=new THREE.Matrix4().copy(root.matrixWorld).invert(),m=new THREE.Matrix4(),meshes=[];
  root.traverse(o=>{
    if(!o.isMesh||!o.geometry||!o.geometry.attributes.position||o.visible===false)return;
    if(o.material===tailM||o.material===headM||(skip&&skip(o)))return;
    meshes.push(o);
  });
  const T=tune||HB_TUNE||{maxHeightFrac:.55,sideFit:true,sidePct:.35,insetSide:0,insetEnd:-.02};
  const each=(cb,capY)=>{
    for(const o of meshes){
      m.multiplyMatrices(inv,o.matrixWorld);const e=m.elements,pos=o.geometry.attributes.position,n=pos.count;
      for(let i=0;i<n;i++){
        const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i),ly=e[1]*x+e[5]*y+e[9]*z+e[13];
        if(ly>capY)continue;
        cb(e[0]*x+e[4]*y+e[8]*z+e[12],e[2]*x+e[6]*y+e[10]*z+e[14],ly);
      }
    }
  };
  let y0=Infinity,y1=-Infinity;
  each((x,z,y)=>{if(y<y0)y0=y;if(y>y1)y1=y},Infinity);
  const frac=T.maxHeightFrac,capY=(T.maxHeightAbs>0&&isFinite(y0))?y0+T.maxHeightAbs:((isFinite(y0)&&frac>0&&frac<1)?y0+(y1-y0)*frac:Infinity);
  let fp=CrashMath.buildFootprint(cb=>each(cb,capY));
  if(!fp&&capY!==Infinity)fp=CrashMath.buildFootprint(cb=>each(cb,Infinity)); // safety: never end up without a hitbox
  if(fp&&T.sideFit){
    const xs=[],zs=[];each((x,z)=>{xs.push(x);zs.push(z)},capY);
    const hwT=robustHalfWidth(xs,zs,fp.cx,fp.cz,fp.hl,T.sidePct);
    if(hwT>fp.hw*.6&&hwT<fp.hw){ // pull the sides in to the real body side (x only; the front and rear stay as they are)
      const sx=hwT/fp.hw;let r=0;
      const poly=fp.poly.map(p=>[fp.cx+(p[0]-fp.cx)*sx,p[1]]);
      for(const p of poly)r=Math.max(r,Math.hypot(p[0]-fp.cx,p[1]-fp.cz));
      fp={poly,cx:fp.cx,cz:fp.cz,hw:hwT,hl:fp.hl,r};
    }
  }
  return shrinkFootprint(fp,T.insetSide,T.insetEnd);
}
function playerHB(){
  if(_playerHB)return _playerHB;
  initCarParts();
  if(!car.children.length)return{poly:[[-.92,-2.28],[.92,-2.28],[.92,2.28],[-.92,2.28]],cx:0,cz:0,hw:.92,hl:2.28,r:2.46,fallback:true};
  const inWheel=o=>{for(let p=o;p&&p!==car;p=p.parent)if(p.userData&&'rear' in p.userData)return true;return false};
  const inCabin=o=>{for(let p=o;p;p=p.parent)if(p===mirrorHost||p===swPivot)return true;return false}; // cabin + steering wheel are never damaged
  const inDash=o=>{for(let p=o;p&&p!==car;p=p.parent)if(p===cluster||(p.userData&&p.userData.noDent))return true;const ms=Array.isArray(o.material)?o.material:[o.material];return ms.some(m=>m&&/^Dash_|^Indicator|^Lamp_/.test(m.name||''))}; // instrument display / indicators are never damaged
  const skip=o=>inWheel(o)||inCabin(o)||inDash(o)||mirPanels.includes(o)||o===cluster||/Interior|Seat|Belt|Steer|Dash|Cabin/i.test(o.name||'');
  _playerHB=(BIKE?bikeBoxFootprint(collectFootprint(car,skip,HB_TUNE_BIKE),HB_TUNE_BIKE):collectFootprint(car,skip))||{poly:[[-.92,-2.28],[.92,-2.28],[.92,2.28],[-.92,2.28]],cx:0,cz:0,hw:.92,hl:2.28,r:2.46};
  PLAYER_HW=_playerHB.hw;PLAYER_HL=_playerHB.hl;
  const list=[];
  car.traverse(o=>{if(o.isMesh&&o.geometry&&o.geometry.attributes.position&&o.material!==tailM&&o.material!==headM&&!skip(o)&&o.visible!==false)list.push(o)});
  _playerDentMeshes=list;
  console.info('Player hitbox:',(_playerHB.hw*2).toFixed(2)+' x '+(_playerHB.hl*2).toFixed(2)+' m, hull vertices',_playerHB.poly.length);
  return _playerHB;
}

// ---- lamps (4) and cabin door mirrors: break when hit, never the steering wheel ----
const LAMPS={fl:null,fr:null,rl:null,rr:null},_mirPos=[],_mirHit=[];
let _partsReady=false;
function initCarParts(){
  if(_partsReady||!car.children.length)return;_partsReady=true;
  try{
    car.updateMatrixWorld(true);
    const inv=new THREE.Matrix4().copy(car.matrixWorld).invert(),m=new THREE.Matrix4(),found=[];
    car.traverse(o=>{if(o.isMesh&&(o.material===headM||o.material===tailM)&&o.geometry.attributes.position)found.push(o)});
    for(const o of found){ // split each glow overlay into its left and right lamp (car-local +x = right)
      const front=o.material===headM,pos=o.geometry.attributes.position.array;
      m.multiplyMatrices(inv,o.matrixWorld);const e=m.elements;
      const bk=[[],[]],sm=[[0,0,0,0],[0,0,0,0]];
      for(let t=0;t+8<pos.length;t+=9){
        let cx=0,cz=0,cy=0;
        for(let k=0;k<3;k++){const x=pos[t+k*3],y=pos[t+k*3+1],z=pos[t+k*3+2];cx+=e[0]*x+e[4]*y+e[8]*z+e[12];cy+=e[1]*x+e[5]*y+e[9]*z+e[13];cz+=e[2]*x+e[6]*y+e[10]*z+e[14]}
        cx/=3;cz/=3;cy/=3;const s=cx>0?1:0;
        for(let k=0;k<9;k++)bk[s].push(pos[t+k]);
        sm[s][0]+=cx;sm[s][1]+=cz;sm[s][2]++;sm[s][3]+=cy;
      }
      for(let s=0;s<2;s++){
        if(!sm[s][2])continue;
        const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(bk[s],3));
        const mesh=new THREE.Mesh(g,o.material);mesh.renderOrder=o.renderOrder;mesh.castShadow=false;mesh.receiveShadow=false;mesh.frustumCulled=false;
        o.parent.add(mesh);
        LAMPS[(front?'f':'r')+(s?'r':'l')]={mesh,x:sm[s][0]/sm[s][2],z:sm[s][1]/sm[s][2],ok:true,hits:0,last:-1e9};
        if(front)LAMPS['f'+(s?'r':'l')].halo=makeHeadHalo(sm[s][0]/sm[s][2],sm[s][3]/sm[s][2],sm[s][1]/sm[s][2]);
      }
      o.parent.remove(o);
    }
    if(mirrorHost)for(let i=0;i<MIRC.length;i++){const p=car.worldToLocal(mirrorHost.localToWorld(MIRC[i].centre.clone()));_mirPos[i]={x:p.x,z:p.z}}
    console.info('Lamps:',Object.keys(LAMPS).filter(k=>LAMPS[k]).join(','),'mirrors:',_mirPos.length);
  }catch(e){console.warn('lamp setup failed',e)}
  _crashReady=true;
}
function applyLamps(){
  const ok=k=>!LAMPS[k]||LAMPS[k].ok;
  if(headLights[0])headLights[0].intensity=(headOn&&ok('fl'))?2.6:0;
  if(headLights[1])headLights[1].intensity=(headOn&&ok('fr'))?2.6:0;
  if(headPool.children[0])headPool.children[0].visible=ok('fl');
  if(headPool.children[1])headPool.children[1].visible=ok('fr');
  for(const k in LAMPS)if(LAMPS[k]){LAMPS[k].mesh.visible=LAMPS[k].ok;if(LAMPS[k].halo)LAMPS[k].halo.visible=headOn&&LAMPS[k].ok}
}
function killMirror(i){
  const a=mirPanels[i*2],b=mirPanels[i*2+1];
  if(!a||a.userData.dead)return;
  a.userData.dead=b.userData.dead=true;a.visible=b.visible=false;
}
// A lamp / interior mirror only breaks once ITS OWN zone has been hit CRASH.partHits times.
// Contacts that follow each other closer than CRASH.partGapMs (one scrape along the kerb, one pile-up)
// count as the SAME hit, so it takes separate impacts to wreck a part.
function partTakesHit(S){
  const now=performance.now(),fresh=now-S.last>CRASH.partGapMs;
  S.last=now;if(fresh)S.hits++;
  return S.hits>=CRASH.partHits;
}
function hitMirror(i){
  const a=mirPanels[i*2];if(!a||a.userData.dead)return;
  if(partTakesHit(_mirHit[i]||(_mirHit[i]={hits:0,last:-1e9})))killMirror(i);
}
function damageParts(lx,lz,R){
  if(!_crashReady)return;
  const rad=Math.max(.85,R*.9);let lampHit=false;
  for(const k in LAMPS){const L=LAMPS[k];if(L&&L.ok&&Math.hypot(L.x-lx,L.z-lz)<rad&&partTakesHit(L)){L.ok=false;lampHit=true}}
  if(lampHit)applyLamps();
  for(let i=1;i<_mirPos.length;i++)if(_mirPos[i]&&Math.hypot(_mirPos[i].x-lx,_mirPos[i].z-lz)<rad)hitMirror(i);
}
function killMirrorSide(sign){for(let i=1;i<_mirPos.length;i++)if(_mirPos[i]&&Math.sign(_mirPos[i].x)===sign)hitMirror(i)}
function trafficMeshes(v){
  if(v.dentList)return v.dentList;
  const list=[];
  v.root.traverse(o=>{
    if(!o.isMesh||!o.geometry||!o.geometry.attributes.position||(o.userData&&o.userData.noDent))return;
    for(let p=o.parent;p&&p!==v.root;p=p.parent)if(p.userData&&p.userData.isTrafficWheelPivot)return;
    list.push(o);
  });
  return v.dentList=list;
}

// ---- body dents: push vertices near the impact point inward (accumulated, capped) ----
function dentMeshes(root,meshes,px,py,pz,dx,dy,dz,depth,R,shared){
  root.updateMatrixWorld(true);
  const inv=new THREE.Matrix4().copy(root.matrixWorld).invert(),rel=new THREE.Matrix4(),rinv=new THREE.Matrix4(),c=new THREE.Vector3();
  const R2=R*R,maxD=CRASH.maxDent;
  // motorcycle: the instrument display and the plastic around it are protected, so a crash can never push the screen out of sight (dents fade in beyond 0.12-0.24 m from the screen)
  let safeP=null;if(!shared&&root===car&&typeof BIKE!=='undefined'&&BIKE&&cluster){cluster.updateMatrixWorld(true);safeP=new THREE.Vector3().setFromMatrixPosition(cluster.matrixWorld).applyMatrix4(inv)}
  for(const o of meshes){
    let g=o.geometry;
    if(!g.boundingSphere)g.computeBoundingSphere();
    rel.multiplyMatrices(inv,o.matrixWorld);
    c.copy(g.boundingSphere.center).applyMatrix4(rel);
    const sc=rel.getMaxScaleOnAxis();
    if(c.distanceTo(_dentP.set(px,py,pz))>R+g.boundingSphere.radius*sc)continue;
    let orig;
    if(shared){ // traffic geometries are shared between clones: give this car its own copy before editing
      if(!o.userData.dOrigGeo){o.userData.dOrigGeo=g;g=o.geometry=g.clone()}
      orig=o.userData.dOrigGeo.attributes.position.array;
    }else{
      if(!o.userData.dOrig)o.userData.dOrig=g.attributes.position.array.slice();
      orig=o.userData.dOrig;
    }
    rinv.copy(rel).invert();
    const e=rel.elements,ei=rinv.elements,pos=g.attributes.position,a=pos.array,n=pos.count,s=pos.itemSize;
    let touched=false;
    for(let i=0;i<n;i++){
      const k=i*s,x=a[k],y=a[k+1],z=a[k+2];
      const rx=e[0]*x+e[4]*y+e[8]*z+e[12],ry=e[1]*x+e[5]*y+e[9]*z+e[13],rz=e[2]*x+e[6]*y+e[10]*z+e[14];
      const ddx=rx-px,ddy=ry-py,ddz=rz-pz,d2=ddx*ddx+ddy*ddy+ddz*ddz;
      if(d2>=R2)continue;
      const f=1-Math.sqrt(d2)/R,noise=.65+.7*(((i*2654435761)>>>0)/4294967296);let amt=depth*f*f*noise;
      if(safeP){const sd=Math.hypot(rx-safeP.x,ry-safeP.y,rz-safeP.z);if(sd<.24)amt*=sd<.12?0:(sd-.12)/.12}
      const qx=rx+dx*amt,qy=ry+dy*amt-.12*amt,qz=rz+dz*amt;
      let nx=ei[0]*qx+ei[4]*qy+ei[8]*qz+ei[12],ny=ei[1]*qx+ei[5]*qy+ei[9]*qz+ei[13],nz=ei[2]*qx+ei[6]*qy+ei[10]*qz+ei[14];
      const ox=orig[k],oy=orig[k+1],oz=orig[k+2],ex=nx-ox,ey=ny-oy,ez=nz-oz,len=Math.hypot(ex,ey,ez)*sc;
      if(len>maxD){const q=maxD/len;nx=ox+ex*q;ny=oy+ey*q;nz=oz+ez*q}
      a[k]=nx;a[k+1]=ny;a[k+2]=nz;touched=true;
    }
    if(touched)pos.needsUpdate=true;
  }
}
const _dentP=new THREE.Vector3();
function repairPlayerCar(){
  if(_crashReady){for(const k in LAMPS)if(LAMPS[k]){LAMPS[k].ok=true;LAMPS[k].hits=0;LAMPS[k].last=-1e9}_mirHit.length=0;applyLamps();mirPanels.forEach(p=>{p.userData.dead=false;p.visible=cockpitOn})}
  if(_playerDentMeshes)for(const o of _playerDentMeshes){
    if(o.userData.dOrig){const p=o.geometry.attributes.position;p.array.set(o.userData.dOrig);p.needsUpdate=true;o.userData.dOrig=null}
  }
  crashShake=0;
}
function repairTrafficCar(v){
  v._lod=-1; // re-pick the level of detail after a repair
  if(!v.dentList)return;
  for(const o of v.dentList)if(o.userData.dOrigGeo){o.geometry.dispose();o.geometry=o.userData.dOrigGeo;o.userData.dOrigGeo=null}
}

// ---- particles: sparks (additive), smoke and debris (normal blending) ----
const FX=(()=>{
  const N=640;
  function pool(additive){
    const pos=new Float32Array(N*3),col=new Float32Array(N*4),siz=new Float32Array(N),geo=new THREE.BufferGeometry();
    geo.setAttribute('position',new THREE.BufferAttribute(pos,3));
    geo.setAttribute('aCol',new THREE.BufferAttribute(col,4));
    geo.setAttribute('aSize',new THREE.BufferAttribute(siz,1));
    const mat=new THREE.ShaderMaterial({uniforms:{uScale:{value:700}},transparent:true,depthWrite:false,blending:additive?THREE.AdditiveBlending:THREE.NormalBlending,
      vertexShader:'attribute vec4 aCol;attribute float aSize;uniform float uScale;varying vec4 vC;void main(){vC=aCol;vec4 mv=modelViewMatrix*vec4(position,1.);gl_PointSize=aSize*uScale/max(-mv.z,.5);gl_Position=projectionMatrix*mv;}',
      fragmentShader:'varying vec4 vC;void main(){float r=length(gl_PointCoord-.5)*2.;if(r>1.)discard;gl_FragColor=vec4(vC.rgb,vC.a*(1.-r*r));}'});
    const pts=new THREE.Points(geo,mat);pts.frustumCulled=false;pts.renderOrder=30;scene.add(pts);
    const S=[];for(let i=0;i<N;i++)S.push({life:0,max:1});
    return{pos,col,siz,geo,mat,S,i:0,dirty:false};
  }
  const add=pool(true),norm=pool(false);
  function emit(p,o){const s=p.S[p.i];p.i=(p.i+1)%N;Object.assign(s,o);s.max=s.life;p.dirty=true}
  function update(dt){
    const sc=renderer.domElement.height/(2*Math.tan(camera.fov*Math.PI/360));
    for(let pi=0;pi<2;pi++){
      const p=pi?norm:add;
      p.mat.uniforms.uScale.value=sc;
      if(!p.dirty)continue; // no live particle: skip the loop and the 3 GPU buffer uploads
      let alive=0;
      for(let i=0;i<N;i++){
        const s=p.S[i];
        if(s.life<=0){p.siz[i]=0;continue}
        alive++;
        s.life-=dt;
        s.vy-=s.g*dt;const dr=Math.exp(-s.drag*dt);s.vx*=dr;s.vy*=dr;s.vz*=dr;
        s.x+=s.vx*dt;s.y+=s.vy*dt;s.z+=s.vz*dt;
        if(s.y<.03&&s.bounce){s.y=.03;s.vy=Math.abs(s.vy)*.35;s.vx*=.6;s.vz*=.6}
        const t=Math.min(1,1-s.life/s.max);
        p.pos[i*3]=s.x;p.pos[i*3+1]=s.y;p.pos[i*3+2]=s.z;
        p.col[i*4]=s.r;p.col[i*4+1]=s.gg;p.col[i*4+2]=s.b;p.col[i*4+3]=s.a*(1-t)*(1-t*.3);
        p.siz[i]=s.s0+(s.s1-s.s0)*t;
      }
      p.geo.attributes.position.needsUpdate=true;p.geo.attributes.aCol.needsUpdate=true;p.geo.attributes.aSize.needsUpdate=true;
      if(!alive)p.dirty=false; // this pass zeroed every size and uploaded it; stay idle until the next emit
    }
  }
  function sparks(x,y,z,vx,vz,n,power){
    for(let i=0;i<n;i++){
      const a=Math.random()*6.283,sp=rnd(2,4+power*9);
      emit(add,{x,y:y+rnd(-.1,.2),z,vx:vx*.4+Math.cos(a)*sp,vy:rnd(.5,4+power*3),vz:vz*.4+Math.sin(a)*sp,g:9.8,drag:.6,life:rnd(.25,.7),s0:.16,s1:.04,r:1,gg:rnd(.55,.85),b:rnd(.1,.35),a:1,bounce:true});
    }
  }
  function smoke(x,y,z,vx,vz,n,power){
    for(let i=0;i<n;i++){
      const gr=rnd(.35,.7);
      emit(norm,{x:x+rnd(-.3,.3),y:y+rnd(-.1,.3),z:z+rnd(-.3,.3),vx:vx*.25+rnd(-1.5,1.5),vy:rnd(.6,1.8),vz:vz*.25+rnd(-1.5,1.5),g:-.25,drag:1.1,life:rnd(1,2.2),s0:rnd(.6,1.1),s1:rnd(2.2,3.6)*(.7+power*.5),r:gr,gg:gr,b:gr,a:.42});
    }
  }
  function debris(x,y,z,vx,vz,n,power){
    for(let i=0;i<n;i++){
      const a=Math.random()*6.283,sp=rnd(1,3+power*7),glass=Math.random()<.45;
      emit(norm,{x,y:y+rnd(0,.4),z,vx:vx*.5+Math.cos(a)*sp,vy:rnd(1,5),vz:vz*.5+Math.sin(a)*sp,g:9.8,drag:.3,life:rnd(.8,1.8),s0:glass?.09:.13,s1:glass?.07:.1,
        r:glass?.8:.12,gg:glass?.9:.12,b:glass?.95:.12,a:glass?.9:.95,bounce:true});
    }
  }
  // tyre smoke: pale grey, slow, billowing (GTA-style burnouts / drifts)
  function tire(x,y,z,vx,vz,k){
    const gr=rnd(.78,.93);
    emit(norm,{x:x+rnd(-.15,.15),y:y+rnd(0,.15),z:z+rnd(-.15,.15),vx:vx*.3+rnd(-.8,.8),vy:rnd(.3,1.1),vz:vz*.3+rnd(-.8,.8),g:-.18,drag:1.6,life:rnd(1.2,2.4),s0:rnd(.5,.8),s1:rnd(2.6,4.2)*(.7+k*.4),r:gr,gg:gr,b:Math.min(1,gr*1.02),a:.14+.24*k});
  }
  return{update,sparks,smoke,debris,tire};
})();

const CRASH_MP3_B64="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";
let _crashBuf=null,_crashLoading=false,_crashLast=0;
function loadCrashSound(){
  if(_crashBuf||_crashLoading||!ac)return;_crashLoading=true;
  try{const bin=atob(CRASH_MP3_B64),u=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);
    ac.decodeAudioData(u.buffer,b=>{_crashBuf=b},()=>{_crashLoading=false})}catch(e){_crashLoading=false}
}
function crashSound(s){
  if(!ac||muted||engineVolume<=0)return;
  loadCrashSound();if(!_crashBuf)return;
  const now=performance.now();if(now-_crashLast<120)return;_crashLast=now;
  try{
    const src=ac.createBufferSource();src.buffer=_crashBuf;
    const g=ac.createGain();g.gain.value=Math.min(1,.25+.75*Math.min(1,s))*Math.min(1,engineVolume*1.3);
    src.playbackRate.value=.92+.16*Math.min(1,s);
    src.connect(g);g.connect(ac.destination);src.start();
  }catch(e){}
}
// ---- hitbox visualisation (press H) ----
function hitboxLine(root,hb){
  if(root.userData.hbLine||!hb)return;
  const pts=hb.poly.map(p=>new THREE.Vector3(p[0],.15,p[1]));
  const line=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts),_hbMat);
  line.renderOrder=999;line.frustumCulled=false;root.add(line);root.userData.hbLine=line;
}
function toggleHitboxes(){
  showHitboxes=!showHitboxes;
  if(showHitboxes){hitboxLine(car,playerHB());for(const v of trafficCars)hitboxLine(v.root,v.hull)}
  if(car.userData.hbLine)car.userData.hbLine.visible=showHitboxes;
  for(const v of trafficCars)if(v.root.userData.hbLine)v.root.userData.hbLine.visible=showHitboxes;
}

// ---- rigid bodies in world space ----
const _wrapAng=a=>Math.atan2(Math.sin(a),Math.cos(a));
function playerBody(){
  const hb=playerHB(),th=st.h,c=Math.cos(th),s=Math.sin(th),w=yawR+st.cw;
  return{player:true,hb,th,ox:st.x,oz:st.z,pts:hb.poly.map(p=>[st.x+p[0]*c+p[1]*s,st.z-p[0]*s+p[1]*c]),
    cx:st.x+hb.cx*c+hb.cz*s,cz:st.z-hb.cx*s+hb.cz*c,vx:st.wx,vz:st.wz,w,w0:w,
    invM:1/(BIKE?BIKE.mass:P.m),invI:3/((BIKE?BIKE.mass:P.m)*(hb.hl*hb.hl+hb.hw*hb.hw)),r:hb.r};
}
function trafficBody(v){
  const hb=v.hull;if(!hb)return null;
  const fr=roadFrameAt(v.z),yaw=-Math.atan(fr.slope),c=Math.cos(yaw),sn=Math.sin(yaw);
  const ox=fr.x+v.x*c,oz=v.z-v.x*sn,th=yaw+v.h,ct=Math.cos(th),ts=Math.sin(th),w=v.yawRate+v.cw;
  return{car:v,hb,th,c,sn,ox,oz,pts:hb.poly.map(p=>[ox+p[0]*ct+p[1]*ts,oz-p[0]*ts+p[1]*ct]),
    cx:ox+hb.cx*ct+hb.cz*ts,cz:oz-hb.cx*ts+hb.cz*ct,vx:v.wx*c+v.wz*sn,vz:-v.wx*sn+v.wz*c,w,w0:w,
    invM:1/v.mass,invI:3/(v.mass*(hb.hl*hb.hl+hb.hw*hb.hw)),r:hb.r};
}
function moveBody(b,dx,dz){
  for(const p of b.pts){p[0]+=dx;p[1]+=dz}
  b.cx+=dx;b.cz+=dz;b.ox+=dx;b.oz+=dz;
  if(b.player){st.x+=dx;st.z+=dz}
  else{b.car.x+=b.c*dx-b.sn*dz;b.car.z+=b.sn*dx+b.c*dz}
}
function commitBody(b){
  const dw=b.w-b.w0,m=CRASH.maxCw;
  if(b.player){
    st.wx=b.vx;st.wz=b.vz;st.cw=Math.max(-m,Math.min(m,st.cw+dw));
  }else{
    const v=b.car;v.wx=b.vx*b.c-b.vz*b.sn;v.wz=b.vx*b.sn+b.vz*b.c;v.cw=Math.max(-m,Math.min(m,v.cw+dw));
    v.speed=Math.abs(v.wx*(-Math.sin(v.h))+v.wz*(-Math.cos(v.h)));
  }
}
function bodyDent(b,mf,inwardSign,closing){
  const depth=Math.min(.02,.0015*closing+.004),R=Math.min(1.6,.75+.04*closing);
  const th=b.th,ct=Math.cos(th),ts=Math.sin(th),px=mf.px-b.ox,pz=mf.pz-b.oz;
  // world -> the car's own frame
  const lx=px*ct-pz*ts,lz=px*ts+pz*ct,dxw=mf.nx*inwardSign,dzw=mf.nz*inwardSign,dx=dxw*ct-dzw*ts,dz=dxw*ts+dzw*ct;
  if(b.player)damageParts(lx,lz,R);
  if(b.player)dentMeshes(car,_playerDentMeshes||[],lx,.62,lz,dx,0,dz,depth,R,false);
  else dentMeshes(b.car.root,trafficMeshes(b.car),lx,.62,lz,dx,0,dz,depth,R,true);
}
function onImpact(A,B,mf,res){
  const closing=-res.vn;
  // The police car makes no crash sound: not against the player, not against traffic, and not for the knock-on hits of a car it just struck.
  const polHit=!!((A.car&&(A.car.isPolice||A.car.polQuiet>0))||(B.car&&(B.car.isPolice||B.car.polQuiet>0)));
  if(polHit)for(const b of[A,B])if(b.car&&!b.car.isPolice)b.car.polQuiet=POLC.quietT;
  for(const b of[A,B])if(!b.player&&(closing>.8||A.player||B.player))b.car.hitTimer=CRASH.hitTime;
  if(closing<1.6)return;
  const now=performance.now(),key=A.player?B.car:A.car;
  if(key.fxT&&now-key.fxT<180)return;
  key.fxT=now;
  const sev=Math.min(1.4,closing/14),avx=(A.vx+B.vx)/2,avz=(A.vz+B.vz)/2;
  FX.sparks(mf.px,.45+bridgeElevAt(mf.px,mf.pz),mf.pz,avx,avz,Math.min(46,Math.round(closing*2.2)),sev);
  FX.debris(mf.px,.4,mf.pz,avx,avz,Math.min(26,Math.round(closing*1.1)),sev);
  FX.smoke(mf.px,.5+bridgeElevAt(mf.px,mf.pz),mf.pz,avx,avz,Math.min(14,2+Math.round(closing*.6)),sev);
  if(!polHit)crashSound(Math.min(1,closing/16)); // silent when the police car is involved (sparks / debris / smoke / dents / camera shake are unchanged)
  if(A.player||B.player){
    crashShake=Math.max(crashShake,Math.min(1,closing/15));
    const me=A.player?A:B,sgn=A.player?-1:1,jn=res.jn*me.invM*sgn;
    const dvx=mf.nx*jn,dvz=mf.nz*jn,c=Math.cos(me.th),s=Math.sin(me.th);
    st.roll+=Math.max(-.06,Math.min(.06,-(dvx*c-dvz*s)*.004));
    st.pitch+=Math.max(-.05,Math.min(.05,(-dvx*s-dvz*c)*.003));
  }
  if(closing>2.5){
    try{bodyDent(A,mf,-1,closing);bodyDent(B,mf,1,closing)}catch(e){console.warn('dent failed',e)}
  }
}
function collidePair(A,B,dt){
  const dx=B.cx-A.cx,dz=B.cz-A.cz,rr=A.r+B.r;
  if(dx*dx+dz*dz>rr*rr)return false;
  const mf=CrashMath.contact(A,B,B.vx-A.vx,B.vz-A.vz,dt);
  if(!mf)return false;
  const closing=-((B.vx-A.vx)*mf.nx+(B.vz-A.vz)*mf.nz);
  // Separation is spread over a few frames (never more than the distance the cars just travelled into each other + a few cm),
  // the impulse below makes them move apart, so nothing jumps.
  const tot=A.invM+B.invM,d=Math.min(CRASH.maxPush+.7*Math.max(0,closing)*dt,Math.max(0,mf.depth-.004)*CRASH.pushFrac);
  moveBody(A,-mf.nx*d*A.invM/tot,-mf.nz*d*A.invM/tot);
  moveBody(B,mf.nx*d*B.invM/tot,mf.nz*d*B.invM/tot);
  const e=CRASH.e0+CRASH.e1*Math.exp(-Math.max(0,closing)/8);
  const res=CrashMath.impulse(A,B,mf,e,CRASH.mu);
  if(res)onImpact(A,B,mf,res);
  return true;
}
function keepTrafficOnRoad(v){
  const hb=v.hull;if(!hb)return;
  const dl=_wrapAng(v.h-(v.direction>0?Math.PI:0)),ext=hb.hw*Math.abs(Math.cos(dl))+hb.hl*Math.abs(Math.sin(dl));
  const sg=v.direction<0?1:-1,a=sg*v.x,CO=19.33,CI=1.0;
  const stepMax=.06; // metres per frame: a wrecked car is eased back onto the road, never snapped
  if(a+ext>CO){const t=sg*(CO-ext);v.x+=Math.max(-stepMax,Math.min(stepMax,t-v.x));if(sg*v.wx>0)v.wx*=.8;v.cw*=.9}
  else if(a-ext<CI){const t=sg*(CI+ext);v.x+=Math.max(-stepMax,Math.min(stepMax,t-v.x));if(sg*v.wx<0)v.wx*=.8;v.cw*=.9}
}
const _colNear=[],_colBodies=[];
function resolveCollisions(dt){
  dt=Math.min(dt,1/30);
  const pb=playerBody(),near=_colNear;near.length=0;
  const pol=(POL.on&&POL.car&&POL.car.hull&&POL.car.root.visible)?POL.car:null;
  let polPos=null;
  if(pol){const fr=roadFrameAt(pol.z),yaw=-Math.atan(fr.slope);polPos={x:fr.x+pol.x*Math.cos(yaw),z:pol.z-pol.x*Math.sin(yaw)}}
  for(const v of trafficCars){
    if(!v.hull)continue;
    // cheap reject: further than 40 m (road station) from the player AND the police car, and not in a crash -> cannot be within 9 m (the road frame skews z by < ~12 m)
    if(!(v.hitTimer>0)&&Math.abs(v.z-st.z)>=40&&(!pol||Math.abs(v.z-pol.z)>=40))continue;
    const fr=roadFrameAt(v.z),yaw=-Math.atan(fr.slope);
    const wx=fr.x+v.x*Math.cos(yaw),wz=v.z-v.x*Math.sin(yaw);
    if(Math.abs(wx-st.x)<9&&Math.abs(wz-st.z)<9)near.push(v);
    else if(v.hitTimer>0)near.push(v);
    else if(polPos&&Math.abs(wx-polPos.x)<9&&Math.abs(wz-polPos.z)<9)near.push(v);
  }
  const polBody=pol?trafficBody(pol):null;
  if(!near.length&&!polBody)return;
  const bodies=_colBodies;bodies.length=0;
  for(const v of near){const b=trafficBody(v);if(b)bodies.push(b)}
  for(const b of bodies)collidePair(pb,b,dt);
  // cars that were hit can also hit each other
  for(let i=0;i<bodies.length;i++)for(let j=i+1;j<bodies.length;j++){
    const a=bodies[i],b=bodies[j];
    if(a.car.hitTimer>0||b.car.hitTimer>0)collidePair(a,b,dt);
  }
  if(polBody){
    if(collidePair(pb,polBody,dt)&&!POL.over)policeBust();   // the police car touched the player: busted
    for(const b of bodies)collidePair(polBody,b,dt);          // the police car can also hit traffic (its small error rate)
  }
  commitBody(pb);
  for(const b of bodies){commitBody(b);if(b.car.hitTimer>0)keepTrafficOnRoad(b.car)}
  if(polBody)commitBody(polBody);
}

function defaultHull(L,W){const a=L/2,b=W/2;return{poly:[[-b,-a],[b,-a],[b,a],[-b,a]],cx:0,cz:0,hw:b,hl:a,r:Math.hypot(a,b)}}

// ---- AI traffic: embedded GLB models + the player's vehicle force model ----
// Traffic cars use the same engine torque curve, gear ratios, traction limit,
// braking, aerodynamic drag and rolling resistance as the player's Lancer.
const TRAFFIC_GZIP_BYTE_LENGTHS={exo90:279352,dirty_car:863378,peugeot206:3726473};
let TRAFFIC_GLB_GZIP_Z85 = window.TRAFFIC_PACK || {};
const TRAFFIC_ASSETS = [
  {id:'exo90',frontPositiveZ:false,wheelPattern:'exo'},
  {id:'dirty_car',frontPositiveZ:true,wheelPattern:'dirty'},
  {id:'peugeot206',frontPositiveZ:true,wheelPattern:'peugeot'}
];
const TRAFFIC_PAINTS=['#e8e9eb','#25282d','#9aa4ae','#b51f2c','#174d91','#d7b72c','#285b45','#eeeeea','#59616b','#7c342d','#243c58','#b9a58a'];
const trafficRoot=new THREE.Group();trafficRoot.name='AI_Traffic';scene.add(trafficRoot);
const trafficTemplates=[],trafficCars=[];
let trafficReady=false,trafficLoadStarted=false;
const trafficLoadStatus=document.getElementById('trafficLoadStatus');
const _trafficPosition=new THREE.Vector3();
const TRAFFIC_FRONT_LANES=[2.83,6.5,10.17,13.83,17.5];
const TRAFFIC_OPPOSITE_LANES=[-2.83,-6.5,-10.17,-13.83,-17.5];
// Keep the main direction at 45 cars and reduce opposite-direction traffic by ~75%.
// 45 * 0.25 = 11.25, rounded to the nearest whole car: 11 opposite-direction cars.
const TRAFFIC_BASE_MAIN_CARS=49;
const TRAFFIC_BASE_OPPOSITE_CARS=Math.round(TRAFFIC_BASE_MAIN_CARS*0.25);
const TRAFFIC_BASE_TOTAL_CARS=TRAFFIC_BASE_MAIN_CARS+TRAFFIC_BASE_OPPOSITE_CARS; // 61 cars in normal mode (easy 51 / crowded 71)
let selectedTrafficDensity='normal';
let TRAFFIC_CARS_PER_DIRECTION=TRAFFIC_BASE_MAIN_CARS;
let TRAFFIC_OPPOSITE_CARS=TRAFFIC_BASE_OPPOSITE_CARS;
let TRAFFIC_TOTAL_CARS=TRAFFIC_BASE_TOTAL_CARS;
function updateTrafficLoadStatus(){
  if(!trafficLoadStatus)return;
  if(trafficReady){
    trafficLoadStatus.textContent='تم تجهيز '+TRAFFIC_TOTAL_CARS+' سيارة مرور: '+TRAFFIC_CARS_PER_DIRECTION+' في اتجاه السير و'+TRAFFIC_OPPOSITE_CARS+' في الاتجاه المعاكس، بثلاثة موديلات مختلفة';
  }else{
    trafficLoadStatus.textContent='جاري تجهيز '+TRAFFIC_TOTAL_CARS+' سيارة مرور بثلاثة موديلات...';
  }
}
function setTrafficDensity(mode){
  const options={
    easy:{total:TRAFFIC_BASE_TOTAL_CARS-10},
    normal:{total:TRAFFIC_BASE_TOTAL_CARS},
    crowded:{total:TRAFFIC_BASE_TOTAL_CARS+10}
  };
  if(!options[mode])return;
  const changed=selectedTrafficDensity!==mode;
  selectedTrafficDensity=mode;
  if(mode==='normal'){
    TRAFFIC_CARS_PER_DIRECTION=TRAFFIC_BASE_MAIN_CARS;
    TRAFFIC_OPPOSITE_CARS=TRAFFIC_BASE_OPPOSITE_CARS;
  }else{
    // Keep the current 4:1 traffic-direction ratio while matching the exact total.
    TRAFFIC_CARS_PER_DIRECTION=Math.round(options[mode].total/1.25);
    TRAFFIC_OPPOSITE_CARS=options[mode].total-TRAFFIC_CARS_PER_DIRECTION;
  }
  TRAFFIC_TOTAL_CARS=options[mode].total;
  document.querySelectorAll('[data-traffic-density]').forEach(button=>{
    const active=button.dataset.trafficDensity===mode;
    button.classList.toggle('active',active);
    button.setAttribute('aria-checked',active?'true':'false');
  });
  if(changed&&trafficReady)resetTrafficFleet();
  updateTrafficLoadStatus();
}
const TRAFFIC_SPEED_FACTOR=0.90*0.93; // previous 10% reduction, then a further 7% reduction (~16.3% below the original); player physics are untouched
const TRAFFIC_MIN_SPEED=(70/3.6)*TRAFFIC_SPEED_FACTOR;  // ~59 km/h in m/s
const TRAFFIC_MAX_SPEED=(140/3.6)*TRAFFIC_SPEED_FACTOR; // ~117 km/h in m/s
const TRAFFIC_TARGET_LENGTH=4.55;
const clampTraffic=(v,a,b)=>Math.max(a,Math.min(b,v));
const randomTrafficSpeed=()=>rnd(TRAFFIC_MIN_SPEED,TRAFFIC_MAX_SPEED);
function shuffledTrafficLanes(lanes){
  const out=lanes.slice();
  for(let i=out.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[out[i],out[j]]=[out[j],out[i]]}
  return out;
}
function makeTrafficSpawnPlans(){
  const plans=[];
  // Spread each direction independently across the complete road ring.
  // This keeps the main-direction density unchanged while using only 25%
  // of its former vehicle count in the opposite direction.
  const playerS=playerRoadCoords().z;
  const front=playerS-FRONT_ROAD_BUFFER+105;
  const rear=playerS+REAR_ROAD_BUFFER-105;
  const span=Math.max(TRAFFIC_CARS_PER_DIRECTION*28,rear-front);
  const addDirectionPlans=(direction,count)=>{
    // Preserve the original 45-car side-by-side frequency proportionally.
    const sideBySidePairs=Math.min(count-1,Math.round(count*(7/45)));
    const stationCount=count-sideBySidePairs;
    const spacing=span/stationCount;
    const pairStations=new Set();
    while(pairStations.size<sideBySidePairs){
      const i=Math.floor(Math.random()*stationCount);
      if(pairStations.has(i)||pairStations.has(i-1)||pairStations.has(i+1))continue;
      pairStations.add(i);
    }
    const stations=Array.from({length:stationCount},(_,i)=>
      front+(i+.5)*spacing+rnd(-spacing*.14,spacing*.14));
    const lanes=direction<0?TRAFFIC_FRONT_LANES:TRAFFIC_OPPOSITE_LANES;
    const laneUse=new Map(lanes.map(l=>[l,0]));
    for(let i=0;i<stationCount;i++){
      const laneOrder=lanes.slice().sort((a,b)=>laneUse.get(a)-laneUse.get(b));
      if(pairStations.has(i)){
        // Two cars share approximately the same longitudinal position, but
        // occupy separate lanes so they can safely travel side-by-side.
        const first=laneOrder[0],second=laneOrder.find(l=>Math.abs(l-first)>1.5)||laneOrder[1];
        const offset=rnd(1.0,2.5);
        plans.push({direction,lane:first,z:clampTraffic(stations[i]-offset,front+5,rear-5)});
        plans.push({direction,lane:second,z:clampTraffic(stations[i]+offset,front+5,rear-5)});
        laneUse.set(first,laneUse.get(first)+1);laneUse.set(second,laneUse.get(second)+1);
      }else{
        const minUse=Math.min(...laneUse.values());
        const choices=lanes.filter(l=>laneUse.get(l)===minUse);
        const lane=pick(choices);
        plans.push({direction,lane,z:clampTraffic(stations[i]+(direction>0?spacing*.08:0),front+5,rear-5)});
        laneUse.set(lane,laneUse.get(lane)+1);
      }
    }
  };
  addDirectionPlans(-1,TRAFFIC_CARS_PER_DIRECTION);
  addDirectionPlans(1,TRAFFIC_OPPOSITE_CARS);
  // Randomize order independently of the spatial distribution.
  for(let i=plans.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[plans[i],plans[j]]=[plans[j],plans[i]]}
  return plans;
}

function trafficPackedBytes(s,id){
  return z85Decode(s,TRAFFIC_GZIP_BYTE_LENGTHS[id]);
}
function trafficWheelNodes(model,pattern){
  const preferred=[];
  model.traverse(o=>{
    if(!o||o===model)return;
    const n=o.name||'';
    const ok=pattern==='exo'?/^(fl|fr|rl|rr)_/i.test(n):
             pattern==='dirty'?/^(front_wheel|back_wheel)$/i.test(n):
             /^tire(?:[._]|$)/i.test(n);
    if(ok)preferred.push(o);
  });
  // Some imported cars use different node names (or expose the wheel as a Mesh
  // rather than a Group). Keep the model-specific names when they identify all
  // four wheels; otherwise fall back to wheel/tire/rim names in the hierarchy.
  if(preferred.length>=4)return preferred;
  const named=[];
  model.traverse(o=>{
    if(!o||o===model)return;
    if(/(?:wheel|tire|tyre|rim)/i.test(o.name||''))named.push(o);
  });
  // Prefer the highest matching wheel assembly so a tyre and its rim are not
  // both given separate pivots. If only wheel meshes are named, use those.
  const assemblies=named.filter(o=>o.children&&o.children.length);
  const candidates=assemblies.length>=4?assemblies:named.filter(o=>o.isMesh);
  const result=preferred.slice();
  for(const o of candidates){
    let nested=false;
    for(let p=o.parent;p&&p!==model;p=p.parent){
      if(result.includes(p)||candidates.includes(p)){nested=true;break}
    }
    if(!nested&&!result.includes(o))result.push(o);
  }
  return result;
}
function mergeStaticTrafficMeshes(wrap){
  // Traffic GLBs contain many small body pieces. Merge opaque, non-animated pieces
  // that share the exact same material into one mesh. Geometry and materials stay
  // identical; wheel assemblies and transparent glass remain separate.
  wrap.updateMatrixWorld(true);
  const invRoot=new THREE.Matrix4().copy(wrap.matrixWorld).invert();
  const batches=new Map(),sourceMeshes=[];
  const attrSignature=geo=>Object.keys(geo.attributes).sort().map(name=>{
    const a=geo.attributes[name];
    return name+':'+a.itemSize+':'+(a.normalized?1:0)+':'+a.array.constructor.name;
  }).join('|');
  wrap.traverse(mesh=>{
    if(!mesh.isMesh||mesh.isSkinnedMesh||mesh.isInstancedMesh||!mesh.geometry||!mesh.geometry.isBufferGeometry||mesh.visible===false||mesh.frustumCulled===false)return;
    if(Array.isArray(mesh.material)||!mesh.material||mesh.material.transparent||mesh.material.opacity<.999||mesh.material.visible===false||mesh.material.depthWrite===false)return;
    if(mesh.onBeforeRender!==THREE.Object3D.prototype.onBeforeRender||mesh.geometry.morphAttributes&& /* fixed: every Object3D has a default no-op onBeforeRender, which used to block ALL merging */Object.keys(mesh.geometry.morphAttributes).some(k=>mesh.geometry.morphAttributes[k]&&mesh.geometry.morphAttributes[k].length))return;
    if(mesh.geometry.groups&&mesh.geometry.groups.length)return;
    if(mesh.geometry.drawRange&&(mesh.geometry.drawRange.start!==0||Number.isFinite(mesh.geometry.drawRange.count)&&mesh.geometry.drawRange.count<mesh.geometry.attributes.position.count))return;
    let parent=mesh.parent,inWheel=false,invisibleParent=false;
    while(parent&&parent!==wrap){
      if(parent.visible===false)invisibleParent=true;
      if(parent.userData&&parent.userData.isTrafficWheelPivot){inWheel=true;break;}
      parent=parent.parent;
    }
    if(inWheel||invisibleParent)return;
    const attrs=mesh.geometry.attributes;
    if(!attrs.position||!attrs.position.count||Object.values(attrs).some(a=>a.isInterleavedBufferAttribute))return;
    const sig=attrSignature(mesh.geometry);
    const key=[mesh.material.uuid,sig,mesh.castShadow?1:0,mesh.receiveShadow?1:0,mesh.renderOrder||0].join('::');
    let batch=batches.get(key);
    if(!batch){batch={material:mesh.material,items:[],castShadow:mesh.castShadow,receiveShadow:mesh.receiveShadow,renderOrder:mesh.renderOrder||0};batches.set(key,batch);}
    const baked=mesh.geometry.clone();
    const localMatrix=new THREE.Matrix4().multiplyMatrices(invRoot,mesh.matrixWorld);
    baked.applyMatrix4(localMatrix);
    batch.items.push(baked);sourceMeshes.push(mesh);
  });
  const removed=new Set();let mergedMeshes=0,mergedSourceMeshes=0;
  for(const batch of batches.values()){
    const geos=batch.items;
    if(geos.length<2){for(const g of geos)g.dispose();continue;}
    let merged=null;
    try{
      const first=geos[0],names=Object.keys(first.attributes);
      const totalVertices=geos.reduce((n,g)=>n+g.attributes.position.count,0);
      merged=new THREE.BufferGeometry();
      for(const name of names){
        const base=first.attributes[name],count=totalVertices*base.itemSize;
        const array=new base.array.constructor(count);let offset=0;
        for(const g of geos){const a=g.attributes[name];if(!a||a.itemSize!==base.itemSize||a.normalized!==base.normalized||a.array.constructor!==base.array.constructor)throw new Error('Incompatible traffic vertex attribute: '+name);array.set(a.array,offset);offset+=a.array.length;}
        merged.setAttribute(name,new THREE.BufferAttribute(array,base.itemSize,base.normalized));
      }
      const totalIndices=geos.reduce((n,g)=>n+(g.index?g.index.count:g.attributes.position.count),0);
      const IndexArray=totalVertices>65535?Uint32Array:Uint16Array;
      const indices=new IndexArray(totalIndices);let ip=0,vertexOffset=0;
      for(const g of geos){
        const count=g.index?g.index.count:g.attributes.position.count;
        if(g.index){for(let j=0;j<count;j++)indices[ip++]=g.index.getX(j)+vertexOffset;}
        else{for(let j=0;j<count;j++)indices[ip++]=j+vertexOffset;}
        vertexOffset+=g.attributes.position.count;
      }
      merged.setIndex(new THREE.BufferAttribute(indices,1));
      merged.computeBoundingBox();merged.computeBoundingSphere();
      const combined=new THREE.Mesh(merged,batch.material);
      combined.name='BatchedTraffic_'+(batch.material.name||'Material');
      combined.castShadow=batch.castShadow;combined.receiveShadow=batch.receiveShadow;combined.renderOrder=batch.renderOrder;
      wrap.add(combined);mergedMeshes++;
      for(const mesh of sourceMeshes){
        // Only remove sources that belong to this successfully merged batch.
        const sourceBatchKey=[mesh.material.uuid,attrSignature(mesh.geometry),mesh.castShadow?1:0,mesh.receiveShadow?1:0,mesh.renderOrder||0].join('::');
        if(sourceBatchKey===[batch.material.uuid,attrSignature(first),batch.castShadow?1:0,batch.receiveShadow?1:0,batch.renderOrder].join('::')){
          if(mesh.parent){mesh.parent.remove(mesh);removed.add(mesh);mergedSourceMeshes++;}
        }
      }
      for(const g of geos)g.dispose();
    }catch(err){
      console.warn('Traffic mesh batch skipped:',err);
      if(merged)merged.dispose();
      for(const g of geos)g.dispose();
    }
  }
  // In case a source was assigned to a batch that did not merge, it remains in place.
  return {mergedMeshes,mergedSourceMeshes};
}
// ===================== Traffic level-of-detail =====================
// Some traffic models are film-quality (the Peugeot 206 is 453k triangles in one car, ~20 of them on the road).
// Each heavy mesh gets lighter copies made by merging vertices that fall in the same small cube of the car (vertex clustering;
// seams and sharp edges are kept apart by also grouping on normal / UV). A copy is used only from the distance at which its
// cube is smaller than one screen pixel, so the switch is invisible; the original model is always used up close.
const TRAFFIC_LODS=new Map(),TRAFFIC_LOD_CELLS=[.025,.06,.12]; // metres: level 1, 2, 3
function trafficClusterSimplify(geo,cell,nq,uq){
  const pos=geo.attributes.position,nor=geo.attributes.normal,uv=geo.attributes.uv,n=pos.count;
  const idx=geo.index?geo.index.array:null,triN=idx?idx.length/3:n/3,inv=1/cell;
  const map=new Map(),remap=new Int32Array(n),P=[],Nn=[],C=[],first=[];
  for(let i=0;i<n;i++){
    const x=pos.getX(i),y=pos.getY(i),z=pos.getZ(i);
    let key=Math.floor(x*inv)+','+Math.floor(y*inv)+','+Math.floor(z*inv);
    if(nor)key+='|'+Math.round(nor.getX(i)*nq)+','+Math.round(nor.getY(i)*nq)+','+Math.round(nor.getZ(i)*nq);
    if(uv&&uq)key+='|'+Math.round(uv.getX(i)*uq)+','+Math.round(uv.getY(i)*uq);
    let id=map.get(key);
    if(id===undefined){id=C.length;map.set(key,id);P.push(0,0,0);Nn.push(0,0,0);C.push(0);first.push(i)}
    remap[i]=id;P[id*3]+=x;P[id*3+1]+=y;P[id*3+2]+=z;C[id]++;
    if(nor){Nn[id*3]+=nor.getX(i);Nn[id*3+1]+=nor.getY(i);Nn[id*3+2]+=nor.getZ(i)}
  }
  const tris=[];
  for(let t=0;t<triN;t++){const a=remap[idx?idx[t*3]:t*3],b=remap[idx?idx[t*3+1]:t*3+1],c=remap[idx?idx[t*3+2]:t*3+2];if(a!==b&&b!==c&&a!==c)tris.push(a,b,c)}
  const m=C.length,out=new THREE.BufferGeometry(),p=new Float32Array(m*3);
  for(let i=0;i<m;i++){p[i*3]=P[i*3]/C[i];p[i*3+1]=P[i*3+1]/C[i];p[i*3+2]=P[i*3+2]/C[i]}
  out.setAttribute('position',new THREE.BufferAttribute(p,3));
  if(nor){const q=new Float32Array(m*3);for(let i=0;i<m;i++){const x=Nn[i*3],y=Nn[i*3+1],z=Nn[i*3+2],l=Math.hypot(x,y,z)||1;q[i*3]=x/l;q[i*3+1]=y/l;q[i*3+2]=z/l}out.setAttribute('normal',new THREE.BufferAttribute(q,3))}
  for(const name of Object.keys(geo.attributes)){
    if(name==='position'||name==='normal')continue;
    const a=geo.attributes[name],sz=a.itemSize,arr=new a.array.constructor(m*sz);
    for(let i=0;i<m;i++)for(let k=0;k<sz;k++)arr[i*sz+k]=a.array[first[i]*sz+k];
    out.setAttribute(name,new THREE.BufferAttribute(arr,sz,a.normalized));
  }
  out.setIndex(new THREE.BufferAttribute(m>65535?new Uint32Array(tris):new Uint16Array(tris),1));
  out.computeBoundingBox();out.computeBoundingSphere();
  return out;
}
function buildTrafficLODs(wrap){
  wrap.updateMatrixWorld(true);
  let before=0,after=[0,0,0];
  wrap.traverse(o=>{
    if(!o.isMesh||!o.geometry||!o.geometry.attributes.position||o.geometry.morphAttributes&&Object.keys(o.geometry.morphAttributes).length)return;
    const g=o.geometry,tris=g.index?g.index.count/3:g.attributes.position.count/3;
    before+=tris;
    if(tris<2000||TRAFFIC_LODS.has(g)){for(let i=0;i<3;i++)after[i]+=tris;return}
    const sc=o.matrixWorld.getMaxScaleOnAxis()||1,lods=[g];
    TRAFFIC_LOD_CELLS.forEach((c,i)=>{const lg=trafficClusterSimplify(g,c/sc,i<1?2:1,i<1?32:i<2?16:0);lods.push(lg);after[i]+=lg.index.count/3});
    TRAFFIC_LODS.set(g,lods);
  });
  console.info('Traffic LOD:',wrap.name,'triangles',before|0,'->',after.map(v=>v|0).join(' / '));
}
function trafficLodList(v){
  if(v._lodList)return v._lodList;
  const list=[];
  v.root.traverse(o=>{if(!o.isMesh)return;const lods=TRAFFIC_LODS.get(o.userData.dOrigGeo||o.geometry);if(lods)list.push({o,lods})});
  return v._lodList=list;
}
// ---- far level: the whole car as ONE mesh (1 draw call instead of ~10) ----
// Built once per model from a real car: every part's lightest geometry merged, with the colour of its material and texture
// (and its emissive lamps) baked into each vertex. The body paint stays a per-car uniform, and the car keeps its night lighting
// and reflections, so a distant car looks the same; it only replaces the full model once the car is a few dozen pixels wide.
const _texPix=new WeakMap(),_lin=v=>Math.pow(v/255,2.2);
function texPixels(tex){
  if(!tex||!tex.image)return null;
  if(_texPix.has(tex))return _texPix.get(tex);
  let out=null;
  try{const W=256,H=256,c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d');g.drawImage(tex.image,0,0,W,H);
    out={W,H,d:g.getImageData(0,0,W,H).data,flipY:!!tex.flipY,srgb:tex.encoding===THREE.sRGBEncoding}}catch(e){out=null}
  _texPix.set(tex,out);return out;
}
function sampleTexInto(P,u,v,o){
  u-=Math.floor(u);v-=Math.floor(v);
  const x=Math.min(P.W-1,Math.floor(u*P.W)),y=Math.min(P.H-1,Math.floor((P.flipY?1-v:v)*P.H)),k=(y*P.W+x)*4,d=P.d;
  if(P.srgb){o[0]*=_lin(d[k]);o[1]*=_lin(d[k+1]);o[2]*=_lin(d[k+2])}else{o[0]*=d[k]/255;o[1]*=d[k+1]/255;o[2]*=d[k+2]/255}
}
const trafficIsBody=m=>/car1|body|badaneh/.test((m&&m.name||'').toLowerCase());
const trafficFarSrc=o=>{if(!o.isMesh||o.userData.noDent||o.name==='trafficFar'||o.visible===false)return null;const m=Array.isArray(o.material)?o.material[0]:o.material;
  return m&&m.visible!==false&&(m.isMeshStandardMaterial||m.isMeshPhongMaterial||m.isMeshLambertMaterial)?m:null};
function buildTrafficFarGeo(root){
  root.updateMatrixWorld(true);
  const inv=new THREE.Matrix4().copy(root.matrixWorld).invert(),m=new THREE.Matrix4(),nm=new THREE.Matrix3(),v=new THREE.Vector3();
  const P=[],N=[],C=[],E=[],B=[],RM=[],I=[],col=[0,0,0],em=[0,0,0];let vo=0;
  root.traverse(o=>{
    const mat=trafficFarSrc(o);if(!mat)return;
    const lods=TRAFFIC_LODS.get(o.geometry),g=lods?lods[3]:o.geometry,pos=g.attributes.position,nor=g.attributes.normal,uv=g.attributes.uv,n=pos.count;
    m.multiplyMatrices(inv,o.matrixWorld);nm.getNormalMatrix(m);
    const body=trafficIsBody(mat),mp=texPixels(mat.map),ep=mat.emissiveMap?texPixels(mat.emissiveMap):null,ek=(mat.emissive&&mat.emissiveIntensity)||0;
    const ro=mat.roughness!=null?mat.roughness:.6,me=mat.metalness!=null?mat.metalness:0;
    for(let i=0;i<n;i++){
      v.fromBufferAttribute(pos,i).applyMatrix4(m);P.push(v.x,v.y,v.z);
      if(nor){v.fromBufferAttribute(nor,i).applyMatrix3(nm).normalize();N.push(v.x,v.y,v.z)}else N.push(0,1,0);
      if(body){col[0]=col[1]=col[2]=1}else{col[0]=mat.color.r;col[1]=mat.color.g;col[2]=mat.color.b}
      if(mp&&uv)sampleTexInto(mp,uv.getX(i),uv.getY(i),col);
      C.push(col[0],col[1],col[2]);
      if(ek>0){em[0]=mat.emissive.r*ek;em[1]=mat.emissive.g*ek;em[2]=mat.emissive.b*ek;if(ep&&uv)sampleTexInto(ep,uv.getX(i),uv.getY(i),em);E.push(em[0],em[1],em[2])}else E.push(0,0,0);
      B.push(body?1:0);RM.push(ro,me);
    }
    const id=g.index?g.index.array:null,tc=id?id.length:n;for(let k=0;k<tc;k++)I.push(vo+(id?id[k]:k));
    vo+=n;
  });
  if(!vo)return null;
  const geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.Float32BufferAttribute(P,3));geo.setAttribute('normal',new THREE.Float32BufferAttribute(N,3));
  geo.setAttribute('color',new THREE.Float32BufferAttribute(C,3));geo.setAttribute('aEmit',new THREE.Float32BufferAttribute(E,3));geo.setAttribute('aBody',new THREE.Float32BufferAttribute(B,1));geo.setAttribute('aRM',new THREE.Float32BufferAttribute(RM,2));
  geo.setIndex(new THREE.BufferAttribute(vo>65535?new Uint32Array(I):new Uint16Array(I),1));
  geo.computeBoundingBox();geo.computeBoundingSphere();
  console.info('Traffic far mesh:',root.name,(I.length/3)|0,'triangles in 1 draw call');
  return geo;
}
function trafficFarMaterial(LU,paint,rough){
  const m=new THREE.MeshStandardMaterial({vertexColors:true,roughness:rough,metalness:.18});
  trafficLightMaterial(m,LU);                                   // same street-lamp / head-light lighting as the full car
  const prev=m.onBeforeCompile;
  m.onBeforeCompile=(sh,r)=>{prev(sh,r);sh.uniforms.uPaint={value:paint};
    sh.vertexShader=sh.vertexShader.replace('void main() {','attribute vec3 aEmit;attribute float aBody;attribute vec2 aRM;varying vec3 vEmit;varying float vBody;varying vec2 vRM;\nvoid main() {vEmit=aEmit;vBody=aBody;vRM=aRM;');
    sh.fragmentShader=sh.fragmentShader.replace('void main() {','uniform vec3 uPaint;varying vec3 vEmit;varying float vBody;varying vec2 vRM;\nvoid main() {')
      .replace('#include <roughnessmap_fragment>','float roughnessFactor=vRM.x;')          // each part keeps its own shine (chrome, glass, metallic paint)
      .replace('#include <metalnessmap_fragment>','float metalnessFactor=vRM.y;')
      .replace('#include <color_fragment>','#include <color_fragment>\ndiffuseColor.rgb*=mix(vec3(1.),uPaint,vBody);')
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\ntotalEmissiveRadiance+=vEmit;')};
  m.customProgramCacheKey=()=>'trafficFar2';
  return m;
}
function trafficLitMeshes(v){
  if(v._litMeshes)return v._litMeshes;
  const list=[];v.root.traverse(o=>{if(trafficFarSrc(o))list.push(o)});
  return v._litMeshes=list;
}
const _lodV=new THREE.Vector3();
// pxH = height in pixels of the image being rendered (main view, mirror or reflection probe)
function updateTrafficLOD(cam,pxH){
  if(!trafficCars.length||!TRAFFIC_LODS.size)return;
  const fov=cam.isPerspectiveCamera?cam.fov:60,s=2*Math.tan(fov*Math.PI/360)/Math.max(1,pxH||innerHeight); // metres per pixel at 1 m distance
  const d1=TRAFFIC_LOD_CELLS[0]/s,d2=TRAFFIC_LOD_CELLS[1]/s,d3=TRAFFIC_LOD_CELLS[2]/s,d4=d3*2;
  cam.getWorldPosition(_lodV);
  for(let i=0;i<trafficCars.length;i++){
    const v=trafficCars[i],r=v.root;if(!r.visible)continue;
    const d=r.position.distanceTo(_lodV);
    let lvl=d<d1?0:d<d2?1:d<d3?2:d<d4?3:4;
    if(lvl===4&&!v.far)lvl=3;
    if(v.hitTimer>0)lvl=0;                                    // crashing cars keep the full model (dents are made on it)
    if(lvl===v._lod)continue;
    v._lod=lvl;
    const blob=v.root.userData._blob;
    if(lvl===4){for(const o of trafficLitMeshes(v))o.visible=false;v.far.visible=true;if(blob)blob.visible=false;continue}
    if(v.far&&v.far.visible){for(const o of trafficLitMeshes(v))o.visible=true;v.far.visible=false;if(blob)blob.visible=true}
    for(const e of trafficLodList(v)){if(e.o.userData.dOrigGeo)continue;e.o.geometry=e.lods[lvl]}
  }
}
function buildTrafficTemplate(gltf,def){
  const wrap=new THREE.Group();wrap.name='TrafficTemplate_'+def.id;
  const model=gltf.scene||gltf.scenes[0];
  wrap.add(model);wrap.updateMatrixWorld(true);
  const originalBounds=new THREE.Box3().setFromObject(model);
  const originalCenter=originalBounds.getCenter(new THREE.Vector3());
  const candidates=trafficWheelNodes(model,def.wheelPattern).map(node=>{
    const b=new THREE.Box3().setFromObject(node),c=b.getCenter(new THREE.Vector3());
    let front=false;
    if(def.wheelPattern==='exo')front=/^(fl|fr)_/i.test(node.name||'');
    else if(def.wheelPattern==='dirty')front=/^front_wheel$/i.test(node.name||'');
    else front=c.z>originalCenter.z;
    return {node,front};
  });
  // All models face -Z on the player's carriageway after this normalization.
  if(def.frontPositiveZ)model.rotation.y+=Math.PI;
  model.updateMatrixWorld(true);wrap.updateMatrixWorld(true);
  let bounds=new THREE.Box3().setFromObject(model);
  let size=bounds.getSize(new THREE.Vector3());
  const length=Math.max(size.x,size.z);
  if(!Number.isFinite(length)||length<.01)throw new Error('Invalid dimensions for '+def.id);
  model.scale.multiplyScalar(TRAFFIC_TARGET_LENGTH/length);
  model.updateMatrixWorld(true);wrap.updateMatrixWorld(true);
  bounds=new THREE.Box3().setFromObject(model);
  const centre=bounds.getCenter(new THREE.Vector3());
  model.position.x-=centre.x;
  model.position.y-=bounds.min.y;
  model.position.z-=centre.z;
  model.updateMatrixWorld(true);wrap.updateMatrixWorld(true);
  // Move wheel assemblies onto pivots located at their true geometry centres.
  let wheelCount=0;
  for(const item of candidates){
    const node=item.node;
    if(!node.parent)continue;
    const box=new THREE.Box3().setFromObject(node);
    if(box.isEmpty())continue;
    const localCentre=wrap.worldToLocal(box.getCenter(new THREE.Vector3()));
    const pivot=new THREE.Group();
    pivot.name='TrafficWheelPivot_'+(node.name||wheelCount);
    pivot.position.copy(localCentre);
    wrap.add(pivot);wrap.updateMatrixWorld(true);
    pivot.attach(node);
    pivot.userData.isTrafficWheelPivot=true;
    pivot.userData.isFrontWheel=!!item.front;
    wheelCount++;
  }
  wrap.updateMatrixWorld(true);
  const meshBatching=mergeStaticTrafficMeshes(wrap);
  try{buildTrafficLODs(wrap)}catch(err){console.warn('traffic LOD build failed',def.id,err)}
  wrap.updateMatrixWorld(true);
  console.info('Traffic model ready:',def.id,'wheel pivots:',wheelCount,'length:',TRAFFIC_TARGET_LENGTH,'batched meshes:',meshBatching.mergedSourceMeshes,'->',meshBatching.mergedMeshes);
  return {id:def.id,root:wrap,animations:gltf.animations||[],wheelCount,hull:collectFootprint(wrap)||defaultHull(TRAFFIC_TARGET_LENGTH,1.8)};
}
function trafficParseGLB(loader,bytes){
  const ab=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
  return new Promise((resolve,reject)=>loader.parse(ab,'',resolve,reject));
}
async function loadTrafficModels(){
  if(trafficLoadStarted)return;trafficLoadStarted=true;
  try{
    if(!THREE.GLTFLoader)throw new Error('GLTFLoader unavailable');
    if(!window.fflate||!fflate.gunzipSync)throw new Error('fflate gunzip unavailable');
    const loader=new THREE.GLTFLoader();
    for(const def of TRAFFIC_ASSETS){
      try{
        const packed=TRAFFIC_GLB_GZIP_Z85[def.id];
        const bytes=csUnpack(fflate.gunzipSync(trafficPackedBytes(packed,def.id)));
        const gltf=await trafficParseGLB(loader,bytes);
        trafficTemplates.push(buildTrafficTemplate(gltf,def));
      }catch(e){console.error('Traffic asset failed:',def.id,e)}
      // Release the large compressed string as soon as this asset has been parsed.
      TRAFFIC_GLB_GZIP_Z85[def.id]=null;
      __loading.set(.4+.5*(trafficTemplates.length/TRAFFIC_ASSETS.length));
    }
    if(!trafficTemplates.length)throw new Error('No traffic models could be loaded');
    trafficReady=true;
    createTrafficFleet();
    updateTrafficLoadStatus();
    __loading.finish();
  }catch(e){
    console.error('Traffic loading failed:',e);
    if(trafficLoadStatus)trafficLoadStatus.textContent='تعذر تحميل سيارات المرور؛ تأكد من اتصال الإنترنت ثم أعد فتح اللعبة.';
    __loading.finish();
  }
}
function addTrafficLamps(template,root){
  const b=template.lampBox||(template.lampBox=new THREE.Box3().setFromObject(template.root)),w=b.max.x-b.min.x,h=b.max.y-b.min.y;
  for(const sx of [-1,1])for(const fr of [1,0]){
    const x=sx*w*.31,y=b.min.y+h*(fr?.3:.38),z=fr?b.min.z+.02:b.max.z-.02;
    const m=new THREE.Mesh(TLAMP.g,fr?TLAMP.h:TLAMP.t);m.position.set(x,y,z);m.userData.noDent=true;m.frustumCulled=false;root.add(m);
    const sp=new THREE.Sprite(fr?TLAMP.gh:TLAMP.gt);sp.position.set(x,y,z+(fr?-.05:.05));sp.scale.set(fr?1.6:1.2,fr?1.6:1.2,1);sp.userData.noDent=true;root.add(sp)}}
const _lampMapCache=new WeakMap();
function trafficLampMap(map){if(_lampMapCache.has(map))return _lampMapCache.get(map);const im=map.image,S=1024,r=S/(im.width||2048),c=document.createElement('canvas');c.width=c.height=S;const g=c.getContext('2d');g.fillStyle='#000';g.fillRect(0,0,S,S);
  for(const[x,y,w,h]of[[1600,556,448,236],[1575,798,473,262]])g.drawImage(im,x,y,w,h,x*r,y*r,w*r,h*r);
  const t=new THREE.CanvasTexture(c);t.flipY=false;t.encoding=map.encoding;t.wrapS=map.wrapS;t.wrapT=map.wrapT;t.anisotropy=4;_lampMapCache.set(map,t);return t}
// ---- Dynamic lighting for traffic cars -------------------------------------------------------
// Traffic bodies now react to: street lamps, other cars' head/tail lights (night), and sky/sun reflections (env map).
// Up to 8 cheap point lights per car are fed to the standard PBR shader (diffuse + glossy specular), in world space.
const TLU={k:{value:0}};
const TLN=8;
function makeTrafficLightUniforms(K){
  const P=[],C=[],R=[];for(let i=0;i<TLN;i++){P.push(new THREE.Vector3());C.push(new THREE.Vector3());R.push(0)}
  return{uLP:{value:P},uLC:{value:C},uLR:{value:R},uLK:K||TLU.k};
}
function trafficLightMaterial(c,U){
  c.onBeforeCompile=sh=>{
    sh.uniforms.uLP=U.uLP;sh.uniforms.uLC=U.uLC;sh.uniforms.uLR=U.uLR;sh.uniforms.uLK=U.uLK;
    sh.fragmentShader=sh.fragmentShader
      .replace('void main() {','uniform vec3 uLP['+TLN+'];uniform vec3 uLC['+TLN+'];uniform float uLR['+TLN+'];uniform float uLK;\nvoid main() {')
      .replace('#include <lights_fragment_end>',`#include <lights_fragment_end>
      if(uLK>0.001){
        for(int _i=0;_i<${TLN};_i++){
          if(uLR[_i]>0.){
            vec3 _lv=(viewMatrix*vec4(uLP[_i],1.)).xyz+vViewPosition;
            float _ld=length(_lv);
            float _lf=clamp(1.-_ld/uLR[_i],0.,1.);_lf*=_lf;
            if(_lf>0.){
              IncidentLight _il;_il.direction=_lv/_ld;_il.color=uLC[_i]*_lf*uLK;_il.visible=true;
              RE_Direct(_il,geometry,material,reflectedLight);
            }
          }
        }
      }`);
  };
  c.customProgramCacheKey=()=>'trafficLit1';
}
window._trafficMats=window._trafficMats||[];
function applyTrafficEnv(){
  const list=window._trafficMats;if(!list||!list.length)return;
  const env=isNight?window._envN:envDay;if(!env)return;
  const k=weatherMode==='winter'?.35:(isNight?.55:.9);
  for(const m of list){m.envMap=env;m.envMapIntensity=k;m.needsUpdate=true}
}
const _tlLampSt=[],_tlTmp=new THREE.Vector3();
function _tlSet(U,n,x,y,z,r,g,b,range){U.uLP.value[n].set(x,y,z);U.uLC.value[n].set(r,g,b);U.uLR.value[n]=range}
// Fill one light-uniform set for a receiver at world (px,py,pz) sitting at road station `station`.
function _tlFill(U,px,pz,station,self){
  let n=0;
  let a=-1,b=-1,da=1e9,db=1e9;
  for(let i=0;i<_tlLampSt.length;i++){const d=Math.abs(_tlLampSt[i]-station);if(d<da){db=da;b=a;da=d;a=i}else if(d<db){db=d;b=i}}
  for(let q=0;q<2;q++){
    const idx=q?b:a,dd=q?db:da;if(idx<0||dd>46)continue;
    for(let sgn=-1;sgn<=1;sgn+=2){
      trackToWorld(sgn*2.15,10.4,_tlLampSt[idx],_tlTmp,true);
      _tlSet(U,n++,_tlTmp.x,_tlTmp.y,_tlTmp.z,1.7,1.32,.82,34);
    }
  }
  let c0=null,c1=null,c2=null,c3=null,d0=1e9,d1=1e9,d2=1e9,d3=1e9;
  for(const o of trafficCars){
    if(o===self)continue;
    const dx=o.root.position.x-px,dz=o.root.position.z-pz,d=dx*dx+dz*dz;
    if(d>900)continue;
    if(d<d0){c3=c2;d3=d2;c2=c1;d2=d1;c1=c0;d1=d0;c0=o;d0=d}
    else if(d<d1){c3=c2;d3=d2;c2=c1;d2=d1;c1=o;d1=d}
    else if(d<d2){c3=c2;d3=d2;c2=o;d2=d}
    else if(d<d3){c3=o;d3=d}
  }
  for(let ei=0;ei<4;ei++){
    const E=ei===0?c0:ei===1?c1:ei===2?c2:c3;
    if(!E||n>=TLN)continue;
    const ry=E.root.rotation.y,fx=-Math.sin(ry),fz=-Math.cos(ry),ep=E.root.position;
    const along=(px-ep.x)*fx+(pz-ep.z)*fz;
    if(along>0)_tlSet(U,n++,ep.x+fx*2.4,ep.y+.75,ep.z+fz*2.4,1.5,1.4,1.2,18);
    else _tlSet(U,n++,ep.x-fx*2.35,ep.y+.8,ep.z-fz*2.35,1.4,.12,.06,9);
  }
  for(;n<TLN;n++)U.uLR.value[n]=0;
}
function _tlBuildStations(){if(_tlStFrame===_frameId)return;_tlStFrame=_frameId;_tlLampSt.length=0;for(let i=0;i<segs.length;i++){const z=segs[i].g.position.z;_tlLampSt.push(z-10,z-40)}}
function updateTrafficLighting(){
  const night=isNight;TLU.k.value=night?1:0;
  if(!night)return;
  _tlBuildStations();
  // cars beyond the fog range are never drawn, so their light lists need no refresh (they refresh the moment they come back in range)
  const lim=Math.max(scene.fog.far,520)+110,limSq=lim*lim,pcx=car.position.x,pcz=car.position.z;
  for(let i=0;i<trafficCars.length;i++){const v=trafficCars[i];if(!v.lit)continue;const rp=v.root.position,dx=rp.x-pcx,dz=rp.z-pcz;if(dx*dx+dz*dz>limSq)continue;_tlFill(v.lit,rp.x,rp.z,v.z,v)}
}
// Player car: same street-lamp / other-car lighting, applied to the FBX car's Phong/Standard materials.
const PLK={value:0},PLU=makeTrafficLightUniforms(PLK);let _plT=0;
function patchPlayerCarMaterials(){
  car.traverse(o=>{
    if(!o.isMesh||!o.material)return;
    const ms=Array.isArray(o.material)?o.material:[o.material];
    for(const m of ms){
      if(!m||m.userData.litPatched||m===headM||m===tailM||m.depthTest===false)continue;
      if(!(m.isMeshPhongMaterial||m.isMeshStandardMaterial))continue;
      trafficLightMaterial(m,PLU);m.userData.litPatched=true;carFresnel(m);classifyCarGloss(o,m);m.needsUpdate=true;
    }
  });
  if(window._carGlossDirty){window._carGlossDirty=false;applyCarGloss()}
}
// ===== Glossy car (v58): night environment with street-lamp reflections, fresnel-weighted mirror reflection ======
window._carGloss=window._carGloss||[];
let _carEnvN=null;
function getCarEnvN(){
  if(_carEnvN)return _carEnvN;
  const W=1024,H=512,c=document.createElement('canvas');c.width=W;c.height=H;const g=c.getContext('2d');
  let gr=g.createLinearGradient(0,0,0,H/2);gr.addColorStop(0,'#03060f');gr.addColorStop(.7,'#0a1430');gr.addColorStop(1,'#1a2a55');g.fillStyle=gr;g.fillRect(0,0,W,H/2);
  gr=g.createLinearGradient(0,H/2,0,H);gr.addColorStop(0,'#17130e');gr.addColorStop(1,'#050505');g.fillStyle=gr;g.fillRect(0,H/2,W,H/2);
  g.globalCompositeOperation='lighter';
  const uv=(x,y,z)=>{const l=Math.hypot(x,y,z);return[(.5+Math.atan2(z/l,x/l)/(2*Math.PI))*W,(.5-Math.asin(y/l)/Math.PI)*H,l]};
  const blob=(x,y,r,col)=>{for(const o of [-W,0,W]){const gg=g.createRadialGradient(x+o,y,0,x+o,y,r);gg.addColorStop(0,col);gg.addColorStop(1,'rgba(255,140,50,0)');g.fillStyle=gg;g.fillRect(x+o-r,y-r,r*2,r*2)}};
  // street lamps on the median (to the left of the car), both directions along the road
  for(const dx of [-6.5,-10.8])for(let k=-8;k<=8;k++){
    const dz=k*30+(dx<-8?15:0),p=uv(dx,9.6,dz),l=p[2];
    blob(p[0],p[1],14+760/l,'rgba(255,150,55,.55)');
    blob(p[0],p[1],3+90/l,'rgba(255,232,180,1)');
    const q=uv(dx*.55,-.8,dz);blob(q[0],q[1],10+420/l,'rgba(255,140,50,.28)');
  }
  // warm sky glow ahead and a band of distant city lights
  const gp=uv(0,.4,-100);blob(gp[0],gp[1],170,'rgba(255,150,70,.16)');
  for(let i=0;i<170;i++){const a=(.17+Math.random()*.26)*W,b=H/2-4-Math.random()*14,r=.8+Math.random()*1.9;blob(a,b,r*2.4,Math.random()<.35?'rgba(255,245,225,.9)':'rgba(255,185,95,.85)')}
  const t=new THREE.CanvasTexture(c,THREE.EquirectangularReflectionMapping);t.anisotropy=4;
  return(_carEnvN=t);
}
function carFresnel(m){
  if(!m.isMeshPhongMaterial||m.userData.carFres)return;
  const prev=m.onBeforeCompile,prevKey=m.customProgramCacheKey?m.customProgramCacheKey():'';
  m.onBeforeCompile=function(sh,r){
    if(prev)prev.call(this,sh,r);
    const ch=THREE.ShaderChunk.envmap_fragment.split('specularStrength * reflectivity').join('specularStrength * reflectivity * _cf');
    sh.fragmentShader=sh.fragmentShader.replace('#include <envmap_fragment>','float _cf=.2+.8*pow(1.-clamp(dot(normalize(vViewPosition),normal),0.,1.),3.5);\n'+ch);
  };
  m.customProgramCacheKey=()=>prevKey+'|carFres';
  m.userData.carFres=true;
}
function classifyCarGloss(o,m){
  if(m.userData.carGlossSet)return;m.userData.carGlossSet=true;
  const sig=(o.name||'')+' '+(m.name||'');let t=null;
  if(paintMaterials.has(m))t='paint';
  else if(/Window|Glass|Windscreen|Windshield/i.test(sig)&&!/Light|Lamp/i.test(sig))t='glass';
  else if(/Chrome|Metal|Alloy|Badge|Mirror|Trim|Rim|Exhaust|Silver/i.test(sig)&&!/Light|Lamp|Glass|Window|Tyre|Tire|Carbon|Interior/i.test(sig))t='chrome';
  if(t){window._carGloss.push({m,t});window._carGlossDirty=true}
}
function applyCarGloss(){
  const list=window._carGloss;if(!list||!list.length)return;
  const gl=activePaintFinish==='gloss',env=isNight?getCarEnvN():envDay;if(!env)return;
  const wk=weatherMode==='winter'?.75:1,R={paint:.95,glass:.7,chrome:.8};
  for(const e of list){
    const m=e.m;
    if(e.t==='paint'&&!gl)m.envMap=null;
    else{
      m.envMap=env;
      if(m.isMeshPhongMaterial){
        if(e.t==='paint'){m.combine=THREE.MixOperation;m.reflectivity=(.1+.2*Math.min(1,(window._paintLum||0)*1.6))*wk}
        else{m.combine=THREE.AddOperation;m.reflectivity=R[e.t]*wk;if(m.shininess<200)m.shininess=200}
      }
      else if(m.isMeshStandardMaterial)m.envMapIntensity=(e.t==='paint'?.35:1.3)*wk;
    }
    m.needsUpdate=true;
  }
}
const _rlTmp=new THREE.Vector3();
const _rlCand=[];
function updateRoadLampUniforms(playerRoad){
  RLU.K.value=isNight?1:0;RLU.W.value=weatherMode==='winter'?1:0;
  if(!isNight)return;
  _tlBuildStations();
  const pz=(playerRoad||playerRoadCoords()).z,cand=_rlCand;cand.length=0;
  for(let i=0;i<_tlLampSt.length;i++){const d=_tlLampSt[i]-pz;if(d<60&&d>-250)cand.push(_tlLampSt[i])}
  cand.sort((a,b)=>Math.abs(a-pz+90)-Math.abs(b-pz+90));
  const P=RLU.P.value,C=RLU.C.value;let n=0;
  for(let i=0;i<cand.length&&n<=18;i++)for(let sg=-1;sg<=1;sg+=2){
    trackToWorld(sg*2.15,10.4,cand[i],_rlTmp,true);
    const lx=_rlTmp.x,ly=_rlTmp.y,lz=_rlTmp.z;
    trackToWorld(sg*2.15+1,10.4,cand[i],_rlTmp,true);
    const ex=_rlTmp.x-lx,ez=_rlTmp.z-lz,el=Math.hypot(ex,ez)||1;
    P[n].set(lx,ly,lz,ez/el);C[n].set(1,.52,.2,.6*sg);n++;
  }
  for(;n<20;n++)C[n].set(0,0,0,0);
  // nearest traffic cars: red tail-light / white head-light streaks on the wet road
  let c0=null,c1=null,d0=1e9,d1=1e9;
  for(const o of trafficCars){
    const dx=o.root.position.x-car.position.x,dz=o.root.position.z-car.position.z,d=dx*dx+dz*dz;
    if(d>16900)continue;
    if(d<d0){c1=c0;d1=d0;c0=o;d0=d}else if(d<d1){c1=o;d1=d}
  }
  let m=20;
  for(let ei=0;ei<2;ei++){
    const E=ei?c1:c0;
    if(!E){C[m].set(0,0,0,0);C[m+1].set(0,0,0,0);m+=2;continue}
    const ry=E.root.rotation.y,fx=-Math.sin(ry),fz=-Math.cos(ry),rx=Math.cos(ry),rz=-Math.sin(ry),ep=E.root.position;
    const head=((car.position.x-ep.x)*fx+(car.position.z-ep.z)*fz)>0,o=head?2.4:-2.35;
    for(let si=0;si<2;si++){
      const sd=si?.68:-.68;
      P[m].set(ep.x+fx*o+rx*sd,ep.y+.75,ep.z+fz*o+rz*sd,.16);
      if(head)C[m].set(1.4,1.15,.8,.35);else C[m].set(1.5,.1,.05,.35);
      m++;
    }
  }
}
function updatePlayerLighting(playerRoad){
  updateRoadLampUniforms(playerRoad);
  TLU.k.value=isNight?1:0;
  // Player car: 15% weaker than traffic cars, and no outside light on it at all in the cockpit view.
  PLK.value=(isNight&&view!==2)?.85:0;
  if(!isNight||view===2)return;
  _plT-=1;if(_plT<=0){_plT=90;patchPlayerCarMaterials()}
  _tlBuildStations();
  _tlFill(PLU,car.position.x,car.position.z,(playerRoad||playerRoadCoords()).z,null);
}
function cloneTrafficCar(template,color){
  const root=template.root.clone(true),materialCopies=new Map(),wheels=[],LU=makeTrafficLightUniforms();
  root.traverse(o=>{
    if(o.userData&&o.userData.isTrafficWheelPivot){wheels.push({pivot:o,front:!!o.userData.isFrontWheel});return}
    if(!o.isMesh)return;
    o.castShadow=false;o.receiveShadow=true;
    const cloneMat=m=>{
      if(!m)return m;
      if(materialCopies.has(m))return materialCopies.get(m);
      const c=m.clone(),name=(m.name||'').toLowerCase();
      if(/car1|body|badaneh/.test(name)&&c.color){
        c.color.set(color);
        if('roughness' in c)c.roughness=Math.max(.22,Math.min(.42,c.roughness||.3));
        if('metalness' in c)c.metalness=Math.max(c.metalness||0,.18);
      }
      if(name==='car1'&&c.map&&c.map.image){c.emissive.set(0xffffff);c.emissiveMap=trafficLampMap(c.map);c.emissiveIntensity=1.8}
      else if(name==='body'&&c.emissiveMap){c.emissive.set(0xffffff);c.emissiveIntensity=2.2}
      else if(name==='cheragh_jelo'||name==='material.006')c.emissiveIntensity=(c.emissiveIntensity||1)*2.5;
      if(c.isMeshStandardMaterial){trafficLightMaterial(c,LU);window._trafficMats.push(c)}
      c.needsUpdate=true;materialCopies.set(m,c);return c;
    };
    o.material=Array.isArray(o.material)?o.material.map(cloneMat):cloneMat(o.material);
  });
  root.name='Traffic_'+template.id;
  let far=null;
  try{
    if(template.farGeo===undefined)template.farGeo=buildTrafficFarGeo(root);
    if(template.farGeo){
      let rough=.4;root.traverse(o=>{const mm=trafficFarSrc(o);if(mm&&trafficIsBody(mm)&&'roughness' in mm)rough=mm.roughness});
      const fm=trafficFarMaterial(LU,new THREE.Color(color),rough);window._trafficMats.push(fm);
      far=new THREE.Mesh(template.farGeo,fm);far.name='trafficFar';far.visible=false;far.userData.noDent=true;root.add(far);
    }
  }catch(err){console.warn('traffic far mesh failed',err);far=null}
  applyTrafficEnv();
  return {root,wheels,templateId:template.id,lit:LU,far};
}
function resetTrafficVehicleState(v,plan,respawn=false){
  const direction=plan.direction;
  v.direction=direction;v.lane=plan.lane;v.x=plan.lane;v.z=plan.z;
  v.h=direction>0?Math.PI:0;
  v.targetSpeed=randomTrafficSpeed();
  v.speed=v.targetSpeed;
  v.wx=-Math.sin(v.h)*v.speed;v.wz=-Math.cos(v.h)*v.speed;
  v.steer=0;v.yawRate=0;v.slide=0;v.gear=0;v.rpm=900;v.cw=0;v.hitTimer=0;v.fxT=0;repairTrafficCar(v);
  v.throttle=0;v.brake=0;v.shiftTimer=0;v.accel=0;v.pitch=0;v.roll=0;v.frontSteer=0;
  for(const w of v.wheels){w.pivot.rotation.x=0;w.pivot.rotation.y=0}
  lcReset(v,plan.lane);
  updateTrafficVehicleTransform(v,0);
}
function createTrafficFleet(){
  if(!trafficReady||!trafficTemplates.length)return;
  const plans=makeTrafficSpawnPlans();
  // Reuse already-created cars when restarting instead of allocating new GPU
  // materials and meshes repeatedly.
  while(trafficCars.length>TRAFFIC_TOTAL_CARS){
    const v=trafficCars.pop();trafficRoot.remove(v.root);
  }
  while(trafficCars.length<TRAFFIC_TOTAL_CARS){
    const serial=trafficCars.length;
    const template=trafficTemplates[(serial*7+Math.floor(serial/3))%trafficTemplates.length];
    const paint=TRAFFIC_PAINTS[(serial*5+Math.floor(serial/2))%TRAFFIC_PAINTS.length];
    const instance=cloneTrafficCar(template,paint);
    const v={...instance,template,hull:template.hull,mass:TRAFFIC_MASS[template.id]||1300,cw:0,hitTimer:0,fxT:0,dentList:null,lane:0,x:0,z:0,direction:-1,h:0,wx:0,wz:0,
      speed:0,targetSpeed:0,steer:0,yawRate:0,slide:0,gear:0,rpm:900,
      throttle:0,brake:0,shiftTimer:0,accel:0,pitch:0,roll:0,frontSteer:0};
    trafficRoot.add(v.root);trafficCars.push(v);
  }
  for(let i=0;i<TRAFFIC_TOTAL_CARS;i++)resetTrafficVehicleState(trafficCars[i],plans[i]);
  console.info('Traffic fleet created:',trafficCars.length,'('+TRAFFIC_CARS_PER_DIRECTION+' main-direction; '+TRAFFIC_OPPOSITE_CARS+' opposite-direction; ~59–117 km/h target speeds; a further 7% slower)');
}
function resetTrafficFleet(){
  if(!trafficReady)return;
  createTrafficFleet();
}
function trafficSpawnAtNewRoad(v,spawnAheadOfPlayer=false){
  const lanes=v.direction<0?TRAFFIC_FRONT_LANES:TRAFFIC_OPPOSITE_LANES;
  // Recycled cars enter from the appropriate edge. Cars overtaken by the
  // player are placed anywhere in the forward half, choosing the sparsest gap
  // so respawning does not create one dense clump and leave another section empty.
  const playerS=playerRoadCoords().z;
  const front=playerS-FRONT_ROAD_BUFFER+100;
  const rear=playerS+REAR_ROAD_BUFFER-100;
  let low,high;
  if(spawnAheadOfPlayer){
    low=front+10;
    high=Math.min(playerS-135,rear-20);
  }else if(v.direction<0){
    low=rear-230;high=rear-65;
  }else{
    low=front+65;high=front+230;
  }
  if(high<low+20){low=front+10;high=Math.max(low+20,Math.min(playerS-135,rear-20));}
  let best=null,bestScore=-Infinity;
  for(let attempt=0;attempt<160;attempt++){
    const lane=lanes[Math.floor(Math.random()*lanes.length)];
    const z=rnd(low,high);
    let nearestAnyGap=Infinity,minSameLaneGap=Infinity,hasAdjacentGroup=false;
    for(const other of trafficCars){
      if(other===v||other.direction!==v.direction)continue;
      const laneGap=Math.abs(other.lane-lane),zGap=Math.abs(other.z-z);
      nearestAnyGap=Math.min(nearestAnyGap,zGap);
      if(laneGap<=1.0)minSameLaneGap=Math.min(minSameLaneGap,zGap);
      else if(zGap<18&&laneGap<7.5)hasAdjacentGroup=true;
    }
    // Prefer a sparse longitudinal section, while retaining safe same-lane spacing.
    // A small bonus allows occasional side-by-side traffic in neighbouring lanes.
    const score=Math.min(nearestAnyGap,100)*.62+
      Math.min(minSameLaneGap,115)*.38+
      (hasAdjacentGroup?12:0)+Math.random()*1.5;
    if(score>bestScore){bestScore=score;best={direction:v.direction,lane,z};}
    if(minSameLaneGap>=30&&nearestAnyGap>=18){best={direction:v.direction,lane,z};break;}
  }
  if(best)resetTrafficVehicleState(v,best,true);
}
// >>> LANE-CHANGE AI ==========================================================================================================
// A share (LC.share) of the cars are "lane changers". They move over when stuck behind a slower car, and now and then just wander
// (preferring to drift back to their home lane). A change only starts when the target lane is clear in front of AND behind the car
// (the rear gap grows with the follower's closing speed; the player counts as a normal car). The car then blinks for 1.4-2.2 s,
// re-checks the gap, slides across in 3.2-4.4 s and keeps blinking until it has settled. Tune everything in LC.
const LC={share:.45,signalMin:1.4,signalMax:2.2,durMin:3.2,durMax:4.4,coolMin:7,coolMax:22,tick:.5,wander:.016,blinkHz:1.5,
  carLen:4.55,signalRange:180,maxWait:3.5,settle:.45,hold:.7};
const SIG={g:new THREE.BoxGeometry(1,1,1),m:new THREE.MeshBasicMaterial({color:0xffa61c,fog:true}),
  s:new THREE.SpriteMaterial({map:glowT,color:0xffa11a,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false})};
const trafficLanesOf=v=>v.direction<0?TRAFFIC_FRONT_LANES:TRAFFIC_OPPOSITE_LANES;
function lcReset(v,lane){
  const li=Math.max(0,trafficLanesOf(v).indexOf(lane));
  v.laneIdx=li;v.homeIdx=li;v.laneFrom=v.laneTo=lane;v.laneToIdx=li;v.lcState=0;v.lcT=0;v.lcDur=3.6;v.lcWait=0;v.laneRate=0;v.lcForce=false;
  v.sig=0;v.sigHold=0;v.sigPhase=0;v.lcOn=Math.random()<LC.share;v.pat=Math.random();v.lcCool=rnd(2,LC.coolMax);v.lcTick=Math.random()*LC.tick;
  if(v.sigL){v.sigL.visible=false;v.sigR.visible=false}
  lcEnv(v);
}
// Lanes a car occupies: oa/ob as seen by other cars (a car that signals has already claimed its target lane),
// sa/sb as seen by the car itself (it only looks at the target lane once it is really moving over).
function lcEnv(v){
  if(v.hitTimer>0){v.oa=v.ob=v.sa=v.sb=v.x;return}
  if(v.lcState>0){v.oa=v.laneFrom;v.ob=v.laneTo}else v.oa=v.ob=v.lane;
  if(v.lcState===2){v.sa=v.laneFrom;v.sb=v.laneTo}else v.sa=v.sb=v.lane;
}
// Is lane X free for car v? Returns null if not, else {gap,speed} of the nearest car ahead in that lane (bumper to bumper).
function lcCheckLane(v,X,pr,ps){
  if(bridgeWallBetween(v.lane,X,v.z))return null; // the bridge divider wall: no lane changes between the bridge lanes and the ground lanes
  let gap=Infinity,spd=TRAFFIC_MAX_SPEED;const sg=v.direction<0?1:-1;
  for(const o of trafficCars){
    if(o===v||o.direction!==v.direction)continue;
    if(Math.abs(o.oa-X)>=2&&Math.abs(o.ob-X)>=2)continue;
    const d=(v.z-o.z)*sg;
    if(d>=0){const g=d-LC.carLen;if(g<6+Math.max(0,v.speed-o.speed)*1.6)return null;if(g<gap){gap=g;spd=o.speed}}
    else if(-d-LC.carLen<8+Math.max(0,o.speed-v.speed)*2.6)return null;
  }
  if(pr&&Math.abs(pr.x-X)<2.8){ // the player is less predictable than the AI: extra margin
    if(v.direction>0){if(Math.abs(v.z-pr.z)<70)return null}
    else{const d=v.z-pr.z;
      if(d>=0){const g=d-LC.carLen;if(g<10+Math.max(0,v.speed-ps)*1.8)return null;if(g<gap){gap=g;spd=ps}}
      else if(-d-LC.carLen<12+Math.max(0,ps-v.speed)*2.9)return null}
  }
  if(POL.on&&POL.car&&v.direction<0){ // the police car counts like the player: nobody cuts in front of / into it
    const pc=POL.car;
    if(Math.abs(pc.x-X)<2.8){const d=v.z-pc.z;
      if(d>=0){if(d-LC.carLen<10+Math.max(0,v.speed-pc.speed)*1.8)return null}
      else if(-d-LC.carLen<12+Math.max(0,pc.speed-v.speed)*2.9)return null}
  }
  return{gap,speed:spd};
}
function lcLeader(v,X,pr,ps){ // nearest car ahead in lane X (no safety rules)
  let gap=Infinity,spd=TRAFFIC_MAX_SPEED;const sg=v.direction<0?1:-1;
  for(const o of trafficCars){
    if(o===v||o.direction!==v.direction||(Math.abs(o.oa-X)>=2&&Math.abs(o.ob-X)>=2))continue;
    const g=(v.z-o.z)*sg-LC.carLen;if(g>=-LC.carLen&&g<gap){gap=g;spd=o.speed}
  }
  if(v.direction<0&&pr&&Math.abs(pr.x-X)<2.5){const g=v.z-pr.z-LC.carLen;if(g>=-LC.carLen&&g<gap){gap=g;spd=ps}}
  return{gap,speed:spd};
}
function lcBegin(v,j){
  v.laneFrom=v.lane;v.laneTo=trafficLanesOf(v)[j];v.laneToIdx=j;
  v.sig=Math.abs(v.laneTo)>Math.abs(v.laneFrom)?1:-1; // larger |x| = towards the outer edge = the driver's right, in both directions
  v.sigPhase=0;v.sigHold=0;v.lcState=1;v.lcT=0;v.lcWait=rnd(LC.signalMin,LC.signalMax);lcEnv(v);
}
function lcEnd(v,done){
  const lanes=trafficLanesOf(v);let bi=v.laneToIdx;
  if(!done){let bd=1e9;for(let i=0;i<lanes.length;i++){const d=Math.abs(lanes[i]-v.x);if(d<bd){bd=d;bi=i}}}
  v.lane=lanes[bi];v.laneIdx=bi;v.laneRate=0;v.lcState=0;v.lcT=0;v.lcForce=false;v.sigHold=done?LC.hold:0;
  v.lcCool=rnd(LC.coolMin,LC.coolMax)*(done?1:.4);lcEnv(v);
}
function lcDecide(v,pr,ps){
  const lanes=trafficLanesOf(v),cur=lcLeader(v,v.lane,pr,ps);
  let want=0;
  if(cur.gap<30+26*v.pat&&v.targetSpeed-cur.speed>2.4-1.3*v.pat)want=1;      // stuck behind a slower car -> overtake
  else if(Math.random()<LC.wander)want=2;                                    // random wander
  if(!want)return;
  const cand=[];for(const d of [-1,1]){const j=v.laneIdx+d;if(j>=0&&j<lanes.length)cand.push(j)}
  if(want===2&&v.homeIdx!==v.laneIdx)cand.sort((a,b)=>Math.abs(a-v.homeIdx)-Math.abs(b-v.homeIdx));
  else if(Math.random()<.5)cand.reverse();
  for(const j of cand){
    const r=lcCheckLane(v,lanes[j],pr,ps);if(!r)continue;
    if(want===1&&!(r.speed>cur.speed+1.5||r.gap>cur.gap+14))continue;        // must really be a better lane
    if(want===2&&r.gap<40&&r.speed<v.targetSpeed-3)continue;                  // never wander into a slower queue
    lcBegin(v,j);return;
  }
}
function lcUpdate(v,dt,pr,ps){
  if(v.hitTimer>0){if(v.lcState)lcEnd(v,false);v.sig=0;return}
  if(v.lcState===0){
    if(v.sig){v.sigHold-=dt;if(v.sigHold<=0)v.sig=0}
    if(v.lcCool>0)v.lcCool-=dt;
    v.lcTick-=dt;
    if(!v.lcOn||v.lcCool>0||v.lcTick>0)return;
    v.lcTick=LC.tick*(.8+Math.random()*.4);
    if(v.speed>8)lcDecide(v,pr,ps);
    return;
  }
  v.lcT+=dt;
  if(v.lcState===1){
    if(v.lcT<v.lcWait)return;
    if(v.lcForce||lcCheckLane(v,v.laneTo,pr,ps)){v.lcState=2;v.lcT=0;v.lcDur=v.lcForce?rnd(2.4,3.2):rnd(LC.durMin,LC.durMax);lcEnv(v)}   // still clear -> go
    else if(v.lcT>v.lcWait+LC.maxWait)lcEnd(v,false);                                                    // gave up
    return;
  }
  const u=Math.min(1,v.lcT/v.lcDur),k=u*u*(3-2*u),dL=v.laneTo-v.laneFrom;
  v.lane=v.laneFrom+dL*k;v.laneRate=dL*6*u*(1-u)/v.lcDur;
  if(u>=1&&(Math.abs(v.x-v.laneTo)<LC.settle||v.lcT>v.lcDur+3))lcEnd(v,true);
}
// ---- turn-signal lamps: amber lens + glow on all four corners, created lazily the first time a car signals ----
function hullEndZ(hb,x,front){ // z of the footprint outline at lateral position x
  let best=null;const P=hb.poly;
  for(let i=0;i<P.length;i++){
    const a=P[i],b=P[(i+1)%P.length];
    if(x<Math.min(a[0],b[0])-1e-6||x>Math.max(a[0],b[0])+1e-6)continue;
    const dx=b[0]-a[0],zs=Math.abs(dx)<1e-6?[a[1],b[1]]:[a[1]+(b[1]-a[1])*(x-a[0])/dx];
    for(const z of zs)if(best===null||(front?z<best:z>best))best=z;
  }
  return best===null?(front?hb.cz-hb.hl:hb.cz+hb.hl):best;
}
function ensureSignalLamps(v){
  if(v.sigL)return;
  const tpl=v.template,hb=v.hull||defaultHull(TRAFFIC_TARGET_LENGTH,1.8);
  const b=tpl.lampBox||(tpl.lampBox=new THREE.Box3().setFromObject(tpl.root)),y=b.min.y+(b.max.y-b.min.y)*.46,lx=hb.hw*.74;
  for(const sd of [-1,1]){
    const grp=new THREE.Group();grp.visible=false;grp.userData.noDent=true;
    for(const front of [true,false]){
      const z=hullEndZ(hb,sd*lx,front);
      const lamp=new THREE.Mesh(SIG.g,SIG.m);lamp.scale.set(.27,.1,.09);lamp.position.set(sd*lx,y,z+(front?.035:-.035));
      lamp.userData.noDent=true;lamp.frustumCulled=false;
      const spr=new THREE.Sprite(SIG.s);spr.position.set(sd*lx,y,z+(front?-.08:.08));spr.scale.set(.62,.62,1);spr.userData.noDent=true;spr.frustumCulled=false;
      grp.add(lamp,spr);
    }
    v.root.add(grp);if(sd<0)v.sigL=grp;else v.sigR=grp;
  }
}
function lcSignals(v,dt,near){
  if(!v.sig){if(v.sigL){v.sigL.visible=false;v.sigR.visible=false}return}
  if(!near){if(v.sigL){v.sigL.visible=false;v.sigR.visible=false}v.sigPhase+=dt*LC.blinkHz;return}
  ensureSignalLamps(v);v.sigPhase+=dt*LC.blinkHz;
  const on=(v.sigPhase%1)<.5;v.sigL.visible=on&&v.sig<0;v.sigR.visible=on&&v.sig>0;
}
// <<< LANE-CHANGE AI ==========================================================================================================
function trafficDesiredSpeed(v,playerSpeed,playerRoad){
  let desired=v.targetSpeed;
  let nearestAheadGap=Infinity;
  // Adaptive following distance for cars travelling in the same lane, plus
  // a gentle all-lane spacing controller that prevents the whole fleet from
  // drifting into a single cluster and leaving long empty road sections.
  for(const other of trafficCars){
    if(other===v||other.direction!==v.direction)continue;
    const laneGap=Math.min(Math.abs(other.oa-v.sa),Math.abs(other.oa-v.sb),Math.abs(other.ob-v.sa),Math.abs(other.ob-v.sb));
    let loopGap=v.direction<0
      ? (v.z-other.z+ROAD_RING_LENGTH)%ROAD_RING_LENGTH
      : (other.z-v.z+ROAD_RING_LENGTH)%ROAD_RING_LENGTH;
    if(loopGap>.05){
      // Cars that are virtually abreast in a separate lane are a side-by-side
      // pair, not a leader; do not make either one brake for the other.
      if(!(laneGap>1.0&&loopGap<14))nearestAheadGap=Math.min(nearestAheadGap,loopGap);
    }
    if(laneGap>1.0)continue;
    const gap=v.direction<0?v.z-other.z:other.z-v.z;
    if(gap>0&&gap<58){
      const safe=Math.max(0,other.speed+Math.max(-12,(gap-13)*.24));
      desired=Math.min(desired,safe);
    }
  }
  // Keep average longitudinal spacing close to the fleet's natural density
  // (~60 m per car in each direction) while preserving each car's own speed.
  if(Number.isFinite(nearestAheadGap)){
    const targetGap=ROAD_RING_LENGTH/TRAFFIC_CARS_PER_DIRECTION;
    const correction=clampTraffic((nearestAheadGap-targetGap)*.05,-4,5);
    desired=clampTraffic(desired+correction,TRAFFIC_MIN_SPEED,TRAFFIC_MAX_SPEED);
  }
  // A same-direction car behind the player slows down rather than driving into the player's rear.
  if(v.direction<0&&Math.min(Math.abs(v.sa-playerRoad.x),Math.abs(v.sb-playerRoad.x))<1.7){
    const gap=v.z-playerRoad.z;
    if(gap>0&&gap<58)desired=Math.min(desired,Math.max(0,playerSpeed+Math.max(-12,(gap-13)*.24)));
  }
  // the police car counts like the player here too: a car behind it slows down instead of driving into its rear when the police brakes for traffic
  if(POL.on&&POL.car&&POL.car.root.visible&&v.direction<0&&Math.min(Math.abs(v.sa-POL.car.x),Math.abs(v.sb-POL.car.x))<1.7){
    const gap=v.z-POL.car.z;
    if(gap>0&&gap<58)desired=Math.min(desired,Math.max(0,POL.car.speed+Math.max(-12,(gap-13)*.24)));
  }
  if(v.hitTimer>0){ // a car that has just been hit brakes; a badly spun one stops
    desired=Math.min(desired,v.targetSpeed*.35);
    if(Math.abs(_wrapAng(v.h-(v.direction>0?Math.PI:0)))>.6)desired=0;
  }
  return clampTraffic(desired,0,TRAFFIC_MAX_SPEED);
}
function updateTrafficVehiclePhysics(v,dt,desiredSpeed){
  { // lane keeping: steers a car that was knocked off its heading / lane back (zero steer when already aligned)
    const dl=_wrapAng(v.h-(v.direction>0?Math.PI:0)),s=v.direction<0?1:-1;
    const lcm=v.lcState===2,ff=lcm?-(v.laneRate||0)/Math.max(8,v.speed):0,lim=v.latLim||(lcm?.17:.12);
    const want=s*clampTraffic((v.x-v.lane)*(v.latGain||.06)+ff,-lim,lim);
    v.steer=clampTraffic((want-dl)*3.2,-1,1)*(v.hitTimer>0?.3:1);
  }
  // Same 2D body-velocity integration as the player, using the shared P/TQ/tq data.
  // The AI controller only supplies throttle/brake; the car's own heading and grip
  // determine its motion. Lane keeping is handled in the curved road coordinate frame.
  let fx=-Math.sin(v.h),fz=-Math.cos(v.h);
  let u0=v.wx*fx+v.wz*fz;
  const sp0=Math.abs(u0);
  const speedError=desiredSpeed-sp0;
  const throttleTarget=clampTraffic(speedError*.17,0,1);
  const brakeTarget=clampTraffic((-speedError-.4)*.30,0,1);
  v.throttle+=(throttleTarget-v.throttle)*Math.min(1,dt*(throttleTarget?6:10));
  v.brake+=(brakeTarget-v.brake)*Math.min(1,dt*12);
  const wheelRPM=g=>sp0/P.R*P.ratios[g]*P.fd*9.5493;
  if(v.shiftTimer>0)v.shiftTimer=Math.max(0,v.shiftTimer-dt);
  else{
    const th=v.throttle;
    if(v.gear<5&&wheelRPM(v.gear)>3200+3500*th&&wheelRPM(v.gear+1)>1900){v.gear++;v.shiftTimer=.2}
    else if(v.gear>0&&((wheelRPM(v.gear)<1700+1100*th)||(th>.85&&wheelRPM(v.gear)<3600&&wheelRPM(v.gear-1)<5800))&&wheelRPM(v.gear-1)<6800){v.gear--;v.shiftTimer=.15}
  }
  const rpmW=wheelRPM(v.gear);
  const rpmE=Math.max(rpmW,P.idle+v.throttle*(1300+1000*(rpmW<2500?1:0)));
  let torque=0;
  if(v.shiftTimer<=0){
    torque=v.throttle*tq(rpmE)-(1-v.throttle)*(rpmW>1300?18+.02*rpmE:0);
    if(rpmW>7100)torque=0;
  }
  const ratio=P.ratios[v.gear];
  const Fdrive=torque*ratio*P.fd*P.eff/P.R;
  const pk=v.powerK||1,aDrive=clampTraffic(Fdrive*pk/P.m,-P.maxTrac*pk,P.maxTrac*pk); // powerK: the police car is tuned stronger than the player's
  v.rpm+=(Math.min(rpmE,7300)-v.rpm)*Math.min(1,dt*14);
  const n=Math.max(1,Math.ceil(dt/.016)),h=dt/n,kd=.5*P.rho*P.CdA/P.m;
  let lateralAcceleration=0,longitudinalAcceleration=0;
  for(let i=0;i<n;i++){
    fx=-Math.sin(v.h);fz=-Math.cos(v.h);
    let rx=Math.cos(v.h),rz=-Math.sin(v.h);
    let u=v.wx*fx+v.wz*fz,side=v.wx*rx+v.wz*rz;
    const V=Math.hypot(u,side);
    const dir=u<-2?-1:1;
    const yawMax=Math.max(P.yawMin,P.yaw0/(1+(V/P.yawV)*(V/P.yawV)));
    const lowT=Math.min(1,V/P.lowV),lowF=P.lowK+(1-P.lowK)*lowT*lowT*(3-2*lowT);
    let yawTarget=v.steer*yawMax*lowF*Math.min(1,V/P.yawLow)*dir;
    const beta=Math.atan2(side,Math.max(Math.abs(u),.5));
    if(dir>0&&yawTarget*beta>0){const t=Math.min(1,Math.max(0,(Math.abs(beta)-P.sl0)/(P.sl1-P.sl0)));yawTarget*=1-t*t*(3-2*t)}
    v.yawRate+=(yawTarget-v.yawRate)*Math.min(1,h*11);
    v.h+=(v.yawRate+v.cw)*h;v.cw*=Math.exp(-CRASH.cwDecay*h);
    fx=-Math.sin(v.h);fz=-Math.cos(v.h);rx=Math.cos(v.h);rz=-Math.sin(v.h);
    u=v.wx*fx+v.wz*fz;side=v.wx*rx+v.wz*rz;
    const speed=Math.hypot(u,side),su=Math.tanh(u/.4);
    const a=aDrive-v.brake*P.brake*su-kd*(v.dragK||1)*speed*u-P.Crr*P.g*Math.tanh(u/.3);
    const nextU=u+a*h;
    u=(!throttleTarget&&u*nextU<0)?0:nextU;
    const oldSide=side;
    side=(side-kd*speed*side*h)*Math.exp(-P.grip*h);
    lateralAcceleration+=(side-oldSide)/h;
    longitudinalAcceleration+=a;
    v.wx=u*fx+side*rx;v.wz=u*fz+side*rz;
    v.x+=v.wx*h;v.z+=v.wz*h;
  }
  v.speed=Math.abs(v.wx*(-Math.sin(v.h))+v.wz*(-Math.cos(v.h)));
  v.accel=longitudinalAcceleration/n;
  const targetPitch=clampTraffic(-v.accel*.0035,-.05,.05);
  v.pitch+=(targetPitch-v.pitch)*Math.min(1,dt*6);
}
function updateTrafficVehicleTransform(v,dt){
  const yaw=roadYawAt(v.z);
  const yawAhead=roadYawAt(v.z+v.direction*5);
  let dyaw=yawAhead-yaw;dyaw=Math.atan2(Math.sin(dyaw),Math.cos(dyaw));
  const curvature=dyaw/5;
  const lateralAccel=v.speed*v.speed*curvature;
  v.roll+=(clampTraffic(-lateralAccel*.0035,-.045,.045)-v.roll)*Math.min(1,dt*5);
  v.frontSteer=clampTraffic(Math.atan(2.55*curvature),-.18,.18);
  v.root.position.copy(trackToWorld(v.x,0,v.z,_trafficPosition));
  v.root.rotation.set(v.pitch-Math.atan(bridgeSlopeAt(v.x,v.z)),yaw+v.h,v.roll);
  for(const w of v.wheels){
    if(w.front)w.pivot.rotation.y=v.frontSteer;
    w.pivot.rotation.x-=v.speed*dt/.33;
  }
}
// Full vehicle dynamics are only needed near the player. Distant traffic is
// visually small and can cruise in road-space while retaining its speed-spacing AI.
// This avoids running the expensive multi-step tyre/gear physics for every car.
const TRAFFIC_FULL_PHYSICS_DISTANCE=280;
function updateTraffic(dt,playerSpeed,playerRoad){
  if(!trafficReady||!trafficCars.length)return;
  playerRoad=playerRoad||playerRoadCoords();
  for(const v of trafficCars)lcEnv(v);
  for(const v of trafficCars){
    const distanceToPlayer=Math.abs(v.z-playerRoad.z);
    const fullPhysics=distanceToPlayer<=TRAFFIC_FULL_PHYSICS_DISTANCE||v.hitTimer>0;
    lcUpdate(v,dt,playerRoad,playerSpeed);
    const desired=trafficDesiredSpeed(v,playerSpeed,playerRoad);
    if(fullPhysics){
      updateTrafficVehiclePhysics(v,dt,desired);
    }else{
      // Far-away cars keep their lane and use a lightweight cruise-speed response.
      // They switch back to full dynamics well before entering the player's vicinity.
      v.speed+=(desired-v.speed)*Math.min(1,dt*2.5);
      v.h=v.direction>0?Math.PI:0;
      v.wx=0;
      v.wz=v.direction*v.speed;
      v.x+=(v.lane-v.x)*Math.min(1,dt*3);
      v.z+=v.direction*v.speed*dt;
      v.pitch*=Math.exp(-dt*5);
      v.roll*=Math.exp(-dt*5);
    }
    // Forward traffic has two recycling cases:
    // 1) It reaches the far-front edge while driving faster than the player -> wrap behind.
    // 2) The player overtakes it and it falls far behind -> respawn ahead beyond the fog.
    // This second case is what keeps traffic continuously populated after overtaking.
    if(v.direction<0&&v.z<playerRoad.z-FRONT_ROAD_BUFFER+70){
      trafficSpawnAtNewRoad(v,false);
    }else if(v.direction<0&&v.z>playerRoad.z+REAR_ROAD_BUFFER-90){
      trafficSpawnAtNewRoad(v,true);
    }else if(v.direction>0&&v.z>playerRoad.z+REAR_ROAD_BUFFER-70){
      trafficSpawnAtNewRoad(v,false);
    }
    if(v.polQuiet>0)v.polQuiet-=dt; // traffic car struck by the police car: its own knock-on hits stay silent for a moment
    if(v.hitTimer>0)v.hitTimer-=dt;
    else if(v.speed<2.5){ // a wreck at rest straightens itself so it does not block the carriageway for ever
      const dl=_wrapAng(v.h-(v.direction>0?Math.PI:0));
      if(Math.abs(dl)>.01)v.h-=Math.max(-.6*dt,Math.min(.6*dt,dl));
      const ex=v.lane-v.x;if(Math.abs(ex)>.02)v.x+=Math.max(-1.2*dt,Math.min(1.2*dt,ex));
    }
  }
  if(POL.on&&POL.car){try{policeStep(dt,playerSpeed,playerRoad)}catch(e){policeErr(e)}}
  resolveCollisions(dt);
  if(POL.on&&POL.car){try{policeAfter(dt)}catch(e){policeErr(e)}}
  const pcx=car.position.x,pcz=car.position.z,sr2=LC.signalRange*LC.signalRange;
  SIG.s.opacity=isNight?1:.55;
  for(const v of trafficCars){updateTrafficVehicleTransform(v,dt);const dx=v.root.position.x-pcx,dz=v.root.position.z-pcz;lcSignals(v,dt,dx*dx+dz*dz<sr2)}
  updateTrafficLighting();
}
// =====================================================================================================================
// >>> POLICE ESCAPE MODE ===========================================================================================
// A police Lancer (same FBX model and the SAME vehicle physics as the player's car) chases the player.
//  * "skill" grows with the chase time (1-exp(-t/rampT)): top speed, look-ahead, braking nerve and agility all rise with it, so the
//    first minute is fair and the chase keeps getting harder;
//  * it aims at the player's (predicted) lateral position; its top speed is capped (vStart -> vEnd) and only a rubber-band (when it is
//    far behind) lifts that cap, so a good player can pull away but never for good;
//  * the planner predicts, in TIME, where every car ahead will be (closing speed, lane changes, signalling cars) and weaves through
//    the gaps; it brakes only as hard as the physics allows (reaction time + braking distance) and before the bridge divider appears
//    it already moves to the player's side of the road;
//  * any contact between the two cars ends the run ("busted").
// Everything is tuned in POLC. Pick the mode in the setup menu ("نمط اللعب").
const POLC={
  startGap:60,holdTime:3.2,                      // metres behind the player at the start / seconds the police waits before it moves
  vStart:150/3.6,vEnd:245/3.6,rampT:90,           // top speed: 150 km/h at the start -> 245 km/h (time constant rampT seconds); a good player can out-run it
  rubberFrom:80,rubberK:.2,rubberMax:30,          // gap (m) from which the rubber-band lifts the top speed, per metre, and its maximum (m/s)
  boostDist:100,boostAfter:8,boostV:20,           // more than 100 m away for more than 8 s -> a clear speed boost (+20 m/s) until it is back under 100 m, then normal again
  spdMid:1.2,spdFar:1.15,midFrom:30,farFrom:100,  // speed multiplier: x1.20 at 30-100 m behind the player, x1.15 at more than 100 m (on top of everything else)
  maxGap:150,                                     // HARD LIMIT: the police car is never further than this many metres from the player (centre to centre)
  catchK:.3,ramBias:3,catchMax:30,                // wanted speed = player + clamp(gap*catchK + ramBias, ramBias, catchMax)
  powerK:1.2,dragK:.8,                            // engine power / drag compared with the player's car (1 = identical)
  latRate:5,xMin:2.1,xMax:18.3,clear:2.5,        // max sideways speed of the target line (at full skill), drivable width, lateral clearance to traffic
  latEff:3.4,latLag:.35,ffK:.6,stick:1.6,         // what the car really manages sideways (m/s, s of lag), feed-forward share of the steering (less = less overshoot), cost of changing the planned line
  lookT0:2.0,lookT1:3.3,mLong:.9,wLine:1.1,wLoss:2.6, // planner: look-ahead time (s) at the start / at full skill, longitudinal margin (m), cost of lane offset / of lost speed
  brakeLo:6.5,brakeHi:10,reactHi:.5,reactLo:.2,gapMin:4, // planned braking (m/s^2) at the start / at full skill, reaction time (s) at the start / full skill, bumper gap it keeps to a car ahead (m)
  wallSoon:35,                                    // extra cost of being on the other side of the player before the bridge divider appears
  errRate:0,errMin:.7,errMax:1.4,               // lapses per second (only matter when a car is in the way) and their length in seconds (0 = it never errs)
  respawnGap:330,respawnTo:130,bustDelay:.8,      // too far behind -> reinforcements appear 140 m behind / slow-motion time before the busted panel
  quietT:1.5                                      // seconds a car struck by the police stays "quiet" (its own knock-on hits make no crash sound either)
};
const POL={mode:'free',on:false,over:false,overT:0,shown:false,car:null,failed:false,t:0,hold:0,errT:0,ign:null,vlat:0,prevPX:null,
  farT:0,stuckT:0,gap:999,obs:[],cand:[],px:null,farBoostT:0,boost:0,mult:1,skill:0,vTop:0,ft:0,errCount:0,U:null,lastTxt:'',lastDanger:false,flashPh:-1,bannerT:0};
const polFmtT=s=>{s=Math.max(0,Math.floor(s));return Math.floor(s/60)+':'+String(s%60).padStart(2,'0')};

// ---- look of the car: black body, white doors, "POLICE / شرطة" on the doors, roof light bar ----
const polDecalT=cv(1024,280,(g,w,h)=>{
  g.clearRect(0,0,w,h);
  g.fillStyle='#1747b5';g.fillRect(0,h-64,w,26);g.fillStyle='#d3202a';g.fillRect(0,h-32,w,10);
  g.fillStyle='#1747b5';g.textBaseline='middle';
  g.textAlign='left';g.font='bold 138px Arial,Helvetica,sans-serif';g.fillText('POLICE',20,100);
  g.textAlign='right';g.font='bold 150px Tahoma,Arial,sans-serif';g.fillText('شرطة',w-22,98);
});
polDecalT.generateMipmaps=false;polDecalT.minFilter=THREE.LinearFilter;polDecalT.magFilter=THREE.LinearFilter;
const polGlowT=cv(64,64,(g,w,h)=>{const r=g.createRadialGradient(32,32,0,32,32,32);r.addColorStop(0,'rgba(255,255,255,1)');r.addColorStop(.25,'rgba(255,255,255,.55)');r.addColorStop(1,'rgba(255,255,255,0)');g.fillStyle=r;g.fillRect(0,0,w,h)});
const POLV={
  blueOn:new THREE.MeshBasicMaterial({color:0x5a8dff}),blueOff:new THREE.MeshBasicMaterial({color:0x0b1a44}),
  redOn:new THREE.MeshBasicMaterial({color:0xff3b30}),redOff:new THREE.MeshBasicMaterial({color:0x3d0907}),
  bar:new THREE.MeshLambertMaterial({color:0x15171b}),
  sprB:new THREE.SpriteMaterial({map:polGlowT,color:0x3d7bff,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}),
  sprR:new THREE.SpriteMaterial({map:polGlowT,color:0xff3322,transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,fog:false}),
  pool:new THREE.MeshBasicMaterial({map:polGlowT,color:0x2f66ff,transparent:true,opacity:.3,blending:THREE.AdditiveBlending,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}),
  head:new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:0,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}),
  tail:new THREE.MeshBasicMaterial({color:0xff1414,transparent:true,opacity:.45,blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2})
};
// Livery in "car space": the body-paint shader asks where on the car every pixel is (via the inverse of the car's world matrix),
// so the two-tone paint and the door lettering stay glued to the car however it moves.
function policeLivery(m,U){
  m.onBeforeCompile=sh=>{
    sh.uniforms.uPInv=U.inv;sh.uniforms.uDecal=U.decal;
    sh.vertexShader=sh.vertexShader
      .replace('void main() {','uniform mat4 uPInv;varying vec3 vRP;\nvoid main() {')
      .replace('#include <begin_vertex>','#include <begin_vertex>\nvRP=(uPInv*modelMatrix*vec4(transformed,1.0)).xyz;');
    sh.fragmentShader=sh.fragmentShader
      .replace('void main() {','uniform sampler2D uDecal;varying vec3 vRP;\nvoid main() {')
      .replace('#include <color_fragment>',`#include <color_fragment>
      {
        vec3 pp=vRP;
        float door=step(-0.98,pp.z)*step(pp.z,0.84)*step(0.30,pp.y)*step(pp.y,1.12)*step(0.52,abs(pp.x));
        vec3 col=mix(vec3(0.035,0.04,0.05),vec3(0.93,0.95,0.97),door);
        float su=(pp.x>0.0)?-(pp.z+0.05):(pp.z+0.05);
        vec2 duv=vec2(su/1.5+0.5,(pp.y-0.46)/0.40);
        vec4 dt=texture2D(uDecal,clamp(duv,0.0,1.0));
        float inside=step(0.0,duv.x)*step(duv.x,1.0)*step(0.0,duv.y)*step(duv.y,1.0)*door;
        diffuseColor.rgb=mix(col,dt.rgb,dt.a*inside);
      }`);
  };
  m.customProgramCacheKey=()=>'policeLivery1';
}
// Head / tail lamp glow: the same triangles the player's Lancer uses, but with the police car's own (independent) materials.
function policeLampGlow(obj){
  try{
    const g=obj.geometry,pos=g.attributes.position,idx=g.index;g.computeBoundingBox();
    const zMin=g.boundingBox.min.z,zMax=g.boundingBox.max.z,tri=idx?idx.count/3:pos.count/3,rear=[],front=[];
    for(let t=0;t<tri;t++){
      const a=idx?idx.getX(t*3):t*3,b=idx?idx.getX(t*3+1):t*3+1,c=idx?idx.getX(t*3+2):t*3+2;
      const cz=(pos.getZ(a)+pos.getZ(b)+pos.getZ(c))/3,cy=(pos.getY(a)+pos.getY(b)+pos.getY(c))/3;
      const dst=cz<zMin+.23?rear:(cz>zMax-.4&&cy>.35?front:null);
      if(dst)for(const i of [a,b,c])dst.push(pos.getX(i),pos.getY(i),pos.getZ(i));
    }
    for(const [arr,mat] of [[rear,POLV.tail],[front,POLV.head]]){
      if(!arr.length)continue;
      const bg=new THREE.BufferGeometry();bg.setAttribute('position',new THREE.Float32BufferAttribute(arr,3));
      const m=new THREE.Mesh(bg,mat);m.renderOrder=10;m.frustumCulled=false;m.userData.noDent=true;obj.add(m);
    }
  }catch(e){console.warn('police lamp glow failed',e)}
}
function policeBuildCar(){
  if(POL.car)return POL.car;
  if(typeof EMBEDDED_CAR_FBX_GZIP_Z85==='undefined'||typeof THREE.FBXLoader!=='function'||typeof fflate==='undefined')throw new Error('Lancer data for the police car is unavailable');
  const bytes=csUnpack(fflate.gunzipSync(z85Decode(EMBEDDED_CAR_FBX_GZIP_Z85,EMBEDDED_CAR_FBX_GZIP_BYTES)));
  const model=new THREE.FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
  // ---- same orientation / size / origin as the player's Lancer (front = -Z, centred, wheels on y = 0) ----
  model.updateMatrixWorld(true);
  let bnd=new THREE.Box3().setFromObject(model),sz=bnd.getSize(new THREE.Vector3());
  const dims=[sz.x,sz.y,sz.z];
  if(dims.indexOf(Math.max(...dims))===0)model.rotation.y=Math.PI/2;
  model.rotation.y+=Math.PI;
  model.updateMatrixWorld(true);
  bnd=new THREE.Box3().setFromObject(model);sz=bnd.getSize(new THREE.Vector3());
  model.scale.setScalar(4.57/Math.max(Math.max(sz.x,sz.z),.001));
  model.updateMatrixWorld(true);
  bnd=new THREE.Box3().setFromObject(model);
  const ctr=bnd.getCenter(new THREE.Vector3());
  model.position.x-=ctr.x;model.position.z-=ctr.z;model.position.y-=bnd.min.y;
  const U=POL.U=POL.U||{inv:{value:new THREE.Matrix4()},decal:{value:polDecalT}};
  const meshes=[];model.traverse(o=>{if(o.isMesh)meshes.push(o)});
  let paintCount=0;
  for(const o of meshes){
    o.castShadow=false;o.receiveShadow=true;
    const mats=Array.isArray(o.material)?o.material:[o.material];
    const sig=[o.name||'',...mats.map(m=>m&&m.name||'')].join(' ');
    const isPaint=/PaintTNR|Kit0_Paint|Hood0a_Paint|Wing0a_Paint/i.test(sig)&&!/Window|Glass|Light|Wheel|Interior|Carbon|Grille|Badge/i.test(sig);
    for(const m of mats){
      if(!m)continue;
      m.side=THREE.DoubleSide;
      if(isPaint&&m.color){policeLivery(m,U);paintCount++}
      m.needsUpdate=true;
    }
  }
  console.info('Police car: livery applied to',paintCount,'paint materials');
  const root=new THREE.Group();root.name='PoliceCar';root.rotation.order='YXZ';
  root.add(model);root.updateMatrixWorld(true);
  // ---- wheel rig (same idea as the player's car): steer pivot -> spin pivot ----
  const wheels=[],wn=[];
  model.traverse(o=>{if(/3DWheel[\s_]*(Front|Rear)/i.test(o.name||''))wn.push(o)});
  for(const n of wn){
    const box=new THREE.Box3();
    for(const c of n.children)box.expandByObject(c);
    if(box.isEmpty())box.setFromObject(n);
    const c0=root.worldToLocal(box.getCenter(new THREE.Vector3()));
    const steer=new THREE.Group(),spin=new THREE.Group();
    steer.position.copy(c0);root.add(steer);steer.add(spin);root.updateMatrixWorld(true);
    spin.attach(n);steer.userData.isTrafficWheelPivot=true;
    wheels.push({steer,spin,front:/Front/i.test(n.name||'')});
  }
  root.updateMatrixWorld(true);
  // ---- hit box: real footprint of the body (wheels / cabin excluded, exactly like the player's) ----
  const skip=o=>{for(let p=o;p&&p!==root;p=p.parent)if(p.userData&&p.userData.isTrafficWheelPivot)return true;return /Interior|Seat|Belt|Steer|Dash|Cabin/i.test(o.name||'')};
  const hull=collectFootprint(root,skip)||defaultHull(4.55,1.85);
  // ---- roof: find the roof height / position with a few rays so the light bar sits right on it ----
  let roofY=1.46,roofZ=.05;
  try{
    const rc=new THREE.Raycaster(),dn=new THREE.Vector3(0,-1,0),org=new THREE.Vector3(),hits=[];
    for(let z=-.6;z<=.61;z+=.1){org.set(0,3,z);rc.set(org,dn);rc.far=5;const h=rc.intersectObject(root,true);if(h.length)hits.push([z,h[0].point.y])}
    if(hits.length>3){
      const ys=hits.map(h=>h[1]).sort((a,b)=>a-b);roofY=ys[Math.floor(ys.length/2)];
      const flat=hits.filter(h=>Math.abs(h[1]-roofY)<.05);if(flat.length)roofZ=flat.reduce((s,h)=>s+h[0],0)/flat.length;
    }
  }catch(e){console.warn('police roof probe failed',e)}
  // ---- lamp glow, light bar, flashing light pool ----
  for(const o of meshes)if(/Kit0_Light/i.test(o.name||''))policeLampGlow(o);
  const mk=(w,h,d,x,y,z,mat)=>{const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),mat);m.position.set(x,y,z);m.userData.noDent=true;m.castShadow=false;root.add(m);return m};
  const by=roofY+.03,ly=roofY+.098;
  mk(1.16,.06,.31,0,by,roofZ,POLV.bar);
  mk(.05,.12,.31,-.58,roofY+.06,roofZ,POLV.bar);mk(.05,.12,.31,.58,roofY+.06,roofZ,POLV.bar);
  const lensL=mk(.52,.085,.27,-.29,ly,roofZ,POLV.blueOff),lensR=mk(.52,.085,.27,.29,ly,roofZ,POLV.redOff);
  const glowL=new THREE.Sprite(POLV.sprB),glowR=new THREE.Sprite(POLV.sprR);
  glowL.position.set(-.29,ly+.04,roofZ);glowR.position.set(.29,ly+.04,roofZ);
  for(const s of [glowL,glowR]){s.scale.set(1.6,1.6,1);s.visible=false;s.frustumCulled=false;root.add(s)}
  const pool=new THREE.Mesh(new THREE.PlaneGeometry(9,9).rotateX(-Math.PI/2),POLV.pool);
  pool.position.y=.06;pool.visible=false;pool.userData.noDent=true;pool.frustumCulled=false;root.add(pool);
  root.visible=false;scene.add(root);
  const v={root,wheels,hull,mass:P.m,template:{id:'police'},isPolice:true,
    cw:0,hitTimer:0,fxT:0,dentList:null,lane:10.17,x:10.17,z:0,direction:-1,h:0,wx:0,wz:0,speed:0,targetSpeed:0,steer:0,yawRate:0,slide:0,gear:0,rpm:900,
    throttle:0,brake:0,shiftTimer:0,accel:0,pitch:0,roll:0,frontSteer:0,lcState:2,laneRate:0,latGain:.1,latLim:.2,powerK:POLC.powerK,dragK:POLC.dragK,
    vis:{lensL,lensR,glowL,glowR,pool}};
  POL.car=v;
  console.info('Police car ready: hitbox',(hull.hw*2).toFixed(2)+' x '+(hull.hl*2).toFixed(2)+' m, roof y',roofY.toFixed(2));
  return v;
}

// ---- spawn / reset -------------------------------------------------------------------------------------------------
function policeSpawn(pr,gap,speed){
  const v=POL.car;
  const lanes=TRAFFIC_FRONT_LANES.slice().sort((a,b)=>Math.abs(a-pr.x)-Math.abs(b-pr.x));
  let z=pr.z+gap,ln=lanes[0],found=false;
  for(let k=0;k<16&&!found;k++){
    for(const l of lanes){
      if(bridgeWallBetween(pr.x,l,z))continue;
      let ok=true;
      for(const o of trafficCars){if(o.direction!==-1)continue;if(Math.abs(o.z-z)<18&&Math.abs(o.x-l)<2.7){ok=false;break}}
      if(ok){ln=l;found=true;break}
    }
    if(!found&&z+14<pr.z+POLC.maxGap-5)z+=14;   // looks for a free spot further back, but never beyond the max distance
  }
  v.direction=-1;v.lane=v.x=ln;v.z=z;v.h=0;v.speed=speed;v.wx=0;v.wz=-speed;
  const wr=g=>speed/P.R*P.ratios[g]*P.fd*9.5493;let g=0;while(g<5&&wr(g)>3800)g++;
  v.gear=g;v.rpm=Math.max(900,Math.min(7000,wr(g)));
  v.steer=0;v.yawRate=0;v.slide=0;v.cw=0;v.hitTimer=0;v.fxT=0;v.throttle=0;v.brake=0;v.shiftTimer=0;v.accel=0;v.pitch=0;v.roll=0;v.frontSteer=0;v.laneRate=0;v.lcState=2;
  repairTrafficCar(v);
  for(const w of v.wheels){w.spin.rotation.x=0;w.steer.rotation.y=0}
  POL.vlat=0;POL.prevPX=null;POL.px=null;POL.errT=0;POL.ign=null;POL.farT=POL.stuckT=0;
  policeTransform(v,0);
}
function policeBegin(){
  POL.over=false;POL.shown=false;POL.overT=0;POL.t=0;POL.ft=0;POL.skill=0;POL.farBoostT=0;POL.boost=0;POL.boostOn=false;POL.mult=1;
  if(POL.mode!=='police'){policeEnd();return}
  try{policeBuildCar()}catch(e){
    console.error('Police mode unavailable:',e);POL.failed=true;POL.on=false;
    policeBanner('تعذر تحميل سيارة الشرطة؛ تعمل اللعبة بالقيادة الحرة','',3200);return;
  }
  POL.on=true;POL.hold=POLC.holdTime;POL.errCount=0;
  policeSpawn(playerRoadCoords(),POLC.startGap,0);
  POL.car.root.visible=true;
  try{policeSirenInit()}catch(e){}
  policeHudShow(true);
  try{renderer.compile(scene,camera)}catch(e){}
  policeBanner('🚨 الشرطة تطاردك — اهرب!','',2800);
}
function policeEnd(){
  POL.on=false;POL.over=false;POL.shown=false;
  if(POL.car)POL.car.root.visible=false;
  policeHudShow(false);policeSirenSet(0);
}

// ---- AI --------------------------------------------------------------------------------------------------------------
function polWallOn(z){for(const o of [30,0,-40,-80,-120,-160])if(bridgeElev(z+o)>=BR_WALL_E*.5)return true;return false}
// the divider is about to appear (200-440 m ahead, i.e. before bridgeWallBetween starts to forbid crossing)
function polWallSoon(z){for(const o of [-200,-260,-320,-380,-440])if(bridgeElev(z+o)>=BR_WALL_E*.5)return true;return false}
// highest speed DIFFERENCE (m/s) at which the police car can still stop gapMin metres behind a car whose bumper is g metres ahead
// (reaction distance + braking distance at the planned deceleration bk)
function polSafeDv(g,bk,tr){const e=Math.max(0,g-POLC.gapMin);return bk*(-tr+Math.sqrt(tr*tr+2*e/bk))}
// Picks the lateral line to drive: close to where the player is going, but free of traffic.
// Every line is checked in TIME: where each car ahead will be while the police car moves over to that line (closing speed, lane changes);
// a line also costs the speed that following a slower car in it would take away.
// Returns {x: line to follow, cap: highest speed that is still safe behind whatever blocks that line}.
function policePlan(v,pr,ps,want){
  const sk=POL.skill,lapse=POL.errT>0,sp=Math.max(v.speed,6);
  const lookT=(POLC.lookT0+(POLC.lookT1-POLC.lookT0)*sk)*(lapse?.55:1),look=16+sp*lookT,dist=v.z-pr.z;
  const lr=POLC.latRate*(.82+.18*sk);
  const bk=POLC.brakeLo+(POLC.brakeHi-POLC.brakeLo)*sk,tr=POLC.reactHi+(POLC.reactLo-POLC.reactHi)*sk;
  const R=LC.carLen+POLC.mLong; // centre distance under which two cars overlap lengthways (with margin)
  // where the player is going: his lane + his sideways drift for the time the police car needs to reach him
  const xt=clampTraffic(pr.x+POL.vlat*clampTraffic(dist/Math.max(sp,12),0,1.2)*(.6+.4*sk),POLC.xMin,POLC.xMax);
  const obs=POL.obs;obs.length=0;
  for(const o of trafficCars){
    if(o.direction!==v.direction)continue;
    const dz=v.z-o.z;if(dz<-R||dz>look+LC.carLen+14)continue;
    obs.push(o);
  }
  const cand=POL.cand;cand.length=0;
  for(let x=POLC.xMin;x<=POLC.xMax+.01;x+=.9)cand.push(x);
  cand.push(xt,v.lane);if(POL.px!==null)cand.push(POL.px);
  const wall=polWallOn(v.z),soon=!wall&&polWallSoon(v.z),sideT=xt<BR_MID,ign=lapse?POL.ign:null;
  let best=null;
  for(const xc of cand){
    if(xc<POLC.xMin-.01||xc>POLC.xMax+.01)continue;
    if(bridgeWallBetween(v.x,xc,v.z))continue;
    if(wall&&Math.abs(xc-BR_MID)<1.4)continue;
    const dxc=xc-v.x,adx=Math.abs(dxc),Tl=adx>.25?adx/POLC.latEff+POLC.latLag:0,clr=POLC.clear+.3*Math.min(1,adx/3.67); // time to get onto that line (the real car is slower than its target line) and the overshoot it needs room for
    let tHit=Infinity,hitO=null,hitCap=1e9,capL=1e9,leadO=null;
    for(const o of obs){
      if(o===ign)continue;
      const d=v.z-o.z,dv=v.speed-o.speed,ch=o.lcState>0,lat=o.laneTo;
      // 1) the time window in which that car overlaps the police car lengthways, and where the police car is sideways in it
      let t0,t1;
      if(d>R){if(dv<=.3)t0=t1=Infinity;else{t0=(d-R)/dv;t1=(d+R)/dv}}
      else{t0=0;t1=dv>.3?(d+R)/dv:(dv<-.3?(R-d)/-dv:3)}
      if(t0<lookT*1.35){
        let hit=false;
        for(let k=0;k<3&&!hit;k++){
          const t=t0+(Math.min(t1,t0+2)-t0)*(k/2),xs=Tl>0?v.x+dxc*Math.min(1,t/Tl):xc;
          hit=Math.abs(xs-o.x)<clr||(ch&&Math.abs(xs-lat)<clr); // a car that signals / changes lane is checked at both lines
        }
        if(hit&&t0<tHit){tHit=t0;hitO=o;hitCap=d>R?o.speed+polSafeDv(d-LC.carLen,bk,tr):1e9}
      }
      // 2) a car in the line it will end up in: it must not drive faster than that car lets it
      if(d>0&&(Math.abs(xc-o.x)<POLC.clear||(ch&&Math.abs(xc-lat)<POLC.clear))){
        const cs=o.speed+polSafeDv(d-LC.carLen,bk,tr);
        if(cs<capL){capL=cs;leadO=o}
      }
    }
    let c=Math.abs(xc-xt)*POLC.wLine+Math.abs(xc-v.lane)*.4+((xc<2.8||xc>17.6)?1.5:0);
    if(POL.px!==null)c+=Math.abs(xc-POL.px)*POLC.stick*(.4+.6*Math.min(1,adx/1.5)); // keep the line it has already started on (no dithering between two gaps)
    if(soon&&(xc<BR_MID)!==sideT)c+=POLC.wallSoon;
    if(tHit<Infinity){const th=Math.min(tHit,lookT);c+=(1-th/lookT)*140+(tHit<lookT*.5?70:0)+(tHit<.55?260+adx*18:0)} // if it is that tight: no sweeping across cars alongside, hold the lane and brake
    const cp=Math.min(capL,tHit<lookT?hitCap:1e9);
    if(cp<want)c+=(want-cp)*POLC.wLoss;
    if(!best||c<best.c)best={x:xc,c,tHit,cap:cp,blk:hitO||leadO};
  }
  if(!best){POL.px=null;return{x:v.lane,cap:1e9}}
  let cap=best.cap;
  if(best.blk){
    if(best.tHit<.4)cap=Math.min(cap,Math.max(0,best.blk.speed-4)); // about to touch it: shed speed now
    if(lapse&&!POL.ign&&best.tHit<lookT)POL.ign=best.blk;             // a lapse: from now on it simply does not "see" this car
  }
  POL.px=best.x;
  return{x:best.x,cap};
}
function policeStep(dt,ps,pr){
  const v=POL.car;
  POL.t+=dt;
  const sk=POL.skill=1-Math.exp(-POL.t/POLC.rampT); // 0 at the start of the chase -> 1: faster, looks further ahead, brakes later, steers sharper
  if(POL.prevPX!==null)POL.vlat+=(clampTraffic((pr.x-POL.prevPX)/Math.max(dt,1e-3),-12,12)-POL.vlat)*Math.min(1,dt*5);
  POL.prevPX=pr.x;
  const bg=v.z-pr.z-LC.carLen;POL.gap=bg; // bumper gap: > 0 police behind the player
  // 1) how fast does it want to go
  let want=0;
  if(POL.over)want=0;
  else if(POL.hold>0){POL.hold-=dt;want=0}
  else{
    // top speed: grows with the chase time; the rubber-band lifts it only when the player has really got away
    // far-away boost: switches on after boostAfter s beyond boostDist, off again as soon as it is closer than boostDist (eased in / out over ~1 s)
    if(bg+LC.carLen>POLC.boostDist){if(POL.farBoostT<POLC.boostAfter)POL.farBoostT+=dt;if(POL.farBoostT>=POLC.boostAfter)POL.boostOn=true}
    else{POL.farBoostT=0;POL.boostOn=false}
    POL.boost+=((POL.boostOn?1:0)-POL.boost)*Math.min(1,dt*3);
    const bv=POLC.boostV*POL.boost;
    const dB=bg+LC.carLen,mt=dB>POLC.farFrom?POLC.spdFar:(dB>POLC.midFrom?POLC.spdMid:1);
    POL.mult+=(mt-POL.mult)*Math.min(1,dt*3);const mu=POL.mult;
    const vTop=POL.vTop=mu*(bv+POLC.vStart+(POLC.vEnd-POLC.vStart)*sk+clampTraffic((bg-POLC.rubberFrom)*POLC.rubberK,0,POLC.rubberMax));
    if(bg>=-4){
      want=mu*(ps+bv+clampTraffic(bg*POLC.catchK+POLC.ramBias,POLC.ramBias,POLC.catchMax)); // closes in faster the further behind it is
      if(ps<10)want=Math.max(want,Math.min(20,bg*.5+3));                              // a (nearly) stopped player is approached quickly
    }else want=Math.max(0,ps-1);   // it is AHEAD of the player (he braked / it overshot): no brake-check, it just does not run away, he can pass and the chase goes on
    want=Math.min(want,vTop);
  }
  // 2) the small error rate: a short lapse in which it ignores one car in its way and looks less far ahead
  if(POL.errT>0){POL.errT-=dt;if(POL.errT<=0)POL.ign=null}
  else if(!POL.over&&POL.hold<=0&&Math.random()<POLC.errRate*dt){POL.errT=rnd(POLC.errMin,POLC.errMax);POL.ign=null}
  // 3) path through the traffic
  const plan=policePlan(v,pr,ps,want);
  if(POL.hold<=0){
    // the target line glides to the planned line (fast, then ever slower: no sudden stop of the steering command = less overshoot)
    const lr=POLC.latRate*(.82+.18*sk),dx=plan.x-v.lane,rate=Math.min(lr,Math.abs(dx)*2),st2=Math.sign(dx)*Math.min(Math.abs(dx),rate*dt);
    v.lane=clampTraffic(v.lane+st2,v.x-1.6,v.x+1.6);v.laneRate=POLC.ffK*st2/Math.max(dt,1e-3); // the target line never runs more than 1.6 m ahead of the car
  }else v.laneRate=0;
  want=Math.min(want,plan.cap);
  // 4) crash recovery: hit cars slow down, a spun car straightens up before it goes on
  if(v.hitTimer>0)want=Math.min(want,POL.over?0:Math.max(10,ps*.55));
  const hd=_wrapAng(v.h);
  if(Math.abs(hd)>.9)want=0;
  // 5) drive with the shared vehicle physics
  v.latLim=clampTraffic(7/Math.max(v.speed,10),.09,.28);
  v.latGain=clampTraffic(1.8/Math.max(v.speed,10),.02,.1); // lower steering gain at speed: the car no longer swings past its line
  updateTrafficVehiclePhysics(v,dt,Math.max(0,want));
  keepTrafficOnRoad(v);
  if(v.hitTimer>0)v.hitTimer-=dt;
  else if(v.speed<2.5){
    const dl=_wrapAng(v.h);if(Math.abs(dl)>.01)v.h-=Math.max(-.6*dt,Math.min(.6*dt,dl));
  }
  // 6) reinforcements: far behind / far ahead / wrecked for too long -> a new police car appears 140 m behind the player
  if(!POL.over&&POL.hold<=0){
    if(bg>POLC.respawnGap||bg<-120)POL.farT+=dt;else POL.farT=0;
    if(v.speed<2&&bg>6)POL.stuckT+=dt;else POL.stuckT=0;
    if(v.z-pr.z>POLC.maxGap){policeSpawn(pr,POLC.respawnTo,Math.max(ps*.95,20));POL.farT=0}   // over the limit: it reappears 130 m behind at once
    else if(POL.farT>2.5||POL.stuckT>6)policeSpawn(pr,POLC.respawnTo,Math.max(ps*.9,20));
  }
}
function policeBust(){
  if(POL.over||!POL.on)return;
  POL.over=true;POL.overT=0;
  try{UISND.play('danger')}catch(e){}
  policeBanner('🚔 تم القبض عليك!','busted',2600);
}

// ---- visuals every frame: transform, flashing lights, headlamps ----------------------------------------------------
function policeTransform(v,dt){
  const yaw=roadYawAt(v.z),yawAhead=roadYawAt(v.z+v.direction*5);
  let dyaw=yawAhead-yaw;dyaw=Math.atan2(Math.sin(dyaw),Math.cos(dyaw));
  const curv=dyaw/5;
  v.roll+=(clampTraffic(-v.speed*v.speed*curv*.0035,-.045,.045)-v.roll)*Math.min(1,dt*5);
  const lock=.5/(1+(v.speed/40)*(v.speed/40))+.18;
  v.frontSteer=clampTraffic(Math.atan(2.55*curv)+v.steer*lock,-.55,.55);
  v.root.position.copy(trackToWorld(v.x,0,v.z,_trafficPosition));
  v.root.rotation.set(v.pitch-Math.atan(bridgeSlopeAt(v.x,v.z)),yaw+v.h,v.roll);
  for(const w of v.wheels){if(w.front)w.steer.rotation.y=v.frontSteer;w.spin.rotation.x-=v.speed*dt/P.R}
}
function policeVisual(v,dt){
  v.root.updateMatrixWorld(true);
  POL.U.inv.value.copy(v.root.matrixWorld).invert();
  POL.ft+=dt;
  const ph=(POL.ft%.8)/.8,Lb=ph<.1||(ph>.16&&ph<.26),Rd=(ph>.5&&ph<.6)||(ph>.66&&ph<.76),V=v.vis;
  V.lensL.material=Lb?POLV.blueOn:POLV.blueOff;V.lensR.material=Rd?POLV.redOn:POLV.redOff;
  V.glowL.visible=Lb;V.glowR.visible=Rd;
  const gs=isNight?2.7:1.5;V.glowL.scale.set(gs,gs,1);V.glowR.scale.set(gs,gs,1);
  V.pool.visible=Lb||Rd;POLV.pool.color.set(Lb?0x2f66ff:0xff2a20);POLV.pool.opacity=isNight?.55:.14;
  POLV.head.opacity=isNight?1:0;
  POLV.tail.opacity=(v.brake>.25)?1:(isNight?.6:.45);
}

// ---- HUD, warning flash, banner, siren -------------------------------------------------------------------------------
document.body.insertAdjacentHTML('beforeend','<div id="policeHud" aria-live="off"><span class="ph-txt" id="phTxt">🚔</span><div class="ph-bar"><i id="phBar"></i></div></div><div id="policeFlash"></div><div id="policeBanner"></div>');
const polHudEl=document.getElementById('policeHud'),polTxtEl=document.getElementById('phTxt'),polBarEl=document.getElementById('phBar'),polFlashEl=document.getElementById('policeFlash'),polBannerEl=document.getElementById('policeBanner');
function policeHudShow(on){polHudEl.classList.toggle('on',!!on);polFlashEl.classList.toggle('on',!!on);if(!on){polFlashEl.style.boxShadow='none';polHudEl.classList.remove('danger');POL.lastTxt='';POL.flashPh=-1}}
function policeBanner(text,cls,ms){
  polBannerEl.textContent=text;polBannerEl.className=(cls||'')+' show';
  clearTimeout(POL.bannerT);POL.bannerT=setTimeout(()=>{polBannerEl.classList.remove('show')},ms||2400);
}
function policeHud(v,dt){
  if(POL.over){policeHudShow(false);return}
  const bg=POL.gap;
  let txt;
  if(POL.hold>0)txt='🚔 الشرطة تستعد…  '+Math.ceil(POL.hold);
  else txt='🚔 '+(bg>=1?Math.round(bg)+' م':(bg>-4?'ملاصقة لك!':'الشرطة بجانبك'))+'   ⏱ '+polFmtT(POL.t);
  if(txt!==POL.lastTxt){POL.lastTxt=txt;polTxtEl.textContent=txt}
  const near=POL.hold>0?0:clampTraffic(1-bg/150,0,1);
  {const w=(near*100).toFixed(0)+'%';if(w!==POL.lastBar){POL.lastBar=w;polBarEl.style.width=w}}
  const danger=POL.hold<=0&&bg<30;
  if(danger!==POL.lastDanger){POL.lastDanger=danger;polHudEl.classList.toggle('danger',danger)}
  // red / blue screen-edge flashing when the police is close
  const k=POL.hold>0?0:clampTraffic((45-bg)/45,0,1),ph=Math.floor(POL.ft*4)%2;
  if(ph!==POL.flashPh||k===0){
    POL.flashPh=ph;
    polFlashEl.style.boxShadow=k>0.02?('inset 0 0 '+(90+90*k).toFixed(0)+'px '+(10+26*k).toFixed(0)+'px '+(ph?'rgba(255,40,30,':'rgba(50,110,255,')+(.12+.5*k).toFixed(2)+')'):'none';
  }
}
const POLS={g:null};
function policeSirenInit(){
  if(!ac)return false;
  if(POLS.g)return true;
  try{
    const o=ac.createOscillator(),lfo=ac.createOscillator(),lg=ac.createGain(),f=ac.createBiquadFilter(),g=ac.createGain();
    o.type='sawtooth';o.frequency.value=950;lfo.type='sine';lfo.frequency.value=.42;lg.gain.value=330;
    lfo.connect(lg);lg.connect(o.frequency);
    f.type='bandpass';f.frequency.value=1250;f.Q.value=.55;
    g.gain.value=0;o.connect(f);f.connect(g);g.connect(ac.destination);
    o.start();lfo.start();POLS.g=g;return true;
  }catch(e){console.warn('siren init failed',e);return false}
}
function policeSirenSet(vol){if(!POLS.g||!ac)return;try{POLS.g.gain.setTargetAtTime(vol,ac.currentTime,.12)}catch(e){}}
function policeAfter(dt){
  const v=POL.car;
  policeTransform(v,dt);policeVisual(v,dt);policeHud(v,dt);
  if(!POLS.g)policeSirenInit();
  const dist=Math.abs(POL.gap)+4.5;
  policeSirenSet(POL.over||muted?0:engineVolume*.2*Math.pow(clampTraffic(1-dist/260,0,1),1.5));
  if(POL.over){POL.overT+=dt;if(POL.overT>POLC.bustDelay&&!POL.shown)policeShowOver()}
}
function policeErr(e){
  if(!POL.errCount++)console.error('Police update failed:',e);
  if(POL.errCount>40){POL.on=false;if(POL.car)POL.car.root.visible=false;policeHudShow(false);policeSirenSet(0)}
}

// ---- game-over ("busted") panel ------------------------------------------------------------------------------------------
function policeShowOver(){
  POL.shown=true;
  try{drvSave(true)}catch(e){}
  const set=(id,t)=>{const e=document.getElementById(id);if(e)e.textContent=t};
  set('statScoreOver',fmtNum(drvScore));set('statDistOver',fmtDist(drvDist));set('statTimeOver',polFmtT(POL.t));set('statBestOver',fmtNum(drvBest));
  gameMode='over';updateWinterAmbience();
  document.body.classList.remove('game-playing');clearDrivingInput();releaseGamePointer();
  polBannerEl.classList.remove('show');policeSirenSet(0);policeHudShow(false);
  showMenuPanel('over');focusMenuDefault();
}
// "Retry" starts a fresh chase with the same settings; "Main menu" goes back to the start screen.
document.getElementById('overRetryBtn').addEventListener('click',()=>{gameMode='menu';startGame()});
document.getElementById('overMenuBtn').addEventListener('click',returnToMainMenu);

// ---- mode selector in the setup menu ---------------------------------------------------------------------------------------
const POL_HINTS={free:'قيادة حرة: تقدّم على الطريق وتجاوز السيارات واجمع النقاط.',
  police:'الهروب من الشرطة: سيارة لانسر شرطة تلاحقك بسرعة وتتفادى الزحام بذكاء. إن لمستك سيارتها تخسر! اهرب أطول وقت ممكن.'};
function setGameMode(mode,save){
  mode=mode==='police'?'police':'free';POL.mode=mode;
  document.querySelectorAll('#modeGrid .time-option').forEach(b=>{const on=b.dataset.gameMode===mode;b.classList.toggle('active',on);b.setAttribute('aria-checked',on?'true':'false')});
  const h=document.getElementById('modeHint');if(h)h.textContent=POL_HINTS[mode];
  if(save){try{localStorage.setItem('corniche_game_mode',mode)}catch(e){}}
  // build the police car while the menu is idle so the chase starts without a hiccup
  if(mode==='police'&&!POL.car&&!POL.failed)setTimeout(()=>{if(gameMode==='menu'&&!POL.car&&!POL.failed){try{policeBuildCar()}catch(e){console.error('Police prebuild failed:',e);POL.failed=true}}},250);
}
document.querySelectorAll('#modeGrid .time-option').forEach(b=>b.addEventListener('click',()=>setGameMode(b.dataset.gameMode,true)));
{let m='free';try{m=localStorage.getItem('corniche_game_mode')||'free'}catch(e){}setGameMode(m,false)}
// <<< POLICE ESCAPE MODE ===========================================================================================

__loading.set(.4,'جاري تجهيز سيارات المرور...');
loadTrafficModels();

const fpsCounterEl=document.getElementById('fpsCounter');
let fpsFrameCount=0,fpsSampleStart=performance.now(),fpsSmoothed=60;
function updateFPSCounter(now){
  fpsFrameCount++;
  const elapsed=now-fpsSampleStart;
  if(elapsed>=500){
    const measured=fpsFrameCount*1000/elapsed;
    fpsSmoothed=fpsSmoothed*.65+measured*.35;
    if(fpsCounterEl)fpsCounterEl.textContent='FPS: '+Math.round(fpsSmoothed)+(GFX.pr<MAX_PR-.01?' · '+Math.round(GFX.pr/MAX_PR*100)+'%':'');
    fpsFrameCount=0;fpsSampleStart=now;
  }
}
const PERF_FOG_MARGIN=70,PERF_MIRROR_MAX=400,_perfDir=new THREE.Vector3();
// Scratch state shared by every render call: no per-call arrays, closures or [object,visible] pairs (less GC, same behaviour).
// Everything hidden here was visible before, so restoring simply means visible=true.
const _perfHidden=[];let _perfCx=0,_perfCy=0,_perfCz=0,_perfLimSq=0;
function _perfCull(o){const p=o.position,dx=p.x-_perfCx,dy=p.y-_perfCy,dz=p.z-_perfCz;if(o.visible&&!(dx*dx+dy*dy+dz*dz<=_perfLimSq)){_perfHidden.push(o);o.visible=false}}
function renderOptimizedScene(viewCamera,isMirror){
  const hidden=_perfHidden;hidden.length=0;
  const cp=viewCamera.position;_perfCx=cp.x;_perfCy=cp.y;_perfCz=cp.z;
  // Anything beyond the fog's far plane is invisible, so the cut-off follows the fog (day 700 m, night 520 m); mirrors use a shorter range.
  let lim=scene.fog.far+PERF_FOG_MARGIN;if(isMirror&&lim>PERF_MIRROR_MAX)lim=PERF_MIRROR_MAX;
  _perfLimSq=lim*lim;
  // Whole segment groups / car hierarchies are hidden only after they are completely obscured by fog.
  for(let i=0;i<segs.length;i++)_perfCull(segs[i].g);
  for(let i=0;i<trafficCars.length;i++)_perfCull(trafficCars[i].root);
  if(isMirror){
    viewCamera.getWorldDirection(_perfDir);
    if(_perfDir.z>.2){ // mirror looks backwards: clouds, sun, moon and the headlight pool all sit ahead of the car, so skip them
      for(let i=0;i<clouds.length;i++){const c=clouds[i];if(c.visible){hidden.push(c);c.visible=false}}
      if(sunSpr.visible){hidden.push(sunSpr);sunSpr.visible=false}
      if(headPool&&headPool.visible){hidden.push(headPool);headPool.visible=false}
    }
  }
  ROADBATCH.flush();
  syncBuildings(viewCamera);
  updateTrafficLOD(viewCamera,isMirror&&renderer.getRenderTarget()?renderer.getRenderTarget().height:renderer.domElement.height);
  try{if(isMirror||viewCamera!==camera||!window.GFXP||!GFXP.render(viewCamera))renderer.render(scene,viewCamera);}
  finally{for(let i=hidden.length-1;i>=0;i--)hidden[i].visible=true;}
}
// ---- adaptive quality: dynamic resolution + presets (auto / high / medium / low) ----
const QUALITY={
  auto:{auto:true,start:MAX_PR,max:MAX_PR,min:Math.min(MAX_PR,.6),mirrorMin:1,clouds:16},
  high:{auto:false,start:MAX_PR,max:MAX_PR,min:MAX_PR,mirrorMin:1,clouds:16},
  medium:{auto:false,start:Math.min(MAX_PR,1),max:Math.min(MAX_PR,1),min:Math.min(MAX_PR,1),mirrorMin:2,clouds:10},
  low:{auto:false,start:Math.min(MAX_PR,.7),max:Math.min(MAX_PR,.7),min:Math.min(MAX_PR,.7),mirrorMin:3,clouds:5}
};
const GFX={mode:'auto',pr:MAX_PR,auto:true,max:MAX_PR,min:.6,mirrorMin:1};
const AQ={ms:0,n:0,okMs:0,okN:0,pending:null,settleUntil:0,lockUntil:0,lockBackoff:25000,probeAt:0,probeEvery:6000};
let idleRenderAt=0,gaugeHidden=null;
function applyPR(v){v=Math.max(.3,Math.min(GFX.max,v));if(Math.abs(v-GFX.pr)<.005)return false;GFX.pr=v;renderer.setPixelRatio(v);return true}
// Keeps frame time near 16.7 ms by scaling the render resolution (the biggest GPU lever). It steps down when frames are slow,
// probes back up now and then, and gives up (restoring sharpness) when lowering the resolution does not help (CPU-bound / refresh-capped).
function adaptResolution(now,ms){
  if(!GFX.auto)return;
  AQ.n++;AQ.ms+=ms;if(ms<150){AQ.okN++;AQ.okMs+=ms}
  if(AQ.ms<1000)return;
  const avg=AQ.okN*2>=AQ.n?AQ.okMs/AQ.okN:AQ.ms/AQ.n;
  AQ.ms=AQ.n=AQ.okMs=AQ.okN=0;
  if(now<AQ.settleUntil)return;
  const p=AQ.pending;
  if(p){
    AQ.pending=null;
    if(p.dir<0){
      if(avg>p.before*.93&&avg>18){applyPR(p.prev);AQ.lockUntil=now+AQ.lockBackoff;AQ.lockBackoff=Math.min(AQ.lockBackoff*2,300000);AQ.settleUntil=now+800}
      else AQ.lockBackoff=25000;
    }else if(avg>20){applyPR(p.prev);AQ.probeEvery=Math.min(AQ.probeEvery*2,60000);AQ.probeAt=now;AQ.settleUntil=now+800}
    else AQ.probeEvery=Math.max(6000,AQ.probeEvery/2);
    return;
  }
  if(now<AQ.lockUntil)return;
  if(avg>20.5&&GFX.pr>GFX.min+.01){
    const prev=GFX.pr;
    if(applyPR(Math.max(GFX.min,prev*(avg>28?.74:.86)))){AQ.pending={dir:-1,prev,before:avg};AQ.settleUntil=now+700}
  }else if(avg<17.6&&GFX.pr<GFX.max-.01&&now-AQ.probeAt>AQ.probeEvery){
    const prev=GFX.pr;AQ.probeAt=now;
    if(applyPR(Math.min(GFX.max,prev/.86))){AQ.pending={dir:1,prev,before:avg};AQ.settleUntil=now+700}
  }
}
function setQuality(mode,save){
  if(!QUALITY[mode])mode='auto';
  const Q=QUALITY[mode],t=performance.now();
  if(typeof setRainDetail==='function')setRainDetail(mode);
  if(GS.rain!=null&&typeof rainFar!=='undefined'){rainDetail=Math.max(.05,Math.min(1,GS.rain/100));for(const L of [rainFar,rainNear])L.mesh.geometry.setDrawRange(0,Math.floor(L.count*rainDetail)*6)}
  const auto=GS.adaptive!=null?!!GS.adaptive:Q.auto,maxPR=GS.res!=null?Math.max(.3,GS.res/100):Q.max;
  GFX.mode=mode;GFX.auto=auto;GFX.max=maxPR;GFX.min=auto?Math.min(maxPR,.6):maxPR;GFX.mirrorMin=GS.mirror!=null?GS.mirror:Q.mirrorMin;
  AQ.pending=null;AQ.lockUntil=0;AQ.lockBackoff=25000;AQ.probeEvery=6000;AQ.probeAt=t;AQ.settleUntil=t+800;AQ.ms=AQ.n=AQ.okMs=AQ.okN=0;
  applyPR(auto?Math.min(GFX.pr,maxPR):maxPR);
  const nc=GS.clouds!=null?GS.clouds:Q.clouds;
  for(let i=0;i<clouds.length;i++)clouds[i].visible=i<nc;
  const custom=GS.res!=null||GS.adaptive!=null||GS.mirror!=null||GS.clouds!=null||GS.rain!=null;
  document.querySelectorAll('#qualityGrid .time-option').forEach(b=>{const on=b.dataset.quality===mode&&!custom;b.classList.toggle('active',on);b.setAttribute('aria-checked',on?'true':'false')});
  if(save){try{localStorage.setItem('corniche_quality',mode)}catch(e){}}
  if(typeof window.syncGfxUI==='function')window.syncGfxUI();
}
document.querySelectorAll('#qualityGrid .time-option').forEach(b=>b.addEventListener('click',()=>{GS.res=GS.adaptive=GS.mirror=GS.clouds=GS.rain=null;saveGS();setQuality(b.dataset.quality,true)}));
setQuality(_savedQuality,false);
// ===== Settings page: tabs, key / button rebinding, advanced graphics =====
(function(){
  const $=id=>document.getElementById(id);
  const fillRange=r=>r.style.setProperty('--p',((r.value-r.min)/((r.max-r.min)||1)*100)+'%');
  function relayout(){if(typeof fitMenus==='function')fitMenus()}

  // ---------- tabs ----------
  const tabs=[...document.querySelectorAll('[data-st-tab]')],panes=[...document.querySelectorAll('[data-st-pane]')];
  function showTab(n){
    tabs.forEach(t=>{const on=t.dataset.stTab===n;t.classList.toggle('active',on);t.setAttribute('aria-selected',on?'true':'false')});
    panes.forEach(p=>p.classList.toggle('hidden',p.dataset.stPane!==n));
    relayout();requestAnimationFrame(relayout);
  }
  tabs.forEach(t=>t.addEventListener('click',()=>showTab(t.dataset.stTab)));
  // LB / RB (or Q / E style shoulder buttons) are not used here; tabs are plain focusable buttons for the gamepad.

  // ---------- keyboard bindings ----------
  const KEYNAMES={ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',Space:'Space',ShiftLeft:'Shift ‹',ShiftRight:'Shift ›',ControlLeft:'Ctrl ‹',ControlRight:'Ctrl ›',AltLeft:'Alt ‹',AltRight:'Alt ›',Backquote:'`',Minus:'-',Equal:'=',BracketLeft:'[',BracketRight:']',Semicolon:';',Quote:"'",Comma:',',Period:'.',Slash:'/',Backslash:'\\',CapsLock:'Caps',NumpadAdd:'Num +',NumpadSubtract:'Num -',NumpadMultiply:'Num *',NumpadDivide:'Num /',NumpadDecimal:'Num .'};
  const keyName=c=>!c?'—':(KEYNAMES[c]||c.replace(/^Key/,'').replace(/^Digit/,'').replace(/^Numpad/,'Num '));
  const kbList=$('kbBindList'),statusEl=$('bindStatus');
  let CAP=null,statusT=0;
  function say(t){statusEl.textContent=t||'';clearTimeout(statusT);if(t)statusT=setTimeout(()=>{statusEl.textContent=''},6000)}
  const labelOf=id=>(KB_ACTIONS.find(a=>a[0]===id)||[])[1]||id;
  function renderKb(){
    kbList.textContent='';
    for(const [id,label] of KB_ACTIONS){
      const row=document.createElement('div');row.className='bind-row';
      const l=document.createElement('span');l.textContent=label;row.appendChild(l);
      for(let i=0;i<2;i++){
        const b=document.createElement('button');b.type='button';
        const cap=CAP&&CAP.id===id&&CAP.slot===i;
        b.className='bind-key'+(cap?' capturing':'');
        b.textContent=cap?'اضغط مفتاحاً…':keyName(BIND.kb[id][i]);
        b.setAttribute('aria-label',label+(i?' (بديل)':' (أساسي)'));
        b.addEventListener('click',()=>{cancelGpCap();CAP={id,slot:i};say('اضغط المفتاح الجديد لـ «'+label+'» — Esc للإلغاء، Backspace لمسح المفتاح');renderKb()});
        row.appendChild(b);
      }
      kbList.appendChild(row);
    }
    relayout();
  }
  function assignKb(id,slot,code){
    let moved='';
    if(code){
      for(const [oid] of KB_ACTIONS)for(let i=0;i<2;i++){
        if(BIND.kb[oid][i]===code&&!(oid===id&&i===slot)){BIND.kb[oid][i]='';if(oid!==id)moved=labelOf(oid)}
      }
    }
    BIND.kb[id][slot]=code;
    bindRebuild();bindSave();
    if(typeof clearDrivingInput==='function')clearDrivingInput();
    const left=KB_ACTIONS.filter(([a])=>!BIND.kb[a][0]&&!BIND.kb[a][1]).map(a=>a[1]);
    say(moved?'تم نقل المفتاح من «'+moved+'» إلى «'+labelOf(id)+'».':(left.length?'تنبيه: «'+left[0]+'» بدون أي مفتاح الآن.':''));
  }
  addEventListener('keydown',e=>{
    if(!CAP)return;
    e.preventDefault();e.stopImmediatePropagation();
    if(e.repeat)return;
    const c=e.code;
    if(c==='Escape'){CAP=null;say('');renderKb();return}
    if(c==='Backspace'||c==='Delete')assignKb(CAP.id,CAP.slot,'');
    else if(!c||c==='Tab'||c==='Enter'||c==='NumpadEnter'||/^(Meta|OS)/.test(c))return;
    else assignKb(CAP.id,CAP.slot,c);
    CAP=null;renderKb();
  },true);
  $('kbResetBtn').addEventListener('click',()=>{CAP=null;bindDefaultsKb();bindRebuild();bindSave();if(typeof clearDrivingInput==='function')clearDrivingInput();say('تمت استعادة مفاتيح الكيبورد الافتراضية.');renderKb()});

  // ---------- gamepad bindings ----------
  const GPNAMES=['A','B','X','Y','LB','RB','LT','RT','Back','Start','L3','R3','↑','↓','←','→','Home'];
  const gpName=i=>GPNAMES[i]||('زر '+i);
  const gpList=$('gpBindList');
  let gpCapId=null;
  function cancelGpCap(){GPCAP.active=false;GPCAP.cb=null;if(gpCapId){gpCapId=null;renderGp()}}
  function renderGp(){
    gpList.textContent='';
    for(const [id,label] of GB_ACTIONS){
      const row=document.createElement('div');row.className='bind-row';
      const l=document.createElement('span');l.textContent=label;row.appendChild(l);
      const b=document.createElement('button');b.type='button';
      const cap=gpCapId===id;
      b.className='bind-key'+(cap?' capturing':'');
      b.textContent=cap?'اضغط زراً في اليد…':gpName(GB[id]);
      b.addEventListener('click',()=>{
        if(!gamepadConnected){say('وصّل يد التحكم أولاً (اضغط أي زر فيها لتظهر متصلة).');return}
        CAP=null;gpCapId=id;GPCAP.active=true;GPCAP.armed=false;GPCAP.until=performance.now()+8000;
        GPCAP.cb=btn=>{
          GPCAP.active=false;GPCAP.cb=null;const cid=gpCapId;gpCapId=null;
          if(btn>=0&&cid){
            const other=GB_ACTIONS.find(([o])=>o!==cid&&GB[o]===btn);
            if(other)GB[other[0]]=GB[cid];     // swap with the action that used this button
            GB[cid]=btn;bindSave();
            say(other?'تم تبديل الزرين بين «'+label+'» و«'+other[1]+'».':'');
          }
          renderGp();
        };
        renderGp();
      });
      row.appendChild(b);gpList.appendChild(row);
    }
    relayout();
  }
  $('gpResetBtn').addEventListener('click',()=>{cancelGpCap();bindDefaultsGp();bindSave();syncGpOpts();say('تمت استعادة أزرار يد التحكم الافتراضية.');renderGp()});
  const gpDead=$('gpDeadSlider'),gpLook=$('gpLookSlider'),gpInv=$('gpInvertToggle');
  function syncGpOpts(){
    gpDead.value=GO.dead;$('gpDeadValue').textContent=GO.dead+'%';fillRange(gpDead);
    gpLook.value=GO.look;$('gpLookValue').textContent=GO.look+'%';fillRange(gpLook);
    gpInv.checked=!!GO.invertY;
  }
  gpDead.addEventListener('input',()=>{GO.dead=+gpDead.value;$('gpDeadValue').textContent=GO.dead+'%';bindSave()});
  gpLook.addEventListener('input',()=>{GO.look=+gpLook.value;$('gpLookValue').textContent=GO.look+'%';bindSave()});
  gpInv.addEventListener('change',()=>{GO.invertY=gpInv.checked;bindSave()});

  // ---------- graphics ----------
  const loaded={aa:GS.aa,aniso:GS.aniso};
  const dpr=window.devicePixelRatio||1,resMax=Math.min(200,Math.max(150,Math.round(dpr*100)));
  const resS=$('gfxResSlider'),adS=$('gfxAdaptiveToggle'),fovS=$('gfxFovSlider'),cloudS=$('gfxCloudsSlider'),rainS=$('gfxRainSlider'),fpsT=$('gfxFpsToggle');
  resS.max=String(resMax);cloudS.max=String(clouds.length);
  const presetRain=m=>m==='low'?45:m==='medium'?70:100;
  const isCustom=()=>GS.res!=null||GS.adaptive!=null||GS.mirror!=null||GS.clouds!=null||GS.rain!=null;
  function setSeg(id,val){document.querySelectorAll('#'+id+' button').forEach(b=>{const on=b.dataset.v===String(val);b.classList.toggle('active',on);b.setAttribute('aria-checked',on?'true':'false')})}
  function syncGfx(){
    const Q=QUALITY[GFX.mode]||QUALITY.auto;
    const res=GS.res!=null?GS.res:Math.round(Q.max*100);
    resS.value=res;$('gfxResValue').textContent=res+'%';fillRange(resS);
    adS.checked=GS.adaptive!=null?!!GS.adaptive:!!Q.auto;
    const cl=GS.clouds!=null?GS.clouds:Q.clouds;cloudS.value=cl;$('gfxCloudsValue').textContent=cl;fillRange(cloudS);
    const rn=GS.rain!=null?GS.rain:presetRain(GFX.mode);rainS.value=rn;$('gfxRainValue').textContent=rn+'%';fillRange(rainS);
    fovS.value=GS.fov||0;$('gfxFovValue').textContent=GS.fov?((GS.fov>0?'+':'')+GS.fov+'°'):'افتراضي';fillRange(fovS);
    fpsT.checked=!!GS.showFps;
    setSeg('gfxFpsCap',GS.fpsCap||0);setSeg('gfxMirror',GS.mirror!=null?GS.mirror:'auto');
    setSeg('gfxAA',GS.aa||'auto');setSeg('gfxAniso',GS.aniso!=null?GS.aniso:'auto');
    $('gfxCustomTag').hidden=!isCustom();
    $('gfxReloadRow').hidden=!((GS.aa||'auto')!==(loaded.aa||'auto')||(GS.aniso!=null?GS.aniso:'auto')!==(loaded.aniso!=null?loaded.aniso:'auto'));
    document.body.classList.toggle('hide-fps',!GS.showFps);
    relayout();
  }
  window.syncGfxUI=syncGfx;
  const changed=()=>{saveGS();setQuality(GFX.mode,false)};
  resS.addEventListener('input',()=>{GS.res=+resS.value;changed()});
  adS.addEventListener('change',()=>{GS.adaptive=adS.checked;changed()});
  cloudS.addEventListener('input',()=>{GS.clouds=+cloudS.value;changed()});
  rainS.addEventListener('input',()=>{GS.rain=+rainS.value;changed()});
  fovS.addEventListener('input',()=>{GS.fov=+fovS.value;saveGS();syncGfx()});
  fpsT.addEventListener('change',()=>{GS.showFps=fpsT.checked;saveGS();syncGfx()});
  function seg(id,apply){document.querySelectorAll('#'+id+' button').forEach(b=>b.addEventListener('click',()=>{apply(b.dataset.v);saveGS();syncGfx()}))}
  seg('gfxFpsCap',v=>{GS.fpsCap=+v});
  seg('gfxMirror',v=>{GS.mirror=v==='auto'?null:+v;setQuality(GFX.mode,false)});
  seg('gfxAA',v=>{GS.aa=v});
  seg('gfxAniso',v=>{GS.aniso=v==='auto'?null:+v});
  $('gfxReloadBtn').addEventListener('click',()=>location.reload());
  $('gfxResetBtn').addEventListener('click',()=>{
    Object.assign(GS,{res:null,adaptive:null,fpsCap:0,mirror:null,clouds:null,rain:null,fov:0,showFps:true,aa:'auto',aniso:null});
    saveGS();setQuality('auto',true);
  });

  renderKb();renderGp();syncGpOpts();syncGfx();
  // keep the gamepad row labels fresh if the settings page is reopened
  window.addEventListener('gamepadconnected',()=>{});
})();

const _CAM_BIKE=[[4.4,1.9,6,1.15],[14,8,6,.6],[-.1,1.2,12,1.1]],_CAM_CAR=[[5.8,2.4,7,1.4],[17,12,6,.5],[-.1,1.2,12,1.1]]; // camera presets (distance, height, look-ahead, look-height) per view
let _armAng=1e9,_armFn=null,_badgeAt=0;
let _capLast=0;
function loop(now){requestAnimationFrame(loop);_frameId++;if(GS.fpsCap){if(now-_capLast<1000/GS.fpsCap-2)return;_capLast=now}seaU.t.value=now*.001;foamT.offset.x=Math.sin(now*.0006)*.035;
updateFPSCounter(now);
if(!mitsuClusterBadgeRemoved&&now-_badgeAt>500){_badgeAt=now;mitsuClusterBadgeRemoved=eraseMitsubishiClusterBadge()}
const rawMs=now-last,dt0=Math.min(rawMs/1000,.05),dt=POL.over?dt0*.4:dt0;last=now;
updateGamepad(now,dt);
updateRain(dt,gameMode==='playing'?Math.hypot(st.wx,st.wz):0);
if(gameMode!=='playing'){
  if(HORN.on||HORN.k>0||HORN.au)hornReset();
  if(POLS.g)policeSirenSet(0);
  if(gn)gn.gain.value=0; // engine sound off while paused / in menus / busted screen
  if(window.DRIVE)DRIVE.silence();
  // menus / pause: the scene is static behind the blurred overlay, so ~10 renders per second are plenty and the GPU stays idle
  if(now-idleRenderAt>=100){idleRenderAt=now;renderOptimizedScene(camera)}
  renderMirrors(); // hides HTML mirror overlays without rendering mirror targets
  return;
}
adaptResolution(now,GS.fpsCap?rawMs*(16.7/Math.max(16.7,1000/GS.fpsCap)):rawMs);
hornFrame(dt);
if(POL.over){clearDrivingInput();keys.s=1} // busted: no more input, the car brakes in slow motion
const pz=playerRoadCoords().z,vf=step(dt),playerRoad=playerRoadCoords(),dz=playerRoad.z-pz,sp=Math.abs(vf);
placeCarOnRoad();
updateTraffic(dt,Math.max(0,vf),playerRoad);updatePlayerLighting(playerRoad);drvAddProgress(-dz);drvNearPass(playerRoad);placeCarOnRoad();crashShake*=Math.exp(-5*dt);FX.update(dt);if(BIKE)bikeVisual(dt);
for(const w of wheels)w.rotation.x=w.userData.rear?spinR:spin; // handbrake locks the rear wheels
const visSteer=Math.max(-.42,Math.min(.42,dlVis*.75)); // visual wheel turn follows the real steering (incl. counter-steer in a drift)
for(const p of pivots)p.rotation.y=visSteer;
for(let i=0;i<segs.length;i++){let s=segs[i],z=s.g.position.z;
const relativeZ=z-playerRoad.z;
// Recycle only after a segment leaves the extended rear/front streaming window.
// This keeps 1000 m of continuous road behind the car for the rear mirrors.
if(relativeZ>REAR_ROAD_BUFFER+L/2)z-=ROAD_RING_LENGTH;
else if(relativeZ<-(FRONT_ROAD_BUFFER+L/2))z+=ROAD_RING_LENGTH;
else continue;
s.g.position.z=z;refreshSegment(s);updateSegmentRoadTransform(s)} // recycle in place: no new meshes / geometries
try{bridgeUpdate(dt)}catch(err){if(!window._brErr){window._brErr=1;console.warn('Flyover update failed:',err)}}
try{tunnelUpdate(dt)}catch(err){if(!window._tnErr){window._tnErr=1;console.warn('Tunnel update failed:',err)}}
const _ck=(window.DRIVE&&DRIVE.enabled&&!BIKE)?DRIVE.cam(dt):null; // GTA-style chase camera helper (look into slides, pull back with speed)
if(view===2)ch=st.h;else{let dh=(_ck?_ck.yaw:st.h)-ch;dh=Math.atan2(Math.sin(dh),Math.cos(dh));ch+=dh*Math.min(1,dt*(_ck?3+Math.min(3,Math.abs(dh)*5):3.5))}
{const keyboardOrbit=((keys.e?1:0)-(keys.q?1:0))*(view===2?-Math.PI*2/9:Math.PI/2);const side=(keys.r&&view!==2)?Math.PI:(keyboardOrbit+(view!==2?gamepadOrbitYaw:0));orb.y+=(side-orb.y)*Math.min(1,dt*6);const pitchTarget=view===2?0:gamepadOrbitPitch;orb.p+=(pitchTarget-orb.p)*Math.min(1,dt*5);orb.z=1;if(view!==2){lk.y=0;lk.p=0;lkT.y=0;lkT.p=0}else{const kk=Math.min(1,dt*8);lk.y+=(lkT.y-lk.y)*kk;lk.p+=(lkT.p-lk.p)*kk}}
const cx=-Math.sin(ch),cz=-Math.cos(ch),V=(BIKE?_CAM_BIKE:_CAM_CAR)[view],zm=view===2?1:orb.z,d=V[0]*zm*(_ck&&view!==2?_ck.d:1),cp=Math.cos(orb.p),pa=view===2?ch:ch+orb.y;
const cameraLocalX=st.x+Math.sin(pa)*d*cp,camBridgeE=bridgeElevAt(st.x,st.z),cameraLocalY=camBridgeE+Math.max(.6,V[1]*(view===2?1:Math.max(.6,zm))+Math.sin(orb.p)*Math.abs(d)+(_ck&&view!==2?_ck.h:0)),cameraLocalZ=st.z+Math.cos(pa)*d*cp;
camera.position.set(cameraLocalX,cameraLocalY,cameraLocalZ);
if(view===2){const ya=ch+orb.y+lk.y;
 if(EYE){car.updateMatrixWorld(true);if(BIKE){BIKE.rider.root.updateMatrixWorld(true);BIKE.eye.getWorldPosition(camera.position)}else camera.position.copy(car.localToWorld(_eyeV.copy(EYE)))} // eye point inside the car, left seat
 camera.lookAt(camera.position.x-Math.sin(ya)*12,(EYE?camera.position.y-12*Math.tan(COCKPIT_PITCH):V[3]+camBridgeE)-Math.sin(orb.p+lk.p)*12,camera.position.z-Math.cos(ya)*12);if(BIKE)camera.rotateZ(.55*BIKE.s.phi)}
else{const k=Math.max(0,1-Math.abs(orb.y)/.7);camera.lookAt(st.x+cx*V[2]*k,V[3]+camBridgeE,st.z+cz*V[2]*k)}
if(crashShake>.004){const k=crashShake*crashShake*.35;camera.position.x+=rnd(-k,k);camera.position.y+=rnd(-k,k)*.7;camera.position.z+=rnd(-k,k)}
const fov=(GS.fov||0)+((view===2&&EYE)?(innerWidth<innerHeight?92:80)+Math.min(sp*.08,6):(innerWidth<innerHeight?74:60)+Math.min(sp*.18,14));
const nearT=(view===2&&EYE)?.1:.5;if(camera.near!==nearT){camera.near=nearT;camera.updateProjectionMatrix()}
if(Math.abs(camera.fov-fov)>.05){camera.fov=fov;camera.updateProjectionMatrix()}
const roadCenter=playerRoad.frame.x;sky.position.set(car.position.x,0,car.position.z);sea.position.set(roadCenter+326,SEA_LEVEL,playerRoad.z-600);ground.position.set(roadCenter-575,-.1,playerRoad.z-600);
seaT.offset.y-=dz/25;seaT.offset.x+=dt*.004;
foamM.opacity=.7+.25*Math.sin(now/900);
// Clouds sit on a fixed sky dome around the player (like the sky sphere): they never shift with the car or camera movement, only a very slow wind drift moves them
const _cloudRoll=(typeof BIKE!=='undefined'&&BIKE&&view===2)?.55*BIKE.s.phi:0; // the cockpit camera rolls with the bike's lean; cancel it on the cloud sprites so they stay level with the horizon
for(const c of clouds){const u=c.userData;c.material.rotation=-_cloudRoll;u.az+=dt*.0008;c.position.set(car.position.x+Math.sin(u.az)*u.rad,u.h,car.position.z-Math.cos(u.az)*u.rad)}
const kmh=String(Math.round(sp*3.6)),g=sp<.5?'N':(((window.DRIVE&&DRIVE.enabled&&!BIKE)?revMode:vf<0)?'R':String(gi+1)); // with real slides the car can roll backwards in a forward gear
if(kmh!==shownS){shownS=kmh;spdEl.textContent=kmh}
if(g!==shownG){shownG=g;gearEl.textContent=g}
setCockpit(view===2&&!!EYE);
if(swPivot){const _sa=Math.max(-2.2,Math.min(2.2,dlVis*3.2));swPivot.quaternion.setFromAxisAngle(swAxis,_sa);if(armUpd&&cockpitOn){if(_armFn!==armUpd||Math.abs(_sa-_armAng)>1e-4){_armFn=armUpd;_armAng=_sa;armUpd()}}else _armFn=null}
if(cockpitOn&&cluster){if(BIKE&&BIKE.drawDisplay)BIKE.drawDisplay(sp*3.6,engRPM,g);else drawCluster(sp*3.6,engRPM,g)}const _gh=cockpitOn;
if(gaugeHidden!==_gh){gaugeHidden=_gh;gaugeEl.style.display=_gh?'none':''}
if(!_gh)drawGauge(sp*3.6,g);
if(osc){const rpm=Math.min(1,Math.max(0,(engRPM-700)/6600));osc.frequency.value=40+rpm*120;gn.gain.value=muted?0:engineVolume*(.03+.05*st.thr)}
renderOptimizedScene(camera);renderMirrors();if(window.GFXP)GFXP.afterFrame()}
// ===================== Car selection: Lancer (embedded FBX) + Kia Sportage + Lada VAZ-2103 (embedded GLB) =====================
const CAR_CFG=window.CAR_CFG||{};
const carSlots={},CAR_PERM=new Set();let activeCarId='lancer',carBusy=false;
for(const L of headLights){CAR_PERM.add(L);if(L.target)CAR_PERM.add(L.target)}
function carStateGet(){
  return{children:car.children.filter(c=>!CAR_PERM.has(c)),wheels:wheels.slice(),pivots:pivots.slice(),paint:[...paintMaterials],paintDef:new Map(paintMaterialDefaults),
    glass:cockpitGlass.slice(),cluster,swPivot,swAxis,EYE,pitch:COCKPIT_PITCH,mirPanels:mirPanels.slice(),MIRC:MIRC.slice(),mirrorHost,handParts:handParts.slice(),armUpd,
    dome:window._dome,domeFix:window._domeFix,rearPos:MIR[0].pos.clone(),spots:headLights.map(l=>l.position.clone()),bike:BIKE};
}
function carStateApply(S){
  for(const c of car.children.slice())if(!CAR_PERM.has(c))car.remove(c);
  for(const c of S.children)car.add(c);
  BIKE=S.bike||null;
  wheels.length=0;for(const w of S.wheels)wheels.push(w);
  pivots.length=0;for(const w of S.pivots)pivots.push(w);
  paintMaterials.clear();for(const m of S.paint)paintMaterials.add(m);
  paintMaterialDefaults.clear();S.paintDef.forEach((v,k)=>paintMaterialDefaults.set(k,v));
  cockpitGlass=S.glass.slice();cluster=S.cluster;swPivot=S.swPivot;swAxis=S.swAxis;EYE=S.EYE;COCKPIT_PITCH=S.pitch;
  mirPanels.length=0;for(const p of S.mirPanels){p.userData.dead=false;mirPanels.push(p)}
  MIRC.length=0;for(const q of S.MIRC)MIRC.push(q);
  mirC=0;                                                       // restart the interior-mirror round-robin for the newly selected vehicle
  mirrorHost=S.mirrorHost;handParts.length=0;for(const h of S.handParts)handParts.push(h);armUpd=S.armUpd;
  window._dome=S.dome;window._domeFix=S.domeFix;MIR[0].pos.copy(S.rearPos);
  headLights.forEach((l,i)=>{if(S.spots[i])l.position.copy(S.spots[i])});
  // damage / lamp caches belong to the previous car: rebuild them lazily for this one
  _partsReady=false;_crashReady=false;_playerHB=null;_playerDentMeshes=null;
  for(const k in LAMPS)LAMPS[k]=null;_mirPos.length=0;_mirHit.length=0;
  cockpitOn=false;for(const g of cockpitGlass)g.visible=true;if(cluster)cluster.visible=false;for(const p of mirPanels)p.visible=false;for(const h of handParts)h.visible=false;
  if(window._dome)window._dome.visible=!!isNight;if(window._domeFix)window._domeFix.visible=!!isNight;
  if(BIKE){st.roll=st.pitch=0;try{BIKE.reset()}catch(e){console.warn(e)}}
  try{patchPlayerCarMaterials()}catch(e){console.warn(e)}
  try{setCarPaintColor(activePaintColor);setCarPaintFinish(activePaintFinish)}catch(e){console.warn(e)}
  try{if(typeof setHeadlights==='function')setHeadlights(isNight)}catch(e){}
  try{renderer.compile(scene,camera)}catch(e){}
}
async function buildGlbCar(id){
  const cfg=CAR_CFG[id],pk=window.CAR_PACK&&window.CAR_PACK[id];
  if(cfg.type==='bike')return buildBikeCar(id,cfg,pk);
  if(!pk||!pk.z)throw new Error('car data missing: '+id);
  if(!THREE.GLTFLoader||!window.fflate)throw new Error('GLTFLoader/fflate unavailable');
  const bytes=fflate.gunzipSync(z85Decode(pk.z,pk.n));
  const gltf=await trafficParseGLB(new THREE.GLTFLoader(),bytes);
  const root=gltf.scene;root.name='CarRoot_'+id;
  const S={children:[root],wheels:[],pivots:[],paint:[],paintDef:new Map(),glass:[],cluster:null,swPivot:null,swAxis:null,EYE:new THREE.Vector3(...cfg.eye),pitch:cfg.pitch,
    mirPanels:[],MIRC:[],mirrorHost:null,handParts:[],armUpd:null,dome:null,domeFix:null,rearPos:new THREE.Vector3(...cfg.rear),spots:cfg.spots.map(s=>new THREE.Vector3(...s))};
  // materials / shadows / paint
  const seen=new Set();
  root.traverse(o=>{
    if(!o.isMesh)return;
    o.castShadow=true;o.receiveShadow=true;
    for(const m of (Array.isArray(o.material)?o.material:[o.material])){
      if(!m||seen.has(m))continue;seen.add(m);
      m.side=THREE.DoubleSide;
      if(m.map)m.map.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());
      if(m.name==='Paint_Body'){S.paint.push(m);S.paintDef.set(m,{roughness:.45,metalness:0,envMapIntensity:m.envMapIntensity});m.roughness=.45;m.metalness=0}
      m.needsUpdate=true;
    }
  });
  // wheels: steer pivot (front) + spin node, exactly like the Lancer rig
  for(const k of ['FL','FR','RL','RR']){
    const w=root.getObjectByName('WHEEL_'+k);if(!w)continue;
    const steer=new THREE.Group();steer.position.copy(w.position);w.position.set(0,0,0);root.add(steer);steer.add(w);
    w.userData.rear=k[0]==='R';S.wheels.push(w);if(k[0]==='F')S.pivots.push(steer);
  }
  // window glass is hidden in the cockpit view
  const win=root.getObjectByName('WINDOWS');if(win)win.traverse(o=>{if(o.isMesh)S.glass.push(o)});
  // head / tail lamp glow overlays (non-indexed triangle lists, same as the Lancer ones)
  for(const [nm,mt] of [['GLOW_HEAD',headM],['GLOW_TAIL',tailM]]){
    const o=root.getObjectByName(nm);if(!o||!o.isMesh)continue;
    const g0=o.geometry.index?o.geometry.toNonIndexed():o.geometry,g=new THREE.BufferGeometry();
    g.setAttribute('position',g0.attributes.position.clone());o.geometry=g;o.material=mt;
    o.renderOrder=10;o.castShadow=false;o.receiveShadow=false;o.frustumCulled=false;
  }
  // cabin host: holds mirror panels + instrument cluster (never counted as damageable body)
  const cabin=new THREE.Group();cabin.name='cabinHost';root.add(cabin);S.mirrorHost=cabin;
  const sw=root.getObjectByName('STEER');
  if(sw){S.swPivot=sw;S.swAxis=new THREE.Vector3(...cfg.steerN).normalize()}
  // driver hands + arms: Lancer rig mapped into this car through a frame (Lancer interior space -> car space)
  if(sw&&DRIVER_HANDS){
    try{
      const prevArm=armUpd,before=handParts.length;
      const CL=new THREE.Vector3(.3497,.7174,.3858),AXL=new THREE.Vector3(0,.3559,-.9345).normalize(),axN=new THREE.Vector3(...cfg.steerN).normalize();
      const R=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.asin(.3559)-Math.asin(axN.y)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),Math.PI));
      const F=new THREE.Group();F.name='handsFrame';F.quaternion.copy(R);F.position.copy(sw.position).sub(CL.clone().applyQuaternion(R));cabin.add(F);
      const hp=new THREE.Group();hp.position.copy(CL);F.add(hp);
      // rim measurement proxy: this car's wheel vertices expressed in Lancer interior space
      const Ri=R.clone().invert(),arr=[],v=new THREE.Vector3();
      sw.traverse(o=>{if(o.isMesh){const p=o.geometry.attributes.position;for(let i=0;i<p.count;i++){v.fromBufferAttribute(p,i).applyQuaternion(Ri);arr.push(v.x,v.y,v.z)}}});
      const pg=new THREE.BufferGeometry();pg.setAttribute('position',new THREE.BufferAttribute(new Float32Array(arr),3));
      const proxy=new THREE.Mesh(pg,new THREE.MeshBasicMaterial());proxy.visible=false;hp.add(proxy);
      buildHands(F,hp);
      hp.remove(proxy);pg.dispose();
      S.handParts=handParts.splice(before);const real=armUpd;armUpd=prevArm;
      S.armUpd=()=>{const q=sw.quaternion,a=S.swAxis,ang=2*Math.atan2(q.x*a.x+q.y*a.y+q.z*a.z,q.w);hp.quaternion.setFromAxisAngle(AXL,ang);if(real)real()};
    }catch(e){console.warn('driver hands (glb car) failed',e)}
  }
  // instrument cluster (shared canvas texture)
  {const faceC=new THREE.Vector3(...cfg.cl.c),faceN=new THREE.Vector3(...cfg.cl.n).normalize();
   const X=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),faceN).normalize(),Y=new THREE.Vector3().crossVectors(faceN,X);
   const cl=new THREE.Group();cl.position.copy(faceC).addScaledVector(faceN,.003);
   cl.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(X,Y,faceN));cl.visible=false;cl.frustumCulled=false;
   const mat=new THREE.MeshBasicMaterial({map:clTex,fog:false,side:THREE.DoubleSide,transparent:false,alphaTest:.35,depthTest:true,depthWrite:true,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});
   const pw=CL_W/3000,ph=CL_H/3000,disp=new THREE.Mesh(new THREE.PlaneGeometry(pw,ph),mat);
   disp.scale.setScalar(cfg.cl.s);disp.frustumCulled=false;disp.castShadow=false;disp.receiveShadow=false;cl.add(disp);
   cl.userData.panelSize={width:pw*cfg.cl.s,height:ph*cfg.cl.s};cabin.add(cl);S.cluster=cl}
  // mirrors (rear-view + two door mirrors), same construction as the Lancer
  {const upV=new THREE.Vector3(0,1,0);
   const mirrorShape=(w,h,kind,sx=1,sy=1)=>{
     const a=w*.5*sx,b=h*.5*sy,sh=new THREE.Shape();
     if(kind===0){sh.moveTo(-a*.80,-b);sh.bezierCurveTo(-a*.98,-b,-a,-b*.58,-a,-b*.10);sh.bezierCurveTo(-a,b*.55,-a*.90,b,a*.74,b);sh.bezierCurveTo(a*.98,b,a,b*.56,a,b*.10);sh.bezierCurveTo(a,-b*.56,a*.90,-b,a*.74,-b)}
     else{sh.moveTo(-a*.92,-b*.12);sh.bezierCurveTo(-a*.99,-b*.72,-a*.58,-b,a*.08,-b*.98);sh.bezierCurveTo(a*.70,-b*.96,a*.99,-b*.56,a*.96,-b*.08);sh.bezierCurveTo(a*.99,b*.48,a*.66,b*.94,a*.12,b*.98);sh.bezierCurveTo(-a*.52,b*.90,-a*.94,b*.54,-a*.92,-b*.12)}
     sh.closePath();const geo=new THREE.ShapeGeometry(sh,24);geo.computeBoundingBox();
     const bb=geo.boundingBox,pos=geo.attributes.position,uv=geo.attributes.uv,sxB=Math.max(1e-6,bb.max.x-bb.min.x),syB=Math.max(1e-6,bb.max.y-bb.min.y);
     for(let i=0;i<pos.count;i++)uv.setXY(i,(pos.getX(i)-bb.min.x)/sxB,(pos.getY(i)-bb.min.y)/syB);uv.needsUpdate=true;return geo};
   for(const [c,n,w,h,rw,rh,vf,kind] of cfg.mirrors){
     const rt=new THREE.WebGLRenderTarget(rw,rh,{minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,generateMipmaps:false});
     rt.texture.repeat.x=-1;rt.texture.offset.x=1;
     const N=new THREE.Vector3(...n).normalize(),U=new THREE.Vector3().crossVectors(upV,N).normalize(),W=new THREE.Vector3().crossVectors(N,U);
     const rot=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(U,W,N)),centre=new THREE.Vector3(...c);
     const frame=new THREE.Mesh(mirrorShape(w,h,kind),new THREE.MeshBasicMaterial({color:0x171d25,fog:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-2,polygonOffsetUnits:-2}));
     frame.position.copy(centre).addScaledVector(N,-.002);frame.quaternion.copy(rot);frame.visible=false;frame.renderOrder=5;cabin.add(frame);S.mirPanels.push(frame);
     const p=new THREE.Mesh(mirrorShape(w,h,kind,.985,.94),new THREE.MeshBasicMaterial({map:rt.texture,fog:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:-3}));
     p.position.copy(centre).addScaledVector(N,.0008);p.quaternion.copy(rot);p.visible=false;p.renderOrder=6;cabin.add(p);S.mirPanels.push(p);
     const cam=new THREE.PerspectiveCamera(vf,rw/rh,.05,1800);cam.rotation.order='YXZ';
     S.MIRC.push({rt,cam,centre:centre.clone(),normal:N.clone(),host:cabin});
   }}
  // cabin dome light
  {const d=new THREE.PointLight(0xffd9a8,.8,3.2,1.8);d.position.set(...cfg.dome);d.visible=!!isNight;d.name='cabinDomeLight';root.add(d);S.dome=d}
  return S;
}
async function selectCar(id){
  if(carBusy||id===activeCarId||!(id==='lancer'||CAR_CFG[id]))return;
  if(gameMode!=='menu')return;
  carBusy=true;
  const btn=document.getElementById('beginDriveBtn'),st=document.getElementById('carLoadStatus'),grid=document.getElementById('carGrid');
  if(btn)btn.disabled=true;
  const setActive=cid=>{grid.querySelectorAll('[data-car]').forEach(b=>{const on=b.dataset.car===cid;b.classList.toggle('active',on);b.setAttribute('aria-checked',on?'true':'false')})};
  if(st)st.textContent='جاري تجهيز السيارة...';
  try{
    if(!carSlots[id]&&id!=='lancer')await new Promise(r=>setTimeout(r,30));
    const next=carSlots[id]||(id==='lancer'?null:await buildGlbCar(id));
    try{repairPlayerCar()}catch(e){}
    for(const k in LAMPS){const L=LAMPS[k];if(L&&L.halo&&L.halo.parent)L.halo.parent.remove(L.halo)}
    carSlots[activeCarId]=carStateGet();
    carStateApply(next||carSlots.lancer);
    activeCarId=id;carSlots[id]=carSlots[id]||next;
    setActive(id);
    if(st)st.textContent=id==='lancer'?'ميتسوبيشي لانسر: السيارة الأساسية.':(CAR_CFG[id].type==='bike'?CAR_CFG[id].label+' جاهزة. موتسيكل بفيزياء ميلان حقيقية: A/D للميلان، W غاز، S فرامل، مسافة للفرامل الخلفية.':CAR_CFG[id].label+' جاهزة. نفس المحرك، مع تعليق ووزن ونظام دفع خاص بكل سيارة.');
  }catch(e){
    console.error('selectCar failed',e);setActive(activeCarId);
    if(st)st.textContent='تعذر تحميل السيارة، تم الإبقاء على السيارة الحالية.';
  }finally{carBusy=false;if(btn)btn.disabled=false}
}
carSlots.lancer=carStateGet();
{const grid=document.getElementById('carGrid');if(grid)grid.querySelectorAll('[data-car]').forEach(b=>b.addEventListener('click',()=>selectCar(b.dataset.car)))}

requestAnimationFrame(loop);