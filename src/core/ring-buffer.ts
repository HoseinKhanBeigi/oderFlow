export class RingBuffer<T> {
  private readonly buf: Array<T | undefined>;
  private head = 0;
  private length_ = 0;

  constructor(readonly capacity: number) {
    if (capacity < 1) throw new Error('RingBuffer capacity must be >= 1');
    this.buf = new Array(capacity);
  }

  get length(): number {
    return this.length_;
  }

  push(item: T): T | undefined {
    const evicted = this.length_ === this.capacity ? this.buf[this.head] : undefined;
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.length_ < this.capacity) this.length_ += 1;
    return evicted;
  }

  at(index: number): T | undefined {
    if (index < 0 || index >= this.length_) return undefined;
    const start = this.length_ === this.capacity ? this.head : 0;
    return this.buf[(start + index) % this.capacity];
  }

  last(): T | undefined {
    return this.length_ === 0 ? undefined : this.at(this.length_ - 1);
  }

  *values(): IterableIterator<T> {
    for (let i = 0; i < this.length_; i++) {
      yield this.at(i) as T;
    }
  }

  toArray(): T[] {
    return [...this.values()];
  }

  clear(): void {
    this.head = 0;
    this.length_ = 0;
    this.buf.fill(undefined);
  }
}
