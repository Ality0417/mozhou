// 已构建服务的无模型冒烟：独立临时库、原创样本、本地 HTTP、重启持久性。
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { applyMigrations } from '../server/src/db/migrate.ts'
import { seedIfEmpty } from '../server/src/db/seed.ts'
import { writingFixtures } from '../tests/fixtures/novel-workbench.ts'
const root = dirname(dirname(fileURLToPath(import.meta.url))), entry = join(root,'out/main/server.js')
assert(existsSync(entry),'请先执行 pnpm build')
const dir = mkdtempSync(join(tmpdir(),'mozhou-smoke-'))
const db = new DatabaseSync(join(dir,'ai-novel-studio.db'),{ timeout:5000,enableForeignKeyConstraints:true })
applyMigrations(db); seedIfEmpty(db)
db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES ('cny_usd_rate_source','manual')").run()
assert.equal(db.prepare("SELECT COUNT(*) AS n FROM provider WHERE api_key_encrypted!=''").get().n,0)
db.close()
const token=randomUUID(), checks=[]
let child,base
async function start() {
  child=spawn(process.execPath,[entry],{cwd:root,env:{...process.env,AI_NOVEL_USER_DATA:dir,AI_NOVEL_PORT:'0',AI_NOVEL_APP_VERSION:'1.1.3',SERVER_TOKEN:token},stdio:['ignore','pipe','pipe']})
  base=await new Promise((resolve,reject)=>{
    let output=''
    const timer=setTimeout(()=>reject(Error('服务启动超时')),15000)
    child.on('error',error=>{clearTimeout(timer);reject(error)})
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`服务提前退出: ${code}`))})
    child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/listening on 127\.0\.0\.1:(\d+)/);if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}/api`)}})
    child.stderr.on('data',()=>undefined)
  })
}
async function stop() {
  if(!child||child.exitCode!==null)return
  const current=child
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{current.kill('SIGKILL');reject(Error('服务退出超时'))},5000);current.once('exit',()=>{clearTimeout(timer);resolve()});current.kill('SIGTERM')})
}
async function request(path,method='GET',body) {
  const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json','X-App-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})})
  assert(response.ok,`${method} ${path}: ${response.status} ${await response.clone().text()}`);return response
}
async function json(path,method,body){return(await request(path,method,body)).json()}
try {
  await start()
  assert.equal((await fetch(`${base}/health`)).status,403)
  assert.equal((await fetch(`${base}/health`,{headers:{'X-App-Token':token,Origin:'https://invalid.example'}})).status,403)
  assert.equal((await json('/health')).ok,true);assert.equal((await json('/settings/bootstrap')).hasApiKey,false)
  checks.push('已构建服务启动、鉴权和来源拒绝、无模型密钥')
  const records=[]
  for(const fixture of writingFixtures){
    const {id}=await json('/novels','POST',{inspiration:fixture.inspiration})
    await json(`/novels/${id}`,'PATCH',{title:fixture.title,genre:fixture.genre})
    await json(`/novels/${id}/writing-profile`,'PUT',{language:fixture.language,market:'offline test fixture',preset:'serial',targetChapterLength:1800,notes:'',export:{heading:'numbered',lineEnding:'crlf',utf8Bom:false,includeInspiration:false}})
    const chapter=await json(`/novels/${id}/chapters`,'POST',{title:fixture.chapterTitle})
    const body={content:fixture.content,status:'written',expectedContent:'',operationId:randomUUID()}
    assert.equal((await json(`/novels/${id}/chapters/${chapter.id}`,'PATCH',body)).currentContent,fixture.content)
    assert.equal((await json(`/novels/${id}/chapters/${chapter.id}`,'PATCH',body)).replayed,true)
    const conflict=await fetch(`${base}/novels/${id}/chapters/${chapter.id}`,{method:'PATCH',headers:{'Content-Type':'application/json','X-App-Token':token},body:JSON.stringify({...body,content:'stale edit',operationId:randomUUID()})})
    assert.equal(conflict.status,409)
    await json(`/novels/${id}/chapters/${chapter.id}/versions`,'POST',{note:'离线测试快照'})
    const preview=await json(`/novels/${id}/export-preview`);assert.equal(preview.inspiration,'');assert.equal(preview.chapters[0].content,fixture.content)
    for(const format of ['txt','md','epub','docx']){
      const bytes=Buffer.from(await(await request(`/novels/${id}/export?format=${format}`)).arrayBuffer());assert(bytes.length>100)
      if(format==='epub'||format==='docx')assert.equal(bytes.subarray(0,2).toString(),'PK')
      else{assert(!bytes.toString().includes(fixture.inspiration));assert(bytes.toString().includes(fixture.chapterTitle))}
    }
    assert((await json(`/novels/${id}/stats`)).total.words>100)
    records.push({id,chapterId:chapter.id,content:fixture.content,language:fixture.language})
    checks.push(`${fixture.id}: 项目→档案→章节→幂等保存→冲突保护→快照→四格式导出`)
  }
  await stop();await start()
  for(const record of records){assert.equal((await json(`/novels/${record.id}/writing-profile`)).profile.language,record.language);assert.equal((await json(`/novels/${record.id}/chapters/${record.chapterId}`)).chapter.content,record.content)}
  checks.push('关闭重启后两个项目的档案与正文完整保留')
  console.log(JSON.stringify({ok:true,modelCalls:0,checks},null,2))
}finally{await stop();rmSync(dir,{recursive:true,force:true})}
