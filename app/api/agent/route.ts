import { createHash, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { and, asc, eq, inArray, lt, lte } from 'drizzle-orm'
import { z } from 'zod'
import { db, ensurePanelSchema } from '@/lib/db'
import { agentCommands, backups, consoleLogs, lostItems, managedDatabases, nodes, operationLogs, serverSchedules, servers, worlds } from '@/lib/db/schema'

const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
async function getNode(request:NextRequest){const id=request.headers.get('x-node-id');const token=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'');if(!id||!token)return null;const node=(await db.select().from(nodes).where(eq(nodes.id,id)).limit(1))[0];if(!node)return null;const actual=Buffer.from(hash(token));const expected=Buffer.from(node.agentTokenHash);return actual.length===expected.length&&timingSafeEqual(actual,expected)?node:null}

function nextScheduleAt(input:{cadence:string;timeOfDay?:string|null;weekday?:number|null;intervalMinutes?:number|null;timezoneOffsetMinutes?:number|null}, from=new Date()){
  const offset=Math.max(-840,Math.min(840,Number(input.timezoneOffsetMinutes??0)))
  if(input.cadence==='interval')return new Date(from.getTime()+Math.max(5,Math.min(10080,Number(input.intervalMinutes??60)))*60_000)
  const match=/^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(input.timeOfDay??'04:00'))
  const hour=Number(match?.[1]??4),minute=Number(match?.[2]??0)
  const localNow=new Date(from.getTime()-offset*60_000)
  let targetMs=Date.UTC(localNow.getUTCFullYear(),localNow.getUTCMonth(),localNow.getUTCDate(),hour,minute)+offset*60_000
  if(input.cadence==='weekly'){
    const wanted=Math.max(0,Math.min(6,Number(input.weekday??0)))
    let diff=(wanted-localNow.getUTCDay()+7)%7
    if(diff===0&&targetMs<=from.getTime())diff=7
    targetMs+=diff*86_400_000
  }else if(targetMs<=from.getTime())targetMs+=86_400_000
  return new Date(targetMs)
}

async function dispatchDueSchedules(nodeId:string,nodeUserId:string){
  const serverRows=await db.select({id:servers.id,status:servers.status,memoryMb:servers.memoryMb,loader:servers.loader,mcVersion:servers.mcVersion,loaderVersion:servers.loaderVersion,port:servers.port,worldName:servers.worldName}).from(servers).where(and(eq(servers.nodeId,nodeId),inArray(servers.status,['ready','stopped','running','crashed','failed'])))
  if(!serverRows.length)return
  const byId=new Map(serverRows.map(row=>[row.id,row]))
  const now=new Date()
  const due=await db.select().from(serverSchedules).where(and(eq(serverSchedules.enabled,true),inArray(serverSchedules.serverId,serverRows.map(row=>row.id)),lte(serverSchedules.nextRunAt,now))).orderBy(asc(serverSchedules.nextRunAt)).limit(10)
  for(const schedule of due){
    const server=byId.get(schedule.serverId)
    if(!server)continue
    const nextRunAt=nextScheduleAt(schedule,new Date(now.getTime()+1000))
    const claimed=await db.update(serverSchedules).set({lastRunAt:now,nextRunAt,updatedAt:new Date()}).where(and(eq(serverSchedules.id,schedule.id),lte(serverSchedules.nextRunAt,now))).returning({id:serverSchedules.id})
    if(!claimed[0])continue
    if(schedule.taskType==='log-cleanup'){
      const payload=(schedule.payload??{}) as Record<string,unknown>
      const retentionDays=Math.max(1,Math.min(365,Number(payload.retentionDays??30)))
      const cutoff=new Date(Date.now()-retentionDays*86_400_000)
      await db.delete(consoleLogs).where(and(eq(consoleLogs.serverId,server.id),lt(consoleLogs.createdAt,cutoff)))
      await db.insert(operationLogs).values({userId:nodeUserId,serverId:server.id,operation:'scheduled-log-cleanup',status:'completed',message:`${retentionDays} günden eski günlükler temizlendi`})
      continue
    }
    const type=schedule.taskType==='backup'?'backup':'restart'
    if(type==='restart'&&server.status!=='running'){
      await db.insert(operationLogs).values({userId:nodeUserId,serverId:server.id,operation:'scheduled-restart',status:'completed',message:'Sunucu çalışmadığı için zamanlanmış restart atlandı'})
      continue
    }
    const existing=await db.select({id:agentCommands.id}).from(agentCommands).where(and(eq(agentCommands.nodeId,nodeId),eq(agentCommands.serverId,server.id),eq(agentCommands.type,type),inArray(agentCommands.status,['queued','processing']))).limit(1)
    if(existing.length)continue
    const payload={memoryMb:server.memoryMb,loader:server.loader,mcVersion:server.mcVersion,loaderVersion:server.loaderVersion,port:server.port,worldName:server.worldName,label:'scheduled',kind:'full',scheduleId:schedule.id}
    await db.insert(agentCommands).values({userId:nodeUserId,nodeId,serverId:server.id,type,payload})
    await db.insert(operationLogs).values({userId:nodeUserId,serverId:server.id,operation:`scheduled-${type}`,status:'queued'})
  }
}

