// يبني أزرار اختيار السيارات تلقائياً من cars/*/config.js (اللانسر ثابتة في index.html)
(function(){
  var grid=document.getElementById('carGrid');
  if(!grid||!window.CAR_MENU)return;
  window.CAR_MENU.forEach(function(c){
    var b=document.createElement('button');
    b.className='time-option';b.type='button';
    b.setAttribute('role','radio');b.setAttribute('aria-checked','false');
    b.setAttribute('data-car',c.id);
    var s=document.createElement('span');s.className='ti';s.textContent=c.icon||'🚗';
    b.appendChild(s);b.appendChild(document.createTextNode(c.label));
    grid.appendChild(b);
  });
})();
