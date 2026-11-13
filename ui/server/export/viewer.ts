// The viewer inlined into the HTML export: plain JavaScript on a 2D canvas, no dependency, no network.
export const VIEWER_CSS = `
:root{--bg:#fbf8f2;--fg:#1a1613;--muted:#655c51;--line:#ddd5c7;--panel:#f6f1e7}
@media (prefers-color-scheme:dark){:root{--bg:#14110f;--fg:#f4efe6;--muted:#a69e92;--line:#3a342e;--panel:#1b1815}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.4 system-ui,sans-serif;display:grid;grid-template-columns:1fr 320px;grid-template-rows:auto 1fr;height:100vh}
header{grid-column:1/-1;padding:8px 12px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
header input{padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);min-width:220px}
#notice{color:#9a6700;font-size:12px}canvas{width:100%;height:100%;display:block}
aside{border-left:1px solid var(--line);padding:10px 12px;overflow:auto;background:var(--panel);font-size:13px}
.tag{color:var(--muted);font-size:12px}li{cursor:pointer}ul{padding-left:16px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}
#legend{position:absolute;left:12px;bottom:12px;display:flex;flex-wrap:wrap;gap:4px 12px;max-width:60%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:12px;color:var(--muted)}
#legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}#legend b{color:var(--fg);font-weight:600}
main{position:relative;min-height:0}
@media (max-width:800px){body{grid-template-columns:1fr;grid-template-rows:auto 1fr 200px}aside{border-left:0;border-top:1px solid var(--line)}}
`;

