"""Measure shared snapshot delivery to 24 concurrent local readers."""
import asyncio,json,time
from pathlib import Path
import numpy as np
from aiohttp import ClientSession,ClientTimeout

async def main():
 async with ClientSession(timeout=ClientTimeout(total=15)) as session:
  async with session.get('http://127.0.0.1:8876/api/health') as r:health=await r.json()
  async def reader(index):
   started=time.perf_counter()
   async with session.get(f'http://127.0.0.1:8876/api/events?index={index}&playing=0') as response:
    async for line in response.content:
     if line.startswith(b'data: '):
      frame=json.loads(line[6:]);assert frame['index']==index
      return (time.perf_counter()-started)*1000
  latency=await asyncio.gather(*(reader(100+i%10) for i in range(24)))
  result={'environment':'Local Python server; 24 concurrent independent SSE connections, one full frame each. Not an internet or sustained-load benchmark.',
    'kernel':health,'concurrentReaders':24,'snapshotDeliveryP50Ms':round(float(np.percentile(latency,50)),2),'snapshotDeliveryP95Ms':round(float(np.percentile(latency,95)),2)}
  path=Path(__file__).resolve().parents[1]/'artifacts/checks/benchmark.json';path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))

if __name__=='__main__':asyncio.run(main())
