import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const hostName='in.legost.jev_browser';
export const extensionId=key=>createHash('sha256').update(Buffer.from(key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
const quote=s=>`'${s.replaceAll("'","'\\''")}'`;
export async function installNativeHost(root,release,{home=homedir(),platform=process.platform,config=process.env.JEV_CONFIG_FILE||join(home,'.config/jev-browser/.env')}={}) {
  const manifest=JSON.parse(await readFile(join(release,'chrome-extension/manifest.json'),'utf8'));
  const origin=`chrome-extension://${extensionId(manifest.key)}/`;
  const executable=join(root,'native-host');
  // Resolve current on each invocation, but keep the executable path stable across updates.
  await writeFile(executable,`#!/bin/sh\nexport JEV_CONFIG_FILE=${quote(config)}\nexec ${quote(process.execPath)} ${quote(join(root,'current/dist/src/native-host.js'))} "$@"\n`,{mode:0o700});
  await chmod(executable,0o700);
  const bases=platform==='darwin'?['Library/Application Support/Google/Chrome','Library/Application Support/Google/ChromeForTesting','Library/Application Support/Chromium']:['.config/google-chrome','.config/google-chrome-for-testing','.config/chromium'];
  for(const base of bases){
    const path=join(home,base,'NativeMessagingHosts',`${hostName}.json`);
    await mkdir(dirname(path),{recursive:true});
    await writeFile(path,JSON.stringify({name:hostName,description:'JEV Browser local connection',path:executable,type:'stdio',allowed_origins:[origin]},null,2)+'\n',{mode:0o600});
  }
  return {origin,executable};
}