export const VIEWER_JS = `
(function(){
var data=JSON.parse(document.getElementById('graph-data').textContent);
var COLORS=data.colors||{},ECOL=data.edgeColors||{};
var canvas=document.getElementById('c'),ctx=canvas.getContext('2d');
var nodes=data.nodes.map(function(n){return{id:n.id,l:n.l,n:n.n,f:n.f,line:n.line,g:n.g,d:n.d,x:n.x,y:n.y,vx:0,vy:0,r:1.2+Math.min(5,0.7*Math.sqrt(n.d))}});
var byId={};nodes.forEach(function(n){byId[n.id]=n});
var edges=data.edges.map(function(e){return{s:byId[e.s],t:byId[e.t],k:e.k,c:e.c,w:e.w||1}}).filter(function(e){return e.s&&e.t});
var clusters=data.clusters||[],cl={};clusters.forEach(function(c){cl[c.key]=c});
var byDegree=nodes.slice().sort(function(a,b){return b.d-a.d});
var view={x:0,y:0,k:1},kFit=1,selected=null,found=null,ticks=0,TICKS=140,fitted=false;
function dpr(){return window.devicePixelRatio||1}
function resize(){canvas.width=canvas.clientWidth*dpr();canvas.height=canvas.clientHeight*dpr();draw()}
window.addEventListener('resize',resize);
// Each folder relaxes inside the disc the server reserved for it; only its own relationships pull.
function step(){
 var N=nodes.length,C=22,grid={},i,j,a,b;
 for(i=0;i<N;i++){a=nodes[i];a.cx=Math.floor(a.x/C);a.cy=Math.floor(a.y/C);var key=a.g+'|'+a.cx+','+a.cy;(grid[key]||(grid[key]=[])).push(a)}
 for(i=0;i<N;i++){a=nodes[i];for(var gx=-1;gx<=1;gx++)for(var gy=-1;gy<=1;gy++){var cell=grid[a.g+'|'+(a.cx+gx)+','+(a.cy+gy)];if(!cell)continue;for(j=0;j<cell.length;j++){b=cell[j];if(b===a)continue;var dx=a.x-b.x,dy=a.y-b.y,d=Math.sqrt(dx*dx+dy*dy)+0.05,f=30/(d*d);a.vx+=dx/d*f;a.vy+=dy/d*f}}}
 edges.forEach(function(e){if(e.s.g!==e.t.g)return;var dx=e.t.x-e.s.x,dy=e.t.y-e.s.y,d=Math.sqrt(dx*dx+dy*dy)+0.05,f=(d-9)*0.03;e.s.vx+=dx/d*f;e.s.vy+=dy/d*f;e.t.vx-=dx/d*f;e.t.vy-=dy/d*f});
 nodes.forEach(function(n){var c=cl[n.g];if(!c)return;n.vx-=(n.x-c.x)*0.004;n.vy-=(n.y-c.y)*0.004;
  var sp=Math.sqrt(n.vx*n.vx+n.vy*n.vy);if(sp>3){n.vx*=3/sp;n.vy*=3/sp}
  n.x+=n.vx;n.y+=n.vy;n.vx*=0.55;n.vy*=0.55;
  var ox=n.x-c.x,oy=n.y-c.y,od=Math.sqrt(ox*ox+oy*oy);if(od>c.r){n.x=c.x+ox/od*c.r;n.y=c.y+oy/od*c.r}})
}
// After relaxing, spread each folder over its disc: the 90th percentile of the distances reaches 90% of the radius.
function normalise(){
 var members={};nodes.forEach(function(n){(members[n.g]||(members[n.g]=[])).push(n)});
 Object.keys(members).forEach(function(g){var c=cl[g],m=members[g];if(!c||m.length<3)return;
  var cx=0,cy=0;m.forEach(function(n){cx+=n.x;cy+=n.y});cx/=m.length;cy/=m.length;
  var ds=m.map(function(n){return Math.sqrt((n.x-cx)*(n.x-cx)+(n.y-cy)*(n.y-cy))}).sort(function(a,b){return a-b});
  var ref=ds[Math.min(ds.length-1,Math.floor(ds.length*0.9))]||1,k=0.9*c.r/ref;
  m.forEach(function(n){var x=(n.x-cx)*k,y=(n.y-cy)*k,d=Math.sqrt(x*x+y*y);if(d>c.r){x*=c.r/d;y*=c.r/d}n.x=c.x+x;n.y=c.y+y})})
}
function sx(x){return canvas.width/2+(x+view.x)*view.k*dpr()}
function sy(y){return canvas.height/2+(y+view.y)*view.k*dpr()}
function rgba(hex,a){var v=parseInt(String(hex).replace('#',''),16);return'rgba('+(v>>16&255)+','+(v>>8&255)+','+(v&255)+','+a+')'}
function isDark(){return window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches}
function draw(){
 var r=dpr(),css=getComputedStyle(document.body),fg=css.color,bg=css.backgroundColor,z=view.k/kFit,w=canvas.width,h=canvas.height;
 ctx.clearRect(0,0,w,h);
 // cluster discs
 clusters.forEach(function(c){ctx.beginPath();ctx.arc(sx(c.x),sy(c.y),c.r*view.k*r,0,6.3);ctx.fillStyle=isDark()?'rgba(255,255,255,0.025)':'rgba(0,0,0,0.025)';ctx.fill()});
 // edges: faint, the selected node's own ones strong
 var base=nodes.length>1500?0.07:0.14;if(isDark())base*=0.6;
 ctx.lineWidth=r*0.7;
 edges.forEach(function(e){var hot=selected&&(e.s===selected||e.t===selected);if(selected&&!hot)return;ctx.strokeStyle=rgba(ECOL[e.c]||'#8c959f',hot?0.9:base);ctx.lineWidth=(hot?1.6:0.7)*r;ctx.beginPath();ctx.moveTo(sx(e.s.x),sy(e.s.y));ctx.lineTo(sx(e.t.x),sy(e.t.y));ctx.stroke()});
 if(selected){ctx.lineWidth=r*0.7;edges.forEach(function(e){if(e.s===selected||e.t===selected)return;ctx.strokeStyle=rgba(ECOL[e.c]||'#8c959f',base*0.5);ctx.beginPath();ctx.moveTo(sx(e.s.x),sy(e.s.y));ctx.lineTo(sx(e.t.x),sy(e.t.y));ctx.stroke()})}
 // nodes
 nodes.forEach(function(n){var px=sx(n.x),py=sy(n.y);if(px<-20||py<-20||px>w+20||py>h+20)return;var big=n===selected||n===found;ctx.fillStyle=COLORS[n.l]||'#6e7781';ctx.beginPath();ctx.arc(px,py,(big?n.r+3:n.r*Math.min(2.2,Math.max(0.8,Math.sqrt(z))))*r,0,6.3);ctx.fill();if(big){ctx.strokeStyle=fg;ctx.lineWidth=2*r;ctx.stroke()}});
 // labels of the most connected nodes appear as you zoom in
 ctx.font='500 '+(11*r)+'px system-ui';ctx.textBaseline='middle';
 var shown=0,minD=Math.max(1,Math.round(40/Math.max(z,0.01)));
 if(z>1.8){for(var i=0;i<byDegree.length&&shown<160;i++){var n=byDegree[i];if(n.d<minD)break;var px=sx(n.x),py=sy(n.y);if(px<0||py<0||px>w||py>h)continue;label(n,px,py,fg,bg);shown++}}
 if(selected)label(selected,sx(selected.x),sy(selected.y),fg,bg);
 if(found&&found!==selected)label(found,sx(found.x),sy(found.y),fg,bg);
 // cluster names, fading out as you get close
 var o=Math.max(0,Math.min(1,1-(z-1.6)/2.2));
 if(o>0.02){ctx.font='700 '+(13*r)+'px system-ui';ctx.textAlign='center';clusters.forEach(function(c){var t=c.name,tw=ctx.measureText(t).width,px=sx(c.x),py=sy(c.y);ctx.globalAlpha=o;ctx.fillStyle=bg;ctx.beginPath();var rw=tw+16*r,rh=22*r;ctx.roundRect?ctx.roundRect(px-rw/2,py-rh/2,rw,rh,rh/2):ctx.rect(px-rw/2,py-rh/2,rw,rh);ctx.fill();ctx.fillStyle=fg;ctx.fillText(t,px,py);ctx.globalAlpha=1});ctx.textAlign='start'}
}
function label(n,px,py,fg,bg){var r=dpr(),t=n.n.indexOf('/')>=0?n.n.slice(n.n.lastIndexOf('/')+1):n.n;if(t.length>36)t=t.slice(0,35)+'\\u2026';ctx.fillStyle=fg;ctx.fillText(t,px+(n.r+4)*r,py)}
function fit(){
 if(!nodes.length)return;var x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
 clusters.forEach(function(c){x0=Math.min(x0,c.x-c.r);x1=Math.max(x1,c.x+c.r);y0=Math.min(y0,c.y-c.r);y1=Math.max(y1,c.y+c.r)});
 if(x0>x1)nodes.forEach(function(n){x0=Math.min(x0,n.x);x1=Math.max(x1,n.x);y0=Math.min(y0,n.y);y1=Math.max(y1,n.y)});
 var r=dpr(),w=(x1-x0)||1,h=(y1-y0)||1;
 kFit=Math.max(0.02,Math.min(8,0.92*Math.min(canvas.width/r/w,canvas.height/r/h)));view.k=kFit;view.x=-(x0+x1)/2;view.y=-(y0+y1)/2}
function loop(){var t=Date.now();while(ticks<TICKS&&Date.now()-t<12){step();ticks++}if(ticks>=TICKS&&!fitted){normalise();fitted=true}draw();if(ticks<TICKS)requestAnimationFrame(loop)}
function pick(ev){var r=dpr(),x=ev.offsetX*r,y=ev.offsetY*r,best=null,bd=144*r*r;nodes.forEach(function(n){var dx=sx(n.x)-x,dy=sy(n.y)-y,d=dx*dx+dy*dy;if(d<bd){bd=d;best=n}});return best}
var drag=null;
canvas.addEventListener('mousedown',function(e){drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y,moved:false}});
window.addEventListener('mouseup',function(e){if(drag&&!drag.moved&&e.target===canvas){select(pick(e))}drag=null});
window.addEventListener('mousemove',function(e){if(!drag)return;var dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;view.x=drag.vx+dx/view.k;view.y=drag.vy+dy/view.k;draw()});
canvas.addEventListener('wheel',function(e){e.preventDefault();view.k=Math.max(kFit*0.5,Math.min(kFit*60,view.k*(e.deltaY<0?1.18:0.85)));draw()},{passive:false});
function esc(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function select(n){
 selected=n;var d=document.getElementById('detail');
 if(!n){d.innerHTML='<p class="tag">Select a node. Drag to pan, scroll to zoom.</p>';draw();return}
 var out=[],inn=[];edges.forEach(function(e){if(e.s===n)out.push(e);if(e.t===n)inn.push(e)});
 var list=function(t,a,k){return a.length?'<h4>'+t+' ('+a.length+')</h4><ul>'+a.slice(0,60).map(function(e){var o=e[k];return'<li data-id="'+esc(o.id)+'">'+esc(o.n)+' <span class="tag">'+esc(e.k)+'</span></li>'}).join('')+'</ul>':''};
 var decl=data.details&&data.details[n.id];
 d.innerHTML='<h3>'+esc(n.n)+'</h3><div class="tag"><span class="dot" style="background:'+(COLORS[n.l]||'#6e7781')+'"></span>'+esc(n.l)+(n.f?' \\u00b7 '+esc(n.f)+(n.line?':'+n.line:''):'')+'</div>'
  +(decl?'<h4>Declarations ('+decl.length+')</h4><ul style="list-style:none;padding:0">'+decl.slice(0,300).map(function(x){return'<li>'+esc(x[1])+' <span class="tag">'+esc(x[0])+(x[2]?':'+x[2]:'')+'</span></li>'}).join('')+'</ul>':'')
  +list('Outgoing',out,'t')+list('Incoming',inn,'s');
 draw()
}
function flyTo(n){view.x=-n.x;view.y=-n.y;view.k=Math.max(view.k,kFit*6)}
document.getElementById('detail').addEventListener('click',function(e){var li=e.target.closest('li[data-id]');if(li){var n=byId[li.getAttribute('data-id')];if(n){flyTo(n);select(n)}}});
document.getElementById('q').addEventListener('input',function(e){var q=e.target.value.toLowerCase();found=null;if(q){for(var i=0;i<nodes.length;i++){if(nodes[i].n.toLowerCase().indexOf(q)>=0){found=nodes[i];break}}}
 if(found){flyTo(found);select(found)}else draw()});
// legend: node kinds present
var kinds={};nodes.forEach(function(n){kinds[n.l]=(kinds[n.l]||0)+1});
var lg=document.getElementById('legend');
if(lg)lg.innerHTML=Object.keys(kinds).sort(function(a,b){return kinds[b]-kinds[a]}).map(function(k){return'<span><i style="background:'+(COLORS[k]||'#6e7781')+'"></i>'+esc(k)+' <b>'+kinds[k]+'</b></span>'}).join('');
resize();fit();loop();
})();
`;
