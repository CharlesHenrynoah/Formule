/**
 * Ponts injectés dans l'iframe sandboxée (sans allow-same-origin) de la mini-app :
 *  - window.mcp.call(tool, args)   → outils MCP externes autorisés (liste blanche, confirmation des écritures)
 *  - window.app.call(tool, args)   → backend MCP PROPRE à l'app (outils du contrat) ; window.app.onChange(cb)
 *  - window.agent.ask(msg, {onDelta, onTool, onUi, onConfirm, context}) → sous-agent de l'app (streaming)
 *      onUi(patch)          : l'agent modifie l'état du dashboard (filtres, scénario, focus d'un panneau)
 *      onConfirm(el, info)  : carte de confirmation INLINE à insérer dans le chat (sinon : boîte de dialogue du studio)
 *      onEvent(ev)          : tous les événements (plan de chantier, outils, CLI, itération…) pour les étapes repliables
 *  - window.agent.transcript() / saveTranscript(msgs) : le fil du chat survit au rechargement à chaud de l'aperçu
 *  - window.agent.onPipeline(cb) : progression de l'équipe (itération déléguée par le contremaître)
 *  - Chat HÉBERGÉ par le studio (onglet « Chat app ») : window.agent.hosted = true ; le panneau de chat de l'AppShell est
 *    masqué (dashboard pleine largeur), les ordres tapés dans le studio arrivent par « chat:order » (même chemin que
 *    les ordres dictés : onVoice), le fil repart par saveTranscript, window.agent.shell({agentName, commands})
 *    publie le nom du contremaître et ses commandes rapides. Les confirmations se font dans le studio (inline:false).
 *  - Voix (style Jarvis) : le micro et la synthèse vivent dans le studio (origine réelle, permission micro) ;
 *    window.agent.onVoice(cb) reçoit les ordres dictés, onVoiceState(cb) l'état (écoute, transcription en direct,
 *    niveau audio, parole), window.agent.voice('toggle'|'ptt-down'|'ptt-up'|'handsfree') pilote le micro.
 *    Barre espace maintenue (hors champ texte) = push-to-talk.
 * Tout passe par postMessage → studio (parent) → gateway. Le parent vérifie la source du message.
 *
 * Sécurité de la confirmation inline : la carte est rendue par CE script (exécuté avant le code de l'app)
 * dans un shadow DOM fermé ; seuls les clics réels (event.isTrusted) comptent et la réponse porte un nonce
 * que le code de l'app ne voit jamais (les messages du pont sont interceptés en premier,
 * stopImmediatePropagation). Le studio rejette toute réponse sans le bon nonce.
 */
