const fs=require('fs'),path=require('path');
const tw=process.env.BSTG_TAILWIND_FIXTURE;
if(!tw)throw Error('Set BSTG_TAILWIND_FIXTURE explicitly to Tailwind 4.1.10 directory; fixture only, not production Tailwind3.');
const {compile}=require(tw+'/dist/lib.js');
const root=path.resolve(__dirname,'../../..');let tokens=new Set();function walk(p){for(const d of fs.readdirSync(p,{withFileTypes:true})){const f=path.join(p,d.name);if(d.isDirectory())walk(f);else if(/\.(tsx|ts)$/.test(f)){for(const t of fs.readFileSync(f,'utf8').split(/[\s"'`{}<>]+/))tokens.add(t);}}}walk(path.join(root,'src'));
const theme=fs.readFileSync(path.join(tw,'theme.css'),'utf8');
let css=fs.readFileSync(path.join(root,'src/index.css'),'utf8').replace(/@tailwind (base|components);/g,'');
(async()=>{const build=await compile(theme+'\n'+fs.readFileSync(path.join(tw,'preflight.css'),'utf8')+'\n'+css);fs.writeFileSync(path.join(process.env.BSTG_UI_ARTIFACT_DIR || path.join(root,'validation/business-experience/ui-assets'),'visual-fixture.css'),build.build([...tokens]));console.log('Visual harness: installed Tailwind 4.1.10; NOT project Tailwind 3 production build.');})().catch(e=>{console.error(e);process.exitCode=1;});
