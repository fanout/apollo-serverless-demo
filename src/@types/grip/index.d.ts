// tslint:disable:max-classes-per-file
declare module "grip" {
  export type WebSocketEventWithContentTypeName = "TEXT" | "BINARY" | "CLOSE";
  export type WebSocketEventWithoutContentTypeName =
    | "OPEN"
    | "PING"
    | "PONG"
    | "DISCONNECT";
  export type WebSocketEventTypeName =
    | WebSocketEventWithContentTypeName
    | WebSocketEventWithoutContentTypeName;
  export interface IWebSocketEventWithContent {
    /** get content of event */
    getContent(): string;
    /** get event type */
    getType(): WebSocketEventWithContentTypeName;
  }
  export interface IWebSocketEventWithoutContent {
    /** get content of event */
    getContent(): null;
    /** get event type */
    getType(): WebSocketEventWithoutContentTypeName;
  }
  /**
   * Class representing one of the events part of the Websocket-Over-HTTP protocol.
   * https://pushpin.org/docs/protocols/websocket-over-http/
   */
  export class WebSocketEvent {
    constructor(type: WebSocketEventTypeName, content?: string);
    /** get content of event */
    public getContent(): Buffer | null;
    /** get event type */
    public getType(): WebSocketEventTypeName;
  }
  // tslint:disable:completed-docs
  /** Translate an application/websocket-events string into WebSocketEvent objects */
  export function decodeWebSocketEvents(reqBody: string): WebSocketEvent[];
  /** Translate an array of WebSocketEvent objects into a string that conforms to application/websocket-events */
  export function encodeWebSocketEvents(events: WebSocketEvent[]): string;

  // https://github.com/fanout/node-grip/blob/master/lib/websocketcontext.js#L16
  export class WebSocketContext {
    public id: string;
    public inEvents: WebSocketEvent[];
    public readIndex: number;
    public accepted: boolean;
    public closeCode: null | number;
    public closed: boolean;
    public outCloseCode: null | number;
    public outEvents: WebSocketEvent[];
    public origMeta: object;
    public meta: object;
    public prefix: string;
    constructor(
      id: string | undefined,
      meta: object,
      inEvents: WebSocketEvent[],
      prefix?: string,
    );
    public isOpening(): boolean;
    public accept(): void;
    public close(code: number): void;
    public canRecv(): boolean;
    public recvRaw(): string | Buffer | null;
    public recv(): string | null;
    public send(message: string): void;
    public sendBinary(message: string | Buffer): void;
    public sendControl(message: string): void;
    public subscribe(channel: string): void;
    public unsubscribe(channel: string): void;
    public detach(): void;
  }
  // tslint:enable:completed-docs
}
