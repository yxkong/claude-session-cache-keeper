const fs=require('node:fs');
const yaml=require('js-yaml');
// GitHub supplies absent secrets as empty strings; builder treats an empty
// CSC_LINK as a filesystem path, rather than an unsigned build.
if(process.env.CSC_LINK==='')delete process.env.CSC_LINK;
const config=yaml.load(fs.readFileSync(require('node:path').join(__dirname,'electron-builder.yml'),'utf8'));
const release=require('./release-config.json');
const [owner,repo]=release.repository.split('/');
config.publish={provider:'github',owner,repo,private:false,releaseType:'release'};
if(process.env.CACHE_KEEPER_NATIVE_UPDATES==='1' && process.platform==='darwin'){
  delete config.mac.identity;
  config.forceCodeSigning=true;config.mac.hardenedRuntime=true;config.mac.notarize=true;
  if(!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID)throw new Error('Signed macOS releases require notarization credentials.');
}
if(process.env.CACHE_KEEPER_NATIVE_UPDATES==='1' && process.platform==='win32')config.forceCodeSigning=true;
module.exports=config;
