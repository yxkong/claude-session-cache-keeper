import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
const request=(command,args)=>invoke(command,args).catch(error=>{throw error instanceof Error?error:new Error(typeof error==='string'?error:JSON.stringify(error));});
// The renderer retains its existing interface; all privileged work stays in Rust.
window.cacheKeeper ??= Object.freeze({
  state: () => request('keeper_state'),
  save: (id, control) => request('keeper_save', { id, control }),
  install: () => request('keeper_install'),
  stopAll: () => request('keeper_stop_all'),
  copyReload: () => request('keeper_copy_reload'),
  openDocs: () => request('keeper_open_docs'),
  openResource: resource => request('keeper_open_resource', {resource}),
  copyWechat: () => request('keeper_copy_wechat'),
  completeGuide: () => request('keeper_complete_guide'),
  update: action => request('keeper_update', { action }),
  onShowUpdates: callback => listen('keeper:show-updates', callback),
  onShowHelp: callback => listen('keeper:show-help', callback),
  onShowAbout: callback => listen('keeper:show-about', callback),
  ready: () => request('keeper_frontend_ready'),
});
