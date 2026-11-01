import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
// Component tests exercise the production Rust bridge, not a JavaScript reimplementation.
export class BridgeRepository {
  constructor({roots,transcriptsRoot}){this.warnings=[];this.pending=new Map();this.seq=0;
    this.child=spawn(path.resolve('src-tauri/target/debug/examples/bridge-contract'+(process.platform==='win32'?'.exe':'')),[JSON.stringify(roots),transcriptsRoot],{stdio:['pipe','pipe','pipe']});
    let stderr='';this.child.stderr.on('data',b=>{stderr=(stderr+b).slice(-4000);});
    this.lines=createInterface({input:this.child.stdout});this.lines.on('line',line=>{const r=JSON.parse(line),p=this.pending.get(r.seq);if(!p)return;this.pending.delete(r.seq);clearTimeout(p.timer);r.error?p.reject(new Error(r.error)):p.resolve(r.value);});
    const fail=e=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();};
    this.child.on('error',fail);this.child.on('exit',code=>fail(new Error(`Rust bridge exited ${code}: ${stderr}`)));
  }
  request(payload){const seq=++this.seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(seq);reject(new Error('Rust contract request timed out'));},10000);this.pending.set(seq,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({...payload,seq})+'\n');});}
  async refresh(){const r=await this.request({method:'refresh'});this.warnings=r.warnings;return r.rows;}
  save(id,control){return this.request({method:'save',id,control});}
  stopAll({legacyOnly=false}={}){return this.request({method:'stopAll',legacyOnly});}
  async close(){this.child.stdin.end();this.lines.close();if(this.child.exitCode===null)await new Promise(resolve=>this.child.once('exit',resolve));}
}
