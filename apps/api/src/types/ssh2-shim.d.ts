declare module "ssh2" {
  import type { EventEmitter } from "node:events";

  export interface ConnectConfig {
    host?: string;
    port?: number;
    username?: string;
    privateKey?: string;
    readyTimeout?: number;
  }

  export interface ExecOptions {
    /* ssh2 exec options */
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): void;
    exec(
      command: string,
      callback: (err: Error | undefined, stream: ClientChannel) => void,
    ): void;
    end(): void;
  }

  export interface ClientChannel extends NodeJS.ReadWriteStream {
    stderr: NodeJS.ReadableStream;
    on(event: "close", listener: (code: number | null, signal?: string) => void): this;
    on(event: "data", listener: (chunk: Buffer) => void): this;
  }
}
