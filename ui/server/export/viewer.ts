// The viewer inlined into the HTML export: plain JavaScript on a 2D canvas, no dependency, no network.
export const VIEWER_CSS = `
:root{--bg:#fff;--fg:#1b1f24;--muted:#656d76;--line:#d0d7de;--panel:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--panel:#161b22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif;display:grid;grid-template-columns:1fr 320px;grid-template-rows:auto 1fr;height:100vh}
header{grid-column:1/-1;padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header input{padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);min-width:220px}
#notice{color:#9a6700;font-size:12px}canvas{width:100%;height:100%;display:block}
aside{border-left:1px solid var(--line);padding:10px 12px;overflow:auto;background:var(--panel);font-size:13px}
.tag{color:var(--muted);font-size:12px}li{cursor:pointer}ul{padding-left:16px}
@media (max-width:800px){body{grid-template-columns:1fr;grid-template-rows:auto 1fr 200px}aside{border-left:0;border-top:1px solid var(--line)}}
`;

export const VIEWER_JS = `
(function(){
var data=JSON.parse(document.getElementById('graph-data').textContent);
var COLORS={Package:'#8250df',Directory:'#bf8700',File:'#0969da',Function:'#1a7f37',Class:'#cf222e',Interface:'#bc4c00',Variable:'#57606a',Route:'#d1242f',EntryPoint:'#fb8500',Component:'#a475f9',Page:'#bf3989',Table:'#0550ae',DataModel:'#0a3069',EnvVar:'#116329',Store:'#1f883d'};
var canvas=document.getElementById('c'),ctx=canvas.getContext('2d');
var nodes=data.nodes.map(function(n,i){var a=2*Math.PI*i/Math.max(1,data.nodes.length);return{id:n.id,l:n.l,n:n.n,f:n.f,line:n.line,x:Math.cos(a)*Math.sqrt(data.nodes.length)*8+Math.random(),y:Math.sin(a)*Math.sqrt(data.nodes.length)*8+Math.random(),vx:0,vy:0}});
var byId={};nodes.forEach(function(n){byId[n.id]=n});
var edges=data.edges.map(function(e){return{s:byId[e.s],t:byId[e.t],k:e.k,w:e.w||1}}).filter(function(e){return e.s&&e.t});
var view={x:0,y:0,k:1},selected=null,found=null,ticks=0,fitted=false;
function resize(){var r=window.devicePixelRatio||1;canvas.width=canvas.clientWidth*r;canvas.height=canvas.clientHeight*r;draw()}
window.addEventListener('resize',resize);
function step(){
 var N=nodes.length,C=70,grid={},i,j,a,b;
 for(i=0;i<N;i++){a=nodes[i];var key=Math.floor(a.x/C)+','+Math.floor(a.y/C);(grid[key]||(grid[key]=[])).push(a);a.cx=Math.floor(a.x/C);a.cy=Math.floor(a.y/C)}
 for(i=0;i<N;i++){a=nodes[i];for(var gx=-1;gx<=1;gx++)for(var gy=-1;gy<=1;gy++){var cell=grid[(a.cx+gx)+','+(a.cy+gy)];if(!cell)continue;for(j=0;j<cell.length;j++){b=cell[j];if(b===a)continue;var dx=a.x-b.x,dy=a.y-b.y,d=dx*dx+dy*dy+0.01,f=500/d;a.vx+=dx*f;a.vy+=dy*f}}}
 edges.forEach(function(e){var dx=e.t.x-e.s.x,dy=e.t.y-e.s.y,d=Math.sqrt(dx*dx+dy*dy)+0.01,f=(d-40)*0.02;e.s.vx+=dx/d*f;e.s.vy+=dy/d*f;e.t.vx-=dx/d*f;e.t.vy-=dy/d*f});
 nodes.forEach(function(n){n.vx-=n.x*0.004;n.vy-=n.y*0.004;n.x+=Math.max(-20,Math.min(20,n.vx))*0.5;n.y+=Math.max(-20,Math.min(20,n.vy))*0.5;n.vx*=0.6;n.vy*=0.6})
}
function sx(x){return canvas.width/2+(x+view.x)*view.k*(window.devicePixelRatio||1)}
function sy(y){return canvas.height/2+(y+view.y)*view.k*(window.devicePixelRatio||1)}
function draw(){
 var r=window.devicePixelRatio||1,fg=getComputedStyle(document.body).color;
 ctx.clearRect(0,0,canvas.width,canvas.height);ctx.globalAlpha=nodes.length>800?0.1:0.35;ctx.strokeStyle=fg;ctx.lineWidth=r;
 edges.forEach(function(e){ctx.beginPath();ctx.moveTo(sx(e.s.x),sy(e.s.y));ctx.lineTo(sx(e.t.x),sy(e.t.y));ctx.stroke()});
 ctx.globalAlpha=1;ctx.font=(11*r)+'px system-ui';ctx.fillStyle=fg;
 nodes.forEach(function(n){ctx.fillStyle=COLORS[n.l]||'#6e7781';ctx.beginPath();ctx.arc(sx(n.x),sy(n.y),(n===selected||n===found?7:4)*r,0,6.3);ctx.fill();
  if(n===selected||n===found||(nodes.length<80&&view.k>0.6)){ctx.fillStyle=fg;ctx.fillText(n.n,sx(n.x)+8*r,sy(n.y)+4*r)}})
}
function fit(){
 if(!nodes.length)return;var x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
 nodes.forEach(function(n){x0=Math.min(x0,n.x);x1=Math.max(x1,n.x);y0=Math.min(y0,n.y);y1=Math.max(y1,n.y)});
 var r=window.devicePixelRatio||1,w=(x1-x0)||1,h=(y1-y0)||1;
 view.k=Math.max(0.02,Math.min(4,0.9*Math.min(canvas.width/r/w,canvas.height/r/h)));view.x=-(x0+x1)/2;view.y=-(y0+y1)/2}
function loop(){var t=Date.now();while(ticks<300&&Date.now()-t<12){step();ticks++}if(ticks<300||!fitted){fit();fitted=ticks>=300}draw();if(ticks<300)requestAnimationFrame(loop)}
function pick(ev){var r=window.devicePixelRatio||1,x=ev.offsetX*r,y=ev.offsetY*r,best=null,bd=144*r*r;nodes.forEach(function(n){var dx=sx(n.x)-x,dy=sy(n.y)-y,d=dx*dx+dy*dy;if(d<bd){bd=d;best=n}});return best}
var drag=null;
canvas.addEventListener('mousedown',function(e){drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y,moved:false}});
window.addEventListener('mouseup',function(e){if(drag&&!drag.moved&&e.target===canvas){select(pick(e))}drag=null});
window.addEventListener('mousemove',function(e){if(!drag)return;var dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;view.x=drag.vx+dx/view.k;view.y=drag.vy+dy/view.k;draw()});
canvas.addEventListener('wheel',function(e){e.preventDefault();view.k=Math.max(0.1,Math.min(8,view.k*(e.deltaY<0?1.15:0.87)));draw()},{passive:false});
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function select(n){
 selected=n;var d=document.getElementById('detail');
 if(!n){d.innerHTML='<p class="tag">Select a node.</p>';draw();return}
 var out=[],inn=[];edges.forEach(function(e){if(e.s===n)out.push(e);if(e.t===n)inn.push(e)});
 var list=function(t,a,k){return a.length?'<h4>'+t+' ('+a.length+')</h4><ul>'+a.slice(0,60).map(function(e){var o=e[k];return'<li data-id="'+esc(o.id)+'">'+esc(o.n)+' <span class="tag">'+esc(e.k)+'</span></li>'}).join('')+'</ul>':''};
 var decl=data.details&&data.details[n.id];
 d.innerHTML='<h3>'+esc(n.n)+'</h3><div class="tag">'+esc(n.l)+(n.f?' \\u00b7 '+esc(n.f)+(n.line?':'+n.line:''):'')+'</div>'
  +(decl?'<h4>Declarations ('+decl.length+')</h4><ul style="list-style:none;padding:0">'+decl.slice(0,300).map(function(x){return'<li>'+esc(x[1])+' <span class="tag">'+esc(x[0])+(x[2]?':'+x[2]:'')+'</span></li>'}).join('')+'</ul>':'')
  +list('Outgoing',out,'t')+list('Incoming',inn,'s');
 draw()
}
document.getElementById('detail').addEventListener('click',function(e){var li=e.target.closest('li[data-id]');if(li){var n=byId[li.getAttribute('data-id')];if(n){view.x=-n.x;view.y=-n.y;select(n)}}});
document.getElementById('q').addEventListener('input',function(e){var q=e.target.value.toLowerCase();found=null;if(q){for(var i=0;i<nodes.length;i++){if(nodes[i].n.toLowerCase().indexOf(q)>=0){found=nodes[i];break}}}
 if(found){view.x=-found.x;view.y=-found.y;select(found)}else draw()});
resize();loop();
})();
`;
