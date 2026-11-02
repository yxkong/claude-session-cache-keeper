import { defaults, validatePolicy } from '../core/contracts.mjs';
import product from '../core/product.json';
import releaseConfig from '../../release-config.json';
const api = window.cacheKeeper;
const $ = id => document.getElementById(id);
const phaseNames = { off: '已关闭', waiting: '等待建立缓存', working: '正常工作中', scheduled: '等待续热', sending: '正在续热', limit: '本轮次数用完', expired: '已错过窗口', tokens: '低于 token 门槛', miss: '未命中，已停止', error: '请求失败，已停止' };
const phaseNotes = {
  waiting: '已开启，但尚未记录有效缓存。下一次正常工作请求结束后开始倒计时。',
  scheduled: '已安排本条会话的下一次续热。正常工作请求会重新开始本轮计数。',
  sending: '正在发送本次续热请求。已发出的请求无法撤回，结果返回后再决定是否安排下一次。',
  limit: '已达到本轮尝试次数上限，暂停续热。下一次正常工作请求会重新计数。',
  expired: '已错过有效缓存窗口，停止本轮续热，等待下一次正常工作请求建立缓存。',
  tokens: '缓存规模低于配置的 token 门槛，暂不续热，等待下一次正常工作请求。',
  miss: '最近一次续热未命中缓存，已停止本轮，避免继续重复写入缓存。下一次正常工作请求后重新判断。',
  error: '最近一次续热请求失败，已停止本轮。下一次正常工作请求后重新判断。'
};
let sessions = [], selected = null, editing = null, busy = false, installing = false;
let listSignature='';
let updateState=null, updateBusy=false, demo=false;
let guideStep=0, guideAutoChecked=false, guideSeen=false, guideSaving=false;
const drafts = new Map();
const fields = ['minimum', 'maximum', 'maximum-attempts', 'token-threshold'];
function tell(message, error = false) {
  $('notice').textContent = message; $('notice').className = 'notice' + (error ? ' error' : ''); $('notice').hidden = Boolean(document.querySelector('dialog[open]'));
  for(const kind of ['guide','about'])if($(kind+'-dialog').open){$(kind+'-feedback').textContent=message;$(kind+'-feedback').className='support-feedback'+(error?' error':'');}
}
function getSelected() { return sessions.find(s => s.id === selected); }
function readDraft() { return { minSeconds: $('minimum').valueAsNumber, maxSeconds: $('maximum').valueAsNumber, maxAttempts: $('maximum-attempts').valueAsNumber, minCachedTokens: $('token-threshold').valueAsNumber }; }
function validDraft() { return validatePolicy(readDraft()); }
function currentPhase(s) {
  if(!s.online)return '会话离线';
  const keeper=s.enabled ? '保活已开启' : '保活已关闭';
  if(s.busy)return `工作中 · ${keeper}${s.current ? '' : ' · 旧版连接'}`;
  if(!s.current)return `在线 · 旧版连接 · ${keeper}`;
  return s.pending ? '在线 · 设置同步中' : `在线 · ${s.enabled ? phaseNames[s.phase] || keeper : keeper}`;
}
function basename(p) { return p.split(/[\\/]/).filter(Boolean).at(-1) || p; }
function fmt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
function renderList() {
  const query = $('search').value.trim().toLowerCase();
  const list = sessions.filter(s => ($('offline').checked || s.online) && `${s.title} ${s.project} ${s.sessionId}`.toLowerCase().includes(query));
  list.sort((a, b) => Number(b.online) - Number(a.online) || a.title.localeCompare(b.title, 'zh-CN'));
  const signature=JSON.stringify([selected,query,$('offline').checked,list.map(s=>[s.id,s.title,s.project,s.sessionId,currentPhase(s),s.enabled,s.online,s.current,s.phase])]);
  if (signature===listSignature) return;
  listSignature=signature;
  const focusedSession=document.activeElement?.dataset?.sessionId;
  const fragment = document.createDocumentFragment();
  for (const s of list) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'session-row' + (s.id === selected ? ' selected' : ''); row.setAttribute('aria-pressed', String(s.id === selected)); row.dataset.sessionId = s.sessionId;
    const phase = currentPhase(s);
    row.title = `${s.title}\n${s.project}\n${s.sessionId}\n${phase}`;
    row.setAttribute('aria-label',`${s.title}，${phase}，${basename(s.project)}，${s.sessionId}`);
    const name = document.createElement('span'); name.className='session-name'; name.textContent=s.title; row.append(name);
    const dot = document.createElement('i');
    const tone = !s.online ? '' : s.busy ? ' working' : ' online';
    dot.className='session-dot'+tone; dot.title=phase; dot.setAttribute('aria-hidden','true'); row.append(dot);
    row.addEventListener('click', () => { if (selected!==s.id) $('notice').hidden=true; selected = s.id; render(); }); fragment.append(row);
  }
  if (!list.length) { const empty = document.createElement('p'); empty.className = 'empty-list'; empty.textContent = query ? '没有匹配的会话。' : '还没有在线连接。安装插件后，在目标 Code 会话重载。'; fragment.append(empty); }
  $('sessions').replaceChildren(fragment);
  if (focusedSession) [...$('sessions').children].find(row=>row.dataset.sessionId===focusedSession)?.focus({preventScroll:true});
}
function renderDetail() {
  const s = getSelected(); $('empty').hidden = Boolean(s); $('detail').hidden = !s; if (!s) return;
  if (editing !== s.id) {
    editing = s.id; const draft = drafts.get(s.id) || s.policy;
    for (const [id, value] of [['minimum', draft.minSeconds], ['maximum', draft.maxSeconds], ['maximum-attempts', draft.maxAttempts], ['token-threshold', draft.minCachedTokens]]) $(id).value = String(value);
  }
  $('session-title').textContent = s.title; $('project').textContent = s.project; $('model').textContent = s.model;
  $('executor').textContent = `执行器 ${s.pluginVersion || '旧版，未报告版本'}`; $('session-id').textContent = `ID ${s.sessionId.slice(0, 8)}`;
  $('phase').textContent = currentPhase(s); $('phase').className = 'phase' + (s.online ? s.busy ? ' blue' : s.enabled && s.current ? (['scheduled', 'sending'].includes(s.phase) ? ' green' : ' orange') : '' : '');
  const note = !s.online ? '这条连接已离线。会话重新连接后会生成新的连接，默认关闭保活。'
    : !s.current ? '这条连接仍在使用旧执行器，仅可停止。安装新版连接插件后，重载并核对版本；若无效，待任务结束后重启 Claude。'
    : s.busy ? (s.enabled ? '会话正在正常工作，无需额外续热。工作请求结束后再安排本轮保活。' : '会话正在正常工作，保活已关闭。在线状态与保活开关分别显示。')
    : s.pending ? '设置已发送，等待会话执行器确认。'
    : s.enabled ? phaseNotes[s.phase] || '只管理这条会话。下一次正常工作请求会重新开始本轮计数。'
    : '本条会话保活已关闭。应用设置并开启后，才会在有效缓存窗口内安排续热。';
  $('context-note').textContent = note; $('context-note').className = 'context-note' + (s.online && (!s.current || (s.enabled && !s.busy && !s.pending && ['expired', 'miss', 'error'].includes(s.phase))) ? ' warning' : '');
  $('attempts').textContent = `${s.attempts} / ${s.policy.maxAttempts}`;
  $('countdown').textContent = s.enabled && s.phase === 'scheduled' ? `${Math.max(0, Math.ceil((s.nextAt - Date.now()) / 1000))} 秒后` : '—';
  $('last-result').textContent = s.lastHit === true ? '最近一次续热命中缓存' : s.lastHit === false ? '最近一次未命中，已停止' : '本轮尚无续热结果';
  for (const [id, value] of [['cache-size', s.cacheTokens], ['cache-reads', s.readTokens], ['cache-writes', s.writeTokens], ['outputs', s.outputTokens]]) $(id).textContent = fmt(value);
  updateButtons();
}
function updateButtons() {
  const s = getSelected(); if (!s) return;
  const valid = validDraft(); $('validation').textContent = valid ? '' : '间隔需为 30～280 秒的整数，最短不能大于最长；尝试次数需为正整数，token 门槛需为 0～1000 万的整数。';
  $('save').disabled = busy || !valid || !s.current;
  $('toggle').textContent = s.enabled ? '停止保活' : '应用设置并开启'; $('toggle').className = 'primary' + (s.enabled ? ' stop' : '');
  // Stop stays available even when a draft is invalid or the executor is old.
  $('toggle').disabled = busy || (!s.enabled && (!valid || !s.online || !s.current));
}
function render() { renderList(); renderDetail(); }
async function refresh() {
  try {
    const state = await api.state(); sessions = state.sessions;
    demo=Boolean(state.demo); if(state.updates){updateState=state.updates;renderUpdates();}
    if (!selected || !sessions.some(s => s.id === selected)) selected = sessions.find(s => s.online)?.id || sessions[0]?.id || null;
    document.body.classList.toggle('mac', state.platform === 'darwin');
    $('connection-count').textContent = `${state.demo ? '演示数据 · ' : ''}${sessions.filter(s => s.online).length} 个在线连接`;
    if (state.demo) { $('install').disabled = true; $('empty-install').disabled = true; }
    $('version').textContent = `CacheKeeper ${state.version}`;
    $('about-version').textContent=`版本 ${state.version}`;
    $('guide-install').disabled=demo || installing;
    if(state.guideSeen===true)guideSeen=true;
    if(!guideAutoChecked){guideAutoChecked=true;if(state.guideSeen===false)showGuide();}
    if (state.warnings?.length) tell(state.warnings.join('；'), true);
    render();
    await api.ready?.();
  } catch (e) { tell(e.message, true); }
}
async function save(enable, stopping = false) {
  const s = getSelected(); if (!s || busy) return;
  busy = true; updateButtons();
  try {
    const policy = stopping ? s.policy : readDraft();
    await api.save(s.id, { enabled: enable, policy }); drafts.set(s.id, { ...policy });
    tell(enable ? '设置已发送。有效缓存已建立时会安排续热；否则等待下一次正常工作请求。' : stopping ? '本条会话的后续续热已停止。' : '设置已保存，保活保持关闭。'); await refresh();
  } catch (e) { tell(e.message, true); }
  finally { busy = false; updateButtons(); }
}
async function install() {
  if (installing || demo) return; installing = true; $('install').disabled = true; $('empty-install').disabled = true; $('guide-install').disabled=true; $('install').textContent = '正在安装…';
  tell('正在安装本机连接插件。若检测到旧版，将先停止旧连接并停用旧插件，避免重复保活。');
  try { tell(await api.install()); await refresh(); } catch (e) { tell(e.message, true); }
  finally { installing = false; $('install').disabled = demo; $('empty-install').disabled = demo; $('guide-install').disabled=demo; $('install').textContent = '安装／更新连接插件'; }
}
for (const id of fields) $(id).addEventListener('input', () => { if (selected) drafts.set(selected, readDraft()); updateButtons(); });
$('policy-form').addEventListener('submit', e => { e.preventDefault(); const s = getSelected(); if (s) save(s.enabled); });
$('toggle').addEventListener('click', () => { const s = getSelected(); if (s) save(!s.enabled, s.enabled); });
$('refresh').addEventListener('click', refresh); $('search').addEventListener('input', renderList); $('offline').addEventListener('change', renderList);
$('install').addEventListener('click', install); $('empty-install').addEventListener('click', install);
async function copyReload(){try{await api.copyReload();tell('已复制 /reload-plugins，请在需要连接的 Claude Code 会话中粘贴发送。');}catch(e){tell(e.message,true);}}
$('copy-reload').addEventListener('click',copyReload);
$('docs').addEventListener('click',showGuide);
function renderUpdates() {
  const u=updateState || {}, a=u.app || {}, p=u.plugin || {};
  const pending=updateBusy || ['checking','downloading-app','downloading-plugin','installing-plugin','installing-app'].includes(u.phase);
  $('updates-source').textContent=u.repository ? `github.com/${u.repository}` : 'GitHub Release';
  $('app-update-version').textContent=`当前 ${a.current || '—'}${a.latest ? ` · 最新 ${a.latest}` : ''}${a.latest && !a.available ? ' · 已是最新或更高版本' : ''}`;
  $('plugin-update-version').textContent=`${p.current ? `已安装 ${p.current}` : 'current' in p ? '未安装或无法读取' : '尚未检查安装状态'} · 内置 ${p.bundled || '—'}${p.latest ? ` · 最新 ${p.latest}` : ''}`;
  $('app-update-mode').textContent=a.native ? '下载后，待任务结束再重启应用安装' : '此构建下载后手动安装';
  $('plugin-update-compatibility').textContent=p.compatible===false ? `需先将应用更新至 ${p.minimumApp} 或更高版本` : '安装后在目标会话手动重载，新连接默认关闭';
  $('app-download').disabled=demo || pending || !a.available || !a.downloadable || a.ready;
  $('app-apply').disabled=demo || pending || !a.ready;
  $('app-apply').textContent=a.native ? '重启应用安装' : '打开下载目录';
  $('plugin-download').disabled=demo || pending || !p.available || !p.compatible || p.ready;
  $('plugin-apply').disabled=demo || pending || !p.ready;
  $('update-check').disabled=pending;
  $('update-progress').hidden=!u.phase?.startsWith('downloading-');$('update-progress').value=u.progress || 0;
  $('update-cancel').hidden=!u.phase?.startsWith('downloading-');
  $('updates-message').textContent=u.message || '按需检查，下载后由你决定何时安装。';
  $('updates-message').className=u.phase==='error' ? 'update-error' : 'update-muted';
  $('release-notes').hidden=!u.notes;$('release-notes-text').textContent=u.notes || '';
}
async function updateAction(action) {
  if(updateBusy && action!=='cancel') return;
  if(action==='check')updateState={...updateState,phase:'checking',message:'正在检查 GitHub Release…'};
  if(action!=='cancel')updateBusy=true;renderUpdates();
  try { updateState=await api.update(action); }
  catch(e){updateState={...updateState,phase:'error',message:e.message};}
  finally{if(action!=='cancel')updateBusy=false;renderUpdates();}
}
function showUpdates(){openDialog('updates-dialog');renderUpdates();if((!updateState?.checkedAt || Date.now()-updateState.checkedAt>60000) && !updateBusy)updateAction('check');}
$('updates').addEventListener('click',showUpdates);
$('updates-close').addEventListener('click',()=>{const d=$('updates-dialog');if(d.close)d.close();else d.removeAttribute('open');});
for(const [id,action] of [['update-check','check'],['app-download','download-app'],['app-apply','apply-app'],['plugin-download','download-plugin'],['plugin-apply','apply-plugin'],['update-cancel','cancel'],['release-page','release']])$(id).addEventListener('click',()=>updateAction(action));
api.onShowUpdates?.(showUpdates);
function closeDialog(id){const d=$(id);if(d.close)d.close();else d.removeAttribute('open');}
function openDialog(id){for(const d of document.querySelectorAll('dialog[open]'))if(d.id!==id)closeDialog(d.id);const d=$(id);if(!d.open){if(d.showModal)d.showModal();else d.setAttribute('open','');}}
const guideTitles=['先安装连接插件','让目标会话连接进来','只开启你需要的会话'];
const guideDescriptions=['三步完成连接，之后按会话管理缓存续热。','每条会话独立连接，名称来自实际会话。','先从建议值开始，随时可以停止。'];
function renderGuide(){
  $('guide-default-interval').textContent=`${defaults.minSeconds}～${defaults.maxSeconds} 秒`;$('guide-default-attempts').textContent=`${defaults.maxAttempts} 次`;$('guide-default-tokens').textContent=defaults.minCachedTokens===0?'0 表示不限':`${defaults.minCachedTokens} token`;
  $('guide-title').textContent=guideTitles[guideStep];$('guide-description').textContent=guideDescriptions[guideStep];
  for(let i=0;i<3;i++)$('guide-panel-'+i).hidden=i!==guideStep;
  for(const button of document.querySelectorAll('[data-guide-step]')){if(Number(button.dataset.guideStep)===guideStep)button.setAttribute('aria-current','step');else button.removeAttribute('aria-current');}
  $('guide-back').disabled=guideStep===0 || guideSaving;
  $('guide-next').textContent=guideStep===2?'开始使用':'下一步';$('guide-next').disabled=guideSaving;$('guide-skip').disabled=guideSaving;
  $('guide-progress').textContent=`${guideStep+1} / 3`;
}
function showGuide(){guideStep=0;$('guide-feedback').textContent='';renderGuide();openDialog('guide-dialog');}
async function finishGuide(){
  if(guideSaving)return;guideSaving=true;renderGuide();let error;
  try{if(!guideSeen){await api.completeGuide();guideSeen=true;}}catch(e){error=`引导状态未能保存：${e.message}。你仍可继续使用，下次打开时会再次提示。`;}
  finally{guideSaving=false;closeDialog('guide-dialog');renderGuide();if(error)tell(error,true);}
}
function changeGuideStep(step){if(guideSaving)return;guideStep=step;$('guide-feedback').textContent='';renderGuide();$('guide-title').focus();}
function showAbout(){
  $('about-title').textContent=product.name;$('product-description').textContent=product.description;
  $('about-repository').textContent=releaseConfig.repository;$('wechat-name').textContent=product.wechatName;$('about-author').textContent=product.author;
  $('about-feedback').textContent='';openDialog('about-dialog');
}
async function openSupport(resource){try{if(resource==='docs')await api.openDocs();else await api.openResource(resource);}catch(e){tell(e.message,true);}}
async function copyWechat(){try{await api.copyWechat();tell(`已复制「${product.wechatName}」，在微信中搜索公众号名称即可找到。`);}catch(e){tell(e.message,true);}}
$('help').addEventListener('click',showGuide);$('about').addEventListener('click',showAbout);
$('github').addEventListener('click',()=>openSupport('repository'));
$('wechat').addEventListener('click',()=>{showAbout();$('about-wechat-copy').focus();});
$('guide-next').addEventListener('click',()=>guideStep===2?finishGuide():changeGuideStep(guideStep+1));
$('guide-back').addEventListener('click',()=>changeGuideStep(Math.max(0,guideStep-1)));
for(const button of document.querySelectorAll('[data-guide-step]'))button.addEventListener('click',()=>changeGuideStep(Number(button.dataset.guideStep)));
$('guide-skip').addEventListener('click',finishGuide);
$('guide-dialog').addEventListener('cancel',event=>{event.preventDefault();finishGuide();});
$('guide-install').addEventListener('click',install);$('guide-docs').addEventListener('click',()=>openSupport('docs'));$('guide-copy-reload').addEventListener('click',copyReload);
$('about-close').addEventListener('click',()=>closeDialog('about-dialog'));
$('about-github').addEventListener('click',()=>openSupport('repository'));$('about-issues').addEventListener('click',()=>openSupport('issues'));$('about-author').addEventListener('click',()=>openSupport('author'));
$('about-wechat-copy').addEventListener('click',copyWechat);$('about-help').addEventListener('click',showGuide);$('about-updates').addEventListener('click',showUpdates);
api.onShowHelp?.(showGuide);api.onShowAbout?.(showAbout);
setInterval(refresh, 2000); refresh();
