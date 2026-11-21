// ===================== Realistic buildings (الكورنيش اللانهائي) =====================
// "Interior mapping" behind every window: the view ray continues through the glass into a virtual room (3.2 m wide, 4 m deep;
// shops are deeper), so each window shows a back wall, side walls, floor, ceiling and furniture with real depth and parallax.
// Every room is different (wall colour, floor, furniture, curtains). Day: rooms are dim behind the glass. Night: lit rooms glow
// warm with a ceiling lamp, dark rooms stay dark, a few flicker with a TV. The glass gets a Fresnel reflection (you see into
// the room when facing it, it turns into a mirror at grazing angles). Painted mullions, sills and blinds of the facade stay.
(function(){
'use strict';
if(typeof THREE==='undefined'||typeof nightWinMats==='undefined'){console.warn('city-plus: game not ready');return}
const BU={uBNight:{value:0},uBTime:{value:0}};
const VERT_DECL='varying vec3 vBWPos;varying vec3 vBWNor;varying vec3 vBInst;\n';
const VERT_BODY=`
{vec4 _bw=vec4(transformed,1.);vec3 _bn=objectNormal;
#ifdef USE_INSTANCING
_bw=instanceMatrix*_bw;_bn=mat3(instanceMatrix)*_bn;vBInst=instanceMatrix[3].xyz;
#else
vBInst=vec3(0.);
#endif
vBWPos=(modelMatrix*_bw).xyz;vBWNor=normalize(mat3(modelMatrix)*_bn);}
`;
const FRAG_DECL=`varying vec3 vBWPos;varying vec3 vBWNor;varying vec3 vBInst;uniform vec2 uCells;uniform float uBNight,uBTime;
float bHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
`;
const FRAG_BODY=`
float _bfr=1.;
{
  // weathering: every building a slightly different tone, street grime that fades upward, contact darkening at the base
  float _bh=bHash(floor(vBInst.xz*.37)+.5),_hy=vBWPos.y;
  diffuseColor.rgb*=mix(vec3(.84,.83,.81),vec3(1.05,1.03,.99),_bh)*(.82+.18*smoothstep(0.,24.,_hy))*(1.-.2*exp(-_hy*1.3));
}
{
  vec3 _N=normalize(vBWNor);
  float _wm=texture2D(specularMap,vUv).r;
  float _ml=dot(texture2D(map,vUv).rgb,vec3(.299,.587,.114));
  float _wms=smoothstep(.45,.75,_wm)*step(abs(_N.y),.5);
  float _wf=_wms*(1.-smoothstep(.70,.84,_ml));                    // glass only (not mullions / sills / blinds / roofs)
  totalEmissiveRadiance*=1.-.85*_wms*(1.-_wf);                     // frames and mullions are solid: only a faint backlight at night
  if(_wf>.001){
    vec3 _V=normalize(vBWPos-cameraPosition);
    // tangent frame from screen derivatives (u along the facade, v up)
    vec3 _dp1=dFdx(vBWPos),_dp2=dFdy(vBWPos);vec2 _du1=dFdx(vUv),_du2=dFdy(vUv);
    vec3 _p2=cross(_dp2,_N),_p1=cross(_N,_dp1);
    vec3 _T=normalize(_p2*_du1.x+_p1*_du2.x),_B=normalize(_p2*_du1.y+_p1*_du2.y);
    vec3 _r=vec3(dot(_V,_T),dot(_V,_B),dot(_V,_N));_r.z=min(_r.z,-.02);
    vec2 _cell=vUv*uCells,_ci=floor(_cell),_cf=fract(_cell);
    bool _shop=_ci.y<.5;                                                     // ground floor = shops
    float _D=_shop?7.:4.,_W=3.2;
    vec3 _o=vec3(_cf*_W,0.);
    vec3 _iv=1./_r;
    float _tx=(_r.x>0.?(_W-_o.x):-_o.x)*_iv.x,_ty=(_r.y>0.?(_W-_o.y):-_o.y)*_iv.y,_tz=-_D*_iv.z;
    float _t=min(min(_tx,_ty),_tz);vec3 _h=_o+_r*_t;
    vec2 _id=_ci+floor(vBInst.xz*.37)*7.13;
    float _h1=bHash(_id),_h2=bHash(_id+3.1),_h3=bHash(_id+7.7),_h4=bHash(_id+11.3);
    vec3 _wall=_h1<.33?vec3(.80,.76,.68):_h1<.6?vec3(.72,.77,.80):_h1<.8?vec3(.86,.81,.66):vec3(.78,.72,.74);
    vec3 _col;
    if(_t==_tz){
      _col=_wall*.92;
      float _fx=1.6+(_h3-.5)*1.1;
      if(_h.y<.5+.55*_h2&&abs(_h.x-_fx)<.5+.6*_h4)_col=mix(vec3(.14,.11,.09),vec3(.42,.27,.17),_h1);        // sofa / cabinet
      if(_h2>.35&&abs(_h.y-1.95)<.28&&abs(_h.x-_fx-.2)<.33)_col=mix(vec3(.18,.26,.32),vec3(.55,.38,.22),_h3);  // a picture
      if(_shop&&abs(_h.y-1.1)<.9&&fract(_h.x*.9+_h4)<.55)_col=mix(vec3(.25,.2,.18),vec3(.7,.6,.5),_h2);          // shop shelves
    }else if(_t==_ty)_col=_r.y<0.?(_h3<.6?vec3(.36,.25,.16):vec3(.45,.45,.47)):vec3(.9,.89,.86);
    else _col=_wall*.76;
    _col*=.5+.5*exp(_h.z*.33);                                                 // deeper = darker
    vec3 _room;
    if(uBNight>.5){
      vec3 _lit=texture2D(emissiveMap,vUv).rgb;float _on=step(.06,max(_lit.r,max(_lit.g,_lit.b)));
      float _lamp=exp(-dot(_h-vec3(1.6,_W,-_D*.5),_h-vec3(1.6,_W,-_D*.5))*.28);
      _room=_on>.5?min(_col*_lit*(.62+.5*_lamp),vec3(.9)):_col*.012;        // stays under the bloom threshold: warm, never a white halo
      if(_on<.5&&_h1>.9)_room+=vec3(.16,.24,.55)*(.55+.45*sin(uBTime*9.+_h2*40.)*sin(uBTime*3.7+_h3*20.))*.14*exp(_h.z*.4); // TV glow
    }else{
      _room=_col*(.30+.16*_h4)*(.6+.4*exp(_h.z*.45));
    }
    // curtains just behind the glass (some windows)
    if(!_shop&&_h2<.28){float _cw=.35+.55*_h3;if(_o.x<_cw||_o.x>_W-_cw*(.6+.8*_h4)){vec3 _cc=mix(vec3(.75,.68,.55),vec3(.52,.58,.66),_h4);
      _room=mix(_room,uBNight>.5?min(_cc*max(texture2D(emissiveMap,vUv).rgb*.8,vec3(.01)),vec3(.85)):_cc*.42,.88);}}
    // far away the room detail would shimmer: fade it into its average
    float _px=length(fwidth(_cell));
    _room=mix(_room,uBNight>.5?texture2D(emissiveMap,vUv).rgb*.55:vec3(.15,.145,.14),smoothstep(.12,.35,_px));
    diffuseColor.rgb=mix(diffuseColor.rgb,vec3(.025,.03,.035),_wf);             // dark glass: the sun does not light the room
    totalEmissiveRadiance=mix(totalEmissiveRadiance,_room,_wf);
    _bfr=mix(1.,.1+.9*pow(1.-clamp(-dot(_V,_N),0.,1.),4.),_wf);                 // Fresnel: see in when facing, mirror at grazing angles
  }
}
`;
function patch(m){
  if(!m||m.userData.bldPatched)return;m.userData.bldPatched=true;
  const f=m.userData.facade||{nx:5,ny:12};
  const cells={value:new THREE.Vector2(f.nx,f.ny)};
  m.extensions=Object.assign(m.extensions||{},{derivatives:true});
  m.onBeforeCompile=sh=>{
    sh.uniforms.uCells=cells;sh.uniforms.uBNight=BU.uBNight;sh.uniforms.uBTime=BU.uBTime;
    sh.vertexShader=sh.vertexShader.replace('void main() {',VERT_DECL+'void main() {').replace('#include <project_vertex>','#include <project_vertex>\n'+VERT_BODY);
    sh.fragmentShader=sh.fragmentShader.replace('void main() {',FRAG_DECL+'void main() {')
      .replace('#include <emissivemap_fragment>','#include <emissivemap_fragment>\n'+FRAG_BODY)
      .replace('#include <envmap_fragment>',THREE.ShaderChunk.envmap_fragment.split('specularStrength * reflectivity').join('specularStrength * reflectivity * _bfr'));
  };
  m.customProgramCacheKey=()=>'bldInterior1';
  m.needsUpdate=true;
}
for(const m of nightWinMats)patch(m);
function sync(){BU.uBNight.value=isNight?1:0}
const _stod=setTimeOfDay;
setTimeOfDay=function(){const r=_stod.apply(this,arguments);try{sync()}catch(e){}return r};
sync();
// animate (TV flicker) cheaply: the uniform is shared by all facades
const _ros=renderOptimizedScene;
renderOptimizedScene=function(){BU.uBTime.value=performance.now()*.001;return _ros.apply(this,arguments)};
window.CITYP={BU,patch};
})();