const BRIDGE = `<style data-es-bridge>[data-testid="chat"]{display:none!important}.control-room{grid-template-columns:minmax(0,1fr)!important}</style><script data-es-bridge>(function(){var seq=0,pending={},listeners=[],pipes=[],voiceCbs=[],stateCbs=[],cards={},history=[],chatMode='agent';
var P=window.parent,post=function(m){P.postMessage(m,'*');},attach=Element.prototype.attachShadow;
function card(ev){var host=document.createElement('div');host.setAttribute('data-es-confirm',ev.callId);var root=attach.call(host,{mode:'closed'});
var st=document.createElement('style');st.textContent=':host{display:block}.c{font:13px/1.4 ui-sans-serif,system-ui;border:1px solid #f59e0b88;background:#1c1917cc;color:#fafaf9;border-radius:10px;padding:10px;margin:2px 0}.t{font-weight:600;color:#fbbf24;margin-bottom:4px}.a{font:11px ui-monospace,monospace;color:#d6d3d1;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;background:#0c0a09;border-radius:6px;padding:6px;margin:6px 0}.b{display:flex;gap:6px}button{flex:1;border:0;border-radius:6px;padding:6px 8px;font-weight:600;cursor:pointer}.y{background:#f59e0b;color:#1c1917}.n{background:#44403c;color:#fafaf9}.s{color:#a8a29e;font-size:12px}';
var c=document.createElement('div');c.className='c';var t=document.createElement('div');t.className='t';t.textContent='\\u26a0 Action à confirmer : '+ev.tool;
var a=document.createElement('div');a.className='a';try{a.textContent=JSON.stringify(ev.args,null,1)}catch(_){a.textContent=String(ev.args)}
var b=document.createElement('div');b.className='b';var y=document.createElement('button');y.className='y';y.textContent='Oui, exécuter';var n=document.createElement('button');n.className='n';n.textContent='Non';
var s=document.createElement('div');s.className='s';var done=false;
function answer(ok,e){if(done||!e||!e.isTrusted)return;done=true;b.remove();s.textContent=ok?'\\u2713 Confirmé':'\\u2717 Refusé';post({__es:'agent:confirm',callId:ev.callId,nonce:ev.nonce,ok:!!ok});}
cards[ev.callId]=function(ok){if(done)return;done=true;b.remove();s.textContent=(ok?'\\u2713 Confirmé':'\\u2717 Refusé')+' à la voix';};
y.addEventListener('click',function(e){answer(true,e)});n.addEventListener('click',function(e){answer(false,e)});
b.append(y,n);c.append(t,a,b,s);root.append(st,c);return host;}
window.addEventListener('message',function(e){var d=e.data;if(!d||!d.__es||e.source!==P)return;e.stopImmediatePropagation();
if(d.__es==='app:changed'){listeners.slice().forEach(function(cb){try{cb()}catch(_){}});return;}
if(d.__es==='chat:mode'){chatMode=d.mode==='ask'?'ask':'agent';return;}
if(d.__es==='voice:command'||d.__es==='chat:order'){if(d.mode==='ask'||d.mode==='agent')chatMode=d.mode;voiceCbs.slice().forEach(function(cb){try{cb(String(d.text||''))}catch(_){}});return;}
if(d.__es==='voice:state'){stateCbs.slice().forEach(function(cb){try{cb(d.state||{})}catch(_){}});return;}
if(d.__es==='agent:confirm:voice'){if(cards[d.callId])cards[d.callId](!!d.ok);return;}
if(d.__es==='pipeline:event'){pipes.slice().forEach(function(cb){try{cb(d.event)}catch(_){}});return;}
if(d.__es==='agent:event'&&pending[d.id]){var p=pending[d.id],ev=d.event||{};try{
if(ev.type==='delta'&&p.onDelta)p.onDelta(ev.text);
if((ev.type==='tool_call'||ev.type==='tool_result')&&p.onTool)p.onTool(ev);
if(ev.type==='ui'&&p.onUi)p.onUi(ev.patch||{});
if(ev.type==='confirm'&&ev.nonce&&p.onConfirm)p.onConfirm(card(ev),{tool:ev.tool,args:ev.args});
if(p.onEvent&&ev.type!=='delta'){var c=Object.assign({},ev);delete c.nonce;p.onEvent(c);}
}catch(_){}return;}
if(d.__es!=='mcp:result'||!pending[d.id])return;var q=pending[d.id];delete pending[d.id];if(d.ok)q.res(q.type==='app:call'?shape(d.data):d.data);else q.rej(new Error(d.error||'Erreur'));},true);
function send(type,payload,extra){return new Promise(function(res,rej){var id=++seq;pending[id]=Object.assign({res:res,rej:rej,type:type},extra||{});post(Object.assign({__es:type,id:id},payload));});}
function shape(data){var names=['items','issues','pullRequests','pull_requests','commits','rows','results','records','data'];
function rows(v){return Array.isArray(v)&&(v.length===0||(v[0]&&typeof v[0]==='object'));}
function align(row){if(!row||typeof row!=='object')return;var pairs=[['created_at','createdAt'],['updated_at','updatedAt'],['merged_at','mergedAt'],['closed_at','closedAt'],['language','lang'],['count','nombre'],['week','semaine']];
for(var i=0;i<pairs.length;i++){var a=pairs[i][0],b=pairs[i][1];var av=row[a],bv=row[b];
if(bv==null&&(typeof av==='string'||typeof av==='number'))row[b]=av;if(av==null&&(typeof bv==='string'||typeof bv==='number'))row[a]=bv;}
if(row.date==null&&typeof row.week==='string')row.date=row.week;
var login=typeof row.author==='string'?row.author:(row.author&&row.author.login?String(row.author.login):(typeof row.user==='string'?row.user:(row.user&&row.user.login?String(row.user.login):'')));
if(login){row.author=login;if(row.user==null||typeof row.user!=='object')row.user={login:login};else if(!row.user.login)row.user.login=login;}
if(row.author==null&&typeof row.key==='string')row.author=row.key;
if(row.count==null&&row.key!=null&&typeof row.total==='number')row.count=row.total;
if(typeof row.owner==='string'&&typeof row.repo==='string'&&row.repo.indexOf('/')<0){var full=row.owner+'/'+row.repo;if(row.repository==null)row.repository=full;if(row.full_name==null)row.full_name=full;}
if((typeof row.merged_at==='string'||typeof row.mergedAt==='string')&&(row.state==null||String(row.state).toLowerCase()==='closed'))row.state='merged';
var dotted=Object.keys(row);for(var d=0;d<dotted.length;d++){var key=dotted[d];if(key.indexOf('.')<0)continue;var parts=key.split('.'),cur=row;
for(var j=0;j<parts.length-1;j++){if(!cur[parts[j]]||typeof cur[parts[j]]!=='object')cur[parts[j]]={};cur=cur[parts[j]];}
if(cur[parts[parts.length-1]]==null)cur[parts[parts.length-1]]=row[key];}}
function totals(obj){if(obj.total==null&&typeof obj.totalCount==='number')obj.total=obj.totalCount;if(obj.totalCount==null&&typeof obj.total==='number')obj.totalCount=obj.total;}
if(Array.isArray(data))data={items:data,totalCount:data.length};if(!data||typeof data!=='object')return data;
var lists=[];for(var n=0;n<names.length;n++)if(rows(data[names[n]]))lists.push(data[names[n]]);
if(!lists.length){var keys=Object.keys(data),extra=[];for(var k=0;k<keys.length;k++)if(names.indexOf(keys[k])<0&&rows(data[keys[k]]))extra.push(data[keys[k]]);
if(extra.length===1)lists=extra;else{var identity=false;for(var h=0;h<keys.length;h++)if(keys[h]==='login'||keys[h]==='full_name'||keys[h].indexOf('.')>=0)identity=true;
if(!identity){totals(data);return data;}var row={};for(var c=0;c<keys.length;c++)row[keys[c]]=data[keys[c]];align(row);data.items=[row];lists=[data.items];}}
var primary=lists[0];for(var p=0;p<lists.length;p++)if(lists[p].length){primary=lists[p];break;}
for(var r=0;r<primary.length;r++)align(primary[r]);
for(var m=0;m<names.length;m++)if(!rows(data[names[m]]))data[names[m]]=primary;
if(data.totalCount==null)data.totalCount=primary.length;totals(data);return data;}
window.mcp={call:function(tool,args){return send('mcp:call',{tool:String(tool),args:args||{}});},tools:function(){return send('mcp:tools',{});}};
window.app={call:function(tool,args){return send('app:call',{tool:String(tool),args:args||{}});},tools:function(){return send('app:tools',{});},
onChange:function(cb){listeners.push(cb);return function(){listeners=listeners.filter(function(x){return x!==cb;});};}};
window.agent={ask:function(message,opts){opts=opts||{};var h=history.slice(-8);history.push({role:'user',content:String(message)});var ctx;try{ctx=opts.context?JSON.stringify(opts.context).slice(0,3000):undefined}catch(_){}
var mode=(opts.mode==='ask'||opts.mode==='agent')?opts.mode:chatMode;
return send('agent:ask',{message:String(message),history:h,context:ctx,inline:false,mode:mode},{onDelta:opts.onDelta,onTool:opts.onTool,onUi:opts.onUi,onConfirm:opts.onConfirm,onEvent:opts.onEvent}).then(function(t){history.push({role:'assistant',content:String(t||'')});return t;});},
setMode:function(m){chatMode=m==='ask'?'ask':'agent';},mode:function(){return chatMode;},
reset:function(){history=[];},hosted:true,
shell:function(info){try{info=info||{};post({__es:'chat:shell',agentName:String(info.agentName||''),commands:(info.commands||[]).map(String).slice(0,6)})}catch(_){}},
transcript:function(){return send('chat:load',{});},saveTranscript:function(m){try{post({__es:'chat:save',messages:JSON.parse(JSON.stringify(m||[])).slice(-80)})}catch(_){}},
onPipeline:function(cb){pipes.push(cb);return function(){pipes=pipes.filter(function(x){return x!==cb;});};},
onVoice:function(cb){voiceCbs.push(cb);return function(){voiceCbs=voiceCbs.filter(function(x){return x!==cb;});};},
onVoiceState:function(cb){stateCbs.push(cb);return function(){stateCbs=stateCbs.filter(function(x){return x!==cb;});};},
voice:function(cmd){post({__es:'voice:control',cmd:String(cmd)});}};
function editable(t){return t&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));}
window.addEventListener('keydown',function(e){if(e.code==='Space'&&!e.repeat&&!editable(e.target)){e.preventDefault();post({__es:'voice:control',cmd:'ptt-down'});}},true);
window.addEventListener('keyup',function(e){if(e.code==='Space'&&!editable(e.target)){post({__es:'voice:control',cmd:'ptt-up'});}},true);
window.addEventListener('error',function(e){var m=String((e.error&&e.error.message)||e.message||e);post({__es:'app:error',message:m});});
})();</script>`;

/** Chart.js ne dessine pas dans un div : l'hôte des new Chart devient un canvas. */
export function repairChartHosts(html: string): string {
  const ids = new Set<string>();
  for (const match of html.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (new RegExp(`new\\s+Chart\\(\\s*${match[1]}\\b`).test(html)) ids.add(match[2]);
  }
  for (const match of html.matchAll(/new\s+Chart\(\s*document\.getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) ids.add(match[1]);
  let out = html;
  for (const id of ids) {
    const open = new RegExp(`<div(\\s[^>]*\\bid=["']${id}["'][^>]*)>`, 'i');
    if (!open.test(out)) continue;
    out = out.replace(open, '<canvas$1>');
    out = out.replace(new RegExp(`(<canvas\\s[^>]*\\bid=["']${id}["'][^>]*>)\\s*</div>`, 'i'), '$1</canvas>');
  }
  return out;
}

export function withBridge(html: string) {
  if (!html) return '';
  const page = repairChartHosts(html);
  if (/<head[^>]*>/i.test(page)) return page.replace(/<head[^>]*>/i, (m) => `${m}\n${BRIDGE}`);
  return BRIDGE + page;
}

export const SANDBOX = 'allow-scripts allow-forms allow-modals';
