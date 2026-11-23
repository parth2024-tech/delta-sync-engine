// Web Worker for client-side FastCDC chunking and SHA-256 hashing
self.onmessage = async function (e) {
  const { fileData, fileName, opts } = e.data;
  const uint8 = new Uint8Array(fileData);
  const len = uint8.length;

  const minSize = (opts && opts.minSize) || 2048;
  const avgSize = (opts && opts.avgSize) || 4096;
  const maxSize = (opts && opts.maxSize) || 16384;
  const mask = 2 ** Math.floor(Math.log2(Math.max(64, avgSize))) - 1;

  // Step 1: Compute FastCDC chunk boundaries
  const ends = [];
  let n = 0;
  while (n < len) {
    const hardMax = Math.min(n + maxSize, len);
    const minEnd = Math.min(n + minSize, len);
    let fp = 0x811c9dc5;
    let i = n;
    while (i < minEnd) {
      fp = (Math.imul(fp, 0x01000193) ^ uint8[i]) >>> 0;
      i++;
    }
    let cut = hardMax;
    while (i < hardMax) {
      fp = (Math.imul(fp, 0x01000193) ^ uint8[i]) >>> 0;
      i++;
      if ((fp & mask) === 0) {
        cut = i;
        break;
      }
    }
    if (cut <= n) cut = Math.min(n + 1, len);
    ends.push(cut);
    n = cut;
  }

  // Step 2: Hash each chunk and report progressive stats
  const totalChunks = ends.length;
  const chunks = [];
  let prev = 0;

  for (let idx = 0; idx < totalChunks; idx++) {
    const end = ends[idx];
    const chunkSlice = uint8.subarray(prev, end);
    const hashBuffer = await crypto.subtle.digest("SHA-256", chunkSlice);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const sha256Hex = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

    chunks.push({
      blockIndex: idx,
      offset: prev,
      length: end - prev,
      strongHash: sha256Hex,
    });

    prev = end;

    if (idx % 8 === 0 || idx === totalChunks - 1) {
      self.postMessage({
        type: "progress",
        chunksProcessed: idx + 1,
        totalChunks,
        bytesHashed: end,
        totalBytes: len,
      });
    }
  }

  // Step 3: Compute whole-file SHA-256 digest
  const fullHashBuffer = await crypto.subtle.digest("SHA-256", uint8);
  const fullHashArray = Array.from(new Uint8Array(fullHashBuffer));
  const fullSha256Hex = fullHashArray.map((b) => b.toString(16).padStart(2, "0")).join("");

  self.postMessage({
    type: "done",
    fileName,
    totalBytes: len,
    chunks,
    contentSha256: fullSha256Hex,
  });
};
