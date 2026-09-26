/** Focused semantic typecheck, using installed TypeScript and explicit Node type directory.
 * Production React/Express/SQLite dependencies and full project build are NOT replaced. */
const cp=require('child_process'),path=require('path'),fs=require('fs');
const root=path.resolve(__dirname,'../..');const globalRoot=cp.execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim();
const tsc=path.join(process.env.BSTG_TYPESCRIPT_PATH||path.join(globalRoot,'typescript'),'lib/tsc.js');
const nodeTypes=process.env.BSTG_NODE_TYPES||path.join(root,'server/node_modules/@types');
if(!fs.existsSync(path.join(nodeTypes,'node/index.d.ts')))throw Error('Set BSTG_NODE_TYPES to a directory containing installed @types/node, or install server dependencies.');
const groups=[
 {name:'server core',mode:['--module','NodeNext','--moduleResolution','NodeNext'],files:['server/src/services/ai-scan/product-state-service.ts','server/src/services/ai-scan/product-event-hub.ts','server/src/services/ai-scan/product-stream.ts','server/src/services/ai-scan/browser/live-observer.ts']},
 {name:'frontend non-React core',mode:['--module','ESNext','--moduleResolution','bundler'],files:['src/lib/assessment-feed.ts','src/lib/business-report.ts']}
];
for(const group of groups){console.log(`Semantic typecheck: ${group.name}; NOT full project build`);const result=cp.spawnSync(process.execPath,[tsc,'--noEmit','--strict','--skipLibCheck','--target','ES2022','--lib','ES2022,DOM','--typeRoots',nodeTypes,...group.mode,...group.files],{cwd:root,stdio:'inherit'});if(result.status!==0)process.exitCode=1;}
