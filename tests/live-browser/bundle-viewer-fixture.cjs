/** Test-only CommonJS bundling of the unchanged production viewer and vendored noVNC.
 * The viewer entry receives explicit HTTP/WebSocket test bridges because the execution
 * environment prohibits browser navigation. noVNC pixels and backend HTTP/WS are real.
 */
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'../..');const ts=require(process.env.BSTG_TYPESCRIPT_PATH||path.join(cp.execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'));
const modules=new Map(),entry=path.join(root,'public/live-browser/viewer.js');
function visit(file){if(modules.has(file))return;const source=fs.readFileSync(file,'utf8');const code=ts.transpileModule(source,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true,allowJs:true}}).outputText;modules.set(file,code);for(const m of code.matchAll(/require\("([^"\n]+)"\)/g)){if(!m[1].startsWith('.'))throw Error('External module '+m[1]);visit(path.resolve(path.dirname(file),m[1]));}}
visit(entry);const id=f=>'/'+path.relative(root,f).replaceAll(path.sep,'/');let out='const __mods={},__cache={};\n';
for(const [file,code]of modules)out+=`__mods[${JSON.stringify(id(file))}]=function(require,module,exports){${file===entry?'const location=window.__testLocation,fetch=window.__testFetch,WebSocket=window.__testWebSocket;':''}\n${code}\n};\n`;
out+=`function __require(spec,from='/'){const p=new URL(spec,'https://fixture.invalid'+from).pathname;if(__cache[p])return __cache[p].exports;const m={exports:{}};__cache[p]=m;if(!__mods[p])throw Error('Missing '+p);__mods[p](s=>__require(s,p),m,m.exports);return m.exports;}window.__mountLiveViewer=__require('/public/live-browser/viewer.js').mountLiveViewer;`;
const target=process.argv[2]||path.join(root,'validation/live-browser/viewer-fixture.js');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,out);console.log(JSON.stringify({modules:modules.size,output:target,adapter:'entry HTTP/WS + location ONLY; noVNC remains actual code'}));
