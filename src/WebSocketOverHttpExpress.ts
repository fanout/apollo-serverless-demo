import * as bodyParser from "body-parser";
import * as express from "express";
import * as grip from "grip";
import {
  IConnectionListener,
  IWebSocketOverHTTPConnectionInfo,
} from "./subscriptions-transport-ws-over-http/GraphqlWebSocketOverHttpConnectionListener";

type AsyncRequestHandler = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => Promise<void>;

const AsyncExpress = (
  handleRequestAsync: AsyncRequestHandler,
): express.RequestHandler => {
  return (req, res, next) => {
    Promise.resolve(handleRequestAsync(req, res, next)).catch(next);
  };
};

interface IWebSocketOverHttpExpressOptions {
  /** GRIP control message prefix. see https://pushpin.org/docs/protocols/grip/ */
  gripPrefix?: string;
  /** look up a listener for the given connection */
  getConnectionListener(
    info: IWebSocketOverHTTPConnectionInfo,
  ): IConnectionListener;
}

/**
 * Express App that does WebSocket-Over-HTTP when getting requests from Pushpin
 */
export default (
  options: IWebSocketOverHttpExpressOptions,
): express.RequestHandler => {
  const app = express()
    .use(bodyParser.raw({ type: "application/websocket-events" }))
    .use(
      AsyncExpress(async (req, res, next) => {
        if (
          !(
            req.headers["grip-sig"] &&
            req.headers["content-type"] === "application/websocket-events"
          )
        ) {
          return next();
        }
        // ok it's a Websocket-Over-Http connection https://pushpin.org/docs/protocols/websocket-over-http/
        const events = grip.decodeWebSocketEvents(req.body);
        const connectionId = req.get("connection-id");
        const meta = {}; // TODO: get from req.headers that start with 'meta-'? Not sure why? https://github.com/fanout/node-faas-grip/blob/746e10ea90305d05e736ce6390ac9f536ecb061f/lib/faas-grip.js#L168
        const gripWebSocketContext = new grip.WebSocketContext(
          connectionId,
          meta,
          events,
          options.gripPrefix,
        );
        if (!events.length) {
          return res
            .status(400)
            .end(
              "Failed to parse any events from application/websocket-events",
            );
        }
        if (!connectionId) {
          throw new Error(`Expected connection-id header but none is present`);
        }
        const connectionListener = options.getConnectionListener({
          id: connectionId,
          protocol: req.get("sec-websocket-protocol"),
          webSocketContext: gripWebSocketContext,
        });
        const eventsOut: grip.WebSocketEvent[] = [];
        for (const event of events) {
          switch (event.getType()) {
            case "CLOSE": // "Close message with 16-bit close code."
              const closeCode = (event.getContent() || "").toString();
              if (connectionListener.onClose) {
                await connectionListener.onClose(closeCode);
              }
              eventsOut.push(new grip.WebSocketEvent("CLOSE", closeCode));
              break;
            case "DISCONNECT": // "Indicates connection closed uncleanly or does not exist."
              if (connectionListener.onDisconnect) {
                await connectionListener.onDisconnect();
              }
              eventsOut.push(new grip.WebSocketEvent("DISCONNECT"));
              break;
            case "OPEN":
              if (connectionListener.onOpen) {
                const onOpenResponse = await connectionListener.onOpen();
                if (onOpenResponse && onOpenResponse.headers) {
                  for (const [header, value] of Object.entries(
                    onOpenResponse.headers,
                  )) {
                    res.setHeader(header, value);
                  }
                }
              }
              eventsOut.push(new grip.WebSocketEvent("OPEN"));
              break;
            case "TEXT":
              const content = event.getContent();
              if (!content) {
                break;
              }
              const message = content.toString();
              const response = await connectionListener.onMessage(message);
              if (response) {
                eventsOut.push(new grip.WebSocketEvent("TEXT", response));
              }
              break;
            default:
              throw new Error(`Unexpected event type ${event.getType()}`);
            // assertNever(event)
          }
        }
        res.status(200);
        res.setHeader("content-type", "application/websocket-events");
        res.setHeader("sec-websocket-extensions", 'grip; message-prefix=""');
        res.write(
          grip.encodeWebSocketEvents([...gripWebSocketContext.outEvents]),
        );
        res.write(grip.encodeWebSocketEvents([...eventsOut]));
        res.end();
      }),
    );
  return app;
};
