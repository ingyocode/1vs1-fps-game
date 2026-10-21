import { PBR_JOBS } from './textureJobs';

/** Generates PBR texture buffers off the main thread. */
self.onmessage = (e: MessageEvent<{ key: string }>) => {
  const raw = PBR_JOBS[e.data.key]();
  (self as unknown as Worker).postMessage({ key: e.data.key, raw }, [raw.map.buffer, raw.normal.buffer, raw.orm.buffer]);
};
