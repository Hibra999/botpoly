"""Same-machine sequential process-tree RSS/CPU sampling. Outputs every observation, no filtering of failed runs."""
import argparse, csv, hashlib, json, os, pathlib, platform, statistics, subprocess, time
p=argparse.ArgumentParser();p.add_argument('--baseline',required=True);p.add_argument('--out',required=True);p.add_argument('--seconds',type=int,default=120);p.add_argument('--repeats',type=int,default=2);a=p.parse_args()
root=pathlib.Path.cwd();out=pathlib.Path(a.out).resolve();out.mkdir(parents=True,exist_ok=False)
metadata={'revision':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'baselineRevision':(root/'.runtime/headless-baseline-commit.txt').read_text().strip(),'lockSha256':hashlib.sha256((root/'pnpm-lock.yaml').read_bytes()).hexdigest(),'host':platform.platform(),'logicalCpus':os.cpu_count(),'baselineSource':str(pathlib.Path(a.baseline).resolve()),'capturedAtUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
node=root/'.runtime/node24/bin/node';hz=os.sysconf('SC_CLK_TCK');page=os.sysconf('SC_PAGE_SIZE');results=[]
def tree(pid):
    found=[]
    def visit(n):
        try:
            stat=pathlib.Path(f'/proc/{n}/stat').read_text().rsplit(')',1)[1].split()
            found.append((int(stat[21])*page,(sum(int(stat[x]) for x in [11,12,13,14]))/hz))
            for child in pathlib.Path(f'/proc/{n}/task/{n}/children').read_text().split():visit(int(child))
        except (FileNotFoundError,ProcessLookupError):pass
    visit(pid);return sum(x[0] for x in found),sum(x[1] for x in found)
for repeat in range(a.repeats):
    for variant in (['baseline','headless'] if repeat%2==0 else ['headless','baseline']):
        dest=out/f'{repeat+1}-{variant}';dest.mkdir();samples=[]
        command=[str(node)]+(['--import','tsx'] if variant=='baseline' else [])+[str(root/'scripts/research/headless-replay.mjs'),variant,str(pathlib.Path(a.baseline).resolve() if variant=='baseline' else root),str(dest),str(a.seconds)]
        with (dest/'process.log').open('w') as log:
            process=subprocess.Popen(command,cwd=root,stdout=log,stderr=log,env={'PATH':str(node.parent)+':'+os.environ['PATH'],'LANG':'C.UTF-8'})
            start=time.monotonic()
            while process.poll() is None:
                rss,cpu=tree(process.pid);samples.append({'elapsed':time.monotonic()-start,'rss':rss,'cpuSeconds':cpu});time.sleep(.1)
        with (dest/'samples.csv').open('w') as f:
            writer=csv.DictWriter(f,fieldnames=['elapsed','rss','cpuSeconds']);writer.writeheader();writer.writerows(samples)
        if process.returncode:raise RuntimeError(f'{variant} failed; inspect local process.log')
        result=json.loads((dest/'result.json').read_text());warm=[s for s in samples if s['elapsed']>=30 and s['rss']>0]
        thirds=[statistics.median([s['rss'] for s in warm if lo<=s['elapsed']<hi]) for lo,hi in [(30,a.seconds/2),(a.seconds/2,a.seconds*.75),(a.seconds*.75,a.seconds)]] if a.seconds>=90 else [0,0,0]
        last=[x['latencyMs'] for x in result['latencies'] if x['elapsedMs']>=30000] or [x['latencyMs'] for x in result['latencies']]
        avgx=statistics.mean(s['elapsed'] for s in warm) if warm else 0;avgy=statistics.mean(s['rss'] for s in warm) if warm else 0
        slope=sum((s['elapsed']-avgx)*(s['rss']-avgy) for s in warm)/sum((s['elapsed']-avgx)**2 for s in warm)*60/2**20 if len(warm)>1 else 0
        row={'repeat':repeat+1,'variant':variant,'inputSha256':result['inputSha256'],'peakTreeMiB':max(s['rss'] for s in samples)/2**20,'medianWarmTreeMiB':statistics.median(s['rss'] for s in warm)/2**20 if warm else None,'cpuSeconds':max(s['cpuSeconds'] for s in samples),'p95LatencyMs':sorted(last)[int((len(last)-1)*.95)],'maxLatencyMs':max(last),'reportMs':result['reportTimes'],'warmSegmentMedianMiB':[n/2**20 for n in thirds],'rssSlopeMiBPerMinute':slope,'orders':result['orders'],'recorded':result['recorded']};results.append(row);print(json.dumps(row),flush=True)
        (out/'measurements.json').write_text(json.dumps({'metadata':metadata,'runs':results,'seconds':a.seconds,'repeats':a.repeats,'protocolSha256':hashlib.sha256((root/'scripts/research/headless-replay.mjs').read_bytes()).hexdigest(),'samplerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'growthCriterion':'After 30s warmup: linear RSS slope <=5 MiB/min and final segment median <= previous segment +8 MiB; finite duration, no proof against every long-term leak.'},indent=2))
assert len({r['inputSha256'] for r in results})==1,'Input replay differs'