export async function GET(request:NextRequest){
  await ensurePanelSchema()
  const node=await getNode(request)
  if(!node)return NextResponse.json({error:'Unauthorized'},{status:401})
  await dispatchDueSchedules(node.id,node.userId)
  const candidates=await db.select().from(agentCommands).where(and(eq(agentCommands.nodeId,node.id),eq(agentCommands.status,'queued'))).orderBy(asc(agentCommands.createdAt)).limit(1)
  const commands=[]
  for(const candidate of candidates){
    const claimed=await db.update(agentCommands).set({status:'processing'}).where(and(eq(agentCommands.id,candidate.id),eq(agentCommands.status,'queued'))).returning()
    if(claimed[0])commands.push(claimed[0])
  }
  return NextResponse.json({commands})
}
const itemSchema=z.object({eventId:z.string().min(1).max(100),serverId:z.string().uuid(),playerUuid:z.string().max(40).nullable().optional(),playerName:z.string().max(40).nullable().optional(),itemId:z.string().max(150),itemName:z.string().max(200),amount:z.number().int().min(1).max(100000),reason:z.string().max(40),world:z.string().max(100),x:z.number().int(),y:z.number().int(),z:z.number().int(),metadata:z.record(z.string(),z.unknown()).default({}),occurredAt:z.coerce.date()})
export async function POST(request:NextRequest){await ensurePanelSchema();const node=await getNode(request);if(!node)return NextResponse.json({error:'Unauthorized'},{status:401});const body=await request.json()
if(body.type==='heartbeat')await db.update(nodes).set({status:'online',lastHeartbeat:new Date(),cpuPercent:body.cpuPercent??0,memoryUsedMb:body.memoryUsedMb??0,memoryTotalMb:body.memoryTotalMb??0,diskUsedGb:body.diskUsedGb??0,diskTotalGb:body.diskTotalGb??0,updatedAt:new Date()}).where(and(eq(nodes.id,node.id),eq(nodes.userId,node.userId)))
else if(body.type==='result'){const command=(await db.select().from(agentCommands).where(and(eq(agentCommands.id,body.commandId),eq(agentCommands.userId,node.userId))).limit(1))[0];if(command){await db.update(agentCommands).set({status:body.ok?'completed':'failed',result:body.result??{},completedAt:new Date()}).where(eq(agentCommands.id,command.id));await db.insert(operationLogs).values({userId:node.userId,serverId:command.serverId!,operation:command.type,status:body.ok?'completed':'failed',message:body.result?.error??null});if(body.ok&&command.serverId&&['backup','CREATE_BACKUP','CREATE_WORLD_BACKUP'].includes(command.type)&&body.result?.path){const world=(await db.select({id:worlds.id}).from(worlds).where(and(eq(worlds.serverId,command.serverId),eq(worlds.isActive,true))).limit(1))[0];if(world)await db.insert(backups).values({userId:node.userId,worldId:world.id,blobPathname:String(body.result.path).slice(0,500),sizeMb:Number(body.result.sizeBytes??0)/1048576,sizeBytes:Number(body.result.sizeBytes??0),createdBy:node.userId})}if(!body.ok&&command.type==='install')await db.update(servers).set({status:'failed',installError:String(body.result?.error??'Kurulum başarısız'),updatedAt:new Date()}).where(eq(servers.id,command.serverId!));if(body.ok&&command.type==='delete-server')await db.update(servers).set({status:'deleted',updatedAt:new Date()}).where(and(eq(servers.id,command.serverId!),eq(servers.userId,node.userId)));if(body.ok&&command.serverId&&command.type==='change-port'){const port=Number((command.payload as Record<string,unknown>|null)?.port);if(Number.isInteger(port)&&port>=1024&&port<=65535)await db.update(servers).set({port,updatedAt:new Date()}).where(and(eq(servers.id,command.serverId),eq(servers.userId,node.userId)))};if(body.ok&&command.serverId&&command.type==='CHANGE_WORLD'){const worldName=String((command.payload as Record<string,unknown>|null)?.worldName??'').replace(/[^A-Za-z0-9_-]/g,'_');if(worldName)await db.update(servers).set({worldName,updatedAt:new Date()}).where(and(eq(servers.id,command.serverId),eq(servers.userId,node.userId)))};if(body.ok&&command.serverId&&command.type==='change-software'){const payload=(command.payload??{}) as Record<string,unknown>;const loader=String(payload.loader??'');const mcVersion=String(payload.mcVersion??'');const loaderVersion=payload.loaderVersion?String(payload.loaderVersion):null;if(['vanilla','paper','fabric','forge','neoforge'].includes(loader)&&/^\d+\.\d+(\.\d+)?$/.test(mcVersion))await db.update(servers).set({loader,mcVersion,loaderVersion,updatedAt:new Date()}).where(and(eq(servers.id,command.serverId),eq(servers.userId,node.userId)))}
if(command.type.startsWith('database-')){const payload=(command.payload??{}) as Record<string,unknown>;const databaseId=String(payload.databaseId??'');if(databaseId){if(body.ok&&command.type==='database-delete'){await db.delete(managedDatabases).where(eq(managedDatabases.id,databaseId))}else{const result=(body.result??{}) as Record<string,unknown>;await db.update(managedDatabases).set({status:body.ok?'ready':'failed',credentialsPath:body.ok?String(result.credentialsPath??'')||null:undefined,lastError:body.ok?null:String(result.error??'Veritabanı işlemi başarısız').slice(0,1000),updatedAt:new Date()}).where(eq(managedDatabases.id,databaseId))}}}}}
else if(body.type==='progress'&&body.serverId)await db.update(servers).set({status:String(body.status??'installing'),installProgress:Math.max(0,Math.min(100,Number(body.progress)||0)),installError:null,updatedAt:new Date()}).where(and(eq(servers.id,body.serverId),eq(servers.userId,node.userId)))
else if(body.type==='log'&&body.serverId&&typeof body.line==='string')await db.insert(consoleLogs).values({userId:node.userId,serverId:body.serverId,stream:body.stream==='stderr'?'stderr':'stdout',line:body.line.slice(0,8000)})
else if(body.type==='server-status'&&body.serverId)await db.update(servers).set({status:body.status,pid:body.pid??null,playerCount:body.playerCount??0,installProgress:body.status==='ready'||body.status==='stopped'?100:undefined,updatedAt:new Date()}).where(and(eq(servers.id,body.serverId),eq(servers.userId,node.userId)))
else if(body.type==='lost-items'){const items=z.array(itemSchema).max(200).parse(body.items);for(const item of items){const server=(await db.select().from(servers).where(and(eq(servers.id,item.serverId),eq(servers.nodeId,node.id),eq(servers.itemTrackingEnabled,true))).limit(1))[0];if(server)await db.insert(lostItems).values({userId:server.userId,...item}).onConflictDoNothing()}}
return NextResponse.json({ok:true})}
