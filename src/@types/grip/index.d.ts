declare module "grip" {
  export type WebSocketEventWithContentTypeName = "TEXT" | "BINARY" | "CLOSE"
  export type WebSocketEventWithoutContentTypeName = "OPEN" | "PING" | "PONG" | "DISCONNECT"
  export type WebSocketEventTypeName = WebSocketEventWithContentTypeName | WebSocketEventWithoutContentTypeName
  export interface IWebSocketEventWithContent {
    getContent(): string;
    getType(): WebSocketEventWithContentTypeName;
  }
  export interface IWebSocketEventWithoutContent {
    getContent(): null;
    getType(): WebSocketEventWithoutContentTypeName;
  }
  export class WebSocketEvent {
    public getContent(): Buffer | null;
    public getType(): WebSocketEventTypeName;
    constructor(type: WebSocketEventTypeName, content?: string)
  }
  // export type WebSocketEvent = WebSocketEventWithContent | WebSocketEventWithoutContent
  export function decodeWebSocketEvents(reqBody: string): WebSocketEvent[]  
  export function encodeWebSocketEvents(events: WebSocketEvent[]): string  
}
