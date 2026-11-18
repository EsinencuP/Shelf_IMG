import { Zip, ZipPassThrough } from 'fflate';

const ZIP32_LIMIT = 0xffffffff;
const UTF8 = new TextEncoder();
const ZIP_END_BYTES = 22;

/** Stream stored entries, draining output before reading each next input chunk. */
export class StreamingZip {
  private archiveBytes = ZIP_END_BYTES;
  private readonly pending: Uint8Array<ArrayBuffer>[] = [];
  private readonly zip = new Zip((error, bytes) => {
    if (error) throw error;
    this.pending.push(bytes);
  });

  constructor(private readonly writer: WritableStreamDefaultWriter<Uint8Array<ArrayBuffer>>) {}

  private async flush() {
    for (const bytes of this.pending.splice(0)) await this.writer.write(bytes);
  }

  async add(path: string, file: Blob) {
    // Local header, data descriptor and central directory header for a stored entry.
    this.archiveBytes += file.size + 30 + 16 + 46 + 2 * UTF8.encode(path).length;
    if (this.archiveBytes >= ZIP32_LIMIT)
      throw new Error('ZIP превышает 4 ГБ. Разделите фотографии на несколько партий.');

    const entry = new ZipPassThrough(path);
    this.zip.add(entry);
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        entry.push(value);
        await this.flush();
      }
      entry.push(new Uint8Array(), true);
      await this.flush();
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async close() {
    this.zip.end();
    await this.flush();
    await this.writer.close();
  }
}
