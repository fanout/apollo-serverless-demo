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
  // tslint:enable:completed-docs
}
