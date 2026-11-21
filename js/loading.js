window.__loading=(function(){
  var el=document.getElementById('loadingScreen'),bar=document.getElementById('ldBar'),txt=document.getElementById('ldText'),done=false,failed=false;
  function set(p,t){if(done||failed)return;bar.style.width=Math.round(Math.max(0,Math.min(1,p))*100)+'%';if(t)txt.textContent=t}
  function fail(m){if(done)return;failed=true;el.classList.add('err');txt.textContent=m}
  function finish(){
    if(done||failed)return;done=true;bar.style.width='100%';txt.textContent='جاري التجهيز النهائي...';
    requestAnimationFrame(function(){setTimeout(function(){
      try{if(typeof warmUpGraphics==='function')warmUpGraphics()}catch(e){console.warn(e)}
      el.classList.add('fade');setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el)},500);
    },80)});
  }
  addEventListener('error',function(e){
    var t=e.target;
    if(t&&t.tagName==='SCRIPT'&&t.src)fail('تعذر تحميل مكتبات اللعبة؛ تأكد من اتصال الإنترنت ثم أعد فتح اللعبة.');
    else if(typeof THREE==='undefined')fail('تعذر تحميل اللعبة؛ تأكد من اتصال الإنترنت ثم أعد فتح اللعبة.');
  },true);
  set(.12,'جاري تحميل المكتبات...');
  return{set:set,finish:finish,fail:fail};
})();
