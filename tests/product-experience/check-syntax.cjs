/** Syntax-only check with explicit global TypeScript. Not a production typecheck/build. */
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'../..');
const ts=require(process.env.BSTG_TYPESCRIPT_PATH||path.join(cp.execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'));
const paths=[...new Set([...cp.execFileSync('git',['diff','--name-only','HEAD'],{cwd:root,encoding:'utf8'}).trim().split('\n'),...cp.execFileSync('git',['ls-files','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).trim().split('\n')])].filter(p=>/\.(tsx|ts)$/.test(p)&&!p.endsWith('.d.ts')&&fs.existsSync(path.join(root,p)));
const errors=[];
for(const file of paths){const r=ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{fileName:file,reportDiagnostics:true,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}});for(const d of r.diagnostics||[])if(d.category===ts.DiagnosticCategory.Error)errors.push({file,message:ts.flattenDiagnosticMessageText(d.messageText,' ')});}
console.log(JSON.stringify({mode:'syntax only; global TypeScript; NOT full typecheck',version:ts.version,files:paths,count:paths.length,errors},null,2));if(errors.length)process.exitCode=1;
