import type { DisplayTask, transformDisplayText } from '../../../../src/lib/display-regex.mjs';
export type RegexReply = { result?: ReturnType<typeof transformDisplayText>; error?: string; cancelled?: boolean; id?: number };
interface Job { key: string; task: DisplayTask; resolve: (reply: RegexReply) => void; id: number; }
/** One terminable worker, latest queued task per display segment. */
export class RegexExecutor {
  url: string; timeoutMs: number; queue: Map<string, Job>; current: Job | null; sequence: number; closed: boolean;
  worker: Worker | null = null; timer?: ReturnType<typeof setTimeout>;
  constructor(url: string, timeoutMs = 1500) { this.url=url;this.timeoutMs=timeoutMs;this.queue=new Map();this.current=null;this.sequence=0;this.closed=false; }
  run(key: string, task: DisplayTask): Promise<RegexReply> {
    if(this.closed)return Promise.resolve({error:'已停用'});
    return new Promise(resolve=>{if(!this.queue.has(key)&&this.queue.size>=64){const oldest=this.queue.values().next().value!;this.queue.delete(oldest.key);oldest.resolve({cancelled:true});}this.queue.get(key)?.resolve({cancelled:true});this.queue.set(key,{key,task,resolve,id:++this.sequence});this.pump();});
  }
  pump() {
    if(this.closed||this.current||!this.queue.size)return;
    const job=this.queue.values().next().value!;this.queue.delete(job.key);this.current=job;
    try {
      this.worker??=new Worker(this.url,{type:'module'});
      this.worker.onmessage=({data})=>{if(data.id===this.current?.id)this.finish(data);};
      this.worker.onerror=()=>{if(this.current?.id===job.id)this.finish({error:'正则执行失败'},true);};
      this.timer=setTimeout(()=>{if(this.current?.id===job.id)this.finish({error:'正则执行超时'},true);},this.timeoutMs);
      this.worker.postMessage({id:job.id,task:job.task});
    } catch {this.finish({error:'正则无法启动'},true);}
  }
  finish(data: RegexReply,discard=false) {clearTimeout(this.timer);if(discard){this.worker?.terminate();this.worker=null;}const job=this.current;this.current=null;job?.resolve(data);this.pump();}
  close(){this.closed=true;clearTimeout(this.timer);this.worker?.terminate();this.current?.resolve({cancelled:true});for(const job of this.queue.values())job.resolve({cancelled:true});this.queue.clear();this.current=null;}
}
