// ===================== Realistic sky (الكورنيش اللانهائي) =====================
//  * sky dome shader: Rayleigh-like blue gradient, Mie glow around the sun, an HDR sun disc (it blooms), a horizon that fades
//    exactly into the scene fog (no seam with the distant city / sea)
//  * one cloud deck 1.8 km up, lit by the sun: self-shadowed bases, bright tops, silver linings toward the sun, high cirrus,
//    real parallax while driving (the deck stays put in the world) and a slow wind drift
//  * night: deep blue-black zenith, warm light pollution over the city, the Milky Way with dark dust lanes, a cratered moon
//    with its halo, and a new star field (thousands of stars, real brightness spread and colours, gentle twinkle)
//  * overcast winter: a heavy, low grey deck; nights lit from below by the city
//  * buildings / fallback reflections use a cube map of this sky, refreshed when the time of day or weather changes
// Uses the existing `sky` sphere (follows the car), so mirrors and reflection probes see the same sky.
(function(){
'use strict';
if(typeof THREE==='undefined'||typeof sky==='undefined'||typeof scene==='undefined'){console.warn('sky-plus: game not ready');return}

// ---------- tileable fbm noise texture (R / G = two independent fbm fields) ----------
const NOISE=(()=>{
  const S=256,data=new Uint8Array(S*S*4);
  const A=[2,4,8,16,32,64].map(f=>mkWrapNoise(f,f)),B=[3,6,12,24,48,96].map(f=>mkWrapNoise(f,f));
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const u=x/S,v=y/S;let a=0,b=0,w=0,k=1;
    for(let i=0;i<6;i++){a+=A[i](u,v)*k;b+=B[i](u,v)*k;w+=k;k*=.5}
    const o=(y*S+x)*4;data[o]=Math.round(a/w*255);data[o+1]=Math.round(b/w*255);data[o+2]=Math.round(A[3](u,v)*255);data[o+3]=255;
  }
  const t=new THREE.DataTexture(data,S,S,THREE.RGBAFormat);
  t.wrapS=t.wrapT=THREE.RepeatWrapping;t.magFilter=THREE.LinearFilter;t.minFilter=THREE.LinearMipmapLinearFilter;t.generateMipmaps=true;
  t.anisotropy=Math.min(8,renderer.capabilities.getMaxAnisotropy());t.needsUpdate=true;
  return t;
})();

// ---------- sky shader ----------
const U={uSun:{value:new THREE.Vector3(.55,.5,-.67).normalize()},uFog:{value:new THREE.Color(0xcfe6f6)},uCam:{value:new THREE.Vector3()},
  uNight:{value:0},uWinter:{value:0},uTime:{value:0},uCover:{value:.55},uNoise:{value:NOISE}};
const VS=`varying vec3 vDir;
void main(){vDir=position;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`;
const FS=`uniform vec3 uSun,uFog,uCam;uniform float uNight,uWinter,uTime,uCover;uniform sampler2D uNoise;varying vec3 vDir;
float N1(vec2 p){return texture2D(uNoise,p).r;}
float N2(vec2 p){return texture2D(uNoise,p).g;}
// ---- day / overcast atmosphere ----
vec3 dayAtmos(vec3 d,float cs){
  float h=clamp(d.y,0.,1.);
  vec3 zen=mix(vec3(.11,.33,.76),vec3(.40,.46,.52),uWinter),hor=mix(vec3(.66,.81,.95),vec3(.56,.62,.67),uWinter);
  vec3 c=mix(hor,zen,pow(h,.48));
  c=mix(c,c*vec3(1.02,1.,.98),pow(1.-h,4.));
  float sg=max(cs,0.);
  c+=vec3(1.,.87,.66)*(pow(sg,5.)*.16+pow(sg,48.)*.42+pow(sg,600.)*2.2)*(1.-.85*uWinter);     // Mie glow around the sun
  c+=vec3(.06,.04,.05)*pow(1.-h,5.)*max(-cs,0.)*(1.-uWinter);                                 // faint pink haze opposite the sun
  return c;
}
// ---- night atmosphere: zenith, light pollution, Milky Way ----
vec3 nightAtmos(vec3 d){
  float h=clamp(d.y,0.,1.);
  vec3 zen=mix(vec3(.004,.009,.03),vec3(.008,.012,.018),uWinter),hor=mix(vec3(.035,.06,.14),vec3(.05,.07,.09),uWinter);
  vec3 c=mix(hor,zen,pow(h,.38));
  float city=pow(1.-h,7.)*(.45+.55*smoothstep(.3,-.9,d.x));                                    // the city lies on the land side (-x)
  c+=vec3(.24,.13,.06)*city*(.55+.6*uWinter);
  if(uWinter<.5){
    vec3 nm=normalize(vec3(.32,.28,.9));float md=dot(d,nm);
    float band=exp(-md*md/.02);
    vec2 mp=vec2(atan(d.z,d.x)*.9,md*2.4);
    float st=N1(mp*.6+.3)*.65+N2(mp*1.7)*.35;
    float dust=smoothstep(.5,.72,N2(mp*1.1+.7))*exp(-md*md/.005);
    float core=exp(-pow(atan(d.z,d.x)-.6,2.)*1.5);
    c+=mix(vec3(.45,.52,.75),vec3(.75,.65,.55),core*.6)*band*pow(st,1.6)*.16*(1.-.85*dust)*smoothstep(0.,.3,h);
  }
  return c;
}
// ---- cloud deck ----
vec4 cloudDeck(vec3 d,vec3 sky,float cs){
  if(d.y<=.0)return vec4(0.);
  float H=mix(1800.,900.,uWinter);
  float t=H/(d.y+.03);
  vec2 wp=uCam.xz+d.xz*t;                                       // world position on the deck: parallax while driving
  vec2 p=wp*.00042+vec2(uTime*.0042,uTime*.0018);
  float cov=mix(uCover,.97,uWinter);
  float th=mix(.68,.34,cov);
  float base=N1(p)*.72+N2(p*2.3+.41)*.28;
  float dens=smoothstep(th,th+.09,base);
  if(dens<.003)return vec4(0.);
  dens*=.72+.28*N1(p*5.3+1.3);                                  // billowy erosion
  vec2 sd=normalize(uSun.xz+1e-4)*.018;float occ=0.;
  for(int i=1;i<=3;i++){vec2 q=p+sd*float(i);occ+=smoothstep(th,th+.09,N1(q)*.72+N2(q*2.3+.41)*.28);}
  float light=exp(-occ*.42);
  float sg=max(cs,0.);
  vec3 lit,dark;
  if(uNight>.5){lit=mix(vec3(.085,.10,.15),vec3(.07,.08,.09),uWinter);dark=mix(vec3(.018,.022,.036),vec3(.03,.032,.036),uWinter);}
  else{lit=mix(vec3(1.,.975,.94),vec3(.70,.74,.78),uWinter);dark=mix(vec3(.62,.67,.76),vec3(.36,.40,.45),uWinter);}
  vec3 col=mix(dark,lit,light);
  col+=(uNight>.5?vec3(.05,.06,.09):vec3(1.,.9,.72))*pow(sg,7.)*(1.-dens)*.9*(1.-uWinter*.8);   // silver lining toward the sun / moon
  if(uNight>.5)col+=vec3(.20,.11,.05)*(1.-light*.6)*(.5+.5*smoothstep(.3,-.9,d.x))*smoothstep(.45,0.,d.y)*(.6+.6*uWinter); // city glow under the clouds
  float fade=smoothstep(0.,.13,d.y);
  col=mix(sky,col,.3+.7*fade);                                   // aerial perspective
  return vec4(col,dens*(.25+.75*fade)*.96);
}
vec4 cirrus(vec3 d,float cs){
  if(d.y<=0.||uWinter>.5)return vec4(0.);
  float t=7000./(d.y+.05);vec2 wp=uCam.xz*.3+d.xz*t;
  vec2 p=wp*vec2(.00004,.00016)+vec2(uTime*.0006,0.);
  float s=smoothstep(.55,.8,N2(p))*smoothstep(.0,.25,d.y);
  vec3 c=uNight>.5?vec3(.05,.06,.09):vec3(1.,.98,.95);
  return vec4(c,s*.35*(1.-uCover*.5));
}
void main(){
  vec3 d=normalize(vDir);
  float cs=dot(d,uSun);
  vec3 c=uNight>.5?nightAtmos(d):dayAtmos(d,cs);
  // sun disc / moon (behind the clouds)
  if(uNight<.5&&uWinter<.5){
    float sr=.0115,dsk=smoothstep(cos(sr*1.08),cos(sr*.92),cs);
    float limb=.6+.4*sqrt(max(0.,1.-pow(acos(min(1.,cs))/sr,2.)));
    c+=vec3(30.,27.,22.)*dsk*limb;
  }else if(uNight>.5){
    float mr=.021,dsk=smoothstep(cos(mr*1.06),cos(mr*.94),cs);
    vec3 up=abs(uSun.y)<.99?vec3(0.,1.,0.):vec3(1.,0.,0.);vec3 mx=normalize(cross(up,uSun)),my=cross(uSun,mx);
    vec2 mq=vec2(dot(d,mx),dot(d,my))/mr;
    float maria=smoothstep(.42,.62,N1(mq*.22+.13))*.42+smoothstep(.5,.7,N2(mq*.5+.3))*.18;
    vec3 moon=vec3(1.,.97,.9)*(1.05-maria)*(.85+.15*sqrt(max(0.,1.-dot(mq,mq))));
    float wk=1.-.75*uWinter;
    c=mix(c,moon*1.0*wk,dsk);                                     // below the bloom threshold: the maria stay visible
    c+=vec3(.55,.65,.95)*(pow(max(cs,0.),350.)*.22+pow(max(cs,0.),25.)*.035)*wk;
  }
  vec4 ci=cirrus(d,cs);c=mix(c,ci.rgb,ci.a);
  vec4 cl=cloudDeck(d,c,cs);c=mix(c,cl.rgb,cl.a);
  // seamless horizon: below / at the horizon the sky becomes the fog colour
  c=mix(uFog,c,smoothstep(-.015,.13,d.y));
  gl_FragColor=vec4(c,1.);
}`;
const skyMat=new THREE.ShaderMaterial({uniforms:U,vertexShader:VS,fragmentShader:FS,side:THREE.BackSide,depthWrite:false,fog:false});
const oldSkyMat=sky.material;
sky.material=skyMat;
sky.onBeforeRender=function(r,sc,cam){
  U.uTime.value=performance.now()*.001;
  cam.getWorldPosition(U.uCam.value);
  if(scene.fog)U.uFog.value.copy(scene.fog.color);
  if(window.GFXP&&GFXP.SUN)U.uSun.value.copy(GFXP.SUN.base);
};

// ---------- star field (replaces the old points; visibility still follows the game's `stars` group) ----------
const STARS=(()=>{
  const N=5200,pos=new Float32Array(N*3),col=new Float32Array(N*3),mag=new Float32Array(N),ph=new Float32Array(N),sz=new Float32Array(N);
  const tint=[[.70,.80,1],[.82,.88,1],[1,1,1],[1,.96,.86],[1,.86,.66],[1,.74,.55]];
  for(let i=0;i<N;i++){
    let y=Math.random()*1.06-.06,a=Math.random()*Math.PI*2;const r=Math.sqrt(1-y*y),R=1350;
    pos[i*3]=Math.cos(a)*r*R;pos[i*3+1]=y*R;pos[i*3+2]=Math.sin(a)*r*R;
    const m=Math.pow(Math.random(),7.5);                        // very few bright stars, many faint ones
    mag[i]=.06+m*2.6;sz[i]=1.05+m*2.4;ph[i]=Math.random()*100;
    const t=tint[Math.min(tint.length-1,Math.floor(Math.pow(Math.random(),1.3)*tint.length))];col.set(t,i*3);
  }
  const g=new THREE.BufferGeometry();
  g.setAttribute('position',new THREE.BufferAttribute(pos,3));g.setAttribute('aCol',new THREE.BufferAttribute(col,3));
  g.setAttribute('aMag',new THREE.BufferAttribute(mag,1));g.setAttribute('aPh',new THREE.BufferAttribute(ph,1));g.setAttribute('aSz',new THREE.BufferAttribute(sz,1));
  const m=new THREE.ShaderMaterial({uniforms:{uTime:U.uTime,uPR:{value:1}},transparent:true,depthWrite:false,blending:THREE.AdditiveBlending,fog:false,
    vertexShader:`attribute vec3 aCol;attribute float aMag,aPh,aSz;uniform float uTime,uPR;varying vec3 vC;
void main(){vec3 n=normalize(position);float ext=smoothstep(-.02,.35,n.y);
float tw=1.+(.18+.35*(1.-ext))*sin(uTime*(2.+fract(aPh)*5.)+aPh)*sin(uTime*1.3+aPh*1.7);
vC=aCol*aMag*ext*tw*mix(vec3(1.),vec3(1.,.85,.7),1.-ext);
gl_PointSize=aSz*uPR;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader:`varying vec3 vC;void main(){vec2 q=gl_PointCoord-.5;float r2=dot(q,q)*4.;float a=exp(-r2*3.2);gl_FragColor=vec4(vC*a,a);}`});
  const pts=new THREE.Points(g,m);pts.frustumCulled=false;pts.renderOrder=-.9;
  for(const ch of stars.children)ch.visible=false;
  stars.add(pts);
  pts.onBeforeRender=()=>{m.uniforms.uPR.value=renderer.getPixelRatio()};
  return pts;
})();

// ---------- the old sprites are replaced by the shader (sun disc, clouds) ----------
function hideOld(){
  if(typeof sunSpr!=='undefined')sunSpr.visible=false;
  for(const c of clouds)c.visible=false;
}
// cloud amount: the existing "number of clouds" setting now sets the deck coverage
function coverFromSettings(){
  const Q=(typeof QUALITY!=='undefined'&&typeof GFX!=='undefined')?QUALITY[GFX.mode]:null;
  const n=(GS.clouds!=null?GS.clouds:(Q?Q.clouds:16));
  U.uCover.value=.06+.46*Math.min(1,n/16);   // default (16) = fair-weather cumulus
}
function syncMode(){
  U.uNight.value=isNight?1:0;U.uWinter.value=weatherMode==='winter'?1:0;
  hideOld();coverFromSettings();requestEnv();
}
const _stod=setTimeOfDay;
setTimeOfDay=function(){const r=_stod.apply(this,arguments);try{syncMode()}catch(e){console.warn(e)}return r};
const _sq=setQuality;
setQuality=function(){const r=_sq.apply(this,arguments);try{hideOld();coverFromSettings();requestEnv()}catch(e){}return r};
// the cloud slider in Settings changes the coverage live
{const cs=document.getElementById('gfxCloudsSlider');if(cs)cs.addEventListener('input',()=>{coverFromSettings();requestEnv()})}

// ---------- sky cube map for building windows (and as a static fallback reflection) ----------
const ENVS=(()=>{
  const sc=new THREE.Scene(),m=new THREE.Mesh(sky.geometry,skyMat);sc.add(m);
  const rt=new THREE.WebGLCubeRenderTarget(256,{format:THREE.RGBAFormat,generateMipmaps:true,minFilter:THREE.LinearMipmapLinearFilter});
  const cam=new THREE.CubeCamera(1,3000,rt);sc.add(cam);
  let pending=true;
  function render(){
    pending=false;
    const fogSaved=scene.fog;
    U.uFog.value.copy(scene.fog?scene.fog.color:new THREE.Color(0xcfe6f6));
    if(window.GFXP&&GFXP.SUN)U.uSun.value.copy(GFXP.SUN.base);
    U.uCam.value.set(0,1,0);
    cam.position.set(0,0,0);cam.update(renderer,sc);
    for(const mm of nightWinMats){mm.envMap=rt.texture;mm.needsUpdate=true}
  }
  return{rt,render,request(){pending=true},get pending(){return pending}};
})();
function requestEnv(){ENVS.request()}
// render the sky cube outside of any other render (first frame after a change)
const _ros=renderOptimizedScene;
renderOptimizedScene=function(cam,isMirror){
  if(ENVS.pending&&!isMirror){try{ENVS.render()}catch(e){console.warn('sky env failed',e)}}
  return _ros.apply(this,arguments);
};

syncMode();
window.SKYP={U,STARS,ENVS,NOISE,oldSkyMat,material:skyMat};
})();
