import { readFile, writeFile } from 'node:fs/promises';
const target=process.argv[2];
if(!target){console.error('Usage: node scripts/configure-vercel.mjs https://YOUR-SERVICE.onrender.com');process.exit(1);}
const url=new URL(target);
if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash){throw Error('Provide an HTTPS backend origin with no path, credentials, query, or fragment.');}
const file=new URL('../frontend/vercel.json',import.meta.url);
const config=JSON.parse(await readFile(file,'utf8'));
config.rewrites[0].destination=`${url.origin}/api/:path*`;
config.rewrites[1].destination=`${url.origin}/socket.io/:path*`;
await writeFile(file,JSON.stringify(config,null,2)+'\n');
console.log('Vercel API and Socket.IO proxy destinations configured.');
