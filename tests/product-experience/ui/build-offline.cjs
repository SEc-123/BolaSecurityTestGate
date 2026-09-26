/** Explicit offline UI adapters. No browser network policy is changed.
 * Uses production TSX; memory transport, history, icons and installed React19 vendor are test adapters. */
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root=path.resolve(__dirname,'../../..'),out=path.resolve(process.env.BSTG_UI_ARTIFACT_DIR || path.join(root,'validation/business-experience/ui-assets'));
fs.mkdirSync(out,{recursive:true});
const globalRoot=cp.execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim();
const ts=require(process.env.BSTG_TYPESCRIPT_PATH || path.join(globalRoot,'typescript'));
const vendor=process.env.BSTG_UI_REACT_FIXTURE;
if(!vendor || !fs.existsSync(vendor))throw new Error('Set BSTG_UI_REACT_FIXTURE explicitly to the installed Playwright React19 shared viewer bundle. This is not a production React18 build.');
let source=fs.readFileSync(vendor,'utf8');
if(!source.includes('de.version="19.1.1"') || !source.includes('H as r'))throw new Error('Unexpected fixture version; do not silently use another React adapter.');
source=source.replace(/export\{[^}]+\};?\s*$/,'window.__fixtureReact=H;window.__fixtureReactDOM=s2;').replace(/import\.meta\.url/g,'"about:blank"');
fs.writeFileSync(path.join(out,'react19-fixture.js'),source);
const modules=new Map();function visit(file){if(modules.has(file))return;let text=fs.readFileSync(file,'utf8').replace(/import\.meta\.env/g,'({VITE_API_URL:""})');
const compiled=ts.transpileModule(text,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,jsxFactory:'__jsx',esModuleInterop:true}}).outputText;
modules.set(file,compiled);for(const match of compiled.matchAll(/require\("([^"\n]+)"\)/g)){const spec=match[1];if(!spec.startsWith('.'))continue;const base=path.resolve(path.dirname(file),spec);const actual=[base,base+'.ts',base+'.tsx',path.join(base,'index.ts')].find(f=>fs.existsSync(f)&&fs.statSync(f).isFile());if(!actual)throw new Error(`Missing module ${spec} from ${file}`);visit(actual);}}
visit(path.join(root,'src/App.tsx'));visit(path.join(root,'src/i18n/I18nProvider.tsx'));
const id=file=>'/'+path.relative(root,file).replaceAll(path.sep,'/');
let bundle='const __mods={},__cache={};\n';
for(const [file,code]of modules)bundle+=`__mods[${JSON.stringify(id(file))}]=function(require,module,exports){const React=window.__fixtureReact;const __jsx=React.createElement;\n${code}\n};\n`;
bundle+=`
const __icon=({size=18,...p})=>window.__fixtureReact.createElement('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','aria-hidden':true,...p},window.__fixtureReact.createElement('circle',{cx:12,cy:12,r:8}));
function __require(spec,from='/src/entry.tsx'){
 if(spec==='react')return window.__fixtureReact;
 if(spec==='react-dom/client')return window.__fixtureReactDOM;
 if(spec==='lucide-react')return new Proxy({},{get:(_,key)=>key==='__esModule'?true:__icon});
 let p=spec.startsWith('.')?new URL(spec,'https://fixture.invalid'+from).pathname:spec;
 const resolved=[p,p+'.ts',p+'.tsx',p+'/index.ts'].find(k=>__mods[k]);if(!resolved)throw Error('Missing fixture module '+p);
 if(__cache[resolved])return __cache[resolved].exports;
 const module={exports:{}};__cache[resolved]=module;__mods[resolved](s=>__require(s,resolved),module,module.exports);return module.exports;
}
const {assessmentApi}=__require('/src/lib/assessment-api.ts');
assessmentApi.image=()=>window.__fixtureImage;
const App=__require('/src/App.tsx').default;
const {I18nProvider}=__require('/src/i18n/I18nProvider.tsx');
let root;
window.__mountApp=()=>{root=window.__fixtureReactDOM.createRoot(document.getElementById('root'));root.render(window.__fixtureReact.createElement(I18nProvider,null,window.__fixtureReact.createElement(App)));};
window.__unmountApp=()=>{root.unmount();};window.__mountApp();
`;
fs.writeFileSync(path.join(out,'production-ui-offline.js'),bundle);
console.log(JSON.stringify({mode:'Explicit offline React19 / transport / history / icon adapters',modules:modules.size,output:out}));
