import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const kind='standups';
const config={fitness:{callback:'addExercise',parser:'parseExercise'},reading:{callback:'addBook',parser:'parseReadingScript'},pm:{callback:'addTask',parser:'parseScript'},standups:{callback:'addItem',parser:'parseScript'}}[kind]!;
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('app.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='App') as ts.FunctionDeclaration;
const declaration=app.body!.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations]).find(n=>n.name.getText(ast)===config.callback)!;
const parser=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text===config.parser)!;
const code=ts.transpileModule(parser.getText(ast).replace(/^export /,'')+'\nconst '+declaration.getText(ast)+';\nreturn '+config.callback+';',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function harness(){
 let input='First draft',finish!:(saved:boolean)=>void;const attempts:any[][]=[],messages:string[]=[];
 const dependencies={useCallback:(fn:unknown)=>fn,persist:(records:any[])=>{attempts.push(records);return attempts.length===1?new Promise<boolean>(resolve=>{finish=resolve;}):Promise.resolve(false);},
  tasks:[],books:[],items:[],exercises:[],setInput:(next:string|((current:string)=>string))=>{input=typeof next==='function'?next(input):next;},announce:(message:string)=>messages.push(message),setInputError:()=>{},NUMERIC_INPUT_ERROR:'fixture',PAGE_INPUT_ERROR:'fixture',crypto:{randomUUID:()=> 'synthetic-record'}};
 const add=new Function(...Object.keys(dependencies),code)(...Object.values(dependencies));
 return{add,attempts,messages,input:()=>input,edit:(next:string)=>{input=next;},finish:(saved:boolean)=>finish(saved)};
}
for(const saved of[true,false])for(const draft of[null,'Second draft','','First draft '])test(`${kind}: ${saved?'saved':'refused'} Add with ${draft===null?'unchanged':JSON.stringify(draft)} composer`,async()=>{
 const page=harness(),pending=page.add('First draft');
 try{if(draft!==null)page.edit(draft);page.finish(saved);await pending;
  expect(page.input()).toBe(saved&&draft===null?'':draft??'First draft');expect(page.attempts).toHaveLength(1);expect(page.attempts[0]).toHaveLength(1);expect(page.attempts[0][0].title).toBe('First draft');expect(page.messages).toEqual(saved?['Added First draft']:[]);
 }finally{page.finish(false);await pending;}
});
test(kind+': a second Add refused during the pending save does not lose its draft when the first completes',async()=>{
 const page=harness(),pending=page.add('First draft');
 try{page.edit('Second draft');await page.add('Second draft');expect(page.input()).toBe('Second draft');page.finish(true);await pending;
  expect(page.input()).toBe('Second draft');expect(page.attempts).toHaveLength(2);expect(page.attempts[0][0].title).toBe('First draft');expect(page.attempts[1][0].title).toBe('Second draft');expect(page.messages).toEqual(['Added First draft']);
 }finally{page.finish(false);await pending;}
});
